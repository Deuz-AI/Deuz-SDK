import { describe, it, expect } from 'vitest';
import { resolveDependencies } from '../src/internal/resolve-deps';
import { createObservationRuntime } from '../src/internal/observe-runtime';
import { unitFromId } from '../src/core/resilience';
import type { Dependencies, ObserveEvent, ObservationOptions } from '../src/index';

function makeRuntime(
  runId: string,
  options: ObservationOptions,
): { events: ObserveEvent[]; rt: NonNullable<ReturnType<typeof createObservationRuntime>> } {
  const events: ObserveEvent[] = [];
  let id = 0;
  const deps: Dependencies = {
    generateId: () => `id-${id++}`,
    clock: { now: () => 1000, setTimeout: (fn) => (fn(), () => {}) },
    observer: { options, emit: (e) => events.push(e) },
  };
  const rt = createObservationRuntime(resolveDependencies(deps), { runId })!;
  return { events, rt };
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
};

/** Find runIds on either side of the sampling decision for a given rate. */
function findRunId(rate: number, sampledWanted: boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const candidate = `run-${i}`;
    if (unitFromId(candidate) < rate === sampledWanted) return candidate;
  }
  throw new Error('no candidate found');
}

describe('deterministic sampling', () => {
  it('uses unitFromId(runId) — same runId, same decision, no extra generateId', () => {
    const rate = 0.5;
    const inId = findRunId(rate, true);
    const outId = findRunId(rate, false);

    for (let i = 0; i < 3; i++) {
      const { events, rt } = makeRuntime(inId, { sampleRate: rate });
      expect(rt.sampled).toBe(true);
      rt.emit({
        type: 'run.started',
        spanId: 's',
        operation: 'generate-text',
        provider: 'p',
        model: 'm',
        surface: 'chat_completions',
        durable: false,
        resumed: false,
      });
      expect(events).toHaveLength(1);
    }
    for (let i = 0; i < 3; i++) {
      const { events, rt } = makeRuntime(outId, { sampleRate: rate });
      expect(rt.sampled).toBe(false);
      rt.emit({
        type: 'run.started',
        spanId: 's',
        operation: 'generate-text',
        provider: 'p',
        model: 'm',
        surface: 'chat_completions',
        durable: false,
        resumed: false,
      });
      expect(events).toHaveLength(0);
    }
  });

  it('clamps sampleRate: NaN→1, <0→0, >1→1', () => {
    const anyId = 'run-x';
    expect(makeRuntime(anyId, { sampleRate: Number.NaN }).rt.sampled).toBe(true);
    expect(makeRuntime(anyId, { sampleRate: -3 }).rt.sampled).toBe(false);
    expect(makeRuntime(anyId, { sampleRate: 7 }).rt.sampled).toBe(true);
  });

  it('default rate is 1 (always sampled)', () => {
    expect(makeRuntime('anything', {}).rt.sampled).toBe(true);
  });
});

describe('sampleErrors — minimal run.failed from unsampled runs', () => {
  const unsampledId = findRunId(0.5, false);

  function emitFailure(options: ObservationOptions): ObserveEvent[] {
    const { events, rt } = makeRuntime(unsampledId, options);
    rt.emit({
      type: 'run.started',
      spanId: 's',
      operation: 'generate-text',
      provider: 'p',
      model: 'm',
      surface: 'chat_completions',
      durable: false,
      resumed: false,
    });
    rt.emit({
      type: 'run.failed',
      spanId: 's',
      status: 'failed',
      durationMs: 12,
      error: {
        name: 'RateLimitError',
        category: 'rate-limit',
        code: 'rate_limit',
        statusCode: 429,
        message: 'sensitive detail',
      },
      stepCount: 3,
      modelCallCount: 3,
      toolCallCount: 2,
      retryCount: 1,
      partialUsage: { ...EMPTY_USAGE, inputTokens: 10, totalTokens: 10 },
    });
    return events;
  }

  it('emits ONLY the minimal run.failed (default sampleErrors: true)', () => {
    const events = emitFailure({ sampleRate: 0.5, metadata: { app: 'x' } });
    expect(events).toHaveLength(1);
    const failed = events[0] as Extract<ObserveEvent, { type: 'run.failed' }>;
    expect(failed.type).toBe('run.failed');
    // identity survives
    expect(failed.runId).toBe(unsampledId);
    // error keeps only category/code/status — no message
    expect(failed.error).toEqual({
      name: 'RateLimitError',
      category: 'rate-limit',
      code: 'rate_limit',
      statusCode: 429,
    });
    // counters zeroed, no usage, no metadata
    expect(failed.stepCount).toBe(0);
    expect(failed.modelCallCount).toBe(0);
    expect(failed.partialUsage).toBeUndefined();
    expect(failed.metadata).toBeUndefined();
  });

  it('emits nothing when sampleErrors is false', () => {
    const events = emitFailure({ sampleRate: 0.5, sampleErrors: false });
    expect(events).toHaveLength(0);
  });
});
