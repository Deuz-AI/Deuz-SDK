/**
 * internal/vector.ts — the shared vector primitives (2.0).
 *
 * `cosineSimilarity` is already covered from both of its public re-export sites
 * (memory.test.ts, rag.test.ts); what is new here is the Float32 BLOB codec the
 * SQLite/Postgres stores serialize embeddings with, and the keyed RRF helper
 * their hybrid queries fuse ranks with.
 */
import { describe, it, expect } from 'vitest';
import { cosineSimilarity, encodeVector, decodeVector, rankFuse } from '../src/internal/vector';

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, 0 on length mismatch / zero vector', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('is identical to the copies memory.ts and rag.ts used to carry', async () => {
    const { cosineSimilarity: fromMemory } = await import('../src/memory');
    const { cosineSimilarity: fromRag } = await import('../src/rag');
    expect(fromMemory).toBe(cosineSimilarity);
    expect(fromRag).toBe(cosineSimilarity);
  });
});

describe('encodeVector / decodeVector', () => {
  it('round-trips a vector at float32 precision', () => {
    const v = [0, 1, -1, 0.5, 0.25, -0.125];
    const decoded = decodeVector(encodeVector(v));
    expect(decoded).toEqual(v); // all exactly representable in float32
  });

  it('lays bytes out little-endian regardless of the host', () => {
    // 1.0f is 0x3F800000; little-endian that is 00 00 80 3F.
    expect([...encodeVector([1])]).toEqual([0x00, 0x00, 0x80, 0x3f]);
    expect(encodeVector([1, 2, 3])).toHaveLength(12);
    expect(encodeVector([])).toHaveLength(0);
    expect(decodeVector(new Uint8Array(0))).toEqual([]);
  });

  it('narrows float64 to float32 without changing the ranking', () => {
    const v = [0.1, 0.2, 0.3];
    const decoded = decodeVector(encodeVector(v));
    for (let i = 0; i < v.length; i++) expect(decoded[i]).toBeCloseTo(v[i]!, 6);
    expect(cosineSimilarity(decoded, v)).toBeCloseTo(1, 6);
  });

  it('ignores a trailing partial float instead of decoding NaN', () => {
    const full = encodeVector([1, 2]);
    const truncated = full.subarray(0, full.length - 1);
    expect(decodeVector(truncated)).toEqual([1]);
  });

  it('honors byteOffset on a view into a larger buffer', () => {
    const buffer = new ArrayBuffer(16);
    const window = new Uint8Array(buffer, 4, 8);
    window.set(encodeVector([7, -7]));
    expect(decodeVector(window)).toEqual([7, -7]);
  });
});

describe('rankFuse', () => {
  it('sums 1/(k + rank) votes across lists, best-first', () => {
    const dense = { key: (s: string) => s, items: ['a', 'b', 'c'] };
    const lexical = { key: (s: string) => s, items: ['c', 'a', 'd'] };

    const fused = rankFuse([dense, lexical]);
    // a: 1/61 + 1/62, c: 1/63 + 1/61, b: 1/62, d: 1/63
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused.get('c')).toBeCloseTo(1 / 63 + 1 / 61, 10);
    expect(fused.get('b')).toBeCloseTo(1 / 62, 10);
    expect(fused.get('d')).toBeCloseTo(1 / 63, 10);

    const ranked = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([key]) => key);
    expect(ranked).toEqual(['a', 'c', 'b', 'd']);
  });

  it('ignores raw scores — only list ORDER votes', () => {
    const byScore = { key: (r: { id: string }) => r.id, items: [{ id: 'x' }, { id: 'y' }] };
    const reversed = { key: (r: { id: string }) => r.id, items: [{ id: 'y' }, { id: 'x' }] };
    const fused = rankFuse([byScore, reversed]);
    expect(fused.get('x')).toBeCloseTo(fused.get('y')!, 12);
  });

  it('lets k tune the damping and handles empty input', () => {
    const list = { key: (s: string) => s, items: ['only'] };
    expect(rankFuse([list], 1).get('only')).toBeCloseTo(1 / 2, 10);
    expect(rankFuse([list], 60).get('only')).toBeCloseTo(1 / 61, 10);
    expect(rankFuse<string>([]).size).toBe(0);
    expect(rankFuse([{ key: (s: string) => s, items: [] }]).size).toBe(0);
  });
});
