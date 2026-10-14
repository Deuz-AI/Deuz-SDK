/**
 * accounting-callback.test.ts (2.4, spec §3.1) — `chargeCallback`, the one
 * way the SDK charges a host callback (a memory LLM, a RAG or memory
 * embedder) to an execution context's ledger. An accounted callback settles
 * the usage it reports, priced by the model it names; an unmarked one is
 * reserved `unaccounted`, ends unknown with its estimate held (never free),
 * warns `unaccounted-usage` once per run, and a strict budget refuses it
 * before it runs.
 */
import { describe, expect, it } from 'vitest';
import { createExecutionContext } from '../src/execution-policy';
import {
  chargeCallback,
  defineAccountedMemoryLLM,
  unaccountedUsageWarning,
} from '../src/internal/accounting';
import { markRunLedger } from '../src/internal/run-ledger';
import type { CallWarning } from '../src/types/methods';
import type { Usage } from '../src/types/usage';

function usage(totalTokens: number): Usage {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens,
  };
}

/** $0.001 per token for `judge-1`; nothing else has a price. */
const prices = {
  priceUsage: (model: string, value: Usage) =>
    model === 'judge-1' ? value.totalTokens / 1000 : undefined,
};

const plainLLM = async (prompt: { system: string; user: string }) => `${prompt.user}!`;
const accountedLLM = defineAccountedMemoryLLM(async (prompt) => ({
  text: `${prompt.user}!`,
  usage: usage(42),
  modelId: 'judge-1',
}));

describe('chargeCallback', () => {
  it('settles what an accounted callback reports, priced by the model it names', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000, usd: 1 } });
    const warnings: CallWarning[] = [];
    const text = await chargeCallback({
      execution,
      requestId: 'mem-1',
      kind: 'memory-llm',
      callback: accountedLLM,
      tokens: 100,
      usd: 0.1,
      priceProvider: prices,
      warn: (warning) => warnings.push(warning),
      run: () => accountedLLM({ system: 's', user: 'u' }),
      usage: (result) => result,
    });
    expect(text.text).toBe('u!');
    expect(execution.ledger.get('mem-1')).toMatchObject({
      state: 'settled',
      kind: 'memory-llm',
      actual: { tokens: 42, usd: 0.042 },
    });
    expect(execution.ledger.get('mem-1')).not.toHaveProperty('unaccounted');
    expect(warnings).toEqual([]);
  });

  it('holds an unmarked callback as unaccounted, never free, and warns once per run', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000 } });
    markRunLedger(execution.ledger);
    const warnings: CallWarning[] = [];
    for (const requestId of ['a', 'b']) {
      const text = await chargeCallback({
        execution,
        requestId,
        kind: 'memory-llm',
        callback: plainLLM,
        tokens: 100,
        warn: (warning) => warnings.push(warning),
        run: () => plainLLM({ system: 's', user: requestId }),
      });
      expect(text).toBe(`${requestId}!`);
    }
    expect(execution.ledger.get('a')).toMatchObject({
      state: 'unknown',
      unaccounted: true,
      reservation: { tokens: 100 },
    });
    expect(execution.ledger.totals()).toMatchObject({
      unaccounted: 2,
      reserved: { tokens: 200 },
      spent: { tokens: 0 },
    });
    expect(warnings).toEqual([unaccountedUsageWarning('memory-llm')]);
    expect(warnings[0]).toMatchObject({ type: 'unaccounted-usage', setting: 'memory-llm' });
  });

  it('reports again on a ledger many runs share, for each run sink to keep once', async () => {
    const execution = createExecutionContext();
    const warnings: CallWarning[] = [];
    for (const requestId of ['a', 'b'])
      await chargeCallback({
        execution,
        requestId,
        kind: 'rag-embedder',
        callback: { embed: async () => [[1]], dims: 1 },
        tokens: 10,
        warn: (warning) => warnings.push(warning),
        run: async () => [[1]],
      });
    // The same text each time, so a run's warning sink keeps one.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toEqual(warnings[1]);
  });

  it("refuses an unmarked callback under unknownPrice: 'reject' before it runs", async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000, unknownPrice: 'reject' } });
    let ran = false;
    await expect(
      chargeCallback({
        execution,
        requestId: 'a',
        kind: 'memory-llm',
        callback: plainLLM,
        tokens: 10,
        run: async () => {
          ran = true;
          return 'x';
        },
      }),
    ).rejects.toMatchObject({ code: 'unaccounted_call' });
    expect(ran).toBe(false);
    // The accounted variant is admitted under the same budget.
    await expect(
      chargeCallback({
        execution,
        requestId: 'b',
        kind: 'memory-llm',
        callback: accountedLLM,
        tokens: 100,
        usd: 0.1,
        priceProvider: prices,
        run: () => accountedLLM({ system: 's', user: 'u' }),
        usage: (result) => result,
      }),
    ).resolves.toMatchObject({ text: 'u!' });
  });

  it('keeps the hold unknown when the callback throws, or reports no usage', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000 } });
    await expect(
      chargeCallback({
        execution,
        requestId: 'boom',
        kind: 'memory-llm',
        callback: accountedLLM,
        tokens: 50,
        run: () => Promise.reject(new Error('provider down')),
        usage: () => undefined,
      }),
    ).rejects.toThrow('provider down');
    expect(execution.ledger.get('boom')).toMatchObject({ state: 'unknown' });
    await chargeCallback({
      execution,
      requestId: 'silent',
      kind: 'memory-llm',
      callback: accountedLLM,
      tokens: 50,
      run: async () => 'text',
      usage: () => undefined,
    });
    expect(execution.ledger.get('silent')).toMatchObject({ state: 'unknown' });
    expect(execution.ledger.totals().reserved.tokens).toBe(100);
  });

  it('charges a request id once, however often it runs', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000, usd: 1 } });
    const charge = () =>
      chargeCallback({
        execution,
        requestId: 'mem-1',
        kind: 'memory-llm',
        callback: accountedLLM,
        tokens: 100,
        usd: 0.1,
        priceProvider: prices,
        run: () => accountedLLM({ system: 's', user: 'u' }),
        usage: (result) => ({ ...result, usage: usage(result.usage.totalTokens + calls++) }),
      });
    let calls = 0;
    await charge();
    await charge();
    expect(execution.ledger.totals()).toMatchObject({ spent: { tokens: 42 } });
  });

  it('checks the allowlist against a named model and the deadline always', async () => {
    const execution = createExecutionContext({
      policy: { allowedModels: ['judge-1'], deadlineAt: 1_000 },
    });
    const base = {
      execution,
      kind: 'memory-llm',
      callback: plainLLM,
      tokens: 1,
      run: async () => 'x',
    };
    await expect(
      chargeCallback({ ...base, requestId: 'a', modelId: 'judge-1', now: 1 }),
    ).resolves.toBe('x');
    await expect(
      chargeCallback({ ...base, requestId: 'b', modelId: 'other', now: 1 }),
    ).rejects.toMatchObject({ code: 'model_not_allowed' });
    // A callback whose model is unknown before it runs is held by budget and deadline only.
    await expect(chargeCallback({ ...base, requestId: 'c', now: 1 })).resolves.toBe('x');
    await expect(chargeCallback({ ...base, requestId: 'd', now: 1_000 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
  });
});
