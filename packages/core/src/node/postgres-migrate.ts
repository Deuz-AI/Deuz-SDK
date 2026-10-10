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
 * new snapshot, on any of `SCHEMA_RACE_CODES`.
 *
 * Forward migrations (2.3): a schema stored at an older version runs the
 * store's upgrade steps, in order, inside the same locked statement, then the
 * `create` statements and the version bump; a failure anywhere leaves the
 * schema as it was. A newer version, written by a newer build, is refused.
 * Node-only.
 */
import type { PgClientLike } from './store-postgres';

export interface PostgresSchemaSpec {
  /** Names the advisory lock, e.g. `ops:public`: one per store and schema. */
  lock: string;
  /** The schema-qualified version table. */
  meta: string;
  /** The version this build writes. */
  version: number;
  /**
   * The message raised for a stored version this build does not know; the
   * stored version and the readable ones are appended.
   */
  unsupported: string;
  /**
   * `CREATE ... IF NOT EXISTS` statements for the current version, run in
   * order under the lock on every first use, after any upgrade step. An object
   * a schema lacks is created here, so an addition older builds can ignore,
   * such as an index, needs no version change.
   */
  create: readonly string[];
  /**
   * Forward migrations (2.3): `upgrades[n]` takes a schema stored at version n
   * to n + 1, for every n from the oldest version this build still upgrades to
   * `version - 1`. Change `version` only for a change older builds must not
   * write through: they refuse a newer version. Each statement must be safe to
   * run twice, because a session whose REPEATABLE READ snapshot predates the
   * lock holder's upgrade runs it again before its retry sees the new version.
   */
  upgrades?: Readonly<Record<number, readonly string[]>>;
}

/** Quotes a constant for SQL text; the stores' identifiers are validated before use. */
const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** The one statement that creates or upgrades a store's schema; send it with `createPostgresSchema`. */
export function postgresSchemaStatement(spec: PostgresSchemaSpec): string {
  const { version } = spec;
  if (!Number.isSafeInteger(version)) throw new TypeError('Schema version must be an integer');
  const steps = Object.entries(spec.upgrades ?? {})
    .map(([from, sql]) => ({ from: Number(from), sql }))
    .sort((left, right) => left.from - right.from);
  const oldest = steps[0]?.from ?? version;
  if (
    steps.some(
      (step, index) =>
        !Number.isSafeInteger(step.from) || step.from !== version - steps.length + index,
    )
  )
    throw new TypeError(`Schema upgrade steps must run without gaps up to version ${version}`);
  const readable = oldest === version ? `version ${version}` : `versions ${oldest} to ${version}`;
  return [
    'DO $deuz$',
    'DECLARE',
    '  stored integer;',
    'BEGIN',
    `  PERFORM pg_advisory_xact_lock(hashtext('deuz-sdk'), hashtext(${literal(spec.lock)}));`,
    `  CREATE TABLE IF NOT EXISTS ${spec.meta} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);`,
    `  SELECT version INTO stored FROM ${spec.meta} WHERE singleton = 1;`,
    `  IF stored < ${oldest} OR stored > ${version} THEN`,
    `    RAISE EXCEPTION USING MESSAGE = ${literal(`${spec.unsupported} `)} || stored || ${literal(`; this build reads ${readable}`)};`,
    '  END IF;',
    // A new schema (stored IS NULL) skips every step: `create` builds it whole.
    ...steps.flatMap((step) => [
      `  IF stored <= ${step.from} THEN`,
      ...step.sql.map((sql) => `    ${sql};`),
      '  END IF;',
    ]),
    ...spec.create.map((sql) => `  ${sql};`),
    '  IF stored IS NULL THEN',
    `    INSERT INTO ${spec.meta} (singleton, version) VALUES (1, ${version}) ON CONFLICT (singleton) DO NOTHING;`,
    `  ELSIF stored < ${version} THEN`,
    `    UPDATE ${spec.meta} SET version = ${version} WHERE singleton = 1;`,
    '  END IF;',
    'END',
    '$deuz$',
  ].join('\n');
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
 * What a contended single-statement write can raise (2.3): 40001 when, under
 * REPEATABLE READ or SERIALIZABLE, a concurrent transaction changed its rows,
 * and 40P01 when it was chosen as a deadlock victim. Postgres rolled the whole
 * statement back, so the stores send it again.
 */
export const SERIALIZATION_CODES: readonly string[] = ['40001', '40P01'];

/**
 * What a concurrent first use can raise; each clears when the idempotent DDL
 * runs again. 42710 is an unlocked `CREATE TABLE IF NOT EXISTS` whose rival
 * committed between the existence check and the table's row type.
 */
export const SCHEMA_RACE_CODES: readonly string[] = [
  ...SERIALIZATION_CODES,
  '23505',
  '42P07',
  '42710',
];

/** Sends a store's schema statement, again when a concurrent first use failed it. */
export async function createPostgresSchema(client: PgClientLike, sql: string): Promise<void> {
  await retryPostgres(SCHEMA_RACE_CODES, () => client.query(sql));
}
