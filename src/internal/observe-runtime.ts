/**
 * Observation runtime (1.6). Owns everything between an instrumentation site
 * and the user's Observer: id/sequence/timestamp stamping, deterministic
 * sampling, capture gating, default + custom redaction, structural limits,
 * the single-terminal-event guard, run counters, and crash isolation (an
 * observer can never affect the run — G2 applies).
 *
 * Fast path: `createObservationRuntime` returns `undefined` when no observer
 * is enabled — callers guard with one branch (`rt?.emit(...)`) and build no
 * event objects, draw no ids, and count nothing.
 *
 * Edge-safe by construction: time via deps.clock.now(), ids via
 * deps.generateId(), sampling via unitFromId(runId) — no ambient calls.
 */
import type { ResolvedDependencies, PriceProvider } from '../types/deps';
import type { Usage } from '../types/usage';
import type {
  ObserveEvent,
  Observer,
  ObservationOptions,
  ObservationCaptureOptions,
  ObservationLimits,
  ObserveAttributes,
  ObserveAttributeValue,
  ObservePrimitive,
  ObservedSubsystem,
  RunFailedEvent,
} from '../types/observe';
import { toObservedError } from './observe-error';
import { unitFromId } from '../core/resilience';
import { redactForObservation, redactObservationString } from './redact';
import { noopTracer } from './resolve-deps';
import { createTracerBridge } from './tracer-bridge';

/** Distributes Omit over the event union so payload types stay discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What instrumentation sites pass to emit(); the runtime stamps the rest. */
export type PendingObserveEvent = DistributiveOmit<
  ObserveEvent,
  'schemaVersion' | 'eventId' | 'sequence' | 'timestamp' | 'runId' | 'executionId' | 'metadata'
>;

export interface RunCounters {
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  denials: number;
  retries: number;
  approvals: number;
  checkpoints: number;
  subAgents: number;
}

export interface ObservationRuntime {
  readonly sampled: boolean;
  readonly runId: string;
  readonly executionId: string;
  /** Resolved capture flags — sites skip building `captured*` payloads when off. */
  readonly capture: Required<ObservationCaptureOptions>;
  /** Live counters, auto-incremented from emitted event types. */
  readonly counters: RunCounters;
  now(): number;
  durationSince(startedAt: number): number;
  /** New timeline node id (deps.generateId()). */
  startSpan(): { spanId: string; startedAt: number };
  emit(event: PendingObserveEvent): void;
  /**
   * Register an async enrichment (e.g. a pending priceProvider cost) so
   * `settled()` can await it. The promise's failure is swallowed here — the
   * enrichment site owns its own error handling.
   */
  trackPending(promise: Promise<unknown>): void;
  /** Resolves once every registered enrichment has settled (1.6.1). */
  settled(): Promise<void>;
}

export interface ObservationRuntimeInit {
  /** Adopt an existing id (durable session runId); else generated. */
  runId?: string;
  /** Extra sinks alongside deps.observer (e.g. the tracer bridge). */
  extraSinks?: Observer[];
}

const TERMINAL_TYPES = new Set<ObserveEvent['type']>([
  'run.completed',
  'run.suspended',
  'run.aborted',
  'run.failed',
]);

const DEFAULT_LIMITS: Required<ObservationLimits> = {
  maxStringLength: 4096,
  maxArrayLength: 100,
  maxObjectDepth: 6,
  maxObjectKeys: 100,
  maxEventBytes: 65536,
};

const DEFAULT_CAPTURE: Required<ObservationCaptureOptions> = {
  messages: false,
  outputText: false,
  reasoning: false,
  toolInputs: false,
  toolOutputs: false,
  errorMessages: false,
  providerMetadata: false,
};

/**
 * Captured-payload keys → the redactor `field` name + the capture flag that
 * gates them. Single source of truth shared with `composeObservers`' per-sink
 * projection (src/observe.ts) — never duplicate this table.
 */
export const CAPTURE_FIELDS: Record<
  string,
  {
    field: Parameters<NonNullable<ObservationOptions['redact']>>[1]['field'];
    flag: keyof ObservationCaptureOptions;
  }
> = {
  capturedMessages: { field: 'messages', flag: 'messages' },
  capturedInput: { field: 'tool-input', flag: 'toolInputs' },
  capturedOutput: { field: 'tool-output', flag: 'toolOutputs' },
  capturedOutputText: { field: 'output', flag: 'outputText' },
  capturedReasoning: { field: 'reasoning', flag: 'reasoning' },
  capturedProviderMetadata: { field: 'provider-metadata', flag: 'providerMetadata' },
};

const TRUNCATED = '[Truncated]';
const UNSERIALIZABLE = '[Unserializable]';

function clampRate(rate: number | undefined): number {
  if (rate === undefined || Number.isNaN(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

interface SnapshotState {
  limits: Required<ObservationLimits>;
  truncated: boolean;
  seen: WeakSet<object>;
}

/** Structural snapshot: JSON-safe copy under limits. Never throws, never stringifies. */
function snapshot(value: unknown, state: SnapshotState, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    if (s.length > state.limits.maxStringLength) {
      state.truncated = true;
      return s.slice(0, state.limits.maxStringLength) + TRUNCATED;
    }
    return s;
  }
  if (t === 'number') return Number.isFinite(value as number) ? value : UNSERIALIZABLE;
  if (t === 'boolean') return value;
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    state.truncated = true;
    return UNSERIALIZABLE;
  }
  // objects / arrays
  if (depth >= state.limits.maxObjectDepth) {
    state.truncated = true;
    return TRUNCATED;
  }
  const obj = value as object;
  if (state.seen.has(obj)) {
    state.truncated = true;
    return UNSERIALIZABLE;
  }
  state.seen.add(obj);
  if (Array.isArray(obj)) {
    const overCap = obj.length > state.limits.maxArrayLength;
    const slice = overCap ? obj.slice(0, state.limits.maxArrayLength) : obj;
    const out = slice.map((v) => snapshot(v, state, depth + 1));
    if (overCap) {
      state.truncated = true;
      out.push(TRUNCATED);
    }
    return out;
  }
  if (obj instanceof Uint8Array) {
    // Binary parts never enter default events; with capture on, report shape only.
    return `[Uint8Array ${obj.byteLength}B]`;
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of entries) {
    if (keys >= state.limits.maxObjectKeys) {
      state.truncated = true;
      out[TRUNCATED] = true;
      break;
    }
    out[k] = snapshot(v, state, depth + 1);
    keys += 1;
  }
  return out;
}

/** Metadata is validated once at runtime creation — flat primitives only. */
function sanitizeMetadata(
  metadata: ObserveAttributes | undefined,
  limits: Required<ObservationLimits>,
): ObserveAttributes | undefined {
  if (!metadata) return undefined;
  const out: Record<string, ObserveAttributeValue> = {};
  for (const [k, v] of Object.entries(metadata)) {
    const t = typeof v;
    if (v === null || t === 'string' || t === 'number' || t === 'boolean') {
      out[k] =
        t === 'string' && (v as string).length > limits.maxStringLength
          ? (v as string).slice(0, limits.maxStringLength) + TRUNCATED
          : (v as ObserveAttributeValue);
    } else if (Array.isArray(v)) {
      out[k] = v
        .slice(0, limits.maxArrayLength)
        .map(
          (item): ObservePrimitive =>
            item === null || ['string', 'number', 'boolean'].includes(typeof item)
              ? (item as ObservePrimitive)
              : UNSERIALIZABLE,
        );
    } else {
      out[k] = UNSERIALIZABLE;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strip an unsampled run failure to identity + error category/code/status (§19). */
function toMinimalRunFailed(event: RunFailedEvent): RunFailedEvent {
  const { metadata: _metadata, partialUsage: _partialUsage, ...rest } = event;
  return {
    ...rest,
    error: {
      name: event.error.name,
      category: event.error.category,
      ...(event.error.code !== undefined ? { code: event.error.code } : {}),
      ...(event.error.statusCode !== undefined ? { statusCode: event.error.statusCode } : {}),
    },
    stepCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    retryCount: 0,
  };
}

// --- Sub-agent inheritance (1.6): the parent loop attaches its runtime to the
// per-call ctx.deps clone via a NON-ENUMERABLE symbol; agentTool reads it and
// threads it into the child loop so child events share the parent's
// runId/executionId/sequence. Spreads drop it by design — it never leaks.
const INHERITED_OBSERVE = Symbol('deuz.observe.inherited');

export interface InheritedObserveContext {
  runtime: ObservationRuntime;
  /** The parent tool call's span — subagent.started parents under it. */
  parentSpanId?: string;
}

export function attachInheritedObserve<T extends object>(
  target: T,
  ctx: InheritedObserveContext,
): T {
  Object.defineProperty(target, INHERITED_OBSERVE, { value: ctx, enumerable: false });
  return target;
}

export function readInheritedObserve(
  target: object | undefined,
): InheritedObserveContext | undefined {
  if (!target) return undefined;
  return (target as Record<symbol, InheritedObserveContext | undefined>)[INHERITED_OBSERVE];
}

/** rt.counters → the run.completed counter field names (shared by every terminal emitter). */
export function counterFields(rt: ObservationRuntime): {
  modelCallCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  deniedToolCount: number;
  retryCount: number;
  approvalCount: number;
  checkpointCount: number;
  subAgentCount: number;
} {
  const c = rt.counters;
  return {
    modelCallCount: c.modelCalls,
    toolCallCount: c.toolCalls,
    toolErrorCount: c.toolErrors,
    deniedToolCount: c.denials,
    retryCount: c.retries,
    approvalCount: c.approvals,
    checkpointCount: c.checkpoints,
    subAgentCount: c.subAgents,
  };
}

/**
 * Wrap an auxiliary subsystem call in operation.started/completed/failed
 * events (image, midjourney, …). Fast path: without an observer the function
 * runs bare — no runtime, no ids, no events.
 */
export async function observeOperation<T>(
  deps: ResolvedDependencies,
  subsystem: ObservedSubsystem,
  operation: string,
  info: { itemCount?: number; resultCount?: (result: T) => number | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  const rt = createObservationRuntime(deps);
  if (!rt) return fn();
  const span = rt.startSpan();
  rt.emit({
    type: 'operation.started',
    spanId: span.spanId,
    subsystem,
    operation,
    ...(info.itemCount !== undefined ? { itemCount: info.itemCount } : {}),
  });
  try {
    const result = await fn();
    const resultCount = info.resultCount?.(result);
    rt.emit({
      type: 'operation.completed',
      spanId: span.spanId,
      subsystem,
      operation,
      durationMs: rt.durationSince(span.startedAt),
      ...(info.itemCount !== undefined ? { itemCount: info.itemCount } : {}),
      ...(resultCount !== undefined ? { resultCount } : {}),
    });
    return result;
  } catch (err) {
    rt.emit({
      type: 'operation.failed',
      spanId: span.spanId,
      subsystem,
      operation,
      durationMs: rt.durationSince(span.startedAt),
      error: toObservedError(err, rt.capture.errorMessages),
    });
    throw err;
  }
}

/**
 * Cost enrichment (§25): a sync priceProvider result is returned so callers
 * can inline `costUsd` into the terminal event; an async one resolves into a
 * fire-and-forget `cost.calculated` event (tolerated after the terminal).
 * Provider throws/rejections never affect the run — cost simply stays
 * undefined.
 */
export function observeCost(
  rt: ObservationRuntime,
  priceProvider: PriceProvider | undefined,
  target: 'model' | 'run',
  provider: string,
  model: string,
  usage: Usage,
  spanId: string,
): number | undefined {
  if (!priceProvider) return undefined;
  try {
    const result = priceProvider.priceUsage(model, usage);
    if (typeof result === 'number') return result;
    if (result && typeof (result as Promise<number | undefined>).then === 'function') {
      // Tracked (1.6.1): `result.observation.settled` awaits this, so a user
      // can drain the cost event before closing a JSONL observer.
      rt.trackPending(
        (result as Promise<number | undefined>).then(
          (costUsd) => {
            if (typeof costUsd === 'number') {
              rt.emit({ type: 'cost.calculated', spanId, target, provider, model, usage, costUsd });
            }
          },
          () => undefined,
        ),
      );
    }
  } catch {
    // price provider failures never affect the run
  }
  return undefined;
}

/**
 * Returns `undefined` when observation is fully off (no observer / disabled) —
 * the fast path. Draws ids only when enabled.
 */
export function createObservationRuntime(
  deps: ResolvedDependencies,
  init: ObservationRuntimeInit = {},
): ObservationRuntime | undefined {
  const sinks: Observer[] = [];
  const observerEnabled = deps.observer !== undefined && deps.observer.options?.enabled !== false;
  if (observerEnabled) sinks.push(deps.observer!);
  // Legacy tracer bridge (1.6): a REAL injected tracer receives the
  // invoke→step→execute_tool hierarchy driven by these events — the single
  // span source. Independent of the observer (either alone activates).
  if (deps.tracer !== undefined && deps.tracer !== noopTracer) {
    sinks.push(createTracerBridge(deps.tracer, deps.tracerMode ?? 'hierarchical'));
  }
  if (init.extraSinks) sinks.push(...init.extraSinks);
  if (sinks.length === 0) return undefined;

  const options: ObservationOptions = observerEnabled ? (deps.observer?.options ?? {}) : {};

  const limits: Required<ObservationLimits> = { ...DEFAULT_LIMITS, ...options.limits };
  const capture: Required<ObservationCaptureOptions> = { ...DEFAULT_CAPTURE, ...options.capture };
  const metadata = sanitizeMetadata(options.metadata, limits);

  const runId = init.runId ?? deps.generateId();
  const executionId = deps.generateId();
  const sampled = unitFromId(runId) < clampRate(options.sampleRate);
  const sampleErrors = options.sampleErrors !== false;

  let sequence = 0;
  let terminalSeen = false;
  const pendingEnrichments = new Set<Promise<unknown>>();
  const counters: RunCounters = {
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    denials: 0,
    retries: 0,
    approvals: 0,
    checkpoints: 0,
    subAgents: 0,
  };

  const count = (type: ObserveEvent['type']): void => {
    if (type === 'model.started') counters.modelCalls += 1;
    else if (type === 'tool.started') counters.toolCalls += 1;
    else if (type === 'tool.failed') counters.toolErrors += 1;
    else if (type === 'tool.denied') counters.denials += 1;
    else if (type === 'model.retry') counters.retries += 1;
    else if (type === 'approval.requested') counters.approvals += 1;
    else if (type === 'checkpoint.saved') counters.checkpoints += 1;
    else if (type === 'subagent.started') counters.subAgents += 1;
  };

  const finalize = (pending: PendingObserveEvent): ObserveEvent => {
    const state: SnapshotState = { limits, truncated: false, seen: new WeakSet() };
    const event = pending as unknown as Record<string, unknown>;
    // Captured payloads: default secret redaction FIRST (so truncation can
    // never split a secret into a surviving decodable prefix) → bounded
    // snapshot → custom redactor → default secret redaction AGAIN as the
    // FINAL BARRIER (a buggy or malicious custom redactor that reintroduces a
    // secret still hits the sweep) → re-bound (custom output may exceed
    // limits; the extra passes run only when a redactor is configured).
    for (const [key, { field }] of Object.entries(CAPTURE_FIELDS)) {
      if (event[key] === undefined) continue;
      let value = snapshot(redactForObservation(event[key]), state, 0);
      if (options.redact) {
        try {
          value = options.redact(value, { eventType: pending.type, field });
        } catch {
          value = '[RedactionError]';
        }
        value = snapshot(redactForObservation(value), state, 0);
      }
      event[key] = value;
    }
    if (typeof event.reason === 'string') {
      event.reason = redactObservationString(event.reason as string);
    }
    const full = {
      schemaVersion: 1,
      eventId: deps.generateId(),
      sequence: sequence++,
      timestamp: deps.clock.now(),
      runId,
      executionId,
      ...(metadata ? { metadata } : {}),
      ...(pending as object),
      ...(state.truncated ? { truncated: true } : {}),
    } as ObserveEvent;
    return full;
  };

  const dispatch = (event: ObserveEvent): void => {
    for (const sink of sinks) {
      try {
        sink.emit(event);
      } catch (err) {
        // Observer failures can never affect the run (G2).
        try {
          deps.logger.debug('observe: observer emit threw', {
            type: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // even the logger must not break the run
        }
      }
    }
  };

  return {
    sampled,
    runId,
    executionId,
    capture,
    counters,
    now: () => deps.clock.now(),
    durationSince: (startedAt: number) => Math.max(0, deps.clock.now() - startedAt),
    startSpan: () => ({ spanId: deps.generateId(), startedAt: deps.clock.now() }),
    trackPending(promise: Promise<unknown>): void {
      pendingEnrichments.add(promise);
      void promise
        .catch(() => undefined)
        .finally(() => {
          pendingEnrichments.delete(promise);
        });
    },
    async settled(): Promise<void> {
      // Loop: an awaited enrichment may register a follow-up.
      while (pendingEnrichments.size > 0) {
        await Promise.allSettled([...pendingEnrichments]);
      }
    },
    emit(pending: PendingObserveEvent): void {
      const isTerminal = TERMINAL_TYPES.has(pending.type);
      if (isTerminal) {
        if (terminalSeen) {
          deps.logger.warn('observe: duplicate terminal event dropped', { type: pending.type });
          return;
        }
        terminalSeen = true;
      }
      if (!sampled) {
        if (pending.type === 'run.failed' && sampleErrors) {
          dispatch(toMinimalRunFailed(finalize(pending) as RunFailedEvent));
        }
        return;
      }
      count(pending.type);
      dispatch(finalize(pending));
    },
  };
}
