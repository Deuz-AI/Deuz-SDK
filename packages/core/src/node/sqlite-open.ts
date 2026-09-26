import type { SqliteDatabaseLike } from './store-sqlite';

/** How long a store waits for another connection's lock before failing. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Gives a connection a busy handler before anything takes a lock. Switching a
 * file to WAL needs a write lock and even a read needs a shared one, and
 * another process may hold either; without a handler SQLite fails at once. A
 * handle that already waits keeps its own timeout.
 */
export function ensureBusyTimeout(db: SqliteDatabaseLike): void {
  const current = db.prepare('PRAGMA busy_timeout').get() as { timeout?: unknown } | undefined;
  if (!Number(current?.timeout)) db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}
