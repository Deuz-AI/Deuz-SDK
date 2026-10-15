/**
 * `ChatSnapshotV1` and the client half of the capability handshake (2.4,
 * spec §3.4 and §4.5).
 *
 * Both are defined HERE, not imported: this package's core peer is `^2.0.0`,
 * so it never imports a core symbol that 2.3 lacks. The capability strings
 * are copies of core's `DEUZ_CAPABILITY` wire strings, which never change
 * (core adds new strings instead), and the snapshot is plain, JSON-shaped
 * data whose history half has the shape of core's `ChatRecord`.
 */
import type { Message, ToolApprovalRequest, ToolApprovalResponse } from '@deuz-sdk/core';
import { uiFromMessages } from '@deuz-sdk/core/chat';
import type { AssistantTurnState, UIMessage, UIToolCall } from '@deuz-sdk/core/chat';

/**
 * A chat as `useChat` holds it, captured by `exportSnapshot()` and restored by
 * `useChat({ initialSnapshot })` (2.4). Plain data: serialize it with
 * `JSON.stringify` (it is as JSON-safe as the history it holds) and treat it
 * as read-only.
 *
 * Only `version` and `messages` are required, so a stored `ChatRecord`
 * restores as `{ version: 1, messages: record.messages, messageIds:
 * record.messageIds }`, and every message renders under the id the server
 * gave it.
 */
export interface ChatSnapshotV1 {
  /** The format: always `1`. Another value is refused when restoring. */
  version: 1;
  /** The canonical history, the one a request POSTs. */
  messages: Message[];
  /**
   * One id per entry of `messages`, as `ChatRecord.messageIds` holds them:
   * the UI message made from `messages[i]` is rendered under `messageIds[i]`.
   * A missing, empty or repeated id gets a fresh one from `generateId`.
   */
  messageIds?: string[];
  /** The resume cursor: the last stream event id the chat read (`Last-Event-ID`). */
  cursor?: string;
  /**
   * The assistant turn that was streaming and had not settled: it is not in
   * `messages` yet. Restored as the last bubble; `reconnect()` (or
   * `resume.auto`) continues it from `cursor`.
   */
  turn?: AssistantTurnState;
  /** Gated tool calls awaiting verdicts: the chat is paused on them. */
  pendingApprovals?: ToolApprovalRequest[];
  /** Client tool calls the chat is parked on, answered with `addToolResult`. */
  pendingToolCalls?: UIToolCall[];
  /** How the paused gate (`pendingApprovals` or `pendingToolCalls`) resumes. */
  gate?: ChatSnapshotGateV1;
  /**
   * What the server announced in the capability handshake, so a restored
   * chat uses the same features before its next response announces again.
   */
  capabilities?: string[];
}

/** The state behind a paused chat's gate in a {@link ChatSnapshotV1} (2.4). */
export interface ChatSnapshotGateV1 {
  /**
   * The settled turn the gate belongs to: answers fold into its bubble. Set
   * for parked client calls and for a native run's gate.
   */
  turn?: AssistantTurnState;
  /**
   * Verdicts already recorded for `pendingApprovals` (the gate resumes once
   * every approval has one), or, for a native run's parked calls, the
   * verdicts that ride the request their results resume it with.
   */
  approvalResponses?: ToolApprovalResponse[];
  /** Results already given to some of the `pendingToolCalls`. */
  toolResults?: Array<{ toolCallId: string; output: unknown; isError?: boolean }>;
  /** The native agent run the gate resumes (`toDeuzAgentStreamResponse` routes). */
  runId?: string;
  /** A native run's client calls that run once every verdict is in. */
  clientCalls?: UIToolCall[];
}

// ---------------------------------------------------------------------------
// The capability handshake (client side)
// ---------------------------------------------------------------------------

/** The request and response header of the handshake (core's `DEUZ_CAPABILITIES_HEADER`). */
export const CAPABILITIES_HEADER = 'x-deuz-capabilities';

/** The capabilities this client uses (copies of core's `DEUZ_CAPABILITY` strings). */
export const CAPABILITY = {
  /** Stable server ids: a replay is deduplicated by message id. */
  messageIds: 'message-ids',
  /** The server takes the client's message ids (`messageIds` in the request body). */
  chatSnapshot: 'chat-snapshot-v1',
  /** A durable stream: a dropped read continues from the resume endpoint. */
  durableStream: 'durable-stream',
} as const;

/** The request header value: what this client understands, sorted and `', '`-joined. */
export const CLIENT_CAPABILITIES = [
  CAPABILITY.chatSnapshot,
  CAPABILITY.durableStream,
  CAPABILITY.messageIds,
].join(', ');

/**
 * A capability list as a sorted array of unique, trimmed, lower-cased
 * tokens; empty items are dropped.
 */
export function normalizeCapabilities(items: Iterable<unknown>): string[] {
  const unique = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const token = item.trim().toLowerCase();
    if (token) unique.add(token);
  }
  return [...unique].sort();
}

/**
 * The capabilities a response header announces, or `undefined` when the
 * response took no part in the handshake (no header: a 2.3 server, a route
 * without `capabilities`, or a cross-origin response that does not expose it).
 */
export function capabilitiesFromHeader(value: string | null | undefined): string[] | undefined {
  return value == null ? undefined : normalizeCapabilities(value.split(','));
}

/**
 * The capabilities a `{ type: 'capabilities' }` frame announces, or
 * `undefined` for any other part. Read structurally: a core older than 2.4
 * has no such member in its part union.
 */
export function capabilitiesOf(part: { type: string }): string[] | undefined {
  if (part.type !== 'capabilities') return undefined;
  const list = (part as { capabilities?: unknown }).capabilities;
  return Array.isArray(list) ? normalizeCapabilities(list) : [];
}

// ---------------------------------------------------------------------------
// Restoring and aligning message ids
// ---------------------------------------------------------------------------

/** Throws a TypeError unless `value` is a snapshot this version restores. */
export function assertChatSnapshot(value: unknown): asserts value is ChatSnapshotV1 {
  const fail = (message: string): never => {
    throw new TypeError(`useChat: initialSnapshot ${message}`);
  };
  if (typeof value !== 'object' || value === null) fail('must be a ChatSnapshotV1 object.');
  const snapshot = value as Partial<ChatSnapshotV1>;
  if (snapshot.version !== 1)
    fail(`has version ${String(snapshot.version)}; this version restores version 1.`);
  if (!Array.isArray(snapshot.messages)) fail('needs a `messages` array.');
  for (const key of ['messageIds', 'pendingApprovals', 'pendingToolCalls', 'capabilities'] as const)
    if (snapshot[key] !== undefined && !Array.isArray(snapshot[key]))
      fail(`has a \`${key}\` that is not an array.`);
}

const usable = (id: unknown): id is string => typeof id === 'string' && id !== '';

/**
 * The render view of a stored history under its stored ids (H7): core's
 * `uiFromMessages` with `{ messageIds }` (2.4), then the same rule applied
 * here, because a 2.3 core ignores that parameter. `uiFromMessages` makes one
 * UI message per user or assistant message, in order (system messages are
 * skipped and tool results fold into the turn before them), so the i-th of
 * those messages owns the i-th UI message. A missing, empty or repeated id
 * keeps the generated one.
 */
export function restoreUI(
  messages: Message[],
  messageIds: readonly string[] | undefined,
  generateId: () => string,
): UIMessage[] {
  const ui = uiFromMessages(messages, generateId, messageIds ? { messageIds } : undefined);
  if (!messageIds) return ui;
  const taken = new Set<string>();
  let view = 0;
  messages.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const at = view++;
    const current = ui[at];
    const id = messageIds[index];
    if (!current || !usable(id) || taken.has(id)) return;
    taken.add(id);
    if (current.id !== id) ui[at] = { ...current, id };
  });
  return ui;
}

/**
 * Pairs the user and assistant messages of `canonical` with the messages of
 * `ui` the way `uiFromMessages` builds them, and hands each pair to `pair`.
 * Stops at the first message whose counterpart is missing or has another
 * role: past that point the two views do not line up.
 */
export function pairViews(
  canonical: readonly Message[],
  ui: readonly UIMessage[],
  pair: (message: Message, view: UIMessage) => void,
): void {
  let view = 0;
  for (const message of canonical) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const counterpart = ui[view++];
    if (!counterpart || counterpart.role !== message.role) return;
    pair(message, counterpart);
  }
}
