import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemorySwarmStore } from '../src/swarm/store';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';
import { createSwarm } from '../src/swarm';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import type { SwarmSnapshot, SwarmStore } from '../src/types/swarm';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function initial(scope = 'a'): SwarmSnapshot {
  return {
    run: {
      kind: 'deuz-swarm',
      version: 1,
      scope,
      runId: 'same',
      definitionVersion: '1',
      status: 'running',
      revision: 0,
      lastSequence: 0,
      createdAt: 1,
      updatedAt: 1,
      cancelRequested: false,
    },
    tasks: [
      { task: { id: 'a', reducer: 'sum' }, bindingVersion: '1', status: 'pending', attempt: 0 },
    ],
  };
}

function contracts(name: string, make: () => SwarmStore) {
  describe(name, () => {
    it('atomically rolls back invalid multi-task writes and event publication', async () => {
      const store = make();
      const snapshot = initial();
      await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
      await expect(
        store.commit({
          ...snapshot.run,
          expectedRevision: 0,
          tasks: [
            { ...snapshot.tasks[0]!, status: 'completed', result: { output: 4 } },
            { ...snapshot.tasks[0]!, task: { id: 'unknown', reducer: 'sum' } },
          ],
          events: [{ type: 'task.completed', taskId: 'a', timestamp: 2 }],
        }),
      ).rejects.toThrow('fixed swarm');
      expect((await store.load(snapshot.run))?.tasks[0]?.status).toBe('pending');
      expect((await store.readEvents(snapshot.run, 0, 10)).map((event) => event.type)).toEqual([
        'run.started',
      ]);
      expect((await store.load(snapshot.run))?.run.revision).toBe(0);
    });
    it('checks revision, isolates scopes, returns copies, and roundtrips bytes', async () => {
      const store = make();
      const a = initial();
      const b = initial('b');
      await store.create(a, []);
      await store.create(b, []);
      await store.commit({
        ...a.run,
        expectedRevision: 0,
        tasks: [
          { ...a.tasks[0]!, status: 'completed', result: { output: new Uint8Array([0, 255]) } },
        ],
      });
      await expect(store.commit({ ...a.run, expectedRevision: 0 })).rejects.toThrow('conflict');
      expect((await store.load(b.run))?.tasks[0]?.status).toBe('pending');
      const copy = await store.load(a.run);
      expect(copy?.tasks[0]?.result?.output).toEqual(new Uint8Array([0, 255]));
      copy!.tasks[0]!.status = 'failed';
      expect((await store.load(a.run))?.tasks[0]?.status).toBe('completed');
    });
    it('reads the run record alone through head()', async () => {
      const store = make();
      const snapshot = initial();
      await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
      await store.commit({
        ...snapshot.run,
        expectedRevision: 0,
        tasks: [{ ...snapshot.tasks[0]!, status: 'running', attempt: 1 }],
        events: [{ type: 'task.started', taskId: 'a', timestamp: 2 }],
      });
      const head = await store.head!(snapshot.run);
      expect(head).toEqual((await store.load(snapshot.run))?.run);
      expect(head).toMatchObject({ revision: 1, lastSequence: 2 });
      head!.status = 'cancelled';
      expect((await store.head!(snapshot.run))?.status).toBe('running');
      expect(await store.head!({ scope: 'none', runId: 'none' })).toBeUndefined();
    });
  });
}
contracts('memory swarm store', createInMemorySwarmStore);
describe.skipIf(!DatabaseSync)('SQLite swarm store', () => {
  contracts('real SQLite transactional conformance', () => {
    const store = createSqliteSwarmStore({ path: ':memory:' });
    cleanup.push(() => store.close());
    return store;
  });
  it('reopens task/result/event journal and leaves the existing global schema version intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deuz-swarm-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'swarm.sqlite');
    const db = new DatabaseSync!(path);
    db.exec('PRAGMA user_version = 79');
    const first = createSqliteSwarmStore({ path, database: db });
    const snapshot = initial();
    await first.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
    await first.commit({
      ...snapshot.run,
      expectedRevision: 0,
      tasks: [{ ...snapshot.tasks[0]!, status: 'completed', result: { output: { answer: 42 } } }],
      events: [{ type: 'task.completed', taskId: 'a', timestamp: 2 }],
    });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 79 });
    await first.close();
    const second = createSqliteSwarmStore({ path });
    cleanup.push(() => second.close());
    expect((await second.load(snapshot.run))?.tasks[0]?.result?.output).toEqual({ answer: 42 });
    expect((await second.readEvents(snapshot.run, 1, 10)).map((event) => event.sequence)).toEqual([
      2,
    ]);
  });

  it('fails closed on corrupt authoritative state and unsupported independent schema versions', async () => {
    const db = new DatabaseSync!(':memory:');
    const store = createSqliteSwarmStore({ path: ':memory:', database: db });
    cleanup.push(() => store.close());
    const snapshot = initial();
    await store.create(snapshot, []);
    db.prepare('UPDATE deuz_swarm_tasks SET payload=?').run('{"status":"completed"}');
    await expect(store.load(snapshot.run)).rejects.toThrow('Corrupt');
    const futureDb = new DatabaseSync!(':memory:');
    futureDb.exec(
      'CREATE TABLE deuz_swarm_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO deuz_swarm_schema VALUES(1,2)',
    );
    const future = createSqliteSwarmStore({ path: ':memory:', database: futureDb });
    await expect(future.load(snapshot.run)).rejects.toThrow('Unsupported');
  });

  it('recovers a reopened SQLite DAG while reusing completed work and reconciling interrupted effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deuz-swarm-recovery-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'recover.sqlite');
    const first = createSqliteSwarmStore({ path });
    const snapshot = initial();
    snapshot.tasks[0] = {
      ...snapshot.tasks[0]!,
      status: 'completed',
      result: { output: 40 },
      attempt: 1,
    };
    snapshot.tasks.push({
      task: { id: 'b', reducer: 'sum', dependsOn: ['a'] },
      bindingVersion: '1',
      status: 'running',
      attempt: 1,
    });
    await first.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
    await first.close();
    const reopened = createSqliteSwarmStore({ path });
    cleanup.push(() => reopened.close());
    let calls = 0;
    const swarm = createSwarm({
      agents: {},
      store: reopened,
      reducers: {
        sum: {
          execute(results) {
            calls++;
            return Number(results.a?.output) + 2;
          },
        },
      },
    });
    const waiting = await (await swarm.resume(snapshot.run)).result;
    expect(waiting.tasks[1]?.status).toBe('needs_reconciliation');
    expect(calls).toBe(0);
    const result = await (await swarm.resume({ ...snapshot.run, retryTaskIds: ['b'] })).result;
    expect(result.run.status).toBe('completed');
    expect(result.tasks[0]?.attempt).toBe(1);
    expect(result.tasks[1]?.result?.output).toBe(42);
    expect(calls).toBe(1);
    const events = await reopened.readEvents(snapshot.run, 0, 100);
    expect(events.filter((event) => event.type === 'task.completed')).toHaveLength(1);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
  });
});
