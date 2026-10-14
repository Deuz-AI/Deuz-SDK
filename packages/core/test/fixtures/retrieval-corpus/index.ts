/**
 * The offline retrieval-quality fixture (2.4, spec §5.2): a labelled corpus
 * (200 records, 50 queries), a deterministic embedder and recall@k /
 * precision@k over any search function. "Selected record accuracy" is
 * measured here without a paid model; the numbers describe this corpus and
 * embedder only, never a real model.
 */
import {
  createBm25Index,
  createMemoryVectorStore,
  indexChunks,
  type Bm25Index,
  type Chunk,
  type VectorStore,
} from '../../../src/rag';
import { createDeterministicEmbedder } from './embedder';
import { RETRIEVAL_QUERIES, type RetrievalQuery } from './queries';
import { RETRIEVAL_RECORDS } from './records';

export { RETRIEVAL_RECORDS, type RetrievalRecord } from './records';
export { RETRIEVAL_QUERIES, type RetrievalQuery } from './queries';
export { createDeterministicEmbedder, embedText, stem, terms } from './embedder';

/** Ranked record ids for a query, best first. */
export type RetrievalSearch = (query: string, k: number) => Promise<readonly string[]>;

/** The quality of one search function at one k, averaged over the queries. */
export interface RetrievalReport {
  k: number;
  /** Mean share of each query's relevant records found in its top k. */
  recall: number;
  /** Mean share of each query's top k that is relevant. */
  precision: number;
  /** Queries with no relevant record in the top k. */
  misses: string[];
}

/** The corpus as RAG chunks: `index` is the record's position, `meta.id` its id. */
export function corpusChunks(): Chunk[] {
  return RETRIEVAL_RECORDS.map((record, index) => ({
    text: record.text,
    index,
    meta: { id: record.id, topic: record.topic },
  }));
}

/** The corpus indexed for dense (deterministic embedder) and BM25 search. */
export async function corpusIndex(): Promise<{
  chunks: Chunk[];
  store: VectorStore;
  bm25: Bm25Index;
  embedder: ReturnType<typeof createDeterministicEmbedder>;
}> {
  const chunks = corpusChunks();
  const embedder = createDeterministicEmbedder();
  const store = createMemoryVectorStore();
  await indexChunks(chunks, { embedder, store });
  return { chunks, store, bm25: createBm25Index(chunks), embedder };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** recall@k and precision@k of `search` over the labelled queries (rounded to 3 places). */
export async function evaluateRetrieval(
  search: RetrievalSearch,
  k: number,
  queries: readonly RetrievalQuery[] = RETRIEVAL_QUERIES,
): Promise<RetrievalReport> {
  let recall = 0;
  let precision = 0;
  const misses: string[] = [];
  for (const query of queries) {
    const top = (await search(query.text, k)).slice(0, k);
    const relevant = new Set(query.relevant);
    const found = top.filter((id) => relevant.has(id)).length;
    recall += found / relevant.size;
    precision += found / k;
    if (found === 0) misses.push(query.id);
  }
  return {
    k,
    recall: round(recall / queries.length),
    precision: round(precision / queries.length),
    misses,
  };
}
