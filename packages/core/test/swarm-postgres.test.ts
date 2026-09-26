import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresSwarmStore } from '../src/node/swarm-postgres';
import { createSwarm, SwarmConflictError } from '../src/swarm';
import type { PgClientLike } from '../src/node/store-postgres';
import type { SwarmStore } from '../src/types/swarm';
import { initialSnapshot, swarmStoreContracts } from './fixtures/swarm-store-conformance';

const db = new PGlite();
afterAll(async () => {
  await db.close();
});
const client: PgClientLike = {
  query: (sql, params) => db.query<Record<string, unknown>>(sql, params),
};

let schemas = 0;
/** Every store gets a fresh schema on the one in-process database. */
function freshStore(wrap: (base: PgClientLike) => PgClientLike = (base) => base): SwarmStore {
  const schema = `swarm_${++schemas}`;
  let created: Promise<unknown> | undefined;
  const scoped: PgClientLike = {
    async query(sql, params) {
      created ??= client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await created;
      return client.query(sql, params);
    },
  };
  return createPostgresSwarmStore({ client: wrap(scoped), schema });
}

swarmStoreContracts('Postgres swarm store (PGlite)', () => freshStore(), {
  spawn: true,
  channels: true,
  list: true,
});

describe('Postgres swarm store', () => {
  it('creates its schema idempotently across store instances', async () => {
    const schema = `swarm_${++schemas}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    const first = createPostgresSwarmStore({ client, schema });
    const snapshot = initialSnapshot();
    await first.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
    const second = createPostgresSwarmStore({ client, schema });
    expect((await second.load(snapshot.run))?.tasks).toHaveLength(1);
    await expect(second.create(snapshot, [])).rejects.toBeInstanceOf(SwarmConflictError);
  });

  it('rejects an invalid schema name before any query', () => {
    expect(() => createPostgresSwarmStore({ client, schema: 'Bad-Name' })).toThrow(/schema/);
  });

  it('fails a commit that raced another writer and writes nothing of it', async () => {
    const race: { racer?: SwarmStore } = {};
    let raced = false;
    const store = freshStore((base) => ({
      async query(sql, params) {
        // Another executor commits between this commit's reads and its write.
        if (!raced && race.racer && /WITH run AS \(\s*UPDATE/.test(sql)) {
          raced = true;
          await race.racer.commit({
            ...snapshot.run,
            expectedRevision: 0,
            tasks: [{ ...snapshot.tasks[0]!, status: 'running', attempt: 1 }],
            events: [{ type: 'task.started', taskId: 'a', timestamp: 2 }],
          });
        }
        return base.query(sql, params);
      },
    }));
    const snapshot = initialSnapshot();
    await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
    race.racer = { ...store };
    await expect(
      store.commit({
        ...snapshot.run,
        expectedRevision: 0,
        tasks: [{ ...snapshot.tasks[0]!, status: 'completed', result: { output: 9 } }],
        posts: [{ channel: 'main', entryId: 'e', taskId: 'a', attempt: 1, text: 'x', at: 2 }],
        events: [{ type: 'task.completed', taskId: 'a', timestamp: 3 }],
      }),
    ).rejects.toBeInstanceOf(SwarmConflictError);
    expect(raced).toBe(true);
    const after = await store.load(snapshot.run);
    expect(after?.run).toMatchObject({ revision: 1, lastSequence: 2 });
    expect(after?.tasks[0]).toMatchObject({ status: 'running', attempt: 1 });
    expect((await store.readEvents(snapshot.run, 0, 10)).map((event) => event.type)).toEqual([
      'run.started',
      'task.started',
    ]);
    expect(await store.readChannel!(snapshot.run, 'main', 0, 10)).toEqual([]);
  });

  it('drives a swarm to completion', async () => {
    const swarm = createSwarm({
      agents: {},
      store: freshStore(),
      reducers: {
        one: { execute: () => 1 },
        sum: {
          execute: (results) =>
            Object.values(results).reduce((total, value) => total + Number(value.output), 0),
        },
      },
    });
    const handle = await swarm.run({
      scope: 'tenant',
      runId: 'pg',
      tasks: [
        { id: 'a', reducer: 'one' },
        { id: 'b', reducer: 'one' },
        { id: 'total', reducer: 'sum', dependsOn: ['a', 'b'] },
      ],
    });
    const outcome = await handle.result;
    expect(outcome.run.status).toBe('completed');
    expect(outcome.tasks.find((task) => task.task.id === 'total')?.result?.output).toBe(2);
  });
});
