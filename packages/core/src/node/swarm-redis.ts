/**
 * `@deuz-sdk/core/swarm/redis` (2.3): a durable swarm store on Redis.
 *
 * The Postgres store's shape, on Lua scripts: a commit reads what its
 * validation needs at the run's revision in one script, validates with the
 * shared rules, then writes everything in a second script that runs only while
 * the run is still at that revision and generation. If the run moved since the
 * read, nothing is written and the commit rejects with SwarmConflictError. The
 * generation is new on every `create`, so a run pruned and created again
 * under the same key never takes a write meant for the old one. Every key
 * carries the hash tag `{<prefix>:swarm}`, so a Redis Cluster keeps the store
 * in one slot. Needs Redis 7 or later. Node-only.
 *
 * KEY SCHEMA (tag `W` = `{<prefix>:swarm}`; a run is named by `R`, the hex of
 * its scope's UTF-16 code units, `-`, then the same of its runId):
 *
 * ```
 * W:run:R          HASH  rec (the run record), rev, gen, st (status), ix (index member)
 * W:tasks:R        HASH  taskId -> task record
 * W:order:R        LIST  task IDs in creation order
 * W:events:R       LIST  events in sequence order
 * W:notes:R        HASH  q:<channel>:<n> -> note, e:<entryId> -> <channel>:<n>,
 *                        n:<channel> -> last sequence
 * W:gen            STRING the generation counter
 * W:ix, W:ix:st:<status>, W:ix:sc:<hex scope>, W:ix:ss:<status>:<hex scope>
 *                  ZSET  score 0, member = sortable updatedAt + R, so ZRANGEBYLEX
 *                        pages runs by updatedAt, then scope, then runId
 * ```
 */
import type {
  SwarmChannelEntry,
  SwarmChannelPost,
  SwarmEvent,
  SwarmKey,
  SwarmRunRecord,
  SwarmRunStatus,
  SwarmStore,
  SwarmTaskRecord,
} from '../types/swarm';
import {
  decodeSwarm,
  encodeSwarm,
  makeSwarmEvents,
  nextSwarmRun,
  planPosts,
  postEvents,
  SETTLED_RUN_STATUSES,
  SwarmConflictError,
  validateChannelName,
  validateEventCursor,
  validatePruneOptions,
  validateRunQuery,
  validateSpawn,
  validateSwarmSnapshot,
  validateTaskChange,
} from '../swarm/store';
import type { RedisScriptClient } from './store-redis';
import {
  arg,
  hexUnits,
  redisConnection,
  redisStoreTag,
  replyList,
  replyNumber,
  replyText,
  script,
  sortableNumber,
  versionedClient,
} from './redis-scripts';

export { wrapIoredisClient } from './store-redis';
export type { IoredisClientLike, RedisScriptClient } from './store-redis';

export type RedisSwarmStoreOptions =
  | {
      /** A connected client that runs scripts; `close()` never quits it. */
      client: RedisScriptClient;
      /** Key namespace, inside the hash tag. Default `'deuz'`; no `{` or `}`. */
      prefix?: string;
    }
  | {
      /** Lazily imports the optional `redis` peer and connects on the first call. */
      url: string;
      prefix?: string;
    };

/** The Redis swarm store: every 2.2 capability, and retention. */
export type RedisSwarmStore = SwarmStore &
  Required<Pick<SwarmStore, 'head' | 'readChannel' | 'listRuns' | 'prune'>> & {
    /** Quit the connection `{ url }` opened; an injected client stays open. */
    close(): Promise<void>;
  };

// KEYS: run, tasks, order, events, notes, gen, ix, ix:st, ix:sc, ix:ss.
// ARGV: record, status, member, n, then n (taskId, task) pairs, then events.
// Answers 1, or 0 when the run exists.
const createScript = script(`
if num(redis.call('EXISTS', KEYS[1])) == 1 then return 0 end
-- Nothing of a pruned run may survive under its key.
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
local gen = num(redis.call('INCR', KEYS[6]))
redis.call('HSET', KEYS[1], 'rec', ARGV[1], 'rev', '0', 'gen', int(gen), 'st', ARGV[2], 'ix', ARGV[3])
local n = num(ARGV[4])
for i = 1, n do
  redis.call('HSET', KEYS[2], ARGV[3 + 2 * i], ARGV[4 + 2 * i])
  redis.call('RPUSH', KEYS[3], ARGV[3 + 2 * i])
end
for i = 5 + 2 * n, #ARGV do redis.call('RPUSH', KEYS[4], ARGV[i]) end
for i = 7, 10 do redis.call('ZADD', KEYS[i], '0', ARGV[3]) end
return 1
`);

// KEYS: run, tasks, order. Answers { record, task, task, ... } in creation
// order, or { } for an unknown run: one script, so run and tasks agree.
const loadScript = script(`
local rec = redis.call('HGET', KEYS[1], 'rec')
if not has(rec) then return arr({}) end
local out = {rec}
local ids = redis.call('LRANGE', KEYS[3], '0', '-1')
local total = #ids
for first = 1, total, 500 do
  local chunk = {}
  for i = first, math.min(first + 499, total) do chunk[#chunk + 1] = ids[i] end
  local tasks = redis.call('HMGET', KEYS[2], unpack(chunk))
  for i = 1, #chunk do out[#out + 1] = tasks[i] end
end
return arr(out)
`);

// KEYS: run. Answers the run record, or '' for an unknown run.
const headScript = script(`
local rec = redis.call('HGET', KEYS[1], 'rec')
if has(rec) then return rec end
return ''
`);

// KEYS: run, tasks, order, notes. ARGV: n, n taskIds, m, m entryIds, then
// channels. What a commit's validation needs, read at one revision:
// { record, revision, generation, task count, each task or '', each note or
// '', each channel's last sequence }, or { } for an unknown run.
const prepareScript = script(`
local meta = redis.call('HMGET', KEYS[1], 'rec', 'rev', 'gen')
if not has(meta[1]) then return arr({}) end
local out = {meta[1], meta[2], meta[3], int(num(redis.call('LLEN', KEYS[3])))}
local pos = 1
local n = num(ARGV[pos])
for i = 1, n do
  local task = redis.call('HGET', KEYS[2], ARGV[pos + i])
  out[#out + 1] = has(task) and task or ''
end
pos = pos + n + 1
local m = num(ARGV[pos])
for i = 1, m do
  local note = ''
  local where = redis.call('HGET', KEYS[4], 'e:' .. ARGV[pos + i])
  if has(where) then
    local found = redis.call('HGET', KEYS[4], 'q:' .. where)
    if has(found) then note = found end
  end
  out[#out + 1] = note
end
for i = pos + m + 1, #ARGV do
  local last = redis.call('HGET', KEYS[4], 'n:' .. ARGV[i])
  out[#out + 1] = has(last) and last or '0'
end
return arr(out)
`);

// KEYS: run, tasks, order, events, notes, ix, ix:st old, ix:st new, ix:sc,
// ix:ss old, ix:ss new. ARGV: expected revision, generation, record, status,
// member, revision, then n (taskId, task) changed, then n (taskId, task)
// spawned, then n (channel, sequence, entryId, note) posted, then events.
// Answers 1, or 0 when the run moved since the read.
const commitScript = script(`
local meta = redis.call('HMGET', KEYS[1], 'rev', 'gen', 'ix')
if not has(meta[1]) or num(meta[1]) ~= num(ARGV[1]) or meta[2] ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], 'rec', ARGV[3], 'rev', ARGV[6], 'st', ARGV[4], 'ix', ARGV[5])
local pos = 7
local n = num(ARGV[pos])
for i = 1, n do redis.call('HSET', KEYS[2], ARGV[pos + 2 * i - 1], ARGV[pos + 2 * i]) end
pos = pos + 2 * n + 1
n = num(ARGV[pos])
for i = 1, n do
  redis.call('HSET', KEYS[2], ARGV[pos + 2 * i - 1], ARGV[pos + 2 * i])
  redis.call('RPUSH', KEYS[3], ARGV[pos + 2 * i - 1])
end
pos = pos + 2 * n + 1
n = num(ARGV[pos])
for i = 1, n do
  local base = pos + 4 * (i - 1)
  local channel, sequence = ARGV[base + 1], ARGV[base + 2]
  local at = channel .. ':' .. sequence
  redis.call('HSET', KEYS[5], 'q:' .. at, ARGV[base + 4], 'e:' .. ARGV[base + 3], at, 'n:' .. channel, sequence)
end
for i = pos + 4 * n + 1, #ARGV do redis.call('RPUSH', KEYS[4], ARGV[i]) end
if meta[3] ~= ARGV[5] or KEYS[7] ~= KEYS[8] then
  for _, i in ipairs({6, 7, 9, 10}) do redis.call('ZREM', KEYS[i], meta[3]) end
  for _, i in ipairs({6, 8, 9, 11}) do redis.call('ZADD', KEYS[i], '0', ARGV[5]) end
end
return 1
`);

// KEYS: events. ARGV: after, limit.
const eventsScript = script(`
local found = redis.call('LRANGE', KEYS[1], ARGV[1], int(num(ARGV[1]) + num(ARGV[2]) - 1))
local out = {}
for i = 1, #found do out[#out + 1] = found[i] end
return arr(out)
`);

// KEYS: notes. ARGV: channel, after, limit. Sequences are gapless, so a page
// is the run of notes up to the first one missing.
const channelScript = script(`
local fields = {}
for n = num(ARGV[2]) + 1, num(ARGV[2]) + num(ARGV[3]) do
  fields[#fields + 1] = 'q:' .. ARGV[1] .. ':' .. int(n)
end
local found = redis.call('HMGET', KEYS[1], unpack(fields))
local out = {}
for i = 1, #fields do
  if not has(found[i]) then break end
  out[#out + 1] = found[i]
end
return arr(out)
`);

// KEYS: an index. ARGV: min, limit, the run-hash prefix.
const listScript = script(`
local members = redis.call('ZRANGEBYLEX', KEYS[1], ARGV[1], '+', 'LIMIT', '0', ARGV[2])
local out = {}
for i = 1, #members do
  local rec = redis.call('HGET', ARGV[3] .. string.sub(members[i], 17), 'rec')
  if has(rec) then out[#out + 1] = rec end
end
return arr(out)
`);

// KEYS: a scratch ZSET, then the three settled-status indexes to prune from.
// ARGV: max (exclusive, the sortable 'before'), limit, the tag prefix. Merges
// the oldest candidates of each index in the scratch set, so Redis orders
// them, and deletes the first 'limit' runs with all their keys and entries.
const pruneScript = script(`
redis.call('DEL', KEYS[1])
for i = 2, 4 do
  local found = redis.call('ZRANGEBYLEX', KEYS[i], '-', ARGV[1], 'LIMIT', '0', ARGV[2])
  for j = 1, #found do redis.call('ZADD', KEYS[1], '0', found[j]) end
end
local chosen = redis.call('ZRANGEBYLEX', KEYS[1], '-', '+', 'LIMIT', '0', ARGV[2])
local victims = {}
for j = 1, #chosen do victims[#victims + 1] = chosen[j] end
redis.call('DEL', KEYS[1])
local w = ARGV[3]
for j = 1, #victims do
  local member = victims[j]
  local id = string.sub(member, 17)
  local status = redis.call('HGET', w .. 'run:' .. id, 'st')
  local scope = string.match(id, '^([^-]*)-')
  redis.call('DEL', w .. 'run:' .. id, w .. 'tasks:' .. id, w .. 'order:' .. id, w .. 'events:' .. id, w .. 'notes:' .. id)
  redis.call('ZREM', w .. 'ix', member)
  redis.call('ZREM', w .. 'ix:st:' .. status, member)
  redis.call('ZREM', w .. 'ix:sc:' .. scope, member)
  redis.call('ZREM', w .. 'ix:ss:' .. status .. ':' .. scope, member)
end
return #victims
`);

/**
 * Build the Redis swarm store. SYNCHRONOUS and side-effect free: nothing is
 * sent, and on the `{ url }` path the optional peer is not imported, until the
 * first call.
 */
export function createRedisSwarmStore(options: RedisSwarmStoreOptions): RedisSwarmStore {
  const tag = redisStoreTag(options.prefix, 'swarm');
  const connection = redisConnection<RedisScriptClient>(options, {
    factory: 'createRedisSwarmStore',
    noun: 'swarm store',
  });
  const use = versionedClient(connection, tag, 'swarm');
  const name = (key: SwarmKey) => `${hexUnits(key.scope)}-${hexUnits(key.runId)}`;
  const runKey = (key: SwarmKey) => `${tag}:run:${name(key)}`;
  const tasksKey = (key: SwarmKey) => `${tag}:tasks:${name(key)}`;
  const orderKey = (key: SwarmKey) => `${tag}:order:${name(key)}`;
  const eventsKey = (key: SwarmKey) => `${tag}:events:${name(key)}`;
  const notesKey = (key: SwarmKey) => `${tag}:notes:${name(key)}`;
  const all = `${tag}:ix`;
  const byStatus = (status: SwarmRunStatus) => `${tag}:ix:st:${status}`;
  const byScope = (scope: string) => `${tag}:ix:sc:${hexUnits(scope)}`;
  const byBoth = (status: SwarmRunStatus, scope: string) =>
    `${tag}:ix:ss:${status}:${hexUnits(scope)}`;
  /** A run's place in the listing order: updatedAt, then scope, then runId. */
  const member = (run: Pick<SwarmRunRecord, 'updatedAt' | 'scope' | 'runId'>) =>
    `${sortableNumber(run.updatedAt)}${name(run)}`;

  const decodeRun = (payload: string, key?: SwarmKey): SwarmRunRecord => {
    const run = decodeSwarm<SwarmRunRecord>(payload);
    validateSwarmSnapshot({ run, tasks: [] }, key);
    return run;
  };
  const texts = (reply: unknown): string[] =>
    replyList(reply).map((value) => replyText(value) ?? '');

  return {
    capabilities: Object.freeze(['spawn', 'channels', 'list'] as const),
    async create(snapshot, inputs) {
      validateSwarmSnapshot(snapshot);
      if (snapshot.run.revision !== 0 || snapshot.run.lastSequence !== 0)
        throw new Error('New swarm counters must start at zero');
      const events = makeSwarmEvents(snapshot.run, 0, inputs);
      const run = { ...snapshot.run, lastSequence: events.length };
      const client = await use();
      const created = await createScript(
        client,
        [
          runKey(run),
          tasksKey(run),
          orderKey(run),
          eventsKey(run),
          notesKey(run),
          `${tag}:gen`,
          all,
          byStatus(run.status),
          byScope(run.scope),
          byBoth(run.status, run.scope),
        ],
        [
          encodeSwarm(run),
          run.status,
          member(run),
          arg(snapshot.tasks.length),
          ...snapshot.tasks.flatMap((task) => [task.task.id, encodeSwarm(task)]),
          ...events.map((event) => encodeSwarm(event)),
        ],
      );
      if (replyNumber(created) !== 1) throw new SwarmConflictError();
      return run;
    },
    async load(key) {
      const client = await use();
      const [run, ...tasks] = texts(
        await loadScript(client, [runKey(key), tasksKey(key), orderKey(key)], []),
      );
      if (!run) return undefined;
      const snapshot = {
        run: decodeRun(run, key),
        tasks: tasks.map((task) => decodeSwarm<SwarmTaskRecord>(task)),
      };
      validateSwarmSnapshot(snapshot, key);
      return snapshot;
    },
    async head(key) {
      const client = await use();
      const run = replyText(await headScript(client, [runKey(key)], []));
      return run ? decodeRun(run, key) : undefined;
    },
    async commit(change) {
      const changed = change.tasks ?? [];
      const spawn = change.spawn ?? [];
      const posts = change.posts ?? [];
      // Validation reads, all at one revision; the write re-checks it.
      const known = [
        ...new Set([
          ...changed.map((task) => task.task?.id),
          ...posts.map((post) => post?.taskId),
          ...spawn.flatMap((task) => [
            task.task?.id,
            ...(task.task?.dependsOn ?? []),
            ...(task.task?.after ?? []),
          ]),
        ]),
      ].filter((id): id is string => typeof id === 'string');
      const entryIds = [...new Set(posts.map((post) => post?.entryId))].filter(
        (id): id is string => typeof id === 'string',
      );
      const channels = [...new Set(posts.map((post) => post?.channel))].filter(
        (channel): channel is string => typeof channel === 'string',
      );
      const client = await use();
      const read = texts(
        await prepareScript(
          client,
          [runKey(change), tasksKey(change), orderKey(change), notesKey(change)],
          [arg(known.length), ...known, arg(entryIds.length), ...entryIds, ...channels],
        ),
      );
      if (!read.length) throw new Error('Swarm run not found');
      const previous = decodeRun(read[0]!, change);
      if (previous.revision !== change.expectedRevision) throw new SwarmConflictError();
      const generation = read[2]!;
      const count = Number(read[3]);
      const stored = new Map<string, string>();
      known.forEach((id, index) => {
        const task = read[4 + index];
        if (task) stored.set(id, task);
      });
      const entries = new Map<string, SwarmChannelPost>();
      entryIds.forEach((id, index) => {
        const note = read[4 + known.length + index];
        if (note) entries.set(id, decodeSwarm<SwarmChannelEntry>(note));
      });
      const lastSequence = new Map<string, number>();
      channels.forEach((channel, index) =>
        lastSequence.set(channel, Number(read[4 + known.length + entryIds.length + index])),
      );

      for (const task of changed) {
        const exists = stored.get(task.task.id);
        if (exists === undefined) throw new Error('Cannot add tasks to a fixed swarm DAG');
        validateTaskChange(decodeSwarm<SwarmTaskRecord>(exists), task, previous);
      }
      validateSpawn({
        run: previous,
        tasks: changed,
        spawn,
        count,
        exists: (taskId) => stored.has(taskId),
      });
      const posted = planPosts({
        posts,
        taskExists: (taskId) => stored.has(taskId),
        find: (entryId) => entries.get(entryId),
        last: (channel) => lastSequence.get(channel) ?? 0,
      });
      const inputs = [...(change.events ?? []), ...postEvents(posted)];
      const run = nextSwarmRun(previous, { ...change, events: inputs });
      const journal = makeSwarmEvents(change, previous.lastSequence, inputs);

      const written = await commitScript(
        client,
        [
          runKey(change),
          tasksKey(change),
          orderKey(change),
          eventsKey(change),
          notesKey(change),
          all,
          byStatus(previous.status),
          byStatus(run.status),
          byScope(run.scope),
          byBoth(previous.status, run.scope),
          byBoth(run.status, run.scope),
        ],
        [
          arg(previous.revision),
          generation,
          encodeSwarm(run),
          run.status,
          member(run),
          arg(run.revision),
          arg(changed.length),
          ...changed.flatMap((task) => [task.task.id, encodeSwarm(task)]),
          arg(spawn.length),
          ...spawn.flatMap((task) => [task.task.id, encodeSwarm(task)]),
          arg(posted.length),
          ...posted.flatMap((entry) => [
            entry.channel,
            arg(entry.sequence),
            entry.entryId,
            encodeSwarm(entry),
          ]),
          ...journal.map((event) => encodeSwarm(event)),
        ],
      );
      if (replyNumber(written) !== 1) throw new SwarmConflictError();
      return run;
    },
    async readChannel(key, channel, afterSequence, limit) {
      validateChannelName(channel);
      validateEventCursor(afterSequence, limit);
      const client = await use();
      return texts(
        await channelScript(client, [notesKey(key)], [channel, arg(afterSequence), arg(limit)]),
      ).map((note) => decodeSwarm<SwarmChannelEntry>(note));
    },
    async readEvents(key, afterSequence, limit) {
      validateEventCursor(afterSequence, limit);
      const client = await use();
      return texts(
        await eventsScript(client, [eventsKey(key)], [arg(afterSequence), arg(limit)]),
      ).map((event) => decodeSwarm<SwarmEvent>(event));
    },
    async listRuns(query) {
      validateRunQuery(query);
      const index =
        query.status !== undefined && query.scope !== undefined
          ? byBoth(query.status, query.scope)
          : query.status !== undefined
            ? byStatus(query.status)
            : query.scope !== undefined
              ? byScope(query.scope)
              : all;
      // Strictly after the cursor, in the listing order.
      const min = query.after ? `(${member(query.after)}` : '-';
      const client = await use();
      return texts(await listScript(client, [index], [min, arg(query.limit), `${tag}:run:`])).map(
        (run) => decodeRun(run),
      );
    },
    async prune(pruneOptions) {
      const { before, scope, limit } = validatePruneOptions(pruneOptions);
      const client = await use();
      const indexes = SETTLED_RUN_STATUSES.map((status) =>
        scope === undefined ? byStatus(status) : byBoth(status, scope),
      );
      return replyNumber(
        await pruneScript(
          client,
          [`${tag}:prune`, ...indexes],
          [`(${sortableNumber(before)}`, arg(limit), `${tag}:`],
        ),
      );
    },
    close: connection.close,
  };
}
