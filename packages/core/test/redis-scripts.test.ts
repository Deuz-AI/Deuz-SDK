/**
 * redis-scripts.test.ts — the plumbing the 2.3 Redis stores share: the hash
 * tag, the order-preserving index encodings, and the Lua helpers, run on
 * ioredis-mock (Lua 5.3, fengari) and on a live Redis (Lua 5.1) when
 * DEUZ_TEST_REDIS_URL names one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hexUnits,
  inBatches,
  redisStoreTag,
  replyList,
  replyNumber,
  replyText,
  script,
  sortableNumber,
} from '../src/node/redis-scripts';
import type { RedisScriptClient } from '../src/node/store-redis';
import { liveRedisServer, liveRedisUrl, mockRedisServer } from './fixtures/redis-harness';

const byCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

describe('redisStoreTag', () => {
  it('puts the prefix and the store in one hash tag', () => {
    expect(redisStoreTag(undefined, 'ops')).toBe('{deuz:ops}');
    expect(redisStoreTag('app:prod', 'swarm')).toBe('{app:prod:swarm}');
  });

  it('refuses a prefix that would move or empty the tag', () => {
    for (const prefix of ['', '{app', 'app}', '}x', 7 as unknown as string])
      expect(() => redisStoreTag(prefix, 'ops'), String(prefix)).toThrow(TypeError);
  });
});

describe('inBatches', () => {
  it('runs a full batch again and stops at a short one, totalling both', async () => {
    const replies = [4, 4, 2, 4];
    const sizes: number[] = [];
    const total = await inBatches(4, async (size) => {
      sizes.push(size);
      return replies.shift()!;
    });
    expect(total).toBe(10);
    expect(sizes).toEqual([4, 4, 4]);
  });

  it('stops at a malformed count instead of looping forever', async () => {
    let calls = 0;
    expect(
      await inBatches(4, async () => {
        calls++;
        return calls === 1 ? 4 : Number.NaN;
      }),
    ).toBe(4);
    expect(calls).toBe(2);
  });
});

describe('sortableNumber', () => {
  it('orders like the numbers, sixteen hex digits each', () => {
    const values = [
      -Number.MAX_VALUE,
      -1e21,
      -3.5,
      -1,
      -Number.MIN_VALUE,
      0,
      Number.MIN_VALUE,
      1e-7,
      0.1,
      1,
      1.5,
      2,
      1_700_000_000_000,
      1_700_000_000_001,
      Number.MAX_SAFE_INTEGER,
      1e21,
      Number.MAX_VALUE,
    ];
    const encoded = values.map(sortableNumber);
    for (const value of encoded) expect(value).toMatch(/^[0-9a-f]{16}$/);
    expect([...encoded].sort(byCodeUnits)).toEqual(encoded);
    expect(new Set(encoded).size).toBe(values.length);
  });

  it('encodes -0 as 0, which compares equal to it', () => {
    expect(sortableNumber(-0)).toBe(sortableNumber(0));
  });
});

describe('hexUnits', () => {
  it('orders like the strings, a prefix first', () => {
    const values = ['', 'a', 'a\u0000', 'aa', 'ab', 'b', 'Z', 'é', '\ud800', '😀', '￿'];
    const sorted = [...values].sort(byCodeUnits);
    expect(sorted.map(hexUnits)).toEqual(sorted.map(hexUnits).sort(byCodeUnits));
    expect(hexUnits('a-b')).toBe('0061002d0062');
  });

  it('keeps a separator below every digit, so tuples order field by field', () => {
    const tuples: [string, string][] = [
      ['a', 'z'],
      ['ab', ''],
      ['a', ''],
      ['b', 'a'],
      ['a', 'za'],
    ];
    const key = ([scope, runId]: [string, string]) => `${hexUnits(scope)}-${hexUnits(runId)}`;
    const expected = [...tuples].sort(
      (left, right) => byCodeUnits(left[0], right[0]) || byCodeUnits(left[1], right[1]),
    );
    expect([...tuples].sort((left, right) => byCodeUnits(key(left), key(right)))).toEqual(expected);
  });
});

/** The Lua helpers, through the same `script()` the stores use. */
function helperContracts(name: string, make: () => Promise<RedisScriptClient>) {
  describe(`Lua helpers: ${name}`, () => {
    it('formats integers and reals without a float suffix or an exponent', async () => {
      const client = await make();
      const run = script(`
        return arr({int(num(ARGV[1])), int(num(ARGV[1]) + 1), real(num(ARGV[2])),
          real(num(ARGV[3]) - num(ARGV[4]))})`);
      const reply = replyList(
        await run(client, ['{t}:x'], ['9007199254740990', '0.1', '0.01', '0.1']),
      );
      expect(reply.map(replyText)).toEqual([
        '9007199254740990',
        '9007199254740991',
        expect.any(String),
        expect.any(String),
      ]);
      expect(replyNumber(reply[2])).toBe(0.1);
      expect(replyNumber(reply[3])).toBe(0.01 - 0.1);
    });

    it('returns a list built front to back, in order, at any length', async () => {
      const client = await make();
      const run = script(`
        local t = {}
        for i = 1, num(ARGV[1]) do t[#t + 1] = 'v' .. int(i) end
        return arr(t)`);
      const reply = replyList(await run(client, ['{t}:x'], ['1200']));
      expect(reply).toHaveLength(1200);
      expect(reply[0]).toBe('v1');
      expect(reply[1199]).toBe('v1200');
      expect(replyList(await run(client, ['{t}:x'], ['0']))).toEqual([]);
    });

    it('tells a missing HMGET field from a present one', async () => {
      const client = await make();
      const run = script(`
        redis.call('HSET', KEYS[1], 'a', '1')
        local got = redis.call('HMGET', KEYS[1], 'a', 'missing', 'a')
        local out = {}
        for i = 1, 3 do out[#out + 1] = has(got[i]) and got[i] or '-' end
        redis.call('DEL', KEYS[1])
        return arr(out)`);
      expect(replyList(await run(client, [`{t}:${Math.random()}`], []))).toEqual(['1', '-', '1']);
    });

    it('takes the key base from a declared key, a client prefix included', async () => {
      const client = await make();
      const run = script(`return key_base(KEYS[1], 'open')`);
      expect(await run(client, ['app:{t}:open'], [])).toBe('app:{t}:');
    });

    it('reads the time in whole milliseconds', async () => {
      const client = await make();
      const now = replyNumber(await script('return int(now_ms())')(client, ['{t}:x'], []));
      expect(Number.isSafeInteger(now)).toBe(true);
      expect(now).toBeGreaterThan(1_600_000_000_000);
    });
  });
}

helperContracts('ioredis-mock', async () => mockRedisServer().client);

it('serves the mock clock to now_ms', async () => {
  const server = mockRedisServer(1_700_000_000_123);
  const read = script('return int(now_ms())');
  expect(replyNumber(await read(server.client, ['{t}:x'], []))).toBe(1_700_000_000_123);
  await server.advance(1_877);
  expect(replyNumber(await read(server.client, ['{t}:x'], []))).toBe(1_700_000_002_000);
});

describe.skipIf(!liveRedisUrl)('live Redis', () => {
  let server: Awaited<ReturnType<typeof liveRedisServer>>;
  beforeAll(async () => {
    server = await liveRedisServer(liveRedisUrl!);
  }, 30_000);
  afterAll(() => server?.close());
  helperContracts('live', async () => server.client);
});
