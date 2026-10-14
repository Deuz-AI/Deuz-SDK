/**
 * swarm-redis.test.ts — `@deuz-sdk/core/swarm/redis` (2.3): the Redis swarm
 * store. Validation reads at the run's revision, then one script that commits
 * only while the run is still at that revision, as on Postgres.
 *
 * The shared contract runs on ioredis-mock and, with DEUZ_TEST_REDIS_URL, on
 * a real Redis; a swarm runs end to end on it too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedisSwarmStore } from '../src/node/swarm-redis';
import { createSwarm, SwarmConflictError } from '../src/swarm';
import type { SwarmSnapshot } from '../src/types/swarm';
import { initialSnapshot, swarmStoreContracts } from './fixtures/swarm-store-conformance';
import { liveRedisServer, mockRedisServer } from './fixtures/redis-harness';
import { redisUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const liveRedisUrl = redisUrl();

const freshStore = () => createRedisSwarmStore({ client: mockRedisServer().client });

swarmStoreContracts('Redis swarm store (ioredis-mock)', freshStore, {
  spawn: true,
  channels: true,
  list: true,
  prune: true,
});

const at = (scope: string, runId: string, updatedAt: number): SwarmSnapshot => {
  const snapshot = initialSnapshot(scope);
  return { ...snapshot, run: { ...snapshot.run, runId, createdAt: updatedAt, updatedAt } };
};

describe('Redis swarm store', () => {
  it('keeps every key under one hash tag and names runs by scope and runId', async () => {
    const server = mockRedisServer();
    const store = createRedisSwarmStore({ client: server.client, prefix: 'app' });
    await store.create(at('a:b', 'r/1', 5), [{ type: 'run.started', timestamp: 5 }]);
    const keys = await server.redis.keys('*');
    for (const key of keys) expect(key.startsWith('{app:swarm}:')).toBe(true);
    expect(keys).toContain('{app:swarm}:run:0061003a0062-0072002f0031');
    expect(() => createRedisSwarmStore({ client: server.client, prefix: 'a{' })).toThrow(TypeError);
  });

  it('stamps its schema version on first use and refuses a newer one', async () => {
    const server = mockRedisServer();
    expect(await createRedisSwarmStore({ client: server.client }).head(initialSnapshot().run)).toBe(
      undefined,
    );
    expect(await server.redis.get('{deuz:swarm}:schema')).toBe('1');
    await server.redis.set('{deuz:swarm}:schema', '2');
    await expect(
      createRedisSwarmStore({ client: server.client }).create(initialSnapshot(), []),
    ).rejects.toThrow('Unsupported Redis swarm schema version 2; this build reads version 1');
  });

  it('keeps runs apart whose scope and runId only split differently', async () => {
    const store = freshStore();
    await store.create(at('a', 'bc', 1), []);
    await store.create(at('ab', 'c', 2), []);
    await store.commit({
      scope: 'a',
      runId: 'bc',
      expectedRevision: 0,
      run: { status: 'partial' },
    });
    expect((await store.head({ scope: 'ab', runId: 'c' }))?.status).toBe('running');
    expect((await store.head({ scope: 'a', runId: 'bc' }))?.status).toBe('partial');
    expect((await store.listRuns!({ scope: 'a', limit: 10 })).map((run) => run.runId)).toEqual([
      'bc',
    ]);
  });

  it('rejects a duplicate create and a commit on a missing run', async () => {
    const store = freshStore();
    await store.create(initialSnapshot(), []);
    await expect(store.create(initialSnapshot(), [])).rejects.toBeInstanceOf(SwarmConflictError);
    await expect(
      store.commit({ scope: 'none', runId: 'none', expectedRevision: 0 }),
    ).rejects.toThrow('not found');
    await expect(
      store.create(
        { ...initialSnapshot('b'), run: { ...initialSnapshot('b').run, revision: 1 } },
        [],
      ),
    ).rejects.toThrow('zero');
  });

  it('orders listings by updatedAt across negative, fractional and equal times', async () => {
    const store = freshStore();
    await store.create(at('b', 'r', -2.5), []);
    await store.create(at('a', 'r', 1e15), []);
    await store.create(at('a', 'r2', 0.5), []);
    await store.create(at('a', 'r1', 0.5), []);
    await store.create(at('a', 'neg', -0), []);
    expect(
      (await store.listRuns!({ limit: 10 })).map((run) => `${run.scope}/${run.runId}`),
    ).toEqual(['b/r', 'a/neg', 'a/r1', 'a/r2', 'a/r']);
    expect(
      (await store.listRuns!({ limit: 10, after: { updatedAt: 0, scope: 'a', runId: 'neg' } })).map(
        (run) => run.runId,
      ),
    ).toEqual(['r1', 'r2', 'r']);
  });

  it('moves a run between the status indexes as it commits', async () => {
    const server = mockRedisServer();
    const store = createRedisSwarmStore({ client: server.client });
    await store.create(at('a', 'r', 1), []);
    await store.commit({
      scope: 'a',
      runId: 'r',
      expectedRevision: 0,
      run: { status: 'completed', updatedAt: 9 },
    });
    expect(await store.listRuns!({ status: 'running', limit: 10 })).toEqual([]);
    expect(
      (await store.listRuns!({ status: 'completed', scope: 'a', limit: 10 })).map(
        (run) => run.updatedAt,
      ),
    ).toEqual([9]);
    expect(await store.prune({ before: 10 })).toBe(1);
    // Every key of the run and every index entry went with it. (ioredis-mock
    // keeps an emptied sorted set as an empty key, where Redis drops it.)
    expect(
      (await server.redis.keys('*')).filter((key) => /:(run|tasks|order|events|notes):/.test(key)),
    ).toEqual([]);
    for (const key of await server.redis.keys('{deuz:swarm}:ix*'))
      expect(await server.redis.zcard(key)).toBe(0);
  });

  it('prunes a settled run whose record is gone, and drops its index entries', async () => {
    const server = mockRedisServer();
    const store = createRedisSwarmStore({ client: server.client });
    await store.create(at('a', 'r', 1), []);
    await store.commit({
      scope: 'a',
      runId: 'r',
      expectedRevision: 0,
      run: { status: 'completed', updatedAt: 9 },
    });
    // The record is lost (evicted, say) while the indexes still name the run.
    await server.redis.del('{deuz:swarm}:run:0061-0072');
    expect(await store.prune({ before: 10 })).toBe(1);
    for (const key of await server.redis.keys('{deuz:swarm}:ix*'))
      expect(await server.redis.zcard(key)).toBe(0);
    expect(await store.prune({ before: 10 })).toBe(0);
  });

  it('fences a commit by the run generation, so a run created again under its key is safe', async () => {
    const server = mockRedisServer();
    const other = createRedisSwarmStore({ client: server.client });
    // Between this writer's read and its write, the settled run is pruned,
    // created again under the same key and committed to revision 1: the same
    // revision the writer read, another run.
    const interlude = async () => {
      expect(await other.prune({ before: 10 })).toBe(1);
      await other.create(at('a', 'r', 20), []);
      await other.commit({ scope: 'a', runId: 'r', expectedRevision: 0 });
    };
    // A client that runs the interlude between a commit's read and its write.
    let armed = false;
    let calls = 0;
    const store = createRedisSwarmStore({
      client: {
        async eval(script, options) {
          if (armed && ++calls === 2) await interlude();
          return server.client.eval(script, options);
        },
      },
    });
    await other.create(at('a', 'r', 1), []);
    await other.commit({
      scope: 'a',
      runId: 'r',
      expectedRevision: 0,
      run: { status: 'completed' },
    });
    // Warm the writer's store (its first call checks the schema version), so
    // the next two calls are the commit's read and its write.
    await store.head({ scope: 'a', runId: 'r' });
    armed = true;
    await expect(
      store.commit({ scope: 'a', runId: 'r', expectedRevision: 1, run: { status: 'cancelled' } }),
    ).rejects.toBeInstanceOf(SwarmConflictError);
    expect(await other.head({ scope: 'a', runId: 'r' })).toMatchObject({
      revision: 1,
      status: 'running',
      updatedAt: 20,
    });
  });
});

describe('Redis swarm store contention', () => {
  it('commits exactly one of many writers racing for one revision', async () => {
    const server = mockRedisServer();
    const stores = [
      createRedisSwarmStore({ client: server.client }),
      createRedisSwarmStore({ client: server.client }),
    ];
    const snapshot = initialSnapshot();
    await stores[0]!.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        stores[index % 2]!.commit({
          ...snapshot.run,
          expectedRevision: 0,
          tasks: [{ ...snapshot.tasks[0]!, status: 'running', attempt: 1 }],
          events: [{ type: 'task.started', taskId: 'a', timestamp: 2, detail: `w${index}` }],
        }),
      ),
    );
    const won = results.flatMap((result, index) => (result.status === 'fulfilled' ? [index] : []));
    expect(won).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(SwarmConflictError);
    const events = await stores[1]!.readEvents(snapshot.run, 0, 10);
    expect(events.map((event) => event.detail)).toEqual([undefined, `w${won[0]}`]);
    expect(await stores[1]!.head(snapshot.run)).toMatchObject({ revision: 1, lastSequence: 2 });
  });
});

describe('a swarm on the Redis store', () => {
  it('runs a reducer DAG to completion and replays its journal', async () => {
    const swarm = createSwarm({
      agents: {},
      reducers: {
        one: { execute: () => 1 },
        sum: {
          execute: (results) => Object.values(results).reduce((n, r) => n + Number(r.output), 0),
        },
      },
      store: freshStore(),
    });
    const handle = await swarm.run({
      scope: 'tenant',
      tasks: [
        { id: 'a', reducer: 'one' },
        { id: 'b', reducer: 'one' },
        { id: 'total', reducer: 'sum', dependsOn: ['a', 'b'] },
      ],
    });
    const outcome = await handle.result;
    expect(outcome.run.status).toBe('completed');
    expect(outcome.tasks.find((task) => task.task.id === 'total')?.result?.output).toBe(2);
    const types: string[] = [];
    for await (const event of swarm.events(handle)) {
      types.push(event.type);
      if (event.type === 'run.settled') break;
    }
    expect(types[0]).toBe('run.started');
    expect(types.at(-1)).toBe('run.settled');
  });
});

// A network round trip per script, and real waits for server time.
if (liveRedisUrl)
  vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!liveRedisUrl)('Redis swarm store on a live server', () => {
  let server: Awaited<ReturnType<typeof liveRedisServer>>;
  beforeAll(async () => {
    server = await liveRedisServer(liveRedisUrl!);
  });
  afterAll(() => server?.close());

  swarmStoreContracts(
    'swarm store (live)',
    () => createRedisSwarmStore({ client: server.client, prefix: server.prefix() }),
    { spawn: true, channels: true, list: true, prune: true },
  );

  it('commits exactly one of many writers racing on two connections', async () => {
    const second = await liveRedisServer(liveRedisUrl!);
    try {
      const prefix = server.prefix();
      const stores = [server.client, second.client].map((client) =>
        createRedisSwarmStore({ client, prefix }),
      );
      const snapshot = initialSnapshot();
      await stores[0]!.create(snapshot, []);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) =>
          stores[index % 2]!.commit({
            ...snapshot.run,
            expectedRevision: 0,
            events: [{ type: 'task.started', taskId: 'a', timestamp: 2, detail: `w${index}` }],
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await stores[1]!.readEvents(snapshot.run, 0, 10)).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});
