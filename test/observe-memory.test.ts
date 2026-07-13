import { describe, it, expect } from 'vitest';
import {
  createCallbackObserver,
  createMemoryObserver,
  composeObservers,
  filterObserver,
  summarizeRun,
} from '../src/observe';
import { resolveDependencies } from '../src/internal/resolve-deps';
import { createObservationRuntime } from '../src/internal/observe-runtime';
import type { Dependencies, ObserveEvent, Usage } from '../src/index';

const USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 15,
};

function stamped(partial: Partial<ObserveEvent> & { type: ObserveEvent['type'] }): ObserveEvent {
  return {
    schemaVersion: 1,
    eventId: 'e',
    sequence: 0,
    timestamp: 1,
    runId: 'r1',
    executionId: 'x1',
    spanId: 's1',
    ...partial,
  } as ObserveEvent;
}

describe('createMemoryObserver', () => {
  it('stores events and answers per-run queries', () => {
    const mem = createMemoryObserver();
    mem.emit(
      stamped({ type: 'run.started', runId: 'a' } as Partial<ObserveEvent> & {
        type: 'run.started';
      }),
    );
    mem.emit(
      stamped({ type: 'run.started', runId: 'b' } as Partial<ObserveEvent> & {
        type: 'run.started';
      }),
    );
    mem.emit(
      stamped({ type: 'run.completed', runId: 'b' } as Partial<ObserveEvent> & {
        type: 'run.completed';
      }),
    );
    expect(mem.events()).toHaveLength(3);
    expect(mem.eventsForRun('a')).toHaveLength(1);
    expect(mem.latestRun()?.map((e) => e.type)).toEqual(['run.started', 'run.completed']);
  });

  it('caps memory: drop-oldest keeps the newest events', () => {
    const mem = createMemoryObserver({ maxEvents: 2 });
    mem.emit(stamped({ type: 'run.started', sequence: 0 }));
    mem.emit(
      stamped({ type: 'model.started', sequence: 1 } as Partial<ObserveEvent> & {
        type: 'model.started';
      }),
    );
    mem.emit(
      stamped({ type: 'model.completed', sequence: 2 } as Partial<ObserveEvent> & {
        type: 'model.completed';
      }),
    );
    expect(mem.droppedCount).toBe(1);
    expect(mem.events().map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('drop-newest keeps the oldest events', () => {
    const mem = createMemoryObserver({ maxEvents: 1, overflow: 'drop-newest' });
    mem.emit(stamped({ type: 'run.started', sequence: 0 }));
    mem.emit(
      stamped({ type: 'run.completed', sequence: 1 } as Partial<ObserveEvent> & {
        type: 'run.completed';
      }),
    );
    expect(mem.droppedCount).toBe(1);
    expect(mem.events().map((e) => e.sequence)).toEqual([0]);
  });

  it('clear() resets buffer, droppedCount and latestRun', () => {
    const mem = createMemoryObserver({ maxEvents: 1 });
    mem.emit(stamped({ type: 'run.started' }));
    mem.emit(
      stamped({ type: 'run.completed' } as Partial<ObserveEvent> & { type: 'run.completed' }),
    );
    mem.clear();
    expect(mem.events()).toHaveLength(0);
    expect(mem.droppedCount).toBe(0);
    expect(mem.latestRun()).toBeUndefined();
  });
});

describe('composeObservers', () => {
  it('one throwing child never blocks the others', () => {
    const seen: string[] = [];
    const bad = createCallbackObserver(() => {
      throw new Error('bad child');
    });
    const explicitBad = {
      emit() {
        throw new Error('raw throw');
      },
    };
    const good = createCallbackObserver((e) => seen.push(e.type));
    const composite = composeObservers(explicitBad, bad, good);
    expect(() => composite.emit(stamped({ type: 'run.started' }))).not.toThrow();
    expect(seen).toEqual(['run.started']);
  });

  it('merges options: capture OR, sampleRate max, limits min, metadata merge', () => {
    const a = createCallbackObserver(() => {}, {
      sampleRate: 0.2,
      capture: { messages: true },
      limits: { maxStringLength: 100 },
      metadata: { team: 'a', env: 'dev' },
    });
    const b = createCallbackObserver(() => {}, {
      sampleRate: 0.9,
      capture: { toolInputs: true, messages: false },
      limits: { maxStringLength: 50, maxArrayLength: 10 },
      metadata: { env: 'prod' },
    });
    const merged = composeObservers(a, b).options!;
    expect(merged.sampleRate).toBe(0.9);
    expect(merged.capture).toMatchObject({ messages: true, toolInputs: true });
    expect(merged.limits).toMatchObject({ maxStringLength: 50, maxArrayLength: 10 });
    expect(merged.metadata).toEqual({ team: 'a', env: 'prod' });
  });

  it('skips children that disabled themselves; disabled-only composite is disabled', () => {
    const seen: string[] = [];
    const off = createCallbackObserver((e) => seen.push(`off:${e.type}`), { enabled: false });
    const on = createCallbackObserver((e) => seen.push(`on:${e.type}`));
    composeObservers(off, on).emit(stamped({ type: 'run.started' }));
    expect(seen).toEqual(['on:run.started']);
    expect(composeObservers(off).options?.enabled).toBe(false);
  });

  it('flush/close reach every child and swallow rejections', async () => {
    const calls: string[] = [];
    const flaky = {
      emit() {},
      flush: () => {
        calls.push('flaky.flush');
        return Promise.reject(new Error('flush fail'));
      },
      close: () => {
        calls.push('flaky.close');
        return Promise.reject(new Error('close fail'));
      },
    };
    const solid = {
      emit() {},
      flush: () => {
        calls.push('solid.flush');
      },
      close: () => {
        calls.push('solid.close');
      },
    };
    const composite = composeObservers(flaky, solid);
    await expect(Promise.resolve(composite.flush?.())).resolves.toBeUndefined();
    await expect(Promise.resolve(composite.close?.())).resolves.toBeUndefined();
    expect(calls).toEqual(['flaky.flush', 'solid.flush', 'flaky.close', 'solid.close']);
  });
});

describe('composeObservers — per-sink capture projection (1.6.1)', () => {
  function capturedEvent(): ObserveEvent {
    return stamped({
      type: 'tool.completed',
      toolCallId: 'c1',
      toolName: 't',
      durationMs: 1,
      outputType: 'object',
      capturedOutput: { result: 'raw tool output' },
    } as Partial<ObserveEvent> & { type: 'tool.completed' });
  }

  function startedEvent(): ObserveEvent {
    return stamped({
      type: 'tool.started',
      toolCallId: 'c1',
      toolName: 't',
      needsApproval: false,
      executionMode: 'server',
      parallel: false,
      capturedInput: { q: 'raw tool input' },
    } as Partial<ObserveEvent> & { type: 'tool.started' });
  }

  it('a capture-off sink composed with a capture-on one never sees captured content', () => {
    const localSeen: ObserveEvent[] = [];
    const remoteSeen: ObserveEvent[] = [];
    const local: import('../src/index').Observer = {
      options: { capture: { toolOutputs: true, toolInputs: true } },
      emit: (e) => localSeen.push(e),
    };
    const remote: import('../src/index').Observer = { emit: (e) => remoteSeen.push(e) }; // bare: defaults = everything off
    const composite = composeObservers(local, remote);
    composite.emit(capturedEvent());
    composite.emit(startedEvent());

    const localDone = localSeen[0] as Extract<ObserveEvent, { type: 'tool.completed' }>;
    const remoteDone = remoteSeen[0] as Extract<ObserveEvent, { type: 'tool.completed' }>;
    expect(localDone.capturedOutput).toEqual({ result: 'raw tool output' });
    expect(remoteDone.capturedOutput).toBeUndefined();
    const localStart = localSeen[1] as Extract<ObserveEvent, { type: 'tool.started' }>;
    const remoteStart = remoteSeen[1] as Extract<ObserveEvent, { type: 'tool.started' }>;
    expect(localStart.capturedInput).toEqual({ q: 'raw tool input' });
    expect(remoteStart.capturedInput).toBeUndefined();
    // non-captured fields are untouched by the projection
    expect(remoteDone.durationMs).toBe(1);
  });

  it('partial capture: only the enabled field survives per sink', () => {
    const seen: ObserveEvent[] = [];
    const inputsOnly = composeObservers(
      { options: { capture: { toolOutputs: true } }, emit: () => {} },
      { options: { capture: { toolInputs: true } }, emit: (e) => seen.push(e) },
    );
    inputsOnly.emit(capturedEvent());
    inputsOnly.emit(startedEvent());
    const done = seen[0] as Extract<ObserveEvent, { type: 'tool.completed' }>;
    const start = seen[1] as Extract<ObserveEvent, { type: 'tool.started' }>;
    expect(done.capturedOutput).toBeUndefined(); // outputs not enabled on THIS sink
    expect(start.capturedInput).toEqual({ q: 'raw tool input' });
  });

  it('error.message is gated per sink too', () => {
    const withMsg: ObserveEvent[] = [];
    const withoutMsg: ObserveEvent[] = [];
    const failed = stamped({
      type: 'run.failed',
      status: 'failed',
      durationMs: 1,
      error: { name: 'E', category: 'unknown', message: 'sensitive detail' },
      stepCount: 0,
      modelCallCount: 0,
      toolCallCount: 0,
      retryCount: 0,
    } as Partial<ObserveEvent> & { type: 'run.failed' });
    composeObservers(
      { options: { capture: { errorMessages: true } }, emit: (e) => withMsg.push(e) },
      { emit: (e) => withoutMsg.push(e) },
    ).emit(failed);
    expect((withMsg[0] as Extract<ObserveEvent, { type: 'run.failed' }>).error.message).toBe(
      'sensitive detail',
    );
    expect(
      (withoutMsg[0] as Extract<ObserveEvent, { type: 'run.failed' }>).error.message,
    ).toBeUndefined();
    expect((withoutMsg[0] as Extract<ObserveEvent, { type: 'run.failed' }>).error.name).toBe('E');
  });

  it("a child's redactor applies ONLY to its own view, and the final barrier still runs after it", () => {
    const aSeen: ObserveEvent[] = [];
    const bSeen: ObserveEvent[] = [];
    composeObservers(
      {
        options: {
          capture: { toolOutputs: true, toolInputs: true },
          // hostile: tries to reintroduce a secret into its own view
          redact: () => 'leak sk-ant-reintroduced-by-child-redactor00',
        },
        emit: (e) => aSeen.push(e),
      },
      {
        options: { capture: { toolOutputs: true, toolInputs: true } },
        emit: (e) => bSeen.push(e),
      },
    ).emit(capturedEvent());
    const a = aSeen[0] as Extract<ObserveEvent, { type: 'tool.completed' }>;
    const b = bSeen[0] as Extract<ObserveEvent, { type: 'tool.completed' }>;
    // A's redactor output passed through the default sweep — no secret survives
    expect(JSON.stringify(a)).not.toContain('sk-ant-reintroduced');
    expect(a.capturedOutput).toContain('[REDACTED]');
    // B's view is untouched by A's redactor
    expect(b.capturedOutput).toEqual({ result: 'raw tool output' });
  });

  it('fast path: no captured fields → children receive the SAME event reference', () => {
    const seen: ObserveEvent[] = [];
    const event = stamped({ type: 'run.started' });
    composeObservers({ emit: (e) => seen.push(e) }).emit(event);
    expect(seen[0]).toBe(event);
  });
});

describe('filterObserver', () => {
  it('forwards matching events only; throwing predicate drops the event', () => {
    const seen: string[] = [];
    const inner = createCallbackObserver((e) => seen.push(e.type));
    const onlyRuns = filterObserver(inner, (e) => e.type.startsWith('run.'));
    onlyRuns.emit(stamped({ type: 'run.started' }));
    onlyRuns.emit(
      stamped({ type: 'model.started' } as Partial<ObserveEvent> & { type: 'model.started' }),
    );
    const explosive = filterObserver(inner, () => {
      throw new Error('predicate bug');
    });
    expect(() => explosive.emit(stamped({ type: 'run.started' }))).not.toThrow();
    expect(seen).toEqual(['run.started']);
  });
});

describe('summarizeRun', () => {
  /** Drive the real runtime so summaries consume genuine stamped events. */
  function runThrough(): ObserveEvent[] {
    const mem = createMemoryObserver();
    let id = 0;
    let now = 0;
    const deps: Dependencies = {
      observer: mem,
      generateId: () => `id-${id++}`,
      clock: { now: () => (now += 100), setTimeout: (fn) => (fn(), () => {}) },
    };
    const rt = createObservationRuntime(resolveDependencies(deps), { runId: 'run-1' })!;
    const { spanId } = rt.startSpan();
    rt.emit({
      type: 'run.started',
      spanId,
      operation: 'generate-text',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      surface: 'anthropic',
      durable: false,
      resumed: false,
      messageCount: 2,
      toolCount: 1,
    });
    rt.emit({
      type: 'model.started',
      spanId: 'm1',
      parentSpanId: spanId,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      surface: 'anthropic',
      maxRetries: 2,
      messageCount: 2,
      toolCount: 1,
    });
    rt.emit({
      type: 'model.retry',
      spanId: 'm1',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      failedAttempt: 0,
      nextAttempt: 1,
      delayMs: 250,
      reason: 'overloaded',
      statusCode: 529,
    });
    rt.emit({
      type: 'step.completed',
      spanId: 'st1',
      parentSpanId: spanId,
      stepIndex: 0,
      durationMs: 300,
      finishReason: 'stop',
      toolCallCount: 1,
      toolResultCount: 1,
      toolErrorCount: 0,
      deniedToolCount: 0,
      usage: USAGE,
      cumulativeUsage: USAGE,
    });
    rt.emit({
      type: 'run.completed',
      spanId,
      status: 'completed',
      durationMs: 400,
      finishReason: 'stop',
      endReason: 'natural',
      stepCount: 1,
      modelCallCount: 1,
      toolCallCount: 1,
      toolErrorCount: 0,
      deniedToolCount: 0,
      retryCount: 1,
      approvalCount: 0,
      checkpointCount: 0,
      subAgentCount: 0,
      usage: USAGE,
    });
    rt.emit({
      type: 'cost.calculated',
      spanId,
      target: 'run',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      usage: USAGE,
      costUsd: 0.05,
    });
    return [...mem.latestRun()!];
  }

  it('aggregates counts/usage/cost/status from real runtime output', () => {
    const summary = summarizeRun(runThrough());
    expect(summary).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      executionCount: 1,
      stepCount: 1,
      modelCallCount: 1,
      retryCount: 1,
      costUsd: 0.05,
    });
    expect(summary.usage.totalTokens).toBe(15);
    expect(summary.durationMs).toBeGreaterThan(0);
  });

  it('sorts by sequence when events arrive shuffled (cost after terminal tolerated)', () => {
    const events = runThrough();
    const shuffled = [events[4]!, events[0]!, events[5]!, events[2]!, events[1]!, events[3]!];
    expect(summarizeRun(shuffled)).toEqual(summarizeRun(events));
  });

  it('returns running with no terminal event; empty input is safe', () => {
    const events = runThrough().filter(
      (e) => e.type !== 'run.completed' && e.type !== 'cost.calculated',
    );
    expect(summarizeRun(events).status).toBe('running');
    expect(summarizeRun(events).finishedAt).toBeUndefined();
    expect(summarizeRun([]).status).toBe('running');
    expect(summarizeRun([]).executionCount).toBe(0);
  });

  it('merges execution legs: suspended leg + completed resume leg', () => {
    const legA: ObserveEvent[] = [
      stamped({ type: 'run.started', executionId: 'xA', sequence: 0, timestamp: 100 }),
      stamped({
        type: 'run.suspended',
        executionId: 'xA',
        sequence: 1,
        timestamp: 200,
        reason: 'approval',
        status: 'suspended',
        durationMs: 100,
        pendingApprovalCount: 1,
        pendingToolCount: 0,
        usage: USAGE,
      } as Partial<ObserveEvent> & { type: 'run.suspended' }),
    ];
    const legB: ObserveEvent[] = [
      stamped({
        type: 'run.started',
        executionId: 'xB',
        sequence: 0,
        timestamp: 300,
        resumed: true,
      } as Partial<ObserveEvent> & { type: 'run.started' }),
      stamped({
        type: 'run.completed',
        executionId: 'xB',
        sequence: 1,
        timestamp: 400,
        status: 'completed',
        durationMs: 100,
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
        usage: USAGE,
      } as Partial<ObserveEvent> & { type: 'run.completed' }),
    ];
    const summary = summarizeRun([...legB, ...legA]); // shuffled leg order
    expect(summary.status).toBe('completed');
    expect(summary.executionCount).toBe(2);
    expect(summary.usage.totalTokens).toBe(30); // both legs' terminal usage summed
    expect(summary.startedAt).toBe(100);
    expect(summary.finishedAt).toBe(400);
  });
});
