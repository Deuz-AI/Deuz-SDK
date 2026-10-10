/**
 * redis-client.test.ts — the client seam the 2.3 Redis stores add: an optional
 * `eval(script, { keys, arguments })` on `RedisClientLike` (the node-redis
 * signature) and `wrapIoredisClient`, which fits an ioredis client to the seam.
 *
 * ioredis-mock stands in for ioredis: it implements ioredis' lowercase API and
 * runs Lua through fengari, so the adapter is exercised end to end, store pack
 * included, with no server.
 */
import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createRedisStores, wrapIoredisClient } from '../src/node/store-redis';
import {
  assertChatStoreContract,
  assertMemoryStoreContract,
  assertSessionStoreContract,
} from './fixtures/store-conformance';

// ioredis-mock shares data between instances on one host and port, as one
// server would: every fresh mock gets a port of its own.
let port = 46_000;
const freshIoredis = () => new RedisMock({ port: port++ });

describe('wrapIoredisClient', () => {
  it('runs a script with its keys and arguments through ioredis eval', async () => {
    const client = wrapIoredisClient(freshIoredis());
    expect(
      await client.eval('return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}', {
        keys: ['k1', 'k2'],
        arguments: ['a1', 'a2'],
      }),
    ).toEqual(['k1', 'k2', 'a1', 'a2']);
    expect(await client.eval('return #KEYS + #ARGV', { keys: [], arguments: [] })).toBe(0);
  });

  it('maps every seam command to its lowercase ioredis spelling', async () => {
    const io = freshIoredis();
    const client = wrapIoredisClient(io);
    await client.set('s', 'v');
    expect(await client.get('s')).toBe('v');
    expect(await client.get('missing')).toBeNull();
    await client.set('t', 'w');
    expect(await client.mGet(['s', 'missing', 't'])).toEqual(['v', null, 'w']);
    await client.del(['s', 't']);
    expect(await io.exists('s', 't')).toBe(0);
    await client.set('u', 'x');
    await client.del('u');
    expect(await io.exists('u')).toBe(0);

    await client.sAdd('a', ['1', '2', '3']);
    await client.sAdd('a', '4');
    await client.sAdd('b', ['2', '3', '9']);
    await client.sRem('a', '1');
    await client.sRem('a', ['4']);
    expect((await client.sMembers('a')).sort()).toEqual(['2', '3']);
    expect((await client.sInter(['a', 'b'])).sort()).toEqual(['2', '3']);
    expect((await client.sInter('a')).sort()).toEqual(['2', '3']);

    await client.zAdd('z', [
      { score: 3, value: 'c' },
      { score: 1, value: 'a' },
    ]);
    await client.zAdd('z', { score: 2, value: 'b' });
    expect(await client.zRangeByScore('z', '-inf', '+inf')).toEqual(['a', 'b', 'c']);
    expect(await client.zRangeByScore('z', 1, 2)).toEqual(['a', 'b']);
    await client.zRem('z', 'a');
    await client.zRem('z', ['c']);
    expect(await client.zRangeByScore('z', '-inf', '+inf')).toEqual(['b']);
  });

  it('answers an empty batch without sending a command Redis would reject', async () => {
    const client = wrapIoredisClient(freshIoredis());
    expect(await client.mGet([])).toEqual([]);
    expect(await client.sInter([])).toEqual([]);
    await expect(client.del([])).resolves.toBe(0);
    await expect(client.sAdd('a', [])).resolves.toBe(0);
    await expect(client.sRem('a', [])).resolves.toBe(0);
    await expect(client.zAdd('z', [])).resolves.toBe(0);
    await expect(client.zRem('z', [])).resolves.toBe(0);
  });
});

// The store pack through the adapter answers the shared contracts like any client.
assertMemoryStoreContract('redis pack over ioredis (ioredis-mock)', async () => {
  const stores = createRedisStores({ client: wrapIoredisClient(freshIoredis()) });
  return { store: stores.memory, cleanup: () => stores.close() };
});

assertChatStoreContract('redis pack over ioredis (ioredis-mock)', async () => {
  const stores = createRedisStores({ client: wrapIoredisClient(freshIoredis()) });
  return { store: stores.chats, cleanup: () => stores.close() };
});

assertSessionStoreContract('redis pack over ioredis (ioredis-mock)', async () => {
  const stores = createRedisStores({ client: wrapIoredisClient(freshIoredis()) });
  return { store: stores.sessions, cleanup: () => stores.close() };
});
