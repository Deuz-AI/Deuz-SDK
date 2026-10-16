/**
 * How the 2.4 Node stores get their connections (spec §4.2): a store owns and
 * closes a connection it opened itself (from `path` or `connectionString`)
 * and only borrows one it is given (`database`, `pool`), leaving it open on
 * `close()`. A PostgreSQL transaction pins one pooled connection
 * (`pool.connect()`); a client that only offers `query()` cannot do that and
 * is refused by the 2.4 stores. Every 2.4 store keeps its own schema version
 * table and never changes an existing one. Node-only.
 */
import type { SqliteDatabaseLike } from './store-sqlite';
import type { PgPoolClientLike, PgPoolLike } from './pg-tx';

/** A SQLite connection: a file (or `':memory:'`) the store opens and owns, or a borrowed handle. */
export type SqliteConnectionOptions =
  | {
      /** Database file, or `':memory:'`. */
      path: string;
      database?: undefined;
      /** WAL journal on a file the store opens. Default true. */
      wal?: boolean;
    }
  | {
      /** A handle the caller opened: borrowed, never closed by the store. */
      database: SqliteDatabaseLike;
      path?: undefined;
    };

/** One pooled connection, held for one transaction (the same type `withPgTransaction` uses). */
export type PgTransactionClientLike = PgPoolClientLike;

/** A `pg.Pool` or compatible pool: the 2.4 stores pin one connection per transaction. */
export type PgTransactionPoolLike = PgPoolLike;

/** A PostgreSQL connection: a borrowed pool, or a pool the store opens (and ends) itself. */
export type PostgresConnectionOptions = (
  | { pool: PgTransactionPoolLike }
  | { connectionString: string }
) & {
  /** Schema holding the tables. Default `'public'`; it must exist. */
  schema?: string;
};
