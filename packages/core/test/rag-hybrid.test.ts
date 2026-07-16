import { describe, it, expect } from 'vitest';
import {
  tokenize,
  createBm25Index,
  reciprocalRankFusion,
  hybridRetrieve,
  createMemoryVectorStore,
  indexChunks,
  type Chunk,
  type ScoredChunk,
  type Embedder,
} from '../src/rag';

const docs: Chunk[] = [
  { text: 'The cat sat on the warm mat by the fire', index: 0 },
  { text: 'A dog ran fast across the green field', index: 1 },
  { text: 'GDPR clause 17 covers the right to erasure of personal data', index: 2 },
  { text: 'Felines are independent animals that enjoy warmth', index: 3 },
];

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics, folds diacritics', () => {
    expect(tokenize('Café, RÉSUMÉ-2024!')).toEqual(['cafe', 'resume', '2024']);
  });
});

describe('BM25', () => {
  it('ranks exact-term matches highest (rare tokens win)', () => {
    const idx = createBm25Index(docs);
    const hits = idx.search('clause 17 erasure', 4);
    expect(hits[0]!.index).toBe(2); // the GDPR doc has all three rare terms
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('returns only docs that contain a query term', () => {
    const idx = createBm25Index(docs);
    const hits = idx.search('dog', 4);
    expect(hits.map((h) => h.index)).toEqual([1]); // only the dog doc matches
  });

  it('honors topK', () => {
    const idx = createBm25Index(docs);
    expect(idx.search('the', 2).length).toBeLessThanOrEqual(2);
    expect(idx.size).toBe(4);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards items ranked high in BOTH lists', () => {
    const dense: ScoredChunk[] = [
      { ...docs[0]!, score: 0.9 }, // rank 0
      { ...docs[3]!, score: 0.7 }, // rank 1
    ];
    const lexical: ScoredChunk[] = [
      { ...docs[3]!, score: 5 }, // rank 0
      { ...docs[0]!, score: 3 }, // rank 1
    ];
    const fused = reciprocalRankFusion([dense, lexical]);
    // doc0: 1/61 + 1/62 ; doc3: 1/62 + 1/61 → equal here, both beat singletons
    expect(fused).toHaveLength(2);
    expect(fused.map((c) => c.index).sort()).toEqual([0, 3]);
    // a doc in only one list scores lower than one in both
    const partial = reciprocalRankFusion([
      [
        { ...docs[0]!, score: 1 },
        { ...docs[1]!, score: 1 },
      ],
      [{ ...docs[0]!, score: 1 }],
    ]);
    expect(partial[0]!.index).toBe(0); // appears in both → top
  });

  it('topN truncates the fused list', () => {
    const r = reciprocalRankFusion(
      [
        [
          { ...docs[0]!, score: 1 },
          { ...docs[1]!, score: 1 },
        ],
      ],
      {
        topN: 1,
      },
    );
    expect(r).toHaveLength(1);
  });
});

describe('hybridRetrieve — dense + BM25 fused', () => {
  // Toy embedder: "warm/cat/feline" → [1,0]; everything else → [0,1].
  const embedder: Embedder = {
    dims: 2,
    embed: async (texts) => texts.map((t) => (/cat|warm|felin/i.test(t) ? [1, 0] : [0, 1])),
  };

  it('fuses semantic + lexical so an exact term AND a paraphrase both surface', async () => {
    const store = createMemoryVectorStore();
    await indexChunks(docs, { embedder, store });
    const bm25 = createBm25Index(docs);

    // Query has a semantic side ("warmth-loving animal") and an exact term ("clause 17").
    const hits = await hybridRetrieve(
      'warm animal and GDPR clause 17',
      { embedder, store, bm25 },
      {
        topK: 4,
      },
    );
    const ids = hits.map((h) => h.index);
    // doc2 (clause 17, lexical) AND a warm/feline doc (semantic) both make the cut
    expect(ids).toContain(2);
    expect(ids.some((i) => i === 0 || i === 3)).toBe(true);
  });

  it('still works when the vector stage is empty (lexical-only fallback)', async () => {
    const store = createMemoryVectorStore(); // nothing indexed
    const bm25 = createBm25Index(docs);
    const hits = await hybridRetrieve('clause 17', { embedder, store, bm25 }, { topK: 3 });
    expect(hits[0]!.index).toBe(2);
  });
});
