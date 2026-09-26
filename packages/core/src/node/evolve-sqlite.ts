/**
 * node/evolve-sqlite.ts — a SQLite `PopulationStore` for `./evolve` (2.2),
 * shipped as `./evolve/sqlite`. Node-only: it opens `node:sqlite` lazily
 * unless a `SqliteDatabaseLike` (better-sqlite3 works) is injected.
 *
 * Every write runs in `BEGIN IMMEDIATE`, so the generation compare-and-set and
 * the idempotent candidate insert hold across processes sharing one file. The
 * schema version lives in a private table; `PRAGMA user_version` is left alone.
 */
import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import type { EvolveCandidate, EvolveKey, EvolveRunRecord, PopulationStore } from '../evolve/types';
import {
  compareCandidates,
  decodeEvolve,
  EvolveConflictError,
  validateCandidate,
  validateCommit,
  validateEvolveKey,
  validateRunRecord,
} from '../evolve/store';

export interface SqlitePopulationStoreOptions {
  path: string;
  /** This store owns the injected connection; close() closes it. */
  database?: SqliteDatabaseLike;
  wal?: boolean;
}

export interface SqlitePopulationStore extends PopulationStore {
  close(): Promise<void>;
}

const SCHEMA_VERSION = 1;

interface PayloadRow {
  payload: string;
}

export function createSqlitePopulationStore(
  options: SqlitePopulationStoreOptions,
): SqlitePopulationStore {
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
        if (options.path !== ':memory:' && options.wal !== false)
          db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA busy_timeout = 5000');
        transaction(db, () => {
          db.exec(
            'CREATE TABLE IF NOT EXISTS deuz_evolve_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
          );
          const row = db!
            .prepare('SELECT version FROM deuz_evolve_schema WHERE singleton = 1')
            .get() as { version: number } | undefined;
          if (row && row.version !== SCHEMA_VERSION)
            throw new Error('Unsupported SQLite evolve schema version');
          if (!row) {
            db!.exec(`CREATE TABLE IF NOT EXISTS deuz_evolve_runs (
              scope TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
              status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL,
              PRIMARY KEY(scope, run_id));
            CREATE TABLE IF NOT EXISTS deuz_evolve_candidates (
              scope TEXT NOT NULL, run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
              generation INTEGER NOT NULL, island INTEGER NOT NULL, slot INTEGER NOT NULL,
              payload TEXT NOT NULL, PRIMARY KEY(scope, run_id, candidate_id));
            CREATE INDEX IF NOT EXISTS deuz_evolve_candidates_order
              ON deuz_evolve_candidates(scope, run_id, generation, island, slot);`);
            db!.exec(
              `INSERT INTO deuz_evolve_schema(singleton,version) VALUES(1,${SCHEMA_VERSION})`,
            );
          }
        });
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    })();
    return opening;
  };
  const use = async <T>(operation: (db: SqliteDatabaseLike) => T): Promise<T> => {
    if (closed) throw new Error('SQLite population store is closed');
    admitted++;
    try {
      return operation(await open());
    } finally {
      admitted--;
      if (admitted === 0) drained?.();
    }
  };
  const readRun = (db: SqliteDatabaseLike, key: EvolveKey): EvolveRunRecord | undefined => {
    const row = statement(
      db,
      'SELECT payload FROM deuz_evolve_runs WHERE scope=? AND run_id=?',
    ).get(key.scope, key.runId) as PayloadRow | undefined;
    return row ? decodeEvolve<EvolveRunRecord>(row.payload) : undefined;
  };
  const writeRun = (db: SqliteDatabaseLike, run: EvolveRunRecord, encoded: string) => {
    statement(
      db,
      'UPDATE deuz_evolve_runs SET generation=?, status=?, updated_at=?, payload=? WHERE scope=? AND run_id=?',
    ).run(run.generation, run.status, run.updatedAt, encoded, run.scope, run.runId);
  };
  const decodeRows = (rows: unknown[]) =>
    (rows as PayloadRow[]).map((row) => decodeEvolve<EvolveCandidate>(row.payload));
  return {
    async createRun(run) {
      const encoded = validateRunRecord(run);
      return use((db) =>
        transaction(db, () => {
          if (readRun(db, run)) throw new EvolveConflictError('Evolve run already exists');
          statement(
            db,
            'INSERT INTO deuz_evolve_runs(scope,run_id,generation,status,updated_at,payload) VALUES(?,?,?,?,?,?)',
          ).run(run.scope, run.runId, run.generation, run.status, run.updatedAt, encoded);
        }),
      );
    },
    async loadRun(key) {
      validateEvolveKey(key);
      return use((db) => readRun(db, key));
    },
    async putCandidate(candidate) {
      const encoded = validateCandidate(candidate);
      return use((db) =>
        transaction(db, () => {
          if (!readRun(db, candidate)) throw new Error('Evolve run not found');
          const existing = statement(
            db,
            'SELECT payload FROM deuz_evolve_candidates WHERE scope=? AND run_id=? AND candidate_id=?',
          ).get(candidate.scope, candidate.runId, candidate.id) as PayloadRow | undefined;
          if (existing) {
            if (existing.payload !== encoded)
              throw new EvolveConflictError(`Conflicting candidate ${candidate.id}`);
            return false;
          }
          statement(
            db,
            'INSERT INTO deuz_evolve_candidates(scope,run_id,candidate_id,generation,island,slot,payload) VALUES(?,?,?,?,?,?,?)',
          ).run(
            candidate.scope,
            candidate.runId,
            candidate.id,
            candidate.generation,
            candidate.island,
            candidate.slot,
            encoded,
          );
          return true;
        }),
      );
    },
    async listCandidates(key, query = {}) {
      validateEvolveKey(key);
      if (query.ids && !query.ids.length) return [];
      return use((db) => {
        if (query.ids && query.generation === undefined) {
          // Point lookups: a resumed run asks for its population members only.
          const lookup = statement(
            db,
            'SELECT payload FROM deuz_evolve_candidates WHERE scope=? AND run_id=? AND candidate_id=?',
          );
          const rows = [...new Set(query.ids)]
            .map((id) => lookup.get(key.scope, key.runId, id) as PayloadRow | undefined)
            .filter((row): row is PayloadRow => row !== undefined);
          return decodeRows(rows).sort(compareCandidates);
        }
        const order = ' ORDER BY generation, island, slot';
        const rows =
          query.generation === undefined
            ? statement(
                db,
                `SELECT payload FROM deuz_evolve_candidates WHERE scope=? AND run_id=?${order}`,
              ).all(key.scope, key.runId)
            : statement(
                db,
                `SELECT payload FROM deuz_evolve_candidates WHERE scope=? AND run_id=? AND generation=?${order}`,
              ).all(key.scope, key.runId, query.generation);
        const wanted = query.ids ? new Set(query.ids) : undefined;
        return decodeRows(rows).filter((item) => !wanted || wanted.has(item.id));
      });
    },
    async commitGeneration(commit) {
      const encoded = validateCommit(commit);
      return use((db) =>
        transaction(db, () => {
          const previous = readRun(db, commit);
          if (!previous) throw new Error('Evolve run not found');
          if (previous.generation !== commit.expectedGeneration)
            throw new EvolveConflictError('Evolve generation conflict');
          writeRun(db, commit.run, encoded);
        }),
      );
    },
    async saveRun(run) {
      const encoded = validateRunRecord(run);
      return use((db) =>
        transaction(db, () => {
          const previous = readRun(db, run);
          if (!previous) throw new Error('Evolve run not found');
          if (previous.generation !== run.generation)
            throw new EvolveConflictError('Evolve generation conflict');
          writeRun(db, run, encoded);
        }),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      if (admitted)
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      if (opening) (await opening).close();
      else options.database?.close();
      statements.clear();
    },
  };
}
