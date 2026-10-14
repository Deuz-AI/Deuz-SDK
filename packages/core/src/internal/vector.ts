/**
 * internal/vector.ts — the ONE vector-math module (2.0).
 *
 * `cosineSimilarity` used to exist TWICE, byte-identical, in `memory.ts` and
 * `rag.ts`; both now re-export this implementation, so the public surface of
 * either subpath is unchanged while there is a single place to fix a rounding
 * or zero-vector decision. On top of it sit the two primitives the persistent
 * stores need but neither feature module owned: a Float32 BLOB codec (SQLite /
 * Postgres store an embedding as bytes, not a JSON array) and a tiny Reciprocal
 * Rank Fusion helper for in-store hybrid search.
 *
 * PURE + edge-safe: no clock, no randomness, no I/O — `Math.sqrt` and
 * `DataView` only.
 */

/** Pure cosine similarity (edge-safe Float math). Returns 0 on length mismatch / zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Encode an embedding as a little-endian Float32 byte blob — the storage form
 * for a SQLite `BLOB` / Postgres `bytea` column (4 bytes per dimension instead
 * of the ~12–20 a JSON array costs).
 *
 * Endianness is written EXPLICITLY through a `DataView`: a raw
 * `new Float32Array(v).buffer` would inherit the host's byte order, so a blob
 * written on x64 and read on a big-endian host would decode as garbage. The
 * precision loss is float64 → float32, which is below the noise floor of every
 * embedding model we support and is what pgvector stores natively anyway.
 */
export function encodeVector(v: number[]): Uint8Array {
  const bytes = new Uint8Array(v.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i]!, /* littleEndian */ true);
  return bytes;
}

/**
 * Reverse of {@link encodeVector}. A trailing partial float (a truncated blob)
 * is IGNORED rather than decoded as NaN — a short read must not poison a whole
 * similarity ranking. Honors `byteOffset`, so a view into a larger buffer (what
 * most database drivers hand back) decodes correctly.
 */
export function decodeVector(bytes: Uint8Array): number[] {
  const count = Math.floor(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  return out;
}

/** One ranked input list for {@link rankFuse}: how to identify an item + the ranking itself. */
export interface RankFuseList<T> {
  /** Stable identity of an item ACROSS lists (a record id, a chunk key, …). */
  key: (item: T) => string;
  /** The ranking, best-first. Only the ORDER matters — raw scores are ignored. */
  items: T[];
}

/**
 * Reciprocal Rank Fusion over keyed lists: every list votes `1 / (k + rank)`
 * for each item it ranks, and the votes sum. Order is all that matters — a
 * BM25/FTS5 score and a cosine score are not comparable, so fusing the ranks is
 * the only sound merge.
 *
 * The sibling of `reciprocalRankFusion` (`../rag`), which fuses `ScoredChunk[]`
 * and returns chunks. This one is deliberately dumber: it returns just
 * `key → fused score`, because a store's hybrid query fuses ROWS it then has to
 * re-hydrate by id anyway. `k` defaults to 60 (the canonical value).
 */
export function rankFuse<T>(lists: RankFuseList<T>[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.items.forEach((item, rank) => {
      const key = list.key(item);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

/**
 * Why a stored vector is left out of a vector ranking (2.4, spec §2.2): it
 * has none (`'missing'`), it has another length than the query's (`'dims'`),
 * or both sides name their embedding model and the names differ (`'model'`).
 */
export type VectorExclusion = 'missing' | 'dims' | 'model';

/** A vector and the model that produced it, as a store holds it. */
export interface ModelVector {
  vector?: number[] | null;
  modelId?: string | null;
}

/** `'unknown'` is what `memoryEmbedderFromRag` pins without a `modelId`: it names no model. */
function namesModel(modelId: string | null | undefined): modelId is string {
  return typeof modelId === 'string' && modelId !== '' && modelId !== 'unknown';
}

/**
 * Whether `stored` may be compared with the query vector (2.4), and if not,
 * why. `cosineSimilarity` answers 0 for a length mismatch, which used to let
 * such a record into a ranking as a score-0 filler; the 2.4 legacy stores
 * ask this first instead.
 */
export function vectorExclusion(
  stored: ModelVector,
  query: { vector: number[]; modelId?: string },
): VectorExclusion | undefined {
  const vector = stored.vector;
  if (!vector || vector.length === 0) return 'missing';
  if (vector.length !== query.vector.length) return 'dims';
  if (namesModel(stored.modelId) && namesModel(query.modelId) && stored.modelId !== query.modelId)
    return 'model';
  return undefined;
}

/** What {@link rankByVector} made of a candidate list. */
export interface VectorRanking<T> {
  /** The comparable items with their cosine, best first; ties keep the input order. */
  ranked: { item: T; score: number }[];
  /** The items left out: no vector, or one of another length or model. Input order. */
  excluded: T[];
  /** How many of `excluded` carry a vector of another length or model. */
  mismatched: number;
}

/**
 * Cosine-ranks the candidates that may be compared with the query vector
 * (2.4) and sets the others aside, so a store can look them up by text
 * instead of filling its topK with them at score 0.
 */
export function rankByVector<T>(
  items: readonly T[],
  vectorOf: (item: T) => ModelVector,
  query: { vector: number[]; modelId?: string },
): VectorRanking<T> {
  const ranked: { item: T; score: number }[] = [];
  const excluded: T[] = [];
  let mismatched = 0;
  for (const item of items) {
    const stored = vectorOf(item);
    const exclusion = vectorExclusion(stored, query);
    if (exclusion === undefined) {
      ranked.push({ item, score: cosineSimilarity(query.vector, stored.vector!) });
      continue;
    }
    excluded.push(item);
    if (exclusion !== 'missing') mismatched++;
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, excluded, mismatched };
}
