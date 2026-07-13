/**
 * Built-in observers (1.6) — local-first sinks for the observation event
 * protocol, edge-safe (no ambient time/id/console; timestamps and ids arrive
 * already stamped on events). See `@deuz-sdk/core/observe/node` for the JSONL
 * file observer.
 */
import type {
  ObserveEvent,
  Observer,
  ObservationOptions,
  ObservationCaptureOptions,
  ObservationLimits,
  ObservedError,
} from './types/observe';
import type { Usage } from './types/usage';
import { CAPTURE_FIELDS } from './internal/observe-runtime';
import { redactForObservation } from './internal/redact';

// ---------------------------------------------------------------------------
// Callback observer
// ---------------------------------------------------------------------------

/** Wrap a plain callback. A throwing callback is swallowed — never the run's problem. */
export function createCallbackObserver(
  callback: (event: ObserveEvent) => void,
  options?: ObservationOptions,
): Observer {
  return {
    options,
    emit(event) {
      try {
        callback(event);
      } catch {
        // observer failures never propagate (G2)
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memory observer
// ---------------------------------------------------------------------------

export interface MemoryObserver extends Observer {
  /** Events dropped due to the maxEvents cap. */
  readonly droppedCount: number;
  events(): readonly ObserveEvent[];
  eventsForRun(runId: string): readonly ObserveEvent[];
  /** Events of the most recently seen runId. */
  latestRun(): readonly ObserveEvent[] | undefined;
  clear(): void;
}

/** Approximate in-memory size of an event; measured only when `maxBytes` is set. */
function approxEventBytes(event: ObserveEvent): number {
  try {
    // Safe here: events already passed the runtime's cycle-free snapshot, and
    // this runs inside the observer — never on the core hot path.
    return JSON.stringify(event).length;
  } catch {
    return 1024; // pathological payload — charge a conservative flat size
  }
}

export function createMemoryObserver(options?: {
  /** Hard cap — memory never grows unbounded. Default 10_000. */
  maxEvents?: number;
  /**
   * Approximate total byte budget across the buffer (1.6.1 additive) —
   * bounds memory even when raw content capture is on. Unset = no byte cap.
   */
  maxBytes?: number;
  /** What to do at the caps. Default 'drop-oldest'. */
  overflow?: 'drop-oldest' | 'drop-newest';
  observation?: ObservationOptions;
}): MemoryObserver {
  const maxEvents = Math.max(1, options?.maxEvents ?? 10_000);
  const maxBytes = options?.maxBytes !== undefined ? Math.max(1, options.maxBytes) : undefined;
  const overflow = options?.overflow ?? 'drop-oldest';
  let buffer: ObserveEvent[] = [];
  let sizes: number[] = [];
  let totalBytes = 0;
  let dropped = 0;
  let lastRunId: string | undefined;

  const evictOldest = (): void => {
    buffer.shift();
    if (maxBytes !== undefined) totalBytes -= sizes.shift() ?? 0;
    dropped += 1;
  };

  return {
    options: options?.observation,
    get droppedCount() {
      return dropped;
    },
    emit(event) {
      lastRunId = event.runId;
      const size = maxBytes !== undefined ? approxEventBytes(event) : 0;
      const overCount = buffer.length >= maxEvents;
      const overBytes = maxBytes !== undefined && totalBytes + size > maxBytes;
      if ((overCount || overBytes) && overflow === 'drop-newest') {
        dropped += 1;
        return;
      }
      if (overCount) evictOldest();
      if (maxBytes !== undefined) {
        while (buffer.length > 0 && totalBytes + size > maxBytes) evictOldest();
      }
      buffer.push(event);
      if (maxBytes !== undefined) {
        sizes.push(size);
        totalBytes += size;
      }
    },
    events() {
      return buffer.slice();
    },
    eventsForRun(runId) {
      return buffer.filter((e) => e.runId === runId);
    },
    latestRun() {
      if (lastRunId === undefined) return undefined;
      return buffer.filter((e) => e.runId === lastRunId);
    },
    clear() {
      buffer = [];
      sizes = [];
      totalBytes = 0;
      dropped = 0;
      lastRunId = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Composite observer
// ---------------------------------------------------------------------------

function mergeCapture(
  a: ObservationCaptureOptions | undefined,
  b: ObservationCaptureOptions | undefined,
): ObservationCaptureOptions | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, boolean> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = (a as Record<string, boolean | undefined>)[key];
    const bv = (b as Record<string, boolean | undefined>)[key];
    out[key] = av === true || bv === true;
  }
  return out as ObservationCaptureOptions;
}

function mergeLimits(
  a: ObservationLimits | undefined,
  b: ObservationLimits | undefined,
): ObservationLimits | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, number> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = (a as Record<string, number | undefined>)[key];
    const bv = (b as Record<string, number | undefined>)[key];
    if (av !== undefined && bv !== undefined) out[key] = Math.min(av, bv);
    else if (av !== undefined) out[key] = av;
    else if (bv !== undefined) out[key] = bv;
  }
  return out as ObservationLimits;
}

/**
 * Per-sink privacy projection (1.6.1): the runtime produces ONE event at the
 * UNION of all children's capture flags, and each child then receives only
 * what ITS OWN capture opted into — captured payload fields the child did not
 * enable are stripped, `error.message` included. A child's custom `redact`
 * applies only to its own view (never to siblings'), and the default secret
 * redaction runs once more after it (the same final-barrier rule as the
 * runtime). Children without options behave like a standalone observer with
 * defaults: no captured content at all.
 */
function projectForChild(
  event: ObserveEvent,
  options: ObservationOptions | undefined,
): ObserveEvent {
  const capture = options?.capture;
  const redact = options?.redact;
  const source = event as unknown as Record<string, unknown>;
  let clone: Record<string, unknown> | undefined;
  const ensure = (): Record<string, unknown> => (clone ??= { ...source });

  for (const [key, meta] of Object.entries(CAPTURE_FIELDS)) {
    if (source[key] === undefined) continue;
    if (capture?.[meta.flag] !== true) {
      delete ensure()[key];
      continue;
    }
    if (redact) {
      let value: unknown;
      try {
        value = redact(source[key], { eventType: event.type, field: meta.field });
      } catch {
        value = '[RedactionError]';
      }
      ensure()[key] = redactForObservation(value);
    }
  }

  // error.message is captured content too — gate it per child.
  const error = source.error as ObservedError | undefined;
  if (error?.message !== undefined && capture?.errorMessages !== true) {
    const { message: _message, ...rest } = error;
    ensure().error = rest;
  }

  return (clone ?? event) as ObserveEvent;
}

/**
 * Fan one event stream out to many observers. Merge rules (resolved once):
 * enabled = any child enabled; sampleRate = max; capture = field-wise OR
 * (so the runtime produces the payloads at all); limits = field-wise min;
 * metadata = shallow merge (later wins). Each child then receives a PER-SINK
 * projection of the event: only the captured content its own options enabled,
 * with its own redactor applied to its own view — a capture-off sink composed
 * next to a capture-on one never sees raw content (1.6.1 privacy fix).
 * A throwing child never blocks its siblings.
 */
export function composeObservers(...observers: readonly Observer[]): Observer {
  const merged: ObservationOptions = {};
  let anyEnabled = observers.length === 0;
  let sampleRate: number | undefined;
  for (const obs of observers) {
    const o = obs.options ?? {};
    if (o.enabled !== false) anyEnabled = true;
    if (o.sampleRate !== undefined) {
      sampleRate = sampleRate === undefined ? o.sampleRate : Math.max(sampleRate, o.sampleRate);
    }
    if (o.sampleErrors !== undefined) merged.sampleErrors = merged.sampleErrors || o.sampleErrors;
    merged.capture = mergeCapture(merged.capture, o.capture);
    merged.limits = mergeLimits(merged.limits, o.limits);
    if (o.metadata) merged.metadata = { ...merged.metadata, ...o.metadata };
    // NOTE: child `redact`s are deliberately NOT merged into the runtime
    // options — each applies only inside its own projection below.
  }
  if (!anyEnabled) merged.enabled = false;
  if (sampleRate !== undefined) merged.sampleRate = sampleRate;

  return {
    options: merged,
    emit(event) {
      for (const obs of observers) {
        if (obs.options?.enabled === false) continue;
        try {
          obs.emit(projectForChild(event, obs.options));
        } catch {
          // one child's failure never blocks the others
        }
      }
    },
    flush() {
      const pending = observers
        .map((obs) => {
          try {
            return obs.flush?.();
          } catch {
            return undefined;
          }
        })
        .filter((p): p is Promise<void> => p instanceof Promise);
      if (pending.length > 0) {
        return Promise.allSettled(pending).then(() => undefined);
      }
    },
    close() {
      const pending = observers
        .map((obs) => {
          try {
            return obs.close?.();
          } catch {
            return undefined;
          }
        })
        .filter((p): p is Promise<void> => p instanceof Promise);
      if (pending.length > 0) {
        return Promise.allSettled(pending).then(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Filter observer
// ---------------------------------------------------------------------------

/** Forward only events matching `predicate`. A throwing predicate drops the event, not the run. */
export function filterObserver(
  observer: Observer,
  predicate: (event: ObserveEvent) => boolean,
): Observer {
  return {
    options: observer.options,
    emit(event) {
      let keep = false;
      try {
        keep = predicate(event);
      } catch {
        keep = false;
      }
      if (keep) observer.emit(event);
    },
    flush: observer.flush?.bind(observer),
    close: observer.close?.bind(observer),
  };
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

export interface RunSummary {
  runId: string;
  status: 'running' | 'completed' | 'suspended' | 'aborted' | 'failed';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  provider?: string;
  model?: string;
  executionCount: number;
  stepCount: number;
  modelCallCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  retryCount: number;
  approvalCount: number;
  checkpointCount: number;
  subAgentCount: number;
  usage: Usage;
  costUsd?: number;
  errors: readonly ObservedError[];
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(total: Usage, part: Usage): Usage {
  return {
    inputTokens: total.inputTokens + part.inputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    reasoningTokens: total.reasoningTokens + part.reasoningTokens,
    cachedReadTokens: total.cachedReadTokens + part.cachedReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + part.cacheWriteTokens,
    cacheWrite1hTokens: total.cacheWrite1hTokens + part.cacheWrite1hTokens,
    ...(total.audioTokens !== undefined || part.audioTokens !== undefined
      ? { audioTokens: (total.audioTokens ?? 0) + (part.audioTokens ?? 0) }
      : {}),
    ...(total.serverToolUses !== undefined || part.serverToolUses !== undefined
      ? { serverToolUses: (total.serverToolUses ?? 0) + (part.serverToolUses ?? 0) }
      : {}),
    totalTokens: total.totalTokens + part.totalTokens,
  };
}

/**
 * Pure, deterministic aggregation of one run's events into a summary. Sorts
 * by (execution leg, sequence) when the input arrived out of order; merges
 * multiple execution legs; tolerates `cost.calculated` after the terminal
 * event; returns status 'running' when no terminal event has arrived.
 * Sub-agent usage is NOT added again — it is already folded into the parent
 * leg's terminal usage.
 */
export function summarizeRun(events: readonly ObserveEvent[]): RunSummary {
  if (events.length === 0) {
    return {
      runId: '',
      status: 'running',
      startedAt: 0,
      executionCount: 0,
      stepCount: 0,
      modelCallCount: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
      retryCount: 0,
      approvalCount: 0,
      checkpointCount: 0,
      subAgentCount: 0,
      usage: emptyUsage(),
      errors: [],
    };
  }

  // Order legs by first-seen timestamp, events within a leg by sequence.
  const legs = new Map<string, ObserveEvent[]>();
  for (const event of events) {
    const leg = legs.get(event.executionId);
    if (leg) leg.push(event);
    else legs.set(event.executionId, [event]);
  }
  const orderedLegs = [...legs.values()]
    .map((leg) => leg.slice().sort((a, b) => a.sequence - b.sequence))
    .sort((a, b) => (a[0]?.timestamp ?? 0) - (b[0]?.timestamp ?? 0));
  const ordered = orderedLegs.flat();

  const first = ordered[0]!;
  let status: RunSummary['status'] = 'running';
  let finishedAt: number | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let usage = emptyUsage();
  let costUsd: number | undefined;
  const errors: ObservedError[] = [];
  const counts = {
    stepCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    retryCount: 0,
    approvalCount: 0,
    checkpointCount: 0,
    subAgentCount: 0,
  };

  for (const event of ordered) {
    switch (event.type) {
      case 'run.started':
        provider ??= event.provider;
        model ??= event.model;
        break;
      case 'step.completed':
        counts.stepCount += 1;
        break;
      case 'model.started':
        counts.modelCallCount += 1;
        break;
      case 'tool.started':
        counts.toolCallCount += 1;
        break;
      case 'tool.failed':
        counts.toolErrorCount += 1;
        errors.push(event.error);
        break;
      case 'model.retry':
        counts.retryCount += 1;
        break;
      case 'approval.requested':
        counts.approvalCount += 1;
        break;
      case 'checkpoint.saved':
        counts.checkpointCount += 1;
        break;
      case 'subagent.started':
        counts.subAgentCount += 1;
        break;
      case 'run.completed':
        status = 'completed';
        finishedAt = event.timestamp;
        usage = addUsage(usage, event.usage);
        if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
        break;
      case 'run.suspended':
        status = 'suspended';
        finishedAt = event.timestamp;
        usage = addUsage(usage, event.usage);
        break;
      case 'run.aborted':
        status = 'aborted';
        finishedAt = event.timestamp;
        usage = addUsage(usage, event.usage);
        break;
      case 'run.failed':
        status = 'failed';
        finishedAt = event.timestamp;
        if (event.partialUsage) usage = addUsage(usage, event.partialUsage);
        errors.push(event.error);
        break;
      case 'model.failed':
      case 'checkpoint.failed':
      case 'subagent.failed':
      case 'operation.failed':
        errors.push(event.error);
        break;
      case 'cost.calculated':
        if (event.target === 'run') costUsd = (costUsd ?? 0) + event.costUsd;
        break;
      default:
        break;
    }
  }

  return {
    runId: first.runId,
    status,
    startedAt: first.timestamp,
    ...(finishedAt !== undefined
      ? { finishedAt, durationMs: Math.max(0, finishedAt - first.timestamp) }
      : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    executionCount: legs.size,
    ...counts,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    errors,
  };
}
