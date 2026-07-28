/**
 * useChat — the React binding over `@deuz-sdk/core/chat` + the Deuz UI wire.
 *
 * THIN by contract: every chat-state transformation is a core call
 * (`createAssistantTurn`/`applyUIPart`/`sealAssistantTurn`/
 * `assistantMessageFromTurn`/`clientToolResultMessage`/`uiFromMessages`/
 * `canonicalFromUI`/`userMessageFromInput`/`dropTrailingAssistant`/
 * `branchBeforeUserMessage`). This hook only owns React state, the fetch
 * round-trips, and abort wiring. Supersedes the frozen `@deuz-sdk/core/react`.
 *
 * 1.9 (Sprint 3) adds five things, all ADDITIVE:
 * - WRITABLE state — `setHistory`/`setMessages`/`addToolResult`/`clearError`.
 *   Deleting a rendered message, switching chats after mount, resolving a
 *   client tool from OUTSIDE the hook, and dismissing an error were all
 *   impossible before: the transcript had no setter, and a tool needing user
 *   interaction (an approve/deny UI, a wallet signature, a file picker) could
 *   only be answered from inside `onToolCall`, which DEADLOCKED the round-trip.
 * - multimodal input — `sendMessage(input: ChatInput)`, so "attach a screenshot
 *   and ask about it" works. `partsFromFiles` feeds it from a file picker.
 * - ONE React commit per fold instead of seven `setState` calls, plus optional
 *   `throttleMs` coalescing (a fast model emits hundreds of text deltas per
 *   second; each one used to re-render the whole transcript seven times).
 * - `resume.auto` — the resume machinery had no TRIGGER, so surviving a refresh
 *   mid-generation still required the app to call `reconnect()` itself.
 * - the newer wire fields reach the consumer: ordered `parts` per message,
 *   `steps`, `verifications`, reconciled `dataParts`, tool `denied`, plus the
 *   three channels the wiring pass gave producers — `warnings`, `falseFinishes`
 *   and `subAgents` (a delegated `agentTool` run used to be invisible here).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FinishReason,
  ImagePart,
  Message,
  ToolApprovalRequest,
  ToolApprovalResponse,
  Usage,
} from '@deuz-sdk/core';
import {
  applyUIPart,
  assistantMessageFromTurn,
  branchBeforeUserMessage,
  canonicalFromUI,
  clientToolResultMessage,
  createAssistantTurn,
  dropTrailingAssistant,
  filesToImageParts,
  sealAssistantTurn,
  uiFromMessages,
  userMessageFromInput,
} from '@deuz-sdk/core/chat';
import type {
  AssistantTurnState,
  ChatHistory,
  ChatInput,
  UIMessage,
  UIToolCall,
} from '@deuz-sdk/core/chat';
import type { DeuzUIPart } from '@deuz-sdk/core/ui';
import { connectDeuzStream, readDeuzStream } from '@deuz-sdk/core/ui';

/**
 * Fold one wire part via the core reducer. Current core versions preserve the
 * approval token; the defensive re-attach keeps the adapter compatible with
 * early 1.7.0 builds that dropped it while constructing the approval entry.
 */
function foldPart(
  turn: AssistantTurnState,
  part: Parameters<typeof applyUIPart>[1],
): AssistantTurnState {
  const next = applyUIPart(turn, part);
  if (part.type === 'tool-approval-request' && part.token !== undefined) {
    return {
      ...next,
      approvals: next.approvals.map((a) =>
        a.approvalId === part.approvalId && a.token === undefined ? { ...a, token: part.token } : a,
      ),
    };
  }
  return next;
}

/** Local id fallback — this package is not edge-lint-constrained. */
const defaultGenerateId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `deuz-ui-${Math.random().toString(36).slice(2)}`;

/**
 * Picked files → canonical parts for a {@link ChatInput}. A thin, null-tolerant
 * wrapper over core's `filesToImageParts`: the bytes work (Web APIs only, no
 * `FileReader`, no `Buffer`) lives THERE and is deliberately not reimplemented
 * here. `ImagePart` is the single carrier for all binary media, so images and
 * PDFs both ride this call.
 *
 * ```tsx
 * <input type="file" multiple onChange={async (e) => {
 *   const parts = await partsFromFiles(e.target.files);
 *   await sendMessage({ text: 'what is in these?', parts });
 * }} />
 * ```
 */
export async function partsFromFiles(
  files: FileList | Iterable<Blob & { type?: string }> | null | undefined,
): Promise<ImagePart[]> {
  if (!files) return [];
  // `FileList` is iterable (lib.dom), so one cast covers both shapes.
  const list: Array<Blob & { type?: string }> = Array.from(
    files as Iterable<Blob & { type?: string }>,
  );
  return list.length === 0 ? [] : filesToImageParts(list);
}

/** Live cumulative USD cost, from the wire's `cost` parts (last one wins). */
export interface UseChatCost {
  costUsd: number;
  cacheSavingsUsd?: number;
}

/** The server's budget guardrail tripped (`budget-exceeded` part). */
export interface UseChatBudgetExceeded {
  kind: 'usd' | 'tokens';
  limit: number;
  value: number;
}

/**
 * Where the resume cursor lives ACROSS a page reload.
 *
 * An adapter rather than a hardcoded `localStorage`: core's own
 * `connectDeuzStream` frames the cursor as the caller's choice, and hardcoding
 * web storage would break SSR (no `window`), React Native (no `localStorage`)
 * and privacy modes that throw on write. Both methods may throw — the hook
 * swallows it, because losing a cursor must never kill a live stream.
 */
export interface UseChatCursorStore {
  /** The persisted cursor, or `undefined` when there is nothing to resume. */
  load(): string | undefined;
  /** Persist the cursor. Called on every advance. */
  save(id: string): void;
}

export interface UseChatResumeOptions {
  /**
   * Resume endpoint (see core's `resumeDeuzStreamResponse`): a GET URL or a
   * factory returning the `Response` for a given cursor. Do NOT point it at
   * the generating POST route — that would re-run the model.
   */
  endpoint: string | ((ctx: { lastEventId?: string }) => Response | Promise<Response>);
  /** Cursor to resume from (e.g. persisted across a page reload). */
  lastEventId?: string;
  /**
   * Attempt `reconnect()` ONCE per mounted hook — the canonical scenario
   * resumability exists for (the user refreshes mid-generation) with zero app
   * wiring. Fires exactly once under React 18/19 StrictMode's deliberate
   * mount → unmount → mount double-invoke.
   *
   * An AUTOMATIC attempt that fails is NOT an error state and does NOT reach
   * `onError`: the user did not ask for it, and every cold load of a chat app
   * whose resume endpoint answers 404 (nothing in flight) would otherwise paint
   * a permanent error. A caught-up endpoint (immediate `[DONE]`) is a silent
   * no-op — no bubble, no state change. Call `reconnect()` yourself when you
   * want the failure surfaced.
   */
  auto?: boolean;
  /** Cursor persistence adapter (see {@link UseChatCursorStore}). */
  cursor?: UseChatCursorStore;
}

export interface UseChatOptions {
  /** Endpoint serving `toDeuzStreamResponse` output. */
  api: string;
  /**
   * Seed canonical history (e.g. restored from a ChatStore) — rendered via
   * `uiFromMessages`.
   *
   * READ ONCE, at mount, like any `useState` initial value. It is deliberately
   * NOT re-adopted when the prop changes: apps pass an inline array literal, so
   * a new identity arrives on EVERY render and adopting it would reset the
   * transcript continuously — and mid-stream it would clobber the turn being
   * folded. Switching chats or hydrating later is an explicit action: call
   * `setHistory` (both views) or `setMessages` (re-derives canonical).
   */
  initialMessages?: Message[];
  headers?: Record<string, string>;
  /** Extra fields merged into every request body. */
  body?: Record<string, unknown>;
  /** Chat identity — merged into every request body (server-side ChatStore persistence). */
  chatId?: string;
  /** Enables `reconnect()` / `resume.auto` against a resume endpoint (wire v2). */
  resume?: UseChatResumeOptions;
  /** Id source for UI messages/turns. Default: `crypto.randomUUID` (with a fallback). */
  generateId?: () => string;
  /**
   * Coalesce React commits to at most one per `throttleMs` (trailing edge).
   * Default `0` — commit on every wire part, exactly as 1.8 did.
   *
   * A fast model emits hundreds of text deltas per second; with markdown
   * rendering over a long transcript that visibly janks. The terminal frame is
   * ALWAYS flushed (stream end, error, abort, an external tool result), so the
   * final text can never be lost to coalescing. A plain `setTimeout` is fine
   * here: unlike core's `src/**`, this package is not edge-lint-constrained and
   * has no `deps.clock` seam.
   */
  throttleMs?: number;
  /**
   * Client-tool executor: called for every streamed tool call the SERVER did
   * not execute. The return value is appended as its tool_result and the chat
   * auto-continues; a throw self-heals as an is_error result.
   *
   * OMIT it to drive client tools from outside the hook instead: the
   * round-trip PARKS, the calls appear in `pendingToolCalls`, and
   * `addToolResult` answers them.
   */
  onToolCall?: (call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => Promise<unknown> | unknown;
  /**
   * Fired for every `data-{name}` part as it arrives, BEFORE reconciliation —
   * so a caller sees each intermediate write of an addressable `(name, id)`
   * entry, which `dataParts` collapses to the last one. A throw is swallowed
   * (G2: a consumer callback is not a transport error).
   */
  onData?: (data: { name: string; id?: string; payload: unknown }) => void;
  onError?: (error: Error) => void;
  /**
   * How a NON-2xx response from `api` is reported (default `'error-part'`: the
   * failure becomes `status: 'error'` instead of an empty assistant bubble).
   * Forwarded verbatim to core's `readDeuzStream`.
   */
  onHttpError?: 'error-part' | 'ignore';
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface UseChatResult {
  /** The render view. Each message carries its ordered `parts` (1.9) when it has any. */
  messages: UIMessage[];
  /**
   * BOTH views in one object (`{ ui, canonical }`). Only the canonical one is
   * POSTable and only it survives a round-trip through a provider, so an app
   * that persists a chat should persist `history.canonical`. Identity is stable
   * until either view changes.
   */
  history: ChatHistory;
  status: 'idle' | 'streaming' | 'error';
  error: Error | undefined;
  /** Gated tool calls awaiting verdicts — the chat is PAUSED while non-empty. */
  pendingApprovals: ToolApprovalRequest[];
  /**
   * Client tool calls the round-trip is PARKED on (no `onToolCall` executor).
   * Answer each with `addToolResult`; the chat continues once all are answered.
   */
  pendingToolCalls: UIToolCall[];
  /** Live cumulative cost from the wire's `cost` parts (last one wins). */
  cost?: UseChatCost;
  /** Set when the server's budget guardrail tripped this turn. */
  budgetExceeded?: UseChatBudgetExceeded;
  /**
   * This turn's app-defined `data-{name}` parts. Entries written with an `id`
   * are RECONCILED by `(name, id)` — one live status widget stays one entry, at
   * its original position — while id-less entries stay append-only (1.7/1.8).
   */
  dataParts: Array<{ name: string; id?: string; payload: unknown }>;
  /** This turn's RAG citations. */
  citations: AssistantTurnState['citations'];
  /** Latest live plan snapshot for this turn (autonomous runs, 1.8). */
  plan?: AssistantTurnState['plan'];
  /** This turn's live activity feed ("Computer" view, 1.8). */
  activity: AssistantTurnState['activity'];
  /** This turn's `verifyStep` verdicts, in arrival order (1.9). */
  verifications?: AssistantTurnState['verifications'];
  /**
   * Non-fatal execution notices for this turn, in arrival order (1.9): a
   * sampling param the wire could not carry, a clamped ceiling, an unknown model
   * slug served from the conservative fallback row. Render them as a dismissible
   * banner — the run itself succeeded.
   */
  warnings?: AssistantTurnState['warnings'];
  /**
   * `false-finish` rejections for this turn (1.9): the server's guard decided
   * the work was not actually done. A trailing entry with `willRetry: false`
   * means the guard's budget ran out, so the answer on screen is the one it
   * stopped on rather than one it was happy with.
   */
  falseFinishes?: AssistantTurnState['falseFinishes'];
  /**
   * Live sub-agent (`agentTool`) frames for this turn, one per `agentPath`
   * (1.9). Each holds the child's OWN turn — its text, ordered `parts` and tool
   * cards — so a delegated run is renderable instead of invisible, and
   * `afterPart` says where in the parent's `parts` it belongs. Nothing here is
   * mixed into the parent's `content`: a sub-agent's words are its own.
   */
  subAgents?: AssistantTurnState['subAgents'];
  /** Per-step usage/finish from `step-finish` parts, in arrival order (1.9). */
  steps?: AssistantTurnState['steps'];
  /** Terminal token usage for this turn, from the wire's `finish` part (1.9). */
  usage?: Usage;
  /** Terminal finish reason (1.9) — `'length'` means the answer was truncated. */
  finishReason?: FinishReason;
  /**
   * Send one user turn: plain text (1.8-identical, including the canonical
   * `content` string) or text plus canonical parts — images/PDFs from
   * {@link partsFromFiles}, `imagePart`/`filePart`, anything the wires accept.
   */
  sendMessage: (input: ChatInput) => Promise<void>;
  /** Abort the in-flight stream (not an error). */
  stop: () => void;
  /** Drop the trailing assistant/tool turns (core `dropTrailingAssistant`) and re-run. */
  regenerate: () => Promise<void>;
  /** Cut history before `messageId` (core `branchBeforeUserMessage`) and send `input`. */
  editAndResend: (messageId: string, input: ChatInput) => Promise<void>;
  /**
   * Replace BOTH views in one commit — the honest primitive, because Deuz keeps
   * two of them and only the canonical one is POSTable. Use it to switch chats,
   * hydrate after mount, or delete/edit a rendered message while keeping a
   * system prompt and provider round-trip data that the UI view cannot carry.
   *
   * Pending gates (approvals, parked client tool calls) are DROPPED: they were
   * anchored to the transcript you just replaced.
   */
  setHistory: (update: ChatHistory | ((prev: ChatHistory) => ChatHistory)) => void;
  /**
   * Sugar over `setHistory`: re-derives the canonical view with core's
   * `canonicalFromUI`. That inverse projection is LOSSY — system messages,
   * `Message.providerMetadata` and UI-only state do not survive it, and a
   * message without ordered `parts` loses its attachments entirely — so drive
   * `setHistory` directly when your history has any of those.
   */
  setMessages: (update: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  /**
   * Answer ONE parked client tool call from outside the hook. Feeds the exact
   * path `onToolCall`'s return value takes (core `clientToolResultMessage`), so
   * the chat auto-continues once every call in `pendingToolCalls` is answered.
   * A result for an id that is not parked is ignored — an orphan `tool_result`
   * would 400 the next request.
   */
  addToolResult: (result: {
    toolCallId: string;
    output: unknown;
    isError?: boolean;
  }) => Promise<void>;
  /** Dismiss the error: `status: 'error'` → `'idle'`. Leaves a live stream alone. */
  clearError: () => void;
  /**
   * Record one verdict (the request's signed `token` is auto-preserved). Once
   * EVERY pending approval has a verdict, the chat auto-resumes with
   * `approvalResponses` in the request body.
   */
  addToolApprovalResponse: (response: ToolApprovalResponse) => Promise<void>;
  /**
   * Re-read the stream from `resume.endpoint` via `connectDeuzStream` and fold
   * the parts into the current turn. No-op unless `options.resume` is set.
   */
  reconnect: () => Promise<void>;
}

/**
 * ONE React state cell (3.4a). 1.8 held eight — `messages` plus a `useState`
 * per readout — and `syncTurn` set seven of them on EVERY wire part, so a fast
 * model re-rendered the whole transcript several times per token. Collapsing
 * them costs nothing and makes the two history views structurally inseparable:
 * `ui` and `canonical` are published in the SAME commit, so no render can ever
 * see one of them a frame behind the other.
 */
interface ChatSnapshot {
  history: ChatHistory;
  cost?: UseChatCost;
  budgetExceeded?: UseChatBudgetExceeded;
  dataParts: Array<{ name: string; id?: string; payload: unknown }>;
  citations: AssistantTurnState['citations'];
  plan?: AssistantTurnState['plan'];
  activity: AssistantTurnState['activity'];
  verifications?: AssistantTurnState['verifications'];
  warnings?: AssistantTurnState['warnings'];
  falseFinishes?: AssistantTurnState['falseFinishes'];
  subAgents?: AssistantTurnState['subAgents'];
  steps?: AssistantTurnState['steps'];
  usage?: Usage;
  finishReason?: FinishReason;
}

/**
 * Cursor persistence is the CALLER's: a throwing adapter (a quota-exceeded
 * private-mode write, storage disabled) must never kill a live stream.
 */
function loadCursor(resume: UseChatResumeOptions): string | undefined {
  try {
    return resume.cursor?.load();
  } catch {
    return undefined;
  }
}

function saveCursor(resume: UseChatResumeOptions, id: string): void {
  try {
    resume.cursor?.save(id);
  } catch {
    /* a persistence failure is not a transport failure */
  }
}

export function useChat(options: UseChatOptions): UseChatResult {
  const genId = options.generateId ?? defaultGenerateId;
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(() => ({
    history: {
      ui: uiFromMessages(options.initialMessages ?? [], genId),
      canonical: options.initialMessages ? [...options.initialMessages] : [],
    },
    dataParts: [],
    citations: [],
    activity: [],
  }));
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<Error | undefined>(undefined);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const [pendingToolCalls, setPendingToolCalls] = useState<UIToolCall[]>([]);

  /** Authoritative snapshot: replaced (never mutated) by `commit`, published to React by `publish`. */
  const snapshotRef = useRef<ChatSnapshot>(snapshot);
  /** The in-flight turn — kept across a drop so `reconnect()` can continue it. */
  const turnRef = useRef<AssistantTurnState | undefined>(undefined);
  /** The turn PARKED on client tool results, so `addToolResult` folds into the same one. */
  const parkedTurnRef = useRef<AssistantTurnState | undefined>(undefined);
  const clientToolsRef = useRef<UIToolCall[]>([]);
  const toolResultsRef = useRef<Array<{ toolCallId: string; result: unknown; isError?: boolean }>>(
    [],
  );
  const approvalsRef = useRef<ToolApprovalRequest[]>([]);
  const verdictsRef = useRef<ToolApprovalResponse[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string | undefined>(options.resume?.lastEventId);
  /**
   * Id of the turn's message AS IT SITS in `ui`. The wire's `start` part
   * RENAMES the message (`applyUIPart`), so the id is not stable across a turn
   * — tracking the last published one lets `syncTurn` address the turn by
   * identity instead of by position. That is what makes `setMessages` safe
   * mid-stream: 1.8 spliced the LAST element blindly, so replacing the
   * transcript under a live stream clobbered whatever the app had put there.
   */
  const placedIdRef = useRef<string | undefined>(undefined);

  // --- Commit plumbing: one React update per fold, optionally coalesced ---

  const throttleMs = options.throttleMs ?? 0;
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirtyRef = useRef(false);

  const publish = useCallback((): void => {
    flushTimerRef.current = undefined;
    dirtyRef.current = false;
    setSnapshot(snapshotRef.current);
  }, []);

  /** Record a new snapshot; publish it now, or on the trailing edge of `throttleMs`. */
  const commit = useCallback(
    (next: ChatSnapshot): void => {
      snapshotRef.current = next;
      if (throttleMs <= 0) {
        publish();
        return;
      }
      dirtyRef.current = true;
      if (flushTimerRef.current === undefined) {
        flushTimerRef.current = setTimeout(publish, throttleMs);
      }
    },
    [throttleMs, publish],
  );

  /** Force the pending frame out. Every terminal boundary calls this. */
  const flush = useCallback((): void => {
    if (flushTimerRef.current !== undefined) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = undefined;
    }
    if (dirtyRef.current) publish();
  }, [publish]);

  /** A coalesced frame must not fire into an unmounted tree. */
  useEffect(
    () => () => {
      if (flushTimerRef.current !== undefined) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  /** Sync ALL turn-derived state in ONE commit. */
  const syncTurn = useCallback(
    (turn: AssistantTurnState): void => {
      const previous = snapshotRef.current;
      const placed = placedIdRef.current;
      const ui = previous.history.ui;
      const index = placed === undefined ? -1 : ui.findIndex((m) => m.id === placed);
      placedIdRef.current = turn.message.id;
      commit({
        ...previous,
        history: {
          // NEW array either way — the turn's message is never spliced in place.
          ui:
            index === -1
              ? [...ui, turn.message]
              : [...ui.slice(0, index), turn.message, ...ui.slice(index + 1)],
          canonical: previous.history.canonical,
        },
        // `cost` is CUMULATIVE for the chat, so an absent reading keeps the
        // previous one (1.7 behaviour, verbatim); every other readout is
        // turn-scoped and resets when the turn does.
        cost:
          turn.costUsd !== undefined
            ? {
                costUsd: turn.costUsd,
                ...(turn.cacheSavingsUsd !== undefined
                  ? { cacheSavingsUsd: turn.cacheSavingsUsd }
                  : {}),
              }
            : previous.cost,
        budgetExceeded: turn.budgetExceeded,
        dataParts: turn.dataParts,
        citations: turn.citations,
        plan: turn.plan,
        activity: turn.activity,
        verifications: turn.verifications,
        warnings: turn.warnings,
        falseFinishes: turn.falseFinishes,
        subAgents: turn.subAgents,
        steps: turn.steps,
        usage: turn.usage,
        finishReason: turn.finishReason,
      });
    },
    [commit],
  );

  /** Append to the canonical view. NEW array — never a splice (immutable history). */
  const appendCanonical = useCallback(
    (message: Message): void => {
      const previous = snapshotRef.current;
      commit({
        ...previous,
        history: {
          ui: previous.history.ui,
          canonical: [...previous.history.canonical, message],
        },
      });
    },
    [commit],
  );

  /** Drop every parked gate — the turn they belonged to is no longer current. */
  const clearGates = useCallback((): void => {
    approvalsRef.current = [];
    verdictsRef.current = [];
    clientToolsRef.current = [];
    toolResultsRef.current = [];
    parkedTurnRef.current = undefined;
    setPendingApprovals([]);
    setPendingToolCalls([]);
  }, []);

  /** Core reducer + the `onData` notification (the only side channel the fold has). */
  const fold = useCallback(
    (turn: AssistantTurnState, part: DeuzUIPart): AssistantTurnState => {
      const next = foldPart(turn, part);
      const onData = options.onData;
      if (onData && typeof part.type === 'string' && part.type.startsWith('data-')) {
        const data = part as Extract<DeuzUIPart, { payload: unknown }>;
        try {
          onData({
            name: data.type.slice('data-'.length),
            ...(typeof data.id === 'string' ? { id: data.id } : {}),
            payload: data.payload,
          });
        } catch {
          /* G2: a consumer callback is not a transport error */
        }
      }
      return next;
    },
    [options.onData],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (approvalResponses?: ToolApprovalResponse[]): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('streaming');
      setError(undefined);
      try {
        // One iteration per model round; client-tool results loop back in.
        for (;;) {
          const doFetch = options.fetch ?? fetch;
          const res = await doFetch(options.api, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...options.headers },
            body: JSON.stringify({
              messages: snapshotRef.current.history.canonical,
              ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
              ...(approvalResponses?.length ? { approvalResponses } : {}),
              ...options.body,
            }),
            signal: controller.signal,
          });
          approvalResponses = undefined; // consumed by the first round only

          let turn = createAssistantTurn(genId());
          turnRef.current = turn;
          placedIdRef.current = undefined; // a fresh turn owns no slot yet
          syncTurn(turn); // appends the bubble AND resets this-turn state
          flush(); // "thinking" feedback must never wait on a throttle window

          // A non-2xx route (500 + an HTML error page, 401, 429) yields a
          // single `error` part → turn.error → the throw below → status 'error'.
          // Before 1.9 it streamed nothing and rendered an empty bubble.
          for await (const part of readDeuzStream(res, {
            ...(options.onHttpError ? { onHttpError: options.onHttpError } : {}),
          })) {
            turn = fold(turn, part);
            turnRef.current = turn;
            syncTurn(turn);
          }
          // A stream that ended WITHOUT `finish`/`error` (a dropped connection)
          // leaves the tail text/reasoning part 'streaming' by design — that
          // boundary belongs to the binding, so close it here. Returns the SAME
          // object when there is nothing to seal, hence no wasted render.
          const sealed = sealAssistantTurn(turn);
          if (sealed !== turn) {
            turn = sealed;
            turnRef.current = turn;
            syncTurn(turn);
          }
          flush(); // terminal frame — never coalesced away
          if (turn.error !== undefined) throw new Error(turn.error);

          // Append the canonical assistant turn (client-tools reconstruction).
          appendCanonical(assistantMessageFromTurn(turn));
          turnRef.current = undefined;

          // Approval pause: verdicts arrive via addToolApprovalResponse.
          if (turn.approvals.length > 0) {
            approvalsRef.current = turn.approvals;
            verdictsRef.current = [];
            setPendingApprovals(turn.approvals);
            return;
          }

          // Client tools: everything the server didn't execute.
          const toolCalls = turn.message.toolCalls ?? [];
          const serverResults = new Set(turn.serverResults);
          const clientPending = toolCalls.filter((t) => !serverResults.has(t.toolCallId));
          if (clientPending.length === 0) return;
          if (!options.onToolCall) {
            // No in-hook executor: PARK the round-trip instead of abandoning
            // it. 1.8 returned here and the `tool_use` never got its
            // `tool_result`, so a tool that needs user interaction was
            // unanswerable. `addToolResult` folds the verdicts into THIS turn.
            parkedTurnRef.current = turn;
            clientToolsRef.current = clientPending;
            toolResultsRef.current = [];
            setPendingToolCalls(clientPending);
            return;
          }
          const results: Array<{ toolCallId: string; result: unknown; isError?: boolean }> = [];
          for (const call of clientPending) {
            try {
              const out = await options.onToolCall({
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              });
              results.push({ toolCallId: call.toolCallId, result: out });
              turn = applyUIPart(turn, {
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: out,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              results.push({ toolCallId: call.toolCallId, result: message, isError: true });
              turn = applyUIPart(turn, {
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: message,
                isError: true,
              });
            }
            syncTurn(turn);
          }
          appendCanonical(clientToolResultMessage(results));
          // loop → next round POSTs the extended history
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // User abort — not an error. No `finish` arrived, so the tail part is
          // still 'streaming'; sealing it is the binding's job (see core's
          // `sealAssistantTurn` docstring).
          const open = turnRef.current;
          if (open) {
            const sealed = sealAssistantTurn(open);
            turnRef.current = sealed;
            if (sealed !== open) syncTurn(sealed);
          }
          return;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus('error');
        options.onError?.(e);
        return;
      } finally {
        setStatus((s) => (s === 'error' ? s : 'idle'));
        flush(); // every exit path publishes the last frame
      }
    },
    [
      options.api,
      options.fetch,
      options.headers,
      options.body,
      options.chatId,
      options.generateId,
      options.onToolCall,
      options.onError,
      options.onHttpError,
      appendCanonical,
      fold,
      flush,
      syncTurn,
    ],
  );

  const sendMessage = useCallback(
    async (input: ChatInput): Promise<void> => {
      // ONE core projection feeds both views, so the user bubble carries its
      // ordered `parts` (incl. `file` elements for attachments) with no
      // React-side message building. A bare string is byte-identical to 1.8:
      // `userMessageFromInput` keeps `content` a plain STRING, so a prompt-cache
      // prefix does not move when a caller upgrades.
      const message = userMessageFromInput(input);
      const bubble = uiFromMessages([message], genId)[0];
      const previous = snapshotRef.current;
      commit({
        ...previous,
        history: {
          ui: bubble ? [...previous.history.ui, bubble] : previous.history.ui,
          canonical: [...previous.history.canonical, message],
        },
      });
      clearGates();
      flush();
      await run();
    },
    [run, commit, clearGates, flush, options.generateId],
  );

  const regenerate = useCallback(async (): Promise<void> => {
    const previous = snapshotRef.current;
    commit({ ...previous, history: dropTrailingAssistant(previous.history) });
    clearGates();
    flush();
    await run();
  }, [run, commit, clearGates, flush]);

  const editAndResend = useCallback(
    async (messageId: string, input: ChatInput): Promise<void> => {
      const previous = snapshotRef.current;
      const cut = branchBeforeUserMessage(previous.history, messageId);
      if (!cut) return; // not a user message — nothing to branch
      commit({ ...previous, history: cut });
      clearGates();
      flush();
      await sendMessage(input);
    },
    [sendMessage, commit, clearGates, flush],
  );

  const setHistory = useCallback(
    (update: ChatHistory | ((prev: ChatHistory) => ChatHistory)): void => {
      const previous = snapshotRef.current;
      const next = typeof update === 'function' ? update(previous.history) : update;
      // Replace BOTH views WHOLESALE, in ONE commit. Never splice the canonical
      // array in place: the loops and prompt caching depend on prior arrays
      // staying stable (immutable history). `placedIdRef` is left alone — it is
      // only a lookup key, and `syncTurn` appends when the id is gone, so a
      // live turn survives a replacement that keeps it and re-appends when not.
      commit({
        ...previous,
        history: { ui: [...next.ui], canonical: [...next.canonical] },
      });
      clearGates();
      flush();
    },
    [commit, clearGates, flush],
  );

  const setMessages = useCallback(
    (update: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])): void => {
      setHistory((prev) => {
        const ui = typeof update === 'function' ? update(prev.ui) : update;
        return { ui, canonical: canonicalFromUI(ui) };
      });
    },
    [setHistory],
  );

  const clearError = useCallback((): void => {
    setError(undefined);
    // Only the terminal error state is dismissible — a live stream is not.
    setStatus((s) => (s === 'error' ? 'idle' : s));
  }, []);

  const addToolResult = useCallback(
    async (result: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void> => {
      const parked = clientToolsRef.current;
      const call = parked.find((c) => c.toolCallId === result.toolCallId);
      // Nothing parked under that id: ignore. An orphan `tool_result` (one with
      // no matching `tool_use`) 400s the next request, so it must never be
      // POSTed — same invariant the core tool loop enforces server-side.
      if (!call) return;
      toolResultsRef.current = [
        ...toolResultsRef.current.filter((r) => r.toolCallId !== result.toolCallId),
        {
          toolCallId: result.toolCallId,
          result: result.output,
          ...(result.isError ? { isError: true } : {}),
        },
      ];
      const turn = parkedTurnRef.current;
      if (turn) {
        // Same reducer path the in-hook executor takes, so the card renders
        // 'result' identically whichever side answered it.
        const next = applyUIPart(turn, {
          type: 'tool-result',
          toolCallId: result.toolCallId,
          toolName: call.toolName,
          output: result.output,
          ...(result.isError ? { isError: true } : {}),
        });
        parkedTurnRef.current = next;
        syncTurn(next);
        flush(); // a user action, not a stream delta — show it now
      }
      const answered = toolResultsRef.current;
      if (!parked.every((c) => answered.some((r) => r.toolCallId === c.toolCallId))) return;
      clientToolsRef.current = [];
      toolResultsRef.current = [];
      parkedTurnRef.current = undefined;
      setPendingToolCalls([]);
      appendCanonical(clientToolResultMessage(answered));
      await run();
    },
    [run, appendCanonical, syncTurn, flush],
  );

  const addToolApprovalResponse = useCallback(
    async (response: ToolApprovalResponse): Promise<void> => {
      // Preserve the request's signed token unless the caller set one.
      const request = approvalsRef.current.find((p) => p.approvalId === response.approvalId);
      const verdict =
        response.token === undefined && request?.token !== undefined
          ? { ...response, token: request.token }
          : response;
      verdictsRef.current = [
        ...verdictsRef.current.filter((v) => v.approvalId !== verdict.approvalId),
        verdict,
      ];
      const verdicts = verdictsRef.current;
      const allSettled = approvalsRef.current.every((p) =>
        verdicts.some((v) => v.approvalId === p.approvalId),
      );
      if (!allSettled) return;
      approvalsRef.current = [];
      verdictsRef.current = [];
      setPendingApprovals([]);
      await run(verdicts);
    },
    [run],
  );

  /**
   * The resume read. `silent` marks the AUTOMATIC on-mount attempt: a failure
   * there is invisible (see `resume.auto`), because nothing the user did failed
   * and a dead endpoint would otherwise paint an error on every cold load.
   */
  const runResume = useCallback(
    async (silent: boolean): Promise<void> => {
      const resume = options.resume;
      if (!resume) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('streaming');
      setError(undefined);
      let folded = 0;
      try {
        // In-memory cursor (this session's stream, or `resume.lastEventId`)
        // beats the persisted one — it is strictly the more recent of the two.
        const cursor = lastEventIdRef.current ?? loadCursor(resume);
        const inFlight = turnRef.current;
        let turn = inFlight;
        if (turn === undefined || cursor === undefined) {
          // No cursor → full replay rebuilds the turn from the start. It takes
          // the place of a partial turn already on screen (`placedIdRef` keeps
          // pointing at it); with nothing on screen the turn stays UNPLACED
          // until the first part arrives, so a caught-up endpoint answering
          // `[DONE]` immediately is a silent no-op rather than an empty bubble.
          if (inFlight === undefined) placedIdRef.current = undefined;
          turn = createAssistantTurn(genId());
        }
        turnRef.current = turn;
        const parts = connectDeuzStream(resume.endpoint, {
          ...(cursor !== undefined ? { lastEventId: cursor } : {}),
          onCursor: (id) => {
            lastEventIdRef.current = id;
            saveCursor(resume, id);
          },
          signal: controller.signal,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
        });
        for await (const part of parts) {
          folded++;
          turn = fold(turn, part);
          turnRef.current = turn;
          syncTurn(turn);
        }
        if (folded === 0) {
          // Already caught up: nothing arrived, so nothing changed and nothing
          // may be appended to the canonical history (an empty assistant
          // message would poison the next request). Not an error. The turn we
          // speculatively created is discarded; a real in-flight one is kept
          // (sealed — no `finish` is coming for it now).
          turnRef.current = inFlight === undefined ? undefined : sealAssistantTurn(inFlight);
          return;
        }
        const sealed = sealAssistantTurn(turn);
        if (sealed !== turn) {
          turn = sealed;
          syncTurn(turn);
        }
        turnRef.current = turn;
        if (turn.error !== undefined) throw new Error(turn.error);
        appendCanonical(assistantMessageFromTurn(turn));
        turnRef.current = undefined;
        if (turn.approvals.length > 0) {
          approvalsRef.current = turn.approvals;
          verdictsRef.current = [];
          setPendingApprovals(turn.approvals);
        }
      } catch (err) {
        if (controller.signal.aborted) return; // user abort — not an error
        if (silent) return; // best-effort auto attempt — invisible by contract
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus('error');
        options.onError?.(e);
        return;
      } finally {
        setStatus((s) => (s === 'error' ? s : 'idle'));
        flush();
      }
    },
    [
      options.resume,
      options.fetch,
      options.headers,
      options.generateId,
      options.onError,
      appendCanonical,
      fold,
      flush,
      syncTurn,
    ],
  );

  const reconnect = useCallback((): Promise<void> => runResume(false), [runResume]);

  /**
   * `resume.auto`: ONE attempt per mounted hook. The ref guard is what makes
   * React 18/19 StrictMode's deliberate mount → unmount → mount effect
   * double-invoke fire a single request — refs survive it, an effect body does
   * not. Deliberately not undone on cleanup for exactly that reason.
   */
  const autoResumedRef = useRef(false);
  useEffect(() => {
    if (options.resume?.auto !== true || autoResumedRef.current) return;
    autoResumedRef.current = true;
    void runResume(true);
  }, [options.resume?.auto, runResume]);

  return {
    messages: snapshot.history.ui,
    history: snapshot.history,
    status,
    error,
    pendingApprovals,
    pendingToolCalls,
    ...(snapshot.cost !== undefined ? { cost: snapshot.cost } : {}),
    ...(snapshot.budgetExceeded !== undefined ? { budgetExceeded: snapshot.budgetExceeded } : {}),
    dataParts: snapshot.dataParts,
    citations: snapshot.citations,
    ...(snapshot.plan !== undefined ? { plan: snapshot.plan } : {}),
    activity: snapshot.activity,
    ...(snapshot.verifications !== undefined ? { verifications: snapshot.verifications } : {}),
    ...(snapshot.warnings !== undefined ? { warnings: snapshot.warnings } : {}),
    ...(snapshot.falseFinishes !== undefined ? { falseFinishes: snapshot.falseFinishes } : {}),
    ...(snapshot.subAgents !== undefined ? { subAgents: snapshot.subAgents } : {}),
    ...(snapshot.steps !== undefined ? { steps: snapshot.steps } : {}),
    ...(snapshot.usage !== undefined ? { usage: snapshot.usage } : {}),
    ...(snapshot.finishReason !== undefined ? { finishReason: snapshot.finishReason } : {}),
    sendMessage,
    stop,
    regenerate,
    editAndResend,
    setHistory,
    setMessages,
    addToolResult,
    clearError,
    addToolApprovalResponse,
    reconnect,
  };
}
