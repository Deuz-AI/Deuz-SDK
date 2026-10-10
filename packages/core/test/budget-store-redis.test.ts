/**
 * budget-store-redis.test.ts — the Redis `BudgetStore` (2.3, from
 * `@deuz-sdk/core/ops/redis`): admission, settlement, holds, sweep and
 * retention as Lua scripts on Redis time.
 *
 * The shared contract runs on ioredis-mock with a manual server clock, which
 * also lets lifetime history move by the hour, and on a real Redis with real
 * waits when DEUZ_TEST_REDIS_URL names one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedisBudgetStore } from '../src/node/ops-redis';
import { BudgetStoreError } from '../src/budget-store';
import type { PersistentBudgetScope } from '../src/types/budget-store';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';
import { liveRedisServer, liveRedisUrl, mockRedisServer, wait } from './fixtures/redis-harness';

budgetStoreContracts(
  'Redis budget store (ioredis-mock, server time)',
  async () => {
    const server = mockRedisServer();
    return {
      store: createRedisBudgetStore({ client: server.client }),
      advance: server.advance,
      now: server.now,
    };
  },
  { hours: true },
);

const user = (tokens: number, extra: Partial<PersistentBudgetScope> = {}) => ({
  key: 'user:1',
  limits: { tokens },
  ...extra,
});

describe('Redis budget store', () => {
  it('keeps every key under one hash tag', async () => {
    const server = mockRedisServer();
    const store = createRedisBudgetStore({ client: server.client, prefix: 'app' });
    await store.reserve({ requestId: 'r', modelId: 'm', tokens: 5, scopes: [user(100)] });
    for (const key of await server.redis.keys('*'))
      expect(key.startsWith('{app:budget}:')).toBe(true);
    expect(() => createRedisBudgetStore({ client: server.client, prefix: '{x' })).toThrow(
      TypeError,
    );
  });

  it('admits on the server clock: a window ends by Redis time, not host time', async () => {
    const server = mockRedisServer(Date.now() - 365 * 86_400_000);
    const store = createRedisBudgetStore({ client: server.client });
    const scope = user(100, { window: { ms: 60_000, buckets: 60 } });
    await store.reserve({ requestId: 'a', modelId: 'm', tokens: 100, scopes: [scope] });
    expect(
      await store.reserve({ requestId: 'b', modelId: 'm', tokens: 1, scopes: [scope] }),
    ).toMatchObject({ admitted: false, committed: 100 });
    await server.advance(61_000);
    expect(
      await store.reserve({ requestId: 'c', modelId: 'm', tokens: 100, scopes: [scope] }),
    ).toMatchObject({ admitted: true });
    const [hold] = await store.holds({ before: server.now() + 1 });
    expect(hold?.reservedAt).toBe(server.now() - 61_000);
  });

  it('shares one budget between two stores on the same server', async () => {
    const server = mockRedisServer();
    const first = createRedisBudgetStore({ client: server.client });
    const second = createRedisBudgetStore({ client: server.client });
    expect(
      await first.reserve({ requestId: 'a', modelId: 'm', tokens: 70, scopes: [user(100)] }),
    ).toMatchObject({ admitted: true });
    expect(
      await second.reserve({ requestId: 'b', modelId: 'm', tokens: 40, scopes: [user(100)] }),
    ).toMatchObject({ admitted: false, committed: 70 });
    await second.settle('a', { tokens: 10, usd: 0 });
    expect(await first.usage('user:1')).toEqual({ tokens: 10, usd: 0 });
  });

  it('reports conflicts with the store error codes', async () => {
    const server = mockRedisServer();
    const store = createRedisBudgetStore({ client: server.client });
    await store.reserve({ requestId: 'r', modelId: 'm', tokens: 5, scopes: [user(100)] });
    await expect(
      store.reserve({ requestId: 'r', modelId: 'm', tokens: 6, scopes: [user(100)] }),
    ).rejects.toMatchObject({ code: 'reservation_conflict' });
    await expect(
      store.reserve({
        requestId: 'w',
        modelId: 'm',
        tokens: 1,
        scopes: [user(100, { window: { ms: 1_000 } })],
      }),
    ).rejects.toBeInstanceOf(BudgetStoreError);
    await store.settle('r', { tokens: 5, usd: 0 });
    await expect(store.settle('r', { tokens: 4, usd: 0 })).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
  });

  it('keeps a long request ID, a model ID with colons, and a scope key with braces apart', async () => {
    const server = mockRedisServer();
    const store = createRedisBudgetStore({ client: server.client });
    const requestId = `req-${'x'.repeat(3_000)}`;
    const scope = { key: 'org:{acme}:team a', limits: { tokens: 1_000 } };
    await store.reserve({ requestId, modelId: 'openai:gpt:5', tokens: 9, scopes: [scope] });
    await store.reserve({ requestId: 'r2', modelId: 'openai', tokens: 1, scopes: [scope] });
    expect(await store.usage(scope.key, { byModel: true })).toEqual({
      tokens: 10,
      usd: 0,
      byModel: { 'openai:gpt:5': { tokens: 9, usd: 0 }, openai: { tokens: 1, usd: 0 } },
    });
    expect((await store.holds({ before: server.now() + 1 })).map((hold) => hold.keys)).toEqual([
      [scope.key],
      [scope.key],
    ]);
    await store.settle(requestId, { tokens: 3, usd: 0.25 });
    expect(await store.usage(scope.key)).toEqual({ tokens: 4, usd: 0.25 });
  });

  it('pages holds across fractional, negative and far cursors', async () => {
    const server = mockRedisServer();
    const store = createRedisBudgetStore({ client: server.client });
    for (const requestId of ['b', 'a']) {
      await store.reserve({ requestId, modelId: 'm', tokens: 1, scopes: [user(100)] });
    }
    await server.advance(5);
    await store.reserve({ requestId: 'c', modelId: 'm', tokens: 1, scopes: [user(100)] });
    const at = server.now();
    const ids = async (query: Parameters<typeof store.holds>[0]) =>
      (await store.holds(query)).map((hold) => hold.requestId);
    expect(await ids({ before: at + 1 })).toEqual(['a', 'b', 'c']);
    expect(await ids({ before: at })).toEqual(['a', 'b']);
    expect(await ids({ before: at - 4.5 })).toEqual(['a', 'b']);
    expect(await ids({ before: at - 5 })).toEqual([]);
    expect(await ids({ before: -1 })).toEqual([]);
    expect(await ids({ before: 1e300 })).toEqual(['a', 'b', 'c']);
    expect(await ids({ before: 1e300, after: { reservedAt: at - 5, requestId: 'a' } })).toEqual([
      'b',
      'c',
    ]);
    expect(await ids({ before: 1e300, after: { reservedAt: at - 5.5, requestId: 'z' } })).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(await ids({ before: 1e300, after: { reservedAt: at - 4.5, requestId: '' } })).toEqual([
      'c',
    ]);
    expect(await ids({ before: 1e300, after: { reservedAt: -7, requestId: 'z' } })).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(await ids({ before: 1e300, after: { reservedAt: 1e300, requestId: '' } })).toEqual([]);
  });
});

describe('Redis budget store contention', () => {
  it('never overspends: reservations, settlements and releases racing across two stores', async () => {
    const server = mockRedisServer();
    const stores = [
      createRedisBudgetStore({ client: server.client }),
      createRedisBudgetStore({ client: server.client }),
    ];
    const scope = { key: 'org:race', limits: { tokens: 500, usd: 5 } };
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        stores[index % 2]!.reserve({
          requestId: `r${index}`,
          modelId: 'm',
          tokens: 60,
          usd: 0.5,
          scopes: [scope],
        }),
      ),
    );
    const admitted = outcomes.flatMap((outcome, index) => (outcome.admitted ? [index] : []));
    expect(admitted).toHaveLength(8); // 8 × 60 = 480 tokens ≤ 500, a ninth would be 540
    expect(await stores[0]!.usage(scope.key)).toEqual({ tokens: 480, usd: 4 });
    // Half settle low and half release, concurrently; nothing is counted twice.
    await Promise.all(
      admitted.map((index, position) =>
        position % 2
          ? stores[position % 2]!.release(`r${index}`)
          : stores[position % 2]!.settle(`r${index}`, { tokens: 10, usd: 0.1 }),
      ),
    );
    expect(await stores[1]!.usage(scope.key)).toEqual({ tokens: 40, usd: 0.4 });
  });
});

describe.skipIf(!liveRedisUrl)('Redis budget store on a live server', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
  let server: Awaited<ReturnType<typeof liveRedisServer>>;
  beforeAll(async () => {
    server = await liveRedisServer(liveRedisUrl!);
  });
  afterAll(() => server?.close());

  budgetStoreContracts('budget store (live)', async () => ({
    store: createRedisBudgetStore({ client: server.client, prefix: server.prefix() }),
    advance: wait,
    now: () => Date.now() + server.skew,
  }));

  it('never overspends with reservations racing on two connections', async () => {
    const second = await liveRedisServer(liveRedisUrl!);
    try {
      const prefix = server.prefix();
      const stores = [server.client, second.client].map((client) =>
        createRedisBudgetStore({ client, prefix }),
      );
      const scope = { key: 'org:race', limits: { tokens: 500 } };
      const outcomes = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          stores[index % 2]!.reserve({
            requestId: `r${index}`,
            modelId: 'm',
            tokens: 60,
            scopes: [scope],
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(8);
      expect(await stores[0]!.usage(scope.key)).toEqual({ tokens: 480, usd: 0 });
    } finally {
      await second.close();
    }
  });
});
