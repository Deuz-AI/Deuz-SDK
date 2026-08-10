/**
 * memory-quality.test.ts — the 2.0 write-quality guarantees of `./memory`:
 * write-time hash dedup on BOTH remember() paths, the TTL sweeper, and the
 * importance/kind/links metadata that now survives extraction → reconciliation
 * → record.
 *
 * The graph half (extractLinks / recall({ expandLinks })) lives in
 * memory-graph.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  remember,
  parseFacts,
  buildExtractionPrompt,
  sweepExpired,
  createInMemoryMemoryStore,
  type MemoryLLM,
  type MemoryMutation,
  type MemoryRecord,
  type MemorySeams,
  type MemoryStore,
} from '../src/memory';

// --- deterministic seam doubles (same shape as memory.test.ts) ---
const fixedClock = { now: () => 1_000_000, setTimeout: (fn: () => void) => (fn(), () => {}) };
const syncHash = async (t: string) => `h:${t}`;

function seams(over: Partial<MemorySeams> = {}): MemorySeams {
  let id = 0;
  return {
    store: createInMemoryMemoryStore(),
    llm: async () => '{"facts":[]}',
    clock: fixedClock,
    generateId: () => `q-${id++}`,
    hashFn: syncHash,
    ...over,
  };
}

/** A pre-2.0 store: the 2.0 optional fast paths simply are not there. */
function legacyStore(): MemoryStore {
  const full = createInMemoryMemoryStore();
  return {
    upsert: (recs) => full.upsert(recs),
    get: (id, scope) => full.get(id, scope),
    search: (query) => full.search(query),
    list: (scope, opts) => full.list(scope, opts),
    delete: (ids) => full.delete(ids),
    update: (id, patch) => full.update!(id, patch),
  };
}

/** Scripted mem0 LLM: extraction prompt → facts, decision prompt → events. */
function scripted(facts: string, decision: string): MemoryLLM {
  return async ({ system }) => (system.includes('extract durable') ? facts : decision);
}

const record = (over: Partial<MemoryRecord> & Pick<MemoryRecord, 'id'>): MemoryRecord => ({
  text: 'text',
  hash: `h:${over.text ?? 'text'}`,
  kind: 'semantic',
  scope: { userId: 'u1' },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const upserted = (muts: MemoryMutation[]): MemoryRecord[] =>
  muts.flatMap((m) => (m.op === 'upsert' ? [m.record] : []));

describe('write-time hash dedup — infer:false path', () => {
  it('collapses duplicate turns INSIDE one batch and mints no id for the loser', async () => {
    const s = seams();
    const muts = await remember(
      [
        { role: 'user', content: 'I only drink dark roast' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'I only drink dark roast' }, // byte-identical repeat
      ],
      { userId: 'u1' },
      s,
      { infer: false },
    );

    expect(upserted(muts).map((r) => r.text)).toEqual(['I only drink dark roast', 'Noted.']);
    // Ids are drawn AFTER the gate — the dropped turn never consumed one.
    expect(upserted(muts).map((r) => r.id)).toEqual(['q-0', 'q-1']);
  });

  it('asks findByHash ONCE for the whole batch and skips what the store already holds', async () => {
    const base = createInMemoryMemoryStore();
    const findByHash = vi.fn(base.findByHash!);
    const s = seams({ store: { ...base, findByHash } });

    const first = await remember([{ role: 'user', content: 'I use vim' }], { userId: 'u1' }, s, {
      infer: false,
    });
    expect(first).toHaveLength(1);

    const second = await remember(
      [
        { role: 'user', content: 'I use vim' }, // already stored
        { role: 'user', content: 'I use tmux' }, // new
      ],
      { userId: 'u1' },
      s,
      { infer: false },
    );
    expect(upserted(second).map((r) => r.text)).toEqual(['I use tmux']);

    // One round-trip per remember() call, carrying every candidate hash.
    expect(findByHash).toHaveBeenCalledTimes(2);
    expect(findByHash.mock.calls[1]![0]).toEqual(['h:I use vim', 'h:I use tmux']);
    expect(findByHash.mock.calls[1]![1]).toEqual({ userId: 'u1' });
    expect(await s.store.list({ userId: 'u1' })).toHaveLength(2);
  });

  it('scopes the dedup: the same text under another owner is still written', async () => {
    const s = seams();
    await remember([{ role: 'user', content: 'likes jazz' }], { userId: 'u1' }, s, {
      infer: false,
    });
    const other = await remember([{ role: 'user', content: 'likes jazz' }], { userId: 'u2' }, s, {
      infer: false,
    });
    expect(other).toHaveLength(1);
  });

  it('a pre-2.0 store (no findByHash) keeps the old write-everything behavior', async () => {
    const s = seams({ store: legacyStore() });
    await remember([{ role: 'user', content: 'I use vim' }], { userId: 'u1' }, s, { infer: false });
    const again = await remember([{ role: 'user', content: 'I use vim' }], { userId: 'u1' }, s, {
      infer: false,
    });
    expect(again).toHaveLength(1); // no full-table scan is attempted
  });
});

describe('write-time hash dedup — infer:true path', () => {
  it('drops the duplicate ADD inside one decision batch (and emits no NOOP for it)', async () => {
    const s = seams({
      llm: scripted(
        '{"facts":["is vegetarian","is vegetarian"]}',
        '{"memory":[{"event":"ADD","text":"is vegetarian"},{"event":"ADD","text":"is vegetarian"}]}',
      ),
    });
    const muts = await remember(
      [{ role: 'user', content: 'I went vegetarian' }],
      { userId: 'u1' },
      s,
    );
    expect(muts).toHaveLength(1);
    expect(muts[0]).toMatchObject({
      op: 'upsert',
      event: 'ADD',
      record: { text: 'is vegetarian' },
    });
  });

  it('drops an ADD whose hash is already in the reconciliation set (no findByHash needed)', async () => {
    const store = legacyStore();
    await store.upsert([record({ id: 'old', text: 'is vegetarian' })]);
    const s = seams({
      store,
      llm: scripted(
        '{"facts":["is vegetarian"]}',
        '{"memory":[{"event":"ADD","text":"is vegetarian"}]}',
      ),
    });

    const muts = await remember(
      [{ role: 'user', content: 'still vegetarian' }],
      { userId: 'u1' },
      s,
    );
    expect(muts).toEqual([]); // dropped outright — NOT recorded as a NOOP
    expect(await store.list({ userId: 'u1' })).toHaveLength(1);
  });

  it('drops an ADD the store reports via findByHash even when search missed it', async () => {
    const base = createInMemoryMemoryStore();
    await base.upsert([record({ id: 'old', text: 'is vegetarian' })]);
    // A store whose ranking cannot see the record (a stale index) — only the
    // hash lookup can catch the duplicate.
    const findByHash = vi.fn(base.findByHash!);
    const s = seams({
      store: { ...base, search: async () => [], findByHash },
      llm: scripted(
        '{"facts":["is vegetarian"]}',
        '{"memory":[{"event":"ADD","text":"is vegetarian"}]}',
      ),
    });

    expect(await remember([{ role: 'user', content: 'x' }], { userId: 'u1' }, s)).toEqual([]);
    expect(findByHash).toHaveBeenCalledWith(['h:is vegetarian'], { userId: 'u1' });
  });

  it('keeps UPDATE/DELETE/NOOP untouched while gating only the ADDs', async () => {
    const store = createInMemoryMemoryStore();
    await store.upsert([record({ id: 'old', text: 'likes meat' })]);
    const s = seams({
      store,
      llm: scripted(
        '{"facts":["likes meat","allergic to nuts","allergic to nuts"]}',
        JSON.stringify({
          memory: [
            { id: '0', event: 'UPDATE', text: 'likes meat', old_memory: 'likes meat' },
            { event: 'ADD', text: 'allergic to nuts' },
            { event: 'ADD', text: 'allergic to nuts' },
          ],
        }),
      ),
    });

    const muts = await remember([{ role: 'user', content: 'nuts!' }], { userId: 'u1' }, s);
    // The UPDATE survives even though its text hashes to an existing record —
    // it is addressed by id, so a hash collision is convergence, not a dupe.
    expect(muts.map((m) => (m.op === 'upsert' ? m.event : m.op))).toEqual(['UPDATE', 'ADD']);
    expect(upserted(muts).map((r) => r.id)).toEqual(['old', 'q-0']);
  });
});

describe('extraction metadata: importance / kind / links', () => {
  it('parseFacts clamps importance to [0,1] and drops non-finite values', () => {
    const facts = parseFacts(
      JSON.stringify({
        facts: [
          { text: 'a', importance: 0.4 },
          { text: 'b', importance: 7 },
          { text: 'c', importance: -3 },
          { text: 'd', importance: Number.NaN },
          { text: 'e', importance: '0.9' },
          { text: 'f' },
        ],
      }),
    );
    expect(facts).toEqual([
      { text: 'a', importance: 0.4 },
      { text: 'b', importance: 1 },
      { text: 'c', importance: 0 },
      { text: 'd' },
      { text: 'e' },
      { text: 'f' },
    ]);
    expect(parseFacts('{"facts":[{"text":"g","importance":1e999}]}')).toEqual([{ text: 'g' }]);
  });

  it('parseFacts validates kind against the four literals and filters links', () => {
    const facts = parseFacts(
      JSON.stringify({
        facts: [
          { text: 'a', kind: 'procedural' },
          { text: 'b', kind: 'long-term' }, // hallucinated → dropped, fact kept
          { text: 'c', links: ['Alice', '  ', 42, 'Bob'] },
          { text: 'd', links: 'Alice' }, // not an array → dropped
          { text: 'e', links: [] },
        ],
      }),
    );
    expect(facts).toEqual([
      { text: 'a', kind: 'procedural' },
      { text: 'b' },
      { text: 'c', links: ['Alice', 'Bob'] },
      { text: 'd' },
      { text: 'e' },
    ]);
  });

  it('parseFacts still accepts the pre-2.0 bare-string shape', () => {
    expect(parseFacts('{"facts":["is vegetarian","likes jazz"]}')).toEqual([
      { text: 'is vegetarian' },
      { text: 'likes jazz' },
    ]);
    expect(parseFacts('```json\n["x"]\n```')).toEqual([{ text: 'x' }]);
  });

  it('buildExtractionPrompt asks for the object shape, and for links only on request', () => {
    const plain = buildExtractionPrompt([{ role: 'user', content: 'hi there' }]);
    expect(plain.system).toContain('extract durable');
    expect(plain.system).toContain('"importance"');
    expect(plain.system).toContain('semantic|episodic|procedural|working');
    expect(plain.system).not.toContain('"links"');

    const linked = buildExtractionPrompt([{ role: 'user', content: 'hi there' }], { links: true });
    expect(linked.system).toContain('"links"');
  });

  it('an exact-text ADD inherits importance/kind/links from the extracted fact', async () => {
    const s = seams({
      llm: scripted(
        '{"facts":[{"text":"loves espresso","importance":0.9,"kind":"procedural","links":["coffee"]}]}',
        '{"memory":[{"event":"ADD","text":"loves espresso"}]}',
      ),
    });
    const muts = await remember([{ role: 'user', content: 'espresso only' }], { userId: 'u1' }, s, {
      links: true,
    });
    expect(upserted(muts)[0]).toMatchObject({
      text: 'loves espresso',
      importance: 0.9,
      kind: 'procedural',
      metadata: { links: ['coffee'] },
    });
  });

  it('a REWRITTEN ADD keeps none of it — matching is exact, never fuzzy', async () => {
    const s = seams({
      llm: scripted(
        '{"facts":[{"text":"loves espresso","importance":0.9,"kind":"procedural","links":["coffee"]}]}',
        '{"memory":[{"event":"ADD","text":"The user loves espresso"}]}',
      ),
    });
    const rec = upserted(
      await remember([{ role: 'user', content: 'espresso only' }], { userId: 'u1' }, s),
    )[0]!;
    expect(rec.text).toBe('The user loves espresso');
    expect(rec.importance).toBeUndefined();
    expect(rec.metadata).toBeUndefined();
    expect(rec.kind).toBe('semantic'); // ctx default, not the fact's
  });

  it('remember({ links: true }) is what puts the links clause in the prompt', async () => {
    const prompts: string[] = [];
    const llm: MemoryLLM = async ({ system }) => {
      prompts.push(system);
      return system.includes('extract durable') ? '{"facts":[]}' : '{"memory":[]}';
    };
    await remember([{ role: 'user', content: 'hi there' }], { userId: 'u1' }, seams({ llm }));
    expect(prompts[0]).not.toContain('"links"');

    await remember([{ role: 'user', content: 'hi there' }], { userId: 'u1' }, seams({ llm }), {
      links: true,
    });
    expect(prompts[1]).toContain('"links"');
  });
});

describe('sweepExpired()', () => {
  it('uses the store fast path when it exists, passing clock.now() and the scope', async () => {
    const deleteExpired = vi.fn(async () => 3);
    const store = { ...createInMemoryMemoryStore(), deleteExpired };
    const list = vi.spyOn(store, 'list');

    expect(await sweepExpired(store, { userId: 'u1' }, fixedClock)).toBe(3);
    expect(deleteExpired).toHaveBeenCalledWith(1_000_000, { userId: 'u1' });
    expect(list).not.toHaveBeenCalled();
  });

  it('falls back to list + filter + delete, and returns how many went', async () => {
    const store = legacyStore();
    await store.upsert([
      record({ id: 'dead-1', text: 'gone', expiresAt: 5 }),
      record({ id: 'dead-2', text: 'also gone', expiresAt: 1_000_000 }), // expiresAt <= now
      record({ id: 'fresh', text: 'stays', expiresAt: 2_000_000 }),
      record({ id: 'forever', text: 'no ttl' }),
      record({ id: 'other', text: 'gone', scope: { userId: 'u2' }, expiresAt: 5 }),
    ]);

    expect(await sweepExpired(store, { userId: 'u1' }, fixedClock)).toBe(2);
    expect((await store.list({ userId: 'u1' })).map((r) => r.id).sort()).toEqual([
      'forever',
      'fresh',
    ]);
    expect(await store.get('other')).not.toBeNull(); // another scope is untouched
    expect(await sweepExpired(store, { userId: 'u1' }, fixedClock)).toBe(0); // idempotent
  });

  it('the reference in-memory store implements the fast path (scoped and unscoped)', async () => {
    const store = createInMemoryMemoryStore();
    await store.upsert([
      record({ id: 'a', expiresAt: 5 }),
      record({ id: 'b', scope: { userId: 'u2' }, expiresAt: 5 }),
    ]);
    expect(await store.deleteExpired!(1_000_000, { userId: 'u1' })).toBe(1);
    expect(await store.deleteExpired!(1_000_000)).toBe(1);
    expect(await store.deleteExpired!(1_000_000)).toBe(0);
  });
});
