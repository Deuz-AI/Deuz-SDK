/**
 * store-redis.ts — one Redis-backed pack of the storage seams (2.0):
 * `MemoryStore` + `ChatStore` + `SessionStore`, and since 2.3 `RunStore`.
 * Ships as `@deuz-sdk/core/stores/redis`.
 *
 * A PACK rather than one object, for a hard reason: `MemoryStore.delete(ids[])`
 * and `SessionStore.delete(runId)` are different methods with the same name, so
 * a single value cannot implement both interfaces. `createRedisStores` returns
 * `{ memory, chats, sessions, runs }` sharing one connection and one key
 * namespace.
 *
 * ZERO hard dependency, by construction: this talks to a STRUCTURAL seam
 * ({@link RedisClientLike} — eleven commands, spelled exactly as node-redis v4/v5
 * spells them), never to a package. A connected node-redis client satisfies it
 * as-is, so the normal path is `createRedisStores({ client })` and nothing is
 * installed on our behalf. `{ url }` is the convenience path for scripts and
 * one-off jobs: it lazily `import('redis')`s the OPTIONAL peer and connects on
 * first use. ioredis (lowercase commands, upstream maintenance mode — which is
 * why node-redis is the documented client) fits through a ~10-line adapter
 * object; the docs page carries the recipe.
 *
 * KEY SCHEMA (prefix `P`, default `deuz`). Every user-sourced segment — record
 * id, scope value, hash, chatId, runId — is `encodeURIComponent`d, so a `:` in
 * an id can never forge a key boundary and two distinct ids can never collide:
 *
 * ```
 * P:mem:rec:<id>        STRING  JSON MemoryRecord (embedding inline as number[])
 * P:mem:ix:user:<v>     SET     record ids — one index per scope FIELD
 * P:mem:ix:agent:<v>    SET       (…:run:, …:actor:, …:chat: likewise)
 * P:mem:ix:all          SET     every record id (the unscoped fallback)
 * P:mem:hash:<hash>     SET     record ids carrying that content hash
 * P:mem:expiry          ZSET    score = expiresAt, member = id
 * P:chat:rec:<chatId>   STRING  serializeChatRecord (binary-safe)
 * P:chat:ix             SET     chat ids
 * P:sess:rec:<runId>    STRING  serializeCheckpoint (binary-safe)
 * P:sess:ix             SET     run ids
 * P:run:rec:<runId>     STRING  JSON RunRecord (2.3)
 * P:run:ix              ZSET    score = createdAt, member = runId
 * P:run:st:<status>     ZSET      the same, one per status (list({ status }))
 * ```
 *
 * NO MULTI IN v1 — stated plainly because it is a real, bounded weakness. A
 * write is a SEQUENCE of independent commands (index sets first, the record
 * string last), so a crash in the middle can leave an id in an index whose
 * record does not exist. Every reader tolerates exactly that: ids are resolved
 * with one `mGet` and a `null` row is skipped, so an orphan costs a wasted slot
 * in a scan and never a wrong answer — and `delete` / an unscoped
 * `sweepExpiredMemories` clear the id-keyed leftovers whenever they pass over
 * them. Wrapping the sequence in MULTI (or pipelining it) is a 2.x
 * optimization, not a correctness fix.
 */
import type { ChatRecord, ChatStore } from '../chat';
import { serializeChatRecord, deserializeChatRecord } from '../chat';
import type { MemoryHit, MemoryRecord, MemoryScope, MemoryStore } from '../memory';
import { matchesScope } from '../memory';
import type { AgentCheckpoint, SessionStore } from '../types/session';
import type { RunRecord, RunStatus, RunStore } from '../types/runtime';
import { serializeCheckpoint, deserializeCheckpoint, CheckpointVersionError } from '../durable';
import { cosineSimilarity } from '../internal/vector';
import { redisConnection } from './redis-scripts';

// ===================================================================
// The client seam
// ===================================================================

/** One ZSET entry, in node-redis's `zAdd` shape. */
export interface RedisZMember {
  score: number;
  value: string;
}

/**
 * The SLICE of a Redis client this store uses. Deliberately tiny and spelled in
 * node-redis's camelCase, so a real `RedisClientType` (v4, v5 or v6) is
 * assignable with no wrapper, no adapter and no `as` — and so a test, a
 * cluster proxy or ioredis (through {@link wrapIoredisClient}) can satisfy it.
 *
 * Return types are as loose as the store's own needs: it reads `get`/`mGet`
 * strings, `sMembers`/`sInter`/`zRangeByScore` string arrays, and IGNORES what
 * the write commands return (node-redis answers numbers, some proxies answer
 * `'OK'`), which is why those are typed `Promise<unknown>`.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(keys: string | string[]): Promise<unknown>;
  sAdd(key: string, members: string | string[]): Promise<unknown>;
  sRem(key: string, members: string | string[]): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  sInter(keys: string | string[]): Promise<string[]>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  zAdd(key: string, members: RedisZMember | RedisZMember[]): Promise<unknown>;
  zRem(key: string, members: string | string[]): Promise<unknown>;
  zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]>;
  /**
   * Run a Lua script atomically (2.3), in node-redis's `EVAL` signature. This
   * pack never calls it; the ops, budget and swarm stores of
   * `@deuz-sdk/core/ops/redis` and `@deuz-sdk/core/swarm/redis` need nothing
   * else (see {@link RedisScriptClient}).
   */
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/**
 * The client the 2.3 Redis stores take: one that runs Lua scripts (2.3). Every
 * read and write of those stores is one script, atomic on the server, so a
 * connected node-redis client (v4, v5 or v6) or cluster client fits as it is;
 * wrap ioredis with {@link wrapIoredisClient}. The scripts need Redis 7 or
 * later.
 */
export type RedisScriptClient = Required<Pick<RedisClientLike, 'eval'>>;

/**
 * The lowercase ioredis commands {@link wrapIoredisClient} calls (2.3). An
 * ioredis `Redis` or `Cluster` client satisfies it structurally; ioredis is not
 * a dependency of this package.
 */
export interface IoredisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  sinter(...keys: string[]): Promise<string[]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  zadd(key: string, ...scoresAndMembers: Array<number | string>): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  eval(script: string, numKeys: number, ...keysAndArguments: string[]): Promise<unknown>;
}

const list = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

/**
 * Fit an ioredis client to the seam (2.3): the store pack's eleven commands
 * and `eval`, so it serves `createRedisStores` and the ops, budget and swarm
 * stores alike. ioredis spells commands in lowercase and takes `EVAL`'s key
 * count positionally; this maps one onto the other and nothing more, so the
 * connection, its retries and its shutdown stay yours. An empty batch answers
 * locally, because Redis rejects `MGET` or `DEL` with no key.
 */
export function wrapIoredisClient(client: IoredisClientLike): Required<RedisClientLike> {
  return {
    get: (key) => client.get(key),
    set: (key, value) => client.set(key, value),
    del: async (keys) => (list(keys).length ? client.del(...list(keys)) : 0),
    sAdd: async (key, members) => (list(members).length ? client.sadd(key, ...list(members)) : 0),
    sRem: async (key, members) => (list(members).length ? client.srem(key, ...list(members)) : 0),
    sMembers: (key) => client.smembers(key),
    sInter: async (keys) => (list(keys).length ? client.sinter(...list(keys)) : []),
    mGet: async (keys) => (keys.length ? client.mget(...keys) : []),
    zAdd: async (key, members) => {
      const entries = Array.isArray(members) ? members : [members];
      if (!entries.length) return 0;
      return client.zadd(key, ...entries.flatMap((entry) => [entry.score, entry.value]));
    },
    zRem: async (key, members) => (list(members).length ? client.zrem(key, ...list(members)) : 0),
    zRangeByScore: (key, min, max) => client.zrangebyscore(key, min, max),
    eval: (script, options) =>
      client.eval(script, options.keys.length, ...options.keys, ...options.arguments),
  };
}

export type RedisStoreOptions =
  | {
      /**
       * An ALREADY CONNECTED client. This is the production path: your app owns
       * the connection (pool size, TLS, retry policy, shutdown order) and the
       * store never touches its lifecycle — `close()` will not quit it.
       */
      client: RedisClientLike;
      /** Key namespace. Default `'deuz'`; not escaped — it is yours, not a user's. */
      prefix?: string;
    }
  | {
      /**
       * Connection string for the convenience path. `redis` (node-redis
       * `^4.6.0 || ^5.0.0 || ^6.0.0`) is an OPTIONAL peer, imported lazily on the
       * first command — construction itself never touches it — and `close()`
       * quits exactly this client, because the store opened it.
       */
      url: string;
      prefix?: string;
    };

/** The four seams plus the two operations that belong to the pack, not to a seam. */
export interface RedisStores {
  /** Full `MemoryStore`, including the 2.0 `findByHash` / `deleteExpired` fast paths. */
  memory: Required<MemoryStore>;
  chats: Required<ChatStore>;
  sessions: Required<SessionStore>;
  /**
   * Background-run metadata (2.3), as in the SQLite and Postgres packs. One
   * ZSET per status keeps `list({ status })` an index read; listings come
   * oldest `createdAt` first. A run has one writer, its worker, which is what
   * makes `update`'s read-modify-write safe.
   */
  runs: Required<RunStore>;
  /**
   * TTL garbage collection: hard-delete every memory whose `expiresAt` is at or
   * before `now` and return how many went. Backed by the `P:mem:expiry` ZSET, so
   * the cost is O(expired), not O(stored) — call it from a cron, or let
   * `memory.sweep: 'on-extract'` chain it onto write traffic.
   *
   * `now` defaults to the HOST clock. That is the one ambient read in this file
   * and it is deliberate: a store pack takes no `Dependencies`, and a sweeper
   * with no time source cannot sweep. Pass `deps.clock.now()` (or a fixed epoch)
   * for a deterministic sweep.
   */
  sweepExpiredMemories(now?: number): Promise<number>;
  /**
   * Release the connection this pack opened ITSELF (the `{ url }` path). An
   * INJECTED client is left untouched — closing a connection the caller owns,
   * and may still be using elsewhere, is not this store's decision.
   *
   * FINAL on the `{ url }` path: a store call made after `close()` REJECTS
   * rather than silently opening a second connection that nothing will ever
   * quit. A pack over an injected client keeps working, because closing it
   * released nothing in the first place.
   */
  close(): Promise<void>;
}

// ===================================================================
// Keys
// ===================================================================

const DEFAULT_PREFIX = 'deuz';

/**
 * Escape ONE user-sourced key segment. `encodeURIComponent` is the whole
 * defence: it maps `:` `/` and whitespace to `%XX`, so an id like `a:b` cannot
 * impersonate a deeper key, and it is INJECTIVE — `'a:b'` and `'a%3Ab'` encode
 * to different strings, so two chats can never land on one record.
 */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/** `MemoryScope` field → the index-key infix it owns. */
const SCOPE_FIELDS: ReadonlyArray<{ field: keyof MemoryScope; name: string }> = [
  { field: 'userId', name: 'user' },
  { field: 'agentId', name: 'agent' },
  { field: 'runId', name: 'run' },
  { field: 'actorId', name: 'actor' },
  { field: 'chatId', name: 'chat' },
];

function keyspace(prefix: string): {
  memRecord: (id: string) => string;
  memIndex: (name: string, value: string) => string;
  memAll: string;
  memHash: (hash: string) => string;
  memExpiry: string;
  chatRecord: (chatId: string) => string;
  chatIndex: string;
  sessionRecord: (runId: string) => string;
  sessionIndex: string;
  runRecord: (runId: string) => string;
  runIndex: string;
  runStatus: (status: string) => string;
} {
  return {
    memRecord: (id) => `${prefix}:mem:rec:${seg(id)}`,
    memIndex: (name, value) => `${prefix}:mem:ix:${name}:${seg(value)}`,
    memAll: `${prefix}:mem:ix:all`,
    memHash: (hash) => `${prefix}:mem:hash:${seg(hash)}`,
    memExpiry: `${prefix}:mem:expiry`,
    chatRecord: (chatId) => `${prefix}:chat:rec:${seg(chatId)}`,
    chatIndex: `${prefix}:chat:ix`,
    sessionRecord: (runId) => `${prefix}:sess:rec:${seg(runId)}`,
    sessionIndex: `${prefix}:sess:ix`,
    runRecord: (runId) => `${prefix}:run:rec:${seg(runId)}`,
    runIndex: `${prefix}:run:ix`,
    runStatus: (status) => `${prefix}:run:st:${seg(status)}`,
  };
}

/** Every `RunStatus`: `runs.delete` clears the run from each status index. */
const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'suspended',
  'completed',
  'failed',
];

// ===================================================================
// Pure decoding helpers (a corrupt value is SKIPPED, never thrown)
// ===================================================================

function parseRecord(json: string): MemoryRecord | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object') return undefined;
    const record = value as MemoryRecord;
    return typeof record.id === 'string' ? record : undefined;
  } catch {
    return undefined;
  }
}

function parseChat(json: string): ChatRecord | undefined {
  try {
    return deserializeChatRecord(json);
  } catch {
    return undefined;
  }
}

function parseRun(json: string): RunRecord | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object') return undefined;
    const record = value as RunRecord;
    return typeof record.runId === 'string' ? record : undefined;
  } catch {
    return undefined;
  }
}

function parseCheckpoint(json: string): AgentCheckpoint | undefined {
  try {
    return deserializeCheckpoint(json);
  } catch (error) {
    // A newer SDK's checkpoint is not a missing one (2.3).
    if (error instanceof CheckpointVersionError) throw error;
    return undefined;
  }
}

/**
 * Bi-temporal liveness. Without `asOf` this is the plain `invalidAt == null`
 * rule the in-memory and markdown stores use; WITH one it is a point-in-time
 * query (`MemoryQuery.asOf`): the fact must already have been true at that
 * instant and must not have been superseded by it.
 */
function isLiveAt(record: MemoryRecord, asOf?: number): boolean {
  if (asOf === undefined) return record.invalidAt == null;
  if ((record.validAt ?? record.createdAt) > asOf) return false;
  return record.invalidAt == null || record.invalidAt > asOf;
}

/**
 * `MemoryQuery.filter` as a client-side predicate — the twin of Postgres'
 * `metadata @> $n::jsonb`. Search here is client-side anyway, so this costs
 * nothing extra; ignoring the filter instead (which is what this store used to
 * do) silently widens a query the caller believes is narrow.
 */
function matchesMetadataFilter(
  record: MemoryRecord,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  const metadata = record.metadata ?? {};
  return Object.entries(filter).every(
    ([key, value]) => JSON.stringify(metadata[key]) === JSON.stringify(value),
  );
}

// ===================================================================
// The pack
// ===================================================================

/**
 * Build the Redis-backed store pack. SYNCHRONOUS and side-effect free: no
 * command is sent, and on the `{ url }` path the optional peer is not even
 * imported, until the first store call — so this is safe to build at module
 * scope in a serverless handler.
 *
 * SEARCH IS CLIENT-SIDE, and that is the honest trade of a v1 Redis backend:
 * `search()` narrows by the scope indexes (`sInter` over the fields the query
 * pins), pulls those records with ONE `mGet`, and ranks them in this process —
 * cosine when the query carries an embedding, substring otherwise. So a query
 * costs O(records in the scope), not O(matching records), and it moves the
 * scope's rows over the wire. Keep scopes narrow (`chatId`, `userId`); reach for
 * the Postgres/pgvector pack when one scope grows past a few thousand records.
 * A server-side vector index would mean Redis Stack, a schema and a migration —
 * out of scope for a drop-in adapter.
 */
export function createRedisStores(options: RedisStoreOptions): RedisStores {
  const k = keyspace(options.prefix ?? DEFAULT_PREFIX);
  const connection = redisConnection<RedisClientLike>(options, {
    factory: 'createRedisStores',
    noun: 'store pack',
  });
  /** The client for the next command (injected as-is, or lazily opened ONCE). */
  const use = connection.use;

  // --- memory plumbing ------------------------------------------------------

  /** The field-index keys a scope pins. Empty when the scope names nothing. */
  const indexKeys = (scope: MemoryScope): string[] =>
    SCOPE_FIELDS.filter(({ field }) => scope[field] !== undefined).map(({ field, name }) =>
      k.memIndex(name, scope[field]!),
    );

  /**
   * Ids in a scope: intersect the pinned field indexes (one `sInter`), read the
   * single index directly when only one field is pinned, and fall back to the
   * `all` index when the query pins nothing at all.
   */
  const candidateIds = async (scope: MemoryScope): Promise<string[]> => {
    const client = await use();
    const keys = indexKeys(scope);
    if (keys.length === 0) return client.sMembers(k.memAll);
    if (keys.length === 1) return client.sMembers(keys[0]!);
    return client.sInter(keys);
  };

  const readRecord = async (id: string): Promise<MemoryRecord | undefined> => {
    const client = await use();
    const json = await client.get(k.memRecord(id));
    return typeof json === 'string' ? parseRecord(json) : undefined;
  };

  /** Ids → records in ONE round-trip. Missing rows (orphan index ids) are skipped. */
  const readRecords = async (ids: string[]): Promise<MemoryRecord[]> => {
    if (ids.length === 0) return [];
    const client = await use();
    const rows = await client.mGet(ids.map((id) => k.memRecord(id)));
    const out: MemoryRecord[] = [];
    for (const json of rows) {
      if (typeof json !== 'string') continue;
      const record = parseRecord(json);
      if (record) out.push(record);
    }
    return out;
  };

  /**
   * Write one record and reconcile every index it appears in. The PREVIOUS
   * version is read first because only it knows which memberships are now stale
   * — a record that moved from `userId: a` to `userId: b`, or whose content hash
   * changed, would otherwise stay findable under the old value forever.
   */
  const upsertRecords = async (records: MemoryRecord[]): Promise<void> => {
    if (records.length === 0) return;
    const client = await use();
    for (const record of records) {
      const id = record.id;
      const previous = await readRecord(id);
      const nextKeys = indexKeys(record.scope);
      const staleKeys = previous
        ? indexKeys(previous.scope).filter((key) => !nextKeys.includes(key))
        : [];
      for (const key of staleKeys) await client.sRem(key, id);
      for (const key of nextKeys) await client.sAdd(key, id);
      await client.sAdd(k.memAll, id);
      if (previous && previous.hash !== record.hash) {
        await client.sRem(k.memHash(previous.hash), id);
      }
      await client.sAdd(k.memHash(record.hash), id);
      if (record.expiresAt !== undefined) {
        await client.zAdd(k.memExpiry, { score: record.expiresAt, value: id });
      } else if (previous?.expiresAt !== undefined) {
        await client.zRem(k.memExpiry, id);
      }
      // The record LAST: see the module note on MULTI. This ordering makes the
      // crash window leave an orphan index entry (harmless, skipped on read)
      // rather than a record no index can find (invisible, and permanent).
      await client.set(k.memRecord(id), JSON.stringify(record));
    }
  };

  const deleteRecords = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const client = await use();
    for (const id of ids) {
      const record = await readRecord(id);
      if (record) {
        for (const key of indexKeys(record.scope)) await client.sRem(key, id);
        await client.sRem(k.memHash(record.hash), id);
      }
      // Unconditional, even for an id with no record: these are the two index
      // memberships reachable from the id ALONE, so this is also what sweeps up
      // an orphan left by a crashed write. `sRem`/`zRem` on a non-member are
      // no-ops, so an unknown id costs nothing and fails nothing.
      await client.sRem(k.memAll, id);
      await client.zRem(k.memExpiry, id);
      await client.del(k.memRecord(id));
    }
  };

  const deleteExpiredRecords = async (now: number, scope?: MemoryScope): Promise<number> => {
    const client = await use();
    const due = await client.zRangeByScore(k.memExpiry, '-inf', now);
    if (due.length === 0) return 0;
    const records = await readRecords(due);
    const matched = scope ? records.filter((record) => matchesScope(record, scope)) : records;
    // An UNSCOPED sweep also deletes the ids whose record is already gone — the
    // orphan ZSET entries nothing else would ever reach. A scoped sweep cannot:
    // a vanished record cannot be shown to belong to the scope. Either way the
    // COUNT is records actually removed, never ids visited.
    await deleteRecords(scope ? matched.map((record) => record.id) : due);
    return matched.length;
  };

  const memory: Required<MemoryStore> = {
    upsert: upsertRecords,

    async get(id, scope) {
      const record = await readRecord(id);
      if (!record) return null;
      if (scope && !matchesScope(record, scope)) return null;
      return record;
    },

    async search(query) {
      const topK = query.topK ?? 5;
      const filter =
        query.filter && Object.keys(query.filter).length > 0 ? query.filter : undefined;
      const records = await readRecords(await candidateIds(query.scope));
      const candidates = records.filter(
        (record) =>
          // Re-checked in process even though the index already narrowed it: a
          // crash-orphaned membership must not leak another tenant's row.
          matchesScope(record, query.scope) &&
          (query.kind ? record.kind === query.kind : true) &&
          matchesMetadataFilter(record, filter) &&
          isLiveAt(record, query.asOf),
      );
      let scored: MemoryHit[];
      if (query.embedding) {
        const embedding = query.embedding;
        scored = candidates.map((record) => ({
          record,
          score: record.embedding ? cosineSimilarity(embedding, record.embedding) : 0,
        }));
      } else if (query.text) {
        const needle = query.text.toLowerCase();
        // Substring grep, non-matches DROPPED (the markdown store's rule) —
        // without a score there is nothing to rank a non-match by.
        scored = candidates
          .map((record) => ({
            record,
            score: record.text.toLowerCase().includes(needle) ? 1 : 0,
          }))
          .filter((hit) => hit.score > 0);
      } else {
        scored = candidates.map((record) => ({ record, score: 0 }));
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    },

    async list(scope, opts) {
      const records = await readRecords(await candidateIds(scope));
      const out = records.filter(
        (record) =>
          matchesScope(record, scope) &&
          (opts?.kind ? record.kind === opts.kind : true) &&
          record.invalidAt == null,
      );
      // `=== undefined`, not truthiness: `limit: 0` means "none", exactly as
      // `slice(0, 0)` and a SQL `LIMIT 0` do. Reading 0 as "unlimited" turns a
      // computed page size of zero into a full-scope scan on this backend only.
      return opts?.limit === undefined ? out : out.slice(0, opts.limit);
    },

    delete: deleteRecords,

    async update(id, patch) {
      const record = await readRecord(id);
      if (!record) return;
      // Through `upsert`, never a bare `set`: a patch may move the scope, the
      // hash or the TTL, and those live in indexes the write has to reconcile.
      await upsertRecords([{ ...record, ...patch }]);
    },

    async findByHash(hashes, scope) {
      if (hashes.length === 0) return [];
      const client = await use();
      const wanted = new Set(hashes);
      const members = new Map<string, string[]>();
      const ids = new Set<string>();
      for (const hash of hashes) {
        const found = await client.sMembers(k.memHash(hash));
        members.set(hash, found);
        for (const id of found) ids.add(id);
      }
      const records = await readRecords([...ids]);
      const byId = new Map(records.map((record) => [record.id, record]));

      // Repair a membership the record itself contradicts. Only when the record
      // EXISTS and carries another hash: an id with no record yet is the
      // documented crash window of an in-flight write (indexes first, record
      // last), and removing that membership would corrupt a live write.
      for (const [hash, found] of members) {
        for (const id of found) {
          const record = byId.get(id);
          if (record && record.hash !== hash) await client.sRem(k.memHash(hash), id);
        }
      }

      // The record's OWN hash decides, never the index membership that led here:
      // a stale set would otherwise let a dedup pass conclude that a brand-new
      // fact is already stored, and the agent would stop learning it.
      // Scoped in process too: the hash index is global, so the same fact
      // written by two users shares one set and dedup must not cross tenants.
      // Soft-deleted rows are excluded to match the `list()`-based fallback this
      // method replaces (`MemoryStore.findByHash`).
      return records.filter(
        (record) =>
          wanted.has(record.hash) && matchesScope(record, scope) && record.invalidAt == null,
      );
    },

    deleteExpired: deleteExpiredRecords,
  };

  // --- chats ----------------------------------------------------------------

  const chats: Required<ChatStore> = {
    async saveChat(record: ChatRecord) {
      const client = await use();
      await client.set(k.chatRecord(record.chatId), serializeChatRecord(record));
      await client.sAdd(k.chatIndex, record.chatId);
    },

    async loadChat(chatId) {
      const client = await use();
      const json = await client.get(k.chatRecord(chatId));
      return typeof json === 'string' ? parseChat(json) : undefined;
    },

    async deleteChat(chatId) {
      const client = await use();
      await client.del(k.chatRecord(chatId));
      await client.sRem(k.chatIndex, chatId);
    },

    async listChats(scope) {
      const client = await use();
      const ids = await client.sMembers(k.chatIndex);
      if (!scope || ids.length === 0) return ids;
      const fields = Object.entries(scope).filter(([, value]) => value !== undefined);
      if (fields.length === 0) return ids;
      // Chats carry NO scope index (a picker lists tens of chats, not the
      // thousands a memory scope holds), so the filter is client-side over one
      // `mGet` — the same shape as the JSONL store's readdir + load, and the
      // same answer.
      const rows = await client.mGet(ids.map((id) => k.chatRecord(id)));
      const matched: string[] = [];
      for (const json of rows) {
        if (typeof json !== 'string') continue;
        const record = parseChat(json);
        if (
          record &&
          fields.every(([field, value]) => record.scope[field as keyof MemoryScope] === value)
        ) {
          matched.push(record.chatId);
        }
      }
      return matched;
    },
  };

  // --- sessions -------------------------------------------------------------

  const sessions: Required<SessionStore> = {
    async save(checkpoint: AgentCheckpoint) {
      const client = await use();
      await client.set(k.sessionRecord(checkpoint.runId), serializeCheckpoint(checkpoint));
      await client.sAdd(k.sessionIndex, checkpoint.runId);
    },

    async load(runId) {
      const client = await use();
      const json = await client.get(k.sessionRecord(runId));
      return typeof json === 'string' ? parseCheckpoint(json) : undefined;
    },

    async delete(runId) {
      const client = await use();
      await client.del(k.sessionRecord(runId));
      await client.sRem(k.sessionIndex, runId);
    },

    async list() {
      const client = await use();
      return client.sMembers(k.sessionIndex);
    },
  };

  // --- runs (2.3) -----------------------------------------------------------

  const readRun = async (runId: string): Promise<RunRecord | undefined> => {
    const client = await use();
    const json = await client.get(k.runRecord(runId));
    return typeof json === 'string' ? parseRun(json) : undefined;
  };

  /**
   * The new status index first, the record, then the stale status index: a
   * crash between them leaves a membership the record contradicts, which
   * `list({ status })` filters out, and never a run its own status cannot find.
   */
  const writeRun = async (record: RunRecord, previous: RunRecord | undefined): Promise<void> => {
    const client = await use();
    const member: RedisZMember = { score: record.createdAt, value: record.runId };
    await client.zAdd(k.runIndex, member);
    await client.zAdd(k.runStatus(record.status), member);
    await client.set(k.runRecord(record.runId), JSON.stringify(record));
    if (previous && previous.status !== record.status)
      await client.zRem(k.runStatus(previous.status), record.runId);
  };

  const runs: Required<RunStore> = {
    async create(record: RunRecord) {
      // A second create under the same runId replaces the run, as in SQLite and Postgres.
      await writeRun(record, await readRun(record.runId));
    },

    async update(runId, patch) {
      const existing = await readRun(runId);
      if (!existing) return; // unknown run — the same no-op as every RunStore
      await writeRun({ ...existing, ...patch, runId }, existing);
    },

    get: readRun,

    async list(filter) {
      const client = await use();
      const status = filter?.status;
      const ids = await client.zRangeByScore(
        status ? k.runStatus(status) : k.runIndex,
        '-inf',
        '+inf',
      );
      if (ids.length === 0) return [];
      const rows = await client.mGet(ids.map((id) => k.runRecord(id)));
      const out: RunRecord[] = [];
      for (const json of rows) {
        if (typeof json !== 'string') continue;
        const record = parseRun(json);
        // The record's own status decides, never the membership that led here.
        if (record && (!status || record.status === status)) out.push(record);
      }
      return out;
    },

    async delete(runId) {
      const client = await use();
      const existing = await readRun(runId);
      await client.del(k.runRecord(runId));
      // Unconditional, like the other seams' deletes: an orphan membership left
      // by a crashed write is reachable from the runId alone.
      await client.zRem(k.runIndex, runId);
      const statuses = new Set<string>(RUN_STATUSES);
      if (existing) statuses.add(existing.status);
      for (const status of statuses) await client.zRem(k.runStatus(status), runId);
    },
  };

  return {
    memory,
    chats,
    sessions,
    runs,
    sweepExpiredMemories: (now = Date.now()) => deleteExpiredRecords(now),
    close: connection.close,
  };
}

// 2.4 stores on this entry: their own modules and tables (W0 skeleton; W1 lanes
// implement them in place, never in this file).
export * from './stream-state-redis';
