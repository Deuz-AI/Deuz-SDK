/**
 * The SQLite `ProcessOperationStore` (2.4), published from
 * `@deuz-sdk/core/compute/docker`: new tables with their own
 * `deuz_process_ops_schema` version table. Node-only.
 */
import type { ProcessOperationStore } from '../compute/docker/types';
import type { Clock } from '../types/deps';
import { notImplemented } from '../internal/not-implemented';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteProcessOperationStore`. */
export type SqliteProcessOperationStoreOptions = SqliteConnectionOptions & { clock?: Clock };

/** The SQLite process operation store (2.4); `close()` closes only a connection it opened. */
export function createSqliteProcessOperationStore(
  _options: SqliteProcessOperationStoreOptions,
): ProcessOperationStore & { close(): Promise<void> } {
  return notImplemented('createSqliteProcessOperationStore');
}
