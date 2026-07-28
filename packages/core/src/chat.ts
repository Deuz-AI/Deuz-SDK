/**
 * chat.ts — framework-agnostic chat state engine (1.7, P2+P6).
 *
 * Everything a chat UI binding needs, as PURE functions over immutable data:
 * the render-friendly `UIMessage` shape, the per-turn reducer that folds Deuz
 * UI wire parts into it (`applyUIPart`), canonical-history reconstruction, and
 * the branch helpers behind regenerate / edit-and-resend. `@deuz-sdk/react`'s
 * hooks bind THIS module to React state — no business logic lives there.
 *
 * Persistence: the `ChatStore` seam (`saveChat`/`loadChat`, SessionStore
 * pattern) with an in-memory reference implementation; the agentic loops
 * auto-persist through `options.chat` (best-effort — a failing store logs and
 * never kills a run). A JSONL-backed Node store ships at `./chat/node`.
 *
 * 1.9 adds four things, all ADDITIVE: the ORDERED projection
 * (`UIMessage.parts`) so a multi-step turn renders in the interleave it
 * actually had, the inverse projection (`canonicalFromUI`) so a binding can let
 * the app REPLACE history, the input primitives (`ChatInput` /
 * `userMessageFromInput` / `filesToImageParts`) so a chat turn can carry an
 * image or a PDF instead of only a string, and three channels for wire parts the
 * reducer used to drop on the floor: `warnings`, `falseFinishes` and `subAgents`
 * — the last of which made a whole delegated `agentTool` run invisible.
 */
import type {
  ImagePart,
  Message,
  Part,
  TextPart,
  ToolUsePart,
  ToolResultPart,
} from './types/message';
import type { ToolApprovalRequest } from './types/tool';
import type { ToolRunState } from './types/stream';
import type { CallWarning } from './types/methods';
import type { Usage, FinishReason } from './types/usage';
import type { MemoryScope } from './memory';
import type { DeuzUIPart } from './ui';
import { imagePart } from './parts';
import { resolveMedia } from './internal/image';

export type { MemoryScope } from './memory';

// ===================================================================
// UI message model (the canonical home — ./react re-exports these)
// ===================================================================

export interface UIToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  /** 'call' = streamed; 'result' = executed (server or client); 'approval-requested' = awaiting a verdict. */
  state: 'call' | 'result' | 'approval-requested';
  /** Fine-grained lifecycle from `tool-state` parts (1.7 additive). */
  runState?: ToolRunState;
  /**
   * The terminal failure was an approval DENIAL, not a thrown tool (1.9
   * additive, from `tool-state.denied`). Without it a declined call renders as
   * "getWeather failed" — the wrong last frame for the approval flow.
   *
   * Carried as OPTIONAL FIELDS on purpose: `state` is an exported literal union
   * that consumers switch on exhaustively, so a 4th member ('denied') would be
   * a breaking change for every one of them. Same reasoning as `ToolRunState`
   * in `types/stream.ts`, which refuses a 7th member for the same reason.
   */
  denied?: boolean;
  /** Why it was declined. Already redacted by the wire (P0) — never re-log it raw. */
  deniedReason?: string;
  /**
   * Opaque provider round-trip data for this call (e.g. Gemini's
   * thoughtSignature), carried so `canonicalFromUI` can rebuild a `tool_use`
   * that the NEXT request will not 400 on. Only `uiFromMessages` sets it: the
   * UI wire does not carry provider metadata, so a streamed turn never has it.
   */
  providerMetadata?: Record<string, unknown>;
}

/**
 * ONE renderable element of a turn, in the order it actually arrived.
 *
 * Why this exists: `content` / `reasoning` / `toolCalls` are BUCKETS. A
 * multi-step run — think → search → "I found 3 papers" → fetch → "here is the
 * summary" — flattens into one reasoning blob, one text blob and a detached
 * list of tool cards, so a UI cannot place a tool card between the two
 * sentences it belongs between. That information is destroyed inside the
 * reducer and is not recoverable downstream, which is why the reducer records
 * it here instead.
 *
 * No wire change was needed: the canonical `StreamPart` stream is strictly
 * ordered and `toDeuzStreamResponse` preserves that order, so ARRIVAL ORDER in
 * `applyUIPart` IS the interleave (no text-start/text-end id triples).
 *
 * The buckets are NOT deprecated and keep their exact 1.8 semantics — `parts`
 * is purely additive.
 */
export type UIMessagePart =
  | {
      type: 'text';
      text: string;
      /** 'streaming' until the next part opens or the turn is sealed (`sealAssistantTurn`). */
      state: 'streaming' | 'done';
    }
  | {
      type: 'reasoning';
      text: string;
      signature?: string;
      /**
       * `text` is an OPAQUE encrypted provider payload (OpenAI Responses), not
       * display text — do not render it. Only `uiFromMessages` can set this:
       * the wire's `reasoning-delta` carries no such flag.
       */
      encrypted?: boolean;
      /** Provider-redacted thinking block (same projection-only rule as `encrypted`). */
      redacted?: boolean;
      state: 'streaming' | 'done';
    }
  /**
   * A reference INTO `UIMessage.toolCalls` — deliberately not a copy of the
   * call. Tool state (input → approval → result → denial) mutates over the
   * turn's life; two copies of it would drift.
   */
  | { type: 'tool'; toolCallId: string }
  /** App-defined `data-{name}` part. With an `id` it is reconciled in place (see `applyUIPart`). */
  | { type: 'data'; name: string; id?: string; payload: unknown }
  /** RAG citation — the wire shape verbatim (the SAME object as in `turn.citations`). */
  | Extract<DeuzUIPart, { type: 'citation' }>
  /** Step boundary of an agentic run, so a UI can draw the divider where one was. */
  | { type: 'step-start'; step: number }
  /**
   * A binary attachment (image OR document — `ImagePart` is the single carrier
   * for both, see `src/parts.ts`). A distinct member rather than a 'text' part
   * carrying a data URL: an attachment is not text, `content` is the turn's
   * text and must not start lying, and a consumer should never have to sniff a
   * string to find out whether it is prose or a payload.
   */
  | {
      type: 'file';
      /** Resolved media type (`internal/image.ts`), so a renderer always has one. */
      mediaType: string;
      /** The canonical `ImagePart.image` value VERBATIM — bytes, base64, a `data:` URL, or an https URL. */
      data: string | Uint8Array;
      /**
       * Set only when `data` is ALREADY a browser-renderable src (`data:` /
       * `http(s):`). For bytes or bare base64 the consumer builds one (e.g.
       * `URL.createObjectURL(new Blob([data], { type: mediaType }))`) — the
       * reducer will not base64-encode a buffer on a render path.
       */
      url?: string;
    };

/** Render-friendly message. The canonical `Message[]` history is kept alongside for POSTing. */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: UIToolCall[];
  /**
   * The turn's elements in ARRIVAL ORDER (1.9 additive). OPTIONAL, and absent
   * until the first element exists: `createAssistantTurn`'s shape is public
   * surface, and a pre-1.9 `UIMessage` (hand-built, or restored from storage)
   * legitimately has none. Render `parts` when present, the buckets otherwise.
   */
  parts?: UIMessagePart[];
}

// ===================================================================
// The per-turn reducer (pure): Deuz UI parts → assistant turn state
// ===================================================================

/** Everything one streamed assistant turn accumulates. Immutable — `applyUIPart` returns a new state. */
export interface AssistantTurnState {
  message: UIMessage;
  /** Gated calls awaiting verdicts (the chat pauses while non-empty). */
  approvals: ToolApprovalRequest[];
  /** toolCallIds the SERVER already executed — the rest are client tools. */
  serverResults: string[];
  /** Live cumulative cost, when the server streams `cost` parts (1.7). */
  costUsd?: number;
  cacheSavingsUsd?: number;
  /** Set when the server's `budget` guardrail tripped (1.7). */
  budgetExceeded?: { kind: 'usd' | 'tokens'; limit: number; value: number };
  /**
   * App-defined `data-{name}` parts, in arrival order (1.7). `id` (1.9) makes
   * an entry ADDRESSABLE: a re-write of the same `(name, id)` replaces it in
   * place instead of appending, so a live status widget is one entry rather
   * than three. Entries written without an id stay append-only, exactly as in
   * 1.7/1.8.
   */
  dataParts: Array<{ name: string; id?: string; payload: unknown }>;
  /** RAG citations streamed with the answer (1.7). */
  citations: Array<Extract<DeuzUIPart, { type: 'citation' }>>;
  /** Latest live plan snapshot from `plan-update` parts (1.8, autonomous runs). */
  plan?: Extract<DeuzUIPart, { type: 'plan-update' }>;
  /** Live activity feed from `activity` parts, in arrival order (1.8). */
  activity: Array<Extract<DeuzUIPart, { type: 'activity' }>>;
  /**
   * `verifyStep` verdicts from `verify` parts, in arrival order (1.9).
   * OPTIONAL, not a defaulted array: `createAssistantTurn`'s shape is public
   * surface, so this stays absent until the first verdict arrives.
   */
  verifications?: Array<Extract<DeuzUIPart, { type: 'verify' }>>;
  /**
   * Non-fatal execution notices from `warning` parts, in arrival order (1.9) —
   * a dropped sampling param, a clamped ceiling, an unknown model slug. The
   * payload is the canonical {@link CallWarning}, identical to what
   * `StreamChatResult.warnings` resolves, so a UI renders one shape. OPTIONAL
   * for the same reason as `verifications`: `createAssistantTurn`'s literal is
   * public surface and stays unchanged.
   */
  warnings?: CallWarning[];
  /**
   * `false-finish` rejections, in arrival order (1.9): the guard decided the
   * work was not actually done. `willRetry: false` on the last one means the
   * guard's budget was spent, so the run stopped anyway — which is what lets a
   * UI say "gave up after 3 tries" instead of pretending the answer is final.
   */
  falseFinishes?: Array<Extract<DeuzUIPart, { type: 'false-finish' }>>;
  /**
   * Live sub-agent (`agentTool`) frames, one per `agentPath`, in the order each
   * one first spoke (1.9). Before this existed a whole delegated run was
   * INVISIBLE: `sub-agent` parts reached the reducer and were dropped.
   *
   * DESIGN — why a channel of its own, and not the parent's ordered `parts`:
   *
   * 1. A sub-agent's words are NOT the parent's. Folding them into
   *    `message.content` / `message.reasoning` / `message.toolCalls` would
   *    misattribute prose to the main agent AND poison the canonical projection
   *    (`assistantMessageFromTurn` would re-emit the child's `tool_use` parts as
   *    the parent's own, and every one of those needs a `tool_result` or the
   *    next request 400s).
   * 2. `UIMessagePart` is a CLOSED, pinned union that consumers switch on
   *    exhaustively; a new member there would be a breaking change for them
   *    (the same reasoning that keeps `ToolRunState` at six members and
   *    `UIToolCall.state` at three).
   * 3. The interleave still stays truthful: `afterPart` records how many of the
   *    parent's ordered elements existed when the frame opened, so a renderer
   *    splices the sub-agent block back in at exactly the point the parent
   *    handed off — normally right after the `tool` card for the `agentTool`
   *    call — and can indent or badge it by `agentPath`.
   *
   * Each frame holds a full `AssistantTurnState` folded by THIS reducer
   * (`applyUIPart` re-enters itself), so a sub-agent's own text, reasoning,
   * ordered `parts`, tool cards, citations, activity and cost are all as
   * complete as the parent's — with one implementation, not a parallel one.
   *
   * A 2nd-level sub-agent is a SIBLING frame with a 2-segment `agentPath`, not a
   * nested one: the wire is single-wrapped (`SubAgentPart.part` is never another
   * `sub-agent`), so a renderer indents by `agentPath.length` and needs no
   * recursion of its own.
   */
  subAgents?: Array<{
    /** Full path, e.g. `['researcher']` or `['researcher', 'coder']`. */
    agentPath: string[];
    /** Count of the parent's ordered `parts` when this frame opened. */
    afterPart: number;
    /** The sub-agent's own turn (recursive — it has its own `parts`). */
    turn: AssistantTurnState;
  }>;
  /** Terminal token usage from the wire's `finish` part (1.9). */
  usage?: Usage;
  /** Terminal finish reason (1.9) — `'length'` means the answer was truncated. */
  finishReason?: FinishReason;
  /** Per-step usage/finish from `step-finish` parts, in arrival order (1.9). */
  steps?: Array<{ step: number; usage: Usage; finishReason: FinishReason }>;
  /** Redacted server error message, when the stream ended in an error part. */
  error?: string;
}

export function createAssistantTurn(id: string): AssistantTurnState {
  return {
    message: { id, role: 'assistant', content: '' },
    approvals: [],
    serverResults: [],
    dataParts: [],
    citations: [],
    activity: [],
  };
}

/**
 * Coerce a wire `usage` payload into a real `Usage` (1.9). `applyUIPart` is
 * TOTAL by contract, and this payload crosses a network boundary from a server
 * that may be older, newer, or hostile: `null`, a string, or a partial object
 * (`{ totalTokens: 1 }`) must fold without throwing AND without leaving a field
 * typed `number` holding something else. Non-finite/missing counts read as 0;
 * `totalTokens` falls back to input+output so a token badge always renders.
 */
function usageFromWire(value: unknown): Usage {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const optional = (key: string): number | undefined => {
    const n = raw[key];
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  };
  const count = (key: string): number => optional(key) ?? 0;
  const inputTokens = count('inputTokens');
  const outputTokens = count('outputTokens');
  const audioTokens = optional('audioTokens');
  const serverToolUses = optional('serverToolUses');
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: count('reasoningTokens'),
    cachedReadTokens: count('cachedReadTokens'),
    cacheWriteTokens: count('cacheWriteTokens'),
    cacheWrite1hTokens: count('cacheWrite1hTokens'),
    ...(audioTokens !== undefined ? { audioTokens } : {}),
    ...(serverToolUses !== undefined ? { serverToolUses } : {}),
    totalTokens: optional('totalTokens') ?? inputTokens + outputTokens,
  };
}

/**
 * A wire `finishReason` is trusted only to be a string — a newer server's new
 * reason value passes through verbatim (open-union rule) instead of being
 * dropped, while a non-string never lands in a field typed as one.
 */
function finishReasonFromWire(value: unknown): FinishReason | undefined {
  return typeof value === 'string' ? (value as FinishReason) : undefined;
}

/**
 * A finite number from the wire, or `undefined`. Same rule as `usageFromWire`:
 * `applyUIPart` is TOTAL, so a hostile/older/newer server's `"3"`, `NaN` or
 * `null` must fold without throwing AND without landing in a field typed
 * `number`.
 */
function numberFromWire(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function withToolCall(
  turn: AssistantTurnState,
  toolCallId: string,
  patch: (call: UIToolCall) => UIToolCall,
): AssistantTurnState {
  const toolCalls = (turn.message.toolCalls ?? []).map((c) =>
    c.toolCallId === toolCallId ? patch(c) : c,
  );
  return { ...turn, message: { ...turn.message, toolCalls } };
}

// --- Ordered projection plumbing (1.9). Every helper returns NEW arrays. ---

/**
 * `parts` is optional AND may have been rehydrated from JSON (a turn kept in
 * sessionStorage across a reload), so its runtime type is not guaranteed —
 * `applyUIPart` is TOTAL and must not throw on a non-array.
 */
function partsOf(message: UIMessage): UIMessagePart[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

/**
 * Close the tail. A text/reasoning part is 'streaming' only while it is the
 * NEWEST thing in the turn; opening anything else ends it. That single rule is
 * what makes a text delta arriving after a tool call start a NEW paragraph
 * instead of silently re-opening the one the tool interrupted.
 *
 * Returns the SAME array when there is nothing to seal — callers use identity
 * to avoid rewriting a message object (and re-rendering) for no reason.
 */
function sealTail(parts: UIMessagePart[]): UIMessagePart[] {
  const tail = parts.at(-1);
  if (!tail) return parts;
  if ((tail.type === 'text' || tail.type === 'reasoning') && tail.state === 'streaming') {
    return [...parts.slice(0, -1), { ...tail, state: 'done' }];
  }
  return parts;
}

/** Append a new element, sealing whatever was streaming before it. */
function openPart(parts: UIMessagePart[], next: UIMessagePart): UIMessagePart[] {
  return [...sealTail(parts), next];
}

function withParts(turn: AssistantTurnState, parts: UIMessagePart[]): AssistantTurnState {
  return { ...turn, message: { ...turn.message, parts } };
}

/**
 * Reference a tool by id, ONCE per id. The card's state lives only in
 * `toolCalls`, so `tool-result` / `tool-approval-request` / a later
 * `tool-state` add nothing here — the card stays anchored at the position where
 * the call was made, which is exactly where a reader expects it.
 */
function withToolPart(turn: AssistantTurnState, toolCallId: string): AssistantTurnState {
  const parts = partsOf(turn.message);
  if (parts.some((p) => p.type === 'tool' && p.toolCallId === toolCallId)) return turn;
  return withParts(turn, openPart(parts, { type: 'tool', toolCallId }));
}

/** Terminal boundary: seal the tail, but never invent a `parts` key that was absent. */
function sealedMessage(message: UIMessage): UIMessage {
  const parts = partsOf(message);
  if (parts.length === 0) return message;
  const sealed = sealTail(parts);
  return sealed === parts ? message : { ...message, parts: sealed };
}

/** One `sub-agent` frame as the reducer stores it (see `AssistantTurnState.subAgents`). */
type SubAgentFrame = NonNullable<AssistantTurnState['subAgents']>[number];

/**
 * Seal every sub-agent frame at the parent's terminal boundary. A frame the
 * parent already moved past still holds a 'streaming' tail of its own — nothing
 * more is coming for it once the parent turn is over, and a renderer must not
 * keep a caret blinking inside a finished sub-agent block.
 *
 * Returns the SAME array when there is nothing to seal (the identity contract
 * `sealAssistantTurn` relies on to avoid a pointless re-render).
 */
function sealedSubAgents(frames: SubAgentFrame[]): SubAgentFrame[] {
  let changed = false;
  const next = frames.map((frame) => {
    // Recursive by construction: `sealAssistantTurn` seals a frame's OWN frames.
    const sealed = sealAssistantTurn(frame.turn);
    if (sealed === frame.turn) return frame;
    changed = true;
    return { ...frame, turn: sealed };
  });
  return changed ? next : frames;
}

/**
 * Index of the `(name, id)` entry a data write REPLACES, or -1 to append.
 * Without an `id` the answer is always -1: that is 1.7/1.8's append-only
 * semantics, preserved byte-for-byte.
 */
function reconcileIndex<T>(
  list: T[],
  id: string | undefined,
  isMatch: (candidate: T) => boolean,
): number {
  return id === undefined ? -1 : list.findIndex(isMatch);
}

/** Replace one entry positionally in a NEW array — the matched entry is never mutated. */
function replaceAt<T>(list: T[], index: number, entry: T): T[] {
  const next = [...list];
  next[index] = entry;
  return next;
}

/**
 * Fold ONE Deuz UI wire part into the turn. Pure and total: unknown part
 * types are ignored (open-union rule), so newer servers never break older
 * clients. `error` parts are RECORDED, not thrown — the binding decides.
 *
 * Since 1.9 every content-bearing case ALSO appends to (or extends the tail of)
 * the ordered `message.parts` projection. The buckets `content` / `reasoning` /
 * `toolCalls` are computed exactly as they were in 1.8 — the same `part.text`
 * lands in both views, so the two can never disagree.
 *
 * The one deliberate exception is `sub-agent`: a delegated run's parts fold into
 * their OWN frame under `turn.subAgents` and touch neither the parent's buckets
 * nor its ordered `parts`, so a sub-agent's words are never put in the main
 * agent's mouth. See `AssistantTurnState.subAgents`.
 */
export function applyUIPart(turn: AssistantTurnState, part: DeuzUIPart): AssistantTurnState {
  switch (part.type) {
    case 'start':
      return { ...turn, message: { ...turn.message, id: part.messageId } };
    case 'text-delta': {
      const parts = partsOf(turn.message);
      const tail = parts.at(-1);
      const next: UIMessagePart[] =
        tail?.type === 'text' && tail.state === 'streaming'
          ? [...parts.slice(0, -1), { ...tail, text: tail.text + part.text }]
          : openPart(parts, { type: 'text', text: part.text, state: 'streaming' });
      return {
        ...turn,
        // `content` stays the WHOLE turn's text (1.8 semantics, verbatim).
        message: { ...turn.message, content: turn.message.content + part.text, parts: next },
      };
    }
    case 'reasoning-delta': {
      const parts = partsOf(turn.message);
      const tail = parts.at(-1);
      // Anthropic sends the signature on the LAST thinking delta, so a later
      // one wins and a delta without it keeps what the block already had.
      const signature = typeof part.signature === 'string' ? { signature: part.signature } : {};
      const next: UIMessagePart[] =
        tail?.type === 'reasoning' && tail.state === 'streaming'
          ? [...parts.slice(0, -1), { ...tail, text: tail.text + part.text, ...signature }]
          : openPart(parts, {
              type: 'reasoning',
              text: part.text,
              state: 'streaming',
              ...signature,
            });
      return {
        ...turn,
        message: {
          ...turn.message,
          reasoning: (turn.message.reasoning ?? '') + part.text,
          parts: next,
        },
      };
    }
    case 'tool-call': {
      // A `tool-state: input-streaming` may have created a placeholder for
      // this id already — complete it in place instead of duplicating.
      if ((turn.message.toolCalls ?? []).some((c) => c.toolCallId === part.toolCallId)) {
        return withToolPart(
          withToolCall(turn, part.toolCallId, (c) => ({
            ...c,
            toolName: part.toolName,
            input: part.input,
            state: 'call',
          })),
          part.toolCallId,
        );
      }
      const call: UIToolCall = {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        state: 'call',
      };
      return withToolPart(
        {
          ...turn,
          message: { ...turn.message, toolCalls: [...(turn.message.toolCalls ?? []), call] },
        },
        part.toolCallId,
      );
    }
    case 'tool-result': {
      const next = withToolCall(turn, part.toolCallId, (c) => ({
        ...c,
        state: 'result',
        output: part.output,
        ...(part.isError ? { isError: true } : {}),
      }));
      return { ...next, serverResults: [...next.serverResults, part.toolCallId] };
    }
    case 'tool-approval-request': {
      const next = withToolCall(turn, part.toolCallId, (c) => ({
        ...c,
        state: 'approval-requested',
      }));
      return {
        ...next,
        approvals: [
          ...next.approvals,
          {
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...('token' in part && part.token ? { token: part.token } : {}),
            ...('agentPath' in part && Array.isArray(part.agentPath)
              ? { agentPath: part.agentPath as string[] }
              : {}),
          },
        ],
      };
    }
    case 'tool-state': {
      // The 1.9 denial flags may not be declared on the wire type this build
      // compiled against (an older server never sends them either), so read
      // them DEFENSIVELY and validate: they cross a network boundary, and a
      // field typed `boolean`/`string` must never end up holding anything else.
      // `deniedReason` arrives already redacted from the serializer (P0).
      const flags = part as { denied?: unknown; deniedReason?: unknown };
      const denial: Pick<UIToolCall, 'denied' | 'deniedReason'> =
        flags.denied === true
          ? {
              denied: true,
              ...(typeof flags.deniedReason === 'string'
                ? { deniedReason: flags.deniedReason }
                : {}),
            }
          : {};
      // `input-streaming` arrives BEFORE the assembled tool-call part — open a
      // placeholder so the lifecycle is visible from the first fragment.
      if (!(turn.message.toolCalls ?? []).some((c) => c.toolCallId === part.toolCallId)) {
        const placeholder: UIToolCall = {
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? '',
          input: undefined,
          state: 'call',
          runState: part.state,
          ...denial,
        };
        return withToolPart(
          {
            ...turn,
            message: {
              ...turn.message,
              toolCalls: [...(turn.message.toolCalls ?? []), placeholder],
            },
          },
          part.toolCallId,
        );
      }
      return withToolCall(turn, part.toolCallId, (c) => ({
        ...c,
        runState: part.state,
        ...denial,
      }));
    }
    case 'cost':
      return {
        ...turn,
        costUsd: part.costUsd,
        ...(part.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: part.cacheSavingsUsd } : {}),
      };
    case 'budget-exceeded':
      return {
        ...turn,
        budgetExceeded: { kind: part.kind, limit: part.limit, value: part.value },
      };
    case 'citation':
      // The SAME object lands in both channels — one source of truth, no drift.
      return {
        ...turn,
        citations: [...turn.citations, part],
        message: { ...turn.message, parts: openPart(partsOf(turn.message), part) },
      };
    case 'step-start': {
      const parts = partsOf(turn.message);
      // Same defensive idiom as `step-finish`: a malformed `step` falls back to
      // the arrival ordinal rather than dropping the boundary entirely.
      const step =
        typeof part.step === 'number' && Number.isFinite(part.step)
          ? part.step
          : parts.filter((p) => p.type === 'step-start').length;
      return withParts(turn, openPart(parts, { type: 'step-start', step }));
    }
    case 'plan-update':
      return { ...turn, plan: part };
    case 'activity':
      return { ...turn, activity: [...turn.activity, part] };
    case 'verify':
      return { ...turn, verifications: [...(turn.verifications ?? []), part] };
    case 'warning': {
      // NORMALIZED rather than stored verbatim (unlike `verify`): every field
      // here is typed, the payload crosses a network boundary, and `warnings` is
      // the one readout an app is likely to render as plain text. A frame with
      // no message is not renderable, so it is dropped instead of appended as an
      // empty line — the same fail-quiet rule the `default` case uses.
      const raw = (part.warning ?? {}) as Partial<CallWarning>;
      if (typeof raw.message !== 'string') return turn;
      const warning: CallWarning = {
        // `CallWarning.type` is documented as an OPEN union: a newer server's
        // value passes through verbatim, a non-string reads as 'other'.
        type: typeof raw.type === 'string' ? raw.type : 'other',
        ...(typeof raw.setting === 'string' ? { setting: raw.setting } : {}),
        message: raw.message,
      };
      return { ...turn, warnings: [...(turn.warnings ?? []), warning] };
    }
    case 'false-finish':
      return {
        ...turn,
        falseFinishes: [
          ...(turn.falseFinishes ?? []),
          {
            type: 'false-finish',
            // A malformed counter takes a neutral default rather than losing the
            // rejection entirely — that a rejection HAPPENED is the signal.
            stepIndex: numberFromWire(part.stepIndex) ?? 0,
            attempt: numberFromWire(part.attempt) ?? 0,
            willRetry: part.willRetry === true,
          },
        ],
      };
    case 'sub-agent': {
      // A frame is identified by its path; a malformed one is DROPPED rather
      // than folded into the parent, because misattributing a sub-agent's words
      // to the main agent is worse than a gap in the UI. See
      // `AssistantTurnState.subAgents` for why this is its own channel.
      const agentPath = Array.isArray(part.agentPath)
        ? part.agentPath.filter((segment): segment is string => typeof segment === 'string')
        : [];
      const inner: unknown = part.part;
      if (
        agentPath.length === 0 ||
        inner === null ||
        typeof inner !== 'object' ||
        typeof (inner as { type?: unknown }).type !== 'string' ||
        // SINGLE-WRAPPED by contract: depth rides `agentPath`, never a nested
        // frame (see `SubAgentPart`). Refusing the nested shape is also what
        // bounds this recursion at exactly one level, so an adversarial payload
        // nested a thousand deep cannot turn a TOTAL reducer into a stack
        // overflow.
        (inner as { type: string }).type === 'sub-agent'
      ) {
        return turn;
      }
      // NUL joins the lookup key: it cannot appear in an agent name, so
      // `['a b']` and `['a', 'b']` can never collide on one frame.
      const key = agentPath.join('\u0000');
      const frames = turn.subAgents ?? [];
      const index = frames.findIndex((frame) => frame.agentPath.join('\u0000') === key);
      const existing = index === -1 ? undefined : frames[index];
      // Re-enter THIS reducer: text coalescing, tool cards, the ordered
      // projection and data reconciliation all come for free, and the child's
      // approvals stay in the child's frame instead of duplicating the parent's
      // (the parent loop emits its OWN unwrapped request for those).
      const base = existing?.turn ?? createAssistantTurn(agentPath.join('/'));
      const frame: SubAgentFrame = {
        agentPath,
        // Anchored ONCE, when the frame opens: the parent is blocked inside the
        // `agentTool` call while the child streams, so this is the handoff point.
        afterPart: existing?.afterPart ?? partsOf(turn.message).length,
        turn: applyUIPart(base, inner as DeuzUIPart),
      };
      return {
        ...turn,
        subAgents: index === -1 ? [...frames, frame] : replaceAt(frames, index, frame),
      };
    }
    case 'finish': {
      const finishReason = finishReasonFromWire(part.finishReason);
      return {
        ...turn,
        usage: usageFromWire(part.usage),
        ...(finishReason !== undefined ? { finishReason } : {}),
        // TERMINAL BOUNDARY: nothing can extend the tail after `finish`, so the
        // last text/reasoning part stops being 'streaming' here. A stream that
        // dies WITHOUT a finish (abort, dropped connection) deliberately leaves
        // it 'streaming' — that is the truth about a truncated turn. A binding
        // that owns the abort seals it explicitly with `sealAssistantTurn`.
        message: sealedMessage(turn.message),
        // Sub-agent frames end with the parent turn: nothing more can arrive for
        // a child once the run that delegated to it is over.
        ...(turn.subAgents ? { subAgents: sealedSubAgents(turn.subAgents) } : {}),
      };
    }
    case 'step-finish': {
      // A malformed `step` falls back to the arrival ordinal rather than
      // dropping the entry — a UI indexes `steps` positionally.
      const step =
        typeof part.step === 'number' && Number.isFinite(part.step)
          ? part.step
          : (turn.steps?.length ?? 0);
      return {
        ...turn,
        steps: [
          ...(turn.steps ?? []),
          {
            step,
            usage: usageFromWire(part.usage),
            // Required in the entry shape; a malformed payload takes the
            // neutral default instead of losing the step's token counts.
            finishReason: finishReasonFromWire(part.finishReason) ?? 'stop',
          },
        ],
      };
    }
    case 'error':
      // Terminal too: the turn is over, whatever was streaming is what arrived.
      return {
        ...turn,
        error: part.message,
        message: sealedMessage(turn.message),
        ...(turn.subAgents ? { subAgents: sealedSubAgents(turn.subAgents) } : {}),
      };
    default: {
      if (typeof part.type === 'string' && part.type.startsWith('data-')) {
        const dataPart = part as Extract<DeuzUIPart, { payload: unknown }>;
        const name = dataPart.type.slice('data-'.length);
        // Only a STRING id addresses an entry; anything else reads as absent and
        // keeps the append-only path (the wire may be older or hostile).
        const id = typeof dataPart.id === 'string' ? dataPart.id : undefined;
        const entry = {
          name,
          ...(id !== undefined ? { id } : {}),
          payload: dataPart.payload,
        };
        const ordered: UIMessagePart = { type: 'data', ...entry };
        const parts = partsOf(turn.message);
        // Reconcile BOTH views with one decision so they cannot disagree: with
        // an id the matched entry is REPLACED in place (position preserved, new
        // array, new entry — never a mutation); without one it appends.
        const bucketIndex = reconcileIndex(
          turn.dataParts,
          id,
          (c) => c.name === name && c.id === id,
        );
        const partIndex = reconcileIndex(
          parts,
          id,
          (p) => p.type === 'data' && p.name === name && p.id === id,
        );
        return {
          ...turn,
          dataParts:
            bucketIndex === -1
              ? [...turn.dataParts, entry]
              : replaceAt(turn.dataParts, bucketIndex, entry),
          message: {
            ...turn.message,
            parts:
              partIndex === -1 ? openPart(parts, ordered) : replaceAt(parts, partIndex, ordered),
          },
        };
      }
      return turn; // additive union — ignore the rest
    }
  }
}

/**
 * Seal a turn's ordered parts: every 'streaming' text/reasoning element becomes
 * 'done'. `applyUIPart` already does this on the wire's terminal parts
 * (`finish` / `error`), so this is for the boundaries only the BINDING knows
 * about — a user abort, a reader that walked away, a turn restored from storage.
 *
 * Idempotent, and returns the SAME object when there is nothing to seal (unlike
 * `applyUIPart`, which always returns a new one) so a React binding can call it
 * unconditionally without forcing a re-render.
 *
 * Sub-agent frames (1.9) are sealed too — a delegated run that was still
 * streaming when the parent was aborted is just as finished as the parent.
 */
export function sealAssistantTurn(turn: AssistantTurnState): AssistantTurnState {
  const message = sealedMessage(turn.message);
  const subAgents = turn.subAgents ? sealedSubAgents(turn.subAgents) : undefined;
  if (message === turn.message && subAgents === turn.subAgents) return turn;
  return { ...turn, message, ...(subAgents ? { subAgents } : {}) };
}

/**
 * `UIToolCall` → canonical `tool_use`. One constructor for every direction
 * (streamed turn, projected history, inverse projection) so a provider
 * round-trip field can never be echoed by one path and dropped by another.
 */
function toolUseFromUI(call: UIToolCall): ToolUsePart {
  return {
    type: 'tool_use',
    id: call.toolCallId,
    name: call.toolName,
    input: call.input,
    ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
  };
}

/**
 * Canonical assistant turn for the request history: text plus `tool_use`
 * parts, exactly as the wire streamed them (client-tools reconstruction).
 */
export function assistantMessageFromTurn(turn: AssistantTurnState): Message {
  const toolCalls = turn.message.toolCalls ?? [];
  const toolUses: ToolUsePart[] = toolCalls.map(toolUseFromUI);
  const text = turn.message.content;
  const content: string | Part[] =
    toolUses.length > 0 ? [...(text ? [{ type: 'text' as const, text }] : []), ...toolUses] : text;
  return { role: 'assistant', content };
}

/** Canonical `role: 'tool'` message for client-executed tool results. */
export function clientToolResultMessage(
  results: Array<{ toolCallId: string; result: unknown; isError?: boolean }>,
): Message {
  const parts: ToolResultPart[] = results.map((r) => ({
    type: 'tool_result',
    toolUseId: r.toolCallId,
    result: r.result,
    ...(r.isError ? { isError: true } : {}),
  }));
  return { role: 'tool', content: parts };
}

// ===================================================================
// Input primitives (1.9) — one user turn from text, parts, or files
// ===================================================================

/**
 * What a chat binding accepts as ONE user turn: plain text (the 1.7/1.8 shape,
 * unchanged) or text plus canonical `Part`s — images and PDFs from
 * {@link filesToImageParts}, `imagePart`/`filePart` (`@deuz-sdk/core/parts`),
 * or anything else the four wires already understand.
 */
export type ChatInput = string | { text?: string; parts?: Part[] };

/**
 * Canonical user message for one {@link ChatInput}.
 *
 * A plain string stays a STRING content — byte-identical to what 1.8's
 * `sendMessage(text)` built, because a prompt-cache prefix must not move when a
 * caller upgrades. With attachments the content becomes `[...parts, text]`:
 * media FIRST, then the question. That is the order every wire's own docs
 * recommend and the order `filePart`'s example uses (`src/parts.ts`).
 *
 * Total, like the reducer: an empty `text` is DROPPED rather than sent as an
 * empty text block (Anthropic 400s on one), a `parts` value that is not an
 * array is ignored instead of throwing, and an input with neither text nor
 * parts yields `content: ''` — exactly what `sendMessage('')` produced before.
 */
export function userMessageFromInput(input: ChatInput): Message {
  if (typeof input === 'string') return { role: 'user', content: input };
  const text = typeof input.text === 'string' ? input.text : '';
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (parts.length === 0) return { role: 'user', content: text };
  return { role: 'user', content: [...parts, ...(text ? [{ type: 'text' as const, text }] : [])] };
}

/**
 * Picked files (`<input type="file">`, a drop event's `DataTransfer.files`) →
 * canonical `ImagePart`s. `ImagePart` is the single carrier for ALL binary
 * media (`src/parts.ts`), so a PDF rides the same call and every adapter maps it
 * to its wire's document block.
 *
 * WEB APIs ONLY: `await blob.arrayBuffer()` → `Uint8Array`. No `FileReader`
 * (callback-only and DOM-bound), no `Buffer`, no `node:*` — this has to behave
 * identically in a browser and in an edge runtime. Order is preserved and the
 * reads run concurrently. Every blob is fully buffered in memory, so cap the
 * size where the user picks them.
 */
export async function filesToImageParts(
  files: Iterable<Blob & { type?: string }>,
): Promise<ImagePart[]> {
  return Promise.all(
    [...files].map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // `imagePart` is the one constructor for the carrier; an unlabelled blob
      // resolves to image/jpeg downstream (`internal/image.ts`).
      return imagePart({ data: bytes, ...(file.type ? { mediaType: file.type } : {}) });
    }),
  );
}

// ===================================================================
// Canonical → UI projection + branch helpers (P6 core)
// ===================================================================

function textOf(content: string | Part[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Canonical `ImagePart` → the ordered `file` element.
 *
 * `resolveMedia` is the single classifier (it knows the `data:` prefix, the URL
 * extension and the `image/jpeg` fallback), but it base64-encodes a `Uint8Array`
 * carrier — so for bytes we resolve a STRING-carrier clone instead and take only
 * the fields we need. Every branch that DERIVES a media type is string-only
 * anyway; the bytes branch merely echoes the default. Nothing is re-encoded on a
 * render path, and `data` stays the canonical value verbatim so the inverse
 * projection can rebuild the exact same part.
 */
function filePartFromImage(part: ImagePart): Extract<UIMessagePart, { type: 'file' }> {
  const isString = typeof part.image === 'string';
  const resolved = resolveMedia(isString ? part : { ...part, image: '' });
  const renderable = isString && (resolved.kind === 'url' || resolved.kind === 'data-url');
  return {
    type: 'file',
    mediaType: resolved.mediaType,
    data: part.image,
    ...(renderable ? { url: part.image as string } : {}),
  };
}

/**
 * Ordered projection of ONE canonical content value — the inverse of
 * `canonicalContentFromUI`. History is not live, so every element is 'done'.
 */
function uiPartsFromContent(content: string | Part[]): UIMessagePart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content, state: 'done' }] : [];
  }
  const parts: UIMessagePart[] = [];
  for (const p of content) {
    switch (p.type) {
      case 'text':
        parts.push({ type: 'text', text: p.text, state: 'done' });
        break;
      case 'reasoning':
        parts.push({
          type: 'reasoning',
          text: p.text,
          state: 'done',
          ...(p.signature !== undefined ? { signature: p.signature } : {}),
          ...(p.encrypted ? { encrypted: true } : {}),
          ...(p.redacted ? { redacted: true } : {}),
        });
        break;
      case 'tool_use':
        parts.push({ type: 'tool', toolCallId: p.id });
        break;
      case 'image':
        // Before 1.9 an attachment was dropped here and rendered as an empty
        // bubble — `textOf` filters to text parts, and `content` is a string.
        parts.push(filePartFromImage(p));
        break;
      default:
        // `tool_result` lives on the `role: 'tool'` message that FOLLOWS the
        // turn; it folds into `toolCalls`, not into the ordered stream.
        break;
    }
  }
  return parts;
}

/**
 * Project a canonical history into render-friendly `UIMessage`s (e.g. a chat
 * loaded from a `ChatStore`). `tool` messages merge their results into the
 * preceding assistant turn; `system` messages are not rendered. `generateId`
 * supplies stable ids (inject `deps.generateId` or scripted ids in tests).
 *
 * Since 1.9 each message also carries the ordered `parts` projection (in
 * canonical array order — the same order the model produced), which is what
 * makes attachments visible and lets `canonicalFromUI` invert this faithfully.
 */
export function uiFromMessages(messages: Message[], generateId: () => string): UIMessage[] {
  const ui: UIMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const ordered = uiPartsFromContent(message.content);
      ui.push({
        id: generateId(),
        role: 'user',
        content: textOf(message.content),
        ...(ordered.length > 0 ? { parts: ordered } : {}),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = typeof message.content === 'string' ? [] : message.content;
      const reasoning = parts
        .filter((p): p is Extract<Part, { type: 'reasoning' }> => p.type === 'reasoning')
        .map((p) => p.text)
        .join('');
      const toolCalls: UIToolCall[] = parts
        .filter((p): p is ToolUsePart => p.type === 'tool_use')
        .map((p) => ({
          toolCallId: p.id,
          toolName: p.name,
          input: p.input,
          state: 'call',
          // Carried so a re-POST after `canonicalFromUI` still echoes the
          // provider round-trip data (a dropped thoughtSignature 400s Gemini).
          ...(p.providerMetadata ? { providerMetadata: p.providerMetadata } : {}),
        }));
      const ordered = uiPartsFromContent(message.content);
      ui.push({
        id: generateId(),
        role: 'assistant',
        content: textOf(message.content),
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(ordered.length > 0 ? { parts: ordered } : {}),
      });
      continue;
    }
    // role 'tool': fold results into the previous assistant turn.
    const previous = ui.at(-1);
    if (!previous || previous.role !== 'assistant' || !previous.toolCalls) continue;
    const results = (typeof message.content === 'string' ? [] : message.content).filter(
      (p): p is ToolResultPart => p.type === 'tool_result',
    );
    for (const r of results) {
      const call = previous.toolCalls.find((c) => c.toolCallId === r.toolUseId);
      if (call) {
        call.state = 'result';
        call.output = r.result;
        if (r.isError) call.isError = true;
      }
    }
  }
  return ui;
}

/** Canonical content for one `UIMessage` — `parts` when present, buckets otherwise. */
function canonicalContentFromUI(message: UIMessage): string | Part[] {
  const parts: Part[] = [];
  const ordered = partsOf(message);
  if (ordered.length > 0) {
    for (const p of ordered) {
      switch (p.type) {
        case 'text':
          // An empty text block 400s some wires — drop it, do not send it.
          if (p.text) parts.push({ type: 'text', text: p.text });
          break;
        case 'reasoning':
          if (p.text) {
            parts.push({
              type: 'reasoning',
              text: p.text,
              ...(p.signature !== undefined ? { signature: p.signature } : {}),
              ...(p.encrypted ? { encrypted: true } : {}),
              ...(p.redacted ? { redacted: true } : {}),
            });
          }
          break;
        case 'tool': {
          // By id, so the call's CURRENT state (input, provider metadata) is
          // read from the one place that holds it.
          const call = (message.toolCalls ?? []).find((c) => c.toolCallId === p.toolCallId);
          if (call) parts.push(toolUseFromUI(call));
          break;
        }
        case 'file':
          parts.push({
            type: 'image',
            image: p.data,
            ...(p.mediaType ? { mediaType: p.mediaType } : {}),
          });
          break;
        default:
          // data / citation / step-start are UI channels with no canonical home.
          break;
      }
    }
  } else {
    // Pre-1.9 / hand-built shape: the buckets are all there is. Reasoning first,
    // then text, then every tool_use — provider emission order, and the order
    // `assistantMessageFromTurn` already writes.
    if (message.reasoning) parts.push({ type: 'reasoning', text: message.reasoning });
    if (message.content) parts.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) parts.push(toolUseFromUI(call));
  }
  // An all-text result collapses to the plain string form — that is what
  // `textOf`/`uiFromMessages` read back, so a text-only history round-trips
  // exactly instead of drifting into a one-element array on every pass.
  const texts = parts.filter((p): p is TextPart => p.type === 'text');
  if (texts.length === parts.length) return texts.map((p) => p.text).join('');
  return parts;
}

/**
 * Rebuild a canonical `Message[]` from the UI view — the inverse of
 * {@link uiFromMessages}. A binding that lets the app REPLACE history
 * (`setMessages`) needs it: the two views must stay coherent, and only the
 * canonical one is POSTable.
 *
 * It is LOSSY, and where it loses matters:
 *
 * SURVIVES (via the 1.9 ordered `parts`, which this prefers over the buckets):
 * - the interleave — text / reasoning / tool_use in the exact rendered order;
 * - `ImagePart` attachments, carrier verbatim (bytes stay bytes) plus media type;
 * - reasoning `signature` / `encrypted` / `redacted`;
 * - `tool_use.providerMetadata` when the UI call carries it (`uiFromMessages` does);
 * - executed tool calls, re-emitted as the `role: 'tool'` message that follows
 *   the turn — every `tool_use` MUST get a `tool_result` or Anthropic 400s.
 *
 * DOES NOT SURVIVE:
 * - SYSTEM messages. `uiFromMessages` never renders them, so nothing here can
 *   bring them back; re-prepend your system prompt yourself.
 * - `Message.providerMetadata` (message-level round-trip data) — `UIMessage` has
 *   no carrier for it.
 * - a turn WITHOUT `parts` (hand-built, or restored from a pre-1.9 store)
 *   collapses to bucket order: ONE reasoning block, then ONE text block, then
 *   every tool_use — and its attachments are gone entirely, because
 *   `UIMessage.content` is a plain string. That result is a PLAUSIBLE history,
 *   not the original one.
 * - consecutive text parts merge into one block (wires concatenate them anyway,
 *   and it is what makes the text-only round-trip exact).
 * - UI-only bookkeeping: `runState`, `denied`/`deniedReason`, pending approvals,
 *   `data-*` parts, citations, step boundaries, `warnings`, `falseFinishes`.
 * - SUB-AGENT frames, deliberately: the parent's canonical turn already carries
 *   the `agentTool` `tool_use` plus the answer it returned as that call's
 *   `tool_result`. Re-emitting a child's internals as the PARENT's parts would
 *   both misattribute them and add `tool_use` ids with no matching
 *   `tool_result` — the exact shape that 400s the next request.
 * - a tool call still awaiting its result stays a bare `tool_use` — resume it
 *   through the approval/client-tool flow, not by POSTing this.
 */
export function canonicalFromUI(ui: UIMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of ui) {
    const content = canonicalContentFromUI(message);
    if (message.role === 'user') {
      out.push({ role: 'user', content });
      continue;
    }
    out.push({ role: 'assistant', content });
    // `uiFromMessages` folded the `role: 'tool'` message INTO the turn; unfold it.
    const executed = (message.toolCalls ?? []).filter((c) => c.state === 'result');
    if (executed.length > 0) {
      out.push(
        clientToolResultMessage(
          executed.map((c) => ({
            toolCallId: c.toolCallId,
            result: c.output,
            ...(c.isError ? { isError: true } : {}),
          })),
        ),
      );
    }
  }
  return out;
}

/** A UI + canonical history pair — the two views a chat binding maintains. */
export interface ChatHistory {
  ui: UIMessage[];
  canonical: Message[];
}

/**
 * Regenerate: drop the trailing assistant/tool turns from BOTH views so the
 * last user turn runs again. Immutable — returns new arrays (a prefix of an
 * immutable history is itself a valid history). No-op when nothing trails.
 */
export function dropTrailingAssistant(history: ChatHistory): ChatHistory {
  let canonicalEnd = history.canonical.length;
  while (canonicalEnd > 0 && history.canonical[canonicalEnd - 1]!.role !== 'user') canonicalEnd--;
  let uiEnd = history.ui.length;
  while (uiEnd > 0 && history.ui[uiEnd - 1]!.role !== 'user') uiEnd--;
  return { ui: history.ui.slice(0, uiEnd), canonical: history.canonical.slice(0, canonicalEnd) };
}

/**
 * Edit-and-resend: cut BOTH views to just BEFORE the user turn holding
 * `messageId` (identified in the UI view; the canonical cut uses the user-turn
 * ordinal, so assistant/tool interleaving can never skew the pairing).
 * Returns `undefined` when `messageId` is not a user message.
 */
export function branchBeforeUserMessage(
  history: ChatHistory,
  messageId: string,
): ChatHistory | undefined {
  const uiIndex = history.ui.findIndex((m) => m.id === messageId && m.role === 'user');
  if (uiIndex === -1) return undefined;
  const ordinal = history.ui.slice(0, uiIndex).filter((m) => m.role === 'user').length;
  let seen = 0;
  let canonicalIndex = history.canonical.length;
  for (let i = 0; i < history.canonical.length; i++) {
    if (history.canonical[i]!.role === 'user') {
      if (seen === ordinal) {
        canonicalIndex = i;
        break;
      }
      seen++;
    }
  }
  return {
    ui: history.ui.slice(0, uiIndex),
    canonical: history.canonical.slice(0, canonicalIndex),
  };
}

// ===================================================================
// ChatStore — the persistence seam (P2)
// ===================================================================

export interface ChatRecord {
  chatId: string;
  /** Ownership/tenancy — REQUIRED, aligned with the memory scope model. */
  scope: MemoryScope;
  /** Full raw chat history, before model-only compaction / prepareStep rewrites. */
  messages: Message[];
  /** Branch lineage (edit-and-resend can fork a chat; optional). */
  parentId?: string;
  /** `deps.clock.now()` at save time. */
  updatedAt: number;
}

/**
 * Chat persistence seam (SessionStore pattern: implement against any backend
 * — Supabase table, Redis, fs). The loops call `saveChat` at terminal
 * boundaries when `options.chat` is set; a throwing store logs via
 * `deps.logger.error` and never kills the run. `saveChat` receives a complete
 * record containing the caller's original history plus this call's persisted
 * assistant/tool additions. On durable resume, the loops may call `loadChat`
 * once and use a scope-matching record as the persistence base.
 */
export interface ChatStore {
  saveChat(record: ChatRecord): void | Promise<void>;
  loadChat(chatId: string): ChatRecord | undefined | Promise<ChatRecord | undefined>;
  /** Optional cleanup (the loops never call it). */
  deleteChat?(chatId: string): void | Promise<void>;
  /** Optional enumeration for pickers/tooling. */
  listChats?(scope?: MemoryScope): string[] | Promise<string[]>;
}

/** In-memory reference store (single runtime). Supabase/SQLite adapters: see docs. */
export function createInMemoryChatStore(): Required<ChatStore> {
  const chats = new Map<string, ChatRecord>();
  return {
    saveChat(record) {
      chats.set(record.chatId, { ...record, messages: [...record.messages] });
    },
    loadChat(chatId) {
      return chats.get(chatId);
    },
    deleteChat(chatId) {
      chats.delete(chatId);
    },
    listChats(scope) {
      if (!scope) return [...chats.keys()];
      const entries = Object.entries(scope).filter(([, v]) => v !== undefined);
      return [...chats.values()]
        .filter((c) => entries.every(([k, v]) => c.scope[k as keyof MemoryScope] === v))
        .map((c) => c.chatId);
    },
  };
}

/** Auto-persist wiring for a call: `options.chat` (see `CommonCallOptions`). */
export interface ChatPersistOptions {
  store: ChatStore;
  chatId: string;
  scope: MemoryScope;
  /** Fork lineage recorded on the saved record. */
  parentId?: string;
}

// ===================================================================
// Binary-safe JSON codec (mirrors the durable checkpoint convention)
// ===================================================================

const BYTES_TAG = '$deuzBytes';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * JSON-serialize a `ChatRecord` with binary message parts (images) preserved
 * via the same `{ "$deuzBytes": "<base64>" }` tag the durable checkpoint
 * codec uses. Store adapters that persist to text columns should use these.
 */
export function serializeChatRecord(record: ChatRecord): string {
  return JSON.stringify(record, (_key, value) =>
    value instanceof Uint8Array ? { [BYTES_TAG]: toBase64(value) } : value,
  );
}

export function deserializeChatRecord(json: string): ChatRecord {
  return JSON.parse(json, (_key, value) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)[BYTES_TAG] === 'string'
    ) {
      // Only the codec's own encoding converts. Tool results / user text are
      // arbitrary — a payload that merely LOOKS like the tag but is not valid
      // base64 must stay plain data, never corrupt or kill the load.
      try {
        return fromBase64((value as Record<string, string>)[BYTES_TAG]!);
      } catch {
        return value;
      }
    }
    return value;
  }) as ChatRecord;
}

// ===================================================================
// Request validation (1.9) — re-exported onto this EXISTING subpath
// ===================================================================

/**
 * The structural gate in front of a client-supplied canonical history. Lives in
 * its own module (`./chat-request`) but ships on `@deuz-sdk/core/chat` because
 * it is the same subject: a route that folds `UIMessage`s here is the same route
 * that must validate the `Message[]` the browser POSTs back. Pure — no clock,
 * no randomness, no logging, `TextEncoder` only.
 */
export { validateChatRequest, parseDeuzChatRequest } from './chat-request';
export type { DeuzChatRequest, ValidateChatOptions, ValidateChatResult } from './chat-request';
