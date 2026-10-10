/**
 * The SQLite `BudgetStore` (2.2). Every mutation runs in `BEGIN IMMEDIATE`, so
 * processes sharing one database file admit against the same budgets without
 * over-admitting. Its private schema version never uses PRAGMA user_version.
 *
 * Since 2.3 a lifetime admission reads a key's running total from
 * `deuz_budget_totals` instead of summing its whole history. Triggers on the
 * history table keep the totals, so a 2.2 process sharing the file keeps them
 * right too, and the schema version stays 1.
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import { ensureBusyTimeout } from './sqlite-open';
import type { Clock } from '../types/deps';
import type {
  BudgetHold,
  BudgetPruneResult,
  BudgetStore,
  BudgetStoreMaintenance,
  BudgetStoreReservation,
} from '../types/budget-store';
import {
  assertBudgetActual,
  assertBudgetKey,
  assertPruneOptions,
  budgetHold,
  assertSameWindow,
  assertUsageOptions,
  bucketIndex,
  decideBudgetAdmission,
  firstCountedBucket,
  normalizeBudgetReserve,
  normalizeHoldQuery,
  planBudgetTransition,
  reservationConflict,
  summarizeBudgetUsage,
  sweepBudgetHolds,
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
  /** Retention (2.3): see `BudgetStore.prune`. */
  prune: BudgetStoreMaintenance['prune'];
  /** Open holds (2.3): see `BudgetStore.holds`. */
  holds: BudgetStoreMaintenance['holds'];
  /** Hold reconciliation (2.3): see `BudgetStore.sweep`. */
  sweep: BudgetStoreMaintenance['sweep'];
  close(): Promise<void>;
}

const SCHEMA_VERSION = 1;

const TOTALS_TRIGGERS = [
  'deuz_budget_totals_insert',
  'deuz_budget_totals_update',
  'deuz_budget_totals_delete',
] as const;

/**
 * Creates the running totals and their triggers (2.3), filled from the
 * history, unless every part is already in place. Runs in the open
 * transaction, so a file gains them once whichever process opens it first.
 */
function ensureTotals(db: SqliteDatabaseLike): void {
  const present = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE (type = 'table' AND name = 'deuz_budget_totals')
       OR (type = 'trigger' AND name IN (${TOTALS_TRIGGERS.map((name) => `'${name}'`).join(', ')}))`,
    )
    .get() as { n: number };
  if (Number(present.n) === TOTALS_TRIGGERS.length + 1) return;
  db.exec(`${TOTALS_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n')}
    DROP TABLE IF EXISTS deuz_budget_totals;
    CREATE TABLE deuz_budget_totals (key TEXT PRIMARY KEY, tokens INTEGER NOT NULL, usd REAL NOT NULL);
    INSERT INTO deuz_budget_totals(key, tokens, usd)
      SELECT key, SUM(tokens), SUM(usd) FROM deuz_budget_counters GROUP BY key;
    CREATE TRIGGER deuz_budget_totals_insert AFTER INSERT ON deuz_budget_counters BEGIN
      INSERT INTO deuz_budget_totals(key, tokens, usd) VALUES (NEW.key, NEW.tokens, NEW.usd)
      ON CONFLICT(key) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd;
    END;
    CREATE TRIGGER deuz_budget_totals_update AFTER UPDATE ON deuz_budget_counters BEGIN
      UPDATE deuz_budget_totals SET tokens = tokens + NEW.tokens - OLD.tokens,
        usd = usd + NEW.usd - OLD.usd WHERE key = NEW.key;
    END;
    CREATE TRIGGER deuz_budget_totals_delete AFTER DELETE ON deuz_budget_counters BEGIN
      UPDATE deuz_budget_totals SET tokens = tokens - OLD.tokens, usd = usd - OLD.usd
        WHERE key = OLD.key;
    END;`);
}

/** The history rows `prune` may fold, from `k` joined with its scope `s` (2.3): see isFoldableBucket. */
const FOLDABLE = `(k.bucket + 1) * s.bucket_ms <= ? AND (k.bucket + 2) * s.bucket_ms <= ?
  AND (s.window_ms IS NULL OR (k.bucket + s.buckets) * s.bucket_ms <= ?)
  AND NOT EXISTS (SELECT 1 FROM temp.deuz_budget_held h WHERE h.key = k.key AND h.bucket = k.bucket)`;

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
      try {
        ensureBusyTimeout(db);
        if (options.path !== ':memory:' && options.wal !== false)
          db.exec('PRAGMA journal_mode = WAL');
        transaction(db, () => {
          db.exec(
            'CREATE TABLE IF NOT EXISTS deuz_budget_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
          );
          const row = db
            .prepare('SELECT version FROM deuz_budget_schema WHERE singleton = 1')
            .get() as { version: number } | undefined;
          if (row && row.version !== SCHEMA_VERSION)
            throw new Error('Unsupported SQLite budget schema version');
          if (!row) {
            db.exec(`CREATE TABLE IF NOT EXISTS deuz_budget_scopes (
            key TEXT PRIMARY KEY, window_ms INTEGER, buckets INTEGER NOT NULL, bucket_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS deuz_budget_counters (
            key TEXT NOT NULL, bucket INTEGER NOT NULL, model_id TEXT NOT NULL,
            tokens INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY(key, bucket, model_id));
            CREATE TABLE IF NOT EXISTS deuz_budget_requests (
            request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, model_id TEXT NOT NULL,
            tokens INTEGER NOT NULL, usd REAL NOT NULL, state TEXT NOT NULL, charges TEXT NOT NULL,
            actual_tokens INTEGER, actual_usd REAL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);`);
            db.exec(
              `INSERT INTO deuz_budget_schema(singleton, version) VALUES(1, ${SCHEMA_VERSION})`,
            );
          }
          // 2.3, on every open: additions a 2.2 process ignores, so version 1 stays.
          db.exec(
            'CREATE INDEX IF NOT EXISTS deuz_budget_requests_state ON deuz_budget_requests(state, created_at)',
          );
          ensureTotals(db);
        });
      } catch (error) {
        // An injected handle stays open: the next call retries on it.
        if (!options.database) db.close();
        throw error;
      }
      database = db;
      return db;
    })();
    // A failed open must not poison the store for the rest of the process.
    opening.catch(() => {
      opening = undefined;
    });
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

  const store: SqliteBudgetStore = {
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
              // A lifetime scope counts every bucket: their running total (2.3).
              const sum = (
                scope.windowMs === null
                  ? statement(db, 'SELECT tokens, usd FROM deuz_budget_totals WHERE key = ?').get(
                      scope.key,
                    )
                  : statement(
                      db,
                      'SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(usd), 0) AS usd FROM deuz_budget_counters WHERE key = ? AND bucket >= ?',
                    ).get(scope.key, firstCountedBucket(scope, at))
              ) as { tokens: number; usd: number } | undefined;
              return { tokens: Number(sum?.tokens ?? 0), usd: Number(sum?.usd ?? 0) };
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
    async prune(pruneOptions) {
      const before = assertPruneOptions(pruneOptions);
      return use((db) =>
        transaction(db, (): BudgetPruneResult => {
          const at = clock.now();
          const finished = "state <> 'reserved' AND created_at < ?";
          const requests = Number(
            (
              statement(db, `SELECT COUNT(*) AS n FROM deuz_budget_requests WHERE ${finished}`).get(
                before,
              ) as { n: number }
            ).n,
          );
          if (requests)
            statement(db, `DELETE FROM deuz_budget_requests WHERE ${finished}`).run(before);
          // An open hold keeps the buckets its settlement adjusts. The fold is
          // planned in temporary tables, so a long history never reaches the heap.
          db.exec(`CREATE TEMP TABLE IF NOT EXISTS deuz_budget_held (
            key TEXT NOT NULL, bucket INTEGER NOT NULL, PRIMARY KEY(key, bucket));
            CREATE TEMP TABLE IF NOT EXISTS deuz_budget_fold (
            key TEXT NOT NULL, model_id TEXT NOT NULL, keep INTEGER NOT NULL,
            tokens INTEGER NOT NULL, usd REAL NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(key, model_id));
            DELETE FROM temp.deuz_budget_held;
            DELETE FROM temp.deuz_budget_fold;`);
          statement(
            db,
            `INSERT OR IGNORE INTO temp.deuz_budget_held(key, bucket)
             SELECT json_extract(c.value, '$.key'), json_extract(c.value, '$.index')
             FROM deuz_budget_requests r, json_each(r.charges) c WHERE r.state = 'reserved'`,
          ).run();
          statement(
            db,
            `INSERT INTO temp.deuz_budget_fold(key, model_id, keep, tokens, usd, n)
             SELECT k.key, k.model_id, MAX(k.bucket), SUM(k.tokens), SUM(k.usd), COUNT(*)
             FROM deuz_budget_counters k JOIN deuz_budget_scopes s ON s.key = k.key
             WHERE ${FOLDABLE} GROUP BY k.key, k.model_id HAVING COUNT(*) > 1`,
          ).run(before, at, at);
          const buckets = Number(
            (
              statement(
                db,
                'SELECT COALESCE(SUM(n - 1), 0) AS n FROM temp.deuz_budget_fold',
              ).get() as {
                n: number;
              }
            ).n,
          );
          if (buckets) {
            // Each scope and model keeps its newest foldable row, now holding the sum.
            statement(
              db,
              `DELETE FROM deuz_budget_counters WHERE rowid IN (
                SELECT k.rowid FROM deuz_budget_counters k
                JOIN temp.deuz_budget_fold f ON f.key = k.key AND f.model_id = k.model_id
                JOIN deuz_budget_scopes s ON s.key = k.key
                WHERE k.bucket < f.keep AND ${FOLDABLE})`,
            ).run(before, at, at);
            statement(
              db,
              `UPDATE deuz_budget_counters SET tokens = f.tokens, usd = f.usd
               FROM temp.deuz_budget_fold AS f
               WHERE deuz_budget_counters.key = f.key AND deuz_budget_counters.model_id = f.model_id
                 AND deuz_budget_counters.bucket = f.keep`,
            ).run();
          }
          return { requests, buckets };
        }),
      );
    },
    async holds(query) {
      const { before, limit, after } = normalizeHoldQuery(query);
      return use((db) =>
        (
          statement(
            db,
            `SELECT request_id, model_id, tokens, usd, charges, created_at FROM deuz_budget_requests
             WHERE state = 'reserved' AND created_at < ?
               AND (? IS NULL OR created_at > ? OR (created_at = ? AND request_id > ?))
             ORDER BY created_at, request_id LIMIT ?`,
          ).all(
            before,
            after?.reservedAt ?? null,
            after?.reservedAt ?? null,
            after?.reservedAt ?? null,
            after?.requestId ?? null,
            limit,
          ) as (Pick<RequestRow, 'model_id' | 'tokens' | 'usd' | 'charges'> & {
            request_id: string;
            created_at: number;
          })[]
        ).map(
          (row): BudgetHold =>
            budgetHold(row.request_id, {
              modelId: row.model_id,
              tokens: Number(row.tokens),
              usd: Number(row.usd),
              at: Number(row.created_at),
              charges: JSON.parse(row.charges) as { key: string; index: number }[],
            }),
        ),
      );
    },
    sweep: (sweepOptions) => sweepBudgetHolds(store, sweepOptions),
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
  return store;
}
