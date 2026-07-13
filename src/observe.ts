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
  ObservationRedactor,
  ObservedError,
} from './types/observe';
import type { Usage } from './types/usage';

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

export function createMemoryObserver(options?: {
  /** Hard cap — memory never grows unbounded. Default 10_000. */
  maxEvents?: number;
  /** What to do at the cap. Default 'drop-oldest'. */
  overflow?: 'drop-oldest' | 'drop-newest';
  observation?: ObservationOptions;
}): MemoryObserver {
  const maxEvents = Math.max(1, options?.maxEvents ?? 10_000);
  const overflow = options?.overflow ?? 'drop-oldest';
  let buffer: ObserveEvent[] = [];
  let dropped = 0;
  let lastRunId: string | undefined;

  return {
    options: options?.observation,
    get droppedCount() {
      return dropped;
    },
    emit(event) {
      lastRunId = event.runId;
      if (buffer.length >= maxEvents) {
        dropped += 1;
        if (overflow === 'drop-newest') return;
        buffer.shift();
      }
      buffer.push(event);
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

function chainRedactors(
  a: ObservationRedactor | undefined,
  b: ObservationRedactor | undefined,
): ObservationRedactor | undefined {
  if (!a) return b;
  if (!b) return a;
  return (value, context) => {
    let out = value;
    try {
      out = a(out, context);
    } catch {
      // a failing link keeps the previous value; the chain continues
    }
    try {
      out = b(out, context);
    } catch {
      // ditto
    }
    return out;
  };
}

/**
 * Fan one event stream out to many observers. Merge rules (resolved once):
 * enabled = any child enabled; sampleRate = max; capture = field-wise OR;
 * limits = field-wise min; metadata = shallow merge (later wins); redact =
 * chain in order. The composite produces ONE event set at the most permissive
 * capture — restrictive children should wrap themselves with `filterObserver`
 * or their own redaction. A throwing child never blocks its siblings.
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
    merged.redact = chainRedactors(merged.redact, o.redact);
  }
  if (!anyEnabled) merged.enabled = false;
  if (sampleRate !== undefined) merged.sampleRate = sampleRate;

  return {
    options: merged,
    emit(event) {
      for (const obs of observers) {
        if (obs.options?.enabled === false) continue;
        try {
          obs.emit(event);
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
