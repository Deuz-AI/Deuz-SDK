/**
 * The Redis durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/stores/redis`: the only 2.4 feature Redis backs. A batch
 * and its fencing check are one Lua script (Redis 7+). Node-only.
 */
import type { DurableStreamStateStore } from '../types/stream-durable';
import { notImplemented } from '../internal/not-implemented';
import type { RedisClientLike } from './store-redis';

/** Options of `createRedisDurableStreamStateStore`. */
export type RedisDurableStreamStateStoreOptions =
  | {
      /** A connected client with `eval`: borrowed, never quit by the store. */
      client: RedisClientLike;
      /** Key namespace. Default `'deuz'`. */
      prefix?: string;
    }
  | {
      /** The store opens (and quits) its own client from this URL. */
      url: string;
      prefix?: string;
    };

/** The Redis durable stream state store (2.4). */
export function createRedisDurableStreamStateStore(
  _options: RedisDurableStreamStateStoreOptions,
): DurableStreamStateStore & { close(): Promise<void> } {
  return notImplemented('createRedisDurableStreamStateStore');
}
