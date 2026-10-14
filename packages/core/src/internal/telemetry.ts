/**
 * 2.4 telemetry (spec §3.6): the span names and attribute keys of the new
 * subsystems, and the one helper they report through. Nothing new is wired:
 * a span is an `operation.*` observation event whose `operation` is the span
 * name, so `/observe` observers see it and `createOtelObserver` turns it into
 * a span of that name, with the attributes on it.
 *
 * Attributes carry only scalars: counts, ids, digests, token values and small
 * enums. Never put memory text, transcript, tool output or any other content
 * in one. Without an observer (or tracer) the work runs bare: no event is
 * built and no id is drawn. An observer that throws never reaches the work.
 * Edge-safe.
 */
import type { ResolvedDependencies } from '../types/deps';
import type { ObservedSubsystem } from '../types/observe';
import { toObservedError } from './observe-error';
import { createObservationRuntime, type ObservationRuntime } from './observe-runtime';

/** The span names of spec §3.6, one per reported operation. */
export const DEUZ_SPAN = {
  /** A context package compiled for a model step (or recompiled on overflow). */
  contextCompile: 'deuz.context.compile',
  /** A versioned memory operation: remember, revise, retract, forget, reembed, import. */
  memoryOp: 'deuz.memory.op',
  /** The supervisor claimed a goal (took its lease). */
  goalClaim: 'deuz.goal.claim',
  /** The supervisor started or resumed a run for a goal. */
  goalDispatch: 'deuz.goal.dispatch',
  /** The supervisor retried a goal's run after a retryable failure. */
  goalRetry: 'deuz.goal.retry',
  /** A cancel was recorded for a goal. */
  goalCancelRequested: 'deuz.goal.cancel_requested',
  /** A recorded cancel took effect on the goal's run. */
  goalCancelApplied: 'deuz.goal.cancel_applied',
  /** The supervisor drained (stopped taking work, run at a safe checkpoint). */
  goalDrain: 'deuz.goal.drain',
  /** A goal moved to a new `specGeneration`. */
  goalGeneration: 'deuz.goal.generation',
  /** A schedule occurrence was delivered to a goal inbox (or disposed of). */
  scheduleDelivery: 'deuz.schedule.delivery',
  processStart: 'deuz.process.start',
  processPoll: 'deuz.process.poll',
  processCancel: 'deuz.process.cancel',
  processExit: 'deuz.process.exit',
  processReconcile: 'deuz.process.reconcile',
  /** A batch of stream frames committed (and then published). */
  streamBatch: 'deuz.stream.batch',
  /** A write from a fenced-off (stale) stream producer was refused. */
  streamFenced: 'deuz.stream.fenced',
} as const;

/** One 2.4 span name. */
export type DeuzSpanName = (typeof DEUZ_SPAN)[keyof typeof DEUZ_SPAN];

/** The subsystems that report 2.4 spans. */
export type TelemetrySubsystem = Extract<
  ObservedSubsystem,
  'context' | 'memory' | 'goal' | 'schedule' | 'process' | 'stream'
>;

/**
 * The attribute keys of spec §3.6. A per-source context count goes under
 * `deuz.context.source.<source>.selected|excluded|tokens`.
 */
export const DEUZ_ATTR = {
  contextSelected: 'deuz.context.selected',
  contextExcluded: 'deuz.context.excluded',
  contextTokens: 'deuz.context.tokens',
  contextEstimator: 'deuz.context.estimator',
  contextRefreshReason: 'deuz.context.refresh_reason',
  contextFallback: 'deuz.context.fallback',
  contextCachePrefixChanged: 'deuz.context.cache_prefix_changed',
  contextManifestDigest: 'deuz.context.manifest_digest',
  memoryOperation: 'deuz.memory.operation',
  memoryRecordCount: 'deuz.memory.record_count',
  memoryConflictRetries: 'deuz.memory.conflict_retries',
  memoryEmbeddingGeneration: 'deuz.memory.embedding_generation',
  goalId: 'deuz.goal.id',
  goalRevision: 'deuz.goal.revision',
  goalSpecGeneration: 'deuz.goal.spec_generation',
  goalRunId: 'deuz.goal.run_id',
  goalAttempt: 'deuz.goal.attempt',
  scheduleId: 'deuz.schedule.id',
  scheduleOccurrenceId: 'deuz.schedule.occurrence_id',
  scheduleDisposition: 'deuz.schedule.disposition',
  scheduleCatchUp: 'deuz.schedule.catch_up',
  processOperationId: 'deuz.process.operation_id',
  processExitCode: 'deuz.process.exit_code',
  processTruncated: 'deuz.process.truncated',
  processReconcileResult: 'deuz.process.reconcile_result',
  processOrphans: 'deuz.process.orphans',
  streamBatchFrames: 'deuz.stream.batch_frames',
  streamBatchBytes: 'deuz.stream.batch_bytes',
  streamCommitMs: 'deuz.stream.commit_ms',
  streamFencingToken: 'deuz.stream.fencing_token',
} as const;

/** Scalar span attributes: never content. */
export type TelemetryAttributes = Readonly<Record<string, string | number | boolean>>;

/** Where a span reports when it runs inside a run leg. */
export interface TelemetryParent {
  /** The leg's observation runtime: the span shares its run and execution ids. */
  runtime?: ObservationRuntime;
  /** The span this one is a child of (the step or the run span). */
  parentSpanId?: string;
  agentPath?: readonly string[];
}

/** The subsystem a span belongs to: the segment after `deuz.`. */
export function spanSubsystem(span: DeuzSpanName): TelemetrySubsystem {
  return span.split('.')[1] as TelemetrySubsystem;
}

function identity(parent: TelemetryParent | undefined) {
  return {
    ...(parent?.parentSpanId !== undefined ? { parentSpanId: parent.parentSpanId } : {}),
    ...(parent?.agentPath !== undefined ? { agentPath: parent.agentPath } : {}),
  };
}

const withAttributes = (attributes: TelemetryAttributes | undefined) =>
  attributes !== undefined && Object.keys(attributes).length > 0 ? { attributes } : {};

/**
 * Runs `fn` as the span `span`: `operation.started` with `attributes`, then
 * `operation.completed` (or `operation.failed`, after which the error is
 * rethrown unchanged) with what `fn` added through `annotate`. Pass `parent`
 * for work inside a run leg; otherwise the span is a leg of its own.
 */
export async function observeSpan<T>(
  deps: ResolvedDependencies,
  span: DeuzSpanName,
  attributes: TelemetryAttributes | undefined,
  fn: (annotate: (more: TelemetryAttributes) => void) => Promise<T>,
  parent?: TelemetryParent,
): Promise<T> {
  const gathered: Record<string, string | number | boolean> = {};
  const annotate = (more: TelemetryAttributes): void => {
    Object.assign(gathered, more);
  };
  const rt = parent?.runtime ?? createObservationRuntime(deps);
  if (!rt) return fn(annotate);
  const subsystem = spanSubsystem(span);
  const handle = rt.startSpan();
  rt.emit({
    type: 'operation.started',
    spanId: handle.spanId,
    ...identity(parent),
    subsystem,
    operation: span,
    ...withAttributes(attributes),
  });
  try {
    const result = await fn(annotate);
    rt.emit({
      type: 'operation.completed',
      spanId: handle.spanId,
      ...identity(parent),
      subsystem,
      operation: span,
      durationMs: rt.durationSince(handle.startedAt),
      ...withAttributes(gathered),
    });
    return result;
  } catch (error) {
    rt.emit({
      type: 'operation.failed',
      spanId: handle.spanId,
      ...identity(parent),
      subsystem,
      operation: span,
      durationMs: rt.durationSince(handle.startedAt),
      error: toObservedError(error, rt.capture.errorMessages),
      ...withAttributes(gathered),
    });
    throw error;
  }
}

/** Records a moment (a fencing refusal, a cancel request) as a zero-length span. */
export function recordSpan(
  deps: ResolvedDependencies,
  span: DeuzSpanName,
  attributes: TelemetryAttributes | undefined,
  parent?: TelemetryParent,
): void {
  const rt = parent?.runtime ?? createObservationRuntime(deps);
  if (!rt) return;
  const subsystem = spanSubsystem(span);
  const handle = rt.startSpan();
  rt.emit({
    type: 'operation.started',
    spanId: handle.spanId,
    ...identity(parent),
    subsystem,
    operation: span,
  });
  rt.emit({
    type: 'operation.completed',
    spanId: handle.spanId,
    ...identity(parent),
    subsystem,
    operation: span,
    durationMs: 0,
    ...withAttributes(attributes),
  });
}
