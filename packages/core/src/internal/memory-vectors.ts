/**
 * internal/memory-vectors.ts (2.4, spec §2.2) — the vector rule every legacy
 * `MemoryStore` search follows: a stored vector of another length or
 * embedding model never enters the vector ranking, a record without a vector
 * never fills the page at score 0, both stay findable by text, and the
 * mismatch is reported once per search through `MemoryQuery.onEmbeddingMismatch`.
 * Internal: the in-memory and Markdown stores use `vectorHits`, the
 * persistent packs `reportEmbeddingMismatch` around their own queries. Pure
 * and edge-safe.
 */
import type { MemoryHit, MemoryQuery, MemoryRecord } from '../memory';
import { rankByVector } from './vector';

/**
 * The vector half of a legacy store's search: records whose vector can be
 * compared with the query's (same length, and the same `embeddingModelId`
 * when both name one) are ranked by cosine; the others, with no vector or
 * one of another length or model, score 1 when `textMatch` finds the query
 * text in them (the score a text query gives) and are left out otherwise,
 * never added at 0 to fill the page.
 */
export function vectorHits(
  candidates: readonly MemoryRecord[],
  query: MemoryQuery,
  vectorOf: (record: MemoryRecord) => number[] | undefined,
  textMatch: (record: MemoryRecord) => boolean,
): MemoryHit[] {
  const ranking = rankByVector(
    candidates,
    (record) => ({ vector: vectorOf(record), modelId: record.embeddingModelId }),
    { vector: query.embedding!, modelId: query.embeddingModelId },
  );
  reportEmbeddingMismatch(query, ranking.mismatched);
  const hits: MemoryHit[] = ranking.ranked.map(({ item, score }) => ({ record: item, score }));
  if (query.text?.trim())
    for (const record of ranking.excluded) if (textMatch(record)) hits.push({ record, score: 1 });
  return hits;
}

/** Tells `query.onEmbeddingMismatch` how many records a search left out of its vector ranking. */
export function reportEmbeddingMismatch(query: MemoryQuery, records: number): void {
  if (records <= 0 || !query.onEmbeddingMismatch || !query.embedding) return;
  query.onEmbeddingMismatch({
    records,
    dims: query.embedding.length,
    ...(query.embeddingModelId !== undefined ? { modelId: query.embeddingModelId } : {}),
  });
}

/**
 * Whether an update patch leaves the stored vector stale (2.4, H6): it changes
 * the text without bringing a new embedding, or sets `embedding` to undefined.
 */
export function dropsVector(
  record: Pick<MemoryRecord, 'text'>,
  patch: Partial<MemoryRecord>,
): boolean {
  if ('embedding' in patch) return patch.embedding === undefined;
  return patch.text !== undefined && patch.text !== record.text;
}

/**
 * H6 (2.4): a stored vector describes the text it was computed from. Before
 * an update patch is applied, this returns the record without its vector and
 * `embeddingModelId` when the patch leaves them stale (`dropsVector`), so the
 * record is found by text until it is embedded again; otherwise unchanged.
 */
export function withoutStaleVector(
  record: MemoryRecord,
  patch: Partial<MemoryRecord>,
): MemoryRecord {
  if (!dropsVector(record, patch)) return record;
  const { embedding: _embedding, embeddingModelId: _model, ...rest } = record;
  return rest;
}

/**
 * The stored `embeddingModelId` values a query's model may be compared with,
 * for a store that filters in SQL (`= ANY(...)`): the model itself, and the
 * values that name no model (`'unknown'`, which `memoryEmbedderFromRag`
 * pins, and `''`); a NULL column names none either. `undefined` when the
 * query names no model, so only lengths are compared.
 */
export function comparableModels(modelId: string | undefined): string[] | undefined {
  if (modelId === undefined || modelId === '' || modelId === 'unknown') return undefined;
  return [modelId, 'unknown', ''];
}
