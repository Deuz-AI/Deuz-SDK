/**
 * Legacy memory recall in 2.4 (spec §2.2): a stored vector of another length
 * or embedding model never enters the vector ranking, a record without a
 * vector never fills topK with score 0, both stay findable by text, and recall
 * reports the mismatch once (`embedding-mismatch`). `cosineSimilarity` itself
 * keeps its 2.3 behaviour: rag.ts and evolve rely on it.
 */
import { describe, expect, it } from 'vitest';
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
