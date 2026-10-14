/**
 * The in-memory `VersionedMemoryStore` (2.4): the reference semantics of the
 * store contract, for tests and one process. Every write runs under one mutex,
 * checks everything first and then applies all of it, so an operation is
 * all-or-nothing and two writers never interleave. State is copied in and out.
 */
import { EmbeddingMismatchError, OperationConflictError } from '../../errors';
import { isSha256Digest, type Sha256Digest } from '../../internal/digest';
import { notImplemented } from '../../internal/not-implemented';
import { resolveDependencies } from '../../internal/resolve-deps';
import { cosineSimilarity, rankFuse } from '../../internal/vector';
import type { Dependencies } from '../../types/deps';
import {
  Mutex,
  checkImportance,
  checkLinks,
  checkMetadata,
  checkScope,
  checkSources,
  checkTime,
  copy,
  invalid,
  isMemoryKind,
  lexicalScore,
  isOrigin,
  recordDigest,
  scopeKey,
  textDigest,
} from './shared';
import type {
  MemoryEmbeddingGeneration,
  VersionedMemoryCommit,
  VersionedMemoryCommitResult,
  VersionedMemoryHit,
  VersionedMemoryMutation,
  VersionedMemoryReceipt,
  VersionedMemoryRecord,
  VersionedMemoryStore,
  VersionedMemoryVector,
} from './types';

const ACTORS: readonly string[] = ['host', 'model', 'extraction', 'import'];

/** One stored revision: the record as written (no embedding meta) and its text digest. */
interface StoredRevision {
  record: VersionedMemoryRecord;
  textDigest: Sha256Digest;
}

/** A vector of one revision in one generation. */
interface StoredVector {
  vector: number[];
  textDigest: Sha256Digest;
}

type Conflict = { id: string; expectedRevision: number; actualRevision?: number };

/** A mutation checked and resolved against the current state, ready to apply. */
interface PlannedWrite {
  id: string;
  entryType: VersionedMemoryMutation['type'];
  next: StoredRevision;
  /** The vector the commit carries for the new revision. */
  vector?: VersionedMemoryVector;
  /** Copy the previous revision's vectors (its text is unchanged). */
  carryFrom?: number;
}

const vectorKey = (key: string, id: string, revision: number): string =>
  JSON.stringify([key, id, revision]);

function checkVector(vector: unknown, what: string): VersionedMemoryVector {
  const value = vector as VersionedMemoryVector | null;
  if (value === null || typeof value !== 'object')
    throw invalid(`${what} embedding must be an object.`);
  if (typeof value.modelId !== 'string' || value.modelId === '')
    throw invalid(`${what} embedding needs a modelId.`);
  if (!isSha256Digest(value.textDigest))
    throw invalid(`${what} embedding needs a sha256:<hex> textDigest.`);
  if (
    !Array.isArray(value.vector) ||
    value.vector.length === 0 ||
    value.vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  )
    throw invalid(`${what} embedding needs a non-empty vector of finite numbers.`);
  return { vector: [...value.vector], modelId: value.modelId, textDigest: value.textDigest };
}

/**
 * The in-memory `VersionedMemoryStore` (2.4): the reference for tests and one
 * process. Copies in and out, real receipts, compare-and-set and replay, and
 * simple text matching plus cosine over the active generation's vectors.
 */
export function createInMemoryVersionedMemoryStore(options?: {
  deps?: Dependencies;
}): VersionedMemoryStore {
  const deps = resolveDependencies(options?.deps);
  const mutex = new Mutex();
  /** scope key → record id → revisions, oldest first. */
  const records = new Map<string, Map<string, StoredRevision[]>>();
  /** scope key → ids of forgotten records: never recreated. */
  const forgotten = new Map<string, Set<string>>();
  const scopeRevisions = new Map<string, number>();
  const receipts = new Map<string, VersionedMemoryReceipt>();
  const generations: MemoryEmbeddingGeneration[] = [];
  /** generation → vector key → vector. */
  const vectors = new Map<number, Map<string, StoredVector>>();

  const activeGeneration = (): MemoryEmbeddingGeneration | undefined =>
    generations.find((generation) => generation.status === 'active');

  const revisionsOf = (key: string, id: string): StoredRevision[] | undefined =>
    records.get(key)?.get(id);

  /** A revision as read: a copy, with the active generation's vector meta when it has one. */
  function present(key: string, stored: StoredRevision): VersionedMemoryRecord {
    const record = copy(stored.record);
    const active = activeGeneration();
    const vector =
      active && vectors.get(active.generation)?.get(vectorKey(key, record.id, record.revision));
    if (active && vector)
      record.embedding = {
        generation: active.generation,
        modelId: active.modelId,
        dims: active.dims,
        revision: record.revision,
        textDigest: vector.textDigest,
      };
    return record;
  }

  async function planCreate(
    mutation: Extract<VersionedMemoryMutation, { type: 'create' }>,
    operation: VersionedMemoryCommit,
    scope: VersionedMemoryRecord['scope'],
    now: number,
    what: string,
  ): Promise<PlannedWrite> {
    const input = mutation.record as Partial<typeof mutation.record> | undefined;
    if (input === null || typeof input !== 'object') throw invalid(`${what} needs a record.`);
    if (typeof input.id !== 'string' || input.id === '')
      throw invalid(`${what} needs a record id.`);
    if (typeof input.text !== 'string') throw invalid(`${what} needs a text.`);
    if (!isOrigin(input.origin)) throw invalid(`${what} origin must be 'asserted' or 'inferred'.`);
    if (input.kind !== undefined && !isMemoryKind(input.kind))
      throw invalid(`${what} has an unknown kind.`);
    const sources = checkSources(input.sources, what);
    const links = checkLinks(input.links, what);
    const importance = checkImportance(input.importance, what);
    const expiresAt = checkTime(input.expiresAt, `${what} expiresAt`);
    const metadata = checkMetadata(input.metadata, what);
    const record: VersionedMemoryRecord = {
      id: input.id,
      revision: 1,
      scope,
      text: input.text,
      kind: input.kind ?? 'semantic',
      origin: input.origin,
      sources,
      status: 'active',
      ...(importance !== undefined ? { importance } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(links !== undefined ? { links } : {}),
      ...(metadata !== undefined ? { metadata: copy(metadata) } : {}),
      operationId: operation.operationId,
      recordedAt: now,
      createdAt: now,
      digest: '' as Sha256Digest,
    };
    record.digest = await recordDigest(record);
    return {
      id: input.id,
      entryType: 'create',
      next: { record, textDigest: await textDigest(record.text) },
      ...(mutation.embedding !== undefined
        ? { vector: checkVector(mutation.embedding, what) }
        : {}),
    };
  }

  async function planChange(
    mutation: Exclude<VersionedMemoryMutation, { type: 'create' }>,
    previous: StoredRevision,
    operation: VersionedMemoryCommit,
    now: number,
    what: string,
  ): Promise<PlannedWrite> {
    const prior = previous.record;
    const record: VersionedMemoryRecord = {
      ...copy(prior),
      revision: prior.revision + 1,
      operationId: operation.operationId,
      recordedAt: now,
    };
    let vector: VersionedMemoryVector | undefined;
    if (mutation.type === 'retract') {
      record.status = 'retracted';
    } else {
      const changes = mutation.changes as typeof mutation.changes | undefined;
      if (changes === null || typeof changes !== 'object') throw invalid(`${what} needs changes.`);
      if (changes.text !== undefined) {
        if (typeof changes.text !== 'string') throw invalid(`${what} text must be a string.`);
        record.text = changes.text;
      }
      if (changes.kind !== undefined) {
        if (!isMemoryKind(changes.kind)) throw invalid(`${what} has an unknown kind.`);
        record.kind = changes.kind;
      }
      const importance = checkImportance(changes.importance, what);
      if (importance !== undefined) record.importance = importance;
      if (changes.expiresAt === null) delete record.expiresAt;
      else {
        const expiresAt = checkTime(changes.expiresAt, `${what} expiresAt`);
        if (expiresAt !== undefined) record.expiresAt = expiresAt;
      }
      const links = checkLinks(changes.links, what);
      if (links !== undefined) record.links = links;
      if (changes.metadata === null) delete record.metadata;
      else {
        const metadata = checkMetadata(changes.metadata, what);
        if (metadata !== undefined) record.metadata = copy(metadata);
      }
      if (changes.sources !== undefined) record.sources = checkSources(changes.sources, what);
      if (mutation.embedding !== undefined) vector = checkVector(mutation.embedding, what);
    }
    record.digest = await recordDigest(record);
    const digest = record.text === prior.text ? previous.textDigest : await textDigest(record.text);
    return {
      id: mutation.id,
      entryType: mutation.type,
      next: { record, textDigest: digest },
      ...(vector !== undefined ? { vector } : {}),
      // A vector belongs to its exact text: an unchanged text keeps the old one.
      ...(digest === previous.textDigest ? { carryFrom: prior.revision } : {}),
    };
  }

  async function commit(operation: VersionedMemoryCommit): Promise<VersionedMemoryCommitResult> {
    if (operation === null || typeof operation !== 'object')
      throw invalid('A versioned memory commit must be an object.');
    if (typeof operation.operationId !== 'string' || operation.operationId === '')
      throw invalid('A versioned memory commit needs an operationId.');
    const scope = checkScope(operation.scope);
    if (!isSha256Digest(operation.requestDigest))
      throw invalid('A versioned memory commit needs a sha256:<hex> requestDigest.');
    if (!ACTORS.includes(operation.actor))
      throw invalid('A versioned memory commit needs an actor (host, model, extraction, import).');
    if (!Array.isArray(operation.mutations))
      throw invalid('A versioned memory commit needs a mutations array.');
    if (
      operation.expectedScopeRevision !== undefined &&
      (!Number.isSafeInteger(operation.expectedScopeRevision) ||
        operation.expectedScopeRevision < 0)
    )
      throw invalid('expectedScopeRevision must be a non-negative integer.');
    const key = scopeKey(scope);

    return mutex.run(async () => {
      const stored = receipts.get(operation.operationId);
      if (stored) {
        if (stored.requestDigest === operation.requestDigest && scopeKey(stored.scope) === key)
          return { status: 'replayed', receipt: copy(stored) };
        throw new OperationConflictError({
          subsystem: 'memory',
          operationId: operation.operationId,
          storedDigest: stored.requestDigest,
          requestDigest: operation.requestDigest,
        });
      }

      const now = deps.clock.now();
      const seen = new Set<string>();
      const conflicts: Conflict[] = [];
      const planned: PlannedWrite[] = [];
      for (const [index, mutation] of operation.mutations.entries()) {
        const what = `Mutation ${index}`;
        if (mutation === null || typeof mutation !== 'object')
          throw invalid(`${what} must be an object.`);
        if (mutation.type === 'create') {
          const write = await planCreate(mutation, operation, scope, now, what);
          if (seen.has(write.id)) throw invalid(`${what} touches record ${write.id} twice.`);
          seen.add(write.id);
          const current = revisionsOf(key, write.id);
          if (current || forgotten.get(key)?.has(write.id))
            conflicts.push({
              id: write.id,
              expectedRevision: 0,
              ...(current ? { actualRevision: current.at(-1)!.record.revision } : {}),
            });
          else planned.push(write);
          continue;
        }
        if (mutation.type !== 'revise' && mutation.type !== 'retract')
          throw invalid(`${what} has an unknown type.`);
        if (typeof mutation.id !== 'string' || mutation.id === '')
          throw invalid(`${what} needs an id.`);
        if (!Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 1)
          throw invalid(`${what} needs a positive expectedRevision.`);
        if (seen.has(mutation.id)) throw invalid(`${what} touches record ${mutation.id} twice.`);
        seen.add(mutation.id);
        const current = revisionsOf(key, mutation.id);
        const latest = current?.at(-1);
        if (!latest) {
          conflicts.push({ id: mutation.id, expectedRevision: mutation.expectedRevision });
          continue;
        }
        if (latest.record.revision !== mutation.expectedRevision) {
          conflicts.push({
            id: mutation.id,
            expectedRevision: mutation.expectedRevision,
            actualRevision: latest.record.revision,
          });
          continue;
        }
        planned.push(await planChange(mutation, latest, operation, now, what));
      }

      // Vectors: each must be of the final text, and of the active generation's model and size.
      let active = activeGeneration();
      let created: MemoryEmbeddingGeneration | undefined;
      for (const write of planned) {
        if (!write.vector) continue;
        if (write.vector.textDigest !== write.next.textDigest)
          throw invalid(
            `The embedding of record ${write.id} was computed from another text than its revision ${write.next.record.revision}.`,
          );
        const expected = active ?? created;
        if (!expected) {
          created = {
            generation: generations.reduce((max, item) => Math.max(max, item.generation), 0) + 1,
            modelId: write.vector.modelId,
            dims: write.vector.vector.length,
            status: 'active',
            createdAt: now,
          };
          continue;
        }
        if (
          write.vector.modelId !== expected.modelId ||
          write.vector.vector.length !== expected.dims
        )
          throw new EmbeddingMismatchError({
            expected: {
              modelId: expected.modelId,
              dims: expected.dims,
              generation: expected.generation,
            },
            actual: { modelId: write.vector.modelId, dims: write.vector.vector.length },
          });
      }

      const scopeRevision = scopeRevisions.get(key) ?? 0;
      if (
        conflicts.length > 0 ||
        (operation.expectedScopeRevision !== undefined &&
          operation.expectedScopeRevision !== scopeRevision)
      )
        return { status: 'conflict', scopeRevision, conflicts };

      // Everything is checked: apply it all, nothing below can fail.
      if (created) {
        generations.push(created);
        active = created;
      }
      let scopeRecords = records.get(key);
      if (!scopeRecords) records.set(key, (scopeRecords = new Map()));
      for (const write of planned) {
        const history = scopeRecords.get(write.id) ?? [];
        history.push(write.next);
        scopeRecords.set(write.id, history);
        const revision = write.next.record.revision;
        if (write.carryFrom !== undefined) {
          for (const byKey of vectors.values()) {
            const previous = byKey.get(vectorKey(key, write.id, write.carryFrom));
            if (previous) byKey.set(vectorKey(key, write.id, revision), previous);
          }
        }
        if (write.vector && active) {
          let byKey = vectors.get(active.generation);
          if (!byKey) vectors.set(active.generation, (byKey = new Map()));
          byKey.set(vectorKey(key, write.id, revision), {
            vector: write.vector.vector,
            textDigest: write.vector.textDigest,
          });
        }
      }
      const receipt: VersionedMemoryReceipt = {
        operationId: operation.operationId,
        scope,
        actor: operation.actor,
        requestDigest: operation.requestDigest,
        scopeRevision: scopeRevision + 1,
        entries: planned.map((write) => ({
          type: write.entryType,
          id: write.id,
          revision: write.next.record.revision,
        })),
        committedAt: now,
      };
      scopeRevisions.set(key, scopeRevision + 1);
      receipts.set(operation.operationId, receipt);
      return { status: 'committed', receipt: copy(receipt) };
    });
  }

  return {
    commit,

    async get(scope, id, getOptions) {
      const key = scopeKey(checkScope(scope));
      const history = revisionsOf(key, id);
      if (!history) return undefined;
      const stored =
        getOptions?.revision !== undefined
          ? history.find((item) => item.record.revision === getOptions.revision)
          : history.at(-1);
      if (!stored) return undefined;
      if (stored.record.status === 'retracted' && !getOptions?.includeRetracted) return undefined;
      return present(key, stored);
    },

    async search(query) {
      if (query === null || typeof query !== 'object') throw invalid('A search needs a query.');
      const key = scopeKey(checkScope(query.scope));
      const topK = query.topK ?? 5;
      if (!Number.isSafeInteger(topK) || topK < 0)
        throw invalid('topK must be a non-negative integer.');
      const now = checkTime(query.now, 'now') ?? deps.clock.now();
      const asOf = checkTime(query.recordedAsOf, 'recordedAsOf');
      const active = activeGeneration();
      let queryVector: number[] | undefined;
      if (query.embedding !== undefined) {
        const { vector, modelId } = query.embedding;
        if (
          typeof modelId !== 'string' ||
          !Array.isArray(vector) ||
          vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))
        )
          throw invalid('A query embedding needs a modelId and a vector of finite numbers.');
        if (active && (modelId !== active.modelId || vector.length !== active.dims))
          throw new EmbeddingMismatchError({
            expected: { modelId: active.modelId, dims: active.dims, generation: active.generation },
            actual: { modelId, dims: vector.length },
          });
        if (active) queryVector = vector;
      }

      const candidates: StoredRevision[] = [];
      for (const history of records.get(key)?.values() ?? []) {
        const stored =
          asOf === undefined
            ? history.at(-1)
            : history.findLast((item) => item.record.recordedAt <= asOf);
        if (!stored) continue;
        const record = stored.record;
        if (record.status === 'retracted' && !query.includeRetracted) continue;
        if (record.expiresAt !== undefined && record.expiresAt <= now && !query.includeExpired)
          continue;
        if (query.kind !== undefined && record.kind !== query.kind) continue;
        candidates.push(stored);
      }
      const newestFirst = (left: StoredRevision, right: StoredRevision): number =>
        right.record.recordedAt - left.record.recordedAt ||
        (left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0);
      const ranked = (scored: { stored: StoredRevision; score: number }[]) =>
        scored.sort(
          (left, right) => right.score - left.score || newestFirst(left.stored, right.stored),
        );

      const text = query.text?.trim();
      const lexical = text
        ? ranked(
            candidates.map((stored) => ({ stored, score: lexicalScore(text, stored.record.text) })),
          ).filter((item) => item.score > 0)
        : undefined;
      let vectorHits: { stored: StoredRevision; score: number }[] | undefined;
      if (queryVector && active) {
        const byKey = vectors.get(active.generation);
        const scored: { stored: StoredRevision; score: number }[] = [];
        for (const stored of candidates) {
          const vector = byKey?.get(vectorKey(key, stored.record.id, stored.record.revision));
          if (vector) scored.push({ stored, score: cosineSimilarity(queryVector, vector.vector) });
        }
        vectorHits = ranked(scored);
      }

      let hits: VersionedMemoryHit[];
      if (lexical && vectorHits) {
        const name = (item: { stored: StoredRevision }) => item.stored.record.id;
        const fused = rankFuse([
          { key: name, items: lexical },
          { key: name, items: vectorHits },
        ]);
        const inText = new Set(lexical.map(name));
        const inVector = new Set(vectorHits.map(name));
        const byId = new Map([...lexical, ...vectorHits].map((item) => [name(item), item.stored]));
        hits = [...byId]
          .map(([id, stored]) => ({
            stored,
            score: fused.get(id) ?? 0,
            match: (inText.has(id) && inVector.has(id)
              ? 'hybrid'
              : inText.has(id)
                ? 'lexical'
                : 'vector') as VersionedMemoryHit['match'],
          }))
          .sort((left, right) => right.score - left.score || newestFirst(left.stored, right.stored))
          .map((item) => ({
            record: present(key, item.stored),
            score: item.score,
            match: item.match,
          }));
      } else if (lexical) {
        hits = lexical.map((item) => ({
          record: present(key, item.stored),
          score: item.score,
          match: 'lexical',
        }));
      } else if (vectorHits) {
        hits = vectorHits.map((item) => ({
          record: present(key, item.stored),
          score: item.score,
          match: 'vector',
        }));
      } else if (query.embedding !== undefined) {
        // A vector query with no generation yet: nothing has a vector to match.
        hits = [];
      } else {
        hits = candidates
          .sort(newestFirst)
          .map((stored) => ({ record: present(key, stored), score: 0, match: 'lexical' }));
      }
      return hits.slice(0, topK);
    },

    async history(scope, id) {
      const key = scopeKey(checkScope(scope));
      return (revisionsOf(key, id) ?? []).map((stored) => present(key, stored));
    },

    async receipt(operationId) {
      const stored = receipts.get(operationId);
      return stored ? copy(stored) : undefined;
    },

    async scopeRevision(scope) {
      return scopeRevisions.get(scopeKey(checkScope(scope))) ?? 0;
    },

    async forget() {
      return notImplemented('VersionedMemoryStore.forget');
    },

    embeddings: {
      async active() {
        const active = activeGeneration();
        return active ? copy(active) : undefined;
      },
      async begin() {
        return notImplemented('VersionedMemoryStore.embeddings.begin');
      },
      async pending() {
        return notImplemented('VersionedMemoryStore.embeddings.pending');
      },
      async put() {
        return notImplemented('VersionedMemoryStore.embeddings.put');
      },
      async activate() {
        return notImplemented('VersionedMemoryStore.embeddings.activate');
      },
    },

    async pruneHistory() {
      return notImplemented('VersionedMemoryStore.pruneHistory');
    },

    async pruneOperations() {
      return notImplemented('VersionedMemoryStore.pruneOperations');
    },

    async close() {},
  };
}
