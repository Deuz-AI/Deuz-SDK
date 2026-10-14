/**
 * The native chat projection on a `ConditionalChatStore` (2.4): what
 * `saveProjection` (`native-chat.ts`) runs when the run's chat store is
 * conditional, loaded on demand so a run on any other store never downloads
 * it. Edge-safe.
 */
import type { ChatPersistOptions } from '../chat';
import type { Clock } from '../types/deps';
import type { AgentRunChatState, AgentRunTranscript, AgentToolReceipt } from '../types/agent-run';
import type { ConditionalChatStore } from '../types/chat-conditional';
import { updateConditionalChat } from '../chat-conditional';
import type { errorOf, fingerprint, isPrefix, project, Projection } from './native-chat';
import { scopeKey } from './native-scope';

/**
 * The projection pieces of `native-chat.ts`, handed in by its caller: this
 * module only imports its types, so `native-chat.ts` stays a chunk of its own
 * and a run on a legacy store downloads nothing of the conditional path.
 */
export interface ProjectionHelpers {
  project: typeof project;
  isPrefix: typeof isPrefix;
  errorOf: typeof errorOf;
  fingerprint: typeof fingerprint;
}

/**
 * `saveProjection` on a `ConditionalChatStore` (2.4): the same decisions
 * (scope check, a chat that moved ahead, a repair that finds the chat moved
 * on), taken against the revision read and written at that revision with
 * `writeChat`. A conflict means another writer got in between: the chat is
 * read and the projection decided again, three attempts in all, after which
 * the write counts as failed (`RevisionConflictError`) and a later repair
 * takes it up. A deletion tombstone is final: the projection is `'superseded'`,
 * from a repair and from a leg still running alike, and nothing is written.
 */
export async function saveConditionalProjection(
  { project, isPrefix, errorOf, fingerprint }: ProjectionHelpers,
  chat: ChatPersistOptions,
  store: ConditionalChatStore,
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
  const found = previous?.found !== undefined ? { found: previous.found } : {};
  const messages = transcript.messages;
  // What the last decision settled on, and the record the last read found.
  let settled: AgentRunChatState | undefined;
  let projection: Projection | undefined;
  let seen: { found?: string } | undefined;
  try {
    await updateConditionalChat(store, chat.chatId, (current) => {
      settled = undefined;
      const stored = current.status === 'found' ? current.record : undefined;
      seen = stored ? { found: fingerprint(stored)! } : {};
      if (current.status === 'deleted') {
        settled = { ...behind, status: 'superseded' };
        return undefined;
      }
      if (
        stored &&
        (stored.chatId !== chat.chatId || scopeKey(stored.scope) !== scopeKey(chat.scope))
      ) {
        settled = { ...behind, ...found, status: 'scope-mismatch' };
        return undefined;
      }
      projection = project(runId, transcript, previous, stored, receipts);
      const ahead =
        stored !== undefined &&
        stored.messages.length > messages.length &&
        isPrefix(messages, stored.messages);
      const moved = stored
        ? !ahead && !isPrefix(stored.messages, messages) && fingerprint(stored) !== previous?.found
        : previous?.found !== undefined;
      if (repair && moved) {
        settled = { ...behind, status: 'superseded' };
        return undefined;
      }
      if (ahead) return undefined;
      return {
        chatId: chat.chatId,
        scope: chat.scope,
        messages: structuredClone(messages),
        messageIds: projection.messageIds,
        ...(chat.parentId ? { parentId: chat.parentId } : {}),
        updatedAt: clock.now(),
      };
    });
  } catch (error) {
    // A read that failed before any succeeded keeps what the last failure found.
    return { ...behind, ...(seen ?? found), status: 'failed', error: errorOf(error) };
  }
  return (
    settled ?? { chatId: chat.chatId, cursor: messages.length, ...projection!, status: 'saved' }
  );
}
