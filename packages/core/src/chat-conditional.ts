/**
 * In-memory conditional chat store and transcript index (2.4), published from
 * `@deuz-sdk/core/chat`. The contracts are in `types/chat-conditional.ts`.
 * Edge-safe.
 */
import type { ChatRecord } from './chat';
import type { Dependencies } from './types/deps';
import type { ConditionalChatStore, TranscriptIndex } from './types/chat-conditional';
import { notImplemented } from './internal/not-implemented';

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

/** The in-memory `TranscriptIndex` (2.4): case-insensitive term matching, scope-checked. */
export function createInMemoryTranscriptIndex(_options?: { deps?: Dependencies }): TranscriptIndex {
  return notImplemented('createInMemoryTranscriptIndex');
}

/**
 * Indexes a chat saved through a legacy `ChatStore` (2.4): the backfill and
 * the explicit sync step for stores that do not index in their own write
 * transaction. Messages without stable ids get `<chatId>:<index>`.
 */
export async function indexChat(_index: TranscriptIndex, _record: ChatRecord): Promise<void> {
  return notImplemented('indexChat');
}
