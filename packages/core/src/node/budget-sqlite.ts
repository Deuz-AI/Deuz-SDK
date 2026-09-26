/**
 * The SQLite `BudgetStore` (2.2). Every mutation runs in `BEGIN IMMEDIATE`, so
 * processes sharing one database file admit against the same budgets without
 * over-admitting. Its private schema version never uses PRAGMA user_version.
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import type { Clock } from '../types/deps';
import type { BudgetStore, BudgetStoreReservation } from '../types/budget-store';
import {
  assertBudgetActual,
  assertBudgetKey,
  assertSameWindow,
  assertUsageOptions,
  bucketIndex,
  decideBudgetAdmission,
  firstCountedBucket,
  normalizeBudgetReserve,
  planBudgetTransition,
  reservationConflict,
  summarizeBudgetUsage,
} from '../budget-store';
import { resolveDependencies } from '../internal/resolve-deps';

export interface SqliteBudgetStoreOptions {
  /** Database file, or `':memory:'` for an ephemeral one. */
  path: string;
  /** Use this handle instead of opening `node:sqlite`; the store owns it and close() closes it. */
  database?: SqliteDatabaseLike;
  /** `PRAGMA journal_mode = WAL` for file databases. Default on; ignored for `':memory:'`. */
  wal?: boolean;
  /** Time source for windows. Processes sharing a file should share a clock. */
  clock?: Clock;
}

export interface SqliteBudgetStore extends BudgetStore {
  close(): Promise<void>;
}

const SCHEMA_VERSION = 1;

interface RequestRow {
  fingerprint: string;
  model_id: string;
  tokens: number;
  usd: number;
  state: 'reserved' | 'settled' | 'released' | 'denied';
  charges: string;
  actual_tokens: number | null;
  actual_usd: number | null;
  outcome: string;
}

export function createSqliteBudgetStore(options: SqliteBudgetStoreOptions): SqliteBudgetStore {
  const clock = options.clock ?? resolveDependencies().clock;
  let opening: Promise<SqliteDatabaseLike> | undefined;
  let database: SqliteDatabaseLike | undefined;
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
  const open = (): Promise<SqliteDatabaseLike> => {
    opening ??= (async () => {
      let db = options.database;
      if (!db) {
        const module = (await import('node:sqlite' as string)) as {
          DatabaseSync: new (path: string) => SqliteDatabaseLike;
        };
        db = new module.DatabaseSync(options.path);
      }
      database = db;
      if (options.path !== ':memory:' && options.wal !== false)
        db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      transaction(db, () => {
        db.exec(
          'CREATE TABLE IF NOT EXISTS deuz_budget_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
        );
        const row = db
          .prepare('SELECT version FROM deuz_budget_schema WHERE singleton = 1')
          .get() as { version: number } | undefined;
        if (row && row.version !== SCHEMA_VERSION)
          throw new Error('Unsupported SQLite budget schema version');
        if (row) return;
        db.exec(`CREATE TABLE IF NOT EXISTS deuz_budget_scopes (
          key TEXT PRIMARY KEY, window_ms INTEGER, buckets INTEGER NOT NULL, bucket_ms INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS deuz_budget_counters (
          key TEXT NOT NULL, bucket INTEGER NOT NULL, model_id TEXT NOT NULL,
          tokens INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY(key, bucket, model_id));
          CREATE TABLE IF NOT EXISTS deuz_budget_requests (
          request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, model_id TEXT NOT NULL,
          tokens INTEGER NOT NULL, usd REAL NOT NULL, state TEXT NOT NULL, charges TEXT NOT NULL,
          actual_tokens INTEGER, actual_usd REAL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);`);
        db.exec(`INSERT INTO deuz_budget_schema(singleton, version) VALUES(1, ${SCHEMA_VERSION})`);
      });
      return db;
    })();
    return opening;
  };
  const use = async <T>(operation: (db: SqliteDatabaseLike) => T): Promise<T> => {
    if (closed) throw new Error('SQLite budget store is closed');
    admitted++;
    try {
      return operation(await open());
    } finally {
      admitted--;
      if (admitted === 0) drained?.();
    }
  };
  const readRequest = (db: SqliteDatabaseLike, requestId: string) =>
    statement(
      db,
      'SELECT fingerprint, model_id, tokens, usd, state, charges, actual_tokens, actual_usd, outcome FROM deuz_budget_requests WHERE request_id = ?',
    ).get(requestId) as RequestRow | undefined;
  const addCounter = (
    db: SqliteDatabaseLike,
    charge: { key: string; index: number },
    modelId: string,
    tokens: number,
    usd: number,
  ) =>
    statement(
      db,
      `INSERT INTO deuz_budget_counters(key, bucket, model_id, tokens, usd) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(key, bucket, model_id) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd`,
    ).run(charge.key, charge.index, modelId, tokens, usd);
  const chargesOf = (row: RequestRow) =>
    JSON.parse(row.charges) as { key: string; index: number }[];

  return {
    async reserve(input) {
      const request = normalizeBudgetReserve(input);
      return use((db) =>
        transaction(db, (): BudgetStoreReservation => {
          const existing = readRequest(db, request.requestId);
          if (existing) {
            if (existing.fingerprint !== request.fingerprint)
              throw reservationConflict(request.requestId);
            return JSON.parse(existing.outcome) as BudgetStoreReservation;
          }
          for (const scope of request.scopes) {
            const saved = statement(
              db,
              'SELECT window_ms, buckets FROM deuz_budget_scopes WHERE key = ?',
            ).get(scope.key) as { window_ms: number | null; buckets: number } | undefined;
            if (saved)
              assertSameWindow(scope, { windowMs: saved.window_ms, buckets: saved.buckets });
          }
          for (const scope of request.scopes)
            statement(
              db,
              'INSERT INTO deuz_budget_scopes(key, window_ms, buckets, bucket_ms) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
            ).run(scope.key, scope.windowMs, scope.buckets, scope.bucketMs);
          const at = clock.now();
          const outcome = decideBudgetAdmission(
            request,
            request.scopes.map((scope) => {
              const sum = statement(
                db,
                'SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(usd), 0) AS usd FROM deuz_budget_counters WHERE key = ? AND bucket >= ?',
              ).get(scope.key, firstCountedBucket(scope, at)) as { tokens: number; usd: number };
              return { tokens: Number(sum.tokens), usd: Number(sum.usd) };
            }),
          );
          const charges = request.scopes.map((scope) => ({
            key: scope.key,
            index: bucketIndex(scope, at),
          }));
          const tokens = request.tokens ?? 0;
          const usd = request.usd ?? 0;
          if (outcome.admitted)
            for (const charge of charges) addCounter(db, charge, request.modelId, tokens, usd);
          statement(
            db,
            `INSERT INTO deuz_budget_requests(request_id, fingerprint, model_id, tokens, usd, state, charges, outcome, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            request.requestId,
            request.fingerprint,
            request.modelId,
            tokens,
            usd,
            outcome.admitted ? 'reserved' : 'denied',
            JSON.stringify(charges),
            JSON.stringify(outcome),
            at,
          );
          return outcome;
        }),
      );
    },
    async settle(requestId, actual) {
      assertBudgetKey(requestId);
      const settle = assertBudgetActual(actual);
      await use((db) =>
        transaction(db, () => {
          const current = readRequest(db, requestId);
          if (
            !current ||
            planBudgetTransition(
              requestId,
              {
                state: current.state,
                actualTokens: current.actual_tokens,
                actualUsd: current.actual_usd,
              },
              { settle },
            ) === 'noop'
          )
            return;
          for (const charge of chargesOf(current))
            addCounter(
              db,
              charge,
              current.model_id,
              settle.tokens - current.tokens,
              settle.usd - current.usd,
            );
          statement(
            db,
            "UPDATE deuz_budget_requests SET state = 'settled', actual_tokens = ?, actual_usd = ? WHERE request_id = ?",
          ).run(settle.tokens, settle.usd, requestId);
        }),
      );
    },
    async release(requestId) {
      assertBudgetKey(requestId);
      await use((db) =>
        transaction(db, () => {
          const current = readRequest(db, requestId);
          if (
            !current ||
            planBudgetTransition(
              requestId,
              {
                state: current.state,
                actualTokens: current.actual_tokens,
                actualUsd: current.actual_usd,
              },
              { release: true },
            ) === 'noop'
          )
            return;
          if (current.state === 'reserved')
            for (const charge of chargesOf(current))
              addCounter(db, charge, current.model_id, -current.tokens, -current.usd);
          statement(
            db,
            "UPDATE deuz_budget_requests SET state = 'released' WHERE request_id = ?",
          ).run(requestId);
        }),
      );
    },
    async usage(key, usageOptions = {}) {
      assertUsageOptions(key, usageOptions);
      return use((db) => {
        const scope = statement(db, 'SELECT bucket_ms FROM deuz_budget_scopes WHERE key = ?').get(
          key,
        ) as { bucket_ms: number } | undefined;
        if (!scope) return summarizeBudgetUsage([], usageOptions.byModel);
        // A bucket counts while any part of it lies after `since`.
        const first =
          usageOptions.since === undefined
            ? Number.MIN_SAFE_INTEGER
            : Math.floor(usageOptions.since / scope.bucket_ms);
        const rows = statement(
          db,
          'SELECT model_id, SUM(tokens) AS tokens, SUM(usd) AS usd FROM deuz_budget_counters WHERE key = ? AND bucket >= ? GROUP BY model_id',
        ).all(key, first) as { model_id: string; tokens: number; usd: number }[];
        return summarizeBudgetUsage(
          rows.map((row) => ({
            modelId: row.model_id,
            tokens: Number(row.tokens),
            usd: Number(row.usd),
          })),
          usageOptions.byModel,
        );
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (admitted)
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      if (opening) await opening.catch(() => undefined);
      (database ?? options.database)?.close();
      statements.clear();
    },
  };
}
