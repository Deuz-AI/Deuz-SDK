/**
 * store-conformance.ts — the SHARED contract suites every store backend runs.
 *
 * 2.0 ships four implementations of the same three seams (in-memory, SQLite,
 * Redis, Postgres). Copying assertions per backend guarantees they drift, and
 * the drift is invisible until a user swaps stores in production. So the
 * behaviour a `MemoryStore` / `ChatStore` / `SessionStore` OWES its callers is
 * written down exactly once, here, and each backend's test file calls it:
 *
 * ```ts
 * assertMemoryStoreContract('sqlite', async () => {
 *   const pack = createSqliteStores({ path: ':memory:' });
 *   return { store: pack.memory, cleanup: () => pack.close() };
 * });
 * ```
 *
 * `make()` is called FRESH for every `it`, so no test can see another's rows;
 * `cleanup` (file handle, connection, container) always runs, even on failure.
 *
 * What is deliberately NOT asserted: anything a backend may legitimately do
 * differently. `search` OWNS its ranking (cosine, BM25, FTS5, grep), so the
 * suite pins the ORDER of clearly-separated candidates, never a score value;
 * `MemoryRecord.embedding` is documented as inline-for-the-in-memory-store, so
 * `get` is never asked to return one. Optional methods (`findByHash`,
 * `deleteExpired`, `deleteChat`, `listChats`, `SessionStore.delete`/`list`) skip
 * when absent instead of failing — a pre-2.0 store stays valid — but are held to
 * the full contract when present.
 */
import { describe, it, expect } from 'vitest';
import type { Message, Part, ImagePart } from '../../src/types/message';
import type { Usage } from '../../src/types/usage';
import type { AgentCheckpoint, SessionStore } from '../../src/types/session';
import type { MemoryRecord, MemoryScope, MemoryStore } from '../../src/memory';
import type { ChatRecord, ChatStore } from '../../src/chat';

/** What a backend hands the suite: the store under test plus its teardown. */
export interface StoreHarness<TStore> {
  store: TStore;
  cleanup?: () => Promise<void>;
}

/** Fixed epoch — every timestamp in the suite is derived from it (no ambient clock). */
const T0 = 1_700_000_000_000;

const SCOPE_A: MemoryScope = { userId: 'user-a', chatId: 'chat-1' };
const SCOPE_A2: MemoryScope = { userId: 'user-a', chatId: 'chat-2' };
const SCOPE_B: MemoryScope = { userId: 'user-b', chatId: 'chat-1' };

function memoryRecord(
  id: string,
  text: string,
  scope: MemoryScope,
  extra: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    text,
    hash: `hash-${id}`,
    kind: 'semantic',
    scope,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

/** Ids in result order — what the suite asserts instead of raw scores. */
function ids(hits: { record: MemoryRecord }[]): string[] {
  return hits.map((h) => h.record.id);
}

function emptyUsage(): Usage {
  return {
    inputTokens: 120,
    outputTokens: 34,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 154,
  };
}

/** Bytes chosen to break a naive latin1/utf8 round-trip if one is attempted. */
const BINARY = new Uint8Array([0, 1, 2, 127, 128, 253, 254, 255]);

function firstPart(messages: Message[], index: number): Part {
  const content = messages[index]?.content;
  if (!Array.isArray(content)) throw new Error(`message ${index} lost its Part[] content`);
  const part = content[0];
  if (!part) throw new Error(`message ${index} lost its first part`);
  return part;
}

// ===================================================================
// MemoryStore
// ===================================================================

/**
 * Run the `MemoryStore` contract against a backend. Covers the round-trip,
 * scope isolation (including the rule that an UNSET query scope field does not
 * filter), both ranking modes of `search`, `list`, `delete`, the soft-delete
 * (`invalidAt`) exclusion, and the two optional 2.0 fast paths.
 */
export function assertMemoryStoreContract(
  name: string,
  make: () => Promise<StoreHarness<MemoryStore>>,
): void {
  const withStore = async (fn: (store: MemoryStore) => Promise<void>): Promise<void> => {
    const { store, cleanup } = await make();
    try {
      await fn(store);
    } finally {
      await cleanup?.();
    }
  };

  describe(`MemoryStore contract: ${name}`, () => {
    it('upsert + get round-trips a record', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('m1', 'the user prefers dark mode', SCOPE_A, {
            kind: 'semantic',
            importance: 0.75,
            metadata: { tags: ['ui', 'preference'], source: 'chat' },
            embeddingModelId: 'text-embedding-3-small',
            validAt: T0,
          }),
        ]);

        const got = await store.get('m1');
        expect(got).not.toBeNull();
        expect(got!.id).toBe('m1');
        expect(got!.text).toBe('the user prefers dark mode');
        expect(got!.hash).toBe('hash-m1');
        expect(got!.kind).toBe('semantic');
        expect(got!.scope.userId).toBe('user-a');
        expect(got!.scope.chatId).toBe('chat-1');
        expect(got!.importance).toBeCloseTo(0.75, 5);
        expect(got!.metadata?.tags).toEqual(['ui', 'preference']);
        expect(got!.embeddingModelId).toBe('text-embedding-3-small');
        expect(got!.createdAt).toBe(T0);
        expect(got!.updatedAt).toBe(T0);
      });
    });

    it('get returns null for an unknown id and for a scope mismatch', async () => {
      await withStore(async (store) => {
        await store.upsert([memoryRecord('m1', 'scoped fact', SCOPE_A)]);

        expect(await store.get('does-not-exist')).toBeNull();
        expect(await store.get('m1', SCOPE_B)).toBeNull();
        // A PARTIAL scope still matches — unset fields do not filter.
        expect(await store.get('m1', { userId: 'user-a' })).not.toBeNull();
      });
    });

    it('upsert of an existing id replaces it (no duplicate rows)', async () => {
      await withStore(async (store) => {
        await store.upsert([memoryRecord('m1', 'first version', SCOPE_A)]);
        await store.upsert([
          memoryRecord('m1', 'second version', SCOPE_A, { updatedAt: T0 + 1_000 }),
        ]);

        const got = await store.get('m1');
        expect(got!.text).toBe('second version');
        expect(got!.updatedAt).toBe(T0 + 1_000);
        expect(await store.list(SCOPE_A)).toHaveLength(1);
      });
    });

    it('search isolates scopes and ignores unset query scope fields', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('a1', 'alpha', SCOPE_A),
          memoryRecord('a2', 'alpha', SCOPE_A2),
          memoryRecord('b1', 'alpha', SCOPE_B),
        ]);

        const sameUser = await store.search({ scope: { userId: 'user-a' }, topK: 10 });
        expect(ids(sameUser).sort()).toEqual(['a1', 'a2']);

        const sameChat = await store.search({ scope: { chatId: 'chat-1' }, topK: 10 });
        expect(ids(sameChat).sort()).toEqual(['a1', 'b1']);

        const both = await store.search({ scope: SCOPE_A, topK: 10 });
        expect(ids(both)).toEqual(['a1']);
      });
    });

    it('search ranks by cosine similarity when the query carries an embedding', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('far', 'orthogonal fact', SCOPE_A, { embedding: [0, 0, 1] }),
          memoryRecord('near', 'exact fact', SCOPE_A, { embedding: [1, 0, 0] }),
          memoryRecord('mid', 'related fact', SCOPE_A, { embedding: [0.6, 0.8, 0] }),
        ]);

        const hits = await store.search({ scope: SCOPE_A, embedding: [1, 0, 0], topK: 3 });
        expect(ids(hits)).toEqual(['near', 'mid', 'far']);
        expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
        expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
      });
    });

    it('search honors topK', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('near', 'a', SCOPE_A, { embedding: [1, 0, 0] }),
          memoryRecord('mid', 'b', SCOPE_A, { embedding: [0.6, 0.8, 0] }),
          memoryRecord('far', 'c', SCOPE_A, { embedding: [0, 0, 1] }),
        ]);

        const hits = await store.search({ scope: SCOPE_A, embedding: [1, 0, 0], topK: 2 });
        expect(hits).toHaveLength(2);
        expect(hits[0]!.record.id).toBe('near');
      });
    });

    it('search matches on text when the query carries no embedding', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('city', 'the user lives in Istanbul', SCOPE_A),
          memoryRecord('drink', 'the user drinks coffee', SCOPE_A),
        ]);

        const hits = await store.search({ scope: SCOPE_A, text: 'Istanbul', topK: 5 });
        expect(hits.length).toBeGreaterThanOrEqual(1);
        // Ranking is the backend's own (grep / BM25 / FTS5); only the WINNER is
        // contractual — a backend may or may not return the non-matching row.
        expect(hits[0]!.record.id).toBe('city');
        expect(hits[0]!.score).toBeGreaterThan(0);
      });
    });

    it('search excludes soft-deleted (invalidAt) records', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('live', 'still true', SCOPE_A, { embedding: [1, 0, 0] }),
          memoryRecord('stale', 'superseded', SCOPE_A, {
            embedding: [1, 0, 0],
            invalidAt: T0 + 500,
          }),
        ]);

        const hits = await store.search({ scope: SCOPE_A, embedding: [1, 0, 0], topK: 10 });
        expect(ids(hits)).toEqual(['live']);
      });
    });

    it('list returns the scope and honors kind + limit', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('s1', 'semantic one', SCOPE_A),
          memoryRecord('s2', 'semantic two', SCOPE_A),
          memoryRecord('e1', 'episodic one', SCOPE_A, { kind: 'episodic' }),
          memoryRecord('other', 'different owner', SCOPE_B),
        ]);

        expect((await store.list(SCOPE_A)).map((r) => r.id).sort()).toEqual(['e1', 's1', 's2']);
        expect((await store.list(SCOPE_A, { kind: 'episodic' })).map((r) => r.id)).toEqual(['e1']);
        expect(await store.list(SCOPE_A, { limit: 2 })).toHaveLength(2);
        expect((await store.list(SCOPE_B)).map((r) => r.id)).toEqual(['other']);
        expect(await store.list({ userId: 'nobody' })).toEqual([]);
      });
    });

    it('delete removes the named records and leaves the rest', async () => {
      await withStore(async (store) => {
        await store.upsert([
          memoryRecord('m1', 'one', SCOPE_A),
          memoryRecord('m2', 'two', SCOPE_A),
        ]);

        await store.delete(['m1', 'never-existed']); // unknown ids are ignored
        expect(await store.get('m1')).toBeNull();
        expect((await store.list(SCOPE_A)).map((r) => r.id)).toEqual(['m2']);
      });
    });

    it('findByHash resolves hashes within a scope (optional fast path)', async (ctx) => {
      await withStore(async (store) => {
        if (!store.findByHash) return ctx.skip();
        await store.upsert([
          memoryRecord('m1', 'dedupe me', SCOPE_A, { hash: 'h-shared' }),
          memoryRecord('m2', 'something else', SCOPE_A, { hash: 'h-other' }),
          // SAME hash, DIFFERENT owner — must not leak across the scope boundary.
          memoryRecord('b1', 'dedupe me', SCOPE_B, { hash: 'h-shared' }),
        ]);

        const found = await store.findByHash(['h-shared', 'h-absent'], SCOPE_A);
        expect(found.map((r) => r.id)).toEqual(['m1']);
        expect(found[0]!.hash).toBe('h-shared');

        expect(await store.findByHash([], SCOPE_A)).toEqual([]);

        const both = await store.findByHash(['h-shared', 'h-other'], SCOPE_A);
        expect(both.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
      });
    });

    it('deleteExpired sweeps records past their TTL (optional fast path)', async (ctx) => {
      await withStore(async (store) => {
        if (!store.deleteExpired) return ctx.skip();
        await store.upsert([
          memoryRecord('forever', 'no ttl', SCOPE_A),
          memoryRecord('fresh', 'not due yet', SCOPE_A, { expiresAt: T0 + 10_000 }),
          memoryRecord('dead-a', 'past due', SCOPE_A, { expiresAt: T0 - 1 }),
          memoryRecord('dead-b', 'past due elsewhere', SCOPE_B, { expiresAt: T0 - 1 }),
        ]);

        // Scoped sweep touches only its own scope.
        expect(await store.deleteExpired(T0, SCOPE_A)).toBe(1);
        expect(await store.get('dead-a')).toBeNull();
        expect(await store.get('dead-b')).not.toBeNull();
        expect(await store.get('fresh')).not.toBeNull();
        expect(await store.get('forever')).not.toBeNull();

        // Unscoped sweep takes the rest; a second pass finds nothing left.
        expect(await store.deleteExpired(T0)).toBe(1);
        expect(await store.get('dead-b')).toBeNull();
        expect(await store.deleteExpired(T0)).toBe(0);
      });
    });
  });
}

// ===================================================================
// ChatStore
// ===================================================================

function chatRecord(chatId: string, scope: MemoryScope, messages: Message[]): ChatRecord {
  return { chatId, scope, messages, updatedAt: T0 };
}

/**
 * Run the `ChatStore` contract against a backend: save/load round-trip,
 * last-write-wins per `chatId`, the optional delete/list methods, and the
 * BINARY-SAFE requirement — a persistent backend must round-trip `Uint8Array`s
 * anywhere in the message tree (that is what `serializeChatRecord` /
 * `deserializeChatRecord` in `src/chat.ts` exist for). Plain `JSON.stringify`
 * decays bytes into `{ "0": 1, … }` objects the adapters cannot send, so this
 * is a correctness bug that only shows up on the NEXT turn of a resumed chat.
 */
export function assertChatStoreContract(
  name: string,
  make: () => Promise<StoreHarness<ChatStore>>,
): void {
  const withStore = async (fn: (store: ChatStore) => Promise<void>): Promise<void> => {
    const { store, cleanup } = await make();
    try {
      await fn(store);
    } finally {
      await cleanup?.();
    }
  };

  describe(`ChatStore contract: ${name}`, () => {
    it('saveChat + loadChat round-trips the record', async () => {
      await withStore(async (store) => {
        await store.saveChat(
          chatRecord('c1', SCOPE_A, [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
          ]),
        );

        const loaded = await store.loadChat('c1');
        expect(loaded).toBeDefined();
        expect(loaded!.chatId).toBe('c1');
        expect(loaded!.scope.userId).toBe('user-a');
        expect(loaded!.scope.chatId).toBe('chat-1');
        expect(loaded!.updatedAt).toBe(T0);
        expect(loaded!.messages).toHaveLength(2);
        expect(loaded!.messages[0]!.content).toBe('hello');
        expect(firstPart(loaded!.messages, 1)).toEqual({ type: 'text', text: 'hi there' });
      });
    });

    it('loadChat returns undefined for an unknown chatId', async () => {
      await withStore(async (store) => {
        expect(await store.loadChat('never-saved')).toBeUndefined();
      });
    });

    it('saveChat overwrites the same chatId (last write wins) and keeps parentId', async () => {
      await withStore(async (store) => {
        await store.saveChat(chatRecord('c1', SCOPE_A, [{ role: 'user', content: 'first' }]));
        await store.saveChat({
          ...chatRecord('c1', SCOPE_A, [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
          ]),
          parentId: 'c0',
          updatedAt: T0 + 5_000,
        });

        const loaded = await store.loadChat('c1');
        expect(loaded!.messages).toHaveLength(2);
        expect(loaded!.parentId).toBe('c0');
        expect(loaded!.updatedAt).toBe(T0 + 5_000);
      });
    });

    it('round-trips binary parts as real Uint8Arrays, at any depth', async () => {
      await withStore(async (store) => {
        await store.saveChat(
          chatRecord('c1', SCOPE_A, [
            {
              role: 'user',
              content: [{ type: 'image', image: BINARY, mediaType: 'image/png' }],
            },
            {
              role: 'tool',
              content: [
                { type: 'tool_result', toolUseId: 't1', result: { nested: { blob: BINARY } } },
              ],
            },
          ]),
        );

        const loaded = await store.loadChat('c1');
        const image = firstPart(loaded!.messages, 0) as ImagePart;
        expect(image.image).toBeInstanceOf(Uint8Array);
        expect([...(image.image as Uint8Array)]).toEqual([...BINARY]);
        expect(image.mediaType).toBe('image/png');

        const toolResult = firstPart(loaded!.messages, 1) as {
          type: 'tool_result';
          result: { nested: { blob: Uint8Array } };
        };
        expect(toolResult.result.nested.blob).toBeInstanceOf(Uint8Array);
        expect([...toolResult.result.nested.blob]).toEqual([...BINARY]);
      });
    });

    it('deleteChat removes a chat (optional)', async (ctx) => {
      await withStore(async (store) => {
        if (!store.deleteChat) return ctx.skip();
        await store.saveChat(chatRecord('c1', SCOPE_A, [{ role: 'user', content: 'x' }]));
        await store.saveChat(chatRecord('c2', SCOPE_A, [{ role: 'user', content: 'y' }]));

        await store.deleteChat('c1');
        expect(await store.loadChat('c1')).toBeUndefined();
        expect(await store.loadChat('c2')).toBeDefined();
      });
    });

    it('listChats enumerates ids and filters by scope (optional)', async (ctx) => {
      await withStore(async (store) => {
        if (!store.listChats) return ctx.skip();
        await store.saveChat(chatRecord('c1', SCOPE_A, [{ role: 'user', content: 'x' }]));
        await store.saveChat(chatRecord('c2', SCOPE_A2, [{ role: 'user', content: 'y' }]));
        await store.saveChat(chatRecord('c3', SCOPE_B, [{ role: 'user', content: 'z' }]));

        expect([...(await store.listChats())].sort()).toEqual(['c1', 'c2', 'c3']);
        // Unset scope fields do not filter — same rule as MemoryStore.
        expect([...(await store.listChats({ userId: 'user-a' }))].sort()).toEqual(['c1', 'c2']);
        expect([...(await store.listChats(SCOPE_B))]).toEqual(['c3']);
        expect([...(await store.listChats({ userId: 'nobody' }))]).toEqual([]);
      });
    });
  });
}

// ===================================================================
// SessionStore
// ===================================================================

function checkpoint(runId: string, extra: Partial<AgentCheckpoint> = {}): AgentCheckpoint {
  return {
    version: 1,
    runId,
    stepId: `${runId}#0`,
    stepIndex: 0,
    status: 'running',
    messages: [{ role: 'user', content: 'do the thing' }],
    usage: emptyUsage(),
    createdAt: T0,
    ...extra,
  };
}

/**
 * Run the `SessionStore` contract against a backend: checkpoint round-trip
 * (including the 2.0 additive `handoff` overlay and a pre-2.0 checkpoint that
 * carries none), last-write-wins per `runId`, binary safety, and the optional
 * `delete`/`list` tooling methods.
 */
export function assertSessionStoreContract(
  name: string,
  make: () => Promise<StoreHarness<SessionStore>>,
): void {
  const withStore = async (fn: (store: SessionStore) => Promise<void>): Promise<void> => {
    const { store, cleanup } = await make();
    try {
      await fn(store);
    } finally {
      await cleanup?.();
    }
  };

  describe(`SessionStore contract: ${name}`, () => {
    it('save + load round-trips a full checkpoint', async () => {
      await withStore(async (store) => {
        await store.save(
          checkpoint('run-1', {
            stepId: 'run-1#3',
            stepIndex: 3,
            status: 'suspended',
            messages: [
              { role: 'user', content: 'do the thing' },
              { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
            ],
            pendingApprovals: [
              { approvalId: 'a1', toolCallId: 'a1', toolName: 'deploy', input: { env: 'prod' } },
            ],
            agentPath: ['researcher'],
            handoff: { to: 'specialist', count: 2 },
            createdAt: T0 + 42,
          }),
        );

        const loaded = await store.load('run-1');
        expect(loaded).toBeDefined();
        expect(loaded!.version).toBe(1);
        expect(loaded!.runId).toBe('run-1');
        expect(loaded!.stepId).toBe('run-1#3');
        expect(loaded!.stepIndex).toBe(3);
        expect(loaded!.status).toBe('suspended');
        expect(loaded!.messages).toHaveLength(2);
        expect(firstPart(loaded!.messages, 1)).toEqual({ type: 'text', text: 'on it' });
        expect(loaded!.usage.totalTokens).toBe(154);
        expect(loaded!.pendingApprovals).toHaveLength(1);
        expect(loaded!.pendingApprovals![0]!.toolName).toBe('deploy');
        expect(loaded!.pendingApprovals![0]!.input).toEqual({ env: 'prod' });
        expect(loaded!.agentPath).toEqual(['researcher']);
        expect(loaded!.handoff).toEqual({ to: 'specialist', count: 2 });
        expect(loaded!.createdAt).toBe(T0 + 42);
      });
    });

    it('loads a checkpoint that predates the 2.0 optional fields unchanged', async () => {
      await withStore(async (store) => {
        await store.save(checkpoint('run-old'));

        const loaded = await store.load('run-old');
        expect(loaded).toBeDefined();
        expect(loaded!.handoff).toBeUndefined();
        expect(loaded!.pendingApprovals).toBeUndefined();
        expect(loaded!.agentPath).toBeUndefined();
      });
    });

    it('load returns undefined for an unknown runId', async () => {
      await withStore(async (store) => {
        expect(await store.load('never-saved')).toBeUndefined();
      });
    });

    it('save overwrites the same runId (latest boundary wins)', async () => {
      await withStore(async (store) => {
        await store.save(checkpoint('run-1'));
        await store.save(
          checkpoint('run-1', { stepId: 'run-1#1', stepIndex: 1, status: 'completed' }),
        );

        const loaded = await store.load('run-1');
        expect(loaded!.stepIndex).toBe(1);
        expect(loaded!.status).toBe('completed');
      });
    });

    it('round-trips binary parts as real Uint8Arrays', async () => {
      await withStore(async (store) => {
        await store.save(
          checkpoint('run-1', {
            messages: [
              { role: 'user', content: [{ type: 'image', image: BINARY, mediaType: 'image/png' }] },
            ],
          }),
        );

        const loaded = await store.load('run-1');
        const image = firstPart(loaded!.messages, 0) as ImagePart;
        expect(image.image).toBeInstanceOf(Uint8Array);
        expect([...(image.image as Uint8Array)]).toEqual([...BINARY]);
      });
    });

    it('list enumerates stored runIds (optional)', async (ctx) => {
      await withStore(async (store) => {
        if (!store.list) return ctx.skip();
        await store.save(checkpoint('run-1'));
        await store.save(checkpoint('run-2'));

        expect([...(await store.list())].sort()).toEqual(['run-1', 'run-2']);
      });
    });

    it('delete removes a stored run (optional)', async (ctx) => {
      await withStore(async (store) => {
        if (!store.delete) return ctx.skip();
        await store.save(checkpoint('run-1'));
        await store.save(checkpoint('run-2'));

        await store.delete('run-1');
        expect(await store.load('run-1')).toBeUndefined();
        expect(await store.load('run-2')).toBeDefined();
      });
    });
  });
}
