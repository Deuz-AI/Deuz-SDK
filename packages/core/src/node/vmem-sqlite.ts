/**
 * `@deuz-sdk/core/memory/versioned/sqlite` (2.4): the versioned memory store
 * on `node:sqlite`. New tables (records, revisions, receipts, FTS5 index,
 * vectors per embedding generation) with their own `deuz_vmem_schema` version
 * table; the legacy `deuz_memory` table and `PRAGMA user_version` are never
 * touched. Every commit is one `BEGIN IMMEDIATE` transaction; search is hybrid
 * (FTS5 + vector, RRF), with a LIKE fallback where FTS5 is missing. Node-only.
 */
import type { VersionedMemoryStore } from '../memory/versioned/types';
import type { Clock } from '../types/deps';
import { notImplemented } from '../internal/not-implemented';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteVersionedMemoryStore`. */
export type SqliteVersionedMemoryStoreOptions = SqliteConnectionOptions & {
  /** Build the FTS5 index. Default true, with a LIKE fallback. */
  fts?: boolean;
  /** The store clock (`recordedAt`, TTL). Default: the host clock. */
  clock?: Clock;
};

/** A SQLite `VersionedMemoryStore`; `close()` closes only a connection it opened. */
export type SqliteVersionedMemoryStore = VersionedMemoryStore & { close(): Promise<void> };

/** The SQLite versioned memory store (2.4). */
export function createSqliteVersionedMemoryStore(
  _options: SqliteVersionedMemoryStoreOptions,
): SqliteVersionedMemoryStore {
  return notImplemented('createSqliteVersionedMemoryStore');
}
