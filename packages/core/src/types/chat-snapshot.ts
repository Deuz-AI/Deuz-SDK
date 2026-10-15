/**
 * `ChatSnapshotV1` (2.4, spec §3.4, §4.3 "/chat, /ui"): a chat as a client
 * holds it, captured by `useChat`'s `exportSnapshot()` and restored by
 * `useChat({ initialSnapshot })`. Type only, published on
 * `@deuz-sdk/core/chat` and `@deuz-sdk/core/ui` so a server can store,
 * validate or build one without the React package.
 *
 * `@deuz-sdk/react` keeps an identical copy of these two types (its core
 * peer is `^2.0.0`, so it never imports a core symbol 2.3 lacks); its tests
 * check that the two stay one shape. Edge-safe.
 */
import type { AssistantTurnState, UIToolCall } from '../chat';
import type { Message } from './message';
import type { ToolApprovalRequest, ToolApprovalResponse } from './tool';

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
