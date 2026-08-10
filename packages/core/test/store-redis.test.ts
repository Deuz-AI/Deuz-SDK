/**
 * store-redis.test.ts — the `@deuz-sdk/core/stores/redis` pack against a
 * Map/Set-backed FAKE client.
 *
 * No Redis process, no container, no `redis` package installed: `RedisClientLike`
 * is a structural seam of eleven commands, so the entire store is provable
 * against an object that implements them over three Maps. What that buys is
 * EXACTNESS — these tests assert the literal key strings, the set memberships
 * and the ZSET scores, which is precisely the layer a live-Redis integration
 * test hides behind "it worked". The fake reproduces the two Redis behaviours
 * the store leans on: an emptied SET/ZSET key stops existing, and `sInter` over
 * a missing key is empty.
 *
 * The seam CONTRACTS themselves are not re-asserted by hand — the three shared
 * suites from `fixtures/store-conformance.ts` run at the bottom, so this backend
 * answers the same questions as the in-memory, SQLite and Postgres ones.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createRedisStores,
  type RedisClientLike,
  type RedisStores,
  type RedisZMember,
} from '../src/node/store-redis';
import type { ChatRecord } from '../src/chat';
import type { MemoryRecord } from '../src/memory';
import type { AgentCheckpoint } from '../src/types/session';
import {
  assertMemoryStoreContract,
  assertChatStoreContract,
  assertSessionStoreContract,
} from './fixtures/store-conformance';

// ===================================================================
// The fake client
// ===================================================================

interface FakeRedis extends RedisClientLike {
  readonly strings: Map<string, string>;
  readonly sets: Map<string, Set<string>>;
  readonly zsets: Map<string, Map<string, number>>;
  /** Every command in call order, with its arguments. */
  readonly calls: Array<{ command: string; args: unknown[] }>;
  readonly stats: { connect: number; quit: number };
  /** Make the next `n` connect attempts reject (the retry test). */
  failConnect(times: number): void;
  connect(): Promise<void>;
  quit(): Promise<void>;
  /** Every LIVE key, sorted — an emptied SET/ZSET is gone, as it is in Redis. */
  keys(): string[];
}

function createFakeRedis(): FakeRedis {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const stats = { connect: 0, quit: 0 };
  let pendingConnectFailures = 0;

  const log = (command: string, ...args: unknown[]): void => {
    calls.push({ command, args });
  };
  const many = (members: string | string[]): string[] =>
    Array.isArray(members) ? members : [members];
  /** ZSET range bounds: Redis accepts `-inf`/`+inf` as well as numbers. */
  const bound = (value: number | string): number => {
    if (typeof value === 'number') return value;
    if (value === '-inf') return -Infinity;
    if (value === '+inf' || value === 'inf') return Infinity;
    return Number(value);
  };

  return {
    strings,
    sets,
    zsets,
    calls,
    stats,
    failConnect(times) {
      pendingConnectFailures = times;
    },
    async connect() {
      stats.connect++;
      if (pendingConnectFailures > 0) {
        pendingConnectFailures--;
        throw new Error('ECONNREFUSED');
      }
    },
    async quit() {
      stats.quit++;
    },
    keys() {
      return [...strings.keys(), ...sets.keys(), ...zsets.keys()].sort();
    },

    async get(key) {
      log('get', key);
      return strings.get(key) ?? null;
    },
    async set(key, value) {
      log('set', key, value);
      strings.set(key, value);
      return 'OK';
    },
    async del(keys) {
      log('del', keys);
      let removed = 0;
      for (const key of many(keys)) {
        if (strings.delete(key)) removed++;
        if (sets.delete(key)) removed++;
        if (zsets.delete(key)) removed++;
      }
      return removed;
    },
    async sAdd(key, members) {
      log('sAdd', key, members);
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      let added = 0;
      for (const member of many(members)) {
        if (!set.has(member)) {
          set.add(member);
          added++;
        }
      }
      return added;
    },
    async sRem(key, members) {
      log('sRem', key, members);
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const member of many(members)) if (set.delete(member)) removed++;
      if (set.size === 0) sets.delete(key); // Redis drops an emptied key
      return removed;
    },
    async sMembers(key) {
      log('sMembers', key);
      return [...(sets.get(key) ?? [])];
    },
    async sInter(keys) {
      log('sInter', keys);
      const [first, ...rest] = many(keys);
      const base = first === undefined ? undefined : sets.get(first);
      if (!base) return []; // intersecting with a missing key is empty
      let out = [...base];
      for (const key of rest) {
        const other = sets.get(key);
        if (!other) return [];
        out = out.filter((member) => other.has(member));
      }
      return out;
    },
    async mGet(keys) {
      log('mGet', keys);
      return keys.map((key) => strings.get(key) ?? null);
    },
    async zAdd(key, members: RedisZMember | RedisZMember[]) {
      log('zAdd', key, members);
      const zset = zsets.get(key) ?? new Map<string, number>();
      zsets.set(key, zset);
      for (const member of Array.isArray(members) ? members : [members]) {
        zset.set(member.value, member.score);
      }
      return 1;
    },
    async zRem(key, members) {
      log('zRem', key, members);
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const member of many(members)) if (zset.delete(member)) removed++;
      if (zset.size === 0) zsets.delete(key);
      return removed;
    },
    async zRangeByScore(key, min, max) {
      log('zRangeByScore', key, min, max);
      const zset = zsets.get(key);
      if (!zset) return [];
      const lo = bound(min);
      const hi = bound(max);
      return [...zset.entries()]
        .filter(([, score]) => score >= lo && score <= hi)
        .sort((a, b) => a[1] - b[1])
        .map(([value]) => value);
    },
  };
}

const commandNames = (client: FakeRedis): string[] => client.calls.map((c) => c.command);

// ===================================================================
// Fixtures
// ===================================================================

const T0 = 1_700_000_000_000;

function memoryRecord(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text: `fact ${id}`,
    hash: `hash-${id}`,
    kind: 'semantic',
    scope: { userId: 'user-a', chatId: 'chat-1' },
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function chatRecord(chatId: string, text: string): ChatRecord {
  return {
    chatId,
    scope: { userId: 'user-a', chatId: 'chat-1' },
    messages: [{ role: 'user', content: text }],
    updatedAt: T0,
  };
}

function checkpoint(runId: string): AgentCheckpoint {
  return {
    version: 1,
    runId,
    stepId: `${runId}#0`,
    stepIndex: 0,
    status: 'running',
    messages: [{ role: 'user', content: 'do the thing' }],
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 12,
    },
    createdAt: T0,
  };
}

const ids = (hits: Array<{ record: MemoryRecord }>): string[] => hits.map((h) => h.record.id);

/** A pack over a fresh fake — the pair every test starts from. */
function pack(prefix?: string): { client: FakeRedis; stores: RedisStores } {
  const client = createFakeRedis();
  return {
    client,
    stores: createRedisStores(prefix === undefined ? { client } : { client, prefix }),
  };
}

// ===================================================================
// Key schema
// ===================================================================

describe('createRedisStores — key schema', () => {
  it('writes exactly the documented keys for one memory record', async () => {
    const { client, stores } = pack();

    await stores.memory.upsert([
      memoryRecord('m1', { hash: 'h1', expiresAt: T0 + 5_000, embedding: [1, 0, 0] }),
    ]);

    expect(client.keys()).toEqual([
      'deuz:mem:expiry',
      'deuz:mem:hash:h1',
      'deuz:mem:ix:all',
      'deuz:mem:ix:chat:chat-1',
      'deuz:mem:ix:user:user-a',
      'deuz:mem:rec:m1',
    ]);
    expect([...client.sets.get('deuz:mem:ix:user:user-a')!]).toEqual(['m1']);
    expect([...client.sets.get('deuz:mem:ix:chat:chat-1')!]).toEqual(['m1']);
    expect([...client.sets.get('deuz:mem:ix:all')!]).toEqual(['m1']);
    expect([...client.sets.get('deuz:mem:hash:h1')!]).toEqual(['m1']);
    expect(client.zsets.get('deuz:mem:expiry')!.get('m1')).toBe(T0 + 5_000);
    // The embedding rides INLINE in the record JSON — no separate vector key.
    const stored = JSON.parse(client.strings.get('deuz:mem:rec:m1')!) as MemoryRecord;
    expect(stored.embedding).toEqual([1, 0, 0]);
    expect(stored.text).toBe('fact m1');
  });

  it('writes only the index sets the scope actually pins', async () => {
    const { client, stores } = pack();

    await stores.memory.upsert([memoryRecord('m1', { scope: { agentId: 'agent-7' } })]);

    expect(client.keys()).toEqual([
      'deuz:mem:hash:hash-m1',
      'deuz:mem:ix:agent:agent-7',
      'deuz:mem:ix:all',
      'deuz:mem:rec:m1',
    ]);
    // No TTL → no ZSET at all, so the sweeper never even looks at this record.
    expect(client.zsets.size).toBe(0);
  });

  it('namespaces every seam under a custom prefix', async () => {
    const { client, stores } = pack('app:tenant-7');

    await stores.memory.upsert([memoryRecord('m1')]);
    await stores.chats.saveChat(chatRecord('c1', 'hello'));
    await stores.sessions.save(checkpoint('run-1'));

    expect(client.keys().every((key) => key.startsWith('app:tenant-7:'))).toBe(true);
    expect(client.keys()).toEqual([
      'app:tenant-7:chat:ix',
      'app:tenant-7:chat:rec:c1',
      'app:tenant-7:mem:hash:hash-m1',
      'app:tenant-7:mem:ix:all',
      'app:tenant-7:mem:ix:chat:chat-1',
      'app:tenant-7:mem:ix:user:user-a',
      'app:tenant-7:mem:rec:m1',
      'app:tenant-7:sess:ix',
      'app:tenant-7:sess:rec:run-1',
    ]);
  });

  it('escapes every user-sourced segment (id, scope value, hash)', async () => {
    const { client, stores } = pack();

    await stores.memory.upsert([
      memoryRecord('a:b/c d', { hash: 'h:1', scope: { userId: 'u/1', chatId: 'chat 1' } }),
    ]);

    expect(client.keys()).toEqual([
      'deuz:mem:hash:h%3A1',
      'deuz:mem:ix:all',
      'deuz:mem:ix:chat:chat%201',
      'deuz:mem:ix:user:u%2F1',
      'deuz:mem:rec:a%3Ab%2Fc%20d',
    ]);
    // …and the escaping is transparent to the caller, in both directions.
    expect((await stores.memory.get('a:b/c d'))!.text).toBe('fact a:b/c d');
    expect(ids(await stores.memory.search({ scope: { userId: 'u/1' }, topK: 5 }))).toEqual([
      'a:b/c d',
    ]);
    await stores.memory.delete(['a:b/c d']);
    expect(client.keys()).toEqual([]);
  });

  it('keeps ids apart that would collide without escaping', async () => {
    const { client, stores } = pack();

    // `encodeURIComponent` is INJECTIVE: 'a:b' → 'a%3Ab', 'a%3Ab' → 'a%253Ab'.
    // Two chats that a naive key template would merge stay two chats.
    await stores.chats.saveChat(chatRecord('a:b', 'first'));
    await stores.chats.saveChat(chatRecord('a%3Ab', 'second'));

    expect(client.keys()).toContain('deuz:chat:rec:a%3Ab');
    expect(client.keys()).toContain('deuz:chat:rec:a%253Ab');
    expect((await stores.chats.loadChat('a:b'))!.messages[0]!.content).toBe('first');
    expect((await stores.chats.loadChat('a%3Ab'))!.messages[0]!.content).toBe('second');
    expect([...(await stores.chats.listChats())].sort()).toEqual(['a%3Ab', 'a:b']);
  });
});

// ===================================================================
// Scope narrowing
// ===================================================================

describe('createRedisStores — scope narrowing', () => {
  const seeded = async (): Promise<{ client: FakeRedis; stores: RedisStores }> => {
    const p = pack();
    await p.stores.memory.upsert([
      memoryRecord('a1', { scope: { userId: 'user-a', chatId: 'chat-1' } }),
      memoryRecord('a2', { scope: { userId: 'user-a', chatId: 'chat-2' } }),
      memoryRecord('b1', { scope: { userId: 'user-b', chatId: 'chat-1' } }),
    ]);
    p.client.calls.length = 0;
    return p;
  };

  it('intersects the pinned field indexes when a query names more than one', async () => {
    const { client, stores } = await seeded();

    const hits = await stores.memory.search({
      scope: { userId: 'user-a', chatId: 'chat-1' },
      topK: 10,
    });

    expect(ids(hits)).toEqual(['a1']);
    // ONE sInter over the two field indexes, then ONE mGet — not a scan.
    expect(commandNames(client)).toEqual(['sInter', 'mGet']);
    expect(client.calls[0]!.args[0]).toEqual([
      'deuz:mem:ix:user:user-a',
      'deuz:mem:ix:chat:chat-1',
    ]);
    expect(client.calls[1]!.args[0]).toEqual(['deuz:mem:rec:a1']);
  });

  it('reads a single index set directly when the scope pins one field', async () => {
    const { client, stores } = await seeded();

    const hits = await stores.memory.search({ scope: { chatId: 'chat-1' }, topK: 10 });

    expect(ids(hits).sort()).toEqual(['a1', 'b1']);
    expect(commandNames(client)).toEqual(['sMembers', 'mGet']);
    expect(client.calls[0]!.args[0]).toBe('deuz:mem:ix:chat:chat-1');
  });

  it('falls back to the all index when the query scope pins nothing', async () => {
    const { client, stores } = await seeded();

    const hits = await stores.memory.search({ scope: {}, topK: 10 });

    expect(ids(hits).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(client.calls[0]).toEqual({ command: 'sMembers', args: ['deuz:mem:ix:all'] });
  });

  it('answers an empty scope value with no round-trip to the records', async () => {
    const { client, stores } = await seeded();

    expect(await stores.memory.search({ scope: { userId: 'nobody' }, topK: 10 })).toEqual([]);
    // The index set does not exist, so there is nothing to mGet.
    expect(commandNames(client)).toEqual(['sMembers']);
  });
});

// ===================================================================
// Index maintenance
// ===================================================================

describe('createRedisStores — index maintenance', () => {
  it('moves membership when an upsert changes the record scope', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([memoryRecord('m1', { scope: { userId: 'user-a' } })]);

    await stores.memory.upsert([memoryRecord('m1', { scope: { userId: 'user-b' } })]);

    // Emptied → the key is gone, not left holding a stale id.
    expect(client.sets.has('deuz:mem:ix:user:user-a')).toBe(false);
    expect([...client.sets.get('deuz:mem:ix:user:user-b')!]).toEqual(['m1']);
    expect(await stores.memory.search({ scope: { userId: 'user-a' }, topK: 5 })).toEqual([]);
    expect(ids(await stores.memory.search({ scope: { userId: 'user-b' }, topK: 5 }))).toEqual([
      'm1',
    ]);
  });

  it('keeps the memberships an upsert does not touch', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([
      memoryRecord('m1', { scope: { userId: 'user-a', chatId: 'chat-1' } }),
    ]);

    await stores.memory.upsert([
      memoryRecord('m1', { scope: { userId: 'user-a', chatId: 'chat-2' }, text: 'moved chat' }),
    ]);

    expect([...client.sets.get('deuz:mem:ix:user:user-a')!]).toEqual(['m1']);
    expect(client.sets.has('deuz:mem:ix:chat:chat-1')).toBe(false);
    expect([...client.sets.get('deuz:mem:ix:chat:chat-2')!]).toEqual(['m1']);
    expect((await stores.memory.get('m1'))!.text).toBe('moved chat');
  });

  it('re-points the hash index when the content hash changes', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([memoryRecord('m1', { hash: 'h1' })]);

    await stores.memory.upsert([memoryRecord('m1', { hash: 'h2' })]);

    expect(client.sets.has('deuz:mem:hash:h1')).toBe(false);
    expect([...client.sets.get('deuz:mem:hash:h2')!]).toEqual(['m1']);
    expect(await stores.memory.findByHash!(['h1'], { userId: 'user-a' })).toEqual([]);
    expect(
      (await stores.memory.findByHash!(['h2'], { userId: 'user-a' })).map((r) => r.id),
    ).toEqual(['m1']);
  });

  it('drops the ZSET entry when a TTL is removed, leaving other records alone', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([
      memoryRecord('m1', { expiresAt: T0 + 1_000 }),
      memoryRecord('m2', { expiresAt: T0 + 2_000 }),
    ]);

    await stores.memory.upsert([memoryRecord('m1')]); // same record, no expiresAt

    expect([...client.zsets.get('deuz:mem:expiry')!.keys()]).toEqual(['m2']);
  });

  it('update() goes through the same reconciliation as upsert', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([memoryRecord('m1', { hash: 'h1' })]);

    await stores.memory.update!('m1', { hash: 'h2', expiresAt: T0 + 10 });

    expect(client.sets.has('deuz:mem:hash:h1')).toBe(false);
    expect([...client.sets.get('deuz:mem:hash:h2')!]).toEqual(['m1']);
    expect(client.zsets.get('deuz:mem:expiry')!.get('m1')).toBe(T0 + 10);
    expect((await stores.memory.get('m1'))!.text).toBe('fact m1'); // patch, not replace
  });

  it('delete clears every membership, the hash set, the ZSET entry and the record', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([memoryRecord('m1', { hash: 'h1', expiresAt: T0 + 1 })]);

    await stores.memory.delete(['m1']);

    expect(client.keys()).toEqual([]); // nothing at all is left behind
  });

  it('delete of an unknown id still sweeps the id-keyed leftovers of a crashed write', async () => {
    const { client, stores } = pack();
    // Exactly the shape the module note on MULTI describes: index entries whose
    // record never landed.
    await client.sAdd('deuz:mem:ix:all', 'ghost');
    await client.zAdd('deuz:mem:expiry', { score: T0, value: 'ghost' });

    await stores.memory.delete(['ghost']);

    expect(client.keys()).toEqual([]);
  });

  it('skips an orphan index id instead of failing the scan', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([memoryRecord('m1', { scope: { userId: 'user-a' } })]);
    await client.sAdd('deuz:mem:ix:user:user-a', 'ghost');

    expect(ids(await stores.memory.search({ scope: { userId: 'user-a' }, topK: 10 }))).toEqual([
      'm1',
    ]);
    expect((await stores.memory.list({ userId: 'user-a' })).map((r) => r.id)).toEqual(['m1']);
  });
});

// ===================================================================
// Ranking
// ===================================================================

describe('createRedisStores — ranking', () => {
  it('ranks by cosine over the inline embeddings and honours topK', async () => {
    const { stores } = pack();
    await stores.memory.upsert([
      memoryRecord('far', { embedding: [0, 0, 1] }),
      memoryRecord('near', { embedding: [1, 0, 0] }),
      memoryRecord('mid', { embedding: [0.6, 0.8, 0] }),
    ]);

    const hits = await stores.memory.search({
      scope: { userId: 'user-a' },
      embedding: [1, 0, 0],
      topK: 2,
    });

    expect(ids(hits)).toEqual(['near', 'mid']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('greps substrings when the query has no embedding, dropping non-matches', async () => {
    const { stores } = pack();
    await stores.memory.upsert([
      memoryRecord('city', { text: 'the user lives in Istanbul' }),
      memoryRecord('drink', { text: 'the user drinks coffee' }),
    ]);

    const hits = await stores.memory.search({
      scope: { userId: 'user-a' },
      text: 'ISTANBUL',
      topK: 5,
    });

    expect(ids(hits)).toEqual(['city']); // case-insensitive, non-matches dropped
  });

  it('answers a point-in-time (asOf) query bi-temporally', async () => {
    const { stores } = pack();
    await stores.memory.upsert([
      memoryRecord('old', { validAt: T0, invalidAt: T0 + 100 }),
      memoryRecord('new', { validAt: T0 + 100 }),
    ]);

    // Now: only the fact that has not been superseded.
    expect(ids(await stores.memory.search({ scope: { userId: 'user-a' }, topK: 5 }))).toEqual([
      'new',
    ]);
    // Back then: the superseded fact was still true, the new one not yet.
    expect(
      ids(await stores.memory.search({ scope: { userId: 'user-a' }, asOf: T0 + 50, topK: 5 })),
    ).toEqual(['old']);
  });
});

// ===================================================================
// TTL sweep
// ===================================================================

describe('createRedisStores — sweepExpiredMemories', () => {
  it('deletes everything due at or before `now` and reports the count', async () => {
    const { client, stores } = pack();
    await stores.memory.upsert([
      memoryRecord('forever'),
      memoryRecord('fresh', { expiresAt: T0 + 10_000 }),
      memoryRecord('dead-1', { expiresAt: T0 - 1 }),
      memoryRecord('dead-2', { expiresAt: T0 }),
    ]);
    client.calls.length = 0;

    expect(await stores.sweepExpiredMemories(T0)).toBe(2);

    // Scored range over the ZSET — O(expired), not a scan of every record.
    expect(client.calls[0]).toEqual({
      command: 'zRangeByScore',
      args: ['deuz:mem:expiry', '-inf', T0],
    });
    expect(await stores.memory.get('dead-1')).toBeNull();
    expect(await stores.memory.get('dead-2')).toBeNull();
    expect(await stores.memory.get('fresh')).not.toBeNull();
    expect(await stores.memory.get('forever')).not.toBeNull();
    expect([...client.zsets.get('deuz:mem:expiry')!.keys()]).toEqual(['fresh']);
    expect(await stores.sweepExpiredMemories(T0)).toBe(0);
  });

  it('clears an orphan ZSET entry without counting it as a deletion', async () => {
    const { client, stores } = pack();
    await client.zAdd('deuz:mem:expiry', { score: T0 - 1, value: 'ghost' });

    expect(await stores.sweepExpiredMemories(T0)).toBe(0); // nothing real was removed
    expect(client.zsets.has('deuz:mem:expiry')).toBe(false); // …but the orphan is gone
  });

  it('defaults `now` to the host clock', async () => {
    const { stores } = pack();
    await stores.memory.upsert([memoryRecord('ancient', { expiresAt: 1 })]);

    expect(await stores.sweepExpiredMemories()).toBe(1);
  });
});

// ===================================================================
// Chats + sessions
// ===================================================================

describe('createRedisStores — chats', () => {
  it('stores a chat under chat:rec + chat:ix and round-trips it', async () => {
    const { client, stores } = pack();

    await stores.chats.saveChat(chatRecord('c1', 'hello'));

    expect(client.keys()).toEqual(['deuz:chat:ix', 'deuz:chat:rec:c1']);
    expect([...client.sets.get('deuz:chat:ix')!]).toEqual(['c1']);
    expect((await stores.chats.loadChat('c1'))!.messages[0]!.content).toBe('hello');
    expect(await stores.chats.loadChat('missing')).toBeUndefined();
  });

  it('filters listChats client-side, in one mGet (JSONL-store parity)', async () => {
    const { client, stores } = pack();
    await stores.chats.saveChat({ ...chatRecord('c1', 'a'), scope: { userId: 'user-a' } });
    await stores.chats.saveChat({ ...chatRecord('c2', 'b'), scope: { userId: 'user-b' } });
    client.calls.length = 0;

    expect(await stores.chats.listChats({ userId: 'user-a' })).toEqual(['c1']);
    expect(commandNames(client)).toEqual(['sMembers', 'mGet']);
    // No scope → the index alone answers, with no record read at all.
    client.calls.length = 0;
    expect([...(await stores.chats.listChats())].sort()).toEqual(['c1', 'c2']);
    expect(commandNames(client)).toEqual(['sMembers']);
  });

  it('deleteChat drops the record and its index entry', async () => {
    const { client, stores } = pack();
    await stores.chats.saveChat(chatRecord('c1', 'hello'));

    await stores.chats.deleteChat('c1');

    expect(client.keys()).toEqual([]);
    expect(await stores.chats.loadChat('c1')).toBeUndefined();
  });
});

describe('createRedisStores — sessions', () => {
  it('stores a checkpoint under sess:rec + sess:ix and round-trips it', async () => {
    const { client, stores } = pack();

    await stores.sessions.save(checkpoint('run-1'));

    expect(client.keys()).toEqual(['deuz:sess:ix', 'deuz:sess:rec:run-1']);
    const loaded = await stores.sessions.load('run-1');
    expect(loaded!.stepId).toBe('run-1#0');
    expect(loaded!.usage.totalTokens).toBe(12);
    expect(await stores.sessions.list()).toEqual(['run-1']);
  });

  it('delete drops the record and its index entry', async () => {
    const { client, stores } = pack();
    await stores.sessions.save(checkpoint('run-1'));
    await stores.sessions.save(checkpoint('run-2'));

    await stores.sessions.delete('run-1');

    expect(await stores.sessions.load('run-1')).toBeUndefined();
    expect(await stores.sessions.list()).toEqual(['run-2']);
    expect(client.keys()).toEqual(['deuz:sess:ix', 'deuz:sess:rec:run-2']);
  });
});

// ===================================================================
// Connection lifecycle
// ===================================================================

/** Re-import the module under a mocked `redis`, so the lazy import resolves to a fake. */
async function withPeer(
  factory: () => Record<string, unknown>,
): Promise<(options: { url: string }) => RedisStores> {
  vi.doMock('redis', factory);
  vi.resetModules();
  const mod = await import('../src/node/store-redis');
  return mod.createRedisStores;
}

afterEach(() => {
  vi.doUnmock('redis');
  vi.resetModules();
});

describe('createRedisStores — connection lifecycle', () => {
  it('never quits an INJECTED client', async () => {
    const { client, stores } = pack();
    await stores.sessions.save(checkpoint('run-1'));

    await stores.close();

    expect(client.stats.quit).toBe(0);
    // The connection is the caller's, so the pack keeps working after close().
    expect(await stores.sessions.list()).toEqual(['run-1']);
  });

  it('opens the peer lazily, ONCE, and quits that client on close', async () => {
    const client = createFakeRedis();
    const urls: string[] = [];
    const create = await withPeer(() => ({
      createClient: (options: { url: string }) => {
        urls.push(options.url);
        return client;
      },
    }));

    const stores = create({ url: 'redis://localhost:6379' });
    expect(urls).toEqual([]); // construction touches nothing
    expect(client.stats.connect).toBe(0);

    await stores.memory.upsert([memoryRecord('m1')]);
    await stores.chats.saveChat(chatRecord('c1', 'hello'));
    expect(urls).toEqual(['redis://localhost:6379']); // one client for the pack
    expect(client.stats.connect).toBe(1);

    await stores.close();
    expect(client.stats.quit).toBe(1);
  });

  it('reports an actionable install error when the peer is missing', async () => {
    // Forced rather than relying on the host: this must also hold on a machine
    // that DOES have `redis` installed.
    const create = await withPeer(() => {
      throw new Error("Cannot find package 'redis'");
    });
    const stores = create({ url: 'redis://localhost:6379' });

    await expect(stores.memory.list({ userId: 'user-a' })).rejects.toThrow(
      /optional peer `redis` \(node-redis v4 or v5\).*npm i redis/s,
    );
    // Every seam funnels through the same accessor, so the message is the same
    // whichever one the caller reached for first.
    await expect(stores.chats.loadChat('c1')).rejects.toThrow(/npm i redis/);
    await expect(stores.sessions.list()).rejects.toThrow(/createRedisStores\(\{ client \}\)/);
    // close() after a failed connect is quiet — there is nothing to release.
    await expect(stores.close()).resolves.toBeUndefined();
  });

  it('retries the connection after a failed connect instead of replaying it', async () => {
    const client = createFakeRedis();
    client.failConnect(1);
    const create = await withPeer(() => ({ createClient: () => client }));
    const stores = create({ url: 'redis://localhost:6379' });

    await expect(stores.sessions.list()).rejects.toThrow('ECONNREFUSED');

    // A poisoned promise would replay the same rejection forever.
    expect(await stores.sessions.list()).toEqual([]);
    expect(client.stats.connect).toBe(2);
  });
});

// ===================================================================
// The shared contracts
// ===================================================================

assertMemoryStoreContract('redis (fake client)', async () => {
  const stores = createRedisStores({ client: createFakeRedis() });
  return { store: stores.memory, cleanup: () => stores.close() };
});

assertChatStoreContract('redis (fake client)', async () => {
  const stores = createRedisStores({ client: createFakeRedis() });
  return { store: stores.chats, cleanup: () => stores.close() };
});

assertSessionStoreContract('redis (fake client)', async () => {
  const stores = createRedisStores({ client: createFakeRedis() });
  return { store: stores.sessions, cleanup: () => stores.close() };
});
