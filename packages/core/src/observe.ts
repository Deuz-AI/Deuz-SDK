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
import { redactForObservation, redactObservationString } from './internal/redact';

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
 * Canonical replay order: execution legs by first-seen timestamp, events
 * within a leg by `sequence`. Shared by everything that reconstructs a run
 * from its events (the summary and the HTML report) so both agree.
 */
function orderByExecution(events: readonly ObserveEvent[]): {
  ordered: ObserveEvent[];
  /** executionId → 0-based leg position (the "leg 2/3" badge in the report). */
  legIndex: Map<string, number>;
} {
  const legs = new Map<string, ObserveEvent[]>();
  for (const event of events) {
    const leg = legs.get(event.executionId);
    if (leg) leg.push(event);
    else legs.set(event.executionId, [event]);
  }
  const orderedLegs = [...legs.entries()]
    .map(([id, leg]) => [id, leg.slice().sort((a, b) => a.sequence - b.sequence)] as const)
    .sort((a, b) => (a[1][0]?.timestamp ?? 0) - (b[1][0]?.timestamp ?? 0));
  const legIndex = new Map<string, number>();
  const ordered: ObserveEvent[] = [];
  for (const [id, leg] of orderedLegs) {
    legIndex.set(id, legIndex.size);
    for (const event of leg) ordered.push(event);
  }
  return { ordered, legIndex };
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

  const { ordered, legIndex } = orderByExecution(events);
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
    executionCount: legIndex.size,
    ...counts,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Run report (1.9) — events in, ONE self-contained HTML document out
//
// A pure string builder: no DOM, no clock (every timestamp comes off the
// events), no randomness (element ids derive from eventIds), no console — so
// it stays edge-safe and its output is byte-identical for identical input.
// The document inlines its own CSS + JS and fetches nothing, so it opens from
// a file:// URL offline.
//
// Everything rendered is attacker-influenced (model output, tool arguments,
// hallucinated tool names). Two rules hold without exception:
//   1. every data-derived string passes `escapeHtml` (text AND attributes) or
//      `jsonForScript` (inline <script>) — a tool result can never become
//      markup or script;
//   2. every value first passes `redactForObservation` / `redactObservationString`
//      (P0) — the report is a sink like any other and never renders a raw
//      header value.
// ---------------------------------------------------------------------------

/** `renderRunReport` options. */
export interface RunReportOptions {
  /** Document `<title>` and page heading. Default 'Deuz run report'. */
  title?: string;
  /** Render only this run; default = the first `runId` in `events`. */
  runId?: string;
  /** Colour scheme. Default 'auto' (follows `prefers-color-scheme`). */
  theme?: 'auto' | 'light' | 'dark';
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML text AND attribute escape — quotes included, so one helper covers both. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

const JS_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  // U+2028/U+2029 terminate a line for a JS parser but not for JSON.
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * JSON destined for an inline `<script>`. JSON.stringify already neutralizes
 * quotes, backslashes and control chars; escaping `< > &` as `\uXXXX` means the
 * emitted bytes can never close the tag or open an HTML comment — whatever a
 * tool name or model output carries. Never throws (cycles → 'null').
 */
function jsonForScript(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    json = 'null';
  }
  return json.replace(/[<>&\u2028\u2029]/g, (c) => JS_ESCAPES[c]!);
}

/** P0: a data-derived string is redacted before it is escaped into the page. */
function safeText(value: string): string {
  return escapeHtml(redactObservationString(value));
}

/**
 * Scalar event field → display string. Routing through `redactForObservation`
 * WITH the field's own key means a secret-NAMED field ('authorization',
 * 'token', 'cookie', …) collapses to '[REDACTED]' exactly as a sink would see
 * it, on top of the pattern sweep.
 */
function safeScalar(key: string, value: unknown): string {
  const redacted = redactForObservation({ [key]: value }) as Record<string, unknown>;
  const out = redacted[key];
  return escapeHtml(typeof out === 'string' ? out : String(out));
}

const REPORT_MAX_DEPTH = 6;
const REPORT_MAX_ARRAY = 50;
const REPORT_MAX_KEYS = 60;
const REPORT_MAX_JSON_CHARS = 8000;
/** Rendered-event ceiling; the SUMMARY always counts every event. */
const REPORT_MAX_EVENTS = 5000;
/** Guard against a pathological parentSpanId chain blowing the render stack. */
const REPORT_MAX_TREE_DEPTH = 64;

/**
 * Structural pass only: cycles, depth, array/key caps and the leaves JSON
 * cannot carry. Strings are left INTACT so redaction later runs on whole
 * values — truncating first could split a secret into a surviving decodable
 * prefix (the ordering rule observe-runtime's finalize() follows).
 */
function prepareForDisplay(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : '[Unserializable]';
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      return '[Unserializable]';
    }
    return value;
  }
  if (seen.has(value)) return '[Unserializable]';
  if (depth >= REPORT_MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (value instanceof Uint8Array) return `[Uint8Array ${value.byteLength}B]`;
  if (Array.isArray(value)) {
    const slice = value.slice(0, REPORT_MAX_ARRAY);
    const out = slice.map((item) => prepareForDisplay(item, depth + 1, seen));
    if (value.length > slice.length) out.push('[Truncated]');
    return out;
  }
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys >= REPORT_MAX_KEYS) {
      out['[Truncated]'] = true;
      break;
    }
    out[k] = prepareForDisplay(v, depth + 1, seen);
    keys += 1;
  }
  return out;
}

/**
 * Long free text (a captured output/reasoning payload, an error message):
 * redact, THEN bound — cutting after redaction can never leave a decodable
 * secret prefix behind — then escape.
 */
function safeLongText(value: string): string {
  const safe = redactObservationString(value);
  return escapeHtml(
    safe.length > REPORT_MAX_JSON_CHARS
      ? `${safe.slice(0, REPORT_MAX_JSON_CHARS)}\n… [Truncated]`
      : safe,
  );
}

/** Bounded, redacted, pretty JSON for a `<pre>` block. Never throws. */
function safeJsonBlock(value: unknown): string {
  const safe = redactForObservation(prepareForDisplay(value, 0, new WeakSet()));
  let json: string;
  try {
    json = JSON.stringify(safe, null, 2) ?? String(safe);
  } catch {
    return '[Unserializable]';
  }
  // Cutting AFTER redaction can never leave a decodable secret prefix behind.
  return json.length > REPORT_MAX_JSON_CHARS
    ? `${json.slice(0, REPORT_MAX_JSON_CHARS)}\n… [Truncated]`
    : json;
}

function fmtInt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtMs(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds < 10 ? '0' : ''}${seconds}s`;
}

/** Epoch → ISO. A pure conversion of an event-supplied number, never a clock read. */
function fmtTime(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  try {
    return new Date(value).toISOString();
  } catch {
    // out-of-range epochs make Date#toISOString throw — the report must not
    return String(value);
  }
}

function fmtUsd(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

/** Element ids derive from eventIds (never randomness); the index keeps them unique. */
function domId(index: number, eventId: unknown): string {
  const seed = typeof eventId === 'string' ? eventId : '';
  return `dz${index}-${seed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;
}

/**
 * Event family, derived from the type PREFIX so a future member of the
 * protocol lands in the right lane without a code change here.
 */
function eventKind(type: string): string {
  const dot = type.indexOf('.');
  const head = dot === -1 ? type : type.slice(0, dot);
  switch (head) {
    case 'run':
    case 'step':
    case 'model':
    case 'tool':
    case 'approval':
    case 'checkpoint':
    case 'compaction':
    case 'subagent':
    case 'operation':
    case 'cost':
      return head;
    default:
      return 'other';
  }
}

const KIND_TITLES: Record<string, string> = {
  run: 'Run',
  step: 'Step',
  model: 'Model',
  tool: 'Tool',
  approval: 'Approval',
  checkpoint: 'Checkpoint',
  compaction: 'Compaction',
  subagent: 'Sub-agent',
  operation: 'Operation',
  cost: 'Cost',
  other: 'Event',
};

/** Base identity keys — rendered in the node header, not as per-event chips. */
const BASE_EVENT_KEYS = new Set([
  'schemaVersion',
  'eventId',
  'sequence',
  'timestamp',
  'runId',
  'executionId',
  'spanId',
  'parentSpanId',
  'agentPath',
  'stepIndex',
  'type',
  'truncated',
  'error',
]);

const USAGE_KEYS = new Set(['usage', 'cumulativeUsage', 'partialUsage', 'durableUsage']);

/** The opt-in content payloads — same table the runtime and composeObservers use. */
const CAPTURED_KEYS = new Set(Object.keys(CAPTURE_FIELDS));

/** The name that identifies a span, whatever family it belongs to. */
function spanName(event: ObserveEvent): string | undefined {
  const bag = event as unknown as Record<string, unknown>;
  for (const key of ['toolName', 'agentName', 'operation', 'layer', 'model', 'stepId']) {
    const value = bag[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

interface ReportNode {
  spanId: string;
  id: string;
  parentSpanId?: string;
  events: ObserveEvent[];
  children: ReportNode[];
  legIndex: number;
  firstSequence: number;
  agentPath?: readonly string[];
}

/** Walk `parent`'s parentSpanId chain (bounded) to reject a cyclic attachment. */
function wouldCycle(
  node: ReportNode,
  parent: ReportNode,
  byId: Map<string, ReportNode>,
  max: number,
): boolean {
  let current: ReportNode | undefined = parent;
  for (let i = 0; current !== undefined && i <= max; i += 1) {
    if (current === node) return true;
    current = current.parentSpanId !== undefined ? byId.get(current.parentSpanId) : undefined;
  }
  return false;
}

const byReplayOrder = (a: ReportNode, b: ReportNode): number =>
  a.legIndex - b.legIndex || a.firstSequence - b.firstSequence;

/** Compact `in 10 · out 20 · total 30` line — zero fields are omitted. */
function usageLine(usage: unknown): string | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const bag = usage as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, label] of [
    ['inputTokens', 'in'],
    ['outputTokens', 'out'],
    ['reasoningTokens', 'reasoning'],
    ['cachedReadTokens', 'cache read'],
    ['cacheWriteTokens', 'cache write'],
    ['cacheWrite1hTokens', 'cache write 1h'],
    ['audioTokens', 'audio'],
    ['serverToolUses', 'server tools'],
    ['totalTokens', 'total'],
  ] as const) {
    const value = bag[key];
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
      parts.push(`${label} ${fmtInt(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** One `<div class="ev">` per event: chips for scalars, `<pre>` for payloads. */
function renderEvent(event: ObserveEvent, t0: number): string {
  const bag = event as unknown as Record<string, unknown>;
  const kind = eventKind(String(bag.type ?? 'other'));
  const chips: string[] = [];
  const blocks: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(bag)) {
    if (BASE_EVENT_KEYS.has(key) || value === undefined) continue;
    if (USAGE_KEYS.has(key)) continue;
    // Captured payloads always get their own block — `capturedOutputText` and
    // `capturedReasoning` are strings, and those are the two a debugger reads.
    if (value !== null && (typeof value === 'object' || CAPTURED_KEYS.has(key))) {
      blocks.push([key, value]);
    } else {
      chips.push(`<span class="chip">${escapeHtml(key)} ${safeScalar(key, value)}</span>`);
    }
  }

  const usageParts: string[] = [];
  for (const key of USAGE_KEYS) {
    const line = usageLine(bag[key]);
    if (line !== undefined) usageParts.push(`<div class="usage">${escapeHtml(key)}: ${line}</div>`);
  }

  const error = bag.error;
  let errorHtml = '';
  if (error !== null && typeof error === 'object') {
    const safe = redactForObservation(error) as Record<string, unknown>;
    const bits: string[] = [];
    for (const key of ['name', 'category', 'code', 'statusCode', 'retryable', 'provider']) {
      if (safe[key] !== undefined) bits.push(`${key} ${escapeHtml(String(safe[key]))}`);
    }
    const message = typeof safe.message === 'string' ? safe.message : undefined;
    errorHtml =
      `<div class="err"><b>error</b> ${bits.join(' · ')}` +
      (message !== undefined ? `<div class="errmsg">${safeLongText(message)}</div>` : '') +
      `</div>`;
  }

  const relative =
    typeof bag.timestamp === 'number' && Number.isFinite(bag.timestamp)
      ? `+${fmtMs(Math.max(0, bag.timestamp - t0))}`
      : '—';

  return (
    `<div class="ev k-${kind}">` +
    `<div class="evh">` +
    `<span class="seq">#${escapeHtml(String(bag.sequence ?? '?'))}</span>` +
    `<span class="etype">${safeText(String(bag.type ?? 'unknown'))}</span>` +
    `<span class="rel" title="${escapeHtml(fmtTime(bag.timestamp))}">${escapeHtml(relative)}</span>` +
    (bag.truncated === true ? `<span class="chip warn">truncated</span>` : '') +
    chips.join('') +
    `</div>` +
    usageParts.join('') +
    errorHtml +
    blocks
      .map(
        ([key, value]) =>
          `<details class="pay"><summary>${escapeHtml(key)}</summary>` +
          `<pre>${
            typeof value === 'string' ? safeLongText(value) : escapeHtml(safeJsonBlock(value))
          }</pre></details>`,
      )
      .join('') +
    `</div>`
  );
}

/** Per-node data the inline viewer needs (labels are attacker text — see jsonForScript). */
interface ReportNodeIndex {
  id: string;
  p?: string;
  kind: string;
  label: string;
  ms?: number;
}

interface RenderedTree {
  html: string;
  index: ReportNodeIndex[];
  kindCounts: Map<string, number>;
}

function renderNodes(roots: readonly ReportNode[], t0: number, legCount: number): RenderedTree {
  const index: ReportNodeIndex[] = [];
  const kindCounts = new Map<string, number>();

  const renderNode = (node: ReportNode, parentId: string | undefined, depth: number): string => {
    const first = node.events[0];
    if (!first) return '';
    const bag = first as unknown as Record<string, unknown>;
    const kind = eventKind(String(bag.type ?? 'other'));
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);

    // Label: family title + step index + the span's own name.
    const name = spanName(first);
    const stepIndex = typeof bag.stepIndex === 'number' ? ` #${bag.stepIndex}` : '';
    const label = `${KIND_TITLES[kind] ?? 'Event'}${kind === 'step' ? stepIndex : ''}${
      name !== undefined ? ` · ${name}` : ''
    }`;

    // Duration: an explicit durationMs beats the span's own timestamp spread.
    let ms: number | undefined;
    let firstTs: number | undefined;
    let lastTs: number | undefined;
    let failed = false;
    for (const event of node.events) {
      const e = event as unknown as Record<string, unknown>;
      if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) {
        ms = Math.max(ms ?? 0, e.durationMs);
      }
      if (typeof e.timestamp === 'number' && Number.isFinite(e.timestamp)) {
        firstTs = firstTs === undefined ? e.timestamp : Math.min(firstTs, e.timestamp);
        lastTs = lastTs === undefined ? e.timestamp : Math.max(lastTs, e.timestamp);
      }
      const type = String(e.type ?? '');
      if (type.endsWith('.failed') || type === 'tool.denied' || type === 'run.aborted') {
        failed = true;
      }
    }
    if (ms === undefined && firstTs !== undefined && lastTs !== undefined && lastTs > firstTs) {
      ms = lastTs - firstTs;
    }

    const badges: string[] = [];
    if (node.agentPath !== undefined && node.agentPath.length > 0) {
      badges.push(`<span class="chip agent">${safeText(node.agentPath.join(' › '))}</span>`);
    }
    if (legCount > 1) {
      badges.push(`<span class="chip">leg ${node.legIndex + 1}/${legCount}</span>`);
    }
    if (typeof bag.stepIndex === 'number' && kind !== 'step') {
      badges.push(`<span class="chip">step ${escapeHtml(String(bag.stepIndex))}</span>`);
    }

    index.push({
      id: node.id,
      ...(parentId !== undefined ? { p: parentId } : {}),
      kind,
      label,
      ...(ms !== undefined ? { ms: Math.round(ms) } : {}),
    });

    // Open the structural lanes and anything that failed; leaves stay folded so
    // a long run is still scannable.
    const open = failed || kind === 'run' || kind === 'step' || kind === 'subagent';
    const children =
      depth + 1 >= REPORT_MAX_TREE_DEPTH
        ? node.children.length > 0
          ? `<div class="note">${fmtInt(node.children.length)} deeper span(s) omitted</div>`
          : ''
        : node.children.map((child) => renderNode(child, node.id, depth + 1)).join('');

    return (
      `<details class="node k-${kind}${failed ? ' bad' : ''}" id="${escapeHtml(node.id)}"${
        open ? ' open' : ''
      }>` +
      `<summary><span class="dot"></span>` +
      `<span class="label" title="${safeText(label)}">${safeText(label)}</span>` +
      badges.join('') +
      (ms !== undefined ? `<span class="ms">${escapeHtml(fmtMs(ms))}</span>` : '') +
      `<span class="count">${fmtInt(node.events.length)} ev</span></summary>` +
      `<div class="body">${node.events.map((event) => renderEvent(event, t0)).join('')}` +
      (children ? `<div class="kids">${children}</div>` : '') +
      `</div></details>`
    );
  };

  const html = roots.map((root) => renderNode(root, undefined, 0)).join('');
  return { html, index, kindCounts };
}

const LIGHT_VARS =
  '--bg:#f6f7f9;--panel:#fff;--fg:#14171d;--muted:#5b6472;--line:#e3e6ec;--pre:#f2f4f7;--hi:#fff6d6';
const DARK_VARS =
  '--bg:#0e1014;--panel:#171a21;--fg:#e6e8ee;--muted:#98a1b1;--line:#262b35;--pre:#101319;--hi:#2c2a16';

const KIND_VARS =
  '--k-run:#6366f1;--k-step:#0ea5e9;--k-model:#a855f7;--k-tool:#10b981;--k-subagent:#ec4899;' +
  '--k-approval:#f59e0b;--k-checkpoint:#0891b2;--k-compaction:#84cc16;--k-operation:#14b8a6;' +
  '--k-cost:#d97706;--k-other:#8b93a1;--bad:#ef4444;--ok:#10b981';

/** Inline stylesheet. No `url()`, no @import, no webfont — nothing to fetch. */
const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:20px 16px 72px}
h1{font-size:19px;margin:0 0 2px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:26px 0 8px}
a{color:inherit}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 14px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:8px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
.stat b{display:block;font-size:17px;font-weight:600;line-height:1.3}
.stat span{color:var(--muted);font-size:11.5px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;
border:1px solid var(--line);background:var(--panel)}
.pill.completed{color:var(--ok);border-color:var(--ok)}
.pill.failed,.pill.aborted{color:var(--bad);border-color:var(--bad)}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px}
input[type=search]{flex:1 1 220px;min-width:0;padding:6px 9px;border-radius:8px;
border:1px solid var(--line);background:var(--panel);color:inherit;font:inherit}
button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);
border-radius:8px;padding:5px 10px;cursor:pointer}
button.on{border-color:currentColor;font-weight:600}
.chip{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;
font-size:11.5px;color:var(--muted);white-space:nowrap;max-width:46ch;overflow:hidden;
text-overflow:ellipsis;vertical-align:middle}
.chip.warn{color:var(--k-approval);border-color:var(--k-approval)}
.chip.agent{color:var(--k-subagent);border-color:var(--k-subagent)}
.node{border:1px solid var(--line);border-left:3px solid var(--k);border-radius:8px;
background:var(--panel);margin:6px 0;padding:0}
.node.bad{border-left-color:var(--bad)}
.node>summary{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:7px 10px;
cursor:pointer;list-style:none}
.node>summary::-webkit-details-marker{display:none}
.dot{width:7px;height:7px;border-radius:50%;background:var(--k);flex:none}
.label{font-weight:600}
.ms,.count{color:var(--muted);font-size:11.5px;margin-left:auto}
.count{margin-left:0}
.body{padding:0 10px 8px}
.kids{margin:4px 0 0 6px;padding-left:8px;border-left:1px dashed var(--line)}
.ev{border-top:1px solid var(--line);padding:6px 0}
.evh{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.seq{color:var(--muted);font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace}
.etype{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--k)}
.rel{color:var(--muted);font-size:11.5px}
.usage{color:var(--muted);font-size:12px;margin:3px 0 0}
.err{margin:4px 0 0;padding:5px 8px;border-radius:7px;border:1px solid var(--bad);
color:var(--bad);font-size:12.5px}
.errmsg{color:var(--fg);margin-top:3px;white-space:pre-wrap;word-break:break-word}
.pay{margin:4px 0 0}
.pay>summary{cursor:pointer;color:var(--muted);font-size:12px}
pre{margin:4px 0 0;padding:8px 10px;background:var(--pre);border:1px solid var(--line);
border-radius:7px;max-height:340px;overflow:auto;font-size:12px;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;
word-break:break-word}
.note{color:var(--muted);font-size:12.5px;padding:6px 0}
.hidden{display:none}
.flash{outline:2px solid var(--k-approval)}
footer{color:var(--muted);font-size:12px;margin-top:26px;border-top:1px solid var(--line);
padding-top:10px}
.k-run{--k:var(--k-run)}.k-step{--k:var(--k-step)}.k-model{--k:var(--k-model)}
.k-tool{--k:var(--k-tool)}.k-subagent{--k:var(--k-subagent)}.k-approval{--k:var(--k-approval)}
.k-checkpoint{--k:var(--k-checkpoint)}.k-compaction{--k:var(--k-compaction)}
.k-operation{--k:var(--k-operation)}.k-cost{--k:var(--k-cost)}.k-other{--k:var(--k-other)}
@media (max-width:560px){.ms,.count{margin-left:0}}
`;

/**
 * Inline viewer. Progressive enhancement only — the report is fully readable
 * with JS disabled (native `<details>`). Every label reaches the DOM through
 * `textContent`, never innerHTML, so the escaping story holds on this side
 * too. Wrapped in try/catch: a broken viewer must never blank the report.
 */
const REPORT_JS = `
(function(){try{
var doc=document,data=window.__DEUZ_RUN__||{},nodes=data.nodes||[];
var byId=function(id){return doc.getElementById(id)};
var slow=nodes.filter(function(n){return typeof n.ms==='number'})
.sort(function(a,b){return b.ms-a.ms}).slice(0,5);
var box=byId('dz-slow');
if(box&&slow.length){for(var i=0;i<slow.length;i++){
var b=doc.createElement('button');b.type='button';
b.textContent=slow[i].label+' · '+slow[i].ms+'ms';b.setAttribute('data-goto',slow[i].id);
box.appendChild(b)}var sec=byId('dz-slow-sec');if(sec)sec.hidden=false}
doc.addEventListener('click',function(ev){
var t=ev.target;var id=t&&t.getAttribute&&t.getAttribute('data-goto');if(!id)return;
var el=byId(id);if(!el)return;var p=el;
while(p){if(p.tagName==='DETAILS')p.open=true;p=p.parentNode}
if(el.scrollIntoView)el.scrollIntoView({block:'center'});
el.classList.add('flash')});
var all=function(open){var d=doc.querySelectorAll('details');
for(var i=0;i<d.length;i++)d[i].open=open};
var xe=byId('dz-expand');if(xe)xe.onclick=function(){all(true)};
var xc=byId('dz-collapse');if(xc)xc.onclick=function(){all(false)};
var kind='',q=byId('dz-q');
var apply=function(){
var term=((q&&q.value)||'').toLowerCase(),keep={},i,n,el;
for(i=0;i<nodes.length;i++){n=nodes[i];el=byId(n.id);if(!el)continue;
var okKind=!kind||n.kind===kind;
var okTerm=!term||(n.label||'').toLowerCase().indexOf(term)>=0||
(el.textContent||'').toLowerCase().indexOf(term)>=0;
if(okKind&&okTerm){var cur=n;var guard=0;
while(cur&&guard++<200){keep[cur.id]=1;cur=cur.p?byIndex[cur.p]:null}}}
for(i=0;i<nodes.length;i++){el=byId(nodes[i].id);
if(el)el.classList.toggle('hidden',!keep[nodes[i].id])}};
var byIndex={};for(var j=0;j<nodes.length;j++)byIndex[nodes[j].id]=nodes[j];
if(q)q.oninput=apply;
var chips=doc.querySelectorAll('[data-kind]');
for(var k=0;k<chips.length;k++)chips[k].onclick=function(){
var v=this.getAttribute('data-kind');kind=kind===v?'':v;
var c=doc.querySelectorAll('[data-kind]');
for(var m=0;m<c.length;m++)c[m].classList.toggle('on',c[m].getAttribute('data-kind')===kind);
apply()};
}catch(e){}})();
`;

function themeCss(theme: 'auto' | 'light' | 'dark'): string {
  if (theme === 'dark') return `:root{${DARK_VARS};${KIND_VARS}}`;
  if (theme === 'light') return `:root{${LIGHT_VARS};${KIND_VARS}}`;
  return (
    `:root{${LIGHT_VARS};${KIND_VARS}}` + `@media (prefers-color-scheme:dark){:root{${DARK_VARS}}}`
  );
}

function statCard(label: string, value: string): string {
  return `<div class="stat"><b>${value}</b><span>${escapeHtml(label)}</span></div>`;
}

/**
 * Render one run's observation events as a standalone HTML document — the
 * viewer for `createMemoryObserver` / `createJsonlObserver` output. Pure and
 * total: an empty list, a run with no terminal event, out-of-order or
 * hand-built events all produce a document instead of a throw.
 *
 * `summarizeRun` supplies every headline number, so the report and the
 * programmatic summary can never disagree.
 */
export function renderRunReport(
  events: readonly ObserveEvent[],
  options?: RunReportOptions,
): string {
  const theme = options?.theme ?? 'auto';
  const title = options?.title ?? 'Deuz run report';
  const input = Array.isArray(events) ? (events as readonly ObserveEvent[]) : [];

  // One document = one run: a JSONL file usually holds many.
  const runIds: string[] = [];
  const seenRuns = new Set<string>();
  for (const event of input) {
    const id = typeof event?.runId === 'string' ? event.runId : '';
    if (!seenRuns.has(id)) {
      seenRuns.add(id);
      runIds.push(id);
    }
  }
  const wanted = options?.runId ?? runIds[0];
  // `event.type` also filters out a malformed JSONL line — the summary reads the
  // same array, so the numbers and the timeline can never disagree.
  const selected =
    wanted === undefined ? [] : input.filter((event) => event?.runId === wanted && event.type);
  const others = runIds.filter((id) => id !== wanted);

  const summary = summarizeRun(selected);
  const { ordered, legIndex } = orderByExecution(selected);
  const shown = ordered.slice(0, REPORT_MAX_EVENTS);
  const omitted = ordered.length - shown.length;
  const t0 = shown[0]?.timestamp ?? 0;
  const lastTs = shown[shown.length - 1]?.timestamp;
  let deniedCount = 0;
  for (const event of selected) if (event.type === 'tool.denied') deniedCount += 1;

  // --- span tree: nodes keyed by spanId, nested by parentSpanId -------------
  const byId = new Map<string, ReportNode>();
  const nodes: ReportNode[] = [];
  for (const event of shown) {
    const bag = event as unknown as Record<string, unknown>;
    const spanId =
      typeof bag.spanId === 'string' && bag.spanId.length > 0
        ? bag.spanId
        : `span?${event.executionId}`;
    let node = byId.get(spanId);
    if (!node) {
      node = {
        spanId,
        id: domId(nodes.length, bag.eventId),
        events: [],
        children: [],
        legIndex: legIndex.get(event.executionId) ?? 0,
        firstSequence: typeof event.sequence === 'number' ? event.sequence : 0,
      };
      byId.set(spanId, node);
      nodes.push(node);
    }
    node.events.push(event);
    if (
      node.parentSpanId === undefined &&
      typeof bag.parentSpanId === 'string' &&
      bag.parentSpanId.length > 0 &&
      bag.parentSpanId !== spanId
    ) {
      node.parentSpanId = bag.parentSpanId;
    }
    if (node.agentPath === undefined && Array.isArray(event.agentPath)) {
      node.agentPath = event.agentPath;
    }
  }

  const roots: ReportNode[] = [];
  for (const node of nodes) {
    const parent = node.parentSpanId !== undefined ? byId.get(node.parentSpanId) : undefined;
    if (parent !== undefined && parent !== node && !wouldCycle(node, parent, byId, nodes.length)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of nodes) node.children.sort(byReplayOrder);
  roots.sort(byReplayOrder);

  // Sub-agent nesting normally falls out of the spanIds. When the parent span
  // is missing (a partial file, a resumed leg), group the orphans by agentPath
  // so the agent hierarchy still reads instead of flattening.
  const plainRoots: ReportNode[] = [];
  const agentGroups = new Map<string, ReportNode[]>();
  for (const node of roots) {
    const path = node.agentPath;
    if (path !== undefined && path.length > 0 && node.parentSpanId !== undefined) {
      const key = path.join(' › ');
      const group = agentGroups.get(key);
      if (group) group.push(node);
      else agentGroups.set(key, [node]);
    } else {
      plainRoots.push(node);
    }
  }

  const tree = renderNodes(plainRoots, t0, legIndex.size);
  let timeline = tree.html;
  const nodeIndex = [...tree.index];
  for (const [path, group] of agentGroups) {
    const sub = renderNodes(group, t0, legIndex.size);
    nodeIndex.push(...sub.index);
    for (const [kind, count] of sub.kindCounts) {
      tree.kindCounts.set(kind, (tree.kindCounts.get(kind) ?? 0) + count);
    }
    timeline +=
      `<details class="node k-subagent" open>` +
      `<summary><span class="dot"></span><span class="label">Sub-agent path</span>` +
      `<span class="chip agent">${safeText(path)}</span></summary>` +
      `<div class="body"><div class="kids">${sub.html}</div></div></details>`;
  }
  if (timeline === '') {
    timeline = `<div class="card note">No events to display${
      wanted !== undefined && wanted !== '' ? ` for run ${safeText(wanted)}` : ''
    }.</div>`;
  }

  // --- head ----------------------------------------------------------------
  const stats = [
    statCard('steps', fmtInt(summary.stepCount)),
    statCard('model calls', fmtInt(summary.modelCallCount)),
    statCard('tool calls', fmtInt(summary.toolCallCount)),
    statCard('tool errors', fmtInt(summary.toolErrorCount)),
    statCard('denied tools', fmtInt(deniedCount)),
    statCard('retries', fmtInt(summary.retryCount)),
    statCard('approvals', fmtInt(summary.approvalCount)),
    statCard('checkpoints', fmtInt(summary.checkpointCount)),
    statCard('sub-agents', fmtInt(summary.subAgentCount)),
    statCard('execution legs', fmtInt(summary.executionCount)),
    statCard('events', fmtInt(selected.length)),
    statCard('duration', fmtMs(summary.durationMs)),
  ];
  const tokens = [
    statCard('input tokens', fmtInt(summary.usage.inputTokens)),
    statCard('output tokens', fmtInt(summary.usage.outputTokens)),
    statCard('reasoning tokens', fmtInt(summary.usage.reasoningTokens)),
    statCard('cached read', fmtInt(summary.usage.cachedReadTokens)),
    statCard('cache write', fmtInt(summary.usage.cacheWriteTokens)),
    statCard('total tokens', fmtInt(summary.usage.totalTokens)),
  ];
  const cost = fmtUsd(summary.costUsd);
  if (cost !== undefined) tokens.push(statCard('cost', escapeHtml(cost)));

  const errorList =
    summary.errors.length === 0
      ? ''
      : `<h2>Errors (${fmtInt(summary.errors.length)})</h2>` +
        summary.errors
          .map((error) => {
            const safe = redactForObservation(error) as Record<string, unknown>;
            const head = ['name', 'category', 'code', 'statusCode', 'provider']
              .filter((key) => safe[key] !== undefined)
              .map((key) => `${key} ${escapeHtml(String(safe[key]))}`)
              .join(' · ');
            const message = typeof safe.message === 'string' ? safe.message : undefined;
            return (
              `<div class="err"><b>error</b> ${head}` +
              (message !== undefined ? `<div class="errmsg">${safeText(message)}</div>` : '') +
              `</div>`
            );
          })
          .join('');

  const kindChips = [...tree.kindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([kind, count]) =>
        `<button type="button" data-kind="${escapeHtml(kind)}">${escapeHtml(
          KIND_TITLES[kind] ?? kind,
        )} · ${fmtInt(count)}</button>`,
    )
    .join('');

  const meta = [
    `run <span class="mono">${safeText(summary.runId || (wanted ?? ''))}</span>`,
    summary.provider !== undefined ? `provider ${safeText(summary.provider)}` : undefined,
    summary.model !== undefined
      ? `model <span class="mono">${safeText(summary.model)}</span>`
      : undefined,
    `started ${escapeHtml(fmtTime(summary.startedAt))}`,
    summary.finishedAt !== undefined
      ? `finished ${escapeHtml(fmtTime(summary.finishedAt))}`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const notes: string[] = [];
  if (omitted > 0) {
    notes.push(
      `<div class="card note">${fmtInt(omitted)} of ${fmtInt(
        ordered.length,
      )} events are not rendered (report cap ${fmtInt(
        REPORT_MAX_EVENTS,
      )}); the numbers above count all of them.</div>`,
    );
  }
  if (others.length > 0) {
    notes.push(
      `<div class="card note">${fmtInt(others.length)} other run(s) in this input: ` +
        `<span class="mono">${others.slice(0, 8).map(safeText).join(', ')}</span>` +
        `${others.length > 8 ? ', …' : ''} — pass <span class="mono">runId</span> to render one.</div>`,
    );
  }

  const viewerData = { runId: summary.runId, nodes: nodeIndex };

  return (
    `<!doctype html>\n<html lang="en" data-theme="${escapeHtml(theme)}">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${safeText(title)}</title>\n` +
    `<style>${themeCss(theme)}${REPORT_CSS}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    `<h1>${safeText(title)}</h1>\n` +
    `<p class="sub"><span class="pill ${escapeHtml(summary.status)}">${escapeHtml(
      summary.status,
    )}</span> ${meta}</p>\n` +
    notes.join('\n') +
    `<div class="stats">${stats.join('')}</div>\n` +
    `<h2>Usage</h2>\n<div class="stats">${tokens.join('')}</div>\n` +
    errorList +
    `<h2>Timeline</h2>\n` +
    `<div class="bar">` +
    `<input type="search" id="dz-q" placeholder="filter spans…" aria-label="filter spans">` +
    `<button type="button" id="dz-expand">expand all</button>` +
    `<button type="button" id="dz-collapse">collapse all</button>` +
    `</div>\n` +
    (kindChips ? `<div class="bar">${kindChips}</div>\n` : '') +
    `<div id="dz-slow-sec" class="bar" hidden><span class="chip">slowest</span>` +
    `<span id="dz-slow" class="bar"></span></div>\n` +
    `<div id="dz-timeline">${timeline}</div>\n` +
    `<footer>${fmtInt(selected.length)} event(s) · schemaVersion 1 · ` +
    `last event ${escapeHtml(fmtTime(lastTs))} · rendered by @deuz-sdk/core</footer>\n` +
    `</div>\n<script>window.__DEUZ_RUN__=${jsonForScript(viewerData)};${REPORT_JS}</script>\n` +
    `</body>\n</html>\n`
  );
}
