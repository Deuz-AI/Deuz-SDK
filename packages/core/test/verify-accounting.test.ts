/**
 * verify-accounting.test.ts (2.4, spec §3.1) — `createVerifier` charges its
 * judge call to an execution context when one is given: the call is reserved
 * and settled on the context's ledger under its policy, like every native
 * model call. Without one nothing changes, and a budget that refuses the call
 * degrades the verdict like any other verifier outage (it never throws).
 */
import { describe, expect, it, vi } from 'vitest';
import { createVerifier } from '../src/autonomy';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createExecutionContext } from '../src/execution-policy';
import type { LanguageModel } from '../src/types/model';

const passing = {
  toolCalls: [
    {
      toolName: 'Verification',
      args: { checks: [{ id: 'c1', question: 'Is it right?', pass: true }] },
    },
  ],
  usage: { inputTokens: 30, outputTokens: 10 },
};

/** A mock judge whose request bodies are recorded. */
function recordingModel(): { model: LanguageModel; bodies: string[] } {
  const inner = createMockModel({ responses: [passing, passing] });
  const config = readConfig(inner)!;
  const bodies: string[] = [];
  const model = attachConfig(
    { provider: inner.provider, modelId: inner.modelId, surface: inner.surface },
    {
      ...config,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return config.fetch!(input, init);
      }) as typeof fetch,
    },
  );
  return { model, bodies };
}

const quiet = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };

describe('createVerifier with an execution context', () => {
  it('reserves and settles the judge call on the ledger', async () => {
    const execution = createExecutionContext({ budget: { tokens: 100_000 } });
    const { model } = recordingModel();
    const verifier = createVerifier({ model, execution, deps: quiet });
    const verdict = await verifier.verify({ goal: 'Say hi', answer: 'hi' });
    expect(verdict).toMatchObject({ ok: true, confidence: 1 });
    const [reservation] = execution.ledger.snapshot().reservations;
    expect(reservation).toMatchObject({
      modelId: model.modelId,
      state: 'unknown',
      actual: { tokens: 40 },
    });
    expect(execution.ledger.totals().spent.tokens).toBe(40);
  });

  it('charges every call of the loop hook too', async () => {
    const execution = createExecutionContext();
    const { model } = recordingModel();
    const step = createVerifier({ model, execution, deps: quiet }).asVerifyStep({ goal: 'g' });
    await step({ stepIndex: 0, attempt: 0, text: 'a', messages: [], usage: undefined as never });
    await step({ stepIndex: 1, attempt: 1, text: 'b', messages: [], usage: undefined as never });
    expect(execution.ledger.snapshot().reservations).toHaveLength(2);
  });

  it('changes nothing without one', async () => {
    const plain = recordingModel();
    await createVerifier({ model: plain.model, deps: quiet }).verify({ goal: 'g', answer: 'a' });
    const charged = recordingModel();
    const execution = createExecutionContext();
    await createVerifier({ model: charged.model, execution, deps: quiet }).verify({
      goal: 'g',
      answer: 'a',
    });
    // An unbounded context sends the very same request.
    expect(charged.bodies).toEqual(plain.bodies);
  });

  it('degrades, never throws, when the budget or policy refuses the call', async () => {
    for (const execution of [
      createExecutionContext({ budget: { tokens: 1 } }),
      createExecutionContext({ policy: { allowedModels: ['another-model'] } }),
    ]) {
      const { model, bodies } = recordingModel();
      const warn = vi.fn();
      const verifier = createVerifier({
        model,
        execution,
        deps: { logger: { ...quiet.logger, warn } },
      });
      await expect(verifier.verify({ goal: 'g', answer: 'a' })).resolves.toEqual({
        ok: true,
        errorCategory: 'other',
      });
      expect(bodies).toEqual([]);
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/DEGRADED/);
    }
  });
});
