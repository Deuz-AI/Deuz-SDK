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
 * types are skipped (open-union rule). A response negotiated to v1 (via
 * {@link negotiateDeuzStreamVersion} / `wireVersion`) carries no `id:` lines
 * and no v2-only part. It is not byte-identical to pre-1.7 output: later
 * releases added optional fields to v1 parts, which an older client ignores:
 * the approval `token` (1.7) and, in 2.3, the `text-delta` and `tool-call`
 * `providerMetadata`, the `reasoning-delta` block fields, `tool-result.outcome`
 * and the `stopDetails` of `step-finish` and `finish`. 2.3's additions to
 * v2-only parts stay on v2: `tool-state.outcome`, the `'unpriced-model'`
 * warning and the `data-agent` frames of a native run.
 */
import type {
  CallWarning,
  StopDetails,
  StreamChatResult,
  StreamObjectResult,
} from './types/methods';
import type { StreamPart, ToolRunState } from './types/stream';
import type { Usage, FinishReason } from './types/usage';
import type { Clock } from './types/deps';
import type { StandardSchemaV1 } from './types/schema';
import type { ToolApprovalRequest, ToolCallOutcome } from './types/tool';
import type {
  AgentEvent,
  AgentPartialOutput,
  AgentResult,
  AgentStream,
  AgentVerification,
} from './types/agent-run';
import { parseSSE } from './internal/sse';
import { redactString } from './internal/redact';
import { resolveDependencies } from './internal/resolve-deps';
import { DEFAULT_RETRY, backoffMs, unitFromId } from './core/resilience';
import { agentFrameOf, applyAgentFrame, idleAgentState } from './internal/agent-ui';
import { stopDetailsFrom } from './internal/stop-details';

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
  /** `stopDetails` (2.3 additive): as on `finish`, for this step. */
  | {
      type: 'step-finish';
      step: number;
      finishReason: FinishReason;
      usage: Usage;
      stopDetails?: StopDetails;
    }
  /**
   * A chunk of assistant text. `providerMetadata` (2.3 additive) is the text's
   * provider round-trip data, such as a Gemini thought signature on a plain text
   * part (often on a final chunk whose `text` is empty), so a chat client sends
   * the text back as the provider produced it (`applyUIPart` keeps it on the UI
   * text part). Never display it. It rides every wire version.
   */
  | { type: 'text-delta'; text: string; providerMetadata?: Record<string, unknown> }
  /**
   * A reasoning delta. 2.3 adds optional fields so a chat client can send
   * every block back unchanged: the canonical part's `id` (deltas of one block
   * share it), `encrypted` / `redacted` (the block is an opaque provider
   * payload, never display text) and `source` (the provider family that
   * produced it), plus `data`. They ride every wire version.
   *
   * An opaque block's payload rides `data`, and its `text` is empty. A client
   * that predates these fields (a 2.2 `@deuz-sdk/react`, the frozen
   * `@deuz-sdk/core/react` hook, a custom reader) ignores them and appends
   * `text` to the reasoning it shows, so it shows nothing for the block instead
   * of the payload. `applyUIPart` reads the payload back from `data`.
   */
  | {
      type: 'reasoning-delta';
      text: string;
      signature?: string;
      id?: string;
      encrypted?: boolean;
      redacted?: boolean;
      source?: string;
      /** The payload of an `encrypted` or `redacted` block (2.3); `text` is then empty. */
      data?: string;
    }
  | { type: 'tool-input-delta'; toolCallId: string; toolName?: string; delta: string }
  /**
   * A fully parsed tool call. `providerMetadata` (2.3 additive) is the call's
   * provider round-trip data, such as a Gemini function call's thought
   * signature, so a chat client sends the `tool_use` back as the provider
   * produced it (`applyUIPart` keeps it on the UI call). Never display it.
   */
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerMetadata?: Record<string, unknown>;
    }
  /**
   * A tool finished. `outcome` (2.3 additive) says how an error result ended
   * (`ToolCallOutcome`: a thrown tool, a policy or approval denial, …); a
   * successful result carries none. It rides every wire version.
   */
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
      outcome?: ToolCallOutcome;
    }
  | { type: 'source'; id: string; url?: string; title?: string }
  | {
      type: 'tool-approval-request';
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** HMAC-signed approval token (D4) — echo it back on the verdict. */
      token?: string;
    }
  /**
   * Client→server direction only (declared for wire symmetry): the verdict
   * travels in the next HTTP request's body as `approvalResponses` — it is
   * never serialized by `toDeuzStreamResponse`. `useChat` consumes it.
   */
  | {
      type: 'tool-approval-response';
      approvalId: string;
      approved: boolean;
      reason?: string;
      /** The request's signed token, echoed back (required to APPROVE under `approvalSigner`). */
      token?: string;
    }
  /** `streamObject` partial — each delta REPLACES the previous partial wholesale. */
  | { type: 'object-delta'; object: unknown }
  /** Automatic compaction ran before a step (token counts are estimates). */
  | { type: 'compaction'; layer: string; tokensBefore: number; tokensAfter: number }
  /** A sub-agent (`agentTool`) part, forwarded live with its path. */
  | { type: 'sub-agent'; agentPath: string[]; part: DeuzUIPart }
  /** App-defined typed data (v2 wire): `writeData('chart', …)` → `data-chart`. */
  /**
   * `id` (1.9 additive) makes a data part RECONCILABLE: re-writing the same
   * `(name, id)` REPLACES the earlier entry instead of appending, so a live
   * status widget ('searching…' → 'found 12' → 'ranking…') is one entry, not
   * three. Absent `id` keeps 1.7/1.8 append-only semantics exactly, so a 1.8
   * client reading a 1.9 stream is unaffected.
   */
  | { type: `data-${string}`; id?: string; payload: unknown }
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
  /**
   * Tool lifecycle transition (v2 wire): render live tool status directly.
   *
   * `denied`/`deniedReason` (1.9 additive) qualify a terminal `state: 'error'`
   * whose cause was an APPROVAL DENIAL rather than a thrown tool — otherwise
   * the last frame of the approval flow reads "getWeather failed", which is the
   * wrong story for a call a human refused. Both are OPTIONAL and
   * `ToolRunState` deliberately gains no 7th member (it is a pinned root export
   * and a new member would break any exhaustive switch), so a 1.8 client keeps
   * rendering exactly the error state it always did.
   *
   * `outcome` (2.3 additive) is the dispatch contract's verdict, as on the
   * canonical `ToolStatePart`: set with a terminal `'error'` and with
   * `'awaiting-approval'` (`'approval-pending'`), absent otherwise.
   */
  | {
      type: 'tool-state';
      toolCallId: string;
      toolName?: string;
      state: ToolRunState;
      denied?: boolean;
      deniedReason?: string;
      outcome?: ToolCallOutcome;
    }
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
  /**
   * A `verifyStep` verdict (v2 wire) — render "checking…"/"retrying" state.
   * Field names mirror the canonical `VerifyPart` exactly.
   */
  | {
      type: 'verify';
      stepIndex: number;
      attempt: number;
      ok: boolean;
      willRetry: boolean;
      feedback?: string;
    }
  /**
   * A non-fatal execution notice (v2 wire, 1.9) — a sampling param the wire
   * could not carry, a clamped ceiling, an unknown slug served from the
   * conservative fallback row. Purely informational: it never ends the stream
   * (that is `error`) and never replaces a delta.
   *
   * The payload IS the canonical {@link CallWarning}, not a re-flattened copy,
   * so the live view and the bulk one (`StreamChatResult.warnings`) are the same
   * shape and a client never has to translate between them.
   */
  | { type: 'warning'; warning: CallWarning }
  /**
   * The false-finish guard rejected a natural completion (v2 wire, 1.9) —
   * render "not done yet, continuing". Field names mirror the canonical
   * `FalseFinishPart` exactly. `willRetry: false` is the rejection that spent
   * the guard's budget, so the terminal `finish` follows immediately.
   */
  | { type: 'false-finish'; stepIndex: number; attempt: number; willRetry: boolean }
  /** Live plan snapshot (v2 wire) — render an autonomous run's to-do panel. */
  | {
      type: 'plan-update';
      goal?: string;
      tasks: Array<{ id: string; title: string; status: string; notes?: string }>;
    }
  /** Live activity feed line (v2 wire) — the "Computer" view of agent actions. */
  | {
      type: 'activity';
      message: string;
      level?: 'info' | 'warn' | 'error';
      data?: unknown;
      agentPath?: string[];
    }
  /**
   * The whole turn finished. `stopDetails` (2.3 additive) is the provider's
   * explanation of an early stop, such as a refusal's category, normalized as
   * `StreamChatResult.stopDetails` and secret-redacted; absent when the provider
   * explained nothing. It rides every wire version.
   */
  | { type: 'finish'; finishReason: FinishReason; usage: Usage; stopDetails?: StopDetails }
  | { type: 'error'; message: string };

// ===================================================================
// Native agent frames (2.3) — the `data-agent` part of the wire
// ===================================================================

/** A client tool call a suspended native run waits on, as the UI receives it (2.3). */
export interface DeuzAgentClientCall {
  toolCallId: string;
  toolName: string;
  /** The model's arguments (`ToolCall.args` on the server). */
  input: unknown;
}

/** A call whose effect is unknown, from a run stopped for reconciliation (2.3). */
export interface DeuzAgentUnknownEffect {
  toolCallId: string;
  toolName: string;
  modelStep?: number;
}

/** The fields every terminal frame (and terminal state) may carry (2.3). */
interface DeuzAgentTerminalFields {
  usage?: Usage;
  modelSteps?: number;
  verification?: AgentVerification['status'];
  /** The provider's explanation of an early stop, such as a refusal's category (secret-redacted). */
  stopDetails?: StopDetails;
}

/**
 * The terminal frame of a leg (2.3): the run's result as the UI may see it. It
 * never carries the transcript, raw tool results, receipts' inputs or the
 * accounting ledger, and a failure's message is secret-redacted.
 */
export type DeuzAgentResultFrame = {
  kind: 'result';
  seq: number;
  runId: string;
} & DeuzAgentTerminalFields &
  (
    | { status: 'completed'; output: unknown }
    | {
        status: 'suspended';
        pendingApprovals: ToolApprovalRequest[];
        pendingClientCalls: DeuzAgentClientCall[];
      }
    | { status: 'stopped'; reason: string; unknownEffects?: DeuzAgentUnknownEffect[] }
    | { status: 'failed'; error: { name: string; message: string; code?: string } }
  );

/**
 * The payload of one `data-agent` part (2.3), written by
 * {@link toDeuzAgentStreamResponse} and read by {@link agentStateFromParts}.
 *
 * `seq` is the frame's own SSE event id. Every leg of a run journaled to one
 * `StreamStateStore` stream (its `streamId`, for example the run id) numbers
 * on from the last stored event, so `seq` grows across the whole run and is
 * the cursor a replay resumes after. A response without a `store` numbers from
 * 0 and cannot be replayed: fold each such response into its own state.
 *
 * - `run`: the first frame of every leg (a fresh run or a resume).
 * - `phase`: the run entered the tool loop or the finalization.
 * - `partial`: a draft of the structured output. Never validated, never `T`.
 * - `element`: an array element the run's element validator accepted. Still a
 *   draft: the whole output is validated only at the end.
 * - `result`: the leg's terminal state ({@link DeuzAgentResultFrame}).
 */
export type DeuzAgentFrame =
  | { kind: 'run'; seq: number; runId?: string; status: 'running' }
  | { kind: 'phase'; seq: number; phase: 'running' | 'finalizing' }
  | { kind: 'partial'; seq: number; attempt: number; value: unknown }
  | { kind: 'element'; seq: number; attempt: number; index: number; value: unknown }
  | DeuzAgentResultFrame;

interface DeuzAgentStateBase {
  /** The highest frame `seq` applied; -1 before the first frame. */
  seq: number;
  /** The run's id, once a frame carried it (the terminal frame always does). */
  runId?: string;
  /** The phase the run was last reported in. */
  phase?: 'running' | 'finalizing';
}

/**
 * A native run as the client sees it (2.3), folded from `data-agent` frames by
 * {@link agentStateFromParts}. Discriminated on `status`: `output` exists only
 * on `completed`, where it is the output the server validated, typed as `T`
 * (the client trusts the server's validation; it does not repeat it). While
 * the run is `running`, `partial` holds the latest draft, which is never `T`.
 */
export type DeuzAgentState<T = unknown> = DeuzAgentStateBase &
  (
    | { status: 'idle' }
    | {
        status: 'running';
        /** The latest draft of the output. Unvalidated, replaced by every draft, gone at the end. */
        partial?: AgentPartialOutput;
        /** The array elements accepted so far, for the draft attempt that produced them. */
        elements?: { attempt: number; values: unknown[] };
      }
    | (DeuzAgentTerminalFields & { status: 'completed'; output: T })
    | (DeuzAgentTerminalFields & {
        status: 'suspended';
        pendingApprovals: ToolApprovalRequest[];
        pendingClientCalls: DeuzAgentClientCall[];
      })
    | (DeuzAgentTerminalFields & {
        status: 'stopped';
        /** Why it stopped: `'aborted'`, `'cancelled'`, `'refusal'`, `'tool-reconciliation-required'`, … */
        reason: string;
        unknownEffects?: DeuzAgentUnknownEffect[];
      })
    | (DeuzAgentTerminalFields & {
        status: 'failed';
        error: { name: string; message: string; code?: string };
      })
  );

/** The `status` of a {@link DeuzAgentState} (2.3). */
export type DeuzAgentStatus = DeuzAgentState['status'];

/**
 * Fold the `data-agent` frames among `parts` into a native run's state (2.3).
 * Pure; every other part is ignored, and so is a malformed frame.
 *
 * Idempotent: a frame whose `seq` is not above the state's `seq` is not
 * applied, so a replay that overlaps what the client already holds, or a
 * frame that arrives after a later one, changes nothing (the same state object
 * comes back). Pass the previous state as `initial` to continue it, for
 * example with the parts of a resume read. A frame of another run, later in
 * the sequence, starts that run's state.
 *
 * `applyUIPart` (`@deuz-sdk/core/chat`) applies the same frames to
 * `AssistantTurnState.agent`.
 */
export function agentStateFromParts<T = unknown>(
  parts: Iterable<DeuzUIPart>,
  initial?: DeuzAgentState<T>,
): DeuzAgentState<T> {
  let state = initial ?? idleAgentState<T>();
  for (const part of parts) {
    const frame = agentFrameOf(part);
    if (frame) state = applyAgentFrame(state, frame);
  }
  return state;
}

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

/**
 * The provider's stop explanation as the wire may carry it (2.3): the
 * `explanation` is provider text echoed to a user, so it passes `redactString`
 * like every other server-supplied string here (P0).
 */
function redactedStopDetails(details: StopDetails): StopDetails {
  return typeof details.explanation === 'string'
    ? { ...details, explanation: redactString(details.explanation) }
    : details;
}

/** `{ stopDetails }` from a finish part's provider metadata, or nothing (2.3). */
function stopDetailsField(providerMetadata: Record<string, unknown> | undefined): {
  stopDetails?: StopDetails;
} {
  const details = stopDetailsFrom(providerMetadata);
  return details ? { stopDetails: redactedStopDetails(details) } : {};
}

/** Map a canonical StreamPart → a Deuz UI part (undefined = drop). */
function toUIPart(part: StreamPart): DeuzUIPart | undefined {
  switch (part.type) {
    case 'text-delta':
      return {
        type: 'text-delta',
        text: part.text,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      };
    case 'reasoning-delta': {
      // An opaque payload (2.3) rides `data` and leaves `text` empty: a client
      // that predates the flags appends `text` to the reasoning it shows.
      const opaque = Boolean(part.encrypted || part.redacted);
      return {
        type: 'reasoning-delta',
        text: opaque ? '' : part.text,
        ...(part.signature ? { signature: part.signature } : {}),
        ...(part.id !== undefined ? { id: part.id } : {}),
        ...(part.encrypted ? { encrypted: true } : {}),
        ...(part.redacted ? { redacted: true } : {}),
        ...(part.source !== undefined ? { source: part.source } : {}),
        ...(opaque ? { data: part.text } : {}),
      };
    }
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
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      };
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
        ...(part.isError ? { isError: true } : {}),
        ...(part.outcome !== undefined ? { outcome: part.outcome } : {}),
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
        ...(part.token ? { token: part.token } : {}),
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
        ...stopDetailsField(part.providerMetadata),
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
        // 1.9: forward the denial qualifier — without it an approval DENIAL is
        // indistinguishable from a thrown tool at the wire, so denial died here
        // and the UI drew "failed". `deniedReason` is free text that may be
        // echoed from the CLIENT's own verdict (`tool-approval-response.reason`)
        // or from a server policy string, so it passes `redactString` like every
        // other server-supplied string on this wire (P0).
        ...(part.denied ? { denied: true } : {}),
        ...(part.deniedReason !== undefined
          ? { deniedReason: redactString(part.deniedReason) }
          : {}),
        ...(part.outcome !== undefined ? { outcome: part.outcome } : {}),
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
    case 'verify':
      // Explicit case required — the default drops unknown canonical parts.
      return {
        type: 'verify',
        stepIndex: part.stepIndex,
        attempt: part.attempt,
        ok: part.ok,
        willRetry: part.willRetry,
        ...(part.feedback !== undefined ? { feedback: part.feedback } : {}),
      };
    case 'warning': {
      // Explicit case required — the default drops unknown canonical parts, and
      // that is exactly where `warning` died before 1.9's wiring pass.
      const warning = (part.warning ?? {}) as Partial<CallWarning>;
      return {
        type: 'warning',
        warning: {
          type: warning.type ?? 'other',
          ...(warning.setting !== undefined ? { setting: warning.setting } : {}),
          // A warning message is BUILT from user input (an option name, a model
          // slug, an activeTools entry), so it goes through `redactString` like
          // every other string this wire emits (P0) — belt and braces over
          // `CallWarning`'s own no-secrets contract.
          message: typeof warning.message === 'string' ? redactString(warning.message) : '',
        },
      };
    }
    case 'false-finish':
      // Explicit case required — same gap `verify` had before Sprint 1.
      return {
        type: 'false-finish',
        stepIndex: part.stepIndex,
        attempt: part.attempt,
        willRetry: part.willRetry,
      };
    case 'plan-update':
      return {
        type: 'plan-update',
        ...(part.goal !== undefined ? { goal: part.goal } : {}),
        tasks: part.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.notes !== undefined ? { notes: t.notes } : {}),
        })),
      };
    case 'activity':
      return {
        type: 'activity',
        message: part.message,
        ...(part.level !== undefined ? { level: part.level } : {}),
        ...(part.data !== undefined ? { data: part.data } : {}),
        ...(part.agentPath !== undefined ? { agentPath: part.agentPath } : {}),
      };
    case 'finish':
      return {
        type: 'finish',
        finishReason: part.finishReason,
        usage: part.usage,
        ...stopDetailsField(part.providerMetadata),
      };
    case 'error':
      return { type: 'error', message: errorMessage(part.error) };
    default:
      return undefined;
  }
}

/**
 * Parts that exist only on wire v2 — never serialized to a negotiated-v1
 * client. Recursive: a v2-only part wrapped in `sub-agent` frames (agentTool
 * forwards child parts live) is just as invisible to v1.
 *
 * Granularity is the whole PART, never a field — and 1.9's additions need no
 * per-field rule: `data-*.id` and `tool-state.denied`/`deniedReason` ride parts
 * that are ALREADY wholly v2-only here, so v1 loses them with their carrier.
 * Both are optional, so a 1.8 client on wire v2 simply ignores the extra keys —
 * which is why they need no version of their own either.
 *
 * 1.9's two NEW parts (`warning`, `false-finish`) join the set for the same
 * reason every other one is in it: a negotiated-v1 response carries only the
 * part types pre-1.7 emitted, and `readDeuzStream`'s open-union rule means a v1
 * client would skip them anyway. The information is not lost — it also
 * resolves in bulk on `StreamChatResult.warnings`. (Optional FIELDS on a v1
 * part do ride v1, such as the 2.3 `reasoning-delta` block fields and
 * `tool-call` provider metadata; an older client ignores them.)
 */
function isV2OnlyPart(part: DeuzUIPart): boolean {
  if (part.type === 'sub-agent') return isV2OnlyPart(part.part);
  return (
    part.type === 'citation' ||
    part.type === 'tool-state' ||
    part.type === 'cost' ||
    part.type === 'budget-exceeded' ||
    part.type === 'verify' ||
    part.type === 'warning' ||
    part.type === 'false-finish' ||
    part.type === 'plan-update' ||
    part.type === 'activity' ||
    part.type.startsWith('data-')
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
   * v1 output has no `id:` lines and no v2-only parts; the optional fields added
   * to v1 parts since ride it too (2.3: the `text-delta` and `tool-call`
   * `providerMetadata`, the `reasoning-delta` block fields, `tool-result.outcome`,
   * and `step-finish` / `finish` `stopDetails`). `tool-state.outcome`, the
   * `'unpriced-model'` warning and native `data-agent` frames are v2 only.
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

/** Per-`send` framing options (internal; surfaced as {@link WriteDataOptions}). */
interface SendOptions {
  /** Emit on the wire but never journal it — see the note inside `send`. */
  transient?: boolean;
}

/**
 * The shared SSE shell of the serializers. `nextSeq` is the event id the next
 * journaled part will get, so a part can name its own id (the agent frames'
 * `seq`, 2.3) when it is built right before its `send`.
 *
 * `journaled` (2.3) is asked, when a `store` is set, before the leg sends or
 * stores anything: whether this leg belongs in the journal. A leg it keeps out
 * is DETACHED: it goes out on this response only, with no `id:` lines, and
 * leaves the journal untouched (no record, no `done` sentinel). Its parts are
 * still numbered from 0 for `nextSeq`, so its frames fold on their own.
 */
function deuzSSEResponse(
  label: string,
  options: ToDeuzStreamOptions,
  produce: (
    send: (part: DeuzUIPart, sendOptions?: SendOptions) => void,
    nextSeq: () => number,
  ) => Promise<void>,
  journaled?: () => Promise<boolean>,
): Response {
  const encoder = new TextEncoder();
  const version: DeuzWireVersion = options.wireVersion ?? 'v2';
  const store = options.store;
  const streamId = options.streamId;
  if (store && !streamId) {
    throw new Error(`${label}: \`streamId\` is required when \`store\` is set.`);
  }
  let writer =
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
      // A detached leg (see `journaled`) carries no journal coordinates.
      let ids = version === 'v2';
      if (writer && journaled && !(await journaled())) {
        writer = undefined;
        ids = false;
      }
      let seq = 0;
      let resumed = false;
      if (writer && store && streamId) {
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
      const send = (part: DeuzUIPart, sendOptions?: SendOptions): void => {
        // v2-only parts are dropped entirely for a negotiated-v1 client (the
        // store must mirror the wire seq-for-seq, so they skip both).
        if (version === 'v1' && isV2OnlyPart(part)) return;
        // A TRANSIENT part is off-journal AND off-seq (1.9). `seq` is the
        // JOURNAL's coordinate system — the resume cursor is a seq and replay
        // means "every record with seq > cursor" — so an event that is never
        // stored must never own a coordinate in it. It rides the wire with NO
        // `id:` line, which is legal SSE and exactly the semantics wanted: an
        // id-less event leaves `Last-Event-ID` untouched, so a progress ping can
        // never become a resume cursor and a reconnecting client just does not
        // see the pings it missed.
        //
        // Consuming a seq instead (emitting `id: n` and skipping only the
        // append) would punch a permanent hole in the log, and a CONTINUED leg —
        // which numbers from `lastStoredSeq + 1` — could then REUSE a seq the
        // client had already committed from a transient frame. Its first real
        // part would be deduplicated away as a "replay" by `connectDeuzStream`,
        // and `read(streamId, cursor)` would skip it too: silent data loss on
        // resume. Off-seq keeps the wire's id space gapless and 1:1 with the
        // journal, so nothing downstream has to know transients exist.
        //
        // It composes with the reader end too: `parseSSE`'s `id` is STICKY (SSE
        // spec), so a transient frame reports the PREVIOUS event's id and
        // `connectDeuzStream` re-commits the cursor it already had — it cannot
        // move forward over an unjournaled event. Do not "fix" that stickiness
        // and do not start stamping `id:` on transients.
        if (sendOptions?.transient) {
          enqueue(`data: ${JSON.stringify(part)}\n\n`);
          return;
        }
        // Store BEFORE wire: a part in flight during a disconnect must still
        // land in the log even though its enqueue never happens.
        writer?.append(seq, part);
        enqueue(`${ids ? `id: ${seq}\n` : ''}data: ${JSON.stringify(part)}\n\n`);
        seq++;
      };
      if (!resumed) {
        const messageId = options.messageId ?? options.generateId?.() ?? 'deuz-msg';
        send({ type: 'start', messageId });
      }
      await produce(send, () => seq);
      // Leg-end sentinel: appended for EVERY ended leg (complete, errored, or
      // suspended-for-approval). Replay treats it as terminal only when
      // nothing was appended after it, so a continued run stays reachable.
      writer?.append(seq, { type: 'done' });
      enqueue(`${ids ? `id: ${seq}\n` : ''}data: [DONE]\n\n`);
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
// Native agent runs (2.3) — streamAgent / resumeStreamAgent on the wire
// ===================================================================

/** `Omit` over each member of a union (plain `Omit` collapses the union first). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ToDeuzAgentStreamOptions extends ToDeuzStreamOptions {
  /**
   * The run's id, carried by the first frame of the leg so a client knows which
   * run to resume before the leg ends (pass the run's `session.runId`). The
   * terminal frame always carries the id the run reports.
   */
  runId?: string;
}

/** The terminal frame for a run result: only what a UI may show (see `DeuzAgentResultFrame`). */
function agentResultFrame(
  result: AgentResult<unknown>,
): DistributiveOmit<DeuzAgentResultFrame, 'seq'> {
  const common = {
    kind: 'result' as const,
    runId: result.runId,
    usage: result.usage,
    modelSteps: result.modelSteps,
    ...(result.verification !== undefined ? { verification: result.verification } : {}),
    ...(result.stopDetails !== undefined
      ? { stopDetails: redactedStopDetails(result.stopDetails) }
      : {}),
  };
  switch (result.status) {
    case 'completed':
      return { ...common, status: 'completed', output: result.output };
    case 'suspended':
      return {
        ...common,
        status: 'suspended',
        pendingApprovals: result.pendingApprovals.map((request) => ({
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input,
          ...(request.token !== undefined ? { token: request.token } : {}),
          ...(request.agentPath !== undefined ? { agentPath: request.agentPath } : {}),
        })),
        // The call's provider metadata stays on the server: the client only runs it.
        pendingClientCalls: result.pendingClientCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.args,
        })),
      };
    case 'stopped':
      return {
        ...common,
        status: 'stopped',
        reason: result.reason,
        // Which calls to reconcile, never what they returned or were given.
        ...(result.unknownEffects !== undefined
          ? {
              unknownEffects: result.unknownEffects.map((receipt) => ({
                toolCallId: receipt.toolCallId,
                toolName: receipt.toolName,
                ...(receipt.modelStep !== undefined ? { modelStep: receipt.modelStep } : {}),
              })),
            }
          : {}),
      };
    case 'failed':
      return {
        ...common,
        status: 'failed',
        error: {
          name: result.error.name,
          message: redactString(result.error.message),
          ...(result.error.code !== undefined ? { code: result.error.code } : {}),
        },
      };
  }
}

/**
 * Serialize a native run (`streamAgent` / `resumeStreamAgent`) to the Deuz UI
 * wire (2.3). Edge-safe.
 *
 * The run's parts go out exactly as {@link toDeuzStreamResponse} frames them,
 * so `useChat` and `applyUIPart` render a native run like any chat stream. On
 * top, `data-agent` parts carry what only a native run has
 * ({@link DeuzAgentFrame}): a `run` frame opening every leg, the phases,
 * drafts of the structured output, and the terminal `result` — the run id,
 * pending approvals and client calls, the validated output, the stop reason
 * and its `stopDetails`, or the failure. `agentStateFromParts` folds them.
 *
 * Nothing that is the server's alone goes out: the transcript, the raw tool
 * results of `tool-output` events (a `tool-result` part carries what the model
 * saw, as on the legacy wire), receipts and the accounting ledger. A failure's
 * message is secret-redacted, and a failed run also gets one `error` part, so a
 * reader that knows nothing of agent frames ends the turn in error.
 *
 * Subscribes to `stream.events` before it returns: pass the stream here before
 * reading its `result` or any other view, and no event is lost. (A stream that
 * already started has no replay of what it emitted; once it ended, only its
 * terminal frame, read from `stream.result`, still goes out.)
 *
 * The agent frames are wire v2 parts (`data-agent`): a client that negotiated
 * v1 gets the plain chat stream. With `store` and `streamId`, every frame's
 * `seq` is its event id in the journal, so a client resumes through
 * {@link resumeDeuzStreamResponse} and the sequence grows across every leg
 * journaled under that `streamId` — use one per run, such as the run id. A
 * stream has one writer at a time: a leg the run REFUSED before it began
 * (another executor holds the run, the run id is stored under another scope,
 * an unknown run, invalid options) goes out on its own response only, with
 * its failed result and error part but no event ids, and writes nothing to
 * the journal, where its frames would take the seqs of the leg that does run.
 */
export function toDeuzAgentStreamResponse<T>(
  stream: AgentStream<T>,
  options: ToDeuzAgentStreamOptions = {},
): Response {
  const events = stream.events[Symbol.asyncIterator]();
  // The run's first event, when the journal question below read it ahead.
  let ahead: Promise<IteratorResult<AgentEvent<T>>> | undefined;
  const next = (): Promise<IteratorResult<AgentEvent<T>>> => {
    const step = ahead ?? events.next();
    ahead = undefined;
    return step;
  };
  // A run refused before it began emits its failed result before anything
  // else; a run that began starts with a phase, and one that stopped or
  // suspended before its first model call is journaled as before. Only the
  // first event tells them apart. (A run whose execution deadline had passed
  // also fails first; its terminal state is the stored run's to report.)
  const journaled = async (): Promise<boolean> => {
    ahead = events.next();
    try {
      const step = await ahead;
      return step.done || step.value.type !== 'result' || step.value.result.status !== 'failed';
    } catch {
      return true; // the read fails again in `produce`, which reports it
    }
  };
  return deuzSSEResponse(
    'toDeuzAgentStreamResponse',
    options,
    async (send, nextSeq) => {
      // Built right before its `send`, so the frame's `seq` is its own event id.
      const frame = (payload: DistributiveOmit<DeuzAgentFrame, 'seq'>): void => {
        const { kind, ...rest } = payload;
        send({ type: 'data-agent', id: kind, payload: { kind, seq: nextSeq(), ...rest } });
      };
      frame({
        kind: 'run',
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        status: 'running',
      });
      let sawError = false;
      let sawResult = false;
      const result = (outcome: AgentResult<unknown>): void => {
        sawResult = true;
        frame(agentResultFrame(outcome));
        if (outcome.status === 'failed' && !sawError) {
          sawError = true;
          send({ type: 'error', message: redactString(outcome.error.message) });
        }
      };
      try {
        for (;;) {
          const step = await next();
          if (step.done) break;
          const event = step.value;
          switch (event.type) {
            case 'part': {
              const ui = toUIPart(event.part);
              if (!ui) break;
              if (ui.type === 'error') sawError = true;
              send(ui);
              break;
            }
            case 'phase':
              frame({ kind: 'phase', phase: event.phase });
              break;
            case 'partial-output':
              frame({ kind: 'partial', attempt: event.attempt, value: event.value });
              break;
            case 'array-element':
              frame({
                kind: 'element',
                attempt: event.attempt,
                index: event.index,
                value: event.value,
              });
              break;
            case 'result':
              result(event.result as AgentResult<unknown>);
              break;
            default:
              // `tool-output` (the raw result) stays on the server.
              break;
          }
        }
        // A stream that had already ended when it was passed in has no events
        // left; its result still says how the run ended.
        if (!sawResult) result((await stream.result) as AgentResult<unknown>);
      } catch (err) {
        // The native pump settles failures as a result; this is belt and braces.
        if (!sawError) send({ type: 'error', message: errorMessage(err) });
      }
    },
    journaled,
  );
}

// ===================================================================
// Plain-text streaming — the frameless projection (1.9)
// ===================================================================

export interface ToDeuzTextStreamOptions {
  /** Extra response headers (override the defaults set here). */
  headers?: Record<string, string>;
  /** Default false. When true, reasoning deltas are interleaved into the text. */
  includeReasoning?: boolean;
}

/**
 * Serialize a `StreamChatResult` to a PLAIN-TEXT streaming `Response`
 * (`text/plain; charset=utf-8`, UTF-8 bytes, **no framing at all**) — the
 * frameless counterpart to {@link toDeuzStreamResponse}, for consumers that
 * cannot parse SSE: `curl`, a shell pipeline, a non-JS edge function, a widget
 * that just appends bytes to a `<pre>`.
 *
 * Canonical line: this projects the CANONICAL `fullStream` (`text-delta`, plus
 * `reasoning-delta` under `includeReasoning`) — never provider bytes. The
 * result is byte-identical to concatenating `result.textStream`; `fullStream`
 * is the single source read here because it is the one projection that reports
 * failures as a part instead of throwing (see below), and reasoning only exists
 * on it.
 *
 * ERROR SEMANTICS — the deliberate trade-off. A frameless format has nowhere to
 * put an error: any string written into the body is INDISTINGUISHABLE from
 * model output. Injecting one would be a correctness bug (the text lands in the
 * user's transcript / gets persisted as an assistant message) and a safety
 * problem (an attacker-influenced upstream message rendered as the model's own
 * words). So a mid-stream failure — an `error` part OR a throwing source —
 * simply CLOSES the body: HTTP truncation without a terminal frame is the
 * signal, exactly as it is for a dropped connection. Callers that need to tell
 * "finished" from "died" must use {@link toDeuzStreamResponse} (or check
 * `result.finishReason`). Nothing is logged here: `ui.ts` carries no
 * `Dependencies` seam, and `console.*` is banned in core — the error stays
 * available on `result.fullStream`/`result.finishReason` for whoever owns the
 * run. (`errorMessage`/`redactString` is what any future log line must go
 * through — P0: nothing unredacted reaches a wire or log surface.)
 *
 * G2: returns synchronously and never throws. Client disconnects are handled
 * exactly like {@link deuzSSEResponse}'s — a failed enqueue flips `clientGone`
 * and the source keeps draining, so the run still reaches its terminal
 * boundary (`onFinish`, chat persistence, checkpoints) after the reader leaves.
 *
 * Edge-safe.
 */
export function toDeuzTextStreamResponse(
  result: StreamChatResult,
  options: ToDeuzTextStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const includeReasoning = options.includeReasoning ?? false;

  // Same discipline as `deuzSSEResponse`: the client can vanish mid-stream, and
  // the enqueue that fails must not abort the drain of the source.
  let clientGone = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string): void => {
        if (clientGone || text === '') return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          clientGone = true;
        }
      };
      try {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            enqueue(part.text);
          } else if (
            includeReasoning &&
            part.type === 'reasoning-delta' &&
            !part.encrypted &&
            !part.redacted
          ) {
            // `encrypted` reasoning (OpenAI Responses) and `redacted` thinking
            // (Anthropic) are opaque provider payloads, not display text —
            // never write them to a text body.
            enqueue(part.text);
          }
          // Everything else — tool calls, steps, citations, and notably the
          // `error` part — has no representation in a frameless format and is
          // dropped. See the error-semantics note above.
        }
      } catch {
        /* Throwing source: truncation is the only signal we may give. */
      }
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
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      ...options.headers,
    },
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

/** Options for one {@link DeuzStreamWriter.writeData} call (1.9 additive). */
export interface WriteDataOptions {
  /**
   * Reconciliation key: every write of the same `(name, id)` addresses the SAME
   * logical entry, so a live status widget ('searching…' → 'found 12 results' →
   * 'ranking…') is ONE entry in the UI instead of three appended ones — and
   * consumers stop inventing a private last-wins convention per name.
   *
   * The WIRE stays strictly append-only: each write is its own frame carrying
   * the id, and last-write-wins is the CLIENT's job (`applyUIPart`). Collapsing
   * frames server-side would break the seq↔journal 1:1 the resume cursor rides
   * on (a replaced record would have to change under a seq a client may already
   * hold) and would hide intermediate states from a live client that is past
   * them. Omit `id` for the 1.7/1.8 append-only semantics, byte-for-byte.
   */
  id?: string;
  /**
   * Emit on the wire but do NOT journal to the `store` (default false), so a
   * progress ping neither bloats a replayed stream nor lands in a persisted
   * record. Transient parts are off-seq as well: they carry no SSE `id:` line
   * and therefore never move a client's resume cursor (see `send`).
   *
   * Consequence to design for: a client that reconnects does not receive the
   * transient parts it missed. Only write state you are happy to lose — the
   * durable snapshot must be a normal (journaled) write.
   */
  transient?: boolean;
}

export interface DeuzStreamWriter {
  response: Response;
  /**
   * Queue a typed `data-{name}` part into the live stream. Safe to call from
   * anywhere while the model stream runs (tool `execute`, RAG pipeline, …);
   * writes after the stream ended are dropped.
   *
   * `options.id` makes the part addressable (client-side last-wins) and
   * `options.transient` keeps it off the journal — see {@link WriteDataOptions}.
   */
  writeData(name: string, payload: unknown, options?: WriteDataOptions): void;
  /** End the data channel early (it auto-closes when the model stream completes). */
  close(): void;
}

/**
 * Like `toDeuzStreamResponse`, but returns a writer so the server can inject
 * typed `data-{name}` parts (chart payloads, RAG citations, progress markers)
 * into the SAME SSE response the model streams over — ordered, seq-numbered,
 * journaled to the `store`, and replayable like every other part (unless the
 * write opts out with `{ transient: true }`).
 */
export function createDeuzStream(
  result: StreamChatResult,
  options: CreateDeuzStreamOptions = {},
): DeuzStreamWriter {
  interface DataItem {
    name: string;
    payload: unknown;
    id?: string;
    transient?: boolean;
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
      // One frame shape for both the validated and the raw path, so an
      // addressable part keeps its `id` when `dataSchemas` is in play too. Key
      // order matches the `data-${string}` variant's declaration (type, id,
      // payload) — the wire is a JSON golden in several tests.
      const frame = (payload: unknown): DeuzUIPart => ({
        type: `data-${item.name}`,
        ...(item.id !== undefined ? { id: item.id } : {}),
        payload,
      });
      // A validation failure is a real diagnostic, not a ping: it is journaled
      // even when the write that produced it was transient, so a replay (or a
      // persisted record) still shows that a part was dropped.
      const invalid = (): void => {
        send({ type: 'error', message: `data part '${item.name}' failed validation.` });
      };
      const sendOptions: SendOptions | undefined = item.transient ? { transient: true } : undefined;
      const schema = options.dataSchemas?.[item.name];
      if (schema) {
        try {
          const checked = await schema['~standard'].validate(item.payload);
          if (checked.issues) {
            invalid();
            return;
          }
          send(frame(checked.value), sendOptions);
          return;
        } catch {
          invalid();
          return;
        }
      }
      send(frame(item.payload), sendOptions);
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
    writeData(name, payload, writeOptions) {
      if (closed) return;
      queue.push({
        name,
        payload,
        ...(writeOptions?.id !== undefined ? { id: writeOptions.id } : {}),
        ...(writeOptions?.transient ? { transient: true } : {}),
      });
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

export interface ReadDeuzStreamOptions {
  /**
   * What to do with a NON-2xx response (default `'error-part'`): a failing
   * route (500 + an HTML error page, 401, 429) carries no `data:` lines, so
   * before 1.9 the generator ended silently and the UI rendered an EMPTY
   * assistant bubble. `'ignore'` restores that pre-1.9 silence.
   */
  onHttpError?: 'error-part' | 'ignore';
  /**
   * Called with a part's SSE event id right before the part is yielded (2.3),
   * once per id: a frame without an id of its own (a transient part) reports
   * nothing, and neither does `[DONE]`. Wire v1 carries no ids. A client that
   * also resumes the stream uses it to know how far it has read: `useChat` does,
   * so a reconnect after a POST read resumes after what that read delivered.
   */
  onEventId?: (id: string) => void;
}

/**
 * Client-side reader: a Deuz-protocol SSE `Response` → `DeuzUIPart`
 * async-iterable.
 *
 * G2-shaped: a failed response yields exactly ONE `error` part and returns —
 * never a throw (`applyUIPart` records it into `turn.error`, which is what
 * `useChat` turns into `status: 'error'`). The body is deliberately NOT read:
 * an error page is arbitrary attacker-or-proxy-controlled markup of unbounded
 * size, and the status line is what a UI can act on. `statusText` is the one
 * server-supplied string echoed, bounded and passed through `redactString`
 * (P0 — nothing unredacted reaches a UI/log surface).
 */
export async function* readDeuzStream(
  response: Response,
  options: ReadDeuzStreamOptions = {},
): AsyncGenerator<DeuzUIPart> {
  if (!response.ok && (options.onHttpError ?? 'error-part') === 'error-part') {
    const statusText = redactString(response.statusText ?? '').slice(0, 200);
    yield {
      type: 'error',
      message: `Deuz stream request failed (status ${response.status}${
        statusText ? ` ${statusText}` : ''
      }).`,
    };
    return;
  }
  if (!response.body) return;
  // `parseSSE`'s id is sticky (SSE spec): an id-less frame repeats the last one.
  let reported: string | undefined;
  for await (const ev of parseSSE(response.body)) {
    if (ev.data === '[DONE]') return;
    let part: DeuzUIPart;
    try {
      part = JSON.parse(ev.data) as DeuzUIPart;
    } catch {
      continue; // skip malformed line
    }
    if (options.onEventId && ev.id !== undefined && ev.id !== reported) {
      reported = ev.id;
      try {
        options.onEventId(ev.id);
      } catch {
        /* consumer callback errors are not transport errors */
      }
    }
    yield part;
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

// ===================================================================
// Durable stream state and the capability handshake (2.4)
// ===================================================================

export type * from './types/stream-durable';
export {
  createInMemoryDurableStreamStateStore,
  DEFAULT_DURABLE_STREAM_BATCH,
} from './stream-durable';
export {
  DEUZ_CAPABILITIES,
  DEUZ_CAPABILITIES_HEADER,
  DEUZ_CAPABILITY,
  formatDeuzCapabilities,
  parseDeuzCapabilities,
} from './internal/capabilities';
export type { DeuzCapabilitiesPart, DeuzCapability } from './internal/capabilities';
