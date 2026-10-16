/**
 * ops-redis.test.ts — `@deuz-sdk/core/ops/redis` (2.3): leases, native agent
 * runs and schedule claims on Redis, one Lua script per operation.
 *
 * The shared contracts run on ioredis-mock, whose `TIME` follows a manual
 * clock (fixtures/redis-harness.ts), and on a real Redis when
 * DEUZ_TEST_REDIS_URL names one, where time is the server's and advancing it
 * means waiting.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createRedisBudgetStore,
  createRedisOpsStore,
  type RedisOpsStoreOptions,
} from '../src/node/ops-redis';
import { hexUnits } from '../src/node/redis-scripts';
import { createRedisSwarmStore } from '../src/node/swarm-redis';
import { initialSnapshot } from './fixtures/swarm-store-conformance';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import {
  agentRunPruneContracts,
  agentRunStoreContracts,
  envelope,
} from './fixtures/agent-run-store-conformance';
import {
  scheduleClaimContracts,
  scheduleClaimPruneContracts,
} from './fixtures/schedule-claim-conformance';
import {
  liveRedisServer,
  mockRedisServer,
  wait,
  type MockRedisServer,
} from './fixtures/redis-harness';
import { redisUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const liveRedisUrl = redisUrl();

const fresh = () => {
  const server = mockRedisServer();
  return { server, ops: createRedisOpsStore({ client: server.client }) };
};

leaseProviderContracts('Redis lease provider (ioredis-mock, server time)', async () => {
  const { server, ops } = fresh();
  return { provider: ops.leases, advance: server.advance, ttl: 1_000, now: server.now };
});
agentRunStoreContracts('Redis agent run store (ioredis-mock)', async () => fresh().ops.agentRuns);
agentRunPruneContracts('Redis agent run retention (ioredis-mock, server time)', async () => {
  const { server, ops } = fresh();
  return { store: ops.agentRuns, advance: server.advance, now: server.now };
});
scheduleClaimContracts('Redis claims (ioredis-mock)', async () => fresh().ops.claims);
scheduleClaimPruneContracts('Redis claim retention (ioredis-mock, server time)', async () => {
  const { server, ops } = fresh();
  return { claim: ops.claims, advance: server.advance, now: server.now };
});

describe('Redis ops store', () => {
  const keys = async (server: MockRedisServer) => (await server.redis.keys('*')).sort();

  it('keeps every key under one hash tag', async () => {
    const { server, ops } = fresh();
    const lease = (await ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 1_000 }))!;
    await ops.leases.signal('run', 'cancel');
    await ops.agentRuns.save(envelope('r1', 1, { phase: 'terminal' }));
    expect(await ops.claims('nightly@1')).toBe(true);
    expect(await keys(server)).toEqual([
      '{deuz:ops}:claims',
      '{deuz:ops}:lease:expiry',
      '{deuz:ops}:lease:owner',
      '{deuz:ops}:lease:signals',
      '{deuz:ops}:lease:token',
      '{deuz:ops}:run:entry',
      '{deuz:ops}:run:indexed',
      '{deuz:ops}:run:ix',
      '{deuz:ops}:run:ix:ph:terminal',
      `{deuz:ops}:run:ix:ps:terminal:${hexUnits('tenant')}`,
      `{deuz:ops}:run:ix:sc:${hexUnits('tenant')}`,
      '{deuz:ops}:run:payload',
      '{deuz:ops}:run:revision',
      '{deuz:ops}:run:terminal',
      '{deuz:ops}:schema',
    ]);
    await ops.leases.release(lease);
    const custom = createRedisOpsStore({ client: server.client, prefix: 'app' });
    expect(await custom.claims('nightly@1')).toBe(true);
    expect(await server.redis.exists('{app:ops}:claims')).toBe(1);
  });

  it('stamps its schema version on first use and refuses a newer one', async () => {
    const { server, ops } = fresh();
    expect(await ops.claims('a')).toBe(true);
    expect(await server.redis.get('{deuz:ops}:schema')).toBe('1');
    // A newer build moved the layout on: this one must not write through it.
    await server.redis.set('{deuz:ops}:schema', '2');
    const older = createRedisOpsStore({ client: server.client });
    await expect(older.claims('b')).rejects.toThrow(
      'Unsupported Redis ops schema version 2; this build reads version 1',
    );
    await expect(older.leases.acquire({ key: 'k', owner: 'a', ttlMs: 10 })).rejects.toThrow(
      /schema version 2/,
    );
    // The refusal is not cached as success: once the schema is right, it works.
    await server.redis.set('{deuz:ops}:schema', '1');
    expect(await older.claims('b')).toBe(true);
  });

  it('refuses a prefix that would break the hash tag', () => {
    const { server } = fresh();
    expect(() => createRedisOpsStore({ client: server.client, prefix: 'a}b' })).toThrow(TypeError);
    expect(() => createRedisOpsStore({ client: server.client, prefix: '' })).toThrow(TypeError);
  });

  it('runs leases on the server clock, not the host clock', async () => {
    // The server's clock is a year behind this host's.
    const server = mockRedisServer(Date.now() - 365 * 86_400_000);
    const ops = createRedisOpsStore({ client: server.client });
    const lease = await ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 5_000 });
    expect(lease?.expiresAt).toBe(server.now() + 5_000);
    // A host clock a year ahead does not make the lease look expired.
    expect(await ops.leases.acquire({ key: 'run', owner: 'b', ttlMs: 5_000 })).toBeUndefined();
    await server.advance(5_001);
    expect(await ops.leases.acquire({ key: 'run', owner: 'b', ttlMs: 5_000 })).toMatchObject({
      owner: 'b',
      token: 2,
    });
  });

  it('stamps claims and terminal runs with the server time', async () => {
    const { server, ops } = fresh();
    expect(await ops.claims('k')).toBe(true);
    expect(Number(await server.redis.zscore('{deuz:ops}:claims', 'k'))).toBe(server.now());
    await ops.agentRuns.save(envelope('done', 1, { phase: 'terminal' }));
    expect(Number(await server.redis.zscore('{deuz:ops}:run:terminal', 'done'))).toBe(server.now());
    // A run saved again before it settles leaves the terminal index.
    await ops.agentRuns.save(envelope('done', 2));
    expect(await server.redis.zscore('{deuz:ops}:run:terminal', 'done')).toBeNull();
  });

  it('shares leases, fenced runs and claims across stores on one server', async () => {
    const server = mockRedisServer();
    const a = createRedisOpsStore({ client: server.client });
    const b = createRedisOpsStore({ client: server.client });
    expect(await a.leases.acquire({ key: 'run', owner: 'a', ttlMs: 1_000 })).toMatchObject({
      token: 1,
    });
    expect(await b.leases.acquire({ key: 'run', owner: 'b', ttlMs: 1_000 })).toBeUndefined();
    await a.agentRuns.save(envelope('r', 1));
    await expect(b.agentRuns.save(envelope('r', 1))).rejects.toThrow(/expected 2, got 1/);
    await b.agentRuns.save(envelope('r', 2, { modelSteps: 5 }));
    expect(await a.agentRuns.load('r')).toMatchObject({ revision: 2, modelSteps: 5 });
    expect(await a.claims('k')).toBe(true);
    expect(await b.claims('k')).toBe(false);
  });

  it('sets no TTL on any key, so only an allkeys-* eviction policy can drop one', async () => {
    // operations.mdx tells operators to run noeviction or a volatile-* policy,
    // which evicts only keys that have a TTL: none of these may have one.
    const { server, ops } = fresh();
    await ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 60_000 });
    await ops.leases.signal('run', 'cancel');
    await ops.agentRuns.save(envelope('r1', 1, { phase: 'terminal' }));
    expect(await ops.claims('nightly@1')).toBe(true);
    const budget = createRedisBudgetStore({ client: server.client });
    const scope = { key: 'u', limits: { tokens: 100 }, window: { ms: 60_000 } };
    await budget.reserve({ requestId: 'b', modelId: 'm', tokens: 1, scopes: [scope] });
    await budget.prune({ before: server.now() });
    await createRedisSwarmStore({ client: server.client }).create(initialSnapshot(), []);
    const keys = await server.redis.keys('*');
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(await server.redis.pttl(key), key).toBe(-1);
  });

  it('rejects an invalid revision and a malformed retention cutoff', async () => {
    const { ops } = fresh();
    await expect(ops.agentRuns.save(envelope('r', 0))).rejects.toThrow(/revision/);
    await expect(ops.agentRuns.save(envelope('r', 1.5))).rejects.toThrow(/revision/);
    await expect(ops.agentRuns.save({ ...envelope('r', 1), runId: '' })).rejects.toThrow(TypeError);
    await expect(ops.leases.signal('run', 'stop' as 'cancel')).rejects.toThrow(TypeError);
    for (const before of [Number.NaN, Infinity, '1' as unknown as number]) {
      await expect(ops.leases.prune(before)).rejects.toThrow(TypeError);
      await expect(ops.agentRuns.prune(before)).rejects.toThrow(TypeError);
      await expect(ops.claims.prune(before)).rejects.toThrow(TypeError);
    }
  });
});

describe('Redis ops store contention', () => {
  it('grants a key to one of many concurrent acquires, and one renewal after it lapses', async () => {
    const { server, ops } = fresh();
    const acquired = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ops.leases.acquire({ key: 'run', owner: `w${index}`, ttlMs: 1_000 }),
      ),
    );
    const holders = acquired.filter((lease) => lease !== undefined);
    expect(holders).toHaveLength(1);
    await server.advance(2_000);
    // The lapsed holder races eleven new owners: exactly one of them wins.
    const raced = await Promise.all([
      ops.leases.renew(holders[0]!, 1_000),
      ...Array.from({ length: 11 }, (_, index) =>
        ops.leases.acquire({ key: 'run', owner: `n${index}`, ttlMs: 1_000 }),
      ),
    ]);
    const renewed = raced[0] as { held: boolean };
    const taken = raced.slice(1).filter((lease) => lease !== undefined);
    expect(Number(renewed.held) + taken.length).toBe(1);
  });

  it('saves exactly one of many writers racing for the same revision', async () => {
    const { ops } = fresh();
    await ops.agentRuns.save(envelope('r', 1));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        ops.agentRuns.save(envelope('r', 2, { modelSteps: index })),
      ),
    );
    const saved = results.flatMap((result, index) =>
      result.status === 'fulfilled' ? [index] : [],
    );
    expect(saved).toHaveLength(1);
    expect(await ops.agentRuns.load('r')).toMatchObject({ revision: 2, modelSteps: saved[0] });
  });
});

describe('Redis ops store { url }', () => {
  afterEach(() => {
    vi.doUnmock('redis');
    vi.resetModules();
  });

  async function withPeer(
    factory: () => Record<string, unknown>,
  ): Promise<(options: RedisOpsStoreOptions) => ReturnType<typeof createRedisOpsStore>> {
    vi.doMock('redis', factory);
    vi.resetModules();
    return (await import('../src/node/ops-redis')).createRedisOpsStore;
  }

  it('connects lazily, once, quits on close, and stays closed', async () => {
    const server = mockRedisServer();
    const stats = { created: 0, connect: 0, quit: 0 };
    const create = await withPeer(() => ({
      createClient: () => {
        stats.created++;
        return {
          eval: server.client.eval,
          connect: async () => void stats.connect++,
          quit: async () => void stats.quit++,
        };
      },
    }));
    const ops = create({ url: 'redis://localhost:6379' });
    expect(stats.created).toBe(0);
    expect(await ops.claims('a')).toBe(true);
    expect(await ops.claims('b')).toBe(true);
    expect(stats).toEqual({ created: 1, connect: 1, quit: 0 });
    await ops.close();
    expect(stats.quit).toBe(1);
    await expect(ops.claims('c')).rejects.toThrow(/closed.*createRedisOpsStore/s);
  });

  it('names the missing peer', async () => {
    const create = await withPeer(() => {
      throw new Error("Cannot find package 'redis'");
    });
    const ops = create({ url: 'redis://localhost:6379' });
    await expect(ops.claims('a')).rejects.toThrow(
      /createRedisOpsStore\(\{ url \}\) requires the optional peer `redis`.*npm i redis/s,
    );
  });

  it('never quits an injected client', async () => {
    const { ops } = fresh();
    await ops.close();
    expect(await ops.claims('still-works')).toBe(true);
  });
});

// A network round trip per script, and real waits for server time.
if (liveRedisUrl)
  vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!liveRedisUrl)('Redis ops store on a live server', () => {
  let server: Awaited<ReturnType<typeof liveRedisServer>>;
  beforeAll(async () => {
    server = await liveRedisServer(liveRedisUrl!);
  });
  afterAll(() => server?.close());
  const live = () => createRedisOpsStore({ client: server.client, prefix: server.prefix() });
  const now = () => Date.now() + server.skew;

  leaseProviderContracts('lease provider (live)', async () => ({
    provider: live().leases,
    advance: wait,
    ttl: 300,
    now,
  }));
  agentRunStoreContracts('agent run store (live)', async () => live().agentRuns);
  agentRunPruneContracts('agent run retention (live)', async () => ({
    store: live().agentRuns,
    advance: wait,
    now,
  }));
  scheduleClaimContracts('claims (live)', async () => live().claims);
  scheduleClaimPruneContracts('claim retention (live)', async () => ({
    claim: live().claims,
    advance: wait,
    now,
  }));

  it('prunes a backlog larger than one batch, past kept cancels', async () => {
    // Seeded straight into the documented layout: 2 500 released leases, the
    // first ten in the expiry range's order still owing a cancel, and as many
    // old claims and terminal runs. One script removes at most 1 000.
    const prefix = server.prefix();
    const ops = createRedisOpsStore({ client: server.client, prefix });
    const t = `{${prefix}:ops}`;
    const at = now() - 60_000;
    const seed = server.client.multi();
    for (let index = 0; index < 2_500; index++) {
      const key = `k${String(index).padStart(4, '0')}`;
      seed.hSet(`${t}:lease:owner`, key, 'a');
      seed.hSet(`${t}:lease:token`, key, '1');
      seed.zAdd(`${t}:lease:expiry`, { score: 0, value: key });
      if (index < 10) seed.hSet(`${t}:lease:signals`, key, 'cancel');
      seed.zAdd(`${t}:claims`, { score: at, value: `c${index}` });
      seed.hSet(`${t}:run:payload`, `r${index}`, JSON.stringify(envelope(`r${index}`, 1)));
      seed.hSet(`${t}:run:revision`, `r${index}`, '1');
      seed.zAdd(`${t}:run:terminal`, { score: at, value: `r${index}` });
    }
    await seed.exec();
    expect(await ops.leases.prune(now())).toBe(2_490);
    expect(await server.client.zCard(`${t}:lease:expiry`)).toBe(10);
    expect(await ops.claims.prune(now())).toBe(2_500);
    expect(await ops.agentRuns.prune(now())).toBe(2_500);
    expect(await server.client.exists([`${t}:claims`, `${t}:run:payload`])).toBe(0);
    const next = (await ops.leases.acquire({ key: 'k0003', owner: 'b', ttlMs: 5_000 }))!;
    expect(await ops.leases.renew(next, 5_000)).toMatchObject({ signals: ['cancel'] });
  });

  it('grants a key to one of many acquires racing on two connections', async () => {
    const second = await liveRedisServer(liveRedisUrl!);
    try {
      const prefix = server.prefix();
      const stores = [server.client, second.client].map((client) =>
        createRedisOpsStore({ client, prefix }),
      );
      const acquired = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          stores[index % 2]!.leases.acquire({ key: 'run', owner: `w${index}`, ttlMs: 5_000 }),
        ),
      );
      expect(acquired.filter((lease) => lease !== undefined)).toHaveLength(1);
      const claimed = await Promise.all(
        Array.from({ length: 20 }, (_, index) => stores[index % 2]!.claims('nightly@1')),
      );
      expect(claimed.filter(Boolean)).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});
