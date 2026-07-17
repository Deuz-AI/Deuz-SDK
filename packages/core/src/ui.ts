/**
 * Deuz-native UI streaming wire. `@deuz-sdk/core` is its OWN AI SDK — this protocol
 * is ours, not a copy of any other SDK's. The server serializes the canonical
 * `fullStream` to SSE (`x-deuz-stream: <version>`); the client reads it back —
 * directly via `readDeuzStream`/`connectDeuzStream`, or through the
 * `useChat`/`useObject` hooks.
 *
 * Wire v2 (1.7) is ADDITIVE over v1: every event additionally carries an SSE
 * `id: <seq>` line (a monotonic per-stream sequence), which makes the stream
 * resumable (`Last-Event-ID` → `resumeDeuzStreamResponse`) and lets any number
 * of clients follow the same stream live through a {@link StreamStateStore}.
 * v1 clients keep working: `id:` lines are invisible to them and unknown part
 * types are skipped (open-union rule). Serializers emit v1 byte-identically
 * when negotiated via {@link negotiateDeuzStreamVersion} / `wireVersion`.
 */
import type { StreamChatResult, StreamObjectResult } from './types/methods';
import type { StreamPart, ToolRunState } from './types/stream';
import type { Usage, FinishReason } from './types/usage';
import type { Clock } from './types/deps';
import type { StandardSchemaV1 } from './types/schema';
import { parseSSE } from './internal/sse';
import { redactString } from './internal/redact';
import { resolveDependencies } from './internal/resolve-deps';
import { DEFAULT_RETRY, backoffMs, unitFromId } from './core/resilience';

/** The version this SDK emits by default. */
export const DEUZ_STREAM_VERSION = 'v2';
/** Every version this SDK can emit (negotiable per response). */
export const DEUZ_STREAM_VERSIONS = ['v1', 'v2'] as const;
export type DeuzWireVersion = (typeof DEUZ_STREAM_VERSIONS)[number];

/**
 * Pick the wire version for a response from the client's request. Clients ask
 * via an `x-deuz-stream` request header; only an explicit `v1` downgrades —
 * anything else (including no header: v1 clients never sent one, and v2's
 * additions are invisible to them) gets the current version.
 */
export function negotiateDeuzStreamVersion(
  source?: Request | Headers | string | null,
): DeuzWireVersion {
  const raw =
    typeof source === 'string' || source == null
      ? source
      : (source instanceof Headers ? source : source.headers).get('x-deuz-stream');
  return raw?.trim().toLowerCase() === 'v1' ? 'v1' : 'v2';
}

/** A part of the Deuz UI stream (mirrors the canonical stream, UI-framed). */
export type DeuzUIPart =
  | { type: 'start'; messageId: string }
  | { type: 'step-start'; step: number }
  | { type: 'step-finish'; step: number; finishReason: FinishReason; usage: Usage }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string; signature?: string }
  | { type: 'tool-input-delta'; toolCallId: string; toolName?: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    }
  | { type: 'source'; id: string; url?: string; title?: string }
  | {
      type: 'tool-approval-request';
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  /**
   * Client→server direction only (declared for wire symmetry): the verdict
   * travels in the next HTTP request's body as `approvalResponses` — it is
   * never serialized by `toDeuzStreamResponse`. `useChat` consumes it.
   */
  | { type: 'tool-approval-response'; approvalId: string; approved: boolean; reason?: string }
  /** `streamObject` partial — each delta REPLACES the previous partial wholesale. */
  | { type: 'object-delta'; object: unknown }
  /** Automatic compaction ran before a step (token counts are estimates). */
  | { type: 'compaction'; layer: string; tokensBefore: number; tokensAfter: number }
  /** A sub-agent (`agentTool`) part, forwarded live with its path. */
  | { type: 'sub-agent'; agentPath: string[]; part: DeuzUIPart }
  /** App-defined typed data (v2 wire): `writeData('chart', …)` → `data-chart`. */
  | { type: `data-${string}`; payload: unknown }
  /** RAG citation (v2 wire): provenance for a retrieved chunk. */
  | {
      type: 'citation';
      id: string;
      sourceId?: string;
      url?: string;
      title?: string;
      snippet?: string;
      chunkIndex?: number;
      score?: number;
    }
  /** Tool lifecycle transition (v2 wire): render live tool status directly. */
  | { type: 'tool-state'; toolCallId: string; toolName?: string; state: ToolRunState }
  /** Live cumulative USD cost (v2 wire) — feed a CostBadge directly. */
  | {
      type: 'cost';
      costUsd: number;
      deltaUsd?: number;
      cacheSavingsUsd?: number;
      stepIndex?: number;
    }
  /** Budget guardrail tripped (v2 wire) — precedes the terminal finish. */
  | { type: 'budget-exceeded'; kind: 'usd' | 'tokens'; limit: number; value: number }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage }
  | { type: 'error'; message: string };

// ===================================================================
// StreamStateStore — the resumability seam (wire v2)
// ===================================================================

/**
 * Terminal sentinel stored (never serialized as a data line) when a response
 * finished its source: replay knows to emit `[DONE]` and stop tailing. A
 * record log WITHOUT it means the producer is still live (or died mid-run —
 * see `resumeStreamFromCheckpoint` for continuing the run itself).
 */
export interface DeuzStreamDoneRecord {
  type: 'done';
}

export interface StreamStateRecord {
  seq: number;
  part: DeuzUIPart | DeuzStreamDoneRecord;
}

/**
 * Two-method persistence seam for resumable streams (the `SessionStore`
 * pattern: pass it explicitly where you serialize). `append` is called once
 * per emitted event with a monotonic `seq`; `read` returns what exists NOW
 * with `seq > fromSeq`, in order — live tailing is the caller's poll loop, so
 * a plain KV/table adapter stays trivial. Failures must not kill the response:
 * the serializer catches and reports via `onStoreError`.
 */
export interface StreamStateStore {
  append(streamId: string, seq: number, part: StreamStateRecord['part']): void | Promise<void>;
  read(streamId: string, fromSeq?: number): AsyncIterable<StreamStateRecord>;
  /** Optional fast path for seq continuation; absent → the serializer scans `read`. */
  lastSeq?(streamId: string): number | undefined | Promise<number | undefined>;
  /** Optional cleanup (TTL/eviction tooling — the serializers never call it). */
  delete?(streamId: string): void | Promise<void>;
}

export interface InMemoryStreamStateStoreOptions {
  /**
   * Evict the least-recently-appended stream once more than this many are
   * held (default: unlimited). Long-lived servers should set this (or use a
   * TTL-capable adapter — Redis `EXPIRE`, a Supabase cron) because records
   * are retained forever otherwise.
   */
  maxStreams?: number;
}

/** In-memory reference store (single runtime). Redis/Supabase adapters: see docs. */
export function createInMemoryStreamStateStore(
  options: InMemoryStreamStateStoreOptions = {},
): Required<StreamStateStore> {
  const maxStreams = options.maxStreams ?? Infinity;
  const streams = new Map<string, StreamStateRecord[]>();
  return {
    append(streamId, seq, part) {
      let records = streams.get(streamId);
      if (!records) {
        records = [];
      } else {
        streams.delete(streamId); // re-insert to refresh recency (Map order)
      }
      records.push({ seq, part });
      streams.set(streamId, records);
      while (streams.size > maxStreams) {
        const oldest = streams.keys().next().value;
        if (oldest === undefined) break;
        streams.delete(oldest);
      }
    },
    async *read(streamId, fromSeq = -1) {
      const records = streams.get(streamId) ?? [];
      // Snapshot slice — appends during iteration belong to the next poll.
      for (const record of [...records]) {
        if (record.seq > fromSeq) yield record;
      }
    },
    lastSeq(streamId) {
      return streams.get(streamId)?.at(-1)?.seq;
    },
    delete(streamId) {
      streams.delete(streamId);
    },
  };
}

/**
 * Ordered, best-effort append pipeline: never blocks or kills the stream.
 * Pending appends are bounded by the response length; a store.append that
 * never settles stalls only the final flush (`settled()`), never the wire.
 * Adapters should put their own timeout on writes.
 */
function createStoreWriter(
  store: StreamStateStore,
  streamId: string,
  onError?: (error: unknown) => void,
): { append(seq: number, part: StreamStateRecord['part']): void; settled(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(seq, part) {
      chain = chain
        .then(() => store.append(streamId, seq, part))
        .catch((error) => {
          try {
            onError?.(error);
          } catch {
            /* observer errors must not break the pipeline */
          }
        });
    },
    settled: () => chain,
  };
}

async function lastStoredSeq(store: StreamStateStore, streamId: string): Promise<number> {
  if (store.lastSeq) {
    const last = await store.lastSeq(streamId);
    return last ?? -1;
  }
  let last = -1;
  for await (const record of store.read(streamId)) last = record.seq;
  return last;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message);
  return redactString(typeof error === 'string' ? error : 'Stream error.');
}

/** Map a canonical StreamPart → a Deuz UI part (undefined = drop). */
function toUIPart(part: StreamPart): DeuzUIPart | undefined {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', text: part.text };
    case 'reasoning-delta':
      return {
        type: 'reasoning-delta',
        text: part.text,
        ...(part.signature ? { signature: part.signature } : {}),
      };
    case 'tool-call-delta':
      return {
        type: 'tool-input-delta',
        toolCallId: part.id,
        ...(part.name ? { toolName: part.name } : {}),
        delta: part.argsTextDelta,
      };
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
        ...(part.isError ? { isError: true } : {}),
      };
    case 'source':
      return {
        type: 'source',
        id: part.id,
        ...(part.url ? { url: part.url } : {}),
        ...(part.title ? { title: part.title } : {}),
      };
    case 'tool-approval-request':
      // Explicit case required — the default drops unknown canonical parts.
      return {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case 'compaction':
      // Explicit case required — the default drops unknown canonical parts.
      return {
        type: 'compaction',
        layer: part.layer,
        tokensBefore: part.tokensBefore,
        tokensAfter: part.tokensAfter,
      };
    case 'sub-agent': {
      // Recursively frame the inner part; drop the wrapper if the inner drops.
      const inner = toUIPart(part.part);
      return inner ? { type: 'sub-agent', agentPath: part.agentPath, part: inner } : undefined;
    }
    case 'step-start':
      return { type: 'step-start', step: part.stepIndex };
    case 'step-finish':
      return {
        type: 'step-finish',
        step: part.stepIndex,
        finishReason: part.finishReason,
        usage: part.usage,
      };
    case 'data':
      // Vercel-style DX on the wire: the part name rides the type itself.
      return { type: `data-${part.name}`, payload: part.payload };
    case 'citation':
      return {
        type: 'citation',
        id: part.id,
        ...(part.sourceId ? { sourceId: part.sourceId } : {}),
        ...(part.url ? { url: part.url } : {}),
        ...(part.title ? { title: part.title } : {}),
        ...(part.snippet ? { snippet: part.snippet } : {}),
        ...(part.chunkIndex !== undefined ? { chunkIndex: part.chunkIndex } : {}),
        ...(part.score !== undefined ? { score: part.score } : {}),
      };
    case 'tool-state':
      return {
        type: 'tool-state',
        toolCallId: part.toolCallId,
        ...(part.toolName ? { toolName: part.toolName } : {}),
        state: part.state,
      };
    case 'cost':
      return {
        type: 'cost',
        costUsd: part.costUsd,
        ...(part.deltaUsd !== undefined ? { deltaUsd: part.deltaUsd } : {}),
        ...(part.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: part.cacheSavingsUsd } : {}),
        ...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
      };
    case 'budget-exceeded':
      return {
        type: 'budget-exceeded',
        kind: part.kind,
        limit: part.limit,
        value: part.value,
      };
    case 'finish':
      return { type: 'finish', finishReason: part.finishReason, usage: part.usage };
    case 'error':
      return { type: 'error', message: errorMessage(part.error) };
    default:
      return undefined;
  }
}

/** Part types that exist only on wire v2 — never serialized to a negotiated-v1 client. */
function isV2OnlyPart(type: string): boolean {
  return (
    type === 'citation' ||
    type === 'tool-state' ||
    type === 'cost' ||
    type === 'budget-exceeded' ||
    type.startsWith('data-')
  );
}

export interface ToDeuzStreamOptions {
  messageId?: string;
  /** Source for the message id (e.g. deps.generateId). */
  generateId?: () => string;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /**
   * Wire version to emit (default 'v2'). Pass
   * `negotiateDeuzStreamVersion(request)` to honor an explicit v1 client.
   * v1 output is byte-identical to pre-1.7 releases.
   */
  wireVersion?: DeuzWireVersion;
  /**
   * Resumability: every emitted event is appended here under `streamId` with
   * its seq. If the store already holds records for `streamId` (a continued
   * run), numbering continues after the last stored seq and the synthetic
   * `start` part is NOT re-emitted.
   */
  store?: StreamStateStore;
  /** Stream identity in `store`. Required when `store` is set. */
  streamId?: string;
  /** Store append failures land here (default: silently dropped — best-effort). */
  onStoreError?: (error: unknown) => void;
}

/** The shared SSE shell of both serializers. */
function deuzSSEResponse(
  label: string,
  options: ToDeuzStreamOptions,
  produce: (send: (part: DeuzUIPart) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const version: DeuzWireVersion = options.wireVersion ?? 'v2';
  const store = options.store;
  const streamId = options.streamId;
  if (store && !streamId) {
    throw new Error(`${label}: \`streamId\` is required when \`store\` is set.`);
  }
  const writer =
    store && streamId ? createStoreWriter(store, streamId, options.onStoreError) : undefined;

  // The client can vanish mid-stream (refresh, tab close, network drop) — the
  // response body dies, but the STORE must keep recording: resumability exists
  // precisely for that moment. Enqueue failures flip this flag and the produce
  // loop keeps draining the source into the store.
  let clientGone = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string): void => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          clientGone = true;
        }
      };
      let seq = 0;
      let resumed = false;
      if (store && streamId) {
        try {
          const last = await lastStoredSeq(store, streamId);
          if (last >= 0) {
            seq = last + 1;
            resumed = true;
          }
        } catch (error) {
          // A store outage must not kill the live response (the appends will
          // route their own failures to onStoreError too).
          try {
            options.onStoreError?.(error);
          } catch {
            /* observer errors are not ours to raise */
          }
        }
      }
      const send = (part: DeuzUIPart): void => {
        // v2-only parts are dropped entirely for a negotiated-v1 client (the
        // store must mirror the wire seq-for-seq, so they skip both).
        if (version === 'v1' && isV2OnlyPart(part.type)) return;
        // Store BEFORE wire: a part in flight during a disconnect must still
        // land in the log even though its enqueue never happens.
        writer?.append(seq, part);
        enqueue(`${version === 'v2' ? `id: ${seq}\n` : ''}data: ${JSON.stringify(part)}\n\n`);
        seq++;
      };
      if (!resumed) {
        const messageId = options.messageId ?? options.generateId?.() ?? 'deuz-msg';
        send({ type: 'start', messageId });
      }
      await produce(send);
      // Leg-end sentinel: appended for EVERY ended leg (complete, errored, or
      // suspended-for-approval). Replay treats it as terminal only when
      // nothing was appended after it, so a continued run stays reachable.
      writer?.append(seq, { type: 'done' });
      enqueue(`${version === 'v2' ? `id: ${seq}\n` : ''}data: [DONE]\n\n`);
      // Flush pending appends before closing so replay never misses the tail
      // (matters on serverless runtimes that freeze after the response ends).
      if (writer) await writer.settled();
      if (!clientGone) {
        try {
          controller.close();
        } catch {
          /* cancelled between the last enqueue and here */
        }
      }
    },
    cancel() {
      clientGone = true;
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-deuz-stream': version,
      ...options.headers,
    },
  });
}

/** Serialize a `StreamChatResult` to a Deuz-protocol SSE `Response`. Edge-safe. */
export function toDeuzStreamResponse(
  result: StreamChatResult,
  options: ToDeuzStreamOptions = {},
): Response {
  return deuzSSEResponse('toDeuzStreamResponse', options, async (send) => {
    try {
      for await (const part of result.fullStream) {
        const ui = toUIPart(part);
        if (ui) send(ui);
      }
    } catch (err) {
      send({ type: 'error', message: errorMessage(err) });
    }
  });
}

/**
 * Serialize a `streamObject` result to a Deuz-protocol SSE `Response`
 * (`object-delta` parts; `useObject` reads it back). Edge-safe. Failures —
 * transport errors AND final-validation rejection — surface as a redacted
 * `error` part; `usage`/`finishReason` ride the terminal `finish` part on
 * success.
 */
export function toDeuzObjectStreamResponse(
  result: StreamObjectResult<unknown>,
  options: ToDeuzStreamOptions = {},
): Response {
  return deuzSSEResponse('toDeuzObjectStreamResponse', options, async (send) => {
    try {
      for await (const partial of result.partialObjectStream) {
        send({ type: 'object-delta', object: partial });
      }
      send({
        type: 'finish',
        finishReason: await result.finishReason,
        usage: await result.usage,
      });
    } catch (err) {
      send({ type: 'error', message: errorMessage(err) });
    }
  });
}

// ===================================================================
// createDeuzStream — model stream + app data parts on one wire (v2)
// ===================================================================

export interface CreateDeuzStreamOptions extends ToDeuzStreamOptions {
  /**
   * Opt-in streaming validation: a Standard Schema per data-part name.
   * `writeData('chart', payload)` validates against `dataSchemas.chart`
   * BEFORE serialization — an invalid payload is dropped and a redacted
   * `error` part is emitted instead (the stream itself keeps going).
   */
  dataSchemas?: Record<string, StandardSchemaV1>;
}

export interface DeuzStreamWriter {
  response: Response;
  /**
   * Queue a typed `data-{name}` part into the live stream. Safe to call from
   * anywhere while the model stream runs (tool `execute`, RAG pipeline, …);
   * writes after the stream ended are dropped.
   */
  writeData(name: string, payload: unknown): void;
  /** End the data channel early (it auto-closes when the model stream completes). */
  close(): void;
}

/**
 * Like `toDeuzStreamResponse`, but returns a writer so the server can inject
 * typed `data-{name}` parts (chart payloads, RAG citations, progress markers)
 * into the SAME SSE response the model streams over — ordered, seq-numbered,
 * journaled to the `store`, and replayable like every other part.
 */
export function createDeuzStream(
  result: StreamChatResult,
  options: CreateDeuzStreamOptions = {},
): DeuzStreamWriter {
  interface DataItem {
    name: string;
    payload: unknown;
  }
  const queue: DataItem[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  const wake = (): void => {
    const n = notify;
    notify = undefined;
    n?.();
  };

  const response = deuzSSEResponse('createDeuzStream', options, async (send) => {
    const sendData = async (item: DataItem): Promise<void> => {
      const schema = options.dataSchemas?.[item.name];
      if (schema) {
        try {
          const checked = await schema['~standard'].validate(item.payload);
          if (checked.issues) {
            send({ type: 'error', message: `data part '${item.name}' failed validation.` });
            return;
          }
          send({ type: `data-${item.name}`, payload: checked.value });
          return;
        } catch {
          send({ type: 'error', message: `data part '${item.name}' failed validation.` });
          return;
        }
      }
      send({ type: `data-${item.name}`, payload: item.payload });
    };

    const model = (async () => {
      try {
        for await (const part of result.fullStream) {
          const ui = toUIPart(part);
          if (ui) send(ui);
        }
      } catch (err) {
        send({ type: 'error', message: errorMessage(err) });
      }
    })();
    const data = (async () => {
      for (;;) {
        while (queue.length > 0) await sendData(queue.shift()!);
        if (closed) return;
        await new Promise<void>((resolve) => (notify = resolve));
      }
    })();
    await model;
    closed = true; // model stream ended — drain what's queued, then stop
    wake();
    await data;
  });

  return {
    response,
    writeData(name, payload) {
      if (closed) return;
      queue.push({ name, payload });
      wake();
    },
    close() {
      closed = true;
      wake();
    },
  };
}

// ===================================================================
// Resume (server) + reconnect (client) — wire v2
// ===================================================================

/** Minimal timer seam (edge-safe; `Clock.setTimeout`-compatible). */
type TimerLike = Pick<Clock, 'setTimeout'>;

const defaultTimer: TimerLike = {
  setTimeout: (fn, ms) => {
    const id = globalThis.setTimeout(fn, ms);
    return () => globalThis.clearTimeout(id);
  },
};

function sleep(timer: TimerLike, ms: number): Promise<void> {
  return new Promise((resolve) => timer.setTimeout(resolve, ms));
}

/**
 * Strict resume-cursor parse: only a plain non-negative integer counts.
 * Empty/whitespace strings and garbage are "no cursor" — NOT seq 0
 * (`Number('') === 0` would silently skip the start part).
 */
function parseSeq(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (value == null) return undefined;
  const raw = value.trim();
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export interface ResumeDeuzStreamOptions {
  /**
   * The client's `Last-Event-ID` (string form accepted verbatim from the
   * header). Replay starts AFTER it; omit/null to replay from the beginning.
   */
  lastEventId?: string | number | null;
  wireVersion?: DeuzWireVersion;
  headers?: Record<string, string>;
  /** Poll cadence while tailing a still-live stream (ms, default 250). */
  pollIntervalMs?: number;
  /**
   * Give up after this long with NO new records and NO terminal sentinel
   * (ms, default 30000). The response closes without `[DONE]`, so a
   * reconnecting client treats it as another drop and may retry.
   */
  idleTimeoutMs?: number;
  /** Timer seam for polling (deterministic tests). Default: global setTimeout. */
  clock?: TimerLike;
}

/**
 * Replay a stored stream from `Last-Event-ID` and keep tailing it live until
 * its terminal sentinel — any number of clients can follow the same stream.
 * This serves BOTH the refresh/reconnect case and the "second tab watches
 * along" case. Route shape: a GET endpoint keyed by your streamId that ends in
 * `return resumeDeuzStreamResponse(store, streamId, { lastEventId:
 * request.headers.get('last-event-id') })`.
 */
export function resumeDeuzStreamResponse(
  store: StreamStateStore,
  streamId: string,
  options: ResumeDeuzStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const version: DeuzWireVersion = options.wireVersion ?? 'v2';
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
  const idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 30_000);
  const timer = options.clock ?? defaultTimer;
  const fromSeq = parseSeq(options.lastEventId) ?? -1;

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string): void => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cancelled = true;
        }
      };
      const finish = (): void => {
        if (cancelled) return;
        try {
          controller.close();
        } catch {
          /* cancelled concurrently */
        }
      };
      const emitPart = (record: StreamStateRecord): void => {
        enqueue(
          `${version === 'v2' ? `id: ${record.seq}\n` : ''}data: ${JSON.stringify(record.part)}\n\n`,
        );
      };
      const emitDone = (seq: number): void => {
        enqueue(`${version === 'v2' ? `id: ${seq}\n` : ''}data: [DONE]\n\n`);
      };

      try {
        let cursor = fromSeq;
        // Caught-up fast path: the client's cursor is at/past the log tail and
        // the tail IS the sentinel → immediate [DONE] instead of an idle hang.
        const last = await lastStoredSeq(store, streamId);
        if (last >= 0 && cursor >= last) {
          let tailIsDone = false;
          for await (const record of store.read(streamId, last - 1)) {
            if (record.seq === last && record.part.type === 'done') tailIsDone = true;
          }
          if (tailIsDone) {
            emitDone(Math.max(cursor, last));
            finish();
            return;
          }
        }
        // A `done` record is terminal only when NOTHING follows it — continued
        // runs (durable resume, approval legs) append past their previous
        // leg's sentinel, and replay must sail through those boundaries.
        let pendingDone: number | undefined;
        let idleMs = 0;
        for (;;) {
          if (cancelled) break;
          let progressed = false;
          for await (const record of store.read(streamId, cursor)) {
            if (cancelled) break;
            cursor = record.seq;
            progressed = true;
            if (record.part.type === 'done') {
              pendingDone = record.seq;
            } else {
              pendingDone = undefined; // a newer leg followed — that sentinel was a boundary
              emitPart(record);
            }
          }
          if (cancelled) break;
          if (progressed) {
            idleMs = 0;
            continue; // drain immediately — more may have landed meanwhile
          }
          if (pendingDone !== undefined) {
            emitDone(pendingDone); // sentinel with nothing after it → complete
            break;
          }
          if (idleMs >= idleTimeoutMs) break;
          await sleep(timer, pollIntervalMs);
          idleMs += pollIntervalMs;
        }
      } catch (error) {
        // A store failure must not hang the client: surface a redacted error
        // part and close WITHOUT [DONE] (reads as a drop → clients may retry).
        enqueue(`data: ${JSON.stringify({ type: 'error', message: errorMessage(error) })}\n\n`);
      }
      finish();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-deuz-stream': version,
      ...options.headers,
    },
  });
}

/** Client-side reader: a Deuz-protocol SSE `Response` → `DeuzUIPart` async-iterable. */
export async function* readDeuzStream(response: Response): AsyncGenerator<DeuzUIPart> {
  if (!response.body) return;
  for await (const ev of parseSSE(response.body)) {
    if (ev.data === '[DONE]') return;
    try {
      yield JSON.parse(ev.data) as DeuzUIPart;
    } catch {
      /* skip malformed line */
    }
  }
}

/** How `connectDeuzStream` obtains each connection (initial and reconnects). */
export type DeuzStreamSource =
  | string
  | URL
  | ((ctx: { lastEventId?: string }) => Response | Promise<Response>);

export interface ConnectDeuzStreamOptions {
  /** Transport for string/URL sources. Default: global fetch. */
  fetch?: typeof fetch;
  /** Extra request headers for string/URL sources. */
  headers?: Record<string, string>;
  /** Resume cursor to start from (e.g. persisted across a page refresh). */
  lastEventId?: string;
  /**
   * Reconnect budget after a drop (default 5). The counter resets whenever an
   * event actually arrives, so a long stream with several rough patches is
   * fine — only consecutive dead reconnects exhaust it.
   */
  maxReconnects?: number;
  /** Abort both the current connection and the reconnect loop. */
  signal?: AbortSignal;
  /** Timer seam for backoff (deterministic tests). Default: global setTimeout. */
  clock?: TimerLike;
  /**
   * Fired whenever the resume cursor advances (a part was fully delivered).
   * Persist the value (e.g. sessionStorage) and pass it back as `lastEventId`
   * to survive a full page reload — reconnects within one call already resume
   * automatically.
   */
  onCursor?: (lastEventId: string) => void;
  /**
   * Randomness source for reconnect jitter — a FRESH draw per retry, so a
   * fleet of clients dropped at the same seq does not reconnect in lockstep.
   * Default: the SDK's crypto-random id (deterministic tests inject their own).
   */
  generateId?: () => string;
}

/**
 * Fault-tolerant client reader (wire v2): reads a Deuz stream and, when the
 * connection drops before `[DONE]`, reconnects with the `Last-Event-ID`
 * header and deduplicates by seq — the consumer sees one gapless part
 * sequence. Point it at a resume endpoint (see `resumeDeuzStreamResponse`);
 * do NOT point it at the generating POST route, which would re-run the model.
 */
export async function* connectDeuzStream(
  source: DeuzStreamSource,
  options: ConnectDeuzStreamOptions = {},
): AsyncGenerator<DeuzUIPart> {
  const maxReconnects = options.maxReconnects ?? 5;
  const timer = options.clock ?? defaultTimer;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let lastEventId = options.lastEventId;
  let attempt = 0;

  const connect = (): Response | Promise<Response> => {
    if (typeof source === 'function') {
      return source({ ...(lastEventId !== undefined ? { lastEventId } : {}) });
    }
    return doFetch(source, {
      headers: {
        ...options.headers,
        ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  const generateId = options.generateId ?? resolveDependencies({}).generateId;

  for (;;) {
    let delivered = false;
    let sawId = false;
    try {
      const response = await connect();
      if (!response.ok || !response.body) {
        throw new Error(`Deuz stream connection failed (status ${response.status}).`);
      }
      // Fixed per-connection cursor: everything at or below it was already
      // delivered before the drop and gets deduplicated on replay.
      const resumeCursor = parseSeq(lastEventId) ?? Number.NaN;
      for await (const ev of parseSSE(response.body)) {
        if (options.signal?.aborted) return;
        delivered = true;
        if (ev.id !== undefined) sawId = true;
        if (ev.data === '[DONE]') return;
        let part: DeuzUIPart;
        try {
          part = JSON.parse(ev.data) as DeuzUIPart;
        } catch {
          // Malformed/truncated frame (e.g. a clean EOF mid-frame). Do NOT
          // advance the cursor past it — the reconnect must replay this seq.
          continue;
        }
        if (ev.id !== undefined) {
          const seq = Number(ev.id);
          if (!Number.isNaN(seq) && !Number.isNaN(resumeCursor) && seq <= resumeCursor) {
            continue; // replayed duplicate
          }
          // Commit the cursor only for a fully-delivered part.
          lastEventId = ev.id;
          attempt = 0; // real progress — reset the reconnect budget
          try {
            options.onCursor?.(ev.id);
          } catch {
            /* consumer callback errors are not transport errors */
          }
        }
        yield part;
      }
      // Source ended without [DONE] — treat as a drop and fall through to retry.
      throw new Error('Deuz stream ended before [DONE].');
    } catch (err) {
      if (options.signal?.aborted) return;
      if (delivered && !sawId) {
        // An id-less (wire v1) server cannot be resumed — a blind reconnect
        // would replay from the start and DUPLICATE every delivered part.
        // Silent duplication is worse than a hard failure.
        throw new Error(
          'Deuz stream carries no event ids (wire v1) — reconnecting would duplicate parts. ' +
            'Serve wire v2 from the resume endpoint.',
        );
      }
      if (attempt >= maxReconnects) throw err;
      const random = (): number => unitFromId(generateId());
      await sleep(timer, backoffMs(attempt, undefined, random, DEFAULT_RETRY));
      attempt++;
    }
  }
}
