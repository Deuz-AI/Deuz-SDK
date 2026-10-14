/**
 * OpenTelemetry mapping of the 2.4 subsystem operations (spec §3.6). The new
 * subsystems (context, goal, schedule, process, stream) report through the
 * existing `operation.*` events, named by their `deuz.*` span name and carrying
 * `attributes` (counts, ids, digests, token values; never content). Unlike the
 * 1.x auxiliary calls they run INSIDE a run leg (a context compile per model
 * step), so finishing one must not end the leg's own span tracking.
 */
import { describe, expect, it } from 'vitest';
import { createOtelObserver, otelReady } from '../src/otel';
import type { ObserveEvent } from '../src/types/observe';

interface FakeSpan {
  name: string;
  attributes: Record<string, unknown>;
  exceptions: unknown[];
  parentContext: unknown;
  ended: number;
}

function fakeOtel(): { tracer: unknown; spans: FakeSpan[] } {
  const spans: FakeSpan[] = [];
  const tracer = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }, context?: unknown) {
      const rec: FakeSpan = {
        name,
        attributes: { ...options?.attributes },
        exceptions: [],
        parentContext: context,
        ended: 0,
      };
      spans.push(rec);
      return {
        setAttribute(key: string, value: unknown) {
          rec.attributes[key] = value;
        },
        setAttributes(values: Record<string, unknown>) {
          Object.assign(rec.attributes, values);
        },
        addEvent() {},
        recordException(exception: unknown) {
          rec.exceptions.push(exception);
        },
        setStatus() {},
        end() {
          rec.ended += 1;
        },
      };
    },
  };
  return { tracer, spans };
}

const BASE = {
  schemaVersion: 1 as const,
  eventId: 'e0',
  timestamp: 0,
  runId: 'run-1',
  executionId: 'exec-1',
};
const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2,
};

const runStarted: ObserveEvent = {
  ...BASE,
  sequence: 0,
  type: 'run.started',
  spanId: 'root',
  operation: 'stream-chat',
  provider: 'xai',
  model: 'grok-4',
  surface: 'chat_completions',
  durable: true,
  resumed: false,
};

const runCompleted = (sequence: number): ObserveEvent => ({
  ...BASE,
  sequence,
  type: 'run.completed',
  spanId: 'root',
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
  usage: USAGE,
});

describe('createOtelObserver — 2.4 subsystem operations', () => {
  it('maps an in-run context compile to a deuz.context.compile child span with its attributes', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    observer.emit(runStarted);
    observer.emit({
      ...BASE,
      sequence: 1,
      type: 'operation.started',
      spanId: 'op-1',
      parentSpanId: 'root',
      stepIndex: 0,
      subsystem: 'context',
      operation: 'deuz.context.compile',
      attributes: {
        'deuz.context.refresh_reason': 'initial',
        'deuz.context.estimator': 'heuristic',
      },
    });
    observer.emit({
      ...BASE,
      sequence: 2,
      type: 'operation.completed',
      spanId: 'op-1',
      parentSpanId: 'root',
      stepIndex: 0,
      subsystem: 'context',
      operation: 'deuz.context.compile',
      durationMs: 1,
      resultCount: 3,
      attributes: {
        'deuz.context.selected': 3,
        'deuz.context.excluded': 2,
        'deuz.context.tokens': 812,
        'deuz.context.cache_prefix_changed': false,
      },
    });
    observer.emit(runCompleted(3));
    await otelReady(observer);

    expect(spans.map((span) => span.name)).toEqual(['invoke_agent', 'deuz.context.compile']);
    const [root, compile] = spans as [FakeSpan, FakeSpan];
    expect(compile.attributes).toMatchObject({
      'deuz.subsystem': 'context',
      'deuz.operation': 'deuz.context.compile',
      'deuz.step.index': 0,
      'deuz.context.refresh_reason': 'initial',
      'deuz.context.estimator': 'heuristic',
      'deuz.context.selected': 3,
      'deuz.context.excluded': 2,
      'deuz.context.tokens': 812,
      'deuz.context.cache_prefix_changed': false,
      'deuz.result.count': 3,
    });
    expect(compile.ended).toBe(1);
    // The leg survived the operation: its root span still closed with the run.
    expect(root.attributes['deuz.run.status']).toBe('completed');
    expect(root.ended).toBe(1);
  });

  it('keeps the run leg across an in-run memory recall too (the 2.3 path)', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    observer.emit(runStarted);
    observer.emit({
      ...BASE,
      sequence: 1,
      type: 'operation.started',
      spanId: 'op-1',
      parentSpanId: 'root',
      subsystem: 'memory',
      operation: 'memory.recall',
    });
    observer.emit({
      ...BASE,
      sequence: 2,
      type: 'operation.completed',
      spanId: 'op-1',
      parentSpanId: 'root',
      subsystem: 'memory',
      operation: 'memory.recall',
      durationMs: 1,
      resultCount: 0,
    });
    observer.emit(runCompleted(3));
    await otelReady(observer);

    const root = spans.find((span) => span.name === 'invoke_agent')!;
    expect(root.ended).toBe(1);
    expect(root.attributes['deuz.run.status']).toBe('completed');
    expect(spans.find((span) => span.name === 'memory.recall')!.ended).toBe(1);
  });

  it('records a failed 2.4 operation with its error type and attributes', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    observer.emit({
      ...BASE,
      sequence: 0,
      type: 'operation.started',
      spanId: 'op-1',
      subsystem: 'stream',
      operation: 'deuz.stream.batch',
      attributes: { 'deuz.stream.batch_frames': 4 },
    });
    observer.emit({
      ...BASE,
      sequence: 1,
      type: 'operation.failed',
      spanId: 'op-1',
      subsystem: 'stream',
      operation: 'deuz.stream.batch',
      durationMs: 2,
      error: { name: 'RevisionConflictError', category: 'unknown', code: 'revision_conflict' },
      attributes: { 'deuz.stream.fencing_token': 7 },
    });
    await otelReady(observer);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('deuz.stream.batch');
    expect(spans[0]!.attributes).toMatchObject({
      'deuz.subsystem': 'stream',
      'deuz.stream.batch_frames': 4,
      'deuz.stream.fencing_token': 7,
      'error.type': 'revision_conflict',
    });
    expect(spans[0]!.ended).toBe(1);
  });

  it('still closes a standalone auxiliary operation and forgets its leg', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    for (const sequence of [0, 2]) {
      observer.emit({
        ...BASE,
        executionId: `aux-${sequence}`,
        sequence: 0,
        type: 'operation.started',
        spanId: `op-${sequence}`,
        subsystem: 'goal',
        operation: 'deuz.goal.claim',
      });
      observer.emit({
        ...BASE,
        executionId: `aux-${sequence}`,
        sequence: 1,
        type: 'operation.completed',
        spanId: `op-${sequence}`,
        subsystem: 'goal',
        operation: 'deuz.goal.claim',
        durationMs: 0,
      });
    }
    await otelReady(observer);
    expect(spans.map((span) => [span.name, span.ended])).toEqual([
      ['deuz.goal.claim', 1],
      ['deuz.goal.claim', 1],
    ]);
  });
});
