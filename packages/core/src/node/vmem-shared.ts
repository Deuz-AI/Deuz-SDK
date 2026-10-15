/**
 * What the SQLite and PostgreSQL versioned memory stores share (2.4): the
 * scope key, input checks, the commit planner, record and receipt encoding,
 * and the search pieces (query tokens, cosine ranking, rank fusion), so the
 * two backends answer the same operation the same way.
 *
 * The planner is pure apart from WebCrypto digests. A store reads a snapshot
 * of what an operation touches (its scope revision, the records it names, the
 * active embedding generation), plans against it, and applies the plan in one
 * transaction after checking the snapshot still holds. Node-only by location;
 * it imports nothing from `node:`.
 */
import type { MemoryKind, MemoryScope } from '../memory';
import type {
  MemoryEmbeddingGeneration,
  MemoryEmbeddingMeta,
  MemoryOrigin,
  VersionedMemoryActor,
  VersionedMemoryCommit,
  VersionedMemoryCommitResult,
  VersionedMemoryHit,
  VersionedMemoryQuery,
  VersionedMemoryReceipt,
  VersionedMemoryReceiptEntry,
  VersionedMemoryRecord,
  VersionedMemoryVector,
} from '../memory/versioned/types';
import type { Clock, Logger } from '../types/deps';
import type { Observer } from '../types/observe';
import { EmbeddingMismatchError, InvalidRequestError, OperationConflictError } from '../errors';
import { canonicalJson, digestJson, sha256Digest, type Sha256Digest } from '../internal/digest';
import { cosineSimilarity, rankFuse } from '../internal/vector';
import { resolveDependencies } from '../internal/resolve-deps';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan } from '../internal/telemetry';

/** The schema-meta name: the version lives in `deuz_vmem_schema`. */
export const VMEM_SCHEMA_NAME = 'deuz_vmem';
/** The version this build writes. */
export const VMEM_SCHEMA_VERSION = 1;

/** Default `topK`. */
export const DEFAULT_TOP_K = 5;
/** Rows each list of a hybrid query ranks before they are fused. */
export const FUSION_WINDOW = 20;
/** At most this many query words reach the lexical index. */
const MAX_QUERY_TOKENS = 32;

const SCOPE_FIELDS = ['userId', 'agentId', 'runId', 'actorId', 'chatId'] as const;
const KINDS: ReadonlySet<string> = new Set(['episodic', 'semantic', 'working', 'procedural']);
const ORIGINS: ReadonlySet<string> = new Set(['asserted', 'inferred']);
const ACTORS: ReadonlySet<string> = new Set(['host', 'model', 'extraction', 'import']);

/** No-op logger for a store built without one. */
export const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The host clock, for a store built without one. */
export const HOST_CLOCK: Pick<Clock, 'now'> = { now: () => Date.now() };

// ===================================================================
// Scopes and input checks
// ===================================================================

/** A copy of the scope's set fields; throws when none is set (the legacy memory rule). */
export function normalizeScope(scope: MemoryScope): MemoryScope {
  const out: MemoryScope = {};
  for (const field of SCOPE_FIELDS) {
    const value = (scope as Record<string, unknown> | undefined)?.[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string')
      throw new InvalidRequestError({ message: `MemoryScope.${field} must be a string.` });
    out[field] = value;
  }
  if (Object.keys(out).length === 0)
    throw new InvalidRequestError({
      message:
        'A versioned memory scope needs at least one of userId / agentId / runId / actorId / chatId.',
    });
  return out;
}

/** The scope's identity in a table: the canonical JSON of its set fields. */
export function scopeKey(scope: MemoryScope): string {
  return canonicalJson(normalizeScope(scope));
}

function invalid(message: string): never {
  throw new InvalidRequestError({ message });
}

function assertRevisionNumber(value: unknown, what: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    invalid(`${what} must be a positive integer.`);
}

function assertVectorShape(vector: VersionedMemoryVector | undefined, id: string): void {
  if (vector === undefined) return;
  if (
    !Array.isArray(vector.vector) ||
    vector.vector.length === 0 ||
    !vector.vector.every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    invalid(`The vector for memory '${id}' must be a non-empty array of finite numbers.`);
  if (typeof vector.modelId !== 'string' || vector.modelId === '')
    invalid(`The vector for memory '${id}' needs its modelId.`);
  if (typeof vector.textDigest !== 'string')
    invalid(`The vector for memory '${id}' needs the textDigest of the text it embeds.`);
}

/** Rejects a malformed operation before anything is read. */
export function validateCommit(op: VersionedMemoryCommit): void {
  if (typeof op?.operationId !== 'string' || op.operationId === '')
    invalid('A versioned memory operation needs an operationId.');
  if (typeof op.requestDigest !== 'string' || (op.requestDigest as string) === '')
    invalid(`Operation '${op.operationId}' needs its requestDigest.`);
  if (!ACTORS.has(op.actor)) invalid(`Operation '${op.operationId}' has an unknown actor.`);
  if (
    op.expectedScopeRevision !== undefined &&
    (!Number.isSafeInteger(op.expectedScopeRevision) || op.expectedScopeRevision < 0)
  )
    invalid('expectedScopeRevision must be a non-negative integer.');
  normalizeScope(op.scope);
  if (!Array.isArray(op.mutations))
    invalid(`Operation '${op.operationId}' needs a mutations array.`);
  for (const mutation of op.mutations) {
    switch (mutation?.type) {
      case 'create': {
        const record = mutation.record;
        if (typeof record?.id !== 'string' || record.id === '')
          invalid('A create mutation needs a record id.');
        if (typeof record.text !== 'string') invalid(`Memory '${record.id}' needs a text.`);
        if (!ORIGINS.has(record.origin)) invalid(`Memory '${record.id}' has an unknown origin.`);
        if (!Array.isArray(record.sources)) invalid(`Memory '${record.id}' needs a sources array.`);
        if (record.kind !== undefined && !KINDS.has(record.kind))
          invalid(`Memory '${record.id}' has an unknown kind.`);
        assertVectorShape(mutation.embedding, record.id);
        break;
      }
      case 'revise': {
        if (typeof mutation.id !== 'string' || mutation.id === '')
          invalid('A revise mutation needs a record id.');
        assertRevisionNumber(mutation.expectedRevision, 'expectedRevision');
        const changes = mutation.changes ?? {};
        if (changes.text !== undefined && typeof changes.text !== 'string')
          invalid(`The new text of memory '${mutation.id}' must be a string.`);
        if (changes.kind !== undefined && !KINDS.has(changes.kind))
          invalid(`Memory '${mutation.id}' has an unknown kind.`);
        if (changes.sources !== undefined && !Array.isArray(changes.sources))
          invalid(`The sources of memory '${mutation.id}' must be an array.`);
        assertVectorShape(mutation.embedding, mutation.id);
        break;
      }
      case 'retract':
        if (typeof mutation.id !== 'string' || mutation.id === '')
          invalid('A retract mutation needs a record id.');
        assertRevisionNumber(mutation.expectedRevision, 'expectedRevision');
        break;
      default:
        invalid(`Operation '${op.operationId}' has a mutation of an unknown type.`);
    }
  }
}

/** The record ids an operation names, in order, once each. */
export function commitIds(op: VersionedMemoryCommit): string[] {
  const ids = op.mutations.map((m) => (m.type === 'create' ? m.record.id : m.id));
  return [...new Set(ids)];
}

// ===================================================================
// Records, receipts, digests
// ===================================================================

/** `sha256:<hex>` of a revision's canonical content (text, kind, origin, sources, links). */
export function recordDigest(record: {
  text: string;
  kind: MemoryKind;
  origin: MemoryOrigin;
  sources: unknown;
  links?: unknown;
}): Promise<Sha256Digest> {
  return digestJson({
    text: record.text,
    kind: record.kind,
    origin: record.origin,
    sources: record.sources,
    ...(record.links !== undefined ? { links: record.links } : {}),
  });
}

/** A revision as stored: everything but its embedding, which the active generation decides. */
export function encodeRecord(record: VersionedMemoryRecord): string {
  const { embedding: _embedding, ...stored } = record;
  return JSON.stringify(stored);
}

export function decodeRecord(json: string, embedding?: MemoryEmbeddingMeta): VersionedMemoryRecord {
  const record = JSON.parse(json) as VersionedMemoryRecord;
  return embedding ? { ...record, embedding } : record;
}

/** A receipt as stored: the receipt without its `redacted` flag, which has a column of its own. */
export function encodeReceipt(receipt: VersionedMemoryReceipt): string {
  const { redacted: _redacted, ...stored } = receipt;
  return JSON.stringify(stored);
}

export function decodeReceipt(json: string, redacted: boolean): VersionedMemoryReceipt {
  const receipt = JSON.parse(json) as VersionedMemoryReceipt;
  return redacted ? { ...receipt, redacted: true } : receipt;
}

export function embeddingMeta(
  generation: MemoryEmbeddingGeneration,
  revision: number,
  textDigest: Sha256Digest,
): MemoryEmbeddingMeta {
  return {
    generation: generation.generation,
    modelId: generation.modelId,
    dims: generation.dims,
    revision,
    textDigest,
  };
}

/** The answer to a repeated operation id: replay when the request matches, refuse when not. */
export function replayOrRefuse(
  op: VersionedMemoryCommit,
  stored: VersionedMemoryReceipt,
): VersionedMemoryCommitResult {
  if (stored.requestDigest === op.requestDigest) return { status: 'replayed', receipt: stored };
  throw new OperationConflictError({
    subsystem: 'memory',
    operationId: op.operationId,
    storedDigest: stored.requestDigest,
    requestDigest: op.requestDigest,
  });
}

// ===================================================================
// Forget as an operation
// ===================================================================

/**
 * The request digest of a forget, as the in-memory reference computes it: a
 * repeated operation id replays on the same scope and record, and conflicts
 * otherwise (with a commit's id too).
 */
export function forgetRequestDigest(scope: MemoryScope, id: string): Promise<Sha256Digest> {
  return digestJson({ type: 'forget', scope, id });
}

/** What a SQL forget transaction found: the revisions it deleted, or that the scope's record was gone before. */
export interface ForgetOutcome {
  revisions: number[];
  alreadyForgotten: boolean;
}

/** Throws `OperationConflictError` when `stored` is not the receipt of this same forget. */
export function refuseForeignForget(
  stored: VersionedMemoryReceipt,
  operationId: string,
  requestDigest: Sha256Digest,
): void {
  if (stored.requestDigest !== requestDigest)
    throw new OperationConflictError({
      subsystem: 'memory',
      operationId,
      storedDigest: stored.requestDigest,
      requestDigest,
    });
}

/** The content-free receipt a committed forget leaves, whether or not it deleted anything. */
export function forgetReceipt(
  scope: MemoryScope,
  operationId: string,
  requestDigest: Sha256Digest,
  scopeRevision: number,
  committedAt: number,
): VersionedMemoryReceipt {
  return {
    operationId,
    scope,
    actor: 'host',
    requestDigest,
    scopeRevision,
    entries: [],
    committedAt,
  };
}

// ===================================================================
// The commit planner
// ===================================================================

/** What a store found under an id the operation names. */
export type RecordLookup =
  | { state: 'live'; scopeKey: string; current: VersionedMemoryRecord }
  | { state: 'forgotten'; scopeKey: string };

/** The state an operation is planned against. */
export interface CommitSnapshot {
  scopeRevision: number;
  /** The ids the operation names; an id absent here is unknown to the store. */
  records: ReadonlyMap<string, RecordLookup>;
  active?: MemoryEmbeddingGeneration;
}

/** A vector the plan stores in the active generation. */
export interface PlannedVector {
  id: string;
  revision: number;
  textDigest: Sha256Digest;
  vector: number[];
}

/** A vector copied from one revision to the next: same text, so it still describes it. */
export interface CarriedVector {
  id: string;
  fromRevision: number;
  toRevision: number;
  textDigest: Sha256Digest;
}

export type CommitPlan =
  | { kind: 'conflict'; result: Extract<VersionedMemoryCommitResult, { status: 'conflict' }> }
  | {
      kind: 'apply';
      scopeKey: string;
      /** New revisions in order; the last one per id is that record's current revision. */
      revisions: VersionedMemoryRecord[];
      /** `sha256:<hex>` of each new revision's text, in the same order. */
      textDigests: Sha256Digest[];
      vectors: PlannedVector[];
      carried: CarriedVector[];
      /** No generation is active yet: the first vector's model and size start one. */
      generation?: { modelId: string; dims: number };
      receipt: VersionedMemoryReceipt;
    };

/** A fingerprint of the snapshot, compared inside the transaction before applying a plan. */
export function snapshotFingerprint(snapshot: CommitSnapshot, ids: readonly string[]): string {
  return JSON.stringify([
    snapshot.scopeRevision,
    snapshot.active?.generation ?? null,
    ids.map((id) => {
      const found = snapshot.records.get(id);
      if (!found) return null;
      return found.state === 'live'
        ? [found.scopeKey, found.current.revision]
        : ['forgotten', found.scopeKey];
    }),
  ]);
}

/**
 * Plans one operation (2.4 contract): conflicts when the scope revision or
 * any record revision no longer holds, or a create names an id that exists or
 * was forgotten; otherwise the new revisions, their vectors and the receipt.
 * A vector of another model or size than the active generation throws
 * `EmbeddingMismatchError`; one whose text digest is not the final text's
 * throws `InvalidRequestError`.
 */
export async function planCommit(
  snapshot: CommitSnapshot,
  op: VersionedMemoryCommit,
  now: number,
): Promise<CommitPlan> {
  const scope = normalizeScope(op.scope);
  const key = canonicalJson(scope);
  const conflicts: { id: string; expectedRevision: number; actualRevision?: number }[] = [];
  /** Records as this operation leaves them, mutation by mutation. */
  const working = new Map<string, VersionedMemoryRecord>();
  const created = new Set<string>();
  const revisions: VersionedMemoryRecord[] = [];
  const entries: VersionedMemoryReceiptEntry[] = [];
  const pendingVectors: {
    id: string;
    revision: number;
    text: string;
    vector: VersionedMemoryVector;
  }[] = [];
  const carried: CarriedVector[] = [];

  const lookup = (id: string): RecordLookup | undefined => snapshot.records.get(id);
  const current = (id: string): VersionedMemoryRecord | undefined => {
    const mine = working.get(id);
    if (mine) return mine;
    const found = lookup(id);
    return found?.state === 'live' && found.scopeKey === key ? found.current : undefined;
  };
  const conflictFor = (id: string, expectedRevision: number): void => {
    const found = lookup(id);
    const actual =
      working.get(id)?.revision ??
      (found?.state === 'live' && found.scopeKey === key ? found.current.revision : undefined);
    conflicts.push(
      actual === undefined
        ? { id, expectedRevision }
        : { id, expectedRevision, actualRevision: actual },
    );
  };

  for (const mutation of op.mutations) {
    if (mutation.type === 'create') {
      const input = mutation.record;
      if (working.has(input.id) || created.has(input.id) || lookup(input.id) !== undefined) {
        conflictFor(input.id, 0);
        continue;
      }
      const kind = input.kind ?? 'semantic';
      const record: VersionedMemoryRecord = {
        id: input.id,
        revision: 1,
        scope,
        text: input.text,
        kind,
        origin: input.origin,
        sources: structuredCloneJson(input.sources),
        status: 'active',
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.links !== undefined ? { links: structuredCloneJson(input.links) } : {}),
        ...(input.metadata !== undefined ? { metadata: structuredCloneJson(input.metadata) } : {}),
        operationId: op.operationId,
        recordedAt: now,
        createdAt: now,
        digest: await recordDigest({ ...input, kind }),
      };
      created.add(input.id);
      working.set(input.id, record);
      revisions.push(record);
      entries.push({ type: 'create', id: record.id, revision: 1 });
      if (mutation.embedding)
        pendingVectors.push({
          id: record.id,
          revision: 1,
          text: record.text,
          vector: mutation.embedding,
        });
      continue;
    }

    const previous = current(mutation.id);
    if (!previous || previous.revision !== mutation.expectedRevision) {
      conflictFor(mutation.id, mutation.expectedRevision);
      continue;
    }
    const revision = previous.revision + 1;
    let next: VersionedMemoryRecord;
    if (mutation.type === 'retract') {
      next = {
        ...previous,
        revision,
        status: 'retracted',
        operationId: op.operationId,
        recordedAt: now,
      };
    } else {
      const changes = mutation.changes ?? {};
      const expiresAt =
        changes.expiresAt === null ? undefined : (changes.expiresAt ?? previous.expiresAt);
      const metadata =
        changes.metadata === null ? undefined : (changes.metadata ?? previous.metadata);
      const importance = changes.importance ?? previous.importance;
      const links = changes.links ?? previous.links;
      const content = {
        text: changes.text ?? previous.text,
        kind: changes.kind ?? previous.kind,
        origin: previous.origin,
        sources: structuredCloneJson(changes.sources ?? previous.sources),
        ...(links !== undefined ? { links: structuredCloneJson(links) } : {}),
      };
      const {
        importance: _i,
        expiresAt: _e,
        links: _l,
        metadata: _m,
        embedding: _v,
        ...base
      } = previous;
      next = {
        ...base,
        ...content,
        revision,
        ...(importance !== undefined ? { importance } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(metadata !== undefined ? { metadata: structuredCloneJson(metadata) } : {}),
        operationId: op.operationId,
        recordedAt: now,
        digest: await recordDigest(content),
      };
      if (mutation.embedding)
        pendingVectors.push({ id: next.id, revision, text: next.text, vector: mutation.embedding });
    }
    const vectorGiven = pendingVectors.some((v) => v.id === next.id && v.revision === revision);
    if (!vectorGiven && next.text === previous.text && !created.has(next.id))
      carried.push({
        id: next.id,
        fromRevision: previous.revision,
        toRevision: revision,
        textDigest: await sha256Digest(next.text),
      });
    working.set(next.id, next);
    revisions.push(next);
    entries.push({ type: mutation.type, id: next.id, revision });
  }

  const scopeMoved =
    op.expectedScopeRevision !== undefined && op.expectedScopeRevision !== snapshot.scopeRevision;
  if (conflicts.length > 0 || scopeMoved)
    return {
      kind: 'conflict',
      result: { status: 'conflict', scopeRevision: snapshot.scopeRevision, conflicts },
    };

  // Vectors: the final text's, in the active generation (or the one they start).
  let generation: { modelId: string; dims: number } | undefined;
  const target = (): { modelId: string; dims: number; generation?: number } | undefined =>
    snapshot.active
      ? {
          modelId: snapshot.active.modelId,
          dims: snapshot.active.dims,
          generation: snapshot.active.generation,
        }
      : generation;
  const vectors: PlannedVector[] = [];
  for (const planned of pendingVectors) {
    const { vector, modelId, textDigest } = planned.vector;
    const expected = target();
    if (expected && (expected.modelId !== modelId || expected.dims !== vector.length))
      throw new EmbeddingMismatchError({
        expected,
        actual: { modelId, dims: vector.length },
      });
    if (!expected) generation = { modelId, dims: vector.length };
    const digest = await sha256Digest(planned.text);
    if (textDigest !== digest)
      invalid(
        `The vector for memory '${planned.id}' was computed for another text: embed the final ` +
          'text of the revision and pass its digest.',
      );
    vectors.push({
      id: planned.id,
      revision: planned.revision,
      textDigest: digest,
      vector: [...vector],
    });
  }

  const digests = new Map<string, Sha256Digest>();
  const textDigests: Sha256Digest[] = [];
  for (const record of revisions) {
    let digest = digests.get(record.text);
    if (!digest) {
      digest = await sha256Digest(record.text);
      digests.set(record.text, digest);
    }
    textDigests.push(digest);
  }

  return {
    kind: 'apply',
    scopeKey: key,
    revisions,
    textDigests,
    vectors,
    carried,
    ...(generation ? { generation } : {}),
    receipt: {
      operationId: op.operationId,
      scope,
      actor: op.actor as VersionedMemoryActor,
      requestDigest: op.requestDigest,
      scopeRevision: snapshot.scopeRevision + 1,
      entries,
      committedAt: now,
    },
  };
}

/** A deep copy of plain JSON input, so a caller mutating its object later changes nothing stored. */
function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ===================================================================
// Search pieces
// ===================================================================

/**
 * The words of a query, lower-cased and unique: runs of letters and digits.
 * Both lexical indexes get the same words, OR-ed, so a long question still
 * matches a record that shares some of its words.
 */
export function queryTokens(text: string | undefined): string[] {
  if (!text) return [];
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_QUERY_TOKENS);
}

/**
 * Throws `EmbeddingMismatchError` when a query vector is not of the active
 * generation's model and size. Without an active generation nothing is
 * embedded yet, so there is nothing to mismatch: the query ranks no vectors.
 */
export function assertQueryVector(
  active: MemoryEmbeddingGeneration | undefined,
  embedding: VersionedMemoryQuery['embedding'],
): boolean {
  if (!embedding) return false;
  if (!active) return false;
  if (embedding.modelId !== active.modelId || embedding.vector.length !== active.dims)
    throw new EmbeddingMismatchError({
      expected: { modelId: active.modelId, dims: active.dims, generation: active.generation },
      actual: { modelId: embedding.modelId, dims: embedding.vector.length },
    });
  return true;
}

/** A candidate revision with the score of one list. */
export interface ScoredRevision {
  record: VersionedMemoryRecord;
  score: number;
}

/** Cosine-ranks candidates that carry a vector, best first, ties by recency then id. */
export function rankByCosine(
  candidates: readonly { record: VersionedMemoryRecord; vector: number[] }[],
  query: number[],
  take: number,
): ScoredRevision[] {
  return candidates
    .map((c) => ({ record: c.record, score: cosineSimilarity(query, c.vector) }))
    .sort(byScore)
    .slice(0, take);
}

export function byScore(a: ScoredRevision, b: ScoredRevision): number {
  return (
    b.score - a.score ||
    b.record.recordedAt - a.record.recordedAt ||
    (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0)
  );
}

/**
 * The hits of a query from its lists: a single list keeps its own scores; two
 * lists are fused by rank (RRF, k = 60), and an id both lists found is a
 * `'hybrid'` match.
 */
export function fuseHits(
  lexical: readonly ScoredRevision[] | undefined,
  vector: readonly ScoredRevision[] | undefined,
  topK: number,
): VersionedMemoryHit[] {
  if (!vector) return (lexical ?? []).slice(0, topK).map((hit) => ({ ...hit, match: 'lexical' }));
  if (!lexical) return vector.slice(0, topK).map((hit) => ({ ...hit, match: 'vector' }));
  const records = new Map<string, VersionedMemoryRecord>();
  for (const hit of [...vector, ...lexical]) records.set(hit.record.id, hit.record);
  const inLexical = new Set(lexical.map((hit) => hit.record.id));
  const inVector = new Set(vector.map((hit) => hit.record.id));
  const fused = rankFuse<ScoredRevision>([
    { key: (hit) => hit.record.id, items: [...lexical] },
    { key: (hit) => hit.record.id, items: [...vector] },
  ]);
  return [...fused.entries()]
    .map(([id, score]) => ({ record: records.get(id)!, score }))
    .sort(byScore)
    .slice(0, topK)
    .map((hit) => ({
      ...hit,
      match:
        inLexical.has(hit.record.id) && inVector.has(hit.record.id)
          ? ('hybrid' as const)
          : inVector.has(hit.record.id)
            ? ('vector' as const)
            : ('lexical' as const),
    }));
}

/**
 * Runs a store-level retention call as a `deuz.memory.op` span (spec §3.6)
 * when the store has an observer: the operation and how many rows it removed,
 * never content. The session reports its own operations; the store reports
 * only the maintenance a host calls on it directly.
 */
export function retentionSpan(
  observer: Observer | undefined,
  clock: Pick<Clock, 'now'>,
  operation: 'prune-history' | 'prune-operations',
  fn: () => Promise<number>,
): Promise<number> {
  if (!observer) return fn();
  const deps = resolveDependencies({
    observer,
    clock: {
      now: () => clock.now(),
      setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
  });
  return observeSpan(
    deps,
    DEUZ_SPAN.memoryOp,
    { [DEUZ_ATTR.memoryOperation]: operation },
    async (annotate) => {
      const count = await fn();
      annotate({ [DEUZ_ATTR.memoryOperation]: operation, [DEUZ_ATTR.memoryRecordCount]: count });
      return count;
    },
  );
}

/** The message `pruneOperations` warns with (shared with the in-memory store). */
export { pruneOperationsWarning } from '../memory/versioned/shared';

/** Checks `embeddings.begin` input. */
export function validateGeneration(request: { modelId: string; dims: number }): void {
  if (typeof request?.modelId !== 'string' || request.modelId === '')
    invalid('An embedding generation needs a modelId.');
  if (!Number.isSafeInteger(request.dims) || request.dims < 1)
    invalid('An embedding generation needs a positive integer dims.');
}

/** Checks one vector handed to `embeddings.put` against its generation's size. */
export function assertGenerationVector(
  generation: MemoryEmbeddingGeneration,
  vector: number[],
): void {
  if (
    !Array.isArray(vector) ||
    !vector.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
    vector.length !== generation.dims
  )
    throw new EmbeddingMismatchError({
      expected: {
        modelId: generation.modelId,
        dims: generation.dims,
        generation: generation.generation,
      },
      actual: { modelId: generation.modelId, dims: Array.isArray(vector) ? vector.length : 0 },
    });
}
