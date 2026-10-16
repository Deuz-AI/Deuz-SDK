/**
 * The SQLite V3 run store (2.4), published from `@deuz-sdk/core/ops/sqlite`:
 * separate tables (runs, context blobs and their record index) with their own
 * `deuz_runs_v3_schema` version table, so `deuz_ops_schema` stays at its 2.3
 * value and 2.3's listing and pruning never see a V3 run. Node-only.
 *
 * Tables, all prefixed `deuz_runs_v3`:
 * - `deuz_runs_v3`: one row per run, the encoded envelope with its revision,
 *   phase, result status and last save time (the store clock) as columns;
 * - `_blobs`: context packages by digest, `content` NULL once redacted,
 *   `created_at` the time of the last put (a put of a stored package
 *   refreshes it);
 * - `_blob_records`: the memory record revisions each blob holds (`-1`: none);
 * - `_blob_refs`: which runs point to which blobs, for retention;
 * - `_forgotten`: forget tombstones (ids only, `-1`: every revision), so a
 *   package put after its forget is stored redacted. Retention never deletes
 *   them.
 *
 * A forget also rewrites the stored copies of a redacted package's
 * retrieval block in the runs that point to it (history, checkpoints, result
 * messages; same revision and `updated_at`), and a later save of such a run
 * is stored with them replaced (`redactRetrievalBlocks`).
 *
 * Every write is one `BEGIN IMMEDIATE` transaction with no await inside it;
 * digests (async WebCrypto) are computed before it starts.
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
  redactedPayload,
  type ContextBlobRecord,
} from '../agent-run-v3-context';
import { agentRunListPage, planAgentRunList, summarizeAgentRun } from '../internal/agent-run-list';
import type { Sha256Digest } from '../internal/digest';
import { resolveDependencies } from '../internal/resolve-deps';
import type { AgentRunStoreV3 } from '../types/agent-run-v3';
import type { Clock } from '../types/deps';
import {
  createSqliteConnection,
  createSqliteStatementCache,
  ensureSqliteSchema,
  sqliteTransaction,
  sqliteUnavailableMessage,
  type SqliteStatementCache,
} from './sqlite-handle';
import type { SqliteConnectionOptions } from './store-connection';
import type { SqliteDatabaseLike } from './store-sqlite';

/** Options of `createSqliteAgentRunStoreV3`. */
export type SqliteAgentRunStoreV3Options = SqliteConnectionOptions & {
  /** The store clock: last-save times for `list` and `prune`. Default: the host clock. */
  clock?: Clock;
};

/** The store's schema name: its version lives in `deuz_runs_v3_schema`. */
export const RUNS_V3_SCHEMA_NAME = 'deuz_runs_v3';
/** The version this build writes. */
export const RUNS_V3_SCHEMA_VERSION = 1;
/** A blob record or tombstone without a revision. */
const NO_REVISION = -1;

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deuz_runs_v3 (
    run_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    revision INTEGER NOT NULL,
    phase TEXT NOT NULL,
    status TEXT,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_runs_v3_updated_at ON deuz_runs_v3 (updated_at)',
  `CREATE TABLE IF NOT EXISTS deuz_runs_v3_blobs (
    digest TEXT PRIMARY KEY,
    content TEXT,
    bytes INTEGER NOT NULL,
    redacted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deuz_runs_v3_blob_records (
    digest TEXT NOT NULL,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (digest, record_id, revision)
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_runs_v3_blob_records_record ON deuz_runs_v3_blob_records (record_id, revision)',
  `CREATE TABLE IF NOT EXISTS deuz_runs_v3_blob_refs (
    run_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY (run_id, digest)
  )`,
  'CREATE INDEX IF NOT EXISTS deuz_runs_v3_blob_refs_digest ON deuz_runs_v3_blob_refs (digest)',
  `CREATE TABLE IF NOT EXISTS deuz_runs_v3_forgotten (
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    forgotten_at INTEGER NOT NULL,
    PRIMARY KEY (record_id, revision)
  )`,
];

/** The blobs of `deuz_runs_v3_blob_records r` that a tombstone covers (the forget rule). */
const FORGOTTEN_RECORD = `EXISTS (SELECT 1 FROM deuz_runs_v3_forgotten t
  WHERE t.record_id = r.record_id
    AND (r.revision = ${NO_REVISION} OR t.revision = ${NO_REVISION} OR t.revision = r.revision))`;

/** Runs `prune` deletes: terminal, last saved before `?`. */
const PRUNED = `phase = 'terminal' AND updated_at < ?`;

/**
 * The blobs a pruned run points to and no kept run does (the cutoff bound
 * twice), except one put again after the last save of every run pointing to
 * it: a run that has not saved yet is using it.
 */
const DOOMED = `SELECT d.digest FROM (
    SELECT f.digest FROM deuz_runs_v3_blob_refs f
    JOIN deuz_runs_v3 u ON u.run_id = f.run_id
    WHERE u.phase = 'terminal' AND u.updated_at < ?
    EXCEPT SELECT f.digest FROM deuz_runs_v3_blob_refs f
    JOIN deuz_runs_v3 u ON u.run_id = f.run_id
    WHERE NOT (u.phase = 'terminal' AND u.updated_at < ?)
  ) d
  WHERE NOT EXISTS (SELECT 1 FROM deuz_runs_v3_blobs b
    WHERE b.digest = d.digest AND b.created_at > (
      SELECT MAX(u.updated_at) FROM deuz_runs_v3_blob_refs f
      JOIN deuz_runs_v3 u ON u.run_id = f.run_id WHERE f.digest = d.digest))`;

type SqlValue = string | number | null;

interface State {
  db: SqliteDatabaseLike;
  statement: SqliteStatementCache;
}

const encoder = new TextEncoder();

function all(s: State, sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
  return s.statement(s.db, sql).all(...params) as Record<string, unknown>[];
}

function one(s: State, sql: string, params: SqlValue[] = []): Record<string, unknown> | undefined {
  return s.statement(s.db, sql).get(...params) as Record<string, unknown> | undefined;
}

function run(s: State, sql: string, params: SqlValue[] = []): void {
  s.statement(s.db, sql).run(...params);
}

/** The redacted blobs a run points to. */
function redactedOf(s: State, runId: string): Set<Sha256Digest> {
  return new Set(
    all(
      s,
      `SELECT b.digest FROM deuz_runs_v3_blob_refs f
       JOIN deuz_runs_v3_blobs b ON b.digest = f.digest
       WHERE f.run_id = ? AND b.redacted = 1`,
      [runId],
    ).map((blob) => String(blob.digest) as Sha256Digest),
  );
}

/**
 * The tombstones that cover a record of the `redacted` blobs: what tells a
 * retrieval block that holds a forgotten record from one of the same marker
 * that does not (`redactRetrievalBlocks`).
 */
function tombstonesOf(s: State, redacted: ReadonlySet<Sha256Digest>): ContextBlobRecord[] {
  if (redacted.size === 0) return [];
  return all(
    s,
    `SELECT DISTINCT t.record_id, t.revision FROM deuz_runs_v3_forgotten t
     JOIN deuz_runs_v3_blob_records r ON r.record_id = t.record_id
     WHERE r.digest IN (${[...redacted].map(() => '?').join(', ')})
       AND (r.revision = ${NO_REVISION} OR t.revision = ${NO_REVISION} OR t.revision = r.revision)`,
    [...redacted],
  ).map((row) =>
    Number(row.revision) === NO_REVISION
      ? { recordId: String(row.record_id) }
      : { recordId: String(row.record_id), revision: Number(row.revision) },
  );
}

/** The redacted blobs among `digests`. */
function redactedAmong(s: State, digests: readonly Sha256Digest[]): Set<Sha256Digest> {
  if (digests.length === 0) return new Set();
  return new Set(
    all(
      s,
      `SELECT digest FROM deuz_runs_v3_blobs
       WHERE redacted = 1 AND digest IN (${digests.map(() => '?').join(', ')})`,
      [...digests],
    ).map((blob) => String(blob.digest) as Sha256Digest),
  );
}

/** The SQLite V3 run store (2.4); `close()` closes only a connection it opened. */
export function createSqliteAgentRunStoreV3(
  options: SqliteAgentRunStoreV3Options,
): AgentRunStoreV3 & { close(): Promise<void> } {
  const clock = options.clock ?? resolveDependencies().clock;
  const statement = createSqliteStatementCache();
  const connection = createSqliteConnection<State>(
    options.database
      ? { path: ':memory:', database: options.database, wal: false }
      : { path: options.path, wal: options.wal },
    {
      injected: 'borrowed',
      unavailable: sqliteUnavailableMessage('createSqliteAgentRunStoreV3'),
      closedMessage: 'The SQLite V3 run store is closed',
      setup(db) {
        ensureSqliteSchema(db, {
          name: RUNS_V3_SCHEMA_NAME,
          version: RUNS_V3_SCHEMA_VERSION,
          create: SCHEMA,
        });
        return { db, statement };
      },
    },
  );
  const use = <T>(operation: (state: State) => T) => connection.use(operation);
  const transaction = <T>(state: State, fn: () => T): T => sqliteTransaction(state.db, fn);

  return {
    checkpointVersion: 3,
    async load(runId) {
      return use((s) => {
        const row = one(s, 'SELECT payload FROM deuz_runs_v3 WHERE run_id = ?', [runId]);
        if (!row) return undefined;
        return markRedactedSteps(
          decodeAgentRunEnvelopeV3(String(row.payload)),
          redactedOf(s, runId),
        );
      });
    },
    async save(envelope) {
      const encoded = encodeAgentRunEnvelopeV3(envelope);
      const digests = agentRunV3BlobDigests(envelope);
      await use((s) =>
        transaction(s, () => {
          const row = one(s, 'SELECT revision FROM deuz_runs_v3 WHERE run_id = ?', [
            envelope.runId,
          ]);
          assertEnvelopeRevisionV3(row ? { revision: Number(row.revision) } : undefined, envelope);
          // A leg that ran through a forget still holds the block: stored redacted.
          const redacted = redactedAmong(s, digests);
          const payload = redactedPayload(encoded, redacted, tombstonesOf(s, redacted));
          run(
            s,
            `INSERT INTO deuz_runs_v3 (run_id, scope, revision, phase, status, payload, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (run_id) DO UPDATE SET scope = excluded.scope,
               revision = excluded.revision, phase = excluded.phase, status = excluded.status,
               payload = excluded.payload, updated_at = excluded.updated_at`,
            [
              envelope.runId,
              envelope.scope,
              envelope.revision!,
              envelope.phase,
              envelope.result?.status ?? null,
              payload,
              clock.now(),
            ],
          );
          for (const digest of digests)
            run(
              s,
              'INSERT INTO deuz_runs_v3_blob_refs (run_id, digest) VALUES (?, ?) ON CONFLICT DO NOTHING',
              [envelope.runId, digest],
            );
        }),
      );
    },
    async list(query) {
      const plan = planAgentRunList(query);
      if (plan.phases?.length === 0) return { runs: [] };
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (plan.scope !== undefined) {
        where.push('scope = ?');
        params.push(plan.scope);
      }
      if (plan.updatedBefore !== undefined) {
        where.push('updated_at < ?');
        params.push(plan.updatedBefore);
      }
      if (plan.after !== undefined) {
        // Strictly after the cursor in the ORDER BY below.
        where.push('(updated_at < ? OR (updated_at = ? AND run_id < ?))');
        params.push(plan.after.updatedAt, plan.after.updatedAt, plan.after.runId);
      }
      if (plan.phases !== undefined) {
        where.push(`phase IN (${plan.phases.map(() => '?').join(', ')})`);
        params.push(...plan.phases);
      }
      const rows = await use((s) =>
        all(
          s,
          `SELECT run_id, scope, revision, updated_at, phase, status FROM deuz_runs_v3
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY updated_at DESC, run_id DESC LIMIT ?`,
          [...params, plan.limit + 1],
        ),
      );
      return agentRunListPage(
        rows.map((row) =>
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
      await use((s) =>
        transaction(s, () => {
          run(
            s,
            `INSERT INTO deuz_runs_v3_blobs (digest, content, bytes, redacted, created_at)
             VALUES (?, ?, ?, 0, ?)
             ON CONFLICT (digest) DO UPDATE SET created_at = MAX(created_at, excluded.created_at)`,
            [blob.digest, blob.content, bytes, clock.now()],
          );
          for (const record of blob.records)
            run(
              s,
              `INSERT INTO deuz_runs_v3_blob_records (digest, record_id, revision)
               VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
              [blob.digest, record.recordId, record.revision ?? NO_REVISION],
            );
          // A forget that came first redacts it at once.
          run(
            s,
            `UPDATE deuz_runs_v3_blobs SET content = NULL, redacted = 1
             WHERE digest = ? AND redacted = 0 AND EXISTS (
               SELECT 1 FROM deuz_runs_v3_blob_records r
               WHERE r.digest = deuz_runs_v3_blobs.digest AND ${FORGOTTEN_RECORD})`,
            [blob.digest],
          );
        }),
      );
    },
    async getBlob(digest) {
      return use((s) => {
        const row = one(s, 'SELECT content, redacted FROM deuz_runs_v3_blobs WHERE digest = ?', [
          digest,
        ]);
        if (!row) return { status: 'missing' as const };
        return Number(row.redacted) === 1 || row.content === null
          ? { status: 'redacted' as const }
          : { status: 'found' as const, content: String(row.content) };
      });
    },
    async redactForgotten(event) {
      assertForgetEvent(event);
      const tombstones = forgetTombstones(event);
      return use((s) =>
        transaction(s, () => {
          for (const tombstone of tombstones)
            run(
              s,
              `INSERT INTO deuz_runs_v3_forgotten (record_id, revision, forgotten_at)
               VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
              [tombstone.recordId, tombstone.revision ?? NO_REVISION, clock.now()],
            );
          // RETURNING counts what changed, which an injected driver's run() may not report.
          const redacted = all(
            s,
            `UPDATE deuz_runs_v3_blobs SET content = NULL, redacted = 1
             WHERE redacted = 0 AND digest IN (
               SELECT r.digest FROM deuz_runs_v3_blob_records r
               WHERE r.record_id = ? AND ${FORGOTTEN_RECORD})
             RETURNING digest`,
            [event.recordId],
          ).length;
          // The runs' stored copies of those blocks go too, in place: same
          // revision and last-save time (a retry finds nothing left to change).
          const affected = all(
            s,
            `SELECT DISTINCT f.run_id FROM deuz_runs_v3_blob_refs f
             JOIN deuz_runs_v3_blob_records r ON r.digest = f.digest
             WHERE r.record_id = ? AND ${FORGOTTEN_RECORD}`,
            [event.recordId],
          );
          for (const { run_id: runId } of affected) {
            const row = one(s, 'SELECT payload FROM deuz_runs_v3 WHERE run_id = ?', [
              String(runId),
            ]);
            if (!row) continue;
            const payload = String(row.payload);
            const redactedBlobs = redactedOf(s, String(runId));
            const next = redactedPayload(payload, redactedBlobs, tombstonesOf(s, redactedBlobs));
            if (next !== payload)
              run(s, 'UPDATE deuz_runs_v3 SET payload = ? WHERE run_id = ?', [next, String(runId)]);
          }
          return redacted;
        }),
      );
    },
    async prune(pruneOptions) {
      const terminalBefore = assertPruneOptions(pruneOptions);
      return use((s) =>
        transaction(s, () => {
          const pruned = Number(
            one(s, `SELECT COUNT(*) AS n FROM deuz_runs_v3 WHERE ${PRUNED}`, [terminalBefore])?.n ??
              0,
          );
          if (pruned === 0) return 0;
          // The blobs a pruned run points to and no kept run does.
          run(s, `DELETE FROM deuz_runs_v3_blob_records WHERE digest IN (${DOOMED})`, [
            terminalBefore,
            terminalBefore,
          ]);
          run(s, `DELETE FROM deuz_runs_v3_blobs WHERE digest IN (${DOOMED})`, [
            terminalBefore,
            terminalBefore,
          ]);
          run(
            s,
            `DELETE FROM deuz_runs_v3_blob_refs WHERE run_id IN (SELECT run_id FROM deuz_runs_v3 WHERE ${PRUNED})`,
            [terminalBefore],
          );
          run(s, `DELETE FROM deuz_runs_v3 WHERE ${PRUNED}`, [terminalBefore]);
          return pruned;
        }),
      );
    },
    async close() {
      await connection.close();
      statement.clear();
    },
  };
}
