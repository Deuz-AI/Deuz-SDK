/**
 * The SQLite conditional chat store and transcript index (2.4), published from
 * `@deuz-sdk/core/stores/sqlite`. Separate tables (chats with revisions,
 * tombstones, an FTS5 transcript index) with their own
 * `deuz_chat_conditional_schema` version table; `deuz_chats` and
 * `PRAGMA user_version` are never touched. A write and its index update are
 * one transaction. Node-only.
 */
import type { ConditionalChatStore, TranscriptIndex } from '../types/chat-conditional';
import type { Clock } from '../types/deps';
import { notImplemented } from '../internal/not-implemented';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteConditionalChatStore`. */
export type SqliteConditionalChatStoreOptions = SqliteConnectionOptions & {
  /** Build the FTS5 index. Default true, with a LIKE fallback. */
  fts?: boolean;
  clock?: Clock;
};

/** The conditional chat store with its transcript index. */
export type SqliteConditionalChatStore = ConditionalChatStore & {
  transcript: TranscriptIndex;
  close(): Promise<void>;
};

/** The SQLite conditional chat store (2.4). */
export function createSqliteConditionalChatStore(
  _options: SqliteConditionalChatStoreOptions,
): SqliteConditionalChatStore {
  return notImplemented('createSqliteConditionalChatStore');
}
