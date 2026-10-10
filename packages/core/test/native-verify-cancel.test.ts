/**
 * native-verify-cancel.test.ts (2.3, F05) — cancellation and the execution
 * deadline must still hold after the async verifier (or async output validation)
 * returns. Before the fix the terminal commit followed the verdict with no
 * re-check: an abort during verification ended `completed`, a signal-aware
 * verifier that threw on abort ended `verification-inconclusive`, and a deadline
 * that elapsed during verification ended `completed`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, streamAgent } from '../src/agent-run';
import { createExecutionContext } from '../src/execution-policy';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createDeferred } from '../src/internal/async-iter';
import type { AgentRunStore, AgentVerification, AgentVerifyContext } from '../src/types/agent-run';
import type { Clock } from '../src/types/deps';

function counted(responses: { text: string }[]) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  return { model: attachConfig({ ...base }, { ...config, fetch }), fetch };
}

function manualClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, setTimeout: () => () => {}, advance: (ms) => void (now += ms) };
}

const output = {
  schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
  mode: 'json' as const,
  validate(value: unknown) {
    if (!value || typeof (value as { answer?: unknown }).answer !== 'number')
      throw new Error('answer must be a number');
    return value as { answer: number };
  },
};

/** A verifier that parks until released, so the test can act while it runs. */
function parkedVerifier(verdict: (signal: AbortSignal | undefined) => AgentVerification): {
  verify: (ctx: AgentVerifyContext<unknown>) => Promise<AgentVerification>;
  entered: Promise<void>;
  release: () => void;
  calls: () => number;
} {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  let calls = 0;
  return {
    async verify(ctx) {
      calls++;
      entered.resolve();
      await released.promise;
      return verdict(ctx.signal);
    },
    entered: entered.promise,
    release: () => released.resolve(),
    calls: () => calls,
  };
}

describe('native verification and cancellation (F05)', () => {
  it('does not commit completed when the run is aborted while the verifier runs', async () => {
    for (const structured of [false, true]) {
      const controller = new AbortController();
      const { model, fetch } = counted([{ text: structured ? '{"answer":42}' : 'answer' }]);
      const store = createInMemoryAgentRunStore();
      const parked = parkedVerifier(() => ({ status: 'verified' }));
      const stream = streamAgent({
        model,
        prompt: 'answer',
        signal: controller.signal,
        verify: parked.verify,
        ...(structured ? { output } : {}),
        session: { store, runId: `abort-${structured}`, scope: 't' },
      } as Parameters<typeof streamAgent>[0]);
      const result = stream.result;
      await parked.entered;
      controller.abort();
      parked.release();
      expect(await result).toMatchObject({ status: 'stopped', reason: 'aborted' });
      const stored = (await store.load(`abort-${structured}`))!;
      expect(stored.phase).toBe('terminal');
      expect(stored.result).toMatchObject({ status: 'stopped', reason: 'aborted' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('classifies a verifier that throws because of the abort as aborted', async () => {
    const controller = new AbortController();
    const { model } = counted([{ text: 'answer' }]);
    const parked = parkedVerifier((signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      return { status: 'verified' };
    });
    const pending = streamAgent({
      model,
      prompt: 'answer',
      signal: controller.signal,
      verify: parked.verify,
    }).result;
    await parked.entered;
    controller.abort();
    parked.release();
    const result = await pending;
    expect(result).toMatchObject({ status: 'stopped', reason: 'aborted' });
    expect(result.verification).not.toBe('inconclusive');
  });

  it('fails on a deadline that elapses during verification instead of completing', async () => {
    const clock = manualClock();
    const { model, fetch } = counted([{ text: 'answer' }]);
    const parked = parkedVerifier(() => ({ status: 'verified' }));
    const pending = streamAgent({
      model,
      prompt: 'answer',
      verify: parked.verify,
      deps: { clock },
      execution: createExecutionContext({
        scopeId: 'deadline',
        policy: { deadlineAt: clock.now() + 50 },
      }),
    }).result;
    await parked.entered;
    clock.advance(100);
    parked.release();
    const result = await pending;
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: 'Execution deadline has elapsed.' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops before the verifier when the run is aborted during async output validation', async () => {
    const controller = new AbortController();
    const { model } = counted([{ text: '{"answer":1}' }]);
    const verify = vi.fn(() => ({ status: 'verified' as const }));
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const result = streamAgent({
      model,
      prompt: 'answer',
      signal: controller.signal,
      verify,
      output: {
        ...output,
        async validate(value: unknown) {
          entered.resolve();
          await released.promise;
          return output.validate(value);
        },
      },
    }).result;
    await entered.promise;
    controller.abort();
    released.resolve();
    expect(await result).toMatchObject({ status: 'stopped', reason: 'aborted' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('still completes a verified candidate when nothing was cancelled', async () => {
    const { model } = counted([{ text: 'answer' }]);
    const parked = parkedVerifier(() => ({ status: 'verified' }));
    const pending = streamAgent({ model, prompt: 'answer', verify: parked.verify }).result;
    await parked.entered;
    parked.release();
    expect(await pending).toMatchObject({
      status: 'completed',
      output: 'answer',
      verification: 'verified',
    });
  });

  it('re-runs the verifier on resume when the terminal commit was lost (documented)', async () => {
    const controller = new AbortController();
    const { model, fetch } = counted([{ text: 'answer' }]);
    const inner = createInMemoryAgentRunStore();
    let failTerminal = true;
    const store: AgentRunStore = {
      load: (id) => inner.load(id),
      save(envelope) {
        if (failTerminal && envelope.phase === 'terminal') {
          failTerminal = false;
          throw new Error('terminal commit failed');
        }
        return inner.save(envelope);
      },
    };
    const parked = parkedVerifier(() => ({ status: 'verified' }));
    const options = {
      model,
      prompt: 'answer',
      verify: parked.verify,
      session: { store, runId: 'lost-terminal', scope: 't' },
    };
    const pending = streamAgent({ ...options, signal: controller.signal }).result;
    await parked.entered;
    controller.abort();
    parked.release();
    expect(await pending).toMatchObject({ status: 'failed' });
    // The candidate survived in `finalizing`; resume verifies it again, no model call.
    expect((await inner.load('lost-terminal'))!.phase).toBe('finalizing');
    expect(await resumeAgent(options)).toMatchObject({ status: 'completed', output: 'answer' });
    expect(parked.calls()).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops a rejected verdict that raced an abort once, and resume never redoes it', async () => {
    const controller = new AbortController();
    const { model, fetch } = counted([{ text: 'draft' }, { text: 'better' }]);
    const store = createInMemoryAgentRunStore();
    const parked = parkedVerifier(() => ({ status: 'rejected', feedback: 'Be precise.' }));
    const options = {
      model,
      prompt: 'answer',
      verify: parked.verify,
      session: { store, runId: 'abort-rejected', scope: 't' },
    };
    const stream = streamAgent({ ...options, signal: controller.signal });
    const results: unknown[] = [];
    const drained = (async () => {
      for await (const event of stream.events) if (event.type === 'result') results.push(event);
    })();
    await parked.entered;
    controller.abort();
    parked.release();
    const result = await stream.result;
    await drained;
    expect(result).toMatchObject({ status: 'stopped', reason: 'aborted' });
    // One terminal event, and the stored state says the same thing.
    expect(results).toHaveLength(1);
    const stored = (await store.load('abort-rejected'))!;
    expect(stored).toMatchObject({ phase: 'terminal', result: { status: 'stopped' } });
    // The rejection's feedback never became a re-drive.
    expect(stored.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(fetch).toHaveBeenCalledTimes(1);
    // A terminal run resumes to its stored result: no verifier, no model call.
    expect(await resumeAgent(options)).toEqual(result);
    expect(parked.calls()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('still re-drives a rejected candidate when nothing was cancelled', async () => {
    const { model, fetch } = counted([{ text: 'draft' }, { text: 'better' }]);
    let verdicts = 0;
    const result = await streamAgent({
      model,
      prompt: 'answer',
      verify: () =>
        verdicts++ === 0 ? { status: 'rejected', feedback: 'Be precise.' } : { status: 'verified' },
    }).result;
    expect(result).toMatchObject({ status: 'completed', output: 'better' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
