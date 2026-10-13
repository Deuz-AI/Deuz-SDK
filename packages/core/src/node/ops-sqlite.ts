/**
 * `@deuz-sdk/core/ops/sqlite` (2.2): durable leases, native agent run stores
 * and schedule claims on one SQLite file. Several processes may share the file;
 * every write is a `BEGIN IMMEDIATE` transaction or a single statement, so a
 * lease changes hands at most once, an agent run save is a compare-and-set on
 * its revision, and a claim key is granted once. Node-only.
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import { ensureBusyTimeout } from './sqlite-open';
import type {
  AgentRunEnvelope,
  AgentRunListPage,
  AgentRunListQuery,
  AgentRunStore,
} from '../types/agent-run';
import type { Clock } from '../types/deps';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from '../types/lease';
import { assertEnvelopeRevision, assertLeaseRequest } from '../internal/ops-validate';
import { assertRetentionTime } from '../internal/ops-retention';
import { agentRunListPage, planAgentRunList, summarizeAgentRun } from '../internal/agent-run-list';
import { resolveDependencies } from '../internal/resolve-deps';
import { decodeSwarm, encodeSwarm } from '../swarm/store';

// Persistent budget scopes (2.2, M5) share this Node-only subpath: one import
// for every durable ops store on a SQLite file.
export { createSqliteBudgetStore } from './budget-sqlite';
export type { SqliteBudgetStoreOptions, SqliteBudgetStore } from './budget-sqlite';

export interface SqliteOpsStoreOptions {
  path: string;
  /** This store owns the injected connection; close() closes it. */
  database?: SqliteDatabaseLike;
  wal?: boolean;
  /**
   * Lease time. Every process sharing the file must agree on it, so the
   * default host clock is the right choice outside tests.
   */
  clock?: Clock;
}

export interface SqliteOpsStore {
  /** Has `ack` and, for retention (2.3), `prune`. */
  leases: LeaseProvider & Required<Pick<LeaseProvider, 'ack' | 'prune'>>;
  agentRuns: AgentRunStore & {
    /**
     * Retention (2.3): delete the terminal runs (completed, stopped or failed)
     * last saved before `before`, epoch ms on the store's clock, and return how
     * many. Running, finalizing and suspended runs stay; a pruned run can no
     * longer be resumed or inspected, and its ID is free again.
     */
    prune(before: number): Promise<number>;
    /**
     * Native run discovery (2.3): a page of runs, newest save first, by the
     * `deuz_agent_runs_updated_at` index. Times are on the store's clock.
     */
    list(query?: AgentRunListQuery): Promise<AgentRunListPage>;
  };
  /**
   * A durable claim for `createScheduler({ claim })` and `handleSignal({ dedupe })`:
   * a key is granted once across every process sharing the file, until
   * `release(key)` gives it back. Granted keys stay in `deuz_claims` (with
   * `claimed_at`, epoch ms on the store's clock) until released or pruned; a
   * key over 512 characters or holding a NUL is stored as `sha256:<hex>` of it.
   */
  claims: {
    (key: string): Promise<boolean>;
    release(key: string): Promise<void>;
    /**
     * Retention (2.3): delete the keys granted before `before`, epoch ms on the
     * store's clock, and return how many. A pruned key can be claimed again, so
     * keep every key an occurrence or delivery may still repeat.
     */
    prune(before: number): Promise<number>;
  };
  close(): Promise<void>;
}

interface LeaseRow {
  owner: string;
  token: number;
  expires_at: number;
  signals: string;
}

const SCHEMA_VERSION = 1;
const SIGNALS: readonly LeaseSignal[] = ['cancel', 'drain'];
const encoder = new TextEncoder();

/**
 * The key a claim row stores: the key itself, or `sha256:` and the hex SHA-256
 * of it when it is longer than 512 characters or holds a NUL, which Postgres
 * text and its btree index cannot take. The Postgres claims map keys the same
 * way, so a key has one row on either store.
 */
async function claimRowKey(key: string): Promise<string> {
  if (key.length <= 512 && !key.includes('\0')) return key;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

export function createSqliteOpsStore(options: SqliteOpsStoreOptions): SqliteOpsStore {
  const clock = options.clock ?? resolveDependencies().clock;
  let opening: Promise<SqliteDatabaseLike> | undefined;
  let closed = false;
  let admitted = 0;
  let drained: (() => void) | undefined;
  const statements = new Map<string, SqliteStatementLike>();
  const statement = (db: SqliteDatabaseLike, sql: string) => {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  const transaction = <T>(db: SqliteDatabaseLike, fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const open = async (): Promise<SqliteDatabaseLike> => {
    opening ??= (async () => {
      let db = options.database;
      if (!db) {
        const module = (await import('node:sqlite' as string)) as {
          DatabaseSync: new (path: string) => SqliteDatabaseLike;
        };
        db = new module.DatabaseSync(options.path);
      }
      try {
        ensureBusyTimeout(db);
        if (options.path !== ':memory:' && options.wal !== false)
          db.exec('PRAGMA journal_mode = WAL');
        transaction(db, () => {
          db.exec(
            'CREATE TABLE IF NOT EXISTS deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
          );
          const row = db!
            .prepare('SELECT version FROM deuz_ops_schema WHERE singleton = 1')
            .get() as { version: number } | undefined;
          if (row && row.version !== SCHEMA_VERSION)
            throw new Error('Unsupported SQLite ops schema version');
          if (!row) {
            db!.exec(`CREATE TABLE IF NOT EXISTS deuz_leases (
              key TEXT PRIMARY KEY, owner TEXT NOT NULL, token INTEGER NOT NULL,
              expires_at INTEGER NOT NULL, signals TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS deuz_agent_runs (
              run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL,
              payload TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
            db!.exec(`INSERT INTO deuz_ops_schema(singleton,version) VALUES(1,${SCHEMA_VERSION})`);
          }
          // Outside the first-open branch, so files written before claims existed gain it.
          db!.exec(
            'CREATE TABLE IF NOT EXISTS deuz_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)',
          );
          // 2.3, for retention: additions a 2.2 process ignores, so version 1 stays.
          db!.exec(`CREATE INDEX IF NOT EXISTS deuz_claims_claimed_at ON deuz_claims(claimed_at);
            CREATE INDEX IF NOT EXISTS deuz_agent_runs_updated_at ON deuz_agent_runs(updated_at);`);
        });
        return db;
      } catch (error) {
        // An injected handle stays open: the next call retries on it.
        if (!options.database) db.close();
        throw error;
      }
    })();
    // A failed open must not poison the store for the rest of the process.
    opening.catch(() => {
      opening = undefined;
    });
    return opening;
  };
  const use = async <T>(operation: (db: SqliteDatabaseLike) => T): Promise<T> => {
    if (closed) throw new Error('SQLite ops store is closed');
    admitted++;
    try {
      return operation(await open());
    } finally {
      admitted--;
      if (admitted === 0) drained?.();
    }
  };
  const readLease = (db: SqliteDatabaseLike, key: string): LeaseRow | undefined =>
    statement(db, 'SELECT owner, token, expires_at, signals FROM deuz_leases WHERE key=?').get(
      key,
    ) as LeaseRow | undefined;
  const view = (key: string, owner: string, token: number, expiresAt: number): Lease =>
    Object.freeze({ key, owner, token: Number(token), expiresAt: Number(expiresAt) });
  /** Deletes the rows `where` matches (2.3), in one transaction, and counts them. */
  const prune = (db: SqliteDatabaseLike, table: string, where: string, before: number) =>
    transaction(db, () => {
      const pruned = Number(
        (
          statement(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(before) as {
            n: number;
          }
        ).n,
      );
      if (pruned) statement(db, `DELETE FROM ${table} WHERE ${where}`).run(before);
      return pruned;
    });

  const leases: SqliteOpsStore['leases'] = {
    async acquire({ key, owner, ttlMs }) {
      assertLeaseRequest(key, owner, ttlMs);
      return use((db) =>
        transaction(db, () => {
          const now = clock.now();
          const row = readLease(db, key);
          if (row && Number(row.expires_at) > now) return undefined;
          const token = Number(row?.token ?? 0) + 1;
          // A queued cancel concerns the run and outlives its holder (2.2); a drain does not.
          statement(
            db,
            `INSERT INTO deuz_leases(key,owner,token,expires_at,signals) VALUES(?,?,?,?,'[]')
             ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, token=excluded.token,
             expires_at=excluded.expires_at,
             signals=CASE WHEN instr(signals, '"cancel"') > 0 THEN '["cancel"]' ELSE '[]' END`,
          ).run(key, owner, token, now + ttlMs);
          return view(key, owner, token, now + ttlMs);
        }),
      );
    },
    async renew(lease, ttlMs, options = {}): Promise<LeaseRenewal> {
      assertLeaseRequest(lease.key, lease.owner, ttlMs);
      return use((db) =>
        transaction(db, (): LeaseRenewal => {
          const row = readLease(db, lease.key);
          if (
            !row ||
            Number(row.token) !== lease.token ||
            row.owner !== lease.owner ||
            Number(row.expires_at) === 0
          )
            return { held: false };
          const expiresAt = clock.now() + ttlMs;
          const signals = JSON.parse(row.signals) as LeaseSignal[];
          // Acknowledged delivery (2.3): the cancel stays queued until ack().
          const queued: LeaseSignal[] =
            options.acknowledge && signals.includes('cancel') ? ['cancel'] : [];
          statement(db, 'UPDATE deuz_leases SET expires_at=?, signals=? WHERE key=?').run(
            expiresAt,
            JSON.stringify(queued),
            lease.key,
          );
          return {
            held: true,
            lease: view(lease.key, lease.owner, lease.token, expiresAt),
            signals,
            ...(options.acknowledge ? { queued } : {}),
          };
        }),
      );
    },
    async release(lease) {
      await use((db) =>
        statement(
          db,
          `UPDATE deuz_leases SET expires_at=0,
           signals=CASE WHEN instr(signals, '"cancel"') > 0 THEN '["cancel"]' ELSE '[]' END
           WHERE key=? AND token=? AND owner=?`,
        ).run(lease.key, lease.token, lease.owner),
      );
    },
    async signal(key, signal) {
      if (!SIGNALS.includes(signal)) throw new TypeError(`Unknown lease signal: ${String(signal)}`);
      return use((db) =>
        transaction(db, () => {
          const row = readLease(db, key);
          if (!row || Number(row.expires_at) <= clock.now()) return false;
          const signals = JSON.parse(row.signals) as LeaseSignal[];
          if (!signals.includes(signal)) signals.push(signal);
          statement(db, 'UPDATE deuz_leases SET signals=? WHERE key=?').run(
            JSON.stringify(signals),
            key,
          );
          return true;
        }),
      );
    },
    async ack(lease, signal) {
      if (signal !== 'cancel')
        throw new TypeError(`Only a cancel is acknowledged: ${String(signal)}`);
      return use((db) =>
        transaction(db, () => {
          const row = readLease(db, lease.key);
          // Fenced by the token: once the key changed hands, the cancel is the new holder's.
          if (!row || Number(row.token) !== lease.token || row.owner !== lease.owner) return false;
          const signals = (JSON.parse(row.signals) as LeaseSignal[]).filter(
            (queued) => queued !== 'cancel',
          );
          statement(db, 'UPDATE deuz_leases SET signals=? WHERE key=?').run(
            JSON.stringify(signals),
            lease.key,
          );
          return true;
        }),
      );
    },
    async prune(before) {
      assertRetentionTime(before);
      // Nobody holds the key, and no cancel waits for its run's next executor.
      // The cutoff stops at the store's time: a lease expiring later is held.
      return use((db) =>
        prune(
          db,
          'deuz_leases',
          `(expires_at = 0 OR expires_at < ?) AND instr(signals, '"cancel"') = 0`,
          Math.min(before, clock.now()),
        ),
      );
    },
  };

  const agentRuns: SqliteOpsStore['agentRuns'] = {
    async load(runId) {
      return use((db) => {
        const row = statement(db, 'SELECT payload FROM deuz_agent_runs WHERE run_id=?').get(
          runId,
        ) as { payload: string } | undefined;
        return row ? decodeSwarm<AgentRunEnvelope>(row.payload) : undefined;
      });
    },
    async save(envelope) {
      if (!envelope?.runId) throw new TypeError('Agent run envelopes require a runId');
      const payload = encodeSwarm(envelope);
      await use((db) =>
        transaction(db, () => {
          const row = statement(db, 'SELECT revision FROM deuz_agent_runs WHERE run_id=?').get(
            envelope.runId,
          ) as { revision: number } | undefined;
          assertEnvelopeRevision(row ? { revision: Number(row.revision) } : undefined, envelope);
          statement(
            db,
            `INSERT INTO deuz_agent_runs(run_id,scope,revision,payload,updated_at) VALUES(?,?,?,?,?)
             ON CONFLICT(run_id) DO UPDATE SET scope=excluded.scope, revision=excluded.revision,
             payload=excluded.payload, updated_at=excluded.updated_at`,
          ).run(envelope.runId, envelope.scope, envelope.revision ?? 0, payload, clock.now());
        }),
      );
    },
    async prune(before) {
      assertRetentionTime(before);
      return use((db) =>
        prune(
          db,
          'deuz_agent_runs',
          `updated_at < ? AND json_extract(payload, '$.phase') = 'terminal'`,
          before,
        ),
      );
    },
    async list(query) {
      const plan = planAgentRunList(query);
      if (plan.phases?.length === 0) return { runs: [] };
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (plan.scope !== undefined) {
        where.push('scope=?');
        params.push(plan.scope);
      }
      if (plan.updatedBefore !== undefined) {
        where.push('updated_at<?');
        params.push(plan.updatedBefore);
      }
      if (plan.after !== undefined) {
        // Strictly after the cursor in the ORDER BY below.
        where.push('(updated_at<? OR (updated_at=? AND run_id<?))');
        params.push(plan.after.updatedAt, plan.after.updatedAt, plan.after.runId);
      }
      if (plan.phases !== undefined) {
        where.push(`json_extract(payload, '$.phase') IN (${plan.phases.map(() => '?').join(',')})`);
        params.push(...plan.phases);
      }
      const rows = await use(
        (db) =>
          statement(
            db,
            `SELECT run_id, scope, revision, updated_at,
             json_extract(payload, '$.phase') AS phase,
             json_extract(payload, '$.result.status') AS status
             FROM deuz_agent_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
             ORDER BY updated_at DESC, run_id DESC LIMIT ?`,
          ).all(...params, plan.limit + 1) as {
            run_id: string;
            scope: string;
            revision: number;
            updated_at: number;
            phase: unknown;
            status: unknown;
          }[],
      );
      return agentRunListPage(
        rows.map((row) =>
          summarizeAgentRun({
            runId: row.run_id,
            scope: row.scope,
            revision: row.revision,
            updatedAt: row.updated_at,
            phase: row.phase,
            status: row.status,
          }),
        ),
        plan.limit,
      );
    },
  };

  const claims: SqliteOpsStore['claims'] = Object.assign(
    async (key: string): Promise<boolean> => {
      const row = await claimRowKey(key);
      return use((db) => {
        // One statement: whichever connection inserts the key first wins it. The
        // grant is the row RETURNING yields, not run()'s change count, which an
        // injected driver may not report.
        const granted = statement(
          db,
          'INSERT INTO deuz_claims(key, claimed_at) VALUES(?, ?) ON CONFLICT(key) DO NOTHING RETURNING 1 AS claimed',
        ).get(row, clock.now());
        return granted !== undefined;
      });
    },
    {
      async release(key: string): Promise<void> {
        const row = await claimRowKey(key);
        await use((db) => statement(db, 'DELETE FROM deuz_claims WHERE key=?').run(row));
      },
      async prune(before: number): Promise<number> {
        assertRetentionTime(before);
        return use((db) => prune(db, 'deuz_claims', 'claimed_at < ?', before));
      },
    },
  );

  return {
    leases,
    agentRuns,
    claims,
    async close() {
      if (closed) return;
      closed = true;
      if (admitted)
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      // A failed open already closed a handle the store made itself.
      const db = await opening?.catch(() => undefined);
      (db ?? options.database)?.close();
      statements.clear();
    },
  };
}
