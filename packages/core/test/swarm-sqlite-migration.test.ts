import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';
import { createSwarm } from '../src/swarm';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const key = { scope: 'tenant', runId: 'legacy' };

/** The exact schema and rows a 2.1 store wrote (swarm schema version 1). */
function writeVersion1(db: SqliteDatabaseLike): void {
  db.exec(`CREATE TABLE deuz_swarm_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
    CREATE TABLE deuz_swarm_runs (
    scope TEXT NOT NULL, run_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope, run_id));
    CREATE TABLE deuz_swarm_tasks (
    scope TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(scope, run_id, task_id));
    CREATE TABLE deuz_swarm_events (
    scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(scope, run_id, sequence));
    INSERT INTO deuz_swarm_schema(singleton,version) VALUES(1,1);`);
  const run = {
    kind: 'deuz-swarm',
    version: 1,
    ...key,
    definitionVersion: '1',
    status: 'suspended',
    revision: 3,
    lastSequence: 2,
    createdAt: 1,
    updatedAt: 5,
    cancelRequested: false,
  };
  db.prepare('INSERT INTO deuz_swarm_runs(scope,run_id,payload) VALUES(?,?,?)').run(
    key.scope,
    key.runId,
    JSON.stringify(run),
  );
  const tasks = [
    {
      task: { id: 'a', reducer: 'sum' },
      bindingVersion: '1',
      status: 'completed',
      attempt: 1,
      result: { output: 40 },
    },
    {
      task: { id: 'b', reducer: 'sum', dependsOn: ['a'], replay: 'safe' },
      bindingVersion: '1',
      status: 'running',
      attempt: 1,
    },
  ];
  tasks.forEach((task, index) =>
    db
      .prepare(
        'INSERT INTO deuz_swarm_tasks(scope,run_id,task_id,ordinal,payload) VALUES(?,?,?,?,?)',
      )
      .run(key.scope, key.runId, task.task.id, index, JSON.stringify(task)),
  );
  ['run.started', 'task.completed'].forEach((type, index) =>
    db
      .prepare('INSERT INTO deuz_swarm_events(scope,run_id,sequence,payload) VALUES(?,?,?,?)')
      .run(
        key.scope,
        key.runId,
        index + 1,
        JSON.stringify({ type, timestamp: index + 1, ...key, version: 1, sequence: index + 1 }),
      ),
  );
}

async function legacyFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'deuz-swarm-v1-'));
  cleanup.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
  );
  const path = join(directory, 'legacy.sqlite');
  const seed = new DatabaseSync!(path);
  writeVersion1(seed);
  seed.close();
  return path;
}

describe.skipIf(!DatabaseSync)('SQLite swarm schema 1 → 2 (2.2)', () => {
  it('upgrades a 2.1 file in place and resumes its run', async () => {
    const path = await legacyFile();
    const store = createSqliteSwarmStore({ path });
    cleanup.push(() => store.close());
    const loaded = await store.load(key);
    expect(loaded?.run.version).toBe(1);
    expect(loaded?.tasks.map((task) => task.status)).toEqual(['completed', 'running']);
    expect((await store.readEvents(key, 0, 10)).map((event) => event.type)).toEqual([
      'run.started',
      'task.completed',
    ]);
    const inspect = new DatabaseSync!(path);
    cleanup.push(() => inspect.close());
    expect(inspect.prepare('SELECT version FROM deuz_swarm_schema').get()).toEqual({
      version: 2,
    });
    expect(inspect.prepare('SELECT status, updated_at FROM deuz_swarm_runs').get()).toEqual({
      status: 'suspended',
      updated_at: 5,
    });
    const swarm = createSwarm({
      agents: {},
      store,
      reducers: { sum: { execute: (results) => Number(results.a?.output) + 2 } },
    });
    const result = await (await swarm.resume(key)).result;
    expect(result.run.status).toBe('completed');
    expect(result.tasks[1]?.result?.output).toBe(42);
    expect(inspect.prepare('SELECT status FROM deuz_swarm_runs').get()).toEqual({
      status: 'completed',
    });
  });

  it('lets two openers race the upgrade and both read the run', async () => {
    const path = await legacyFile();
    const first = createSqliteSwarmStore({ path });
    const second = createSqliteSwarmStore({ path });
    cleanup.push(
      () => first.close(),
      () => second.close(),
    );
    const [a, b] = await Promise.all([first.load(key), second.load(key)]);
    expect(a?.tasks).toHaveLength(2);
    expect(b?.tasks).toHaveLength(2);
    const inspect = new DatabaseSync!(path);
    cleanup.push(() => inspect.close());
    const columns = (
      inspect.prepare('PRAGMA table_info(deuz_swarm_runs)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns.filter((name) => name === 'status' || name === 'updated_at')).toEqual([
      'status',
      'updated_at',
    ]);
    expect(inspect.prepare('SELECT version FROM deuz_swarm_schema').get()).toEqual({
      version: 2,
    });
  });
});
