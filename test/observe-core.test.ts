import { describe, it, expect } from 'vitest';
import { resolveDependencies } from '../src/internal/resolve-deps';
import {
  createObservationRuntime,
  type PendingObserveEvent,
} from '../src/internal/observe-runtime';
import { toObservedError } from '../src/internal/observe-error';
import {
  redactForObservation,
  redactObservationString,
  maskSecret,
  OBSERVE_REDACTED,
} from '../src/internal/redact';
import { RateLimitError, AuthenticationError, TimeoutError, AbortError } from '../src/errors';
import type { Dependencies, ObserveEvent, Observer } from '../src/index';

/** Deterministic deps: scripted ids + fixed-step clock. */
function testDeps(overrides: Dependencies = {}): {
  deps: ReturnType<typeof resolveDependencies>;
  idCalls: () => number;
} {
  let id = 0;
  let now = 1_000;
  const base: Dependencies = {
    generateId: () => `id-${id++}`,
    clock: { now: () => (now += 10), setTimeout: (fn) => (fn(), () => {}) },
    ...overrides,
  };
  return { deps: resolveDependencies(base), idCalls: () => id };
}

function collector(): { events: ObserveEvent[]; observer: Observer } {
  const events: ObserveEvent[] = [];
  return { events, observer: { emit: (e) => events.push(e) } };
}

function pendingRunStarted(spanId = 'span'): Extract<PendingObserveEvent, { type: 'run.started' }> {
  return {
    type: 'run.started',
    spanId,
    operation: 'generate-text',
    provider: 'mock',
    model: 'mock-model',
    surface: 'chat_completions',
    durable: false,
    resumed: false,
    messageCount: 1,
    toolCount: 0,
  };
}

describe('observation runtime — fast path', () => {
  it('returns undefined with no observer and draws zero ids', () => {
    const { deps, idCalls } = testDeps();
    const rt = createObservationRuntime(deps);
    expect(rt).toBeUndefined();
    expect(idCalls()).toBe(0);
  });

  it('returns undefined when the observer disables itself', () => {
    const { deps, idCalls } = testDeps({
      observer: { options: { enabled: false }, emit: () => {} },
    });
    expect(createObservationRuntime(deps)).toBeUndefined();
    expect(idCalls()).toBe(0);
  });
});

describe('observation runtime — stamping', () => {
  it('stamps schemaVersion/eventId/sequence/timestamp/runId/executionId', () => {
    const { events, observer } = collector();
    const { deps } = testDeps({ observer });
    const rt = createObservationRuntime(deps)!;
    rt.emit(pendingRunStarted());
    rt.emit({
      type: 'run.completed',
      spanId: 'span',
      status: 'completed',
      durationMs: 5,
      finishReason: 'stop',
      endReason: 'natural',
      stepCount: 1,
      modelCallCount: 1,
      toolCallCount: 0,
      toolErrorCount: 0,
      deniedToolCount: 0,
      retryCount: 0,
      approvalCount: 0,
      checkpointCount: 0,
      subAgentCount: 0,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 3,
      },
    });

    expect(events).toHaveLength(2);
    const [started, completed] = events as [ObserveEvent, ObserveEvent];
    expect(started.schemaVersion).toBe(1);
    expect(started.sequence).toBe(0);
    expect(completed.sequence).toBe(1);
    expect(started.runId).toBe(completed.runId);
    expect(started.executionId).toBe(completed.executionId);
    // ids come from the injected generateId — deterministic
    expect(started.eventId).toMatch(/^id-\d+$/);
    // timestamps come from the injected clock
    expect(typeof started.timestamp).toBe('number');
    expect(completed.timestamp).toBeGreaterThan(started.timestamp);
  });

  it('adopts a provided runId (durable correlation)', () => {
    const { events, observer } = collector();
    const { deps } = testDeps({ observer });
    const rt = createObservationRuntime(deps, { runId: 'session-run-7' })!;
    rt.emit(pendingRunStarted());
    expect(events[0]!.runId).toBe('session-run-7');
  });

  it('merges option metadata into every event and sanitizes invalid values', () => {
    const { events, observer } = collector();
    const meta = {
      app: 'deuz',
      // invalid values must degrade, not throw
      fn: (() => {}) as unknown as string,
      nested: { a: 1 } as unknown as string,
    };
    const { deps } = testDeps({
      observer: { options: { metadata: meta }, emit: observer.emit },
    });
    const rt = createObservationRuntime(deps)!;
    rt.emit(pendingRunStarted());
    expect(events[0]!.metadata).toEqual({
      app: 'deuz',
      fn: '[Unserializable]',
      nested: '[Unserializable]',
    });
  });
});

describe('observation runtime — terminal guard', () => {
  it('drops a second terminal event and warns', () => {
    const { events, observer } = collector();
    const warnings: string[] = [];
    const { deps } = testDeps({
      observer,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    const rt = createObservationRuntime(deps)!;
    const terminal: PendingObserveEvent = {
      type: 'run.aborted',
      spanId: 's',
      status: 'aborted',
      durationMs: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
      },
    };
    rt.emit(terminal);
    rt.emit(terminal);
    expect(events).toHaveLength(1);
    expect(warnings.some((w) => w.includes('duplicate terminal'))).toBe(true);
  });

  it('allows cost.calculated after the terminal event', () => {
    const { events, observer } = collector();
    const { deps } = testDeps({ observer });
    const rt = createObservationRuntime(deps)!;
    rt.emit({
      type: 'run.aborted',
      spanId: 's',
      status: 'aborted',
      durationMs: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
      },
    });
    rt.emit({
      type: 'cost.calculated',
      spanId: 's',
      target: 'run',
      provider: 'mock',
      model: 'mock-model',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
      costUsd: 0.001,
    });
    expect(events.map((e) => e.type)).toEqual(['run.aborted', 'cost.calculated']);
  });
});

describe('observation runtime — isolation (G2)', () => {
  it('a throwing observer never propagates', () => {
    const { deps } = testDeps({
      observer: {
        emit: () => {
          throw new Error('observer exploded');
        },
      },
    });
    const rt = createObservationRuntime(deps)!;
    expect(() => rt.emit(pendingRunStarted())).not.toThrow();
  });

  it('a throwing custom redactor degrades the field, not the run', () => {
    const { events, observer } = collector();
    const { deps } = testDeps({
      observer: {
        options: {
          capture: { messages: true },
          redact: () => {
            throw new Error('redactor bug');
          },
        },
        emit: observer.emit,
      },
    });
    const rt = createObservationRuntime(deps)!;
    rt.emit({ ...pendingRunStarted(), capturedMessages: [{ role: 'user' }] });
    const started = events[0] as Extract<ObserveEvent, { type: 'run.started' }>;
    expect(started.capturedMessages).toBe('[RedactionError]');
  });
});

describe('observation runtime — structural limits', () => {
  it('truncates long strings/arrays/depth and flags the event', () => {
    const { events, observer } = collector();
    const { deps } = testDeps({
      observer: {
        options: {
          capture: { toolInputs: true },
          limits: { maxStringLength: 5, maxArrayLength: 2, maxObjectDepth: 2 },
        },
        emit: observer.emit,
      },
    });
    const rt = createObservationRuntime(deps)!;
    rt.emit({
      type: 'tool.started',
      spanId: 's',
      toolCallId: 'c1',
      toolName: 't',
      needsApproval: false,
      executionMode: 'server',
      parallel: false,
      capturedInput: {
        long: 'abcdefghij',
        arr: [1, 2, 3, 4],
        deep: { a: { b: { c: 1 } } },
      },
    });
    const ev = events[0] as Extract<ObserveEvent, { type: 'tool.started' }>;
    expect(ev.truncated).toBe(true);
    const input = ev.capturedInput as Record<string, unknown>;
    expect(input.long).toBe('abcde[Truncated]');
    expect(input.arr).toEqual([1, 2, '[Truncated]']);
  });

  it('circular and bigint payloads degrade instead of throwing', () => {
    const { events, observer } = collector();
    const { deps } = testDeps({
      observer: { options: { capture: { toolOutputs: true } }, emit: observer.emit },
    });
    const rt = createObservationRuntime(deps)!;
    const cyc: Record<string, unknown> = { big: 1n };
    cyc.self = cyc;
    expect(() =>
      rt.emit({
        type: 'tool.completed',
        spanId: 's',
        toolCallId: 'c1',
        toolName: 't',
        durationMs: 1,
        outputType: 'object',
        capturedOutput: cyc,
      }),
    ).not.toThrow();
    const ev = events[0] as Extract<ObserveEvent, { type: 'tool.completed' }>;
    const out = ev.capturedOutput as Record<string, unknown>;
    expect(out.big).toBe('[Unserializable]');
    expect(out.self).toBe('[Unserializable]');
  });
});

describe('observation runtime — counters', () => {
  it('auto-counts model/tool/retry/approval/checkpoint/subagent events', () => {
    const { observer } = collector();
    const { deps } = testDeps({ observer });
    const rt = createObservationRuntime(deps)!;
    rt.emit({
      type: 'model.started',
      spanId: 's',
      provider: 'p',
      model: 'm',
      surface: 'chat_completions',
      maxRetries: 2,
      messageCount: 1,
      toolCount: 0,
    });
    rt.emit({
      type: 'model.retry',
      spanId: 's',
      provider: 'p',
      model: 'm',
      failedAttempt: 0,
      nextAttempt: 1,
      delayMs: 100,
      reason: 'rate-limit',
      statusCode: 429,
    });
    rt.emit({
      type: 'tool.started',
      spanId: 's2',
      toolCallId: 'c',
      toolName: 't',
      needsApproval: false,
      executionMode: 'server',
      parallel: false,
    });
    rt.emit({
      type: 'tool.denied',
      spanId: 's2',
      toolCallId: 'c2',
      toolName: 't',
      cause: 'no-response',
    });
    expect(rt.counters).toMatchObject({
      modelCalls: 1,
      retries: 1,
      toolCalls: 1,
      denials: 1,
    });
  });
});

describe('toObservedError', () => {
  it('maps DeuzError codes to categories', () => {
    expect(toObservedError(new RateLimitError({ message: 'slow down' }), false)).toMatchObject({
      category: 'rate-limit',
      code: 'rate_limit',
      statusCode: 429,
      retryable: true,
    });
    expect(toObservedError(new TimeoutError('ttft'), false).category).toBe('timeout');
    expect(toObservedError(new AbortError(), false).category).toBe('aborted');
  });

  it('splits authentication vs authorization on statusCode', () => {
    expect(toObservedError(new AuthenticationError({ message: 'no key' }), false).category).toBe(
      'authentication',
    );
    expect(
      toObservedError(new AuthenticationError({ message: 'forbidden', statusCode: 403 }), false)
        .category,
    ).toBe('authorization');
  });

  it('omits message unless captured, and redacts it when captured', () => {
    const err = new RateLimitError({ message: 'key sk-ant-supersecretvalue123 leaked' });
    expect(toObservedError(err, false).message).toBeUndefined();
    const captured = toObservedError(err, true);
    expect(captured.message).not.toContain('sk-ant-supersecretvalue123');
    expect(captured.message).toContain(OBSERVE_REDACTED);
  });

  it('handles non-DeuzError values', () => {
    expect(toObservedError('boom', true)).toMatchObject({ category: 'unknown', message: 'boom' });
    expect(toObservedError(new RangeError('x'), false)).toMatchObject({
      name: 'RangeError',
      category: 'unknown',
    });
  });
});

describe('observation redaction profile', () => {
  it('replaces token patterns with [REDACTED] (no last-4 tail)', () => {
    const input =
      'auth Bearer abc.def.ghi and sk-1234567890abcdef1234 plus AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
    const out = redactObservationString(input);
    expect(out).not.toMatch(/sk-\w{5}/);
    expect(out).not.toContain('AIzaSy');
    expect(out).toContain(OBSERVE_REDACTED);
    // the log-profile maskSecret is untouched (P0 pin lives in internal.test.ts)
    expect(maskSecret('sk-abcdef123456')).toBe('****3456');
  });

  it('redacts secret keys wholesale, wherever they nest', () => {
    const out = redactForObservation({
      headers: { Authorization: 'Bearer tok', Cookie: 'sid=1' },
      config: { api_key: 'k', password: 'p', 'private-key': 'pem' },
      safe: 'hello',
    }) as Record<string, Record<string, unknown>> & { safe: string };
    expect(out.headers!.Authorization).toBe(OBSERVE_REDACTED);
    expect(out.headers!.Cookie).toBe(OBSERVE_REDACTED);
    expect(out.config!.api_key).toBe(OBSERVE_REDACTED);
    expect(out.config!.password).toBe(OBSERVE_REDACTED);
    expect(out.config!['private-key']).toBe(OBSERVE_REDACTED);
    expect(out.safe).toBe('hello');
  });

  it('redacts JWTs and PEM blocks', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P';
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQ==\n-----END PRIVATE KEY-----';
    expect(redactObservationString(`token ${jwt}`)).not.toContain(jwt);
    expect(redactObservationString(pem)).toBe(OBSERVE_REDACTED);
  });
});
