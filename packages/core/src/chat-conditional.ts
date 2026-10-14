/**
 * In-memory conditional chat store and transcript index (2.4), published from
 * `@deuz-sdk/core/chat`. The contracts are in `types/chat-conditional.ts`; the
 * transcript rules every backend shares are in `internal/chat-transcript.ts`.
 * Edge-safe.
 */
import type { ChatRecord } from './chat';
import type { MemoryScope } from './memory';
import type { Dependencies } from './types/deps';
import type {
  ConditionalChatStore,
  TranscriptHit,
  TranscriptIndex,
  TranscriptMessage,
} from './types/chat-conditional';
import { notImplemented } from './internal/not-implemented';
import {
  compareRanked,
  normalizeScore,
  queryTerms,
  resolveSearchOptions,
  scopeMatches,
  stableMessageIds,
  textTerms,
  transcriptEntries,
  type RankedMessage,
} from './internal/chat-transcript';

/** Options of `createInMemoryConditionalChatStore`. */
export interface InMemoryConditionalChatStoreOptions {
  /** An index kept in step with every write and tombstone. */
  transcript?: TranscriptIndex;
  /** The clock for `deletedAt` and tombstone pruning. */
  deps?: Dependencies;
}

/**
 * The in-memory `ConditionalChatStore` (2.4): copies in and out, revisions
 * and tombstones as the contract says, and `transcript` updated with every
 * committed write.
 */
export function createInMemoryConditionalChatStore(
  _options?: InMemoryConditionalChatStoreOptions,
): ConditionalChatStore {
  return notImplemented('createInMemoryConditionalChatStore');
}

const now = (deps: Dependencies | undefined): number => deps?.clock?.now() ?? Date.now();

interface IndexedMessage extends TranscriptMessage {
  /** Folded term counts of the message's searchable text. */
  terms: Map<string, number>;
  /** When this message id was first indexed (the store clock). */
  indexedAt: number;
}

interface IndexedChat {
  scope: MemoryScope;
  messages: IndexedMessage[];
}

const transcriptMessage = (message: IndexedMessage): TranscriptMessage => ({
  chatId: message.chatId,
  messageId: message.messageId,
  index: message.index,
  message: structuredClone(message.message),
});

/**
 * The in-memory `TranscriptIndex` (2.4): case- and diacritic-insensitive
 * whole-term matching, scope-checked. A hit's raw score is how many distinct
 * query terms its message holds; ties go to the newer message.
 */
export function createInMemoryTranscriptIndex(options?: { deps?: Dependencies }): TranscriptIndex {
  const chats = new Map<string, IndexedChat>();
  return {
    async index(record) {
      const at = now(options?.deps);
      const firstIndexed = new Map(
        (chats.get(record.chatId)?.messages ?? []).map((message) => [
          message.messageId,
          message.indexedAt,
        ]),
      );
      const messages = transcriptEntries(structuredClone(record)).map((entry) => {
        const terms = new Map<string, number>();
        for (const term of textTerms(entry.text)) terms.set(term, (terms.get(term) ?? 0) + 1);
        return {
          chatId: record.chatId,
          messageId: entry.messageId,
          index: entry.index,
          message: entry.message,
          terms,
          indexedAt: firstIndexed.get(entry.messageId) ?? at,
        };
      });
      chats.set(record.chatId, { scope: { ...record.scope }, messages });
    },

    async remove(chatId) {
      chats.delete(chatId);
    },

    async search(scope, query, searchOptions) {
      const resolved = resolveSearchOptions(searchOptions);
      const terms = queryTerms(query);
      if (terms.length === 0 || resolved.limit === 0) return [];
      const ranked: (RankedMessage & { chat: IndexedChat; position: number })[] = [];
      for (const [chatId, chat] of chats) {
        if (resolved.chatIds && !resolved.chatIds.has(chatId)) continue;
        if (!scopeMatches(chat.scope, scope)) continue;
        chat.messages.forEach((message, position) => {
          if (resolved.before !== undefined && !(message.indexedAt < resolved.before)) return;
          if (resolved.after !== undefined && !(message.indexedAt > resolved.after)) return;
          const raw = terms.filter((term) => message.terms.has(term)).length;
          if (raw > 0)
            ranked.push({
              chatId,
              index: message.index,
              indexedAt: message.indexedAt,
              raw,
              chat,
              position,
            });
        });
      }
      ranked.sort(compareRanked);
      const best = ranked[0]?.raw ?? 0;
      return ranked.slice(0, resolved.limit).map((entry): TranscriptHit => {
        const hit: TranscriptHit = {
          ...transcriptMessage(entry.chat.messages[entry.position]!),
          score: normalizeScore(entry.raw, best),
        };
        if (resolved.around > 0) {
          const { messages } = entry.chat;
          hit.around = [
            ...messages.slice(Math.max(0, entry.position - resolved.around), entry.position),
            ...messages.slice(entry.position + 1, entry.position + 1 + resolved.around),
          ].map(transcriptMessage);
        }
        return hit;
      });
    },

    async resolveSource(scope, ref) {
      if (ref.chatId === undefined || ref.messageId === undefined) return undefined;
      const chat = chats.get(ref.chatId);
      if (!chat || !scopeMatches(chat.scope, scope)) return undefined;
      const message = chat.messages.find((candidate) => candidate.messageId === ref.messageId);
      return message ? transcriptMessage(message) : undefined;
    },
  };
}

/**
 * Indexes a chat saved through a legacy `ChatStore` (2.4): the backfill and
 * the explicit sync step for stores that do not index in their own write
 * transaction. Messages without stable ids get `<chatId>:<index>`.
 */
export async function indexChat(index: TranscriptIndex, record: ChatRecord): Promise<void> {
  await index.index({ ...record, messageIds: stableMessageIds(record) });
}
