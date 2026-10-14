/**
 * Legacy `recall` in 2.4 (spec §2.2): the query carries the embedder's model,
 * records embedded by another model or size stay out of the vector ranking,
 * and the run hears about it ONCE as an `embedding-mismatch` CallWarning (or,
 * without a warning channel, one logger line per seams and mismatch). H6:
 * `memory_update` with a new text drops the stale vector. No call adds a paid
 * request: recall embeds the query exactly as 2.3 did.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryMemoryStore,
  createMemoryTools,
  recall,
  remember,
  type MemoryRecord,
  type MemorySeams,
} from '../src/memory';
import type { CallWarning } from '../src/types/methods';
import { createSqliteStores } from '../src/node/store-sqlite';

const clock = { now: () => 1_000_000, setTimeout: () => () => {} };
const SCOPE = { userId: 'u1' };

function record(id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text,
    hash: `h-${id}`,
    kind: 'semantic',
    scope: SCOPE,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function seams(over: Partial<MemorySeams> = {}): MemorySeams & { embeds: string[][] } {
  const embeds: string[][] = [];
  return {
    embeds,
    store: createInMemoryMemoryStore(),
    embedder: {
      async embed(texts) {
        embeds.push(texts);
        return { vectors: texts.map(() => [1, 0, 0]), model: 'model-new' };
      },
    },
    llm: async () => '{"facts":[]}',
    clock,
    generateId: () => 'id',
    ...over,
  };
}

async function seeded(over: Partial<MemorySeams> = {}) {
  const s = seams(over);
  await s.store.upsert([
    record('fresh', 'embedded by the current model', {
      embedding: [1, 0, 0],
      embeddingModelId: 'model-new',
    }),
    record('old', 'the user lives in Istanbul', {
      embedding: [1, 0, 0],
      embeddingModelId: 'model-old',
    }),
    record('old2', 'the user drinks tea', {
      embedding: [0.9, 0.1, 0],
      embeddingModelId: 'model-old',
    }),
  ]);
  return s;
}

describe('recall: embedding mismatch', () => {
  it('leaves other-model records out of the vector ranking and warns once', async () => {
    const s = await seeded();
    const warnings: CallWarning[] = [];
    const hits = await recall({ scope: SCOPE, text: 'what do I like?', topK: 5 }, s, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(hits.map((hit) => hit.record.id)).toEqual(['fresh']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: 'embedding-mismatch' });
    expect(warnings[0]!.message).toContain('model-new');
    expect(warnings[0]!.message).toContain('3 dimensions');
    expect(warnings[0]!.message).not.toContain('Istanbul');
    // The query embedding is the only embedder call, as in 2.3.
    expect(s.embeds).toEqual([['what do I like?']]);
  });

  it('still finds an other-model record by its text', async () => {
    const s = await seeded();
    const hits = await recall({ scope: SCOPE, text: 'Istanbul', topK: 5 }, s, {
      onWarning: () => {},
    });
    expect(hits.map((hit) => hit.record.id).sort()).toEqual(['fresh', 'old']);
  });

  it('gives the same warning text for the same mismatch, so a run sink keeps one', async () => {
    const s = await seeded();
    const warnings: CallWarning[] = [];
    for (let i = 0; i < 3; i++)
      await recall({ scope: SCOPE, text: `question ${i}` }, s, {
        onWarning: (warning) => warnings.push(warning),
      });
    expect(new Set(warnings.map((w) => `${w.type} ${w.message}`)).size).toBe(1);
  });

  it('without a warning channel, logs once per seams and mismatch', async () => {
    const warn = vi.fn();
    const s = await seeded({ logger: { warn } });
    await recall({ scope: SCOPE, text: 'first question' }, s);
    await recall({ scope: SCOPE, text: 'second question' }, s);
    const lines = warn.mock.calls.filter(([, fields]) => fields?.warning === 'embedding-mismatch');
    expect(lines).toHaveLength(1);
  });

  it('says nothing when every vector matches', async () => {
    const s = seams();
    await s.store.upsert([
      record('a', 'fact', { embedding: [1, 0, 0], embeddingModelId: 'model-new' }),
      record('plain', 'no vector'),
    ]);
    const onWarning = vi.fn();
    const hits = await recall({ scope: SCOPE, text: 'q' }, s, { onWarning });
    expect(hits.map((hit) => hit.record.id)).toEqual(['a']);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('a different-size embedder is a mismatch on the SQLite pack too', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      record('old', 'the user lives in Istanbul', {
        embedding: [1, 0],
        embeddingModelId: 'model-new',
      }),
    ]);
    const warnings: CallWarning[] = [];
    const s = seams({ store: pack.memory });
    const hits = await recall({ scope: SCOPE, text: 'Istanbul' }, s, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(hits.map((hit) => hit.record.id)).toEqual(['old']);
    expect(warnings.map((w) => w.type)).toEqual(['embedding-mismatch']);
    await pack.close();
  });

  it('reconciliation in remember() compares with the embedder model too', async () => {
    const s = await seeded({
      llm: vi
        .fn()
        .mockResolvedValueOnce('{"facts":[{"text":"The user lives in Ankara"}]}')
        .mockResolvedValueOnce('{"memory":[]}'),
    });
    const search = vi.spyOn(s.store, 'search');
    await remember([{ role: 'user', content: 'I live in Ankara now' }], SCOPE, s);
    expect(search.mock.calls[0]![0]).toMatchObject({ embeddingModelId: 'model-new' });
  });
});

describe('memory_update (H6)', () => {
  it('drops the vector of the old text; the record is found by text', async () => {
    const s = seams();
    await s.store.upsert([
      record('m1', 'the user lives in Istanbul', {
        embedding: [1, 0, 0],
        embeddingModelId: 'model-new',
      }),
    ]);
    const tools = createMemoryTools({ scope: SCOPE, seams: s });
    await tools.memory_update!.execute!(
      { id: 'm1', text: 'the user moved to Ankara' },
      {} as never,
    );
    const updated = await s.store.get('m1', SCOPE);
    expect(updated?.text).toBe('the user moved to Ankara');
    expect(updated?.embedding).toBeUndefined();
    expect(updated?.embeddingModelId).toBeUndefined();
    expect((await recall({ scope: SCOPE, text: 'Ankara' }, s)).map((h) => h.record.id)).toEqual([
      'm1',
    ]);
  });

  it('drops it through the get + upsert fallback of a store without update', async () => {
    const inner = createInMemoryMemoryStore();
    const { update: _update, ...withoutUpdate } = inner;
    const s = seams({ store: withoutUpdate });
    await inner.upsert([
      record('m1', 'old text', { embedding: [1, 0, 0], embeddingModelId: 'model-new' }),
    ]);
    const tools = createMemoryTools({ scope: SCOPE, seams: s });
    await tools.memory_update!.execute!({ id: 'm1', text: 'new text' }, {} as never);
    const updated = await inner.get('m1');
    expect(updated?.text).toBe('new text');
    expect(updated?.embedding).toBeUndefined();
  });
});
