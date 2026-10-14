/**
 * The PostgreSQL conditional chat store and transcript index (2.4), published
 * from `@deuz-sdk/core/stores/postgres`: separate tables with a
 * `tsvector` + GIN index and their own `deuz_chat_conditional_schema`
 * version table. A write and its index update share one pinned transaction.
 * Node-only.
 */
import type { ConditionalChatStore, TranscriptIndex } from '../types/chat-conditional';
import { notImplemented } from '../internal/not-implemented';
import type { PostgresConnectionOptions } from './store-connection';

/** Options of `createPostgresConditionalChatStore`. */
export type PostgresConditionalChatStoreOptions = PostgresConnectionOptions;

/** The conditional chat store with its transcript index. */
export type PostgresConditionalChatStore = ConditionalChatStore & {
  transcript: TranscriptIndex;
  migrate(): Promise<void>;
  close(): Promise<void>;
};

/** The PostgreSQL conditional chat store (2.4). */
export function createPostgresConditionalChatStore(
  _options: PostgresConditionalChatStoreOptions,
): PostgresConditionalChatStore {
  return notImplemented('createPostgresConditionalChatStore');
}
