/**
 * `@deuz-sdk/core/ops/redis` (2.3): durable leases, native agent run stores
 * and schedule claims on Redis, with the Redis budget store beside them.
 *
 * Every operation is ONE Lua script, so it is atomic on the server, and lease
 * and claim time is the server's `TIME`, which every process shares: host
 * clocks never decide who holds a lease. Every key carries the hash tag
 * `{<prefix>:ops}`, so a Redis Cluster keeps the store in one slot. Needs
 * Redis 7 or later and a client that runs scripts: node-redis as it is,
 * ioredis through `wrapIoredisClient`. Node-only.
 *
 * KEY SCHEMA (tag `T` = `{<prefix>:ops}`, prefix default `deuz`):
 *
 * ```
 * T:lease:owner     HASH  key -> owner
 * T:lease:token     HASH  key -> token (only ever grows; 1 again after a prune)
 * T:lease:expiry    ZSET  key -> expiresAt, server ms (0 once released)
 * T:lease:signals   HASH  key -> queued signals, space-separated, in queue order
 * T:run:payload     HASH  runId -> encoded AgentRunEnvelope
 * T:run:revision    HASH  runId -> revision (0 for a 2.1 envelope)
 * T:run:terminal    ZSET  runId -> server ms of its save, terminal runs only
 * T:run:entry       HASH  runId -> its listing entry (below), to unindex it
 * T:run:ix, T:run:ix:ph:<phase>, T:run:ix:sc:<hex scope>, T:run:ix:ps:<phase>:<hex scope>
 *                   ZSET  score 0, member = listing entry: every run, by phase,
 *                         by scope, by both; ZRANGEBYLEX pages them in order
 * T:run:indexed     STRING '1' once every run has a listing entry
 * T:claims          ZSET  key -> server ms it was granted
 * T:schema          STRING the key layout version (1), stamped on first use
 * ```
 *
 * A listing entry is the server ms of the run's last save as 16 decimal
 * digits, the run ID as hex UTF-16 code units (`hexUnits`), then `-` and the
 * summary the listing returns: phase, result status (empty while in
 * progress), revision and hex scope, `-`-separated. Byte order of the entries
 * is the listing order reversed: time, then run ID as JavaScript compares it
 * (`-` sorts below every digit, so a run ID that is a prefix of another comes
 * first). The save and prune scripts keep the indexes, so listing is range
 * reads with no lookup per run.
 *
 * Runs saved by a pre-release 2.3 build, before the listing index existed,
 * have no entry. A store this build created is stamped `T:run:indexed` with
 * its schema; on any other, the first `list` indexes the runs that lack an
 * entry, a page of about 100 per script, then sets the marker. A terminal run is
 * listed at its terminal save time; another, whose last save nothing
 * recorded, at the time it was indexed.
 */
import type {
  AgentRunEnvelope,
  AgentRunListPage,
  AgentRunListQuery,
  AgentRunStore,
  AgentRunSummary,
} from '../types/agent-run';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from '../types/lease';
import { assertEnvelopeRevision, assertLeaseRequest } from '../internal/ops-validate';
import { assertRetentionTime } from '../internal/ops-retention';
import {
  agentRunListPage,
  planAgentRunList,
  summarizeAgentRun,
  type AgentRunListPlan,
} from '../internal/agent-run-list';
import { decodeSwarm, encodeSwarm } from '../swarm/store';
import type { RedisScriptClient } from './store-redis';
import {
  arg,
  BACKFILL_BATCH,
  fromHexUnits,
  hexUnits,
  inBatches,
  LUA_HSCAN,
  PRUNE_BATCH,
  redisConnection,
  redisStoreTag,
  replyList,
  replyNumber,
  replyText,
  script,
  versionedClient,
} from './redis-scripts';

// The Redis budget store shares this Node-only subpath, as on SQLite and
// Postgres: one import for every durable ops store on Redis.
export { createRedisBudgetStore } from './redis-budget';
export type { RedisBudgetStore, RedisBudgetStoreOptions } from './redis-budget';
export { wrapIoredisClient } from './store-redis';
export type { IoredisClientLike, RedisScriptClient } from './store-redis';

export type RedisOpsStoreOptions =
  | {
      /**
       * A connected client that runs scripts. Your app owns the connection;
       * `close()` never quits it.
       */
      client: RedisScriptClient;
      /** Key namespace, inside the hash tag. Default `'deuz'`; no `{` or `}`. */
      prefix?: string;
    }
  | {
      /**
       * Connection string for the convenience path: lazily imports the
       * optional `redis` peer on the first call and connects once; `close()`
       * quits exactly that client.
       */
      url: string;
      prefix?: string;
    };

export interface RedisOpsStore {
  /** Has `ack` and, for retention, `prune`, on the server clock. */
  leases: LeaseProvider & Required<Pick<LeaseProvider, 'ack' | 'prune'>>;
  agentRuns: AgentRunStore & {
    /**
     * Retention: delete the terminal runs (completed, stopped or failed) last
     * saved before `before`, epoch ms on the server clock, and return how
     * many. Running, finalizing and suspended runs stay; a pruned run can no
     * longer be resumed or inspected, and its ID is free again.
     */
    prune(before: number): Promise<number>;
    /**
     * Native run discovery (2.3): a page of runs, newest save first, by
     * sorted-set indexes the save and prune scripts keep. Times are the
     * server's `TIME`.
     */
    list(query?: AgentRunListQuery): Promise<AgentRunListPage>;
  };
  /**
   * A durable claim for `createScheduler({ claim })` and `handleSignal({ dedupe })`:
   * a key is granted once across every process using the prefix, until
   * `release(key)` gives it back. Keys are stored as they are (Redis members
   * are binary-safe), with the server time they were granted at.
   */
  claims: {
    (key: string): Promise<boolean>;
    release(key: string): Promise<void>;
    /**
     * Retention: delete the keys granted before `before`, epoch ms on the
     * server clock, and return how many. A pruned key can be claimed again,
     * so keep every key an occurrence or delivery may still repeat.
     */
    prune(before: number): Promise<number>;
  };
  /** Quit the connection `{ url }` opened; an injected client stays open. */
  close(): Promise<void>;
}

const SIGNALS: readonly LeaseSignal[] = ['cancel', 'drain'];

/** Lease helpers: a missing signal list reads as empty, and membership is by word. */
const LEASE_HELPERS = `
local function signals_of(v) if has(v) then return v end return '' end
local function queues(list, signal)
  return string.find(' ' .. list .. ' ', ' ' .. signal .. ' ', 1, true) ~= nil
end
local function holder(key)
  local owner = redis.call('HGET', KEYS[1], key)
  local token = redis.call('HGET', KEYS[2], key)
  return has(owner) and owner == ARGV[2] and has(token) and num(token) == num(ARGV[3])
end
local function keep_cancel(key)
  if queues(signals_of(redis.call('HGET', KEYS[4], key)), 'cancel') then
    redis.call('HSET', KEYS[4], key, 'cancel')
  else
    redis.call('HDEL', KEYS[4], key)
  end
end
`;

// KEYS: owner, token, expiry, signals. ARGV: key, owner, ttlMs.
// Free, released (expiry 0) and expired keys change hands; tokens only grow.
// A queued cancel concerns the run and outlives its holder; a drain does not.
const acquireScript = script(`${LEASE_HELPERS}
local key = ARGV[1]
local now = now_ms()
local expires = redis.call('ZSCORE', KEYS[3], key)
if has(expires) and num(expires) > now then return arr({}) end
local token = 1
local stored = redis.call('HGET', KEYS[2], key)
if has(stored) then token = num(stored) + 1 end
local expiry = now + num(ARGV[3])
redis.call('HSET', KEYS[1], key, ARGV[2])
redis.call('HSET', KEYS[2], key, int(token))
redis.call('ZADD', KEYS[3], int(expiry), key)
keep_cancel(key)
return arr({int(token), int(expiry)})
`);

// KEYS: owner, token, expiry, signals. ARGV: key, owner, token, ttlMs, acknowledge.
// A lapsed lease nobody took is still renewable; a released one is not. The
// renewal delivers every queued signal; acknowledged delivery keeps the cancel.
const renewScript = script(`${LEASE_HELPERS}
local key = ARGV[1]
local expires = redis.call('ZSCORE', KEYS[3], key)
if not holder(key) or not has(expires) or num(expires) == 0 then return arr({}) end
local expiry = now_ms() + num(ARGV[4])
local signals = signals_of(redis.call('HGET', KEYS[4], key))
local queued = ''
if ARGV[5] == '1' and queues(signals, 'cancel') then queued = 'cancel' end
redis.call('ZADD', KEYS[3], int(expiry), key)
if queued == '' then redis.call('HDEL', KEYS[4], key) else redis.call('HSET', KEYS[4], key, queued) end
return arr({int(expiry), signals, queued})
`);

// KEYS: owner, token, expiry, signals. ARGV: key, owner, token. A stale token is ignored.
const releaseScript = script(`${LEASE_HELPERS}
local key = ARGV[1]
if holder(key) then
  redis.call('ZADD', KEYS[3], '0', key)
  keep_cancel(key)
end
return 0
`);

// KEYS: owner, token, expiry, signals. ARGV: key, signal. Only a held key queues one.
const signalScript = script(`${LEASE_HELPERS}
local key = ARGV[1]
local expires = redis.call('ZSCORE', KEYS[3], key)
if not has(expires) or num(expires) <= now_ms() then return 0 end
local signals = signals_of(redis.call('HGET', KEYS[4], key))
if not queues(signals, ARGV[2]) then
  if signals == '' then signals = ARGV[2] else signals = signals .. ' ' .. ARGV[2] end
  redis.call('HSET', KEYS[4], key, signals)
end
return 1
`);

// KEYS: owner, token, expiry, signals. ARGV: key, owner, token. Fenced by the
// token: once the key changed hands, the cancel is the new holder's.
const ackScript = script(`${LEASE_HELPERS}
local key = ARGV[1]
if not holder(key) then return 0 end
local left = {}
for signal in string.gmatch(signals_of(redis.call('HGET', KEYS[4], key)), '%S+') do
  if signal ~= 'cancel' then left[#left + 1] = signal end
end
if #left == 0 then
  redis.call('HDEL', KEYS[4], key)
else
  redis.call('HSET', KEYS[4], key, table.concat(left, ' '))
end
return 1
`);

// KEYS: owner, token, expiry, signals. ARGV: before, offset, batch. Deletes
// the keys nobody holds (released, or expired before min(before, now)) that
// queue no cancel. The cutoff stops at the server's time: a lease expiring
// later is held, whatever a host clock ahead of the server passed as before.
// Answers { pruned, examined, kept } so the caller pages past kept keys.
const leasePruneScript = script(`${LEASE_HELPERS}
local cutoff = num(ARGV[1])
local now = now_ms()
if now < cutoff then cutoff = now end
local max = '(' .. real(cutoff)
if cutoff <= 0 then max = '0' end
local found = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', max, 'LIMIT', ARGV[2], ARGV[3])
local pruned, kept = 0, 0
for i = 1, #found do
  local key = found[i]
  if queues(signals_of(redis.call('HGET', KEYS[4], key)), 'cancel') then
    kept = kept + 1
  else
    redis.call('HDEL', KEYS[1], key)
    redis.call('HDEL', KEYS[2], key)
    redis.call('ZREM', KEYS[3], key)
    redis.call('HDEL', KEYS[4], key)
    pruned = pruned + 1
  end
end
return arr({pruned, #found, kept})
`);

// KEYS: payload. ARGV: runId.
const loadScript = script(`
local payload = redis.call('HGET', KEYS[1], ARGV[1])
if has(payload) then return payload end
return ''
`);

/** Digits of a listing entry's time: server ms up to 10^16, zero-padded. */
const STAMP_DIGITS = 16;

/**
 * The listing index helpers (see the module note). `base` is the run keys'
 * base (`T:run:`), taken from a declared key; an entry names its own indexes.
 */
const RUN_INDEX_HELPERS = `
local function stamp(ms)
  local s = int(ms)
  return string.rep('0', ${STAMP_DIGITS} - #s) .. s
end
local function run_indexes(base, entry)
  local phase, scope = string.match(entry, '%-([^%-]*)%-[^%-]*%-[^%-]*%-([^%-]*)$')
  if not phase then return {base .. 'ix'} end
  return {base .. 'ix', base .. 'ix:ph:' .. phase, base .. 'ix:sc:' .. scope,
    base .. 'ix:ps:' .. phase .. ':' .. scope}
end
local function unindex_run(base, entries, id)
  local old = redis.call('HGET', entries, id)
  if not has(old) then return end
  for _, key in ipairs(run_indexes(base, old)) do redis.call('ZREM', key, old) end
  redis.call('HDEL', entries, id)
end
local function index_run(base, entries, id, entry)
  for _, key in ipairs(run_indexes(base, entry)) do redis.call('ZADD', key, '0', entry) end
  redis.call('HSET', entries, id, entry)
end
`;

// KEYS: payload, revision, terminal, entry, ix. ARGV: runId, revision ('' for
// none), payload, terminal ('1' or '0'), the listing entry without its time.
// The fence: a save carries the stored revision plus one; a revision-less save
// is accepted while the stored run is unfenced (revision 0, or no run at all).
// The run's entry moves to this save's time and summary. Answers { 1 } or
// { 0, current }.
const saveScript = script(`${RUN_INDEX_HELPERS}
local id = ARGV[1]
local stored = redis.call('HGET', KEYS[2], id)
local current = 0
if has(stored) then current = num(stored) end
local ok
if ARGV[2] == '' then ok = current == 0 else ok = num(ARGV[2]) == current + 1 end
if not ok then return arr({0, int(current)}) end
local now = now_ms()
redis.call('HSET', KEYS[1], id, ARGV[3])
if ARGV[2] == '' then redis.call('HSET', KEYS[2], id, '0') else redis.call('HSET', KEYS[2], id, ARGV[2]) end
if ARGV[4] == '1' then
  redis.call('ZADD', KEYS[3], int(now), id)
else
  redis.call('ZREM', KEYS[3], id)
end
local base = key_base(KEYS[5], 'ix')
unindex_run(base, KEYS[4], id)
index_run(base, KEYS[4], id, stamp(now) .. ARGV[5])
return arr({1})
`);

// KEYS: payload, revision, terminal, entry, ix. ARGV: before, batch.
const runPruneScript = script(`${RUN_INDEX_HELPERS}
local found = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', '(' .. real(num(ARGV[1])), 'LIMIT', '0', ARGV[2])
local base = key_base(KEYS[5], 'ix')
for i = 1, #found do
  redis.call('HDEL', KEYS[1], found[i])
  redis.call('HDEL', KEYS[2], found[i])
  redis.call('ZREM', KEYS[3], found[i])
  unindex_run(base, KEYS[4], found[i])
end
return #found
`);

// KEYS: the indexes to read. ARGV: max (an exclusive bound, or '+'), count.
// Answers up to count entries of each index below max, newest first.
const runListScript = script(`
local out = {}
for i = 1, #KEYS do
  local found = redis.call('ZREVRANGEBYLEX', KEYS[i], ARGV[1], '-', 'LIMIT', '0', ARGV[2])
  for j = 1, #found do out[#out + 1] = found[j] end
end
return arr(out)
`);

// KEYS: revision, entry, payload, terminal, indexed. ARGV: cursor, count.
// Answers { } once every run has an entry; else the next cursor ('0' at the
// end), then runId, payload and terminal save time ('' for none) of each run in
// this page of the revision hash that has no entry.
const backfillScanScript = script(`${LUA_HSCAN}
if has(redis.call('GET', KEYS[5])) then return arr({}) end
local cursor, rows = hscan(KEYS[1], ARGV[1], ARGV[2])
local out = {cursor}
for i = 1, #rows, 2 do
  local id = rows[i]
  if not has(redis.call('HGET', KEYS[2], id)) then
    local payload = redis.call('HGET', KEYS[3], id)
    if has(payload) then
      local at = redis.call('ZSCORE', KEYS[4], id)
      out[#out + 1] = id
      out[#out + 1] = payload
      if has(at) then out[#out + 1] = at else out[#out + 1] = '' end
    end
  end
end
return arr(out)
`);

// KEYS: entry, payload, ix, indexed. ARGV: '1' when the scan is done, then
// for each run: runId, listing entry without its time, time ('' for now).
// Indexes each run that is still stored and still has no entry (a save or a
// prune since the scan wins), then marks the store indexed when done.
const backfillIndexScript = script(`${RUN_INDEX_HELPERS}
local base = key_base(KEYS[3], 'ix')
local now = now_ms()
for i = 2, #ARGV, 3 do
  local id = ARGV[i]
  if not has(redis.call('HGET', KEYS[1], id)) and redis.call('HEXISTS', KEYS[2], id) == 1 then
    local at = now
    if ARGV[i + 2] ~= '' then at = num(ARGV[i + 2]) end
    index_run(base, KEYS[1], id, stamp(at) .. ARGV[i + 1])
  end
end
if ARGV[1] == '1' then redis.call('SET', KEYS[4], '1') end
return 0
`);

/** A run's listing entry without its time: hex run ID, phase, status, revision, hex scope. */
function runEntry(envelope: AgentRunEnvelope): string {
  // Only lowercase words, so an entry always splits on '-' and names its
  // indexes; the listing refuses an unknown phase, as the SQL stores do.
  const word = (value: unknown) => typeof value === 'string' && /^[a-z]+$/.test(value);
  const status = (envelope.result as { status?: unknown } | undefined)?.status;
  const revision = envelope.revision;
  return [
    hexUnits(envelope.runId),
    word(envelope.phase) ? envelope.phase : 'unknown',
    word(status) ? status : '',
    Number.isSafeInteger(revision) && revision! >= 0 ? String(revision) : '0',
    hexUnits(String(envelope.scope)),
  ].join('-');
}

/** The summary a listing entry carries. */
function runSummary(entry: string): AgentRunSummary {
  const [runId = '', phase, status, revision, scope = ''] = entry.slice(STAMP_DIGITS).split('-');
  return summarizeAgentRun({
    runId: fromHexUnits(runId),
    scope: fromHexUnits(scope),
    revision,
    updatedAt: Number(entry.slice(0, STAMP_DIGITS)),
    phase,
    status,
  });
}

/**
 * The exclusive `ZREVRANGEBYLEX` bound of the entries after a position in the
 * listing order: saved before `at`, or at `at` with a lower run ID. Save times
 * are whole milliseconds, so a fractional `at` (a cursor another store made,
 * or a cut-off) falls between two of them and its run ID no longer matters.
 * `'+'` when every entry lies after it, undefined when none can.
 */
function entriesBelow(at: number, runId?: string): string | undefined {
  const exact = runId !== undefined && Number.isInteger(at) ? hexUnits(runId) : undefined;
  const whole = exact === undefined ? Math.ceil(at) : at;
  if (whole >= 10 ** STAMP_DIGITS) return '+';
  if (whole < 0 || (whole === 0 && exact === undefined)) return undefined;
  return `(${String(whole).padStart(STAMP_DIGITS, '0')}${exact ?? ''}`;
}

/** The indexes holding exactly the runs a listing asks for. */
function runIndexes(ix: string, plan: AgentRunListPlan): string[] {
  const scope = plan.scope === undefined ? undefined : hexUnits(plan.scope);
  // The plan's phases are distinct: three of them are every phase.
  if (plan.phases === undefined || plan.phases.length === 3)
    return [scope === undefined ? ix : `${ix}:sc:${scope}`];
  return plan.phases.map((phase) =>
    scope === undefined ? `${ix}:ph:${phase}` : `${ix}:ps:${phase}:${scope}`,
  );
}

// KEYS: claims. ARGV: key. Whichever caller adds the key first wins it.
const claimScript = script(`
return redis.call('ZADD', KEYS[1], 'NX', int(now_ms()), ARGV[1])
`);

// KEYS: claims. ARGV: key.
const unclaimScript = script(`
redis.call('ZREM', KEYS[1], ARGV[1])
return 0
`);

// KEYS: claims. ARGV: before, batch.
const claimPruneScript = script(`
local found = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. real(num(ARGV[1])), 'LIMIT', '0', ARGV[2])
for i = 1, #found do redis.call('ZREM', KEYS[1], found[i]) end
return #found
`);

/**
 * Build the Redis ops store. SYNCHRONOUS and side-effect free: nothing is sent,
 * and on the `{ url }` path the optional peer is not imported, until the first
 * call.
 */
export function createRedisOpsStore(options: RedisOpsStoreOptions): RedisOpsStore {
  const tag = redisStoreTag(options.prefix, 'ops');
  const connection = redisConnection<RedisScriptClient>(options, {
    factory: 'createRedisOpsStore',
    noun: 'ops store',
  });
  const runIndexed = `${tag}:run:indexed`;
  // A store this build creates indexes every run from its first save.
  const use = versionedClient(connection, tag, 'ops', [runIndexed]);
  const leaseKeys = [
    `${tag}:lease:owner`,
    `${tag}:lease:token`,
    `${tag}:lease:expiry`,
    `${tag}:lease:signals`,
  ];
  const [runPayload, runRevision, runTerminal, runEntries, runIx] = [
    `${tag}:run:payload`,
    `${tag}:run:revision`,
    `${tag}:run:terminal`,
    `${tag}:run:entry`,
    `${tag}:run:ix`,
  ];
  const runKeys = [runPayload, runRevision, runTerminal, runEntries, runIx];
  const claimKeys = [`${tag}:claims`];
  const view = (key: string, owner: string, token: number, expiresAt: number): Lease =>
    Object.freeze({ key, owner, token, expiresAt });
  const signals = (value: unknown): LeaseSignal[] =>
    (replyText(value) ?? '').split(' ').filter(Boolean) as LeaseSignal[];
  const texts = (reply: unknown): string[] =>
    replyList(reply).map(
      (value) => replyText(value) ?? (typeof value === 'number' ? String(value) : ''),
    );

  /** Index the runs saved before the listing index existed, a page per scan (module note). */
  const backfill = async (client: RedisScriptClient): Promise<void> => {
    const scanKeys = [runRevision, runEntries, runPayload, runTerminal, runIndexed];
    let cursor = '0';
    for (;;) {
      const reply = texts(
        await backfillScanScript(client, scanKeys, [cursor, arg(BACKFILL_BATCH)]),
      );
      if (!reply.length) return; // indexed already
      const [next = '0', ...found] = reply;
      const runs: string[] = [];
      for (let index = 0; index + 2 < found.length; index += 3)
        runs.push(
          found[index]!,
          runEntry(decodeSwarm<AgentRunEnvelope>(found[index + 1]!)),
          found[index + 2]!,
        );
      const done = next === '0';
      await backfillIndexScript(
        client,
        [runEntries, runPayload, runIx, runIndexed],
        [done ? '1' : '0', ...runs],
      );
      if (done) return;
      cursor = next;
    }
  };
  let backfilled: Promise<void> | undefined;
  const indexed = (client: RedisScriptClient): Promise<void> =>
    (backfilled ??= backfill(client).catch((error: unknown) => {
      // A failed backfill is retried by the next listing.
      backfilled = undefined;
      throw error;
    }));

  const leases: RedisOpsStore['leases'] = {
    async acquire({ key, owner, ttlMs }) {
      assertLeaseRequest(key, owner, ttlMs);
      const client = await use();
      const reply = replyList(await acquireScript(client, leaseKeys, [key, owner, arg(ttlMs)]));
      if (!reply.length) return undefined;
      return view(key, owner, replyNumber(reply[0]), replyNumber(reply[1]));
    },
    async renew(lease, ttlMs, renewOptions = {}): Promise<LeaseRenewal> {
      assertLeaseRequest(lease.key, lease.owner, ttlMs);
      const client = await use();
      const acknowledge = renewOptions.acknowledge === true;
      const reply = replyList(
        await renewScript(client, leaseKeys, [
          lease.key,
          lease.owner,
          arg(lease.token),
          arg(ttlMs),
          acknowledge ? '1' : '0',
        ]),
      );
      if (!reply.length) return { held: false };
      return {
        held: true,
        lease: view(lease.key, lease.owner, lease.token, replyNumber(reply[0])),
        signals: signals(reply[1]),
        ...(acknowledge ? { queued: signals(reply[2]) } : {}),
      };
    },
    async release(lease) {
      const client = await use();
      await releaseScript(client, leaseKeys, [lease.key, lease.owner, arg(lease.token)]);
    },
    async signal(key, signal) {
      if (!SIGNALS.includes(signal)) throw new TypeError(`Unknown lease signal: ${String(signal)}`);
      const client = await use();
      return replyNumber(await signalScript(client, leaseKeys, [key, signal])) === 1;
    },
    async ack(lease, signal) {
      if (signal !== 'cancel')
        throw new TypeError(`Only a cancel is acknowledged: ${String(signal)}`);
      const client = await use();
      return (
        replyNumber(
          await ackScript(client, leaseKeys, [lease.key, lease.owner, arg(lease.token)]),
        ) === 1
      );
    },
    async prune(before) {
      assertRetentionTime(before);
      const client = await use();
      // Keys that still owe a cancel stay in the expiry range; page past them.
      let total = 0;
      let offset = 0;
      for (;;) {
        const [pruned, examined, kept] = replyList(
          await leasePruneScript(client, leaseKeys, [arg(before), arg(offset), arg(PRUNE_BATCH)]),
        ).map(replyNumber);
        total += pruned ?? 0;
        // A full batch pages on; anything else, a malformed reply included, ends it.
        if (!((examined ?? 0) >= PRUNE_BATCH)) return total;
        offset += kept ?? 0;
      }
    },
  };

  const agentRuns: RedisOpsStore['agentRuns'] = {
    async load(runId) {
      const client = await use();
      const payload = replyText(await loadScript(client, runKeys.slice(0, 1), [runId]));
      return payload ? decodeSwarm<AgentRunEnvelope>(payload) : undefined;
    },
    async save(envelope) {
      if (!envelope?.runId) throw new TypeError('Agent run envelopes require a runId');
      const revision = envelope.revision;
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
        throw new Error(`Agent run revision conflict for ${envelope.runId}: invalid revision`);
      const payload = encodeSwarm(envelope);
      const client = await use();
      const reply = replyList(
        await saveScript(client, runKeys, [
          envelope.runId,
          revision === undefined ? '' : arg(revision),
          payload,
          envelope.phase === 'terminal' ? '1' : '0',
          runEntry(envelope),
        ]),
      );
      // Rejected: report the stored revision the save had to follow.
      if (replyNumber(reply[0]) !== 1)
        assertEnvelopeRevision({ revision: replyNumber(reply[1]) }, envelope);
    },
    async prune(before) {
      assertRetentionTime(before);
      const client = await use();
      return inBatches(PRUNE_BATCH, async (size) =>
        replyNumber(await runPruneScript(client, runKeys, [arg(before), arg(size)])),
      );
    },
    async list(query) {
      const plan = planAgentRunList(query);
      if (plan.phases?.length === 0) return { runs: [] };
      const bounds = [
        plan.updatedBefore === undefined ? '+' : entriesBelow(plan.updatedBefore),
        plan.after === undefined ? '+' : entriesBelow(plan.after.updatedAt, plan.after.runId),
      ];
      if (bounds.includes(undefined)) return { runs: [] };
      // The tighter bound: entries are ASCII, so JavaScript order is byte order.
      const max = (bounds as string[]).filter((bound) => bound !== '+').sort()[0] ?? '+';
      const client = await use();
      await indexed(client);
      const entries = texts(
        await runListScript(client, runIndexes(runIx, plan), [max, arg(plan.limit + 1)]),
      );
      // One index per phase asked for: merge them, newest first.
      entries.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
      return agentRunListPage(entries.slice(0, plan.limit + 1).map(runSummary), plan.limit);
    },
  };

  const claims: RedisOpsStore['claims'] = Object.assign(
    async (key: string): Promise<boolean> => {
      const client = await use();
      return replyNumber(await claimScript(client, claimKeys, [key])) === 1;
    },
    {
      async release(key: string): Promise<void> {
        const client = await use();
        await unclaimScript(client, claimKeys, [key]);
      },
      async prune(before: number): Promise<number> {
        assertRetentionTime(before);
        const client = await use();
        return inBatches(PRUNE_BATCH, async (size) =>
          replyNumber(await claimPruneScript(client, claimKeys, [arg(before), arg(size)])),
        );
      },
    },
  );

  return { leases, agentRuns, claims, close: connection.close };
}
