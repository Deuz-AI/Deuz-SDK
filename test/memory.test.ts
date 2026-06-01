import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  parseFacts,
  buildDecisionPrompt,
  parseDecision,
  applyEvents,
  isExpired,
  assertScope,
  matchesScope,
  cosineSimilarity,
  defaultHashFn,
  defaultMemoryScorer,
  remember,
  recall,
  planMemory,
  formatMemoriesForPrompt,
  createMemoryTools,
  createInMemoryMemoryStore,
  type MemorySeams,
  type MemoryLLM,
  type MemoryRecord,
  type Embedder,
} from '../src/memory';
import { InvalidRequestError } from '../src/errors';

// --- deterministic seam doubles ---
const fixedClock = { now: () => 1_000_000, setTimeout: (fn: () => void) => (fn(), () => {}) };
let idCounter = 0;
const genId = () => `id-${idCounter++}`;
const syncHash = async (t: string) => `h:${t}`;

function seams(over: Partial<MemorySeams> = {}): MemorySeams {
  return {
    store: createInMemoryMemoryStore(),
    llm: async () => '{"facts":[]}',
    clock: fixedClock,
    generateId: genId,
    hashFn: syncHash,
    ...over,
  };
}

describe('pure helpers', () => {
  it('assertScope throws without any scope field', () => {
    expect(() => assertScope({})).toThrow(InvalidRequestError);
    expect(() => assertScope({ userId: 'u1' })).not.toThrow();
  });

  it('matchesScope is exact-match on present fields', () => {
    const rec = { scope: { userId: 'u1', agentId: 'a1' } } as MemoryRecord;
    expect(matchesScope(rec, { userId: 'u1' })).toBe(true);
    expect(matchesScope(rec, { userId: 'u2' })).toBe(false);
    expect(matchesScope(rec, { runId: 'r1' })).toBe(false);
  });

  it('isExpired honors expiresAt vs now', () => {
    expect(isExpired({ expiresAt: 500 } as MemoryRecord, 1000)).toBe(true);
    expect(isExpired({ expiresAt: 2000 } as MemoryRecord, 1000)).toBe(false);
    expect(isExpired({} as MemoryRecord, 1000)).toBe(false);
  });

  it('cosineSimilarity: identical=1, orthogonal=0, mismatch=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('defaultHashFn produces a stable 64-char hex (WebCrypto SHA-256)', async () => {
    const h = await defaultHashFn('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await defaultHashFn('hello')).toBe(h);
  });

  it('defaultMemoryScorer blends recency·importance·relevance', () => {
    const rec = { updatedAt: 1_000_000, importance: 0.5 } as MemoryRecord;
    const s = defaultMemoryScorer.score(rec, { now: 1_000_000, relevance: 1 });
    expect(s).toBeCloseTo(1 + 0.5 + 1, 5); // recency≈1 (0h), importance 0.5, relevance 1
  });
});

describe('extraction parsing', () => {
  it('buildExtractionPrompt summarizes the conversation', () => {
    const { system, user } = buildExtractionPrompt([{ role: 'user', content: 'I am vegetarian' }]);
    expect(system).toContain('facts');
    expect(user).toContain('vegetarian');
  });

  it('parseFacts strips ```json fences and prose', () => {
    expect(parseFacts('Here you go:\n```json\n{"facts":["a","b"]}\n```')).toEqual([
      { text: 'a' },
      { text: 'b' },
    ]);
    expect(parseFacts('garbage')).toEqual([]);
    expect(parseFacts('["x"]')).toEqual([{ text: 'x' }]);
  });
});

describe('decision parsing + reducer', () => {
  const existing: MemoryRecord[] = [
    {
      id: 'real-0',
      text: 'likes meat',
      hash: 'h',
      kind: 'semantic',
      scope: { userId: 'u1' },
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  it('buildDecisionPrompt maps temp int ids → real ids', () => {
    const { idMap, user } = buildDecisionPrompt(existing, [{ text: 'is vegetarian' }]);
    expect(idMap.get('0')).toBe('real-0');
    expect(user).toContain('"id":"0"'); // model sees int, not the UUID
    expect(user).not.toContain('real-0');
  });

  it('parseDecision drops hallucinated ids, keeps valid ADD/UPDATE/DELETE', () => {
    const idMap = new Map([['0', 'real-0']]);
    const events = parseDecision(
      JSON.stringify({
        memory: [
          { event: 'ADD', text: 'allergic to nuts' },
          { id: '0', event: 'UPDATE', text: 'is vegetarian', old_memory: 'likes meat' },
          { id: '99', event: 'DELETE' }, // hallucinated → dropped
        ],
      }),
      idMap,
    );
    expect(events).toEqual([
      { type: 'ADD', text: 'allergic to nuts' },
      { type: 'UPDATE', id: 'real-0', text: 'is vegetarian', oldText: 'likes meat' },
    ]);
  });

  it('applyEvents: ADD→upsert(new id), UPDATE→same id, DELETE hard vs soft', async () => {
    const ctx = {
      clock: fixedClock,
      generateId: () => 'new-1',
      scope: { userId: 'u1' },
      hashFn: syncHash,
    };
    const add = await applyEvents([{ type: 'ADD', text: 'x' }], existing, ctx);
    expect(add[0]).toMatchObject({
      op: 'upsert',
      event: 'ADD',
      record: { id: 'new-1', text: 'x' },
    });

    const upd = await applyEvents(
      [{ type: 'UPDATE', id: 'real-0', text: 'y', oldText: 'likes meat' }],
      existing,
      ctx,
    );
    expect(upd[0]).toMatchObject({
      op: 'upsert',
      event: 'UPDATE',
      record: { id: 'real-0', text: 'y' },
    });

    const del = await applyEvents([{ type: 'DELETE', id: 'real-0' }], existing, ctx);
    expect(del[0]).toEqual({ op: 'delete', id: 'real-0' });

    const soft = await applyEvents([{ type: 'DELETE', id: 'real-0' }], existing, {
      ...ctx,
      supersede: 'soft',
    });
    expect(soft[0]).toMatchObject({ op: 'invalidate', id: 'real-0' });
  });
});

describe('remember() pipeline', () => {
  it('infer=false stores raw turns with ZERO llm calls', async () => {
    let llmCalls = 0;
    const s = seams({ llm: async () => (llmCalls++, '{"facts":[]}') });
    const muts = await remember(
      [{ role: 'user', content: 'remember this verbatim' }],
      { userId: 'u1' },
      s,
      { infer: false },
    );
    expect(llmCalls).toBe(0);
    expect(muts).toHaveLength(1);
    expect(muts[0]).toMatchObject({
      op: 'upsert',
      record: { kind: 'episodic', text: 'remember this verbatim' },
    });
    // applied to the store
    const all = await s.store.list({ userId: 'u1' });
    expect(all).toHaveLength(1);
  });

  it('infer=true runs extract → decide → apply (mock LLM)', async () => {
    const llm: MemoryLLM = async ({ system }) => {
      // First call = extraction (system mentions "extract"), second = decision.
      if (system.includes('extract')) return '{"facts":["is vegetarian"]}';
      return '{"memory":[{"event":"ADD","text":"is vegetarian"}]}';
    };
    const s = seams({ llm });
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
    const stored = await s.store.list({ userId: 'u1' });
    expect(stored[0]!.text).toBe('is vegetarian');
  });

  it('embedder is delegated: vectors pinned onto ADDed records', async () => {
    const embedder: Embedder = {
      embed: async (texts) => ({ vectors: texts.map(() => [0.1, 0.2]), model: 'emb-test' }),
    };
    const llm: MemoryLLM = async ({ system }) =>
      system.includes('extract')
        ? '{"facts":["likes hiking"]}'
        : '{"memory":[{"event":"ADD","text":"likes hiking"}]}';
    const s = seams({ llm, embedder });
    const muts = await remember([{ role: 'user', content: 'I love hiking' }], { userId: 'u1' }, s);
    const rec = (muts[0] as { record: MemoryRecord }).record;
    expect(rec.embedding).toEqual([0.1, 0.2]);
    expect(rec.embeddingModelId).toBe('emb-test');
  });

  it('planMemory does NOT apply (plan-only)', async () => {
    const s = seams();
    const muts = await planMemory([{ role: 'user', content: 'plan only' }], { userId: 'u1' }, s, {
      infer: false,
    });
    expect(muts).toHaveLength(1);
    expect(await s.store.list({ userId: 'u1' })).toHaveLength(0); // nothing applied
  });

  it('assertScope guards remember()', async () => {
    await expect(remember([{ role: 'user', content: 'x' }], {}, seams())).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });
});

describe('recall()', () => {
  it('embeds the query (if embedder) and ranks by cosine, dropping expired', async () => {
    const store = createInMemoryMemoryStore();
    await store.upsert([
      {
        id: 'a',
        text: 'cats',
        hash: 'h',
        kind: 'semantic',
        scope: { userId: 'u1' },
        embedding: [1, 0],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'b',
        text: 'dogs',
        hash: 'h',
        kind: 'semantic',
        scope: { userId: 'u1' },
        embedding: [0, 1],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'c',
        text: 'expired',
        hash: 'h',
        kind: 'semantic',
        scope: { userId: 'u1' },
        embedding: [1, 0],
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 5,
      },
    ]);
    const embedder: Embedder = { embed: async () => ({ vectors: [[1, 0]], model: 'm' }) };
    const hits = await recall(
      { scope: { userId: 'u1' }, text: 'feline' },
      seams({ store, embedder }),
    );
    expect(hits[0]!.record.id).toBe('a'); // cosine match
    expect(hits.find((h) => h.record.id === 'c')).toBeUndefined(); // expired dropped (now=1_000_000)
  });

  it('formatMemoriesForPrompt renders a bulleted block (empty when no hits)', () => {
    expect(formatMemoriesForPrompt([])).toBe('');
    const out = formatMemoriesForPrompt([{ record: { text: 'fact A' } as MemoryRecord, score: 1 }]);
    expect(out).toContain('- fact A');
  });
});

describe('createMemoryTools (model-driven write path)', () => {
  it('append/search/view/delete operate on the store seam', async () => {
    const s = seams();
    const tools = createMemoryTools({ scope: { userId: 'u1' }, seams: s });
    const ctx = { toolCallId: 't1', messages: [] };

    const appended = (await tools.memory_append!.execute!({ text: 'I use vim' }, ctx)) as {
      id: string;
    };
    expect(appended.id).toBeTruthy();

    const found = (await tools.memory_search!.execute!({ query: 'vim' }, ctx)) as {
      text: string;
    }[];
    expect(found[0]!.text).toBe('I use vim');

    const viewed = (await tools.memory_view!.execute!({}, ctx)) as unknown[];
    expect(viewed).toHaveLength(1);

    await tools.memory_delete!.execute!({ id: appended.id }, ctx);
    expect(await s.store.list({ userId: 'u1' })).toHaveLength(0);
  });
});

describe('Obsidian-style backend works behind the SAME seam', () => {
  it('a grep/substring store with no embeddings still serves recall()', async () => {
    // Simulate a markdown backend: text-only search, no vectors.
    const store = createInMemoryMemoryStore();
    await store.upsert([
      {
        id: 'm1',
        text: 'Project deadline is Friday',
        hash: 'h',
        kind: 'semantic',
        scope: { agentId: 'a1' },
        metadata: { tags: ['work'], links: ['[[project]]'] },
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const hits = await recall({ scope: { agentId: 'a1' }, text: 'deadline' }, seams({ store }));
    expect(hits[0]!.record.text).toContain('deadline');
    expect(hits[0]!.record.metadata?.links).toEqual(['[[project]]']);
  });
});
