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
 * T:claims          ZSET  key -> server ms it was granted
 * ```
 */
import type { AgentRunEnvelope, AgentRunStore } from '../types/agent-run';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from '../types/lease';
import { assertEnvelopeRevision, assertLeaseRequest } from '../internal/ops-validate';
import { assertRetentionTime } from '../internal/ops-retention';
import { decodeSwarm, encodeSwarm } from '../swarm/store';
import type { RedisScriptClient } from './store-redis';
import {
  arg,
  inBatches,
  PRUNE_BATCH,
  redisConnection,
  redisStoreTag,
  replyList,
  replyNumber,
  replyText,
  script,
} from './redis-scripts';

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

// KEYS: payload, revision, terminal. ARGV: runId, revision ('' for none),
// payload, terminal ('1' or '0'). The fence: a save carries the stored
// revision plus one; a revision-less save is accepted while the stored run is
// unfenced (revision 0, or no run at all). Answers { 1 } or { 0, current }.
const saveScript = script(`
local id = ARGV[1]
local stored = redis.call('HGET', KEYS[2], id)
local current = 0
if has(stored) then current = num(stored) end
local ok
if ARGV[2] == '' then ok = current == 0 else ok = num(ARGV[2]) == current + 1 end
if not ok then return arr({0, int(current)}) end
redis.call('HSET', KEYS[1], id, ARGV[3])
if ARGV[2] == '' then redis.call('HSET', KEYS[2], id, '0') else redis.call('HSET', KEYS[2], id, ARGV[2]) end
if ARGV[4] == '1' then
  redis.call('ZADD', KEYS[3], int(now_ms()), id)
else
  redis.call('ZREM', KEYS[3], id)
end
return arr({1})
`);

// KEYS: payload, revision, terminal. ARGV: before, batch.
const runPruneScript = script(`
local found = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', '(' .. real(num(ARGV[1])), 'LIMIT', '0', ARGV[2])
for i = 1, #found do
  redis.call('HDEL', KEYS[1], found[i])
  redis.call('HDEL', KEYS[2], found[i])
  redis.call('ZREM', KEYS[3], found[i])
end
return #found
`);

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
  const leaseKeys = [
    `${tag}:lease:owner`,
    `${tag}:lease:token`,
    `${tag}:lease:expiry`,
    `${tag}:lease:signals`,
  ];
  const runKeys = [`${tag}:run:payload`, `${tag}:run:revision`, `${tag}:run:terminal`];
  const claimKeys = [`${tag}:claims`];
  const view = (key: string, owner: string, token: number, expiresAt: number): Lease =>
    Object.freeze({ key, owner, token, expiresAt });
  const signals = (value: unknown): LeaseSignal[] =>
    (replyText(value) ?? '').split(' ').filter(Boolean) as LeaseSignal[];

  const leases: RedisOpsStore['leases'] = {
    async acquire({ key, owner, ttlMs }) {
      assertLeaseRequest(key, owner, ttlMs);
      const client = await connection.use();
      const reply = replyList(await acquireScript(client, leaseKeys, [key, owner, arg(ttlMs)]));
      if (!reply.length) return undefined;
      return view(key, owner, replyNumber(reply[0]), replyNumber(reply[1]));
    },
    async renew(lease, ttlMs, renewOptions = {}): Promise<LeaseRenewal> {
      assertLeaseRequest(lease.key, lease.owner, ttlMs);
      const client = await connection.use();
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
      const client = await connection.use();
      await releaseScript(client, leaseKeys, [lease.key, lease.owner, arg(lease.token)]);
    },
    async signal(key, signal) {
      if (!SIGNALS.includes(signal)) throw new TypeError(`Unknown lease signal: ${String(signal)}`);
      const client = await connection.use();
      return replyNumber(await signalScript(client, leaseKeys, [key, signal])) === 1;
    },
    async ack(lease, signal) {
      if (signal !== 'cancel')
        throw new TypeError(`Only a cancel is acknowledged: ${String(signal)}`);
      const client = await connection.use();
      return (
        replyNumber(
          await ackScript(client, leaseKeys, [lease.key, lease.owner, arg(lease.token)]),
        ) === 1
      );
    },
    async prune(before) {
      assertRetentionTime(before);
      const client = await connection.use();
      // Keys that still owe a cancel stay in the expiry range; page past them.
      let total = 0;
      let offset = 0;
      for (;;) {
        const [pruned, examined, kept] = replyList(
          await leasePruneScript(client, leaseKeys, [arg(before), arg(offset), arg(PRUNE_BATCH)]),
        ).map(replyNumber);
        total += pruned ?? 0;
        if ((examined ?? 0) < PRUNE_BATCH) return total;
        offset += kept ?? 0;
      }
    },
  };

  const agentRuns: RedisOpsStore['agentRuns'] = {
    async load(runId) {
      const client = await connection.use();
      const payload = replyText(await loadScript(client, runKeys.slice(0, 1), [runId]));
      return payload ? decodeSwarm<AgentRunEnvelope>(payload) : undefined;
    },
    async save(envelope) {
      if (!envelope?.runId) throw new TypeError('Agent run envelopes require a runId');
      const revision = envelope.revision;
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
        throw new Error(`Agent run revision conflict for ${envelope.runId}: invalid revision`);
      const payload = encodeSwarm(envelope);
      const client = await connection.use();
      const reply = replyList(
        await saveScript(client, runKeys, [
          envelope.runId,
          revision === undefined ? '' : arg(revision),
          payload,
          envelope.phase === 'terminal' ? '1' : '0',
        ]),
      );
      // Rejected: report the stored revision the save had to follow.
      if (replyNumber(reply[0]) !== 1)
        assertEnvelopeRevision({ revision: replyNumber(reply[1]) }, envelope);
    },
    async prune(before) {
      assertRetentionTime(before);
      const client = await connection.use();
      return inBatches(PRUNE_BATCH, async (size) =>
        replyNumber(await runPruneScript(client, runKeys, [arg(before), arg(size)])),
      );
    },
  };

  const claims: RedisOpsStore['claims'] = Object.assign(
    async (key: string): Promise<boolean> => {
      const client = await connection.use();
      return replyNumber(await claimScript(client, claimKeys, [key])) === 1;
    },
    {
      async release(key: string): Promise<void> {
        const client = await connection.use();
        await unclaimScript(client, claimKeys, [key]);
      },
      async prune(before: number): Promise<number> {
        assertRetentionTime(before);
        const client = await connection.use();
        return inBatches(PRUNE_BATCH, async (size) =>
          replyNumber(await claimPruneScript(client, claimKeys, [arg(before), arg(size)])),
        );
      },
    },
  );

  return { leases, agentRuns, claims, close: connection.close };
}
