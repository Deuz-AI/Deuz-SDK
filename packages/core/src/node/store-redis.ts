/**
 * store-redis.ts — one Redis-backed pack of the three storage seams (2.0):
 * `MemoryStore` + `ChatStore` + `SessionStore`. Ships as
 * `@deuz-sdk/core/stores/redis`.
 *
 * A PACK rather than one object, for a hard reason: `MemoryStore.delete(ids[])`
 * and `SessionStore.delete(runId)` are different methods with the same name, so
 * a single value cannot implement both interfaces. `createRedisStores` returns
 * `{ memory, chats, sessions }` sharing one connection and one key namespace.
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
import { serializeCheckpoint, deserializeCheckpoint } from '../durable';
import { cosineSimilarity } from '../internal/vector';

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
 * node-redis's camelCase, so a real `RedisClientType` (v4 or v5) is assignable
 * with no wrapper, no adapter and no `as` — and so a test (or ioredis, or a
 * cluster proxy) can satisfy it with a plain object.
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
}

/** What the `{ url }` path opens for itself — the seam plus its lifecycle. */
interface ManagedRedisClient extends RedisClientLike {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface RedisModule {
  createClient(options: { url: string }): ManagedRedisClient;
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
       * `^4.6.0 || ^5.0.0`) is an OPTIONAL peer, imported lazily on the first
       * command — construction itself never touches it — and `close()` quits
       * exactly this client, because the store opened it.
       */
      url: string;
      prefix?: string;
    };

/** The three seams plus the two operations that belong to the pack, not to a seam. */
export interface RedisStores {
  memory: MemoryStore;
  chats: Required<ChatStore>;
  sessions: Required<SessionStore>;
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
  };
}

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

function parseCheckpoint(json: string): AgentCheckpoint | undefined {
  try {
    return deserializeCheckpoint(json);
  } catch {
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

async function openClient(url: string): Promise<ManagedRedisClient> {
  let mod: RedisModule;
  try {
    // `as string` keeps tsup's dts builder from statically resolving the
    // optional peer (matches node/browser.ts and rag-node.ts).
    mod = (await import('redis' as string)) as unknown as RedisModule;
  } catch (err) {
    throw new Error(
      'createRedisStores({ url }) requires the optional peer `redis` (node-redis v4 or v5). Install it with `npm i redis`, or pass a client you connected yourself: createRedisStores({ client }).',
      { cause: err },
    );
  }
  const client = mod.createClient({ url });
  await client.connect();
  return client;
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
  let opened: Promise<ManagedRedisClient> | undefined;

  /** The client for the next command (injected as-is, or lazily opened ONCE). */
  const use = async (): Promise<RedisClientLike> => {
    if ('client' in options) return options.client;
    const pending = opened ?? openClient(options.url);
    if (pending !== opened) {
      opened = pending;
      // A failed connect must not poison the pack for its whole life: forget
      // the rejected promise so the next call retries instead of replaying it.
      // Guarded by identity, so a later successful connection is never dropped.
      pending.catch(() => {
        if (opened === pending) opened = undefined;
      });
    }
    return pending;
  };

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

  const memory: MemoryStore = {
    upsert: upsertRecords,

    async get(id, scope) {
      const record = await readRecord(id);
      if (!record) return null;
      if (scope && !matchesScope(record, scope)) return null;
      return record;
    },

    async search(query) {
      const topK = query.topK ?? 5;
      const records = await readRecords(await candidateIds(query.scope));
      const candidates = records.filter(
        (record) =>
          // Re-checked in process even though the index already narrowed it: a
          // crash-orphaned membership must not leak another tenant's row.
          matchesScope(record, query.scope) &&
          (query.kind ? record.kind === query.kind : true) &&
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
      return opts?.limit ? out.slice(0, opts.limit) : out;
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
      const ids = new Set<string>();
      for (const hash of hashes) {
        for (const id of await client.sMembers(k.memHash(hash))) ids.add(id);
      }
      const records = await readRecords([...ids]);
      // Scoped in process: the hash index is global, so the same fact written by
      // two users shares one set — and dedup must never reach across tenants.
      // Soft-deleted rows are excluded to match the `list()`-based fallback this
      // method replaces (`MemoryStore.findByHash`).
      return records.filter((record) => matchesScope(record, scope) && record.invalidAt == null);
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

  return {
    memory,
    chats,
    sessions,
    sweepExpiredMemories: (now = Date.now()) => deleteExpiredRecords(now),
    async close() {
      const pending = opened;
      opened = undefined;
      if (!pending) return; // injected client, or never connected — not ours
      const client = await pending.catch(() => undefined);
      await client?.quit();
    },
  };
}
