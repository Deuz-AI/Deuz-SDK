import type { SqliteDatabaseLike, SqliteStatementLike } from './store-sqlite';
import type {
  SwarmEvent,
  SwarmKey,
  SwarmRunRecord,
  SwarmSnapshot,
  SwarmStore,
  SwarmTaskRecord,
} from '../types/swarm';
import {
  decodeSwarm,
  encodeSwarm,
  makeSwarmEvents,
  nextSwarmRun,
  SwarmConflictError,
  validateEventCursor,
  validateSwarmSnapshot,
  validateSpawn,
  validateTaskChange,
} from '../swarm/store';

export interface SqliteSwarmStoreOptions {
  path: string;
  /** This store owns the injected connection; close() closes it. */
  database?: SqliteDatabaseLike;
  wal?: boolean;
}

export interface SqliteSwarmStore extends SwarmStore {
  close(): Promise<void>;
}

interface PayloadRow {
  payload: string;
}

/**
 * Schema 2 (2.2): run status/updated_at columns for listing and the blackboard
 * channel table. A 2.1 file (schema 1) upgrades in place, once, inside one
 * transaction; 2.1 then refuses the file, which is the intended downgrade.
 */
const SCHEMA_VERSION = 2;

function createVersion2Objects(db: SqliteDatabaseLike): void {
  db.exec(`CREATE TABLE IF NOT EXISTS deuz_swarm_channels (
    scope TEXT NOT NULL, run_id TEXT NOT NULL, channel TEXT NOT NULL, sequence INTEGER NOT NULL,
    entry_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(scope, run_id, channel, sequence), UNIQUE(scope, run_id, entry_id));
    CREATE INDEX IF NOT EXISTS deuz_swarm_runs_status ON deuz_swarm_runs(scope, status, updated_at);`);
}

/** Single executor store. Its private schema version never uses PRAGMA user_version. */
export function createSqliteSwarmStore(options: SqliteSwarmStoreOptions): SqliteSwarmStore {
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
            'CREATE TABLE IF NOT EXISTS deuz_swarm_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
          );
          const row = db!
            .prepare('SELECT version FROM deuz_swarm_schema WHERE singleton = 1')
            .get() as { version: number } | undefined;
          if (row && row.version !== 1 && row.version !== SCHEMA_VERSION)
            throw new Error('Unsupported SQLite swarm schema version');
          if (!row) {
            db!.exec(`CREATE TABLE IF NOT EXISTS deuz_swarm_runs (
            scope TEXT NOT NULL, run_id TEXT NOT NULL, payload TEXT NOT NULL,
            status TEXT, updated_at INTEGER, PRIMARY KEY(scope, run_id));
            CREATE TABLE IF NOT EXISTS deuz_swarm_tasks (
            scope TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            payload TEXT NOT NULL, PRIMARY KEY(scope, run_id, task_id));
            CREATE TABLE IF NOT EXISTS deuz_swarm_events (
            scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY(scope, run_id, sequence));`);
            createVersion2Objects(db!);
            db!.exec(
              `INSERT INTO deuz_swarm_schema(singleton,version) VALUES(1,${SCHEMA_VERSION})`,
            );
          } else if (row.version === 1) {
            // A 2.1 file: index the run status for listing, backfill it, add channels.
            db!.exec(`ALTER TABLE deuz_swarm_runs ADD COLUMN status TEXT;
            ALTER TABLE deuz_swarm_runs ADD COLUMN updated_at INTEGER;`);
            const update = db!.prepare(
              'UPDATE deuz_swarm_runs SET status=?, updated_at=? WHERE scope=? AND run_id=?',
            );
            for (const run of db!
              .prepare('SELECT scope, run_id, payload FROM deuz_swarm_runs')
              .all() as { scope: string; run_id: string; payload: string }[]) {
              const record = decodeSwarm<SwarmRunRecord>(run.payload);
              update.run(record.status, record.updatedAt, run.scope, run.run_id);
            }
            createVersion2Objects(db!);
            db!.exec(
              `UPDATE deuz_swarm_schema SET version = ${SCHEMA_VERSION} WHERE singleton = 1`,
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
    if (closed) throw new Error('SQLite swarm store is closed');
    admitted++;
    try {
      return operation(await open());
    } finally {
      admitted--;
      if (admitted === 0) drained?.();
    }
  };
  const readRun = (db: SqliteDatabaseLike, key: SwarmKey): SwarmRunRecord | undefined => {
    const row = statement(db, 'SELECT payload FROM deuz_swarm_runs WHERE scope=? AND run_id=?').get(
      key.scope,
      key.runId,
    ) as PayloadRow | undefined;
    if (!row) return undefined;
    const run = decodeSwarm<SwarmRunRecord>(row.payload);
    validateSwarmSnapshot({ run, tasks: [] }, key);
    return run;
  };
  const writeEvents = (db: SqliteDatabaseLike, events: readonly SwarmEvent[]) => {
    const insert = statement(
      db,
      'INSERT INTO deuz_swarm_events(scope,run_id,sequence,payload) VALUES(?,?,?,?)',
    );
    for (const event of events)
      insert.run(event.scope, event.runId, event.sequence, encodeSwarm(event));
  };
  return {
    capabilities: Object.freeze(['spawn'] as const),
    async create(snapshot, inputs) {
      validateSwarmSnapshot(snapshot);
      if (snapshot.run.revision !== 0 || snapshot.run.lastSequence !== 0)
        throw new Error('New swarm counters must start at zero');
      return use((db) =>
        transaction(db, () => {
          if (readRun(db, snapshot.run)) throw new SwarmConflictError();
          const events = makeSwarmEvents(snapshot.run, 0, inputs);
          const run = { ...snapshot.run, lastSequence: events.length };
          statement(
            db,
            'INSERT INTO deuz_swarm_runs(scope,run_id,payload,status,updated_at) VALUES(?,?,?,?,?)',
          ).run(run.scope, run.runId, encodeSwarm(run), run.status, run.updatedAt);
          const insert = statement(
            db,
            'INSERT INTO deuz_swarm_tasks(scope,run_id,task_id,ordinal,payload) VALUES(?,?,?,?,?)',
          );
          snapshot.tasks.forEach((task, index) =>
            insert.run(run.scope, run.runId, task.task.id, index, encodeSwarm(task)),
          );
          writeEvents(db, events);
          return run;
        }),
      );
    },
    async load(key) {
      return use((db) =>
        transaction(db, () => {
          const run = readRun(db, key);
          if (!run) return undefined;
          const rows = statement(
            db,
            'SELECT payload FROM deuz_swarm_tasks WHERE scope=? AND run_id=? ORDER BY ordinal',
          ).all(key.scope, key.runId) as PayloadRow[];
          const snapshot: SwarmSnapshot = {
            run,
            tasks: rows.map((row) => decodeSwarm<SwarmTaskRecord>(row.payload)),
          };
          validateSwarmSnapshot(snapshot, key);
          return snapshot;
        }),
      );
    },
    async head(key) {
      return use((db) => readRun(db, key));
    },
    async commit(change) {
      return use((db) =>
        transaction(db, () => {
          const previous = readRun(db, change);
          if (!previous) throw new Error('Swarm run not found');
          const run = nextSwarmRun(previous, change);
          for (const task of change.tasks ?? []) {
            const exists = statement(
              db,
              'SELECT payload FROM deuz_swarm_tasks WHERE scope=? AND run_id=? AND task_id=?',
            ).get(change.scope, change.runId, task.task.id) as PayloadRow | undefined;
            if (!exists) throw new Error('Cannot add tasks to a fixed swarm DAG');
            validateTaskChange(decodeSwarm<SwarmTaskRecord>(exists.payload), task, run);
            statement(
              db,
              'UPDATE deuz_swarm_tasks SET payload=? WHERE scope=? AND run_id=? AND task_id=?',
            ).run(encodeSwarm(task), change.scope, change.runId, task.task.id);
          }
          const spawn = change.spawn ?? [];
          if (spawn.length) {
            const count = statement(
              db,
              'SELECT COUNT(*) AS n, COALESCE(MAX(ordinal), -1) AS last FROM deuz_swarm_tasks WHERE scope=? AND run_id=?',
            ).get(change.scope, change.runId) as { n: number; last: number };
            validateSpawn({
              run,
              tasks: change.tasks ?? [],
              spawn,
              count: count.n,
              exists: (taskId) =>
                !!statement(
                  db,
                  'SELECT 1 AS found FROM deuz_swarm_tasks WHERE scope=? AND run_id=? AND task_id=?',
                ).get(change.scope, change.runId, taskId),
            });
            const insert = statement(
              db,
              'INSERT INTO deuz_swarm_tasks(scope,run_id,task_id,ordinal,payload) VALUES(?,?,?,?,?)',
            );
            spawn.forEach((task, index) =>
              insert.run(
                change.scope,
                change.runId,
                task.task.id,
                count.last + 1 + index,
                encodeSwarm(task),
              ),
            );
          }
          statement(
            db,
            'UPDATE deuz_swarm_runs SET payload=?, status=?, updated_at=? WHERE scope=? AND run_id=?',
          ).run(encodeSwarm(run), run.status, run.updatedAt, change.scope, change.runId);
          writeEvents(db, makeSwarmEvents(change, previous.lastSequence, change.events ?? []));
          return run;
        }),
      );
    },
    async readEvents(key, afterSequence, limit) {
      validateEventCursor(afterSequence, limit);
      return use((db) =>
        (
          statement(
            db,
            'SELECT payload FROM deuz_swarm_events WHERE scope=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
          ).all(key.scope, key.runId, afterSequence, limit) as PayloadRow[]
        ).map((row) => decodeSwarm<SwarmEvent>(row.payload)),
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
