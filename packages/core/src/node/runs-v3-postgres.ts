/**
 * The PostgreSQL V3 run store (2.4), published from
 * `@deuz-sdk/core/ops/postgres`: separate tables with their own
 * `deuz_runs_v3_schema` version table; existing migrate versions unchanged.
 * Node-only.
 *
 * The tables are those of the SQLite store (`runs-v3-sqlite.ts`), in the
 * configured schema. Times are the DATABASE clock, as for the 2.3 ops store.
 * The store needs a pool: every write is one transaction on one pinned
 * connection (`withPgTransaction`), at SERIALIZABLE, so a package put that
 * races a forget is retried instead of leaving a forgotten record
 * unredacted. A put of a stored package refreshes its `created_at`, and
 * `prune` keeps a package put again after the last save of every run that
 * pointed to it, so a run that writes a package an old run also used keeps
 * it when a prune comes between its put and its save (a put that races the
 * prune is retried). Only a put made before such a run's last save is not
 * protected: if the writer saves after the prune, its reopened step finds
 * the package missing and compiles that step again.
 */
import {
  agentRunV3BlobDigests,
  assertEnvelopeRevisionV3,
  assertPruneOptions,
  decodeAgentRunEnvelopeV3,
  encodeAgentRunEnvelopeV3,
} from '../agent-run-v3';
import {
  assertBlobInput,
  assertForgetEvent,
  forgetTombstones,
  markRedactedSteps,
} from '../agent-run-v3-context';
import { InvalidRequestError, RevisionConflictError } from '../errors';
import { agentRunListPage, planAgentRunList, summarizeAgentRun } from '../internal/agent-run-list';
import type { Sha256Digest } from '../internal/digest';
import type { AgentRunStoreV3 } from '../types/agent-run-v3';
import { bigintCutoff } from './budget-postgres';
import { assertPgPool, ensurePgSchema, withPgTransaction, type PgPoolLike } from './pg-tx';
import type { PostgresConnectionOptions } from './store-connection';
import type { PgClientLike } from './store-postgres';
import { postgresSchemaName } from './swarm-postgres';

/** Options of `createPostgresAgentRunStoreV3`. */
export type PostgresAgentRunStoreV3Options = PostgresConnectionOptions;

const FACTORY = 'createPostgresAgentRunStoreV3';
const SCHEMA_NAME = 'deuz_runs_v3';
const SCHEMA_VERSION = 1;
/** A blob record or tombstone without a revision. */
const NO_REVISION = -1;
/** Milliseconds on the database clock. */
const NOW = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;
const SERIALIZABLE = { isolation: 'serializable' } as const;
const encoder = new TextEncoder();

interface PgModule {
  Pool?: new (config: { connectionString: string }) => PgPoolLike;
  default?: { Pool?: new (config: { connectionString: string }) => PgPoolLike };
}

/** Lazy `pg` load for the `connectionString` form; `as string` keeps the dts build off the optional peer. */
async function openPool(connectionString: string): Promise<PgPoolLike> {
  let mod: PgModule;
  try {
    mod = (await import('pg' as string)) as unknown as PgModule;
  } catch (cause) {
    throw new InvalidRequestError({
      message: `${FACTORY}({ connectionString }) needs the optional peer 'pg' (npm i pg), or pass { pool }.`,
      cause,
    });
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool)
    throw new InvalidRequestError({
      message: "The installed 'pg' module exposes no Pool constructor. Pass { pool } instead.",
    });
  return new Pool({ connectionString });
}

/** The PostgreSQL V3 run store (2.4); `close()` ends only a pool it opened itself. */
export function createPostgresAgentRunStoreV3(
  options: PostgresAgentRunStoreV3Options,
): AgentRunStoreV3 & { migrate(): Promise<void>; close(): Promise<void> } {
  const borrowed = (options as { pool?: PgPoolLike }).pool;
  const connectionString = (options as { connectionString?: unknown }).connectionString;
  if (borrowed !== undefined) assertPgPool(borrowed, FACTORY);
  else if (typeof connectionString !== 'string' || !connectionString)
    throw new TypeError(`${FACTORY} needs { pool } (such as a pg.Pool) or { connectionString }.`);
  const schema = postgresSchemaName(options.schema);
  const runs = `${schema}.deuz_runs_v3`;
  const blobs = `${schema}.deuz_runs_v3_blobs`;
  const records = `${schema}.deuz_runs_v3_blob_records`;
  const refs = `${schema}.deuz_runs_v3_blob_refs`;
  const forgotten = `${schema}.deuz_runs_v3_forgotten`;
  /** The blobs of `records r` that a tombstone covers (the forget rule). */
  const forgottenRecord = `EXISTS (SELECT 1 FROM ${forgotten} t
    WHERE t.record_id = r.record_id
      AND (r.revision = ${NO_REVISION} OR t.revision = ${NO_REVISION} OR t.revision = r.revision))`;
  /**
   * The blobs a pruned run points to and no kept run does, except one put
   * again after the last save of every run pointing to it (a run that has
   * not saved yet is using it); `$1` is the cutoff.
   */
  const doomed = `SELECT d.digest FROM (
      SELECT f.digest FROM ${refs} f JOIN ${runs} u ON u.run_id = f.run_id
        WHERE u.phase = 'terminal' AND u.updated_at < $1::bigint
      EXCEPT SELECT f.digest FROM ${refs} f JOIN ${runs} u ON u.run_id = f.run_id
        WHERE NOT (u.phase = 'terminal' AND u.updated_at < $1::bigint)
    ) d
    WHERE NOT EXISTS (SELECT 1 FROM ${blobs} b WHERE b.digest = d.digest AND b.created_at > (
      SELECT max(u.updated_at) FROM ${refs} f JOIN ${runs} u ON u.run_id = f.run_id
        WHERE f.digest = d.digest))`;

  let owned: Promise<PgPoolLike> | undefined;
  let ready: Promise<void> | undefined;
  let closed = false;
  const pool = (): Promise<PgPoolLike> => {
    if (borrowed) return Promise.resolve(borrowed);
    owned ??= openPool(connectionString as string).catch((error: unknown) => {
      owned = undefined;
      throw error;
    });
    return owned;
  };
  /** The pool, once the schema is in place; refused after close(). */
  const use = async (): Promise<PgPoolLike> => {
    if (closed) throw new Error('The Postgres V3 run store is closed');
    const target = await pool();
    ready ??= ensurePgSchema(target, {
      name: SCHEMA_NAME,
      version: SCHEMA_VERSION,
      schema,
      create: [
        `CREATE TABLE IF NOT EXISTS ${runs} (
          run_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          revision BIGINT NOT NULL,
          phase TEXT NOT NULL,
          status TEXT,
          payload TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS deuz_runs_v3_updated_at ON ${runs} (updated_at)`,
        `CREATE TABLE IF NOT EXISTS ${blobs} (
          digest TEXT PRIMARY KEY,
          content TEXT,
          bytes BIGINT NOT NULL,
          redacted BOOLEAN NOT NULL DEFAULT false,
          created_at BIGINT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${records} (
          digest TEXT NOT NULL,
          record_id TEXT NOT NULL,
          revision BIGINT NOT NULL,
          PRIMARY KEY (digest, record_id, revision)
        )`,
        `CREATE INDEX IF NOT EXISTS deuz_runs_v3_blob_records_record ON ${records} (record_id, revision)`,
        `CREATE TABLE IF NOT EXISTS ${refs} (
          run_id TEXT NOT NULL,
          digest TEXT NOT NULL,
          PRIMARY KEY (run_id, digest)
        )`,
        `CREATE INDEX IF NOT EXISTS deuz_runs_v3_blob_refs_digest ON ${refs} (digest)`,
        `CREATE TABLE IF NOT EXISTS ${forgotten} (
          record_id TEXT NOT NULL,
          revision BIGINT NOT NULL,
          forgotten_at BIGINT NOT NULL,
          PRIMARY KEY (record_id, revision)
        )`,
      ],
    }).then(
      () => undefined,
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    await ready;
    return target;
  };
  const rows = async (client: PgClientLike, sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows;

  return {
    checkpointVersion: 3,
    async load(runId) {
      const client = await use();
      const [row] = await rows(client, `SELECT payload FROM ${runs} WHERE run_id = $1`, [runId]);
      if (!row) return undefined;
      const redacted = await rows(
        client,
        `SELECT b.digest FROM ${refs} f JOIN ${blobs} b ON b.digest = f.digest
         WHERE f.run_id = $1 AND b.redacted`,
        [runId],
      );
      return markRedactedSteps(
        decodeAgentRunEnvelopeV3(String(row.payload)),
        new Set(redacted.map((blob) => String(blob.digest) as Sha256Digest)),
      );
    },
    async save(envelope) {
      const payload = encodeAgentRunEnvelopeV3(envelope);
      const digests = agentRunV3BlobDigests(envelope);
      const revision = envelope.revision!;
      const columns = [
        envelope.runId,
        envelope.scope,
        revision,
        envelope.phase,
        envelope.result?.status ?? null,
        payload,
      ];
      await withPgTransaction(
        await use(),
        async (tx) => {
          // A new run starts at 1; a stored one advances by exactly one.
          const saved =
            revision === 1
              ? await rows(
                  tx,
                  `INSERT INTO ${runs} (run_id, scope, revision, phase, status, payload, updated_at)
                   VALUES ($1, $2, $3::bigint, $4, $5, $6, ${NOW})
                   ON CONFLICT (run_id) DO NOTHING RETURNING 1 AS saved`,
                  columns,
                )
              : await rows(
                  tx,
                  `UPDATE ${runs} SET scope = $2, revision = $3::bigint, phase = $4, status = $5,
                     payload = $6, updated_at = ${NOW}
                   WHERE run_id = $1 AND revision = $3::bigint - 1 RETURNING 1 AS saved`,
                  columns,
                );
          if (saved.length !== 1) {
            const [stored] = await rows(tx, `SELECT revision FROM ${runs} WHERE run_id = $1`, [
              envelope.runId,
            ]);
            assertEnvelopeRevisionV3(
              stored ? { revision: Number(stored.revision) } : undefined,
              envelope,
            );
            // The row moved on between the write and the read: still a conflict.
            throw new RevisionConflictError({
              subsystem: 'run',
              key: envelope.runId,
              expectedRevision: revision - 1,
            });
          }
          if (digests.length > 0)
            await tx.query(
              `INSERT INTO ${refs} (run_id, digest) SELECT $1, d FROM unnest($2::text[]) AS d
               ON CONFLICT DO NOTHING`,
              [envelope.runId, digests],
            );
        },
        SERIALIZABLE,
      );
    },
    async list(query) {
      const plan = planAgentRunList(query);
      if (plan.phases?.length === 0) return { runs: [] };
      const params: unknown[] = [];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      const where: string[] = [];
      if (plan.scope !== undefined) where.push(`scope = ${bind(plan.scope)}`);
      if (plan.updatedBefore !== undefined)
        where.push(`updated_at < ${bind(bigintCutoff(plan.updatedBefore))}::bigint`);
      if (plan.after !== undefined) {
        // Strictly after the cursor; run IDs compare under "C" in the order and the cursor.
        const at = bind(plan.after.updatedAt);
        where.push(
          `(updated_at < ${at}::bigint OR (updated_at = ${at}::bigint
            AND run_id COLLATE "C" < ${bind(plan.after.runId)}))`,
        );
      }
      if (plan.phases !== undefined)
        where.push(`phase IN (${plan.phases.map((phase) => bind(phase)).join(', ')})`);
      const found = await rows(
        await use(),
        `SELECT run_id, scope, revision, updated_at, phase, status FROM ${runs}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY updated_at DESC, run_id COLLATE "C" DESC
         LIMIT ${bind(plan.limit + 1)}`,
        params,
      );
      return agentRunListPage(
        found.map((row) =>
          summarizeAgentRun({
            runId: String(row.run_id),
            scope: String(row.scope),
            revision: row.revision,
            updatedAt: row.updated_at,
            phase: row.phase,
            status: row.status,
          }),
        ),
        plan.limit,
      );
    },
    async putBlob(blob) {
      await assertBlobInput(blob);
      const bytes = encoder.encode(blob.content).length;
      await withPgTransaction(
        await use(),
        async (tx) => {
          // A put of a stored package refreshes its time, which prune reads.
          await tx.query(
            `INSERT INTO ${blobs} AS b (digest, content, bytes, redacted, created_at)
             VALUES ($1, $2, $3, false, ${NOW})
             ON CONFLICT (digest) DO UPDATE SET created_at = GREATEST(b.created_at, EXCLUDED.created_at)`,
            [blob.digest, blob.content, bytes],
          );
          if (blob.records.length > 0)
            await tx.query(
              `INSERT INTO ${records} (digest, record_id, revision)
               SELECT $1, r.record_id, r.revision
               FROM unnest($2::text[], $3::bigint[]) AS r (record_id, revision)
               ON CONFLICT DO NOTHING`,
              [
                blob.digest,
                blob.records.map((record) => record.recordId),
                blob.records.map((record) => record.revision ?? NO_REVISION),
              ],
            );
          // A forget that came first redacts it at once.
          await tx.query(
            `UPDATE ${blobs} SET content = NULL, redacted = true
             WHERE digest = $1 AND NOT redacted AND EXISTS (
               SELECT 1 FROM ${records} r WHERE r.digest = $1 AND ${forgottenRecord})`,
            [blob.digest],
          );
        },
        SERIALIZABLE,
      );
    },
    async getBlob(digest) {
      const [row] = await rows(
        await use(),
        `SELECT content, redacted FROM ${blobs} WHERE digest = $1`,
        [digest],
      );
      if (!row) return { status: 'missing' };
      return row.redacted === true || row.content === null
        ? { status: 'redacted' }
        : { status: 'found', content: String(row.content) };
    },
    async redactForgotten(event) {
      assertForgetEvent(event);
      const tombstones = forgetTombstones(event);
      return withPgTransaction(
        await use(),
        async (tx) => {
          await tx.query(
            `INSERT INTO ${forgotten} (record_id, revision, forgotten_at)
             SELECT $1, r, ${NOW} FROM unnest($2::bigint[]) AS r ON CONFLICT DO NOTHING`,
            [event.recordId, tombstones.map((tombstone) => tombstone.revision ?? NO_REVISION)],
          );
          const redacted = await rows(
            tx,
            `UPDATE ${blobs} SET content = NULL, redacted = true
             WHERE NOT redacted AND digest IN (
               SELECT r.digest FROM ${records} r WHERE r.record_id = $1 AND ${forgottenRecord})
             RETURNING digest`,
            [event.recordId],
          );
          return redacted.length;
        },
        SERIALIZABLE,
      );
    },
    async prune(pruneOptions) {
      const cutoff = bigintCutoff(assertPruneOptions(pruneOptions));
      return withPgTransaction(
        await use(),
        async (tx) => {
          // Blob rows before record rows, the order putBlob locks them in, so
          // a put racing the prune waits for it instead of deadlocking.
          await tx.query(`DELETE FROM ${blobs} WHERE digest IN (${doomed})`, [cutoff]);
          await tx.query(`DELETE FROM ${records} WHERE digest IN (${doomed})`, [cutoff]);
          await tx.query(
            `DELETE FROM ${refs} WHERE run_id IN (
               SELECT run_id FROM ${runs} WHERE phase = 'terminal' AND updated_at < $1::bigint)`,
            [cutoff],
          );
          const pruned = await rows(
            tx,
            `DELETE FROM ${runs} WHERE phase = 'terminal' AND updated_at < $1::bigint RETURNING 1`,
            [cutoff],
          );
          return pruned.length;
        },
        SERIALIZABLE,
      );
    },
    async migrate() {
      await use();
    },
    async close() {
      if (closed) return;
      closed = true;
      const opened = await owned?.catch(() => undefined);
      await opened?.end?.();
    },
  };
}
