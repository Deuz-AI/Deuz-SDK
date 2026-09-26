/**
 * `@deuz-sdk/core/ops/sqlite` (2.2): durable leases and native agent run
 * stores on one SQLite file. Several processes may share the file; every write
 * is a `BEGIN IMMEDIATE` transaction, so a lease changes hands at most once and
 * an agent run save is a compare-and-set on its revision. Node-only.
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import { ensureBusyTimeout } from './sqlite-open';
import type { AgentRunEnvelope, AgentRunStore } from '../types/agent-run';
import type { Clock } from '../types/deps';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from '../types/lease';
import { assertEnvelopeRevision, assertLeaseRequest } from '../ops';
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
  leases: LeaseProvider;
  agentRuns: AgentRunStore;
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

  const leases: LeaseProvider = {
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
    async renew(lease, ttlMs): Promise<LeaseRenewal> {
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
          statement(db, `UPDATE deuz_leases SET expires_at=?, signals='[]' WHERE key=?`).run(
            expiresAt,
            lease.key,
          );
          return {
            held: true,
            lease: view(lease.key, lease.owner, lease.token, expiresAt),
            signals: JSON.parse(row.signals) as LeaseSignal[],
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
  };

  const agentRuns: AgentRunStore = {
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
  };

  return {
    leases,
    agentRuns,
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
