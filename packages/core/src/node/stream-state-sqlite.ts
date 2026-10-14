/**
 * The SQLite durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/stores/sqlite`: new tables with their own
 * `deuz_stream_state_schema` version table; a batch and its fencing check
 * are one transaction. Node-only.
 */
import type { DurableStreamStateStore } from '../types/stream-durable';
import type { Clock } from '../types/deps';
import { notImplemented } from '../internal/not-implemented';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteDurableStreamStateStore`. */
export type SqliteDurableStreamStateStoreOptions = SqliteConnectionOptions & { clock?: Clock };

/** The SQLite durable stream state store (2.4); `close()` closes only a connection it opened. */
export function createSqliteDurableStreamStateStore(
  _options: SqliteDurableStreamStateStoreOptions,
): DurableStreamStateStore & { close(): Promise<void> } {
  return notImplemented('createSqliteDurableStreamStateStore');
}
