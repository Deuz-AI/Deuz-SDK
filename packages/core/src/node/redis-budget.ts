/**
 * The Redis `BudgetStore` (2.3), from `@deuz-sdk/core/ops/redis`.
 *
 * Every state change is ONE Lua script, atomic on the server, and windows run
 * on the server's `TIME`, never on host clocks. The model is the Postgres
 * store's: a scope keeps its first window and a ring of `buckets` slots that
 * admission sums (one slot holding the total of a lifetime scope), plus a
 * per-model history that `usage` reads and `prune` folds; a request record is
 * the idempotency key and remembers its outcome. Validation, the fingerprint
 * and the transition rules are the shared ones in `budget-store.ts`, so this
 * store admits, settles and refuses like the others. USD is summed as IEEE
 * doubles in Lua, as in JavaScript, and compared and reported at 1e-12.
 *
 * KEY SCHEMA (tag `B` = `{<prefix>:budget}`, prefix default `deuz`):
 *
 * ```
 * B:req:<requestId>   HASH  fingerprint, model, estimates, state, reservedAt,
 *                           scope keys and history buckets, outcome, actuals
 * B:scope:<key>       HASH  w (window ms, -1 lifetime), b (buckets), bm (bucket ms),
 *                           ring slots: i<n> bucket index, t<n> tokens, u<n> USD
 * B:hist:<key>        HASH  "<bucket>:<modelId>" -> "<tokens> <usd>"
 * B:held              HASH  "<bucket>:<key>" -> open holds charging that bucket
 * B:open              ZSET  score 0, member = 16-digit reservedAt + requestId
 * B:closed            ZSET  requestId -> reservedAt (settled, released, denied)
 * B:scopes            ZSET  score 0, member = scope key (prune walks it)
 * ```
 */
import type {
  BudgetHold,
  BudgetPruneResult,
  BudgetStore,
  BudgetStoreMaintenance,
  BudgetStoreReservation,
  BudgetSweepOptions,
  BudgetSweepResult,
} from '../types/budget-store';
import {
  assertBudgetActual,
  assertBudgetKey,
  assertPruneOptions,
  assertSameWindow,
  assertUsageOptions,
  normalizeBudgetReserve,
  normalizeHoldQuery,
  planBudgetTransition,
  reservationConflict,
  roundBudgetOutcome,
  summarizeBudgetUsage,
  sweepBudgetHolds,
  type NormalizedBudgetReserve,
} from '../budget-store';
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

export type RedisBudgetStoreOptions =
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

/** A Redis budget store: the whole `BudgetStore`, retention and holds included. */
export interface RedisBudgetStore extends BudgetStore {
  /** Retention: see `BudgetStore.prune`. */
  prune: BudgetStoreMaintenance['prune'];
  /** Open holds: see `BudgetStore.holds`. */
  holds: BudgetStoreMaintenance['holds'];
  /** Hold reconciliation: see `BudgetStore.sweep`. */
  sweep: BudgetStoreMaintenance['sweep'];
  /** Quit the connection `{ url }` opened; an injected client stays open. */
  close(): Promise<void>;
}

/** A reservation time takes 16 digits in the open-hold index (until the year 318857). */
const TIME_DIGITS = 16;
const TIME_LIMIT = 10 ** TIME_DIGITS;

// Shared by the budget scripts. KEYS start with req, open, closed, held.
const BUDGET_HELPERS = `
local function round12(x)
  local y = x * 1e12
  local f = floor(y)
  if y - f >= 0.5 then f = f + 1 end
  return f / 1e12
end
local function pad16(n)
  local s = int(n)
  return string.rep('0', 16 - #s) .. s
end
local function split2(v)
  local a, b = string.match(v, '^(%S+) (%S+)$')
  return num(a), num(b)
end
-- The ring index and slot a charge of 'bucket' lives in: a lifetime scope
-- (window -1) keeps its total in slot 0 at index 0.
local function ring_slot(w, buckets, bucket)
  if w < 0 then return 0, 0 end
  return bucket, bucket % buckets
end
local function add_history(hist, bucket, model, dt, du)
  local field = int(bucket) .. ':' .. model
  local row = redis.call('HGET', hist, field)
  local t, u = 0, 0
  if has(row) then t, u = split2(row) end
  redis.call('HSET', hist, field, int(t + dt) .. ' ' .. real(u + du))
end
-- Close one charge of a reserved request by (dt, du): its ring slot while the
-- slot still holds the charge's bucket (a later bucket reuses the slot once
-- the window moved past it), its history row, and its hold count.
local function close_charge(scope, hist, key, bucket, model, dt, du)
  local cfg = redis.call('HMGET', scope, 'w', 'b')
  local ring, slot = ring_slot(num(cfg[1]), num(cfg[2]), bucket)
  local s = int(slot)
  local cur = redis.call('HMGET', scope, 'i' .. s, 't' .. s, 'u' .. s)
  if has(cur[1]) and num(cur[1]) == ring then
    redis.call('HSET', scope, 't' .. s, int(num(cur[2]) + dt), 'u' .. s, real(num(cur[3]) + du))
  end
  add_history(hist, bucket, model, dt, du)
  local field = int(bucket) .. ':' .. key
  if num(redis.call('HINCRBY', KEYS[4], field, '-1')) <= 0 then redis.call('HDEL', KEYS[4], field) end
end
-- Move the reserved request in KEYS[1] (ARGV[1]) to 'state', every charge by
-- (dt, du), and from the open index to the closed one.
local function close_request(state, dt, du, scope_prefix, hist_prefix)
  local rec = KEYS[1]
  local r = redis.call('HMGET', rec, 'model', 'n', 'at', 'm')
  for i = 1, num(r[2]) do
    local key = redis.call('HGET', rec, 'k' .. int(i))
    local bucket = num(redis.call('HGET', rec, 'b' .. int(i)))
    close_charge(scope_prefix .. key, hist_prefix .. key, key, bucket, r[1], dt, du)
  end
  redis.call('HSET', rec, 'state', state)
  redis.call('HDEL', rec, 'm')
  redis.call('ZREM', KEYS[2], r[4])
  redis.call('ZADD', KEYS[3], r[3], ARGV[1])
end
-- What a request that is not reserved reports: its state and actuals.
local function current_state()
  local r = redis.call('HMGET', KEYS[1], 'state', 'xt', 'xu')
  if not has(r[1]) then return nil end
  return {r[1], has(r[2]) and r[2] or '', has(r[3]) and r[3] or ''}
end
`;

// KEYS: req, open, closed, held, scopes, then per scope its scope and hist
// hashes. ARGV: requestId, fingerprint, modelId, tokens, usd, n, then per
// scope: key, token limit ('' none), USD limit ('' none), window ms (-1 for
// a lifetime scope), buckets, bucket ms. Answers { 'conflict' },
// { 'window', i, w, b }, or { 'repeat' | 'fresh', outcome }, the outcome
// reading 'admitted t1 u1 ...' (each scope's committed usage, this request
// included) or 'denied i dimension limit committed'.
const reserveScript = script(`${BUDGET_HELPERS}
local rec = KEYS[1]
local fp = redis.call('HGET', rec, 'fp')
if has(fp) then
  if fp ~= ARGV[2] then return arr({'conflict'}) end
  return arr({'repeat', redis.call('HGET', rec, 'out')})
end
local n = num(ARGV[6])
local function at(i, field) return ARGV[6 + (i - 1) * 6 + field] end
local function scope_of(i) return KEYS[4 + 2 * i] end
local function hist_of(i) return KEYS[5 + 2 * i] end
for i = 1, n do
  local cfg = redis.call('HMGET', scope_of(i), 'w', 'b')
  if has(cfg[1]) and (cfg[1] ~= at(i, 4) or (cfg[1] ~= '-1' and cfg[2] ~= at(i, 5))) then
    return arr({'window', int(i), cfg[1], has(cfg[2]) and cfg[2] or ''})
  end
end
-- A key's window is fixed by its first request, admitted or not.
for i = 1, n do
  if not has(redis.call('HGET', scope_of(i), 'w')) then
    redis.call('HSET', scope_of(i), 'w', at(i, 4), 'b', at(i, 5), 'bm', at(i, 6))
    redis.call('ZADD', KEYS[5], '0', at(i, 1))
  end
end
local now = now_ms()
local tokens, usd = num(ARGV[4]), num(ARGV[5])
-- Committed usage per scope before this request, USD at 1e-12.
local used = {}
for i = 1, n do
  local buckets, bm = num(at(i, 5)), num(at(i, 6))
  local t, u = 0, 0
  if num(at(i, 4)) < 0 then
    local cur = redis.call('HMGET', scope_of(i), 'i0', 't0', 'u0')
    if has(cur[1]) then t, u = num(cur[2]), num(cur[3]) end
  else
    local first = floor(now / bm) - buckets
    local fields = {}
    for slot = 0, buckets - 1 do
      fields[#fields + 1] = 'i' .. int(slot)
      fields[#fields + 1] = 't' .. int(slot)
      fields[#fields + 1] = 'u' .. int(slot)
    end
    local ring = redis.call('HMGET', scope_of(i), unpack(fields))
    for slot = 0, buckets - 1 do
      local index = ring[slot * 3 + 1]
      if has(index) and num(index) > first then
        t = t + num(ring[slot * 3 + 2])
        u = u + num(ring[slot * 3 + 3])
      end
    end
  end
  used[i] = {t, round12(u)}
end
-- The first scope and dimension the request does not fit, if any.
local outcome = nil
for i = 1, n do
  local t, u = used[i][1], used[i][2]
  if at(i, 2) ~= '' and t + tokens > num(at(i, 2)) then
    outcome = 'denied ' .. int(i) .. ' tokens ' .. at(i, 2) .. ' ' .. int(t)
    break
  end
  if at(i, 3) ~= '' and round12(u + usd) > num(at(i, 3)) then
    outcome = 'denied ' .. int(i) .. ' usd ' .. at(i, 3) .. ' ' .. real(u)
    break
  end
end
local fields = {'fp', ARGV[2], 'model', ARGV[3], 't', ARGV[4], 'u', ARGV[5], 'at', int(now), 'n', ARGV[6]}
for i = 1, n do
  fields[#fields + 1] = 'k' .. int(i)
  fields[#fields + 1] = at(i, 1)
  fields[#fields + 1] = 'b' .. int(i)
  fields[#fields + 1] = int(floor(now / num(at(i, 6))))
end
if outcome then
  fields[#fields + 1] = 'state'
  fields[#fields + 1] = 'denied'
  redis.call('ZADD', KEYS[3], int(now), ARGV[1])
else
  local parts = {'admitted'}
  for i = 1, n do
    parts[#parts + 1] = int(used[i][1] + tokens)
    parts[#parts + 1] = real(round12(used[i][2] + usd))
    local bucket = floor(now / num(at(i, 6)))
    local ring, slot = ring_slot(num(at(i, 4)), num(at(i, 5)), bucket)
    local s = int(slot)
    local cur = redis.call('HMGET', scope_of(i), 'i' .. s, 't' .. s, 'u' .. s)
    if has(cur[1]) and num(cur[1]) == ring then
      redis.call('HSET', scope_of(i), 't' .. s, int(num(cur[2]) + tokens), 'u' .. s, real(num(cur[3]) + usd))
    else
      redis.call('HSET', scope_of(i), 'i' .. s, int(ring), 't' .. s, int(tokens), 'u' .. s, real(usd))
    end
    add_history(hist_of(i), bucket, ARGV[3], tokens, usd)
    redis.call('HINCRBY', KEYS[4], int(bucket) .. ':' .. at(i, 1), '1')
  end
  outcome = table.concat(parts, ' ')
  local member = pad16(now) .. ARGV[1]
  fields[#fields + 1] = 'state'
  fields[#fields + 1] = 'reserved'
  fields[#fields + 1] = 'm'
  fields[#fields + 1] = member
  redis.call('ZADD', KEYS[2], '0', member)
end
fields[#fields + 1] = 'out'
fields[#fields + 1] = outcome
redis.call('HSET', rec, unpack(fields))
return arr({'fresh', outcome})
`);

// KEYS: req, open, closed, held. ARGV: requestId, actual tokens, actual USD,
// scope prefix, hist prefix. Answers { 'applied' }, { 'missing' }, or the
// state and actuals of a request that is no longer reserved.
const settleScript = script(`${BUDGET_HELPERS}
local state = current_state()
if not state then return arr({'missing'}) end
if state[1] ~= 'reserved' then return arr(state) end
local r = redis.call('HMGET', KEYS[1], 't', 'u')
close_request('settled', num(ARGV[2]) - num(r[1]), num(ARGV[3]) - num(r[2]), ARGV[4], ARGV[5])
redis.call('HSET', KEYS[1], 'xt', ARGV[2], 'xu', ARGV[3])
return arr({'applied'})
`);

// KEYS: req, open, closed, held. ARGV: requestId, scope prefix, hist prefix.
// A settled request that cost nothing is released without touching a counter.
const releaseScript = script(`${BUDGET_HELPERS}
local state = current_state()
if not state then return arr({'missing'}) end
if state[1] == 'settled' and num(state[2]) == 0 and num(state[3]) == 0 then
  redis.call('HSET', KEYS[1], 'state', 'released')
  return arr({'applied'})
end
if state[1] ~= 'reserved' then return arr(state) end
local r = redis.call('HMGET', KEYS[1], 't', 'u')
close_request('released', -num(r[1]), -num(r[2]), ARGV[2], ARGV[3])
return arr({'applied'})
`);

// KEYS: scope, hist. Answers { bucket ms or '', field, row, field, row, ... }.
const usageScript = script(`
local out = {}
local bm = redis.call('HGET', KEYS[1], 'bm')
out[1] = has(bm) and bm or ''
local rows = redis.call('HGETALL', KEYS[2])
for i = 1, #rows do out[#out + 1] = rows[i] end
return arr(out)
`);

// KEYS: closed. ARGV: before, batch, req prefix. Deletes the settled,
// released and denied records reserved before 'before'.
const requestPruneScript = script(`
local found = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. real(num(ARGV[1])), 'LIMIT', '0', ARGV[2])
for i = 1, #found do
  redis.call('DEL', ARGV[3] .. found[i])
  redis.call('ZREM', KEYS[1], found[i])
end
return #found
`);

// KEYS: scopes. ARGV: the last key of the previous page ('' to start), count.
const scopePageScript = script(`
local min = '-'
if ARGV[1] ~= '' then min = '(' .. ARGV[1] end
local found = redis.call('ZRANGEBYLEX', KEYS[1], min, '+', 'LIMIT', '0', ARGV[2])
local out = {}
for i = 1, #found do out[#out + 1] = found[i] end
return arr(out)
`);

// KEYS: scope, hist, held. ARGV: scope key, before. Folds the scope's history,
// per model, from the buckets isFoldableBucket allows and no open hold
// charges, into the newest of them. Answers the rows folded away.
const foldScript = script(`${BUDGET_HELPERS}
local cfg = redis.call('HMGET', KEYS[1], 'w', 'b', 'bm')
if not has(cfg[3]) then return 0 end
local w, buckets, bm = num(cfg[1]), num(cfg[2]), num(cfg[3])
local before, now = num(ARGV[2]), now_ms()
local rows = redis.call('HGETALL', KEYS[2])
local groups, models = {}, {}
for i = 1, #rows, 2 do
  local field = rows[i]
  local b, model = string.match(field, '^(%-?%d+):(.*)$')
  local bucket = num(b)
  if (bucket + 1) * bm <= before and (bucket + 2) * bm <= now
    and (w < 0 or (bucket + buckets) * bm <= now)
    and not has(redis.call('HGET', KEYS[3], int(bucket) .. ':' .. ARGV[1])) then
    local t, u = split2(rows[i + 1])
    if not groups[model] then
      groups[model] = {}
      models[#models + 1] = model
    end
    local list = groups[model]
    list[#list + 1] = {field, bucket, t, u}
  end
end
local folded = 0
for m = 1, #models do
  local list = groups[models[m]]
  if #list > 1 then
    local keep = list[1]
    local t, u = 0, 0
    for j = 1, #list do
      if list[j][2] > keep[2] then keep = list[j] end
      t = t + list[j][3]
      u = u + list[j][4]
    end
    for j = 1, #list do
      if list[j] ~= keep then
        redis.call('HDEL', KEYS[2], list[j][1])
        folded = folded + 1
      end
    end
    redis.call('HSET', KEYS[2], keep[1], int(t) .. ' ' .. real(u))
  end
end
return folded
`);

// KEYS: open. ARGV: min, max (ZRANGEBYLEX bounds), limit, req prefix.
// Answers { requestId, model, tokens, usd, reservedAt, n, key1..keyn, ... }.
const holdsScript = script(`
local members = redis.call('ZRANGEBYLEX', KEYS[1], ARGV[1], ARGV[2], 'LIMIT', '0', ARGV[3])
local out = {}
for i = 1, #members do
  local id = string.sub(members[i], 17)
  local rec = ARGV[4] .. id
  local r = redis.call('HMGET', rec, 'model', 't', 'u', 'at', 'n')
  out[#out + 1] = id
  for j = 1, 5 do out[#out + 1] = r[j] end
  for k = 1, num(r[5]) do out[#out + 1] = redis.call('HGET', rec, 'k' .. int(k)) end
end
return arr(out)
`);

/** The stored outcome of a reservation, in the shape `reserve` answers. */
function outcomeOf(text: string, request: NormalizedBudgetReserve): BudgetStoreReservation {
  const parts = text.split(' ');
  if (parts[0] === 'admitted')
    return roundBudgetOutcome({
      admitted: true,
      scopes: request.scopes.map((scope, index) => ({
        key: scope.key,
        tokens: Number(parts[1 + 2 * index]),
        usd: Number(parts[2 + 2 * index]) + 0,
      })),
    });
  return roundBudgetOutcome({
    admitted: false,
    key: request.scopes[Number(parts[1]) - 1]!.key,
    dimension: parts[2] === 'usd' ? 'usd' : 'tokens',
    limit: Number(parts[3]),
    committed: Number(parts[4]) + 0,
  });
}

/** An actual amount a closed request recorded, or null. */
const actualOf = (value: unknown): number | null => {
  const text = replyText(value);
  return text ? Number(text) : null;
};

/** A reservation time in the open-hold index: zero-padded, so byte order is time order. */
const padTime = (value: number): string => String(value).padStart(TIME_DIGITS, '0');

/**
 * Build the Redis budget store. SYNCHRONOUS and side-effect free: nothing is
 * sent, and on the `{ url }` path the optional peer is not imported, until the
 * first call.
 */
export function createRedisBudgetStore(options: RedisBudgetStoreOptions): RedisBudgetStore {
  const tag = redisStoreTag(options.prefix, 'budget');
  const connection = redisConnection<RedisScriptClient>(options, {
    factory: 'createRedisBudgetStore',
    noun: 'budget store',
  });
  const requestPrefix = `${tag}:req:`;
  const scopePrefix = `${tag}:scope:`;
  const historyPrefix = `${tag}:hist:`;
  const open = `${tag}:open`;
  const closed = `${tag}:closed`;
  const held = `${tag}:held`;
  const scopes = `${tag}:scopes`;
  const closing = (requestId: string) => [requestPrefix + requestId, open, closed, held];

  /** Settle or release `requestId` through its script, then judge what it found. */
  const transition = async (
    requestId: string,
    run: (client: RedisScriptClient) => Promise<unknown>,
    next: { settle: { tokens: number; usd: number } } | { release: true },
  ): Promise<void> => {
    const reply = replyList(await run(await connection.use()));
    const state = replyText(reply[0]);
    if (state === 'applied' || state === 'missing' || state === undefined) return;
    // Repeating the same settlement, or releasing twice, is a no-op; anything
    // else throws the shared reservation_conflict.
    planBudgetTransition(
      requestId,
      {
        state: state as 'reserved' | 'settled' | 'released' | 'denied',
        actualTokens: actualOf(reply[1]),
        actualUsd: actualOf(reply[2]),
      },
      next,
    );
  };

  const store: RedisBudgetStore = Object.freeze({
    async reserve(input) {
      const request = normalizeBudgetReserve(input);
      const client = await connection.use();
      const reply = replyList(
        await reserveScript(
          client,
          [
            requestPrefix + request.requestId,
            open,
            closed,
            held,
            scopes,
            ...request.scopes.flatMap((scope) => [
              scopePrefix + scope.key,
              historyPrefix + scope.key,
            ]),
          ],
          [
            request.requestId,
            request.fingerprint,
            request.modelId,
            arg(request.tokens ?? 0),
            arg(request.usd ?? 0),
            arg(request.scopes.length),
            ...request.scopes.flatMap((scope) => [
              scope.key,
              scope.limits.tokens === undefined ? '' : arg(scope.limits.tokens),
              scope.limits.usd === undefined ? '' : arg(scope.limits.usd),
              scope.windowMs === null ? '-1' : arg(scope.windowMs),
              arg(scope.buckets),
              arg(scope.bucketMs),
            ]),
          ],
        ),
      );
      const kind = replyText(reply[0]);
      if (kind === 'conflict') throw reservationConflict(request.requestId);
      if (kind === 'window') {
        const saved = replyText(reply[2]) ?? '';
        assertSameWindow(request.scopes[replyNumber(reply[1]) - 1]!, {
          windowMs: saved === '-1' ? null : Number(saved),
          buckets: Number(replyText(reply[3]) ?? ''),
        });
      }
      const outcome = replyText(reply[1]);
      if ((kind !== 'fresh' && kind !== 'repeat') || !outcome)
        throw new Error(`Budget reservation got an unexpected reply: ${String(kind)}`);
      return outcomeOf(outcome, request);
    },
    async settle(requestId, actual) {
      assertBudgetKey(requestId);
      const settle = assertBudgetActual(actual);
      await transition(
        requestId,
        (client) =>
          settleScript(client, closing(requestId), [
            requestId,
            arg(settle.tokens),
            arg(settle.usd),
            scopePrefix,
            historyPrefix,
          ]),
        { settle },
      );
    },
    async release(requestId) {
      assertBudgetKey(requestId);
      await transition(
        requestId,
        (client) =>
          releaseScript(client, closing(requestId), [requestId, scopePrefix, historyPrefix]),
        { release: true },
      );
    },
    async usage(key, usageOptions = {}) {
      assertUsageOptions(key, usageOptions);
      const client = await connection.use();
      const reply = replyList(
        await usageScript(client, [scopePrefix + key, historyPrefix + key], []),
      );
      const bucketMs = Number(replyText(reply[0]) || 0);
      const since = usageOptions.since;
      const rows: { modelId: string; tokens: number; usd: number }[] = [];
      for (let index = 1; index + 1 < reply.length; index += 2) {
        const field = replyText(reply[index]) ?? '';
        const separator = field.indexOf(':');
        const bucket = Number(field.slice(0, separator));
        // A bucket counts while any part of it lies after `since`.
        if (since !== undefined && (bucket + 1) * bucketMs <= since) continue;
        const [tokens, usd] = (replyText(reply[index + 1]) ?? '0 0').split(' ');
        rows.push({
          modelId: field.slice(separator + 1),
          tokens: Number(tokens),
          usd: Number(usd) + 0,
        });
      }
      return summarizeBudgetUsage(rows, usageOptions.byModel);
    },
    async prune(pruneOptions): Promise<BudgetPruneResult> {
      const before = assertPruneOptions(pruneOptions);
      const client = await connection.use();
      const requests = await inBatches(PRUNE_BATCH, async (size) =>
        replyNumber(
          await requestPruneScript(client, [closed], [arg(before), arg(size), requestPrefix]),
        ),
      );
      // Each scope folds in a script of its own, a page of scope keys at a time.
      let buckets = 0;
      let last = '';
      for (;;) {
        const page = replyList(await scopePageScript(client, [scopes], [last, arg(PRUNE_BATCH)]))
          .map(replyText)
          .filter((key): key is string => key !== undefined);
        for (const key of page)
          buckets += replyNumber(
            await foldScript(
              client,
              [scopePrefix + key, historyPrefix + key, held],
              [key, arg(before)],
            ),
          );
        if (page.length < PRUNE_BATCH) return { requests, buckets };
        last = page[page.length - 1]!;
      }
    },
    async holds(query) {
      const { before, limit, after } = normalizeHoldQuery(query);
      // Bounds in the open index's order: a 16-digit time, then the request ID.
      const ceiling = Math.ceil(before);
      if (ceiling <= 0) return [];
      const max = before >= TIME_LIMIT ? '+' : `(${padTime(ceiling)}`;
      let min = '-';
      if (after && after.reservedAt >= 0) {
        if (after.reservedAt >= TIME_LIMIT) return [];
        min = Number.isInteger(after.reservedAt)
          ? `(${padTime(after.reservedAt)}${after.requestId}`
          : `[${padTime(Math.ceil(after.reservedAt))}`;
      }
      const client = await connection.use();
      const reply = replyList(
        await holdsScript(client, [open], [min, max, arg(limit), requestPrefix]),
      );
      const holds: BudgetHold[] = [];
      for (let index = 0; index < reply.length; ) {
        const [requestId, modelId, tokens, usd, reservedAt, count] = reply
          .slice(index, index + 6)
          .map((value) => replyText(value) ?? '');
        const keys = reply
          .slice(index + 6, index + 6 + Number(count))
          .map((value) => replyText(value) ?? '');
        index += 6 + keys.length;
        holds.push({
          requestId: requestId!,
          modelId: modelId!,
          tokens: Number(tokens),
          usd: Number(usd) + 0,
          reservedAt: Number(reservedAt),
          keys,
        });
      }
      return holds;
    },
    async sweep(sweepOptions: BudgetSweepOptions): Promise<BudgetSweepResult> {
      return sweepBudgetHolds(store, sweepOptions);
    },
    close: connection.close,
  } satisfies RedisBudgetStore);
  return store;
}
