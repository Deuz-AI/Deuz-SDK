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
 *
 * 2.3 fixes two settlement holes, no API change:
 * - F06 — a verdict resumes the chat only when it answers the gate the chat is
 *   paused on. One with nothing pending (a double click, a stale card, another
 *   run's verdict) used to POST a fresh round and render an empty bubble.
 * - F07 — a turn read back through `reconnect()` settles exactly like one read
 *   from the POST (`settleTurn`). Its unresolved client calls used to reach
 *   neither `onToolCall` nor `pendingToolCalls`; and a call the replay
 *   re-delivers after this client answered it is not dispatched again. A
 *   result settles only the call or gate that came before it, so a provider
 *   that recycles call ids (`tool_0` in every response) keeps a later one open.
 *
 * 2.3 also drives a NATIVE agent route (`toDeuzAgentStreamResponse` over
 * `streamAgent` / `resumeStreamAgent`), additively: core's `applyUIPart` folds
 * the route's `data-agent` frames into `turn.agent`, and when that state says
 * the run is suspended, its terminal frame is the authority on what it waits
 * for. The hook then answers with the run's id, and with every verdict and
 * every client result in ONE request (`runId`, `approvalResponses`,
 * `clientToolResults`), because a native resume proceeds only with all of
 * them. A chat route never sends a frame, so its requests are unchanged. No
 * new core export is imported: with a core older than 2.3 there is no
 * `turn.agent`, and the hook behaves as before.
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

/**
 * Verdict ↔ request identity (2.3): the approval id plus the request's signed
 * token. A RECORDED verdict always carries its request's exact token, so this
 * pairs the two one-to-one.
 */
function sameTarget(
  a: { approvalId: string; token?: string },
  b: { approvalId: string; token?: string },
): boolean {
  return a.approvalId === b.approvalId && a.token === b.token;
}

/**
 * Does the caller's verdict answer `request`? (2.3, F06.) The approval id must
 * match and, when the verdict carries a signed token, it must be THIS
 * request's token: a token is minted per run and call (`createApprovalSigner`),
 * so a different one means the verdict was issued for another run — a card
 * left over from an earlier turn, or another chat whose provider recycled the
 * same call id.
 */
function answersRequest(verdict: ToolApprovalResponse, request: ToolApprovalRequest): boolean {
  return (
    verdict.approvalId === request.approvalId &&
    (verdict.token === undefined || verdict.token === request.token)
  );
}

/** One request delivered twice (a repeated frame), as opposed to two calls sharing an id. */
function sameRequest(a: ToolApprovalRequest, b: ToolApprovalRequest): boolean {
  return (
    sameTarget(a, b) &&
    a.toolCallId === b.toolCallId &&
    (a.agentPath ?? []).join('\u0000') === (b.agentPath ?? []).join('\u0000')
  );
}

/**
 * What a resume read saw in ARRIVAL order (2.3), which the reducer's state
 * cannot tell: it merges the calls that share an id into one entry, and a
 * provider without call ids gets `tool_0`, `tool_1`, … from core's adapter
 * afresh in every model response, so one id can name several calls of one
 * exchange. Kept with the cursor turn (`cursorLedgerRef`), so a turn continued
 * from the cursor carries it across reads.
 */
interface ReplayLedger {
  /** Indexes into the turn's `approvals` whose call got a result AFTER the request. */
  readonly answeredApprovals: Set<number>;
  /** Per invocation key (`invocationKey`): how many finished legs delivered that call. */
  readonly legs: Map<string, number>;
  /** Invocation keys of the calls the current, unfinished leg delivered. */
  readonly openLeg: Set<string>;
  /** The cursor the turn's first read sent. */
  readonly cursor: string | undefined;
  /**
   * Whether the endpoint resumed AFTER that cursor: the first event id it
   * delivered is a later one. Unknown until an id arrives, and unknown (no id,
   * no cursor, ids that are not sequence numbers) counts as no.
   */
  afterCursor?: boolean;
}

const newLedger = (cursor?: string): ReplayLedger => ({
  answeredApprovals: new Set(),
  legs: new Map(),
  openLeg: new Set(),
  cursor,
});

/** Note one wire part of a resume read, BEFORE it folds into `turn`. */
function recordPart(ledger: ReplayLedger, turn: AssistantTurnState, part: DeuzUIPart): void {
  switch (part.type) {
    case 'tool-result':
      // A result settles the requests that came before it, never a later one
      // that reuses its call id.
      turn.approvals.forEach((request, index) => {
        if (request.toolCallId === part.toolCallId) ledger.answeredApprovals.add(index);
      });
      return;
    case 'tool-call':
      // Once per leg: a frame the wire repeats is one delivery.
      ledger.openLeg.add(invocationKey(part.toolCallId, part.toolName, part.input));
      return;
    case 'finish':
      // Every leg ends with one, and a replay sails through leg boundaries.
      for (const key of ledger.openLeg) ledger.legs.set(key, (ledger.legs.get(key) ?? 0) + 1);
      ledger.openLeg.clear();
      return;
  }
}

/** How many legs of a replayed turn delivered the call: at least once, as it is in the turn. */
const deliveries = (ledger: ReplayLedger, key: string): number =>
  Math.max(1, (ledger.legs.get(key) ?? 0) + (ledger.openLeg.has(key) ? 1 : 0));

/** Whether event id `id` comes after `cursor`; no when either is not a sequence number. */
function isLaterId(id: string, cursor: string | undefined): boolean {
  return (
    cursor !== undefined && /^\d+$/.test(id) && /^\d+$/.test(cursor) && Number(id) > Number(cursor)
  );
}

const NO_INDEXES: ReadonlySet<number> = new Set();

/**
 * The approvals a settled turn actually PAUSES on (2.3). `turn.approvals` is
 * the reducer's raw arrival log, so it keeps a request the wire repeated —
 * one question, asked once: the latest delivery stands for it. On a REPLAY it
 * can also hold a request whose call already has its result (`answered`): a
 * journal that spans an approval leg and the continuation that settled it
 * folds both into one turn, and an executed call cannot be approved again.
 * Only a result that arrived after the request settles it: an earlier one
 * belongs to an earlier call that used the same id. A fresh POST leg settles
 * none (`answered` is empty): the loop breaks right after emitting its
 * approvals.
 */
function openApprovals(
  turn: AssistantTurnState,
  answered: ReadonlySet<number>,
): ToolApprovalRequest[] {
  const open: ToolApprovalRequest[] = [];
  turn.approvals.forEach((request, index) => {
    if (answered.has(index)) return;
    const seen = open.findIndex((entry) => sameRequest(entry, request));
    if (seen === -1) open.push(request);
    else open[seen] = request;
  });
  return open;
}

/** JSON replacer that emits object keys in sorted order — see `invocationKey`. */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
}

/**
 * Identity of ONE client tool invocation (2.3, F07): the server-issued id plus
 * what it invokes. The id alone is not enough — an OpenAI-compatible server
 * that omits call ids gets `tool_${index}` from core's adapter, so one id
 * recurs across the rounds of an exchange — but a replay re-delivers the SAME
 * call, not merely the same id. Key order does not count: a history restored
 * from a store that reorders object keys (Postgres `jsonb` does) still holds
 * the same input.
 */
function invocationKey(toolCallId: string, toolName: string, input: unknown): string {
  try {
    return JSON.stringify([toolCallId, toolName, input ?? null], sortedKeys);
  } catch {
    // Not JSON-serializable (a restored history can hold anything).
    return JSON.stringify([toolCallId, toolName]);
  }
}

const keyOfCall = (call: UIToolCall): string =>
  invocationKey(call.toolCallId, call.toolName, call.input);

/**
 * How often the canonical history already ANSWERS each client tool invocation
 * within its current exchange (after the last user message): a `tool_use`
 * followed by a `tool_result` for its id (2.3, F07). That result is the only
 * durable evidence this hook has that a client call completed, which is why it
 * — not a set of ids seen so far — decides whether a REPLAYED call may be
 * dispatched: it survives a reload exactly when the app restores
 * `history.canonical`. It is a count, not a set, because a provider without
 * call ids can ask the identical call (`tool_0`, same input) again in a later
 * leg, and one answer covers one delivery.
 *
 * `behind` holds the messages a read that resumed after its cursor cannot
 * deliver again (`behindCursorRef`): their answers do not count.
 */
function answeredInvocations(
  history: Message[],
  behind?: ReadonlySet<Message>,
): Map<string, number> {
  const answered = new Map<string, number>();
  const results = new Set<string>();
  // Backwards, so a result is seen before the call it answers. A paired id is
  // consumed: an older `tool_use` that recycled it is not answered by it.
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === 'user') break;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool_result') results.add(part.toolUseId);
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'tool_use' && results.delete(part.id) && !behind?.has(message)) {
        const key = invocationKey(part.id, part.name, part.input);
        answered.set(key, (answered.get(key) ?? 0) + 1);
      }
    }
  }
  return answered;
}

/**
 * The native agent run a turn carries (2.3): core's `DeuzAgentState`, read off
 * `AssistantTurnState.agent`. Derived rather than imported, so these types
 * still compile against a core older than 2.3 (where it is `unknown`).
 */
export type UseChatAgent = AssistantTurnState extends { agent?: infer A }
  ? Exclude<A, undefined>
  : unknown;

/** The provider's explanation of a stop (2.3): core's `StopDetails`, derived like `UseChatAgent`. */
export type UseChatStopDetails = AssistantTurnState extends { stopDetails?: infer S }
  ? Exclude<S, undefined>
  : unknown;

/** A client result as a native resume takes it (`AgentRunOptions.clientToolResults`). */
interface ClientToolResult {
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}

/** One answered client call, as a native resume takes it. */
function asClientToolResult(answer: {
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}): ClientToolResult {
  return {
    toolCallId: answer.toolCallId,
    output: answer.result,
    ...(answer.isError ? { isError: true } : {}),
  };
}

/**
 * What the next POST carries besides the history (2.3). A chat route only
 * ever gets `approvalResponses`; `runId` and `clientToolResults` resume a
 * native run.
 */
interface Continuation {
  approvalResponses?: ToolApprovalResponse[];
  runId?: string;
  clientToolResults?: ClientToolResult[];
}

/**
 * A suspended native run (2.3), from the terminal frame folded into the turn:
 * its id, the approvals it waits for, and its client calls, as the turn's
 * cards when the leg streamed them (a resume leg that changed nothing streams
 * none, so a call can exist only in the frame).
 */
function nativeSuspension(
  turn: AssistantTurnState,
): { runId: string; approvals: ToolApprovalRequest[]; clientCalls: UIToolCall[] } | undefined {
  const agent = turn.agent;
  if (agent?.status !== 'suspended' || agent.runId === undefined) return undefined;
  const cards = turn.message.toolCalls ?? [];
  return {
    runId: agent.runId,
    approvals: agent.pendingApprovals,
    clientCalls: agent.pendingClientCalls.map(
      (call) =>
        cards.find((card) => card.toolCallId === call.toolCallId && card.input !== undefined) ?? {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          state: 'call',
        },
    ),
  };
}

/** The verdicts and the run a native gate's client calls resume with (2.3). */
interface NativeResume {
  runId: string;
  approvalResponses?: ToolApprovalResponse[];
}

/**
 * A native gate whose last verdict landed (2.3): its client calls run as the
 * first step of the round that resumes the run with their results.
 */
interface NativeGateRound {
  turn: AssistantTurnState;
  clientCalls: UIToolCall[];
  resume: NativeResume;
}

/**
 * The ids of the `tool_use` parts the current exchange (after the last user
 * message) has not answered yet (2.3). A server-run call that an earlier leg
 * paused on (an approval) gets its result in a later leg, where it is no
 * assembled card of the turn: these are the calls such results answer.
 */
function unansweredCalls(history: Message[]): Set<string> {
  const results = new Set<string>();
  const open = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === 'user') break;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool_result') results.add(part.toolUseId);
      if (part.type === 'tool_use' && !results.has(part.id)) open.add(part.id);
    }
  }
  return open;
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
   * want the failure surfaced. Only the READ is silent: when the replayed turn
   * continues the chat (2.3 — `onToolCall` answered its client calls), that
   * POST to `api` reports a failure like any other.
   */
  auto?: boolean;
  /**
   * Cursor persistence adapter (see {@link UseChatCursorStore}). Only reads
   * through `endpoint` save the cursor, so it marks how far the RESUME reads
   * got. (Since 2.3 a POST response that carries the journal's `id:` lines
   * moves the hook's in-memory cursor too, so a `reconnect()` within the same
   * mounted hook resumes after what the POST read delivered; it is not saved
   * here, because a reload mid-turn must replay that turn from its start.
   * `setHistory` drops that in-memory cursor, so a chat switch never sends
   * one chat's cursor to another chat's endpoint.)
   */
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
   * auto-continues; a throw self-heals as an is_error result. A result that
   * lands after the chat moved on (a new message, a regenerate, a replaced
   * history) is dropped (2.3).
   *
   * OMIT it to drive client tools from outside the hook instead: the
   * round-trip PARKS, the calls appear in `pendingToolCalls`, and
   * `addToolResult` answers them.
   *
   * Since 2.3 a turn read back through `reconnect()` / `resume.auto` reaches
   * this the same way. A replayed call is dispatched AT MOST ONCE per mounted
   * hook: not when the canonical history already holds its result, and not
   * while it is parked or still running. Across a reload that evidence is the
   * history the app restored — a call whose result was not persisted before
   * the page went away runs again, so make such tools idempotent, or omit
   * `onToolCall` and confirm parked calls yourself. A tab that only WATCHES a
   * stream another tab drives should omit it too, or it would run that tab's
   * calls.
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
  /**
   * Gated tool calls awaiting verdicts — the chat is PAUSED while non-empty.
   * One entry per request: a repeated wire frame does not add a second card.
   */
  pendingApprovals: ToolApprovalRequest[];
  /**
   * Client tool calls the round-trip is PARKED on (no `onToolCall` executor).
   * Answer each with `addToolResult`; the chat continues once all are answered.
   * A turn read back through `reconnect()` parks its calls here too (2.3).
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
   * The provider's explanation of this turn's stop (2.3), from the wire's
   * `finish`: with `finishReason: 'content_filter'`, a refusal's `category`
   * and `explanation`. Absent when the provider explained nothing.
   */
  stopDetails?: UseChatStopDetails;
  /**
   * The native agent run behind this turn (2.3), on a route that serves
   * `toDeuzAgentStreamResponse`: its `runId`, `status` (`'running'`,
   * `'suspended'`, `'completed'`, `'stopped'`, `'failed'`), the latest `partial`
   * draft while it runs, and — only once `completed` — the `output` the server
   * validated. Absent on a chat route. Pending approvals and client calls of a
   * suspended run also appear in `pendingApprovals` / `pendingToolCalls`, and
   * the hook resumes the run with them.
   */
  agent?: UseChatAgent;
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
   * anchored to the transcript you just replaced. So is the in-memory resume
   * cursor (2.3), which addresses that transcript's stream: the next
   * `reconnect()` reads from the persisted cursor or from the start.
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
   * EVERY pending approval has a verdict, the chat auto-resumes ONCE with
   * `approvalResponses` in the request body.
   *
   * The verdict must answer an approval in `pendingApprovals`: its
   * `approvalId`, and — when the verdict carries a `token` — that request's
   * token, which binds it to the run that issued it. ANYTHING ELSE IS A NO-OP
   * (2.3): no request, no state change, and the promise resolves — the same
   * contract as `addToolResult`. That covers a verdict with nothing pending, a
   * repeat of one already sent (a double click), a card left over from an
   * earlier turn or a replaced transcript, and another run's verdict. Before
   * the last verdict lands, answering an approval again replaces its verdict.
   */
  addToolApprovalResponse: (response: ToolApprovalResponse) => Promise<void>;
  /**
   * Re-read the stream from `resume.endpoint` via `connectDeuzStream` and fold
   * the parts into the current turn. No-op unless `options.resume` is set.
   *
   * The read turn settles exactly like a streamed one (2.3): its approvals
   * pause the chat, its unresolved client calls reach `onToolCall` (and the
   * chat continues with a POST) or `pendingToolCalls`, and a call the replay
   * re-delivers after this client answered it is not dispatched again. A
   * `stop()` during the read settles nothing; the next call continues it.
   *
   * Since 2.3 a POST read whose response carries the journal's event ids
   * moves the cursor too, so a reconnect after a settled turn resumes after
   * it and appends nothing the hook already holds.
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
  stopDetails?: UseChatStopDetails;
  agent?: UseChatAgent;
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
  /**
   * The gate the chat is PAUSED on: the open approvals of the last settled turn
   * (deduplicated, see `openApprovals`). Emptied the moment its verdicts are
   * sent, so a verdict that arrives later answers nothing (2.3, F06).
   */
  const approvalsRef = useRef<ToolApprovalRequest[]>([]);
  const verdictsRef = useRef<ToolApprovalResponse[]>([]);
  /**
   * A native run paused on approvals (2.3): the turn and the client calls it
   * also waits for. They run once the verdicts are in, and the verdicts ride
   * the same resume request as their results.
   */
  const nativeGateRef = useRef<
    { runId: string; turn: AssistantTurnState; clientCalls: UIToolCall[] } | undefined
  >(undefined);
  /** The native run (and its verdicts) the parked client calls resume (2.3). */
  const parkedNativeRef = useRef<NativeResume | undefined>(undefined);
  /**
   * Bumped by `clearGates` (2.3). An `onToolCall` batch that started under an
   * older value belongs to a gate that was dropped meanwhile (a new message, a
   * regenerate, a replaced transcript): its results join nothing.
   */
  const gateGenerationRef = useRef(0);
  /**
   * The results the current turn streamed for calls of an EARLIER leg (2.3):
   * a server-run call the chat paused on (an approval) executes in the resumed
   * leg, which streams its state and result but not the call, so it is no
   * assembled card of that leg's turn. They answer the history's open
   * `tool_use`s when the turn settles.
   */
  const priorResultsRef = useRef<Array<{ toolCallId: string; result: unknown; isError?: boolean }>>(
    [],
  );
  /**
   * Invocation keys (`invocationKey`) of client calls an `onToolCall` batch is
   * running right now. Parked calls live in `clientToolsRef`; together they are
   * the calls a concurrent replay must not dispatch a second time (2.3, F07).
   */
  const executingRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string | undefined>(options.resume?.lastEventId);
  /**
   * The turn `lastEventIdRef` is a cursor INTO (2.3). A reconnect may fold
   * into the in-flight turn only when that turn is the one the cursor
   * addresses. The resume read advances the cursor, and so does a POST read
   * whose response carries the journal's ids (`readDeuzStream`'s `onEventId`,
   * 2.3). A turn a POST read built without ids (a route that does not journal,
   * or a core before 2.3) is rebuilt from the cursor instead; folding the
   * replay into it would apply its already-received parts twice.
   */
  const cursorTurnRef = useRef<AssistantTurnState | undefined>(undefined);
  /** What the reads of `cursorTurnRef`'s turn saw in arrival order (see `ReplayLedger`). */
  const cursorLedgerRef = useRef<ReplayLedger>(newLedger());
  /**
   * The canonical history as it stood when the last replayed turn settled
   * (2.3). Its read ended on the cursor, so a read that resumes after the
   * cursor cannot deliver any of these messages' calls again, and their
   * answers are no evidence about the calls it does deliver.
   */
  const behindCursorRef = useRef<readonly Message[]>([]);
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
      // The LAST message with the id (2.3): the turn's bubble was appended
      // after every earlier one, and a route that names each response's
      // message the same ('deuz-msg' without a `messageId`) must not have a
      // later leg write into an earlier leg's bubble.
      let index = -1;
      if (placed !== undefined) {
        for (let i = ui.length - 1; i >= 0; i--) {
          if (ui[i]!.id === placed) {
            index = i;
            break;
          }
        }
      }
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
        stopDetails: turn.stopDetails,
        agent: turn.agent,
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
    gateGenerationRef.current++;
    approvalsRef.current = [];
    verdictsRef.current = [];
    nativeGateRef.current = undefined;
    parkedNativeRef.current = undefined;
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
      // A native run's `data-agent` frame (2.3) is not app data: core folds it
      // into `turn.agent` and leaves `dataParts` alone. With an older core it
      // stays an ordinary data part and is reported as before.
      const agentFrame = part.type === 'data-agent' && next.dataParts === turn.dataParts;
      if (onData && !agentFrame && typeof part.type === 'string' && part.type.startsWith('data-')) {
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
      // A result for a call of an earlier leg (2.3, see `priorResultsRef`): the
      // turn has no card for it, or only one a `tool-state` frame opened.
      if (
        part.type === 'tool-result' &&
        !(turn.message.toolCalls ?? []).some(
          (call) => call.toolCallId === part.toolCallId && call.input !== undefined,
        )
      ) {
        priorResultsRef.current = [
          ...priorResultsRef.current,
          {
            toolCallId: part.toolCallId,
            result: part.output,
            ...(part.isError ? { isError: true } : {}),
          },
        ];
      }
      return next;
    },
    [options.onData],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  /**
   * Run or park the client calls a settled turn waits for. ONE path for a
   * turn's own settlement and for a native gate whose verdicts just landed
   * (2.3).
   *
   * Without `onToolCall` the round-trip PARKS instead of being abandoned: 1.8
   * returned here and the `tool_use` never got its `tool_result`, so a tool
   * that needs user interaction was unanswerable. `addToolResult` folds the
   * results into THIS turn. With it, every call runs once, its result is folded
   * into the turn, and the results join the canonical history.
   *
   * `native` resumes a native run: its id, and the verdicts that must ride
   * the same request. Resolves the next POST's continuation, or `undefined`
   * when the chat is done or parked, or when the gate was dropped while the
   * calls ran (2.3: a new message, a regenerate or a replaced transcript).
   * Such a batch folds and appends nothing: its results answer a turn that is
   * no longer current, and a `role: 'tool'` message after the new exchange
   * would make the next request invalid.
   */
  const settleClientCalls = useCallback(
    async (
      settled: AssistantTurnState,
      pending: UIToolCall[],
      native?: NativeResume,
    ): Promise<Continuation | undefined> => {
      let turn = settled;
      if (pending.length === 0) {
        // A native gate without client calls resumes with its verdicts alone.
        return native?.approvalResponses?.length ? { ...native } : undefined;
      }
      if (!options.onToolCall) {
        parkedTurnRef.current = turn;
        parkedNativeRef.current = native;
        clientToolsRef.current = pending;
        toolResultsRef.current = [];
        setPendingToolCalls(pending);
        return undefined;
      }
      const generation = gateGenerationRef.current;
      const running = pending.map(keyOfCall);
      for (const key of running) executingRef.current.add(key);
      try {
        const results: Array<{ toolCallId: string; result: unknown; isError?: boolean }> = [];
        for (const call of pending) {
          let answer: { toolCallId: string; result: unknown; isError?: boolean };
          try {
            const out = await options.onToolCall({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            });
            answer = { toolCallId: call.toolCallId, result: out };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            answer = { toolCallId: call.toolCallId, result: message, isError: true };
          }
          if (gateGenerationRef.current !== generation) return undefined;
          results.push(answer);
          turn = applyUIPart(turn, {
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: answer.result,
            ...(answer.isError ? { isError: true } : {}),
          });
          syncTurn(turn);
        }
        appendCanonical(clientToolResultMessage(results));
        return native ? { ...native, clientToolResults: results.map(asClientToolResult) } : {};
      } finally {
        for (const key of running) executingRef.current.delete(key);
      }
    },
    [options.onToolCall, appendCanonical, syncTurn],
  );

  /**
   * Settle a turn whose stream ENDED cleanly: append it to the canonical
   * history, then pause on its approvals, park or run its client tool calls,
   * or finish. ONE implementation behind both reads (2.3, F07) — before 2.3
   * only the POST round-trip settled client tools, so an unresolved call that
   * arrived through `reconnect()` reached neither `onToolCall` nor
   * `pendingToolCalls`, and the transcript kept a `tool_use` nobody answered.
   *
   * `replay` marks a turn read back from `resume.endpoint`, with what its
   * reads saw in arrival order. A replay re-delivers whatever the journal
   * holds after the cursor — with a lost cursor, or a journal holding the leg
   * before the one in flight, that includes calls this client already
   * answered. So for a replayed turn a call is dispatched only while the read
   * delivered it more often than the canonical history answers it (one answer
   * per leg that asked it), and not while it is parked or running: within a
   * mounted hook, at most once per invocation. A fresh POST leg skips those
   * checks — it cannot repeat a call, and providers that number their calls
   * (`tool_0`, …) legitimately recycle an answered id in the next round.
   * `cursorRead` marks a POST read whose event ids moved the cursor (2.3).
   *
   * A native run (2.3) is settled from its terminal frame: the approvals and
   * client calls it reports are what it waits for, and the continuation
   * carries its `runId`.
   *
   * Resolves the next POST's continuation when client results were appended,
   * `undefined` when the chat is done or paused.
   */
  const settleTurn = useCallback(
    async (
      settled: AssistantTurnState,
      replay?: { ledger: ReplayLedger },
      cursorRead = false,
    ): Promise<Continuation | undefined> => {
      const turn = settled;
      // Completion evidence for a replay, read BEFORE this turn joins it. A
      // read that resumed after its cursor cannot have delivered the calls of
      // the turns settled behind that cursor again.
      const history = snapshotRef.current.history.canonical;
      const behind = replay?.ledger.afterCursor ? new Set(behindCursorRef.current) : undefined;
      // Results for calls an earlier leg paused on (2.3), such as an approved
      // call the resumed leg executed, answer them first, so a later request's
      // history leaves no `tool_use` open. Before 2.3 such a result reached the
      // screen but never the history, and the next request failed on the open call.
      const open = unansweredCalls(history);
      const answers = priorResultsRef.current.filter(
        (entry, index, all) =>
          open.has(entry.toolCallId) &&
          all.findIndex((other) => other.toolCallId === entry.toolCallId) === index,
      );
      priorResultsRef.current = [];
      if (answers.length > 0) appendCanonical(clientToolResultMessage(answers));
      // Append the canonical assistant turn (client-tools reconstruction).
      appendCanonical(assistantMessageFromTurn(turn));
      turnRef.current = undefined;
      // Its read ended on the cursor: this turn and all before it are behind it now.
      if (replay || cursorRead) behindCursorRef.current = snapshotRef.current.history.canonical;

      // A suspended native run says itself what it waits for (2.3). One that
      // did not suspend waits for nothing: a call its stream showed (a refused
      // turn's, say) is no client call, and a POST would start a new run.
      const native = nativeSuspension(turn);
      if (!native && turn.agent !== undefined) return undefined;
      // Client tools: every call no result followed (for a native run, the
      // calls its frame reports) — on a replay, minus what this client already
      // answered or is answering right now. The reducer merges the calls that
      // share an id and keeps the latest one's state, so a result for an
      // earlier call under a recycled id (`tool_0` again) leaves this one a
      // 'call'. Testing the id against `turn.serverResults` took the later call
      // for the executed one.
      const answered = replay ? answeredInvocations(history, behind) : undefined;
      const parked = new Set(clientToolsRef.current.map(keyOfCall));
      const candidates = native
        ? native.clientCalls
        : (turn.message.toolCalls ?? []).filter(
            // A card without input is a call of an earlier leg, never one to run.
            (call) => call.state === 'call' && call.input !== undefined,
          );
      const clientPending = candidates.filter((call) => {
        if (!replay || !answered) return true;
        const key = keyOfCall(call);
        return (
          deliveries(replay.ledger, key) > (answered.get(key) ?? 0) &&
          !parked.has(key) &&
          !executingRef.current.has(key)
        );
      });

      // Approval pause: verdicts arrive via addToolApprovalResponse. A native
      // run's client calls wait for them, since one request resumes it.
      const gate = native
        ? native.approvals
        : openApprovals(turn, replay?.ledger.answeredApprovals ?? NO_INDEXES);
      if (gate.length > 0) {
        approvalsRef.current = gate;
        verdictsRef.current = [];
        nativeGateRef.current = native
          ? { runId: native.runId, turn, clientCalls: clientPending }
          : undefined;
        setPendingApprovals(gate);
        return undefined;
      }
      return settleClientCalls(turn, clientPending, native ? { runId: native.runId } : undefined);
    },
    [appendCanonical, settleClientCalls],
  );

  const run = useCallback(
    async (initial?: Continuation, gate?: NativeGateRound): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('streaming');
      setError(undefined);
      let continuation = initial;
      try {
        if (gate) {
          // A native gate's client calls (2.3) run as this round's first step,
          // under its controller and while it is 'streaming': a `stop()` while
          // they run cancels the resume POST, as a stop between the rounds of
          // a chat route does, and a gate dropped meanwhile resumes nothing.
          continuation = await settleClientCalls(gate.turn, gate.clientCalls, gate.resume);
          if (!continuation || controller.signal.aborted) return;
        }
        // One iteration per model round; client-tool results loop back in.
        for (;;) {
          const doFetch = options.fetch ?? fetch;
          const res = await doFetch(options.api, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...options.headers },
            body: JSON.stringify({
              messages: snapshotRef.current.history.canonical,
              ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
              ...(continuation?.approvalResponses?.length
                ? { approvalResponses: continuation.approvalResponses }
                : {}),
              // A native run's resume (2.3); a chat route never gets these.
              ...(continuation?.runId !== undefined ? { runId: continuation.runId } : {}),
              ...(continuation?.clientToolResults?.length
                ? { clientToolResults: continuation.clientToolResults }
                : {}),
              ...options.body,
            }),
            signal: controller.signal,
          });
          continuation = undefined; // consumed by this round only

          let turn = createAssistantTurn(genId());
          turnRef.current = turn;
          priorResultsRef.current = [];
          placedIdRef.current = undefined; // a fresh turn owns no slot yet
          syncTurn(turn); // appends the bubble AND resets this-turn state
          flush(); // "thinking" feedback must never wait on a throttle window

          // A response journaled for `resume.endpoint` carries its event ids
          // (2.3): they move the cursor, so a reconnect resumes after what this
          // read delivered instead of replaying it into the transcript again.
          // The persisted cursor (`resume.cursor`) still moves on resume reads
          // only. A core older than 2.3 reports no ids; nothing changes then.
          const resume = options.resume;
          let cursorRead = false;
          const ledger = newLedger(lastEventIdRef.current);
          ledger.afterCursor = true; // a POST leg is new: none of it came before
          // A non-2xx route (500 + an HTML error page, 401, 429) yields a
          // single `error` part → turn.error → the throw below → status 'error'.
          // Before 1.9 it streamed nothing and rendered an empty bubble.
          for await (const part of readDeuzStream(res, {
            ...(options.onHttpError ? { onHttpError: options.onHttpError } : {}),
            ...(resume
              ? {
                  onEventId: (id: string) => {
                    lastEventIdRef.current = id;
                    cursorRead = true;
                  },
                }
              : {}),
          })) {
            if (resume) recordPart(ledger, turn, part);
            turn = fold(turn, part);
            turnRef.current = turn;
            if (cursorRead) {
              cursorTurnRef.current = turn;
              cursorLedgerRef.current = ledger;
            }
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
            if (cursorRead) cursorTurnRef.current = turn;
            syncTurn(turn);
          }
          flush(); // terminal frame — never coalesced away
          if (turn.error !== undefined) throw new Error(turn.error);

          // The settlement `reconnect()` shares (F07): done or paused → stop.
          const next = await settleTurn(turn, undefined, cursorRead);
          if (!next) return;
          continuation = next; // loop → next round POSTs the extended history
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
            if (cursorTurnRef.current === open) cursorTurnRef.current = sealed;
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
        // Only the current round ends the streaming status (2.3): a round a
        // newer one replaced, such as a gate's whose client calls were still
        // running when a message was sent, must not flip that stream to idle.
        if (abortRef.current === controller) setStatus((s) => (s === 'error' ? s : 'idle'));
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
      options.onError,
      options.onHttpError,
      options.resume,
      fold,
      flush,
      settleClientCalls,
      settleTurn,
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
      // The in-memory resume cursor (2.3: POST reads move it too) addresses
      // the stream of the transcript just replaced, like the gates. After a
      // chat switch it would send the old chat's position to the new chat's
      // endpoint, so the next reconnect reads from the persisted cursor
      // (`resume.cursor`) or from the start, as before 2.3. Not in
      // `clearGates`: a send, regenerate or edit continues the same stream.
      lastEventIdRef.current = undefined;
      cursorTurnRef.current = undefined;
      cursorLedgerRef.current = newLedger();
      behindCursorRef.current = [];
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
      // A parked native run (2.3) resumes with these results and its verdicts.
      const native = parkedNativeRef.current;
      clientToolsRef.current = [];
      toolResultsRef.current = [];
      parkedTurnRef.current = undefined;
      parkedNativeRef.current = undefined;
      setPendingToolCalls([]);
      appendCanonical(clientToolResultMessage(answered));
      await run(
        native ? { ...native, clientToolResults: answered.map(asClientToolResult) } : undefined,
      );
    },
    [run, appendCanonical, syncTurn, flush],
  );

  const addToolApprovalResponse = useCallback(
    async (response: ToolApprovalResponse): Promise<void> => {
      const gate = approvalsRef.current;
      // F06 (2.3): a verdict must answer a request of the gate the chat is
      // paused on; anything else is a NO-OP — the `addToolResult` contract: no
      // request, no state change. Before, `every()` over an EMPTY gate was
      // `true`, so a verdict with nothing pending (a double click after the
      // gate completed, a stale card, another run's verdict) POSTed a fresh
      // round and rendered an empty bubble, and a foreign verdict recorded
      // while a gate was open rode along in its `approvalResponses`.
      const targets = gate.filter((request) => answersRequest(response, request));
      if (targets.length === 0) return;
      // One verdict per request identity, carrying that request's signed token
      // unless the caller set one (`answersRequest` proved it equal). Answering
      // the same request again before the gate completes REPLACES the verdict.
      const recorded: ToolApprovalResponse[] = [];
      for (const request of targets) {
        const verdict =
          response.token === undefined && request.token !== undefined
            ? { ...response, token: request.token }
            : response;
        if (!recorded.some((v) => sameTarget(v, verdict))) recorded.push(verdict);
      }
      verdictsRef.current = [
        ...verdictsRef.current.filter((v) => !recorded.some((r) => sameTarget(r, v))),
        ...recorded,
      ];
      const verdicts = verdictsRef.current;
      if (!gate.every((request) => verdicts.some((v) => sameTarget(v, request)))) return;
      // Consumed. Cleared BEFORE the round starts, so a verdict that lands while
      // it is in flight finds no gate and is a no-op too.
      approvalsRef.current = [];
      verdictsRef.current = [];
      setPendingApprovals([]);
      // A native run (2.3) resumes only with every verdict AND every client
      // result in one request: its client calls run (or park) first, inside
      // the round that resumes it.
      const native = nativeGateRef.current;
      nativeGateRef.current = undefined;
      if (native) {
        await run(undefined, {
          turn: native.turn,
          clientCalls: native.clientCalls,
          resume: { runId: native.runId, approvalResponses: verdicts },
        });
        return;
      }
      await run({ approvalResponses: verdicts });
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
        // The replay continues the in-flight turn only when the cursor
        // addresses THAT turn (2.3, see `cursorTurnRef`). Otherwise it rebuilds
        // the turn — from the start without a cursor, from the cursor when the
        // in-flight turn is one a POST read built without ids — and the rebuilt
        // turn takes the place of a partial one already on screen
        // (`placedIdRef` keeps pointing at it). With nothing on screen the turn
        // stays UNPLACED until the first part arrives, so a caught-up endpoint
        // answering `[DONE]` immediately is a silent no-op, not an empty bubble.
        const continuing =
          inFlight !== undefined && cursor !== undefined && cursorTurnRef.current === inFlight;
        if (inFlight === undefined) placedIdRef.current = undefined;
        let turn = continuing && inFlight ? inFlight : createAssistantTurn(genId());
        turnRef.current = turn;
        cursorTurnRef.current = turn;
        if (!continuing) priorResultsRef.current = [];
        // A continued turn keeps what its earlier reads saw.
        const ledger = continuing ? cursorLedgerRef.current : newLedger(cursor);
        cursorLedgerRef.current = ledger;
        const parts = connectDeuzStream(resume.endpoint, {
          ...(cursor !== undefined ? { lastEventId: cursor } : {}),
          onCursor: (id) => {
            ledger.afterCursor ??= isLaterId(id, ledger.cursor);
            lastEventIdRef.current = id;
            saveCursor(resume, id);
          },
          signal: controller.signal,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
        });
        for await (const part of parts) {
          folded++;
          recordPart(ledger, turn, part);
          turn = fold(turn, part);
          turnRef.current = turn;
          cursorTurnRef.current = turn;
          syncTurn(turn);
        }
        if (folded === 0) {
          // Already caught up: nothing arrived, so nothing changed and nothing
          // may be appended to the canonical history (an empty assistant
          // message would poison the next request). Not an error. The turn we
          // speculatively created is discarded; a real in-flight one is kept
          // (sealed — no `finish` is coming for it now).
          const kept = inFlight === undefined ? undefined : sealAssistantTurn(inFlight);
          turnRef.current = kept;
          cursorTurnRef.current = continuing ? kept : undefined;
          return;
        }
        if (controller.signal.aborted) {
          // `connectDeuzStream` ends QUIETLY on a user abort, so the loop above
          // just stops. That ends the read, not the turn: like the POST path's
          // abort, seal what arrived and settle nothing (2.3) — settling would
          // append a turn the user stopped and run its client tools. The cursor
          // still addresses this turn, so the next `reconnect()` continues it.
          const stopped = sealAssistantTurn(turn);
          turnRef.current = stopped;
          cursorTurnRef.current = stopped;
          if (stopped !== turn) syncTurn(stopped);
          return;
        }
        const sealed = sealAssistantTurn(turn);
        if (sealed !== turn) {
          turn = sealed;
          syncTurn(turn);
        }
        turnRef.current = turn;
        cursorTurnRef.current = turn;
        if (turn.error !== undefined) throw new Error(turn.error);
        // The settlement the POST path uses (F07): approvals pause the chat and
        // unresolved client calls reach `onToolCall` or `pendingToolCalls`.
        // Results from `onToolCall` continue the chat with a POST, as the POST
        // path's loop does — unless the user stopped it while they ran.
        const next = await settleTurn(turn, { ledger });
        if (next && !controller.signal.aborted) await run(next);
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
      fold,
      flush,
      run,
      settleTurn,
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
    ...(snapshot.stopDetails !== undefined ? { stopDetails: snapshot.stopDetails } : {}),
    ...(snapshot.agent !== undefined ? { agent: snapshot.agent } : {}),
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
