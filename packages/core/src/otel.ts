/**
 * OpenTelemetry bridge (1.9) — the LAST MILE from Deuz's own seams to a real
 * collector. Deuz already owned the hard half: the `deps.tracer` seam (+
 * `tracerMode`), `internal/tracer-bridge.ts` as the SINGLE span source, and the
 * versioned `ObserveEvent` protocol with ids/sequence/sampling/redaction. What
 * was missing was this adapter, so "send Deuz traces to our collector" was a
 * task (write a 3-method Tracer, invent attribute names, do context
 * propagation) instead of a config line.
 *
 * Two entry points; either works alone:
 *
 *   deps.tracer   = createOtelTracer()    // drives the existing bridge topology
 *   deps.observer = createOtelObserver()  // richer: ONE semconv span per model call
 *
 * Attaching BOTH double-spans a run — pick one (the observer is recommended:
 * `gen_ai.usage.*` then lands exactly once per model request, so dashboard sums
 * are exact).
 *
 * `@opentelemetry/api` is an OPTIONAL PEER imported lazily through a VARIABLE
 * specifier (the `src/schema/bridge.ts` pattern) so tsup's `.d.ts` resolution
 * and the browser bundle stay clean and core keeps ZERO runtime dependencies.
 * Its types never appear in a public signature here — hence `tracer?: unknown`.
 * When the peer is absent the run is untouched: spans are dropped and the
 * actionable install error surfaces through {@link otelReady} / `flush()`.
 *
 * SECURITY (P0). Content capture is OPT-IN and REDACTED — this is the one place
 * where copying the competition would be wrong. Default output is counts, ids,
 * names, small enums and durations; never prompts, completions, tool payloads,
 * reasoning, image bytes or error messages. With `captureContent: true` every
 * captured value passes `redactForObservation` HERE as well (the observation
 * runtime already redacted it — this is the second barrier), non-primitive
 * attribute values are dropped rather than stringified, and recorded exceptions
 * carry name/code only (never a stack).
 */
import type { Observer, ObserveEvent, ObservationOptions } from './types/observe';
import type { Span, SpanOptions, Tracer } from './types/deps';
import type { Usage } from './types/usage';
import { createTracerBridge } from './internal/tracer-bridge';
import { redactForObservation, redactObservationString } from './internal/redact';
import { InvalidRequestError } from './errors';

export interface OtelTracerOptions {
  /** Pass your own OTel tracer; otherwise the adapter lazily resolves the global one. */
  tracer?: unknown;
  /** 'gen-ai' (default) maps to OpenTelemetry GenAI semconv; 'deuz' keeps today's span names. */
  naming?: 'gen-ai' | 'deuz';
  /** Capture prompt/completion content on spans. Default FALSE — see below. */
  captureContent?: boolean;
}

// ---------------------------------------------------------------------------
// Structural shapes of the peer (never the peer's own types)
// ---------------------------------------------------------------------------

type OtelValue = string | number | boolean | readonly string[] | readonly number[];
type OtelAttributes = Record<string, OtelValue>;

interface OtelSpanLike {
  setAttribute(key: string, value: OtelValue): unknown;
  setAttributes?(attributes: OtelAttributes): unknown;
  addEvent?(name: string, attributes?: OtelAttributes): unknown;
  recordException?(exception: { name?: string; message?: string; code?: string }): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  end(): void;
}

interface OtelTracerLike {
  startSpan(
    name: string,
    options?: { kind?: number; attributes?: OtelAttributes },
    context?: unknown,
  ): OtelSpanLike;
}

interface OtelApiLike {
  trace?: {
    getTracer(name: string, version?: string): OtelTracerLike;
    setSpan(context: unknown, span: OtelSpanLike): unknown;
  };
  context?: { active(): unknown };
  SpanKind?: { CLIENT?: number; INTERNAL?: number };
  SpanStatusCode?: { ERROR?: number };
}

const INSTRUMENTATION_NAME = '@deuz-sdk/core';
/** Bound the pre-resolution buffer — a peer that never loads must not grow memory. */
const MAX_BUFFERED_SPANS = 512;
/** Ops recorded per buffered span before we stop recording (defensive only). */
const MAX_BUFFERED_OPS = 64;
/** Captured content is already bounded by ObservationLimits; this is the span-side cap. */
const MAX_CONTENT_CHARS = 16_384;
/** Live executions tracked by the observer before the oldest is force-settled. */
const MAX_TRACKED_EXECUTIONS = 1024;
/**
 * `SpanKind.INTERNAL`/`CLIENT` and `SpanStatusCode.ERROR` are stable values in
 * the versioned `@opentelemetry/api` enums. The peer's own values win whenever
 * the module resolved; these fallbacks only matter for a hand-passed `tracer`
 * with no peer installed.
 */
const FALLBACK_KIND_INTERNAL = 0;
const FALLBACK_KIND_CLIENT = 2;
const FALLBACK_STATUS_ERROR = 2;

async function loadOtelApi(): Promise<OtelApiLike> {
  // Variable specifier keeps TS/esbuild from resolving the optional peer statically.
  const peer = '@opentelemetry/api';
  try {
    const mod = await import(peer);
    return (mod.default ?? mod) as OtelApiLike;
  } catch (err) {
    throw new InvalidRequestError({
      message:
        'The OpenTelemetry bridge needs the optional peer "@opentelemetry/api" — install it: npm i @opentelemetry/api. Or pass an existing tracer: createOtelTracer({ tracer }).',
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Readiness handle (the actionable-install-error path)
// ---------------------------------------------------------------------------

const OTEL_READY = Symbol('deuz.otel.ready');

function attachReady<T extends object>(target: T, ready: Promise<void>): T {
  Object.defineProperty(target, OTEL_READY, { value: ready, enumerable: false });
  return target;
}

/**
 * Await an adapter's peer resolution. Resolves once spans are flowing; REJECTS
 * with the actionable "install @opentelemetry/api" error when the peer is
 * missing and no `tracer` was passed. Nothing else observes that failure — a
 * missing collector library must never break a run (G2), so call this once at
 * boot if you want to fail loudly. It does NOT force-flush the exporter; that
 * is the SDK provider's `forceFlush()`.
 */
export function otelReady(target: Tracer | Observer): Promise<void> {
  if (!target || typeof target !== 'object') return Promise.resolve();
  const handle = (target as unknown as Record<symbol, Promise<void> | undefined>)[OTEL_READY];
  return handle ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Attribute coercion
// ---------------------------------------------------------------------------

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Coerce a seam attribute bag into OTel-legal values. Non-primitives are
 * DROPPED, never stringified: `String(value)` on an unvetted object is exactly
 * how message content sneaks onto a span.
 */
function toAttributes(input: Record<string, unknown> | undefined): OtelAttributes {
  const out: OtelAttributes = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isPrimitive(value)) out[key] = value;
    else if (Array.isArray(value) && value.every(isPrimitive)) out[key] = value.map(String);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Span writer: buffers until the peer resolves, then replays in creation order
// ---------------------------------------------------------------------------

type SpanKind = 'client' | 'internal';

interface WriterSpan {
  /** Skips `undefined` so callers can inline optional fields. */
  attr(key: string, value: OtelValue | undefined): void;
  attrs(values: OtelAttributes): void;
  event(name: string, values?: OtelAttributes): void;
  /** recordException + ERROR status (no `end`) under the content policy. */
  error(err: unknown): void;
  end(): void;
}

interface Writer {
  readonly captureContent: boolean;
  readonly ready: Promise<void>;
  start(name: string, kind: SpanKind, attributes: OtelAttributes, parent?: WriterSpan): WriterSpan;
}

interface WriterSpanImpl extends WriterSpan {
  /** The materialized peer span, once it exists — a child's parent context. */
  real?: OtelSpanLike;
  materialize(): void;
}

function createWriter(options: OtelTracerOptions): Writer {
  const captureContent = options.captureContent === true;
  const passed = asTracerLike(options.tracer);
  let tracer: OtelTracerLike | undefined = passed;
  let api: OtelApiLike | undefined;
  let live = false;
  const buffered: WriterSpanImpl[] = [];

  const activate = (mod: OtelApiLike | undefined): void => {
    api = mod;
    if (!tracer && mod?.trace) {
      try {
        tracer = mod.trace.getTracer(INSTRUMENTATION_NAME);
      } catch {
        tracer = undefined; // a broken provider must not break the run (G2)
      }
    }
    live = true;
    for (const span of buffered) span.materialize();
    buffered.length = 0;
  };

  // The peer is loaded even when a tracer was passed: `trace.setSpan` +
  // `context.active()` are what make the parent-child tree real, and the
  // enums come from there. Spans opened before it settles are buffered so a
  // run is never HALF parented. With a passed tracer a missing peer is not an
  // error (flat spans, documented); without one, `ready` rejects.
  const ready = loadOtelApi().then(
    (mod) => {
      activate(mod);
    },
    (err: unknown) => {
      activate(undefined);
      if (!passed) throw err;
    },
  );
  // Handled here so an unawaited rejection can never crash the host process;
  // `otelReady()` still sees the rejection.
  ready.catch(() => undefined);

  const kindValue = (kind: SpanKind): number => {
    const enums = api?.SpanKind;
    if (kind === 'client') return enums?.CLIENT ?? FALLBACK_KIND_CLIENT;
    return enums?.INTERNAL ?? FALLBACK_KIND_INTERNAL;
  };

  const startReal = (
    name: string,
    kind: SpanKind,
    attributes: OtelAttributes,
    parent: WriterSpanImpl | undefined,
  ): OtelSpanLike | undefined => {
    if (!tracer) return undefined;
    try {
      const parentSpan = parent?.real;
      const ctx =
        parentSpan && api?.trace?.setSpan && api.context
          ? api.trace.setSpan(api.context.active(), parentSpan)
          : undefined;
      return tracer.startSpan(name, { kind: kindValue(kind), attributes }, ctx);
    } catch {
      return undefined; // a throwing tracer never affects the run (G2)
    }
  };

  const toException = (err: unknown): { name?: string; message?: string; code?: string } => {
    // Built fresh on purpose: passing the raw error would hand OTel its `stack`
    // (paths, sometimes arguments) and its unredacted `message`.
    if (typeof err === 'string') {
      return captureContent
        ? { name: 'Error', message: redactObservationString(err) }
        : { name: 'Error' };
    }
    if (err && typeof err === 'object') {
      const e = err as { name?: unknown; message?: unknown; code?: unknown };
      return {
        ...(typeof e.name === 'string' ? { name: e.name } : {}),
        ...(typeof e.code === 'string' ? { code: e.code } : {}),
        ...(captureContent && typeof e.message === 'string'
          ? { message: redactObservationString(e.message) }
          : {}),
      };
    }
    return { name: 'Error' };
  };

  const makeSpan = (
    name: string,
    kind: SpanKind,
    attributes: OtelAttributes,
    parent?: WriterSpan,
  ): WriterSpanImpl => {
    let real: OtelSpanLike | undefined;
    let queue: ((span: OtelSpanLike) => void)[] | undefined;
    let ended = false;

    const apply = (op: (span: OtelSpanLike) => void): void => {
      if (real) {
        try {
          op(real);
        } catch {
          // exporter failures never affect the run (G2)
        }
        return;
      }
      if (queue && queue.length < MAX_BUFFERED_OPS) queue.push(op);
    };

    const self: WriterSpanImpl = {
      attr(key, value) {
        if (value === undefined) return;
        apply((span) => span.setAttribute(key, value));
      },
      attrs(values) {
        apply((span) => {
          if (span.setAttributes) span.setAttributes(values);
          else for (const [k, v] of Object.entries(values)) span.setAttribute(k, v);
        });
      },
      event(eventName, values) {
        apply((span) => span.addEvent?.(eventName, values));
      },
      error(err) {
        const record = toException(err);
        apply((span) => {
          span.recordException?.(record);
          span.setStatus?.({
            code: api?.SpanStatusCode?.ERROR ?? FALLBACK_STATUS_ERROR,
            ...(record.message !== undefined ? { message: record.message } : {}),
          });
        });
      },
      end() {
        if (ended) return; // idempotent settle, like internal/trace.ts SpanHandle
        ended = true;
        apply((span) => span.end());
      },
      materialize() {
        real = startReal(name, kind, attributes, parent as WriterSpanImpl | undefined);
        self.real = real;
        const ops = queue;
        queue = undefined;
        if (real && ops) {
          for (const op of ops) {
            try {
              op(real);
            } catch {
              // exporter failures never affect the run (G2)
            }
          }
        }
      },
    };

    if (live) {
      real = startReal(name, kind, attributes, parent as WriterSpanImpl | undefined);
      self.real = real;
    } else if (buffered.length < MAX_BUFFERED_SPANS) {
      queue = [];
      buffered.push(self);
    }
    return self;
  };

  return { captureContent, ready, start: makeSpan };
}

/** Duck-type an injected tracer; anything else is ignored (we then resolve the global one). */
function asTracerLike(value: unknown): OtelTracerLike | undefined {
  if (value && typeof (value as OtelTracerLike).startSpan === 'function') {
    return value as OtelTracerLike;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GenAI semantic conventions
//
// Verified 2026-07 against open-telemetry/semantic-conventions-genai:
//   inference span   `{gen_ai.operation.name} {gen_ai.request.model}`, kind CLIENT
//   embeddings span  `embeddings {gen_ai.request.model}`, kind CLIENT
//   execute_tool     `execute_tool {gen_ai.tool.name}`, kind INTERNAL
//   invoke_agent     `invoke_agent {gen_ai.agent.name}`, or bare when unknown
//   gen_ai.system is DEPRECATED in favor of gen_ai.provider.name (we emit both:
//   the alias costs one attribute and many shipped dashboards still key on it)
// Anything with no convention stays in the `deuz.*` namespace — a namespaced
// attribute is never wrong, a guessed `gen_ai.*` one is.
// ---------------------------------------------------------------------------

/** Deuz provider id → semconv `gen_ai.provider.name` (registry-recognized values). */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  xai: 'x_ai',
  google: 'gcp.gemini',
  'vertex-google': 'gcp.vertex_ai',
  'vertex-anthropic': 'gcp.vertex_ai',
  azure: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
};

function providerAttributes(provider: string): OtelAttributes {
  const name = PROVIDER_NAMES[provider] ?? provider;
  return {
    'gen_ai.provider.name': name,
    // Deprecated in semconv, still the key many shipped dashboards filter on.
    'gen_ai.system': name,
    ...(name !== provider ? { 'deuz.provider': provider } : {}),
  };
}

/** Per-model-call token attributes — exactly once per request, so sums stay exact. */
function usageAttributes(usage: Usage): OtelAttributes {
  const out: OtelAttributes = {
    'gen_ai.usage.input_tokens': usage.inputTokens,
    'gen_ai.usage.output_tokens': usage.outputTokens,
  };
  if (usage.cachedReadTokens > 0) {
    out['gen_ai.usage.cache_read.input_tokens'] = usage.cachedReadTokens;
  }
  const created = usage.cacheWriteTokens + usage.cacheWrite1hTokens;
  if (created > 0) out['gen_ai.usage.cache_creation.input_tokens'] = created;
  if (usage.reasoningTokens > 0)
    out['gen_ai.usage.reasoning.output_tokens'] = usage.reasoningTokens;
  out['deuz.usage.total_tokens'] = usage.totalTokens;
  return out;
}

/**
 * Run-level TOTALS live in the `deuz.*` namespace: a dashboard summing
 * `gen_ai.usage.*` across a trace would otherwise count every step twice
 * (once on its `chat` span, once on the run).
 */
function runUsageAttributes(usage: Usage): OtelAttributes {
  return {
    'deuz.usage.input_tokens': usage.inputTokens,
    'deuz.usage.output_tokens': usage.outputTokens,
    'deuz.usage.total_tokens': usage.totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Content capture (opt-in, double-redacted)
// ---------------------------------------------------------------------------

/** JSON-encode a captured payload. Redaction runs HERE too — second barrier. */
function contentAttribute(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let json: string | undefined;
  try {
    const safe = redactForObservation(value);
    json = typeof safe === 'string' ? safe : JSON.stringify(safe);
  } catch {
    return undefined; // an unserializable payload is simply not reported
  }
  if (typeof json !== 'string' || json.length === 0) return undefined;
  return json.length > MAX_CONTENT_CHARS ? `${json.slice(0, MAX_CONTENT_CHARS)}[Truncated]` : json;
}

/** Canonical `Part` → semconv message part (`gen-ai-input-messages.json`). */
function toSemconvPart(raw: unknown): Record<string, unknown> {
  const part = raw as {
    type?: unknown;
    text?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    toolUseId?: unknown;
    result?: unknown;
  };
  switch (part.type) {
    case 'text':
      return { type: 'text', content: String(part.text ?? '') };
    case 'reasoning':
      return { type: 'reasoning', content: String(part.text ?? '') };
    case 'tool_use':
      return {
        type: 'tool_call',
        ...(typeof part.id === 'string' ? { id: part.id } : {}),
        name: String(part.name ?? ''),
        arguments: part.input,
      };
    case 'tool_result':
      return {
        type: 'tool_call_response',
        ...(typeof part.toolUseId === 'string' ? { id: part.toolUseId } : {}),
        response: part.result,
      };
    default:
      // GenericPart: image/file parts report their KIND only — never the bytes.
      return { type: typeof part.type === 'string' ? part.type : 'generic' };
  }
}

/** Canonical `Message[]` → semconv `gen_ai.input.messages` shape. */
function toInputMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    const message = raw as { role?: unknown; content?: unknown };
    const content = message.content;
    return {
      role: typeof message.role === 'string' ? message.role : 'user',
      parts:
        typeof content === 'string'
          ? [{ type: 'text', content }]
          : Array.isArray(content)
            ? content.map(toSemconvPart)
            : [],
    };
  });
}

/** Model output → semconv `gen_ai.output.messages` shape (one message per choice). */
function toOutputMessages(text: unknown, reasoning: unknown, finishReason: string): unknown {
  const parts: Record<string, unknown>[] = [];
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    parts.push({ type: 'reasoning', content: reasoning });
  }
  parts.push({ type: 'text', content: typeof text === 'string' ? text : '' });
  return [{ role: 'assistant', parts, finish_reason: finishReason }];
}

// ---------------------------------------------------------------------------
// createOtelTracer — implements the Dependencies.tracer seam
// ---------------------------------------------------------------------------

/** Bridge span name → semconv name/operation/kind. */
function mapBridgeSpan(
  name: string,
  attributes: OtelAttributes,
): { name: string; operation?: string; kind: SpanKind } {
  const model = attributes['gen_ai.request.model'];
  const tool = attributes['gen_ai.tool.name'];
  switch (name) {
    case 'invoke':
    case 'step':
      // The bridge's `invoke` IS the model call for single-turn runs, so it
      // must carry the `chat` name/usage; multi-step runs report usage on both
      // the invoke and its steps (today's behavior with `deuz` names too).
      return {
        name: typeof model === 'string' ? `chat ${model}` : 'chat',
        operation: 'chat',
        kind: 'client',
      };
    case 'execute_tool':
      return {
        name: typeof tool === 'string' ? `execute_tool ${tool}` : 'execute_tool',
        operation: 'execute_tool',
        kind: 'internal',
      };
    default:
      return { name, kind: 'internal' };
  }
}

/**
 * Implement the `Dependencies.tracer` seam over OpenTelemetry. The existing
 * tracer bridge (`internal/tracer-bridge.ts`) stays the SINGLE span source —
 * this only translates its `invoke`/`step`/`execute_tool` lifecycle onto real
 * OTel spans, renaming to GenAI semconv under `naming: 'gen-ai'` (the default)
 * and passing today's names/attributes through untouched under `'deuz'`.
 *
 * ```ts
 * const tracer = createOtelTracer();          // global provider, semconv names
 * await otelReady(tracer);                    // optional: fail loudly at boot
 * streamChat({ model, messages, deps: { tracer } });
 * ```
 *
 * `captureContent` has no effect here: the bridge deliberately carries no
 * message content (attribute policy, `internal/trace.ts`). Use
 * {@link createOtelObserver} for content capture.
 */
export function createOtelTracer(options: OtelTracerOptions = {}): Tracer {
  const writer = createWriter(options);
  const genAi = (options.naming ?? 'gen-ai') === 'gen-ai';
  // Seam Span -> writer span, so `SpanOptions.parent` builds a real trace tree.
  const opened = new WeakMap<Span, WriterSpan>();

  const tracer: Tracer = {
    startSpan(name: string, attributes?: Record<string, unknown>, spanOptions?: SpanOptions): Span {
      const attrs = toAttributes(attributes);
      const mapped: { name: string; operation?: string; kind: SpanKind } = genAi
        ? mapBridgeSpan(name, attrs)
        : { name, kind: name === 'execute_tool' ? 'internal' : 'client' };
      if (genAi) {
        if (mapped.operation) attrs['gen_ai.operation.name'] = mapped.operation;
        const provider = attrs['gen_ai.provider.name'];
        if (typeof provider === 'string') Object.assign(attrs, providerAttributes(provider));
      }
      const parent = spanOptions?.parent ? opened.get(spanOptions.parent) : undefined;
      const span = writer.start(mapped.name, mapped.kind, attrs, parent);
      const seam: Span = {
        setAttribute(key, value) {
          if (isPrimitive(value)) span.attr(key, value);
          else if (Array.isArray(value) && value.every(isPrimitive))
            span.attr(key, value.map(String));
          // anything else is dropped, never stringified (see toAttributes)
        },
        recordException(error) {
          span.error(error);
        },
        end() {
          span.end();
        },
      };
      opened.set(seam, span);
      return seam;
    },
  };
  return attachReady(tracer, writer.ready);
}

// ---------------------------------------------------------------------------
// createOtelObserver — maps the ObserveEvent protocol onto semconv spans
// ---------------------------------------------------------------------------

const TERMINAL_TYPES = new Set<ObserveEvent['type']>([
  'run.completed',
  'run.suspended',
  'run.aborted',
  'run.failed',
]);

interface ExecutionState {
  /** The run-level span (`invoke_agent` / `embeddings`), when the leg opened one. */
  root?: WriterSpan;
  /** Event spanId → span, so `parentSpanId` resolves to a real parent. */
  spans: Map<string, WriterSpan>;
  /** Embedding runs have no `model.*` lifecycle: the run span IS the inference span. */
  embeddings: boolean;
}

/** Capture flags requested from the observation runtime when content is opted in. */
const CAPTURE_ALL: ObservationOptions = {
  capture: {
    messages: true,
    outputText: true,
    reasoning: true,
    toolInputs: true,
    toolOutputs: true,
    errorMessages: true,
  },
};

/**
 * Observe a Deuz run into OpenTelemetry. Consumes the versioned `ObserveEvent`
 * protocol, so it sees more than the tracer seam does and can emit exact GenAI
 * semconv spans:
 *
 * - `invoke_agent` (run) — one root per execution leg, `deuz.*` totals
 * - `chat {model}` (per model request, kind CLIENT) — `gen_ai.usage.*` lands
 *   here exactly once, `gen_ai.response.*`, retries as span events
 * - `execute_tool {name}` (kind INTERNAL) — `gen_ai.tool.*`, `deuz.tool.is_error`
 * - `embeddings {model}` for embed/embedMany runs
 *
 * Step boundaries are NOT spans in `gen-ai` naming (semconv has no `step`
 * operation); they survive as `deuz.step.index` on each child. Approvals,
 * checkpoints and compaction land as span events on the run span. Under
 * `naming: 'deuz'` the adapter instead drives `internal/tracer-bridge.ts` — the
 * single source of today's `invoke → step → execute_tool` shape — so pinned
 * dashboards keep working (content capture is unavailable in that mode).
 *
 * ```ts
 * const observer = createOtelObserver({ captureContent: false });
 * generateText({ model, messages, deps: { observer } });
 * ```
 */
export function createOtelObserver(options: OtelTracerOptions = {}): Observer {
  if ((options.naming ?? 'gen-ai') === 'deuz') return createBridgeObserver(options);

  const writer = createWriter(options);
  const capture = writer.captureContent;
  const executions = new Map<string, ExecutionState>();

  const settle = (state: ExecutionState): void => {
    for (const span of state.spans.values()) span.end(); // idempotent
    state.spans.clear();
    state.root?.end();
  };

  const stateOf = (event: ObserveEvent): ExecutionState => {
    let state = executions.get(event.executionId);
    if (!state) {
      // Legs whose first event is not `run.started` (resume after a
      // checkpoint.loaded, aux `operation.*` runs) simply have no root span.
      state = { spans: new Map(), embeddings: false };
      if (executions.size >= MAX_TRACKED_EXECUTIONS) {
        const oldest = executions.keys().next().value;
        if (oldest !== undefined) {
          const stale = executions.get(oldest);
          executions.delete(oldest);
          if (stale) settle(stale);
        }
      }
      executions.set(event.executionId, state);
    }
    return state;
  };

  const parentOf = (state: ExecutionState, event: ObserveEvent): WriterSpan | undefined =>
    (event.parentSpanId !== undefined ? state.spans.get(event.parentSpanId) : undefined) ??
    state.root;

  /** Common identity on every child span. */
  const childAttributes = (event: ObserveEvent): OtelAttributes => ({
    ...(event.stepIndex !== undefined ? { 'deuz.step.index': event.stepIndex } : {}),
    ...(event.agentPath && event.agentPath.length > 0
      ? { 'deuz.agent.path': event.agentPath.join('/') }
      : {}),
  });

  const emit = (event: ObserveEvent): void => {
    if (event.type === 'cost.calculated') {
      // An async priceProvider can resolve AFTER the terminal event — look the
      // leg up without resurrecting it (a settled span drops the attribute).
      const settled = executions.get(event.executionId);
      (settled?.spans.get(event.spanId) ?? settled?.root)?.attr('deuz.cost.usd', event.costUsd);
      return;
    }
    const state = stateOf(event);
    switch (event.type) {
      case 'run.started': {
        const embeddings = event.operation === 'embed' || event.operation === 'embed-many';
        const agentName = event.agentPath?.[event.agentPath.length - 1];
        state.embeddings = embeddings;
        const root = writer.start(
          embeddings
            ? `embeddings ${event.model}`
            : agentName
              ? `invoke_agent ${agentName}`
              : 'invoke_agent',
          embeddings ? 'client' : 'internal',
          {
            'gen_ai.operation.name': embeddings ? 'embeddings' : 'invoke_agent',
            ...providerAttributes(event.provider),
            'gen_ai.request.model': event.model,
            ...(agentName ? { 'gen_ai.agent.name': agentName } : {}),
            'deuz.operation': event.operation,
            'deuz.surface': event.surface,
            'deuz.run.id': event.runId,
            'deuz.execution.id': event.executionId,
            ...(event.messageCount !== undefined
              ? { 'deuz.message.count': event.messageCount }
              : {}),
            ...(event.toolCount !== undefined ? { 'deuz.tool.count': event.toolCount } : {}),
            ...(event.durable ? { 'deuz.durable': true } : {}),
            ...(event.resumed ? { 'deuz.resumed': true } : {}),
            ...childAttributes(event),
          },
        );
        state.root = root;
        state.spans.set(event.spanId, root);
        // Embedding runs have no `chat` span to carry the input.
        if (capture && embeddings) {
          root.attr(
            'gen_ai.input.messages',
            contentAttribute(toInputMessages(event.capturedMessages)),
          );
        }
        break;
      }

      case 'model.started': {
        const span = writer.start(
          `chat ${event.model}`,
          'client',
          {
            'gen_ai.operation.name': 'chat',
            ...providerAttributes(event.provider),
            'gen_ai.request.model': event.model,
            ...(event.responseFormat ? { 'gen_ai.output.type': event.responseFormat } : {}),
            'deuz.surface': event.surface,
            'deuz.max_retries': event.maxRetries,
            'deuz.message.count': event.messageCount,
            'deuz.tool.count': event.toolCount,
            ...(event.purpose ? { 'deuz.purpose': event.purpose } : {}),
            ...(event.promptCaching ? { 'deuz.prompt_caching': event.promptCaching } : {}),
            ...childAttributes(event),
          },
          parentOf(state, event),
        );
        state.spans.set(event.spanId, span);
        if (capture) {
          span.attr(
            'gen_ai.input.messages',
            contentAttribute(toInputMessages(event.capturedMessages)),
          );
        }
        break;
      }

      case 'model.retry': {
        state.spans.get(event.spanId)?.event('deuz.model.retry', {
          'deuz.retry.attempt': event.nextAttempt,
          'deuz.retry.delay_ms': event.delayMs,
          'deuz.retry.reason': event.reason,
          ...(event.statusCode !== undefined
            ? { 'http.response.status_code': event.statusCode }
            : {}),
          ...(event.errorCode !== undefined ? { 'error.type': event.errorCode } : {}),
        });
        break;
      }

      case 'model.completed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attrs({
          'gen_ai.response.model': event.model,
          'gen_ai.response.finish_reasons': [event.finishReason],
          ...usageAttributes(event.usage),
          'deuz.retry.count': event.retryCount,
          'deuz.tool.call.count': event.toolCallCount,
        });
        // semconv: time_to_first_chunk is a double in SECONDS.
        if (event.ttftMs !== undefined) {
          span.attr('gen_ai.response.time_to_first_chunk', event.ttftMs / 1000);
        }
        if (capture) {
          span.attr(
            'gen_ai.output.messages',
            contentAttribute(
              toOutputMessages(
                event.capturedOutputText,
                event.capturedReasoning,
                event.finishReason,
              ),
            ),
          );
        }
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'model.failed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attrs({
          'error.type': event.error.code ?? event.error.name,
          'deuz.error.category': event.error.category,
          'deuz.retry.count': event.retryCount,
        });
        span.error(event.error);
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'tool.started': {
        const span = writer.start(
          `execute_tool ${event.toolName}`,
          'internal',
          {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': event.toolName,
            'gen_ai.tool.call.id': event.toolCallId,
            'gen_ai.tool.type': 'function',
            'deuz.tool.execution_mode': event.executionMode,
            'deuz.tool.needs_approval': event.needsApproval,
            'deuz.tool.parallel': event.parallel,
            ...childAttributes(event),
          },
          parentOf(state, event),
        );
        state.spans.set(event.spanId, span);
        if (capture) {
          span.attr('gen_ai.tool.call.arguments', contentAttribute(event.capturedInput));
        }
        break;
      }

      case 'tool.completed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attrs({ 'deuz.tool.is_error': false, 'deuz.tool.output_type': event.outputType });
        if (capture) span.attr('gen_ai.tool.call.result', contentAttribute(event.capturedOutput));
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'tool.failed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attrs({
          'deuz.tool.is_error': true,
          'deuz.tool.self_healed': event.selfHealed,
          'error.type': event.error.code ?? event.error.name,
        });
        span.error(event.error);
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'tool.denied': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        // A denial is deliberate — is_error WITHOUT an exception (bridge contract).
        span.attrs({ 'deuz.tool.is_error': true, 'deuz.tool.denied_cause': event.cause });
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'subagent.started': {
        const span = writer.start(
          `invoke_agent ${event.agentName}`,
          'internal',
          {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': event.agentName,
            'gen_ai.request.model': event.model,
            'gen_ai.tool.call.id': event.parentToolCallId,
            'deuz.agent.depth': event.depth,
            ...(event.durable ? { 'deuz.durable': true } : {}),
            ...childAttributes(event),
          },
          parentOf(state, event),
        );
        state.spans.set(event.spanId, span);
        break;
      }

      case 'subagent.completed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attrs({ 'deuz.step.count': event.stepCount, ...runUsageAttributes(event.usage) });
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'subagent.suspended': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attrs({
          'deuz.run.status': 'suspended',
          'deuz.approval.pending_count': event.pendingApprovalCount,
        });
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'subagent.failed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attr('error.type', event.error.code ?? event.error.name);
        span.error(event.error);
        span.end();
        state.spans.delete(event.spanId);
        break;
      }

      case 'run.completed': {
        const root = state.root;
        if (root) {
          root.attrs({
            'deuz.run.status': 'completed',
            'deuz.end_reason': event.endReason,
            'deuz.step.count': event.stepCount,
            'deuz.model.call.count': event.modelCallCount,
            'deuz.tool.call.count': event.toolCallCount,
            'deuz.tool.error.count': event.toolErrorCount,
            'deuz.retry.count': event.retryCount,
            // Embedding runs have no child `chat` span — the semconv token
            // attributes belong on this span, and only there.
            ...(state.embeddings ? usageAttributes(event.usage) : runUsageAttributes(event.usage)),
          });
          if (!state.embeddings) {
            root.attr('gen_ai.response.finish_reasons', [event.finishReason]);
          }
          root.attr('deuz.stopped_by', event.stoppedBy);
          root.attr('deuz.cost.usd', event.costUsd);
        }
        settle(state);
        executions.delete(event.executionId);
        break;
      }

      case 'run.aborted': {
        state.root?.attrs({ 'deuz.run.status': 'aborted', ...runUsageAttributes(event.usage) });
        // A user abort is a resolution, not a failure — no exception, no ERROR.
        settle(state);
        executions.delete(event.executionId);
        break;
      }

      case 'run.suspended': {
        state.root?.attrs({
          'deuz.run.status': 'suspended',
          'deuz.suspend.reason': event.reason,
          'deuz.approval.pending_count': event.pendingApprovalCount,
          'deuz.tool.pending_count': event.pendingToolCount,
          ...runUsageAttributes(event.usage),
        });
        settle(state);
        executions.delete(event.executionId);
        break;
      }

      case 'run.failed': {
        const root = state.root;
        if (root) {
          root.attrs({
            'deuz.run.status': 'failed',
            'error.type': event.error.code ?? event.error.name,
            'deuz.error.category': event.error.category,
            'deuz.step.count': event.stepCount,
            'deuz.tool.call.count': event.toolCallCount,
            'deuz.retry.count': event.retryCount,
            ...(event.partialUsage ? runUsageAttributes(event.partialUsage) : {}),
          });
          root.error(event.error);
        }
        settle(state);
        executions.delete(event.executionId);
        break;
      }

      case 'approval.requested':
      case 'approval.resolved': {
        state.root?.event(`deuz.${event.type}`, {
          'gen_ai.tool.name': event.toolName,
          'gen_ai.tool.call.id': event.toolCallId,
          ...(event.type === 'approval.resolved'
            ? { 'deuz.approval.approved': event.approved, 'deuz.approval.source': event.source }
            : { 'deuz.approval.mode': event.mode }),
        });
        break;
      }

      case 'checkpoint.saved':
      case 'checkpoint.loaded': {
        state.root?.event(`deuz.${event.type}`, {
          'deuz.checkpoint.step_id': event.stepId,
          'deuz.checkpoint.step_index': event.checkpointStepIndex,
          'deuz.message.count': event.messageCount,
        });
        break;
      }

      case 'checkpoint.failed': {
        state.root?.event('deuz.checkpoint.failed', {
          'deuz.checkpoint.operation': event.operation,
          'error.type': event.error.code ?? event.error.name,
          'deuz.run.continued': event.runContinued,
        });
        break;
      }

      case 'compaction': {
        state.root?.event('deuz.compaction', {
          'deuz.compaction.layer': event.layer,
          'deuz.compaction.tokens_before': event.tokensBefore,
          'deuz.compaction.tokens_after': event.tokensAfter,
          'deuz.message.count': event.messageCountAfter,
        });
        break;
      }

      case 'compaction.skipped': {
        state.root?.event('deuz.compaction.skipped', { 'deuz.compaction.layer': event.layer });
        break;
      }

      case 'operation.started': {
        // Auxiliary subsystems (image, midjourney, …) run without a `run.*`
        // lifecycle; no semconv operation covers them, so stay namespaced.
        const span = writer.start(
          event.operation,
          'internal',
          {
            'deuz.subsystem': event.subsystem,
            'deuz.operation': event.operation,
            ...(event.itemCount !== undefined ? { 'deuz.item.count': event.itemCount } : {}),
            ...childAttributes(event),
          },
          parentOf(state, event),
        );
        state.spans.set(event.spanId, span);
        break;
      }

      case 'operation.completed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attr('deuz.result.count', event.resultCount);
        if (event.usage) span.attrs(runUsageAttributes(event.usage));
        span.end();
        state.spans.delete(event.spanId);
        executions.delete(event.executionId);
        break;
      }

      case 'operation.failed': {
        const span = state.spans.get(event.spanId);
        if (!span) break;
        span.attr('error.type', event.error.code ?? event.error.name);
        span.error(event.error);
        span.end();
        state.spans.delete(event.spanId);
        executions.delete(event.executionId);
        break;
      }

      default:
        // model.first-content (ttft lands on model.completed), step.* (no
        // semconv operation — `deuz.step.index` on each child instead).
        break;
    }
  };

  const observer: Observer = {
    ...(capture ? { options: CAPTURE_ALL } : {}),
    emit(event) {
      try {
        emit(event);
      } catch {
        // An adapter bug must never affect the run (G2) — the runtime also
        // guards, but losing one span beats losing the rest of the leg.
      }
    },
    /** Awaits peer readiness; rejects with the install error when it is missing. */
    flush() {
      return otelReady(observer);
    },
  };
  return attachReady(observer, writer.ready);
}

/**
 * `naming: 'deuz'` — drive the legacy tracer bridge instead of duplicating its
 * shape, so span names/attributes are byte-for-byte today's. The bridge holds
 * per-run state and `deps.observer` is shared across concurrent runs, so one
 * bridge is created PER EXECUTION LEG and dropped at its terminal event.
 */
function createBridgeObserver(options: OtelTracerOptions): Observer {
  const tracer = createOtelTracer({ ...options, naming: 'deuz' });
  const bridges = new Map<string, Observer>();

  const observer: Observer = {
    emit(event) {
      try {
        let bridge = bridges.get(event.executionId);
        if (!bridge) {
          if (bridges.size >= MAX_TRACKED_EXECUTIONS) {
            // Pathological only (that many legs with no terminal event). The
            // bridge exposes no settle hook, so eviction just drops its state.
            const oldest = bridges.keys().next().value;
            if (oldest !== undefined) bridges.delete(oldest);
          }
          bridge = createTracerBridge(tracer, 'hierarchical');
          bridges.set(event.executionId, bridge);
        }
        bridge.emit(event);
        if (TERMINAL_TYPES.has(event.type)) bridges.delete(event.executionId);
      } catch {
        // never affect the run (G2)
      }
    },
    flush() {
      return otelReady(observer);
    },
  };
  // The bridge writes through `tracer`, so its readiness IS this observer's.
  return attachReady(observer, otelReady(tracer));
}
