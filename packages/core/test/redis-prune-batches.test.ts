/**
 * redis-prune-batches.test.ts — retention on the 2.3 Redis stores runs in
 * batches, so a backlog never holds the server in one long script. The batch
 * size is shrunk to four here, so the paging is exercised on a handful of
 * entries (ioredis-mock spends milliseconds per command inside a script).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/node/redis-scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/node/redis-scripts')>()),
  PRUNE_BATCH: 4,
}));

const { createRedisOpsStore, createRedisBudgetStore } = await import('../src/node/ops-redis');
const { envelope } = await import('./fixtures/agent-run-store-conformance');
const { mockRedisServer } = await import('./fixtures/redis-harness');

describe('Redis ops store retention in batches of four', () => {
  it('pages past released leases that still owe a cancel', async () => {
    const server = mockRedisServer();
    const ops = createRedisOpsStore({ client: server.client });
    const owing = new Set(['k00', 'k01', 'k05']);
    for (let index = 0; index < 11; index++) {
      const key = `k${String(index).padStart(2, '0')}`;
      const lease = (await ops.leases.acquire({ key, owner: 'a', ttlMs: 1_000 }))!;
      if (owing.has(key)) await ops.leases.signal(key, 'cancel');
      await ops.leases.release(lease);
    }
    // Released keys all sit at 0 in the expiry range, in key order: the kept
    // ones open the first batch and sit inside the second.
    expect(await ops.leases.prune(server.now())).toBe(8);
    expect((await server.redis.zrange('{deuz:ops}:lease:expiry', 0, -1)).sort()).toEqual([
      ...owing,
    ]);
    expect(await ops.leases.prune(server.now())).toBe(0);
  });

  it('prunes claims and terminal runs to the last short batch', async () => {
    const server = mockRedisServer();
    const ops = createRedisOpsStore({ client: server.client });
    for (let index = 0; index < 9; index++) {
      expect(await ops.claims(`c${index}`)).toBe(true);
      await ops.agentRuns.save(envelope(`r${index}`, 1, { phase: 'terminal' }));
    }
    await server.advance(1);
    expect(await ops.claims.prune(server.now())).toBe(9);
    expect(await ops.agentRuns.prune(server.now())).toBe(9);
    expect(await server.redis.zcard('{deuz:ops}:claims')).toBe(0);
    expect(await server.redis.hlen('{deuz:ops}:run:payload')).toBe(0);
  });
});

describe('Redis budget store retention in batches of four', () => {
  it('deletes request records a batch at a time and folds every page of scopes', async () => {
    const server = mockRedisServer();
    const store = createRedisBudgetStore({ client: server.client });
    // Nine scopes, each with two settled buckets of one model to fold.
    const scopes = Array.from({ length: 9 }, (_, index) => ({
      key: `user:${index}`,
      limits: { tokens: 1_000 },
      window: { ms: 400, buckets: 4 },
    }));
    for (const round of [0, 1]) {
      for (const scope of scopes) {
        const requestId = `${scope.key}#${round}`;
        await store.reserve({ requestId, modelId: 'm', tokens: 10, scopes: [scope] });
        await store.settle(requestId, { tokens: 10, usd: 0.5 });
      }
      await server.advance(100);
    }
    await server.advance(600);
    const before = await Promise.all(scopes.map((scope) => store.usage(scope.key)));
    expect(await store.prune({ before: server.now() })).toEqual({ requests: 18, buckets: 9 });
    expect(await Promise.all(scopes.map((scope) => store.usage(scope.key)))).toEqual(before);
    expect(await store.prune({ before: server.now() })).toEqual({ requests: 0, buckets: 0 });
  });

  it('folds a large history of one scope at most a batch of rows per script', async () => {
    const server = mockRedisServer();
    const history = '{deuz:budget}:hist:org';
    // The most history rows any one script removed (calls are sequential).
    let largest = 0;
    const store = createRedisBudgetStore({
      client: {
        async eval(source, options) {
          const before = await server.redis.hlen(history);
          const reply = await server.client.eval(source, options);
          largest = Math.max(largest, before - (await server.redis.hlen(history)));
          return reply;
        },
      },
    });
    // A per-minute window: 60 buckets of one second, so a row per second per model.
    const scope = { key: 'org', limits: { tokens: 1_000_000 }, window: { ms: 60_000 } };
    for (let index = 0; index < 12; index++) {
      await store.reserve({ requestId: `r${index}`, modelId: 'm', tokens: 10, scopes: [scope] });
      await store.settle(`r${index}`, { tokens: 10, usd: 0 });
      await server.advance(1_000);
    }
    await server.advance(120_000);
    expect(await server.redis.hlen(history)).toBe(12);
    const usage = await store.usage('org');
    // Folding the twelve rows into the newest removes eleven in all ...
    expect(await store.prune({ before: server.now() })).toEqual({ requests: 12, buckets: 11 });
    expect(await server.redis.hlen(history)).toBe(1);
    expect(await store.usage('org')).toEqual(usage);
    // ... and no single script removed more than the batch of four.
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(4);
    expect(await server.redis.exists('{deuz:budget}:fold:org')).toBe(0);
  });

  /**
   * A per-minute scope whose history the scan meets out of time order: the
   * current bucket's row first, then old rows of two models, one of them in a
   * bucket an open hold still charges. Rows are seeded straight into the hash,
   * which is the only way to choose the order a scan meets them in.
   */
  const scrambled = async () => {
    const server = mockRedisServer();
    const store = createRedisBudgetStore({ client: server.client });
    const scope = { key: 'org', limits: { tokens: 1_000_000 }, window: { ms: 60_000 } };
    await store.reserve({ requestId: 'now', modelId: 'a', tokens: 7, scopes: [scope] });
    await store.settle('now', { tokens: 7, usd: 0 });
    const current = Math.floor(server.now() / 1_000);
    const old = (back: number, model: string) => `${current - 1_000 + back}:${model}`;
    for (const [field, row] of [
      [old(5, 'a'), '50 0.5'],
      [old(1, 'b'), '10 0.25'],
      [old(0, 'a'), '1 0.125'],
      [old(3, 'b'), '30 0'],
      [old(2, 'a'), '20 0'],
      [old(1, 'a'), '5 0'],
    ])
      await server.redis.hset('{deuz:budget}:hist:org', field!, row!);
    await server.redis.hset('{deuz:budget}:held', `${current - 1_000 + 2}:org`, '1');
    // Each model's foldable rows end in its newest one; the held and the current rows stay.
    const folded = {
      [old(5, 'a')]: '56 0.625',
      [old(3, 'b')]: '40 0.25',
      [old(2, 'a')]: '20 0',
      [`${current}:a`]: '7 0',
    };
    return { server, store, old, current, folded };
  };

  it('folds each model into its newest foldable row, whatever order the scan meets them in', async () => {
    const { server, store, folded } = await scrambled();
    const usage = await store.usage('org', { byModel: true });
    expect(await store.prune({ before: server.now() })).toEqual({ requests: 0, buckets: 3 });
    expect(await server.redis.hgetall('{deuz:budget}:hist:org')).toEqual(folded);
    expect(await store.usage('org', { byModel: true })).toEqual(usage);
    expect(await store.prune({ before: server.now() })).toEqual({ requests: 0, buckets: 0 });
  });

  it('never folds into a target a stopped prune left that this one may not fold', async () => {
    const { server, store, old, current, folded } = await scrambled();
    await server.redis.hset('{deuz:budget}:hist:org', old(8, 'a'), '100 0');
    // A prune with a later 'before' stopped midway and left its fold hash: a
    // target this prune's 'before' does not reach, and one deleted since.
    await server.redis.hset('{deuz:budget}:fold:org', 'a', old(8, 'a'), 'b', old(4, 'b'));
    const before = (current - 1_000 + 6) * 1_000;
    expect(await store.prune({ before })).toEqual({ requests: 0, buckets: 3 });
    expect(await server.redis.hgetall('{deuz:budget}:hist:org')).toEqual({
      ...folded,
      [old(8, 'a')]: '100 0',
    });
    expect(await server.redis.exists('{deuz:budget}:fold:org')).toBe(0);
  });
});
