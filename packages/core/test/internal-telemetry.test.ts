/**
 * internal/telemetry.ts (2.4): the span names of spec §3.6 and the one helper
 * every 2.4 subsystem reports through. It emits the existing `operation.*`
 * events (the `/observe` and `/otel` seams, no new dependency): the span name
 * is the operation, the subsystem comes from the name, and attributes carry
 * only scalars. Without an observer the work runs bare, drawing no id.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryObserver } from '../src/observe';
import { resolveDependencies } from '../src/internal/resolve-deps';
import { createObservationRuntime } from '../src/internal/observe-runtime';
import {
  DEUZ_ATTR,
  DEUZ_SPAN,
  observeSpan,
  recordSpan,
  spanSubsystem,
} from '../src/internal/telemetry';
import type { ObserveEvent } from '../src/index';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

function counter() {
  let ids = 0;
  let now = 100;
  return {
    generateId: () => `id-${++ids}`,
    clock: { now: () => (now += 5), setTimeout: () => () => {} },
    get ids() {
      return ids;
    },
  };
}

describe('span names', () => {
  it('covers every span family of spec §3.6 under deuz.<subsystem>.*', () => {
    const names = Object.values(DEUZ_SPAN);
    expect(names).toContain('deuz.context.compile');
    expect(names).toContain('deuz.memory.op');
    expect(names).toContain('deuz.schedule.delivery');
    for (const family of ['goal', 'process', 'stream']) {
      expect(names.some((name) => name.startsWith(`deuz.${family}.`))).toBe(true);
    }
    for (const name of names) expect(name).toMatch(/^deuz\.[a-z]+\.[a-z_]+$/);
  });

  it('derives each span subsystem from its name', () => {
    expect(spanSubsystem(DEUZ_SPAN.contextCompile)).toBe('context');
    expect(spanSubsystem(DEUZ_SPAN.memoryOp)).toBe('memory');
    expect(spanSubsystem(DEUZ_SPAN.goalClaim)).toBe('goal');
    expect(spanSubsystem(DEUZ_SPAN.scheduleDelivery)).toBe('schedule');
    expect(spanSubsystem(DEUZ_SPAN.processStart)).toBe('process');
    expect(spanSubsystem(DEUZ_SPAN.streamBatch)).toBe('stream');
  });

  it('keeps attribute keys inside their subsystem namespace', () => {
    for (const key of Object.values(DEUZ_ATTR)) expect(key).toMatch(/^deuz\.[a-z]+\.[a-z_.]+$/);
  });
});

describe('observeSpan', () => {
  it('wraps the work in operation.started/completed with the attributes it gathered', async () => {
    const observer = createMemoryObserver();
    const ids = counter();
    const deps = resolveDependencies({ observer, ...ids });
    const value = await observeSpan(
      deps,
      DEUZ_SPAN.contextCompile,
      { [DEUZ_ATTR.contextRefreshReason]: 'initial' },
      async (annotate) => {
        annotate({ [DEUZ_ATTR.contextSelected]: 3, [DEUZ_ATTR.contextTokens]: 640 });
        return 'package';
      },
    );
    expect(value).toBe('package');
    const [started, completed] = observer.events() as [
      Ev<'operation.started'>,
      Ev<'operation.completed'>,
    ];
    expect(observer.events().map((event) => event.type)).toEqual([
      'operation.started',
      'operation.completed',
    ]);
    expect(started).toMatchObject({
      subsystem: 'context',
      operation: 'deuz.context.compile',
      attributes: { 'deuz.context.refresh_reason': 'initial' },
    });
    expect(completed).toMatchObject({
      subsystem: 'context',
      operation: 'deuz.context.compile',
      spanId: started.spanId,
      attributes: { 'deuz.context.selected': 3, 'deuz.context.tokens': 640 },
    });
    expect(completed.durationMs).toBeGreaterThan(0);
  });

  it('reports a failure with its attributes and rethrows it unchanged', async () => {
    const observer = createMemoryObserver();
    const deps = resolveDependencies({ observer, ...counter() });
    const boom = new Error('daemon unreachable');
    await expect(
      observeSpan(deps, DEUZ_SPAN.processCancel, undefined, async (annotate) => {
        annotate({ [DEUZ_ATTR.processOperationId]: 'op-1' });
        throw boom;
      }),
    ).rejects.toBe(boom);
    const failed = observer.events().at(-1) as Ev<'operation.failed'>;
    expect(failed).toMatchObject({
      type: 'operation.failed',
      subsystem: 'process',
      operation: 'deuz.process.cancel',
      attributes: { 'deuz.process.operation_id': 'op-1' },
    });
    // Error text stays out unless the observer opted into it.
    expect(failed.error.message).toBeUndefined();
  });

  it('runs bare without an observer: no events, no ids drawn', async () => {
    const ids = counter();
    const deps = resolveDependencies(ids);
    const value = await observeSpan(deps, DEUZ_SPAN.goalClaim, { a: 1 }, async (annotate) => {
      annotate({ b: 2 });
      return 42;
    });
    expect(value).toBe(42);
    expect(ids.ids).toBe(0);
  });

  it('reports inside an existing run leg under its parent span', async () => {
    const observer = createMemoryObserver();
    const deps = resolveDependencies({ observer, ...counter() });
    const runtime = createObservationRuntime(deps)!;
    await observeSpan(deps, DEUZ_SPAN.memoryOp, undefined, async () => undefined, {
      runtime,
      parentSpanId: 'step-span',
      agentPath: ['root', 'child'],
    });
    const events = observer.events() as Ev<'operation.started' | 'operation.completed'>[];
    expect(events.every((event) => event.executionId === runtime.executionId)).toBe(true);
    expect(events.every((event) => event.parentSpanId === 'step-span')).toBe(true);
    expect(events[0]!.agentPath).toEqual(['root', 'child']);
  });

  it('never lets an observer failure reach the work', async () => {
    const deps = resolveDependencies({
      observer: {
        emit() {
          throw new Error('observer bug');
        },
      },
      ...counter(),
    });
    await expect(observeSpan(deps, DEUZ_SPAN.streamBatch, {}, async () => 'ok')).resolves.toBe(
      'ok',
    );
  });
});

describe('recordSpan', () => {
  it('records a moment as a zero-length span', () => {
    const observer = createMemoryObserver();
    const deps = resolveDependencies({ observer, ...counter() });
    recordSpan(deps, DEUZ_SPAN.streamFenced, { [DEUZ_ATTR.streamFencingToken]: 9 });
    const [started, completed] = observer.events() as [
      Ev<'operation.started'>,
      Ev<'operation.completed'>,
    ];
    expect(started.operation).toBe('deuz.stream.fenced');
    expect(completed.durationMs).toBe(0);
    expect(completed.attributes).toEqual({ 'deuz.stream.fencing_token': 9 });
  });
});
