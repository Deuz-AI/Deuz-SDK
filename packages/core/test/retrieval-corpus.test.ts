/**
 * Retrieval quality on the offline corpus (2.4, spec §5.2): recall@k and
 * precision@k of dense, BM25 and hybrid retrieval with the deterministic
 * embedder, and of the same retrieval through the compiler's RAG source.
 * The pinned numbers are this corpus's baseline: they catch a regression in
 * the retrieval or selection plumbing and claim nothing about real models.
 * A deliberate change to the corpus, the embedder or the ranking updates
 * them in the same commit.
 */
import { describe, expect, it } from 'vitest';
import { compileContext } from '../src/context/compile';
import { createRagContextSource } from '../src/context/sources';
import { createBm25Index, hybridRetrieve, retrieve } from '../src/rag';
import {
  RETRIEVAL_QUERIES,
  RETRIEVAL_RECORDS,
  corpusChunks,
  corpusIndex,
  createDeterministicEmbedder,
  embedText,
  evaluateRetrieval,
  type RetrievalSearch,
} from './fixtures/retrieval-corpus';

const ids = (chunks: readonly { meta?: Record<string, unknown> }[]) =>
  chunks.map((chunk) => String(chunk.meta?.id));

describe('the retrieval corpus', () => {
  it('holds about 200 labelled records and 50 queries whose labels resolve', () => {
    expect(RETRIEVAL_RECORDS).toHaveLength(200);
    expect(new Set(RETRIEVAL_RECORDS.map((record) => record.id)).size).toBe(200);
    expect(new Set(RETRIEVAL_RECORDS.map((record) => record.topic)).size).toBe(25);
    expect(RETRIEVAL_QUERIES).toHaveLength(50);
    const known = new Set(RETRIEVAL_RECORDS.map((record) => record.id));
    for (const query of RETRIEVAL_QUERIES) {
      expect(query.relevant.length).toBeGreaterThanOrEqual(1);
      expect(query.relevant.length).toBeLessThanOrEqual(3);
      for (const id of query.relevant) expect(known.has(id), `${query.id} → ${id}`).toBe(true);
    }
  });

  it('embeds deterministically into unit vectors', async () => {
    const embedder = createDeterministicEmbedder();
    const [a, b] = await embedder.embed(['Vacation days roll over', 'Vacation days roll over']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(256);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 10);
    expect(embedText('', 8)).toEqual(new Array(8).fill(0));
  });
});

describe('retrieval quality baseline', () => {
  type Searches = Record<'dense' | 'lexical' | 'hybrid' | 'compiled', RetrievalSearch>;

  async function searches(): Promise<Searches> {
    const { store, bm25, embedder } = await corpusIndex();
    const dense: RetrievalSearch = async (query, k) =>
      ids(await retrieve(query, { embedder, store }, { topK: k }));
    const lexical: RetrievalSearch = async (query, k) => ids(bm25.search(query, k));
    const hybrid: RetrievalSearch = async (query, k) =>
      ids(await hybridRetrieve(query, { embedder, store, bm25 }, { topK: k, perStageK: 20 }));
    const source = createRagContextSource({
      retrieve: (query, topK) =>
        hybridRetrieve(query, { embedder, store, bm25 }, { topK, perStageK: 20 }),
    });
    const compiled: RetrievalSearch = async (query, k) => {
      const candidates = await source.query({ text: query, limit: k, budgetTokens: 0 });
      const pkg = compileContext({
        step: 1,
        results: [{ source: { id: 'rag', kind: 'rag' }, status: 'ok', candidates }],
        inputTokens: 200_000,
        usedTokens: 0,
        refresh: 'initial',
        pass: 1,
      });
      return pkg.manifest.entries.filter((entry) => entry.selected).map((entry) => entry.recordId);
    };
    return { dense, lexical, hybrid, compiled };
  }

  it('pins recall@k and precision@k for k = 1, 5 and 10', async () => {
    const all = await searches();
    const report: Record<string, Record<number, { recall: number; precision: number }>> = {};
    for (const [name, search] of Object.entries(all)) {
      report[name] = {};
      for (const k of [1, 5, 10]) {
        const { recall, precision } = await evaluateRetrieval(search, k);
        report[name]![k] = { recall, precision };
      }
    }
    expect(report).toEqual(BASELINE);
  });

  it('loses nothing between hybrid retrieval and the compiled package', async () => {
    const { hybrid, compiled } = await searches();
    for (const k of [5, 10])
      expect(await evaluateRetrieval(compiled, k)).toEqual(await evaluateRetrieval(hybrid, k));
  });

  it('keeps BM25 over the corpus chunks deterministic', () => {
    const one = createBm25Index(corpusChunks()).search('paid vacation days', 5);
    const two = createBm25Index(corpusChunks()).search('paid vacation days', 5);
    expect(ids(one)).toEqual(ids(two));
  });
});

/** Measured on this corpus and embedder (2.4.0); update deliberately, never to pass. */
const BASELINE = {
  dense: {
    1: { recall: 0.44, precision: 0.5 },
    5: { recall: 0.64, precision: 0.148 },
    10: { recall: 0.72, precision: 0.086 },
  },
  lexical: {
    1: { recall: 0.41, precision: 0.46 },
    5: { recall: 0.65, precision: 0.152 },
    10: { recall: 0.75, precision: 0.088 },
  },
  hybrid: {
    1: { recall: 0.49, precision: 0.56 },
    5: { recall: 0.68, precision: 0.156 },
    10: { recall: 0.75, precision: 0.09 },
  },
  compiled: {
    1: { recall: 0.49, precision: 0.56 },
    5: { recall: 0.68, precision: 0.156 },
    10: { recall: 0.75, precision: 0.09 },
  },
};
