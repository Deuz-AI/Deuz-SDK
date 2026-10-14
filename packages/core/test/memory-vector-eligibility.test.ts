/**
 * Legacy memory recall in 2.4 (spec §2.2): a stored vector of another length
 * or embedding model never enters the vector ranking, a record without a
 * vector never fills topK with score 0, both stay findable by text, and recall
 * reports the mismatch once (`embedding-mismatch`). `cosineSimilarity` itself
 * keeps its 2.3 behaviour: rag.ts and evolve rely on it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../src/memory';
import { createMarkdownMemoryStore } from '../src/memory-markdown';
import { cosineSimilarity, rankByVector, vectorExclusion } from '../src/internal/vector';

describe('vectorExclusion', () => {
  const query = { vector: [1, 0, 0], modelId: 'm1' };

  it('admits a vector of the same length and model, or with no model named on a side', () => {
    expect(vectorExclusion({ vector: [0, 1, 0], modelId: 'm1' }, query)).toBeUndefined();
    expect(vectorExclusion({ vector: [0, 1, 0] }, query)).toBeUndefined();
    expect(
      vectorExclusion({ vector: [0, 1, 0], modelId: 'm2' }, { vector: [1, 0, 0] }),
    ).toBeUndefined();
    // memoryEmbedderFromRag without a modelId pins 'unknown': it names no model.
    expect(vectorExclusion({ vector: [0, 1, 0], modelId: 'unknown' }, query)).toBeUndefined();
    expect(
      vectorExclusion({ vector: [0, 1, 0], modelId: 'm2' }, { ...query, modelId: 'unknown' }),
    ).toBeUndefined();
  });

  it('names why a vector is left out', () => {
    expect(vectorExclusion({}, query)).toBe('missing');
    expect(vectorExclusion({ vector: [] }, query)).toBe('missing');
    expect(vectorExclusion({ vector: null }, query)).toBe('missing');
    expect(vectorExclusion({ vector: [1, 0], modelId: 'm1' }, query)).toBe('dims');
    expect(vectorExclusion({ vector: [1, 0, 0], modelId: 'm2' }, query)).toBe('model');
  });
});

describe('rankByVector', () => {
  it('ranks only the vectors it may compare, best first, and counts the mismatches', () => {
    const items = [
      { id: 'far', vector: [0, 0, 1], modelId: 'm1' },
      { id: 'near', vector: [1, 0, 0], modelId: 'm1' },
      { id: 'novec' },
      { id: 'short', vector: [1, 0], modelId: 'm1' },
      { id: 'other', vector: [1, 0, 0], modelId: 'm2' },
      { id: 'mid', vector: [0.6, 0.8, 0] },
    ];
    const ranking = rankByVector(items, (item) => item, { vector: [1, 0, 0], modelId: 'm1' });
    expect(ranking.ranked.map((hit) => hit.item.id)).toEqual(['near', 'mid', 'far']);
    expect(ranking.ranked.map((hit) => hit.score)).toEqual([1, 0.6, 0]);
    expect(ranking.excluded.map((item) => item.id)).toEqual(['novec', 'short', 'other']);
    expect(ranking.mismatched).toBe(2);
  });

  it('keeps the input order for equal scores', () => {
    const items = [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [2, 0] },
      { id: 'c', vector: [3, 0] },
    ];
    const ranking = rankByVector(items, (item) => item, { vector: [1, 0] });
    expect(ranking.ranked.map((hit) => hit.item.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves cosineSimilarity as it was: 0 on a length mismatch', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The Markdown store (not part of the shared contract): the same rule, with
// vectors in its sidecar file.
// ---------------------------------------------------------------------------

describe('createMarkdownMemoryStore (2.4 vector rule, H6)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deuz-mem-vec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = (id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
    id,
    text,
    hash: `h-${id}`,
    kind: 'semantic',
    scope: { userId: 'u1' },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });

  it('ranks only comparable vectors, finds the rest by text and reports a mismatch once', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([
      record('same', 'same model', { embedding: [1, 0, 0], embeddingModelId: 'm1' }),
      record('other', 'the user lives in Istanbul', {
        embedding: [1, 0, 0],
        embeddingModelId: 'm2',
      }),
      record('novec', 'no vector at all'),
    ]);
    const notices: unknown[] = [];
    const hits = await store.search({
      scope: { userId: 'u1' },
      embedding: [1, 0, 0],
      embeddingModelId: 'm1',
      onEmbeddingMismatch: (mismatch) => notices.push(mismatch),
    });
    expect(hits.map((hit) => hit.record.id)).toEqual(['same']);
    expect(notices).toEqual([{ records: 1, dims: 3, modelId: 'm1' }]);

    const withText = await store.search({
      scope: { userId: 'u1' },
      text: 'Istanbul',
      embedding: [1, 0, 0],
      embeddingModelId: 'm1',
    });
    expect(withText.map((hit) => hit.record.id).sort()).toEqual(['other', 'same']);
  });

  it('drops the sidecar vector when an update changes the text', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([
      record('moved', 'the user lives in Istanbul', {
        embedding: [1, 0, 0],
        embeddingModelId: 'm1',
      }),
      record('kept', 'the user drinks tea', { embedding: [0.9, 0.1, 0] }),
    ]);
    await store.update!('moved', { text: 'the user moved to Ankara' });
    await store.update!('kept', { importance: 0.5 });

    const byVector = await store.search({ scope: { userId: 'u1' }, embedding: [1, 0, 0] });
    expect(byVector.map((hit) => hit.record.id)).toEqual(['kept']);
    expect((await store.get('moved'))?.embeddingModelId).toBeUndefined();
    const sidecar = JSON.parse(await readFile(join(dir, '.deuz-vectors.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(sidecar)).toEqual(['kept']);
  });
});
