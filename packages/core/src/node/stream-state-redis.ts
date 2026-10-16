/**
 * The Redis durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/stores/redis`: the only 2.4 feature Redis backs. A batch
 * and its fencing check are one Lua script (Redis 7+). Node-only.
 *
 * Every read and write of a stream is ONE script on that stream's keys, so it
 * is atomic on the server, and time is the server's `TIME`. Each stream has a
 * hash tag of its own, so a Redis Cluster spreads streams across slots while
 * every script stays inside one. Retention needs to find streams, so they are
 * also listed in an index under the store's tag, which a script on a stream
 * cannot touch atomically; the index is therefore a list of candidates:
 *
 * - `open` adds the stream to the index (`ZADD NX`, server time) before it
 *   writes, and any write that creates the stream's head adds it again with
 *   the head's time. So every stream with data is indexed, and an entry's
 *   score is never later than the stream's last open, commit or append.
 * - `prune` reads candidates older than the cutoff from the index, lets a
 *   script on each stream decide (terminal and untouched since the cutoff:
 *   delete it), and drops the entry of a deleted or missing stream only if
 *   its score is still the one it read, so a stream that came back in the
 *   meantime stays indexed.
 *
 * KEY SCHEMA (prefix `P`, default `deuz`; a stream id is `encodeURIComponent`d):
 *
 * ```
 * {P:stream:<id>}:head   HASH  token (the fence), last (last seq, -1 when empty),
 *                              done ('1' when the last record is the sentinel),
 *                              at (server ms of the last open, commit or append)
 * {P:stream:<id>}:log    ZSET  score = seq, member = '<seq> <part JSON>'
 * {P:streams}:ix         ZSET  stream id -> server ms it was indexed
 * {P:streams}:schema     STRING the key layout version (1), stamped on first use
 * ```
 *
 * The scripts follow the conventions of `redis-scripts.ts`, so they also run
 * on ioredis-mock (fengari) offline.
 */
import type { DurableStreamStateStore } from '../types/stream-durable';
import {
  assertFencingToken,
  assertPart,
  assertSeq,
  assertStreamId,
  assertTerminalBefore,
  checkBatch,
  decodePart,
  encodePart,
  isDonePart,
  PRUNE_PAGE,
  READ_PAGE,
} from '../internal/durable-stream';
import type { RedisClientLike, RedisScriptClient } from './store-redis';
import {
  arg,
  redisConnection,
  redisStoreTag,
  replyList,
  replyNumber,
  replyText,
  script,
  versionedClient,
} from './redis-scripts';

/** Options of `createRedisDurableStreamStateStore`. */
export type RedisDurableStreamStateStoreOptions =
  | {
      /** A connected client with `eval`: borrowed, never quit by the store. */
      client: RedisClientLike | RedisScriptClient;
      /** Key namespace. Default `'deuz'`. */
      prefix?: string;
    }
  | {
      /** The store opens (and quits) its own client from this URL. */
      url: string;
      prefix?: string;
    };

const FACTORY = 'createRedisDurableStreamStateStore';

// KEYS: the index. ARGV: stream id. Indexes a stream not yet listed, at the server time.
const registerScript = script(`
redis.call('ZADD', KEYS[1], 'NX', int(now_ms()), ARGV[1])
return 'ok'
`);

// KEYS: the index. ARGV: stream id, the head's time. (Re)indexes a stream whose head was created.
const reindexScript = script(`
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 'ok'
`);

// KEYS: the index. ARGV: stream id, the score prune read. Drops the entry only if unchanged.
const unindexScript = script(`
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if has(score) and num(score) == num(ARGV[2]) then redis.call('ZREM', KEYS[1], ARGV[1]) end
return 'ok'
`);

// KEYS: the index. ARGV: stream id. Drops the entry, whatever its score.
const dropIndexScript = script(`
redis.call('ZREM', KEYS[1], ARGV[1])
return 'ok'
`);

// KEYS: the index. ARGV: cutoff (exclusive), offset, count. Answers id, score, id, score, ...
const candidatesScript = script(`
local found = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1], 'WITHSCORES', 'LIMIT', ARGV[2], ARGV[3])
local out = {}
for i = 1, #found do out[#out + 1] = found[i] end
return arr(out)
`);

// KEYS: head. ARGV: token. Answers {'opened', last, created, at} or {'fenced', token}.
const openScript = script(`
local stored = redis.call('HGET', KEYS[1], 'token')
if has(stored) and num(stored) > num(ARGV[1]) then return arr({'fenced', stored}) end
local last = redis.call('HGET', KEYS[1], 'last')
local created = '0'
if not has(last) then
  created = '1'
  last = '-1'
  redis.call('HSET', KEYS[1], 'last', '-1', 'done', '0')
end
local at = int(now_ms())
redis.call('HSET', KEYS[1], 'token', ARGV[1], 'at', at)
return arr({'opened', last, created, at})
`);

// KEYS: head, log. ARGV: token, first seq, count, done ('1'/'0'), then the parts.
// Answers {'committed', last, created, at}, {'fenced', token} or {'conflict', last}.
const commitScript = script(`
local stored = redis.call('HGET', KEYS[1], 'token')
if has(stored) and num(stored) > num(ARGV[1]) then return arr({'fenced', stored}) end
local current = redis.call('HGET', KEYS[1], 'last')
local last = -1.0
local created = '0'
if has(current) then last = num(current) else created = '1' end
local count = num(ARGV[3])
if count > 0 and num(ARGV[2]) ~= last + 1 then return arr({'conflict', int(last)}) end
for i = 1, count do
  local seq = int(last + i)
  redis.call('ZADD', KEYS[2], seq, seq .. ' ' .. ARGV[4 + i])
end
local at = int(now_ms())
redis.call('HSET', KEYS[1], 'token', ARGV[1], 'last', int(last + count), 'at', at)
if count > 0 then
  redis.call('HSET', KEYS[1], 'done', ARGV[4])
elseif created == '1' then
  redis.call('HSET', KEYS[1], 'done', '0')
end
return arr({'committed', int(last + count), created, at})
`);

// KEYS: head, log. ARGV: seq, done ('1'/'0'), part. Answers {created, at}.
const appendScript = script(`
local seq = num(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], ARGV[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1] .. ' ' .. ARGV[3])
local current = redis.call('HGET', KEYS[1], 'last')
local last = -1.0
local created = '0'
if has(current) then
  last = num(current)
else
  created = '1'
  redis.call('HSET', KEYS[1], 'token', '0', 'done', '0')
end
local at = int(now_ms())
if seq >= last then redis.call('HSET', KEYS[1], 'last', int(seq), 'done', ARGV[2]) end
redis.call('HSET', KEYS[1], 'at', at)
return arr({created, at})
`);

// KEYS: log. ARGV: after seq (exclusive), count. Answers the members in seq order.
const readScript = script(`
local found = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], '+inf', 'LIMIT', '0', ARGV[2])
local out = {}
for i = 1, #found do out[#out + 1] = found[i] end
return arr(out)
`);

// KEYS: head. Answers the last seq, or nothing.
const lastSeqScript = script(`
local last = redis.call('HGET', KEYS[1], 'last')
if has(last) then return last end
return ''
`);

// KEYS: head, log. Deletes the stream.
const deleteScript = script(`
redis.call('DEL', KEYS[1], KEYS[2])
return 'ok'
`);

// KEYS: head, log. ARGV: cutoff (exclusive). PRUNE_STREAM: deletes a terminal
// stream untouched since the cutoff. Answers 'pruned', 'kept' or 'gone'.
const pruneStreamScript = script(`
-- PRUNE_STREAM
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[2])
  return 'gone'
end
local done = redis.call('HGET', KEYS[1], 'done')
local at = redis.call('HGET', KEYS[1], 'at')
if done == '1' and has(at) and num(at) < num(ARGV[1]) then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 'pruned'
end
return 'kept'
`);

/** The Redis durable stream state store (2.4). */
export function createRedisDurableStreamStateStore(
  options: RedisDurableStreamStateStoreOptions,
): DurableStreamStateStore & { close(): Promise<void> } {
  if ('client' in options && typeof (options.client as { eval?: unknown })?.eval !== 'function')
    throw new TypeError(
      `${FACTORY} needs a client that runs Lua scripts (eval): node-redis as it is, ioredis through wrapIoredisClient.`,
    );
  const prefix = options.prefix ?? 'deuz';
  const indexTag = redisStoreTag(prefix, 'streams');
  const index = `${indexTag}:ix`;
  const connection = redisConnection<RedisScriptClient>(
    'client' in options ? { client: options.client as RedisScriptClient } : { url: options.url },
    { factory: FACTORY, noun: 'durable stream state store' },
  );
  const ready = versionedClient(connection, indexTag, 'durable stream state');
  const keys = (streamId: string): [string, string] => {
    const tag = `{${prefix}:stream:${encodeURIComponent(streamId)}}`;
    return [`${tag}:head`, `${tag}:log`];
  };
  /** Indexes again a stream whose head this write created, at the head's time. */
  const reindex = async (client: RedisScriptClient, streamId: string, reply: unknown[]) => {
    const [created, at] = reply;
    if (replyText(created) === '1') await reindexScript(client, [index], [streamId, String(at)]);
  };

  return {
    durable: true,

    async open(streamId, token) {
      assertStreamId(streamId);
      assertFencingToken(token);
      const client = await ready();
      await registerScript(client, [index], [streamId]);
      const reply = replyList(await openScript(client, keys(streamId).slice(0, 1), [arg(token)]));
      if (replyText(reply[0]) === 'fenced')
        return { status: 'fenced', token: replyNumber(reply[1]) };
      await reindex(client, streamId, reply.slice(2));
      return { status: 'opened', lastSeq: replyNumber(reply[1]) };
    },

    async commit(batch) {
      const checked = checkBatch(batch);
      const client = await ready();
      const reply = replyList(
        await commitScript(client, keys(checked.streamId), [
          arg(checked.token),
          checked.first === undefined ? '' : arg(checked.first),
          arg(checked.encoded.length),
          checked.done ? '1' : '0',
          ...checked.encoded,
        ]),
      );
      const status = replyText(reply[0]);
      if (status === 'fenced') return { status: 'fenced', token: replyNumber(reply[1]) };
      if (status === 'conflict') return { status: 'conflict', lastSeq: replyNumber(reply[1]) };
      await reindex(client, checked.streamId, reply.slice(2));
      return { status: 'committed', lastSeq: replyNumber(reply[1]) };
    },

    async append(streamId, seq, part) {
      assertStreamId(streamId);
      assertSeq(seq);
      assertPart(part);
      const client = await ready();
      const reply = replyList(
        await appendScript(client, keys(streamId), [
          arg(seq),
          isDonePart(part) ? '1' : '0',
          encodePart(part),
        ]),
      );
      await reindex(client, streamId, reply);
    },

    async *read(streamId, fromSeq = -1) {
      const [, log] = keys(streamId);
      let cursor = fromSeq;
      for (;;) {
        const client = await ready();
        const members = replyList(await readScript(client, [log], [arg(cursor), arg(READ_PAGE)]));
        for (const member of members) {
          const text = replyText(member) ?? '';
          const space = text.indexOf(' ');
          cursor = Number(text.slice(0, space));
          yield { seq: cursor, part: decodePart(text.slice(space + 1)) };
        }
        if (members.length < READ_PAGE) return;
      }
    },

    async lastSeq(streamId) {
      const client = await ready();
      const last = replyText(await lastSeqScript(client, keys(streamId).slice(0, 1), []));
      if (!last) return undefined;
      const value = Number(last);
      return value >= 0 ? value : undefined;
    },

    async delete(streamId) {
      const client = await ready();
      await deleteScript(client, keys(streamId), []);
      await dropIndexScript(client, [index], [streamId]);
    },

    async prune(pruneOptions) {
      const terminalBefore = assertTerminalBefore(pruneOptions);
      const cutoff = arg(Math.floor(terminalBefore));
      const client = await ready();
      let removed = 0;
      let offset = 0;
      for (;;) {
        const page = replyList(
          await candidatesScript(client, [index], [cutoff, arg(offset), arg(PRUNE_PAGE)]),
        );
        for (let at = 0; at + 1 < page.length; at += 2) {
          const streamId = replyText(page[at]) ?? '';
          const score = replyText(page[at + 1]) ?? String(page[at + 1]);
          const outcome = replyText(await pruneStreamScript(client, keys(streamId), [cutoff]));
          if (outcome === 'kept') {
            offset++;
            continue;
          }
          if (outcome === 'pruned') removed++;
          await unindexScript(client, [index], [streamId, score]);
        }
        if (page.length < PRUNE_PAGE * 2) return removed;
      }
    },

    close: () => connection.close(),
  };
}
