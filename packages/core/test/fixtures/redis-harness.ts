/**
 * Redis servers for the 2.3 store tests.
 *
 * Offline: ioredis-mock, which runs the stores' Lua through fengari, behind
 * `wrapIoredisClient` (so the adapter is on the path too). Its `TIME` is not a
 * usable clock (it rounds the seconds and takes the microseconds from an
 * unrelated timer), and the stores read time only from `TIME`, so the mock
 * server gets a manual clock: every script runs behind a prelude whose
 * `redis.call('TIME')` answers the clock's time. ioredis-mock builds a fresh
 * Lua state per script, so the prelude never outlives one call.
 *
 * Live: DEUZ_TEST_REDIS_URL names a real server (the CI `integration` job
 * runs redis:7), looked up with `redisUrl()` from ./services; time is the
 * server's own, and advancing it means waiting.
 */
import RedisMock from 'ioredis-mock';
import { createClient } from 'redis';
import { wrapIoredisClient, type RedisScriptClient } from '../../src/node/store-redis';
import { estimateClockSkew } from './clock-skew';

// ioredis-mock shares data per host and port, as one server would: a fresh
// server per mock.
let port = 48_000;

export interface MockRedisServer {
  client: RedisScriptClient;
  /** The mock itself, to inspect keys. */
  redis: InstanceType<typeof RedisMock>;
  /** Move the server's clock forward. */
  advance(ms: number): Promise<void>;
  /** The server's time in epoch milliseconds. */
  now(): number;
}

/** A fresh ioredis-mock server whose `TIME` is a manual clock starting at `start`. */
export function mockRedisServer(start = 1_700_000_000_000): MockRedisServer {
  let now = start;
  const redis = new RedisMock({ port: port++ });
  const wrapped = wrapIoredisClient(redis);
  const prelude = () => {
    const seconds = Math.floor(now / 1000);
    const micros = (now - seconds * 1000) * 1000;
    return (
      `local __deuz_time = {'${seconds}', '${micros}'}\n` +
      'local __deuz_call = redis.call\n' +
      'redis.call = function(command, ...)\n' +
      "  if string.upper(command) == 'TIME' then return __deuz_time end\n" +
      '  return __deuz_call(command, ...)\n' +
      'end\n'
    );
  };
  return {
    client: { eval: (script, options) => wrapped.eval(prelude() + script, options) },
    redis,
    async advance(ms) {
      now += ms;
    },
    now: () => now,
  };
}

/** A node-redis connection to the live server, and its clock. */
export async function liveRedisServer(url: string): Promise<{
  client: ReturnType<typeof createClient>;
  /** Server time minus host time, measured at connect (best of several round trips). */
  skew: number;
  /** A key prefix of its own for every call, so suites on one server never meet. */
  prefix(): string;
  /** Drop every key the prefixes handed out named, then disconnect. */
  close(): Promise<void>;
}> {
  const client = createClient({ url });
  await client.connect();
  const { skew } = await estimateClockSkew(async () => {
    const [seconds, micros] = (await client.sendCommand(['TIME'])) as [string, string];
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  });
  const run = `deuz-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let count = 0;
  return {
    client,
    skew,
    prefix: () => `${run}-${++count}`,
    async close() {
      try {
        for (const pattern of [`{${run}-*`, `${run}-*`])
          for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 500 }))
            if (keys.length) await client.unlink(keys);
      } finally {
        await client.quit();
      }
    },
  };
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
