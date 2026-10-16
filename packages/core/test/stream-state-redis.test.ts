/**
 * The Redis durable stream state store (2.4, spec §3.4), the only 2.4 store
 * Redis backs. Offline: the shared contract on ioredis-mock (its Lua through
 * fengari, `TIME` on a manual clock). Live, when DEUZ_TEST_REDIS_URL names a
 * server: the same contract on node-redis, each store under its own prefix.
 * Also: one hash tag per stream, the prune index, and the race where a
 * stream comes back while prune removes it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedisDurableStreamStateStore } from '../src/node/stream-state-redis';
import type { RedisScriptClient } from '../src/node/store-redis';
import {
  durableStreamStoreContracts,
  readAll,
  records,
} from './fixtures/durable-stream-store-conformance';
import { liveRedisServer, mockRedisServer, wait } from './fixtures/redis-harness';
import { redisUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

describe('createRedisDurableStreamStateStore on ioredis-mock', () => {
  durableStreamStoreContracts('contract', async () => {
    const server = mockRedisServer();
    const store = createRedisDurableStreamStateStore({ client: server.client, prefix: 'p' });
    return { store, now: server.now, advance: server.advance };
  });

  it('keeps every key of a stream under that stream’s hash tag, and the index under its own', async () => {
    const server = mockRedisServer();
    const store = createRedisDurableStreamStateStore({ client: server.client, prefix: 'app' });
    await store.open('run:1', 1);
    await store.commit({ streamId: 'run:1', token: 1, records: records(0, [{ type: 'done' }]) });
    expect((await server.redis.keys('*')).sort()).toEqual([
      '{app:stream:run%3A1}:head',
      '{app:stream:run%3A1}:log',
      '{app:streams}:ix',
      '{app:streams}:schema',
    ]);
    expect(await server.redis.hgetall('{app:stream:run%3A1}:head')).toMatchObject({
      token: '1',
      last: '0',
      done: '1',
    });
    expect(await server.redis.zrange('{app:streams}:ix', 0, -1)).toEqual(['run:1']);
    await store.delete('run:1');
    expect((await server.redis.keys('{app:stream:*')).length).toBe(0);
    expect(await server.redis.zrange('{app:streams}:ix', 0, -1)).toEqual([]);
  });

  it('refuses a client without eval, and a prefix holding a brace', () => {
    expect(() =>
      createRedisDurableStreamStateStore({ client: {} as unknown as RedisScriptClient }),
    ).toThrow(/eval/);
    const server = mockRedisServer();
    expect(() =>
      createRedisDurableStreamStateStore({ client: server.client, prefix: 'a{b' }),
    ).toThrow(TypeError);
  });

  it('refuses a key layout a newer build wrote', async () => {
    const server = mockRedisServer();
    await server.redis.set('{p:streams}:schema', '2');
    const store = createRedisDurableStreamStateStore({ client: server.client, prefix: 'p' });
    await expect(store.lastSeq('s')).rejects.toThrow(/schema version 2/);
  });

  it('keeps the index entry of a stream that came back while prune removed it', async () => {
    const server = mockRedisServer();
    let raced = false;
    // Right after the per-stream prune script deleted the stream, and before
    // prune drops its index entry, a new leg opens and writes it again.
    const client: RedisScriptClient = {
      async eval(source, options) {
        const reply = await server.client.eval(source, options);
        if (!raced && source.includes('PRUNE_STREAM') && reply === 'pruned') {
          raced = true;
          await server.advance(5);
          await store.open('s', 2);
          await store.commit({ streamId: 's', token: 2, records: records(0, [{ type: 'done' }]) });
        }
        return reply;
      },
    };
    const store = createRedisDurableStreamStateStore({ client, prefix: 'p' });
    await store.commit({ streamId: 's', token: 1, records: records(0, [{ type: 'done' }]) });
    await server.advance(1_000);
    expect(await store.prune({ terminalBefore: server.now() })).toBe(1);
    expect(raced).toBe(true);
    // The new leg's stream is intact and still indexed, so a later prune finds it.
    expect(await readAll(store, 's')).toEqual(records(0, [{ type: 'done' }]));
    expect(await server.redis.zrange('{p:streams}:ix', 0, -1)).toEqual(['s']);
    await server.advance(1_000);
    expect(await store.prune({ terminalBefore: server.now() })).toBe(1);
    expect(await server.redis.zrange('{p:streams}:ix', 0, -1)).toEqual([]);
  });

  it('drops index entries whose stream is gone, without counting them', async () => {
    const server = mockRedisServer();
    const store = createRedisDurableStreamStateStore({ client: server.client, prefix: 'p' });
    await store.open('ghost', 1);
    await server.redis.del('{p:stream:ghost}:head');
    await server.advance(10);
    expect(await store.prune({ terminalBefore: server.now() })).toBe(0);
    expect(await server.redis.zrange('{p:streams}:ix', 0, -1)).toEqual([]);
  });
});

const url = redisUrl();
if (url) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!url)('createRedisDurableStreamStateStore on a live server', () => {
  let live: Awaited<ReturnType<typeof liveRedisServer>>;
  beforeAll(async () => {
    live = await liveRedisServer(url!);
  });
  afterAll(async () => {
    await live.close();
  });

  durableStreamStoreContracts('contract', async () => {
    const store = createRedisDurableStreamStateStore({
      client: live.client,
      prefix: live.prefix(),
    });
    return { store, now: () => Date.now() + live.skew, advance: wait };
  });

  it('opens and quits its own client from a URL', async () => {
    const store = createRedisDurableStreamStateStore({ url: url!, prefix: live.prefix() });
    await store.commit({ streamId: 's', token: 1, records: records(0, [{ type: 'done' }]) });
    expect(await store.lastSeq('s')).toBe(0);
    await store.delete('s');
    await store.close();
    await expect(store.lastSeq('s')).rejects.toThrow(/closed/);
  });
});
