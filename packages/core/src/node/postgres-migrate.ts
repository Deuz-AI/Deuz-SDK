/**
 * Schema creation for the Postgres stores (2.2). `PgClientLike` exposes only
 * `query()`, and a pool may run consecutive calls on different connections, so
 * a store cannot hold a lock across statements. Each store therefore creates
 * its schema in ONE statement: a DO block that first takes a transaction-scoped
 * advisory lock, then checks the version table and creates every table and
 * index. Concurrent first uses (several processes, or two pooled connections)
 * queue on the lock instead of racing `CREATE TABLE IF NOT EXISTS`, which fails
 * with 23505 (a pg_type unique violation) or 42P07 when two sessions create one
 * table at once. The lock ends when the statement commits. Node-only.
 */

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

/** The one statement that creates a store's schema; send it with `query()` alone. */
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
