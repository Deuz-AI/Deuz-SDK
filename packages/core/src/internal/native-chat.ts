/**
 * Native transcript and chat projection (2.3, 23.4).
 *
 * The run's checkpoint (`AgentRunEnvelope`) is canonical. Its history is the
 * model's effective one, which compaction or a `prepareStep` history rewrite
 * can change, so a run with `chat` or `memory` also keeps a transcript: the
 * input, then every turn the run appended, raw. It grows at three places:
 * - a loop leg hands over its raw chat history at the end of the leg (the
 *   legacy loops' own chat persistence, pointed at the envelope);
 * - between those, each checkpoint folds in the turns appended since the last
 *   sync point, as long as the history was not rewritten (a fingerprint of the
 *   last folded message anchors it), so an interrupted leg loses nothing;
 * - the runner appends its own finalization turns directly.
 *
 * The chat store holds a projection of the transcript. The two stores are
 * written one after the other, never as one transaction: the projection is
 * saved after the checkpoint, and its acknowledgement (`AgentRunChatState`)
 * after the projection, so a failed write leaves the cursor behind for the
 * next save to repair. Every save replaces the whole record, which makes a
 * repeat idempotent.
 */
import type { Message } from '../types/message';
import type { Clock } from '../types/deps';
import type { ChatPersistOptions, ChatRecord } from '../chat';
import type {
  AgentRunChatInvocation,
  AgentRunChatState,
  AgentRunTranscript,
  AgentToolReceipt,
} from '../types/agent-run';
import { scopeKey } from './native-scope';

/**
 * FNV-1a over a message's (or a stored chat record's) JSON: a sync anchor, not
 * a security boundary.
 */
export function fingerprint(value: Message | ChatRecord | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

/** The sync point of a checkpointed history. */
export function syncPoint(canonical: readonly Message[]): AgentRunTranscript['synced'] {
  const last = fingerprint(canonical.at(-1));
  return { length: canonical.length, ...(last !== undefined ? { last } : {}) };
}

/** A transcript that starts with the run's history so far. */
export function createTranscript(
  messages: readonly Message[],
  input: number,
  internal: number[],
): AgentRunTranscript {
  return { messages: [...messages], input, internal, synced: syncPoint(messages) };
}

/**
 * Fold the turns a checkpointed history appended since the transcript's sync
 * point. A history rewritten past the anchor (compaction) folds nothing and
 * re-anchors: the leg's raw record will bring those turns.
 */
export function foldHistory(
  transcript: AgentRunTranscript,
  canonical: readonly Message[],
): 'current' | 'folded' | 'rewritten' {
  const { length, last } = transcript.synced;
  if (canonical.length === length && fingerprint(canonical.at(-1)) === last) return 'current';
  let from: number | undefined;
  if (length === 0) from = 0;
  else if (length <= canonical.length && fingerprint(canonical[length - 1]) === last) from = length;
  else {
    for (let index = canonical.length - 1; index >= 0; index--) {
      if (fingerprint(canonical[index]) === last) {
        from = index + 1;
        break;
      }
    }
  }
  transcript.synced = syncPoint(canonical);
  if (from === undefined) return 'rewritten';
  transcript.messages.push(...structuredClone(canonical.slice(from)));
  return 'folded';
}

/** Append one runner-written turn; `canonical` is the history after the append. */
export function appendTurn(
  transcript: AgentRunTranscript,
  message: Message,
  canonical: readonly Message[],
  internal = false,
): void {
  if (internal) transcript.internal.push(transcript.messages.length);
  transcript.messages.push(structuredClone(message));
  transcript.synced = syncPoint(canonical);
}

/** Replace the run's last turn (an output guardrail's rewrite); drop it when `message` is undefined. */
export function replaceLastTurn(
  transcript: AgentRunTranscript,
  message: Message | undefined,
  canonical: readonly Message[],
): void {
  if (
    transcript.messages.length > transcript.input &&
    transcript.messages.at(-1)?.role === 'assistant'
  )
    transcript.messages.pop();
  if (message) transcript.messages.push(structuredClone(message));
  transcript.synced = syncPoint(canonical);
}

interface Projection {
  messageIds: string[];
  turns: string[];
  invocations: AgentRunChatInvocation[];
}

function project(
  runId: string,
  transcript: AgentRunTranscript,
  previous: AgentRunChatState | undefined,
  stored: ChatRecord | undefined,
  receipts: readonly AgentToolReceipt[],
): Projection {
  const messages = transcript.messages;
  const messageIds = messages.map((message, index) => {
    const kept = previous?.messageIds[index];
    if (kept !== undefined) return kept;
    // An input message keeps the id the stored chat gave it.
    const prior = stored?.messageIds?.[index];
    if (
      index < transcript.input &&
      prior !== undefined &&
      fingerprint(stored!.messages[index]) === fingerprint(message)
    )
      return prior;
    return `${runId}:${index}`;
  });
  const turns: string[] = [];
  const invocations: AgentRunChatInvocation[] = [];
  // A provider may reuse a call id at a later step: the n-th call with an id is
  // the one whose receipt has the n-th smallest model step.
  const steps = new Map<string, number[]>();
  for (const receipt of receipts) {
    if (receipt.modelStep === undefined) continue;
    const list = steps.get(receipt.toolCallId) ?? [];
    list.push(receipt.modelStep);
    steps.set(receipt.toolCallId, list);
  }
  for (const list of steps.values()) list.sort((a, b) => a - b);
  const seen = new Map<string, number>();
  for (let index = transcript.input; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    turns.push(messageIds[index]!);
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type !== 'tool_use') continue;
      const nth = seen.get(part.id) ?? 0;
      seen.set(part.id, nth + 1);
      const modelStep = steps.get(part.id)?.[nth];
      let resultId: string | undefined;
      for (let later = index + 1; later < messages.length; later++) {
        const content = messages[later]!.content;
        if (
          typeof content !== 'string' &&
          content.some((item) => item.type === 'tool_result' && item.toolUseId === part.id)
        ) {
          resultId = messageIds[later];
          break;
        }
      }
      invocations.push({
        toolCallId: part.id,
        ...(modelStep !== undefined ? { modelStep } : {}),
        messageId: messageIds[index]!,
        ...(resultId !== undefined ? { resultId } : {}),
      });
    }
  }
  return { messageIds, turns, invocations };
}

function errorOf(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

/** `prefix` is the first `prefix.length` messages of `messages`. */
function isPrefix(prefix: readonly Message[], messages: readonly Message[]): boolean {
  if (prefix.length > messages.length) return false;
  for (let index = 0; index < prefix.length; index++)
    if (fingerprint(prefix[index]) !== fingerprint(messages[index])) return false;
  return true;
}

/**
 * Save the projection of `transcript` to the chat store and return the state
 * to record. Never throws: a store failure comes back as `'failed'`, and a
 * stored chat of another scope as `'scope-mismatch'` (left untouched, as in
 * the legacy loops). A stored chat that already holds this projection and
 * more (a later run continued it) is not overwritten.
 *
 * `repair`: a late write for a run whose leg is not running (a terminal or
 * still-suspended resume, `reconcileAgentRun`). It only finishes the write the
 * run's last attempt meant, so it replaces the record that attempt found (no
 * record, when it found none) or one this transcript continues (its input, or
 * an earlier projection of it). Any other record was saved or deleted after
 * that attempt: the chat moved on without the run, so it comes back as
 * `'superseded'` and is left as it is. A running leg keeps last-writer-wins,
 * as the legacy loops do.
 */
export async function saveProjection(
  chat: ChatPersistOptions,
  runId: string,
  transcript: AgentRunTranscript,
  previous: AgentRunChatState | undefined,
  receipts: readonly AgentToolReceipt[],
  clock: Clock,
  repair: boolean,
): Promise<AgentRunChatState> {
  const behind = {
    chatId: chat.chatId,
    cursor: previous?.cursor ?? 0,
    messageIds: previous?.messageIds ?? [],
    turns: previous?.turns ?? [],
    invocations: previous?.invocations ?? [],
  };
  // The record a failed write found stays known until a write lands.
  const found = previous?.found !== undefined ? { found: previous.found } : {};
  let stored: ChatRecord | undefined;
  try {
    stored = await chat.store.loadChat(chat.chatId);
  } catch (error) {
    // Writing over a chat whose owner could not be checked could overwrite
    // another tenant's history: the projection waits for the next save.
    return { ...behind, ...found, status: 'failed', error: errorOf(error) };
  }
  if (stored && (stored.chatId !== chat.chatId || scopeKey(stored.scope) !== scopeKey(chat.scope)))
    return { ...behind, ...found, status: 'scope-mismatch' };
  const projection = project(runId, transcript, previous, stored, receipts);
  const messages = transcript.messages;
  const ahead =
    stored !== undefined &&
    stored.messages.length > messages.length &&
    isPrefix(messages, stored.messages);
  const moved = stored
    ? !ahead && !isPrefix(stored.messages, messages) && fingerprint(stored) !== previous?.found
    : previous?.found !== undefined;
  if (repair && moved) return { ...behind, status: 'superseded' };
  if (!ahead) {
    try {
      await chat.store.saveChat({
        chatId: chat.chatId,
        scope: chat.scope,
        messages: structuredClone(messages),
        messageIds: projection.messageIds,
        ...(chat.parentId ? { parentId: chat.parentId } : {}),
        updatedAt: clock.now(),
      });
    } catch (error) {
      // A late repair may still replace the record this write found.
      return {
        ...behind,
        ...(stored ? { found: fingerprint(stored)! } : {}),
        status: 'failed',
        error: errorOf(error),
      };
    }
  }
  return { chatId: chat.chatId, cursor: messages.length, ...projection, status: 'saved' };
}

/**
 * Whether the chat store is behind the transcript, or its last write failed.
 * A projection the chat moved on from (`'superseded'`) is settled: no repair
 * writes it again.
 */
export function projectionBehind(
  transcript: AgentRunTranscript,
  state: AgentRunChatState | undefined,
): boolean {
  if (state?.status === 'superseded') return false;
  return state?.status !== 'saved' || state.cursor !== transcript.messages.length;
}
