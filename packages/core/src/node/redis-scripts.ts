/**
 * @internal Plumbing shared by the Redis store pack and the 2.3 Redis stores
 * (`@deuz-sdk/core/ops/redis`, `@deuz-sdk/core/swarm/redis`): the lazy
 * `{ url }` connection, the per-store hash tag, the Lua helpers every script
 * starts with, and the order-preserving encodings their indexes use.
 *
 * The 2.3 stores run every operation as ONE Lua script, so each is atomic on
 * the server. No WATCH/MULTI: on a shared node-redis connection a WATCH is not
 * isolated from the other commands in flight, and an optimistic transaction
 * needs a retry loop under contention. Scripts read the time from Redis
 * `TIME`, never from a host clock, and every key of one store carries the same
 * hash tag, so a Redis Cluster keeps the store in one slot and a script that
 * reaches a key through an index stays atomic and legal there.
 *
 * The scripts run on Redis's Lua 5.1 and on the Lua 5.3 of ioredis-mock
 * (fengari), which the offline tests use. So every number a script computes
 * with is a float (`num`, `floor`: fengari's integers are 32 bits and wrap,
 * while a double is exact to 2^53 in both), numbers cross into `redis.call`
 * as strings formatted by `int`/`real` (5.3 prints a float `5` as `5.0`), a
 * missing reply is tested with `has` (fengari hands a missing `HMGET` field
 * over as a JS null, not `false`), and a returned list goes through `arr`
 * (ioredis-mock only reads a table as a list when its keys were set last to
 * first). Replies are strings, integers and lists of them: never a Lua
 * boolean, which a RESP3 connection would return as a boolean.
 */
import type { RedisClientLike, RedisScriptClient } from './store-redis';

// ===================================================================
// The lazy `{ url }` connection
// ===================================================================

/** What the `{ url }` path opens for itself: the whole seam plus its lifecycle. */
export interface ManagedRedisClient extends Required<RedisClientLike> {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface RedisModule {
  createClient(options: { url: string }): ManagedRedisClient;
}

/** The node-redis majors whose published types the seam was checked against. */
const PEER_VERSIONS = 'node-redis v4, v5 or v6';

async function openClient(url: string, factory: string): Promise<ManagedRedisClient> {
  let mod: RedisModule;
  try {
    // `as string` keeps tsup's dts builder from statically resolving the
    // optional peer (matches node/browser.ts and rag-node.ts).
    mod = (await import('redis' as string)) as unknown as RedisModule;
  } catch (err) {
    throw new Error(
      `${factory}({ url }) requires the optional peer \`redis\` (${PEER_VERSIONS}). Install it with \`npm i redis\`, or pass a client you connected yourself: ${factory}({ client }).`,
      { cause: err },
    );
  }
  const client = mod.createClient({ url });
  await client.connect();
  return client;
}

export interface RedisConnection<C> {
  /** The client for the next command: the injected one, or the one opened lazily, ONCE. */
  use(): Promise<C>;
  /** Quit the connection `{ url }` opened; an injected client is the caller's and stays open. */
  close(): Promise<void>;
}

/**
 * The connection lifecycle every Redis store shares. `{ client }` is used as
 * it is and never closed. `{ url }` lazily imports the optional `redis` peer
 * on the first command and connects once; a failed connect is forgotten, so
 * the next call retries instead of replaying the rejection, and `close()` is
 * final: a later call rejects rather than open a second connection nobody
 * will ever quit.
 */
export function redisConnection<C>(
  options: { client: C } | { url: string },
  names: { factory: string; noun: string },
): RedisConnection<C> {
  let opened: Promise<ManagedRedisClient> | undefined;
  let closed = false;
  return {
    async use() {
      if ('client' in options) return options.client;
      if (closed) {
        throw new Error(
          `${names.factory}({ url }): this ${names.noun} is closed. close() quit the connection it ` +
            'opened, and a closed one does not reconnect — silently opening a second connection ' +
            'nobody will ever quit is how a long-lived process runs out of them. Build a new one ' +
            `with ${names.factory}({ url }), or inject a client whose lifecycle you own: ` +
            `${names.factory}({ client }).`,
        );
      }
      const pending = opened ?? openClient(options.url, names.factory);
      if (pending !== opened) {
        opened = pending;
        // A failed connect must not poison the store for its whole life: forget
        // the rejected promise so the next call retries instead of replaying it.
        // Guarded by identity, so a later successful connection is never dropped.
        pending.catch(() => {
          if (opened === pending) opened = undefined;
        });
      }
      // The managed client implements every command, `eval` included.
      return pending as unknown as Promise<C>;
    },
    async close() {
      // Marked before the await: `use()` reads this flag, so a call racing the
      // quit must not slip through and re-open behind it.
      closed = true;
      const pending = opened;
      opened = undefined;
      if (!pending) return; // injected client, or never connected — not ours
      const client = await pending.catch(() => undefined);
      await client?.quit();
    },
  };
}

// ===================================================================
// Keys
// ===================================================================

/**
 * The hash tag every key of one 2.3 store starts with: `{<prefix>:<store>}`.
 * Redis Cluster hashes only what lies between the first `{` and the next `}`,
 * so a prefix holding a brace would move the tag or empty it, which spreads a
 * store across slots; it is refused.
 */
export function redisStoreTag(prefix: string | undefined, store: string): string {
  const value = prefix ?? 'deuz';
  if (typeof value !== 'string' || !value || /[{}]/.test(value))
    throw new TypeError(
      `Invalid Redis key prefix ${JSON.stringify(value)}: use a nonempty string without { or }`,
    );
  return `{${value}:${store}}`;
}

/**
 * A string as fixed-width hex of its UTF-16 code units. Byte order of the hex
 * is the code-unit order of the strings (JavaScript's `<`), and a string that
 * is a prefix of another sorts first, as it does in JavaScript.
 */
export function hexUnits(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++)
    out += value.charCodeAt(index).toString(16).padStart(4, '0');
  return out;
}

/**
 * A finite number as 16 hex digits whose byte order is the numeric order, so
 * a ZSET of same-score members can range over it with ZRANGEBYLEX: the IEEE
 * 754 bits with the sign flipped for a positive number and every bit flipped
 * for a negative one. `-0` encodes as `0`.
 */
export function sortableNumber(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value);
  let high = view.getUint32(0);
  let low = view.getUint32(4);
  if (high >= 0x80000000) {
    high = ~high >>> 0;
    low = ~low >>> 0;
  } else high = (high | 0x80000000) >>> 0;
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

// ===================================================================
// Scripts and replies
// ===================================================================

/**
 * The helpers every script starts with (see the module note). `now_ms` reads
 * Redis `TIME` in whole milliseconds.
 */
export const LUA_HELPERS = `
local function num(v) return tonumber(v) + 0.0 end
local function floor(x) return math.floor(x) + 0.0 end
local function now_ms()
  local t = redis.call('TIME')
  return num(t[1]) * 1000 + floor(num(t[2]) / 1000)
end
local function int(n) return string.format('%.0f', n) end
local function real(n) return string.format('%.17g', n) end
local function has(v) return type(v) == 'string' end
local function arr(t)
  local out = {}
  for i = #t, 1, -1 do out[i] = t[i] end
  return out
end
`;

/** Run one script; `body` is prefixed with {@link LUA_HELPERS}. */
export function script(
  body: string,
): (client: RedisScriptClient, keys: string[], args: string[]) => Promise<unknown> {
  const source = LUA_HELPERS + body;
  return (client, keys, args) => client.eval(source, { keys, arguments: args });
}

/** The key layout version the 2.3 Redis stores write. */
export const REDIS_SCHEMA_VERSION = 1;

// KEYS: the schema marker. ARGV: this build's version. Answers the stored one.
const schemaScript = script(`
local stored = redis.call('GET', KEYS[1])
if has(stored) then return stored end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
`);

/**
 * A store's client, once its schema marker `<tag>:schema` reads the version
 * this build writes. The first use stamps it; a different stored version is
 * refused, as the SQL stores refuse a newer schema, so an older build never
 * writes through a newer layout. Checked once per store; a failed check is
 * retried by the next call.
 */
export function versionedClient(
  connection: RedisConnection<RedisScriptClient>,
  tag: string,
  store: string,
): () => Promise<RedisScriptClient> {
  let checked: Promise<void> | undefined;
  return async () => {
    const client = await connection.use();
    checked ??= (async () => {
      const stored = replyText(
        await schemaScript(client, [`${tag}:schema`], [String(REDIS_SCHEMA_VERSION)]),
      );
      if (Number(stored) !== REDIS_SCHEMA_VERSION)
        throw new Error(
          `Unsupported Redis ${store} schema version ${String(stored)}; this build reads version ${REDIS_SCHEMA_VERSION}`,
        );
    })().catch((error: unknown) => {
      checked = undefined;
      throw error;
    });
    await checked;
    return client;
  };
}

/** A list reply (an empty one when the script answered nothing). */
export function replyList(reply: unknown): unknown[] {
  return Array.isArray(reply) ? reply : [];
}

/** A string element of a reply; `undefined` for a missing one. */
export function replyText(reply: unknown): string | undefined {
  if (typeof reply === 'string') return reply;
  // A client configured to return buffers still decodes here.
  if (reply instanceof Uint8Array) return new TextDecoder().decode(reply);
  return undefined;
}

/** A numeric element of a reply (an integer, or a number a script formatted). */
export function replyNumber(reply: unknown): number {
  const value = typeof reply === 'number' ? reply : Number(replyText(reply));
  // `+ 0` turns a `-0` that Lua formatted back into `0`.
  return value + 0;
}

/** A number as a script argument: `String` keeps every finite double exact. */
export const arg = (value: number): string => String(value);

/**
 * The most entries one retention script removes. Retention runs in batches so
 * a large backlog never holds the server in one long script.
 */
export const PRUNE_BATCH = 1_000;

/** Run a batch script of `size` until a batch removes fewer; the total removed. */
export async function inBatches(
  size: number,
  batch: (size: number) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await batch(size);
    // A full batch runs again; anything else, a malformed reply included, ends it.
    if (!(removed >= size)) return removed >= 0 ? total + removed : total;
    total += removed;
  }
}
