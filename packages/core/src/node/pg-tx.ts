/**
 * Postgres transactions on one pinned connection (2.4), for the stores 2.4
 * adds. The 2.3 stores take a `PgClientLike`, which only has `query()`, and a
 * pool may run two calls on two connections, so they change state one
 * statement at a time (`postgres-migrate.ts`). A new store that needs several
 * statements to commit together takes a pool instead: `withPgTransaction`
 * borrows ONE connection with `pool.connect()`, runs BEGIN, the callback and
 * COMMIT on it, rolls back on any throw, and always gives the connection back.
 * A store handed a client without `connect()` refuses it (`assertPgPool`).
 *
 * Under REPEATABLE READ or SERIALIZABLE a concurrent write fails with 40001,
 * and any isolation level can pick a transaction as a deadlock victim (40P01).
 * Postgres rolled the whole transaction back, so it runs again, callback
 * included, on a fresh connection: five attempts in all, as the 2.3 stores
 * retry a statement. The callback must therefore be safe to run again, and
 * keep its side effects inside the transaction.
 *
 * `ensurePgSchema` is the schema-meta rule of `sqlite-handle.ts` for Postgres:
 * each store keeps its version in `<schema>.<name>_schema`, never in another
 * store's table. Node-only.
 */
import type { PgClientLike } from './store-postgres';
import { SCHEMA_RACE_CODES, SERIALIZATION_CODES } from './postgres-migrate';
import {
  assertStoredSchemaVersion,
  planSchemaMeta,
  type SchemaMetaSpec,
  type SchemaMetaState,
} from './schema-meta';

export type { SchemaMetaState } from './schema-meta';

/** A connection a pool lends out: `pg`'s `PoolClient` and compatible drivers fit. */
export interface PgPoolClientLike extends PgClientLike {
  /** Gives the connection back; a truthy argument (`pg`) destroys it instead. */
  release(destroy?: Error | boolean): void;
}

/** A pool that lends one connection for a transaction: `pg.Pool`, `@neondatabase/serverless`'s `Pool`. */
export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgPoolClientLike>;
}

/** True for a client that can lend a connection (`connect()`), false for a query()-only one. */
export function isPgPool(client: PgClientLike): client is PgPoolLike {
  return typeof (client as { connect?: unknown }).connect === 'function';
}

/**
 * Throws when `client` cannot lend a connection. `factory` names the store's
 * factory in the message, e.g. `createPostgresGoalRuntimeStore`.
 */
export function assertPgPool(client: PgClientLike, factory: string): asserts client is PgPoolLike {
  if (!isPgPool(client))
    throw new TypeError(
      `${factory} needs a pool (such as pg.Pool) with connect(): it commits several statements ` +
        'together on one connection, which a query()-only client cannot pin.',
    );
}

export type PgIsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

const BEGIN: Readonly<Record<PgIsolationLevel, string>> = {
  'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
};

export interface PgTransactionOptions {
  /** The transaction's isolation level. Default: the session's (`default_transaction_isolation`). */
  isolation?: PgIsolationLevel;
  /** SQLSTATEs that run the transaction again. Default 40001 and 40P01. */
  retryOn?: readonly string[];
  /** Attempts in all, the first included. Default 5. */
  attempts?: number;
}

/** How many times a transaction runs before its error is thrown, as `retryPostgres` does. */
const ATTEMPTS = 5;

const ENDED =
  'withPgTransaction: this transaction already ended; run its statements inside the callback.';

/**
 * Runs `fn` in one transaction on one connection from `pool`: BEGIN, `fn`,
 * COMMIT. A throw rolls back and is rethrown. A serialization failure or a
 * deadlock, in `fn` or at COMMIT, runs the whole transaction again on a fresh
 * connection, up to `attempts`. The connection always goes back to the pool;
 * one whose ROLLBACK failed is destroyed instead, since its state is unknown.
 * `tx` refuses statements once the transaction ended.
 */
export async function withPgTransaction<T>(
  pool: PgPoolLike,
  fn: (tx: PgClientLike) => Promise<T>,
  options: PgTransactionOptions = {},
): Promise<T> {
  const retryOn = options.retryOn ?? SERIALIZATION_CODES;
  const attempts = options.attempts ?? ATTEMPTS;
  const begin = options.isolation ? BEGIN[options.isolation] : 'BEGIN';
  for (let attempt = 1; ; attempt++) {
    const connection = await pool.connect();
    if (typeof connection?.query !== 'function' || typeof connection.release !== 'function')
      throw new TypeError(
        'withPgTransaction: pool.connect() must resolve to a connection with query() and ' +
          'release(), as pg.Pool does; a single client cannot be shared by concurrent transactions.',
      );
    let ended = false;
    let broken: Error | undefined;
    const tx: PgClientLike = {
      query: (sql, params) =>
        ended ? Promise.reject(new Error(ENDED)) : connection.query(sql, params),
    };
    try {
      await connection.query(begin);
      const result = await fn(tx);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try {
        // Harmless when Postgres already ended the transaction (a failed COMMIT).
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt < attempts && typeof code === 'string' && retryOn.includes(code)) continue;
      throw error;
    } finally {
      ended = true;
      connection.release(broken);
    }
  }
}

/** One upgrade step: SQL text, or code given the transaction. */
export type PgSchemaStep = string | ((tx: PgClientLike) => Promise<void>);

/** A new store's Postgres schema: see `SchemaMetaSpec`. */
export interface PgSchemaSpec extends SchemaMetaSpec<PgSchemaStep> {
  /** The schema holding the store's tables, which must already exist. Default `'public'`. */
  schema?: string;
}

/** Exactly the identifiers Postgres accepts unquoted (and folds to lower case). */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Creates or upgrades a new store's schema in one transaction on one
 * connection, under a transaction-scoped advisory lock per store and schema,
 * so concurrent first uses queue instead of racing `CREATE TABLE IF NOT EXISTS`:
 *
 * - the version lives in `<schema>.<name>_schema` (one row, `singleton = 1`);
 * - a newer stored version is refused with an error naming both, an older one
 *   runs every upgrade step from it in order, then the `create` statements
 *   (one statement each), then the version is written;
 * - any failure rolls the whole transaction back, so the schema stays as it was.
 *
 * It runs at READ COMMITTED whatever the session default, so a session that
 * queued on the lock reads what the holder committed.
 */
export async function ensurePgSchema(
  pool: PgPoolLike,
  spec: PgSchemaSpec,
): Promise<SchemaMetaState> {
  const plan = planSchemaMeta(spec);
  const schema = spec.schema ?? 'public';
  if (!SCHEMA_NAME_PATTERN.test(schema) || schema.length > 63)
    throw new TypeError(
      `Invalid Postgres schema name ${JSON.stringify(schema)}: use lower-case letters, digits and underscores.`,
    );
  const table = `${schema}.${plan.table}`;
  return withPgTransaction(
    pool,
    async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'deuz-sdk',
        `${spec.name}:${schema}`,
      ]);
      await tx.query(
        `CREATE TABLE IF NOT EXISTS ${table} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`,
      );
      const { rows } = await tx.query(`SELECT version FROM ${table} WHERE singleton = 1`);
      const stored = rows[0] === undefined ? undefined : Number(rows[0].version);
      assertStoredSchemaVersion(plan, spec.version, stored, table);
      if (stored !== undefined)
        for (const step of plan.steps) {
          if (stored > step.from) continue;
          for (const run of step.run) {
            if (typeof run === 'string') await tx.query(run);
            else await run(tx);
          }
        }
      for (const sql of spec.create) await tx.query(sql);
      // The version is a validated integer, so there is nothing to bind.
      if (stored === undefined)
        await tx.query(`INSERT INTO ${table} (singleton, version) VALUES (1, ${spec.version})`);
      else if (stored < spec.version)
        await tx.query(`UPDATE ${table} SET version = ${spec.version} WHERE singleton = 1`);
      return { stored, version: spec.version };
    },
    { isolation: 'read committed', retryOn: SCHEMA_RACE_CODES },
  );
}
