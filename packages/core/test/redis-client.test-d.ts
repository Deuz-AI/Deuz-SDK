/**
 * The Redis client seam (2.3) at the type level: a connected node-redis client
 * is a `RedisClientLike` and a `RedisScriptClient` as it is, with no wrapper
 * and no cast, and an ioredis client fits `wrapIoredisClient`.
 */
import { expectTypeOf, test } from 'vitest';
import type { RedisClientType } from 'redis';
import type Redis from 'ioredis';
import { wrapIoredisClient } from '../src/node/store-redis';
import type {
  IoredisClientLike,
  RedisClientLike,
  RedisScriptClient,
} from '../src/node/store-redis';

declare const nodeRedis: RedisClientType;
declare const ioredis: Redis;

test('a node-redis client needs no adapter', () => {
  const seam: RedisClientLike = nodeRedis;
  const scripts: RedisScriptClient = nodeRedis;
  expectTypeOf(seam.eval).toEqualTypeOf<RedisClientLike['eval']>();
  expectTypeOf(scripts.eval).parameters.toEqualTypeOf<
    [script: string, options: { keys: string[]; arguments: string[] }]
  >();
  expectTypeOf(scripts.eval).returns.toEqualTypeOf<Promise<unknown>>();
});

test('eval stays optional on the 2.0 seam', () => {
  expectTypeOf<RedisClientLike['eval']>().toEqualTypeOf<RedisScriptClient['eval'] | undefined>();
});

test('an ioredis client fits the adapter, which returns the whole seam', () => {
  const lowercase: IoredisClientLike = ioredis;
  expectTypeOf(wrapIoredisClient(lowercase)).toEqualTypeOf<Required<RedisClientLike>>();
  expectTypeOf(wrapIoredisClient(ioredis)).toExtend<RedisScriptClient>();
});
