/**
 * Schema creation for the Postgres stores (2.2). `PgClientLike` exposes only
 * `query()`, and a pool may run consecutive calls on different connections, so
 * a store cannot hold a lock across statements. Each store therefore creates
 * its schema in ONE statement: a DO block that first takes a transaction-scoped
 * advisory lock, then checks the version table and creates every table and
 * index. Concurrent first uses (several processes, or two pooled connections)
 * queue on the lock instead of racing `CREATE TABLE IF NOT EXISTS`, which fails
 * with 23505 (a pg_type unique violation) or 42P07 when two sessions create one
 * table at once. The lock ends when the statement commits.
 *
 * Under a REPEATABLE READ or SERIALIZABLE session default the statement's
 * snapshot is taken before it waits on the lock, so a session that queued
 * misses the version row the holder committed and fails with 40001. The
 * statement is idempotent, so `createPostgresSchema` sends it again, with a
 * new snapshot, on any of `SCHEMA_RACE_CODES`. Node-only.
 */
import type { PgClientLike } from './store-postgres';

export interface PostgresSchemaSpec {
  /** Names the advisory lock, e.g. `ops:public`: one per store and schema. */
  lock: string;
  /** The schema-qualified version table. */
  meta: string;
  version: number;
  /** The message raised for a stored version this build does not know. */
  unsupported: string;
  /** `CREATE ... IF NOT EXISTS` statements, run in order under the lock. */
  create: readonly string[];
}

/** Quotes a constant for SQL text; the stores' identifiers are validated before use. */
const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** The one statement that creates a store's schema; send it with `createPostgresSchema`. */
export function postgresSchemaStatement(spec: PostgresSchemaSpec): string {
  if (!Number.isSafeInteger(spec.version)) throw new TypeError('Schema version must be an integer');
  return `DO $deuz$
DECLARE
  stored integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('deuz-sdk'), hashtext(${literal(spec.lock)}));
  CREATE TABLE IF NOT EXISTS ${spec.meta} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
  INSERT INTO ${spec.meta} (singleton, version) VALUES (1, ${spec.version}) ON CONFLICT (singleton) DO NOTHING;
  SELECT version INTO stored FROM ${spec.meta} WHERE singleton = 1;
  IF stored IS DISTINCT FROM ${spec.version} THEN
    RAISE EXCEPTION USING MESSAGE = ${literal(spec.unsupported)};
  END IF;
${spec.create.map((sql) => `  ${sql};`).join('\n')}
END
$deuz$`;
}

/** How many times a store sends one statement before it gives up. */
const ATTEMPTS = 5;

/**
 * Runs `statement`, and again (five attempts in all) while it fails with one of
 * the SQLSTATEs in `codes`, read from the driver error's `code` as `pg`, PGlite
 * and postgres.js report it. Only for statements that are safe to repeat.
 */
export async function retryPostgres<T>(
  codes: readonly string[],
  statement: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await statement();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt >= ATTEMPTS || typeof code !== 'string' || !codes.includes(code)) throw error;
    }
  }
}

/**
 * What a concurrent first use can raise; each clears when the idempotent DDL
 * runs again. 42710 is an unlocked `CREATE TABLE IF NOT EXISTS` whose rival
 * committed between the existence check and the table's row type.
 */
export const SCHEMA_RACE_CODES: readonly string[] = ['40001', '23505', '42P07', '42710'];

/** Sends a store's schema statement, again when a concurrent first use failed it. */
export async function createPostgresSchema(client: PgClientLike, sql: string): Promise<void> {
  await retryPostgres(SCHEMA_RACE_CODES, () => client.query(sql));
}
