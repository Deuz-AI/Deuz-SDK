/**
 * `createMemorySession` (2.4, spec §2.1–§2.2): one scope over one
 * `VersionedMemoryStore`. Every write plans its mutations first — similar
 * records read, the memory LLM asked, the final texts embedded, all outside
 * the store — and then commits them as one operation with a receipt. A
 * revision conflict is planned again from a fresh read, up to
 * `maxConflictRetries` attempts. Edge-safe.
 */
import {
  EmbeddingMismatchError,
  OperationConflictError,
  RevisionConflictError,
} from '../../errors';
import { digestJson, type Sha256Digest } from '../../internal/digest';
import { resolveDependencies } from '../../internal/resolve-deps';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan } from '../../internal/telemetry';
import type { Embedder, MemoryKind, MemoryLLM } from '../../memory';
import type { AccountedMemoryEmbedder, AccountedMemoryLLM } from '../../types/accounting';
import { createMemoryCharging } from './accounting';
import {
  buildExtractionPrompt,
  buildReconcilePrompt,
  parseExtractedFacts,
  parseReconcileDecisions,
} from './prompts';
import { readExtractionSources } from './policy';
import {
  checkImportance,
  checkLinks,
  checkMetadata,
  checkScope,
  checkSources,
  copy,
  invalid,
  isMemoryKind,
  isOrigin,
  scopeKey,
  textDigest,
  throwIfAborted,
} from './shared';
import type {
  CreateMemorySessionOptions,
  MemoryExtractionInput,
  MemoryForgetListener,
  MemoryForgetResult,
  MemoryLink,
  MemoryOperationResult,
  MemoryOrigin,
  MemoryReembedItem,
  MemoryReembedOptions,
  MemoryReembedResult,
  MemoryRememberInput,
  MemorySession,
  MemorySourceRef,
  VersionedMemoryActor,
  VersionedMemoryCommitResult,
  VersionedMemoryMutation,
  VersionedMemoryReceipt,
  VersionedMemoryRecord,
  VersionedMemoryRevision,
} from './types';

/** Passes over the pending records before a re-embed call gives up for now (resumable). */
const REEMBED_PASSES = 3;

/** A fact to write, with the sources it rests on. */
export interface SessionFact {
  text: string;
  kind?: MemoryKind;
  importance?: number;
  sources: MemorySourceRef[];
}

/** How a set of facts is written (remember, extract and the model's tools share it). */
export interface FactWritePlan {
  origin: MemoryOrigin;
  mode: 'reconcile' | 'add';
  kind?: MemoryKind;
  importance?: number;
  ttlMs?: number;
  links?: MemoryLink[];
  metadata?: Record<string, unknown>;
  /** How many similar records reconciliation reads per fact. */
  topK: number;
}

/** What one operation commits. */
interface PlannedOperation {
  mutations: VersionedMemoryMutation[];
  expectedScopeRevision?: number;
}

interface OperationSpec {
  name: string;
  operationId: string;
  requestDigest: Sha256Digest;
  actor: VersionedMemoryActor;
  /** Re-plan on a conflict (reconciliation); false for a caller's own expected revision. */
  retry: boolean;
  signal?: AbortSignal;
  plan: () => Promise<PlannedOperation>;
}

/**
 * The parts of a session the model's tools write through: the same
 * operations, under another actor. Keyed by the session object, so only a
 * session made by `createMemorySession` exposes them.
 */
export interface SessionInternals {
  readonly defaultMode: 'reconcile' | 'add';
  writeFacts(
    facts: SessionFact[],
    plan: FactWritePlan,
    op: {
      name: string;
      operationId: string;
      requestDigest: Sha256Digest;
      actor: VersionedMemoryActor;
      signal?: AbortSignal;
    },
  ): Promise<MemoryOperationResult>;
  change(
    mutation: Exclude<VersionedMemoryMutation, { type: 'create' }>,
    op: {
      name: string;
      operationId: string;
      requestDigest: Sha256Digest;
      actor: VersionedMemoryActor;
      signal?: AbortSignal;
    },
  ): Promise<MemoryOperationResult>;
}

export const sessionInternals = new WeakMap<MemorySession, SessionInternals>();

/** The same source cited twice counts once. */
function mergeSources(sources: readonly MemorySourceRef[]): MemorySourceRef[] {
  const seen = new Set<string>();
  const out: MemorySourceRef[] = [];
  for (const source of sources) {
    const key = JSON.stringify([
      source.kind,
      source.digest,
      source.runId,
      source.chatId,
      source.messageId,
      source.toolCallId,
      source.toolName,
      source.uri,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function mergeLinks(...lists: (readonly MemoryLink[] | undefined)[]): MemoryLink[] | undefined {
  const seen = new Set<string>();
  const out: MemoryLink[] = [];
  for (const link of lists.flatMap((list) => list ?? [])) {
    const key = JSON.stringify([link.recordId, link.relation]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out.length > 0 ? out : undefined;
}

function checkTtl(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw invalid(`${what} ttlMs must be a positive number of milliseconds.`);
  return value;
}

/**
 * A memory session over one scope and one store (2.4).
 *
 * - `remember` (host): `origin` defaults to `'asserted'`; with
 *   `supersede: 'reconcile'` (the default) the LLM reconciles against the
 *   `topK` most similar records first, outside the transaction, and the vector
 *   is computed from the final text.
 * - `extract`: only the sources `options.extraction` allows (user messages,
 *   host input, trusted tools by default); every record is `'inferred'` and
 *   cites its messages by id and digest. Same options as `remember`.
 * - Every write commits one operation. A `'conflict'` answer is re-read and
 *   reconciled again, `maxConflictRetries` attempts in all (default 3), then
 *   throws `RevisionConflictError`; the same `operationId` with the same
 *   request returns the stored receipt (`replayed: true`), with another
 *   request throws `OperationConflictError`.
 * - `forget` commits first, then awaits every `onForget` listener in order;
 *   a listener failure leaves `redaction: 'failed'` and never undoes it.
 * - `reembed` is resumable: batches of 64 into a pending generation, records
 *   that changed meanwhile embedded again, the generation activated
 *   atomically once complete. A query vector of another model or size throws
 *   `EmbeddingMismatchError`.
 *
 * Reports `deuz.memory.op` spans (operation, record count, conflict retries,
 * embedding generation) through `deps.observer`.
 */
export function createMemorySession(options: CreateMemorySessionOptions): MemorySession {
  if (options === null || typeof options !== 'object')
    throw invalid('createMemorySession needs options.');
  const store = options.store;
  if (store === null || typeof store !== 'object' || typeof store.commit !== 'function')
    throw invalid('createMemorySession needs a VersionedMemoryStore.');
  const scope = checkScope(options.scope, 'memory session scope');
  const key = scopeKey(scope);
  const maxAttempts = options.maxConflictRetries ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw invalid('maxConflictRetries must be a positive integer.');
  const deps = resolveDependencies(options.deps);
  const llm: MemoryLLM | AccountedMemoryLLM | undefined = options.llm;
  let embedder: Embedder | AccountedMemoryEmbedder | undefined = options.embedder;
  const listeners: readonly MemoryForgetListener[] =
    options.onForget === undefined
      ? []
      : typeof options.onForget === 'function'
        ? [options.onForget]
        : [...options.onForget];
  const charging = createMemoryCharging({
    deps,
    ...(options.execution !== undefined ? { execution: options.execution } : {}),
    ...(options.llmModelId !== undefined ? { llmModelId: options.llmModelId } : {}),
    ...(options.embedderModelId !== undefined ? { embedderModelId: options.embedderModelId } : {}),
  });
  const defaultMode: 'reconcile' | 'add' = llm ? 'reconcile' : 'add';

  /**
   * Embeds `texts` with the session's embedder; a vector of another model or
   * size than the active generation throws before anything is written.
   */
  async function embedChecked(
    texts: string[],
    action: 'add' | 'search' | 'update',
  ): Promise<{ vectors: number[][]; model: string } | undefined> {
    if (!embedder || texts.length === 0) return undefined;
    const active = await store.embeddings.active();
    const result = await charging.embed(
      embedder,
      texts,
      action,
      active?.modelId ?? options.embedderModelId,
    );
    for (const vector of result.vectors) {
      if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      )
        throw invalid('The memory embedder returned a vector that is not finite numbers.');
      if (active && (result.model !== active.modelId || vector.length !== active.dims))
        throw new EmbeddingMismatchError({
          expected: { modelId: active.modelId, dims: active.dims, generation: active.generation },
          actual: { modelId: result.model, dims: vector.length },
        });
    }
    return result;
  }

  /** Puts the vector of each new final text on its mutation. */
  async function attachVectors(
    mutations: VersionedMemoryMutation[],
  ): Promise<VersionedMemoryMutation[]> {
    if (!embedder) return mutations;
    const creates = mutations.filter(
      (mutation): mutation is Extract<VersionedMemoryMutation, { type: 'create' }> =>
        mutation.type === 'create',
    );
    const revises = mutations.filter(
      (mutation): mutation is Extract<VersionedMemoryMutation, { type: 'revise' }> =>
        mutation.type === 'revise' && mutation.changes.text !== undefined,
    );
    const added = await embedChecked(
      creates.map((mutation) => mutation.record.text),
      'add',
    );
    const updated = await embedChecked(
      revises.map((mutation) => mutation.changes.text!),
      'update',
    );
    for (const [index, mutation] of creates.entries())
      mutation.embedding = {
        vector: added!.vectors[index]!,
        modelId: added!.model,
        textDigest: await textDigest(mutation.record.text),
      };
    for (const [index, mutation] of revises.entries())
      mutation.embedding = {
        vector: updated!.vectors[index]!,
        modelId: updated!.model,
        textDigest: await textDigest(mutation.changes.text!),
      };
    return mutations;
  }

  /** Active records similar to any of `texts` (text, and vector once a generation exists). */
  async function similar(texts: string[], topK: number): Promise<VersionedMemoryRecord[]> {
    const active = embedder ? await store.embeddings.active() : undefined;
    const query = active ? await embedChecked(texts, 'search') : undefined;
    const found = new Map<string, VersionedMemoryRecord>();
    for (const [index, text] of texts.entries()) {
      const hits = await store.search({
        scope,
        text,
        topK,
        ...(query ? { embedding: { vector: query.vectors[index]!, modelId: query.model } } : {}),
      });
      for (const hit of hits) if (!found.has(hit.record.id)) found.set(hit.record.id, hit.record);
    }
    return [...found.values()];
  }

  /** Plans the mutations that write `facts` (reconciled against similar records, or added). */
  async function planFacts(facts: SessionFact[], plan: FactWritePlan): Promise<PlannedOperation> {
    const now = deps.clock.now();
    const expiresAt = plan.ttlMs !== undefined ? now + plan.ttlMs : undefined;
    const allSources = mergeSources(facts.flatMap((fact) => fact.sources));
    const factFor = (text: string) => facts.find((fact) => fact.text === text);
    const create = (text: string, links?: MemoryLink[]): VersionedMemoryMutation => {
      const fact = factFor(text);
      const importance = fact?.importance ?? plan.importance;
      const merged = mergeLinks(plan.links, links);
      return {
        type: 'create',
        record: {
          id: deps.generateId(),
          text,
          kind: plan.kind ?? fact?.kind ?? 'semantic',
          origin: plan.origin,
          sources: fact?.sources ?? allSources,
          ...(importance !== undefined ? { importance } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(merged !== undefined ? { links: merged } : {}),
          ...(plan.metadata !== undefined ? { metadata: plan.metadata } : {}),
        },
      };
    };
    const distinct = [...new Set(facts.map((fact) => fact.text))];
    if (plan.mode === 'add' || distinct.length === 0)
      return { mutations: await attachVectors(distinct.map((text) => create(text))) };

    const expectedScopeRevision = await store.scopeRevision(scope);
    const candidates = await similar(distinct, plan.topK);
    if (candidates.length === 0)
      return {
        mutations: await attachVectors(distinct.map((text) => create(text))),
        expectedScopeRevision,
      };
    if (!llm) throw invalid("supersede: 'reconcile' needs a memory LLM (options.llm).");
    const prompt = buildReconcilePrompt(candidates, distinct);
    const decisions = parseReconcileDecisions(await charging.complete(llm, prompt), prompt.ids);
    const byTemp = new Map(prompt.ids.map((id, index) => [id, candidates[index]!]));
    const mutations: VersionedMemoryMutation[] = [];
    const touched = new Set<string>();
    const superseded: MemoryLink[] = [];
    const adds: { text: string; links: MemoryLink[] }[] = [];
    for (const decision of decisions) {
      if (decision.event === 'NOOP') continue;
      if (decision.event === 'ADD') {
        adds.push({ text: decision.text, links: [] });
        continue;
      }
      const current = byTemp.get(decision.id)!;
      if (touched.has(current.id)) continue;
      // An inferred write never changes an asserted record.
      const guarded = plan.origin === 'inferred' && current.origin === 'asserted';
      if (decision.event === 'DELETE') {
        if (guarded) continue;
        touched.add(current.id);
        mutations.push({
          type: 'retract',
          id: current.id,
          expectedRevision: current.revision,
          reason: 'superseded',
        });
        superseded.push({ recordId: current.id, relation: 'supersedes' });
        continue;
      }
      if (current.origin === plan.origin) {
        touched.add(current.id);
        const links = plan.links ? mergeLinks(current.links, plan.links) : undefined;
        const changes: VersionedMemoryRevision = {
          ...(decision.text !== current.text ? { text: decision.text } : {}),
          sources: mergeSources([
            ...current.sources,
            ...(factFor(decision.text)?.sources ?? allSources),
          ]),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(links !== undefined ? { links } : {}),
          ...(plan.metadata !== undefined
            ? { metadata: { ...current.metadata, ...plan.metadata } }
            : {}),
        };
        mutations.push({
          type: 'revise',
          id: current.id,
          expectedRevision: current.revision,
          changes,
        });
      } else if (guarded) {
        adds.push({ text: decision.text, links: [{ recordId: current.id, relation: 'about' }] });
      } else {
        // An asserted write supersedes an inferred record instead of relabelling it.
        touched.add(current.id);
        mutations.push({
          type: 'retract',
          id: current.id,
          expectedRevision: current.revision,
          reason: 'superseded',
        });
        adds.push({
          text: decision.text,
          links: [{ recordId: current.id, relation: 'supersedes' }],
        });
      }
    }
    // An ADD of a text the scope already holds is a duplicate, not a new memory.
    const normalized = (text: string) => text.trim().toLowerCase();
    const added = new Set(
      candidates
        .filter((record) => !touched.has(record.id))
        .map((record) => normalized(record.text)),
    );
    for (const add of adds) {
      if (added.has(normalized(add.text))) continue;
      added.add(normalized(add.text));
      mutations.push(create(add.text, [...add.links, ...superseded]));
    }
    return { mutations: await attachVectors(mutations), expectedScopeRevision };
  }

  /** The revisions an operation wrote, as far as they still exist. */
  async function written(receipt: VersionedMemoryReceipt): Promise<VersionedMemoryRecord[]> {
    const records = await Promise.all(
      receipt.entries.map((entry) =>
        store.get(scope, entry.id, { revision: entry.revision, includeRetracted: true }),
      ),
    );
    return records.filter((record): record is VersionedMemoryRecord => record !== undefined);
  }

  function conflictError(
    result: Extract<VersionedMemoryCommitResult, { status: 'conflict' }>,
    planned: PlannedOperation,
    attempts: number,
  ): RevisionConflictError {
    const first = result.conflicts[0];
    const expectedRevision = first ? first.expectedRevision : planned.expectedScopeRevision;
    const actualRevision = first ? first.actualRevision : result.scopeRevision;
    return new RevisionConflictError({
      subsystem: 'memory',
      key: first?.id ?? key,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(actualRevision !== undefined ? { actualRevision } : {}),
      attempts,
    });
  }

  /** Replays a stored receipt, plans and commits, re-planning on a conflict. */
  function runOperation(spec: OperationSpec): Promise<MemoryOperationResult> {
    return observeSpan(
      deps,
      DEUZ_SPAN.memoryOp,
      { [DEUZ_ATTR.memoryOperation]: spec.name },
      async (annotate) => {
        annotate({ [DEUZ_ATTR.memoryOperation]: spec.name });
        const finish = (
          receipt: VersionedMemoryReceipt,
          records: VersionedMemoryRecord[],
          replayed: boolean,
          conflictRetries: number,
        ): MemoryOperationResult => {
          const generation = records.find((record) => record.embedding)?.embedding?.generation;
          annotate({
            [DEUZ_ATTR.memoryRecordCount]: receipt.entries.length,
            [DEUZ_ATTR.memoryConflictRetries]: conflictRetries,
            ...(generation !== undefined
              ? { [DEUZ_ATTR.memoryEmbeddingGeneration]: generation }
              : {}),
          });
          return { receipt, replayed, records, conflictRetries };
        };
        const stored = await store.receipt(spec.operationId);
        if (stored) {
          if (stored.requestDigest !== spec.requestDigest || scopeKey(stored.scope) !== key)
            throw new OperationConflictError({
              subsystem: 'memory',
              operationId: spec.operationId,
              storedDigest: stored.requestDigest,
              requestDigest: spec.requestDigest,
            });
          return finish(stored, await written(stored), true, 0);
        }
        for (let attempt = 1; ; attempt++) {
          throwIfAborted(spec.signal);
          const planned = await spec.plan();
          throwIfAborted(spec.signal);
          const result = await store.commit({
            operationId: spec.operationId,
            scope,
            actor: spec.actor,
            mutations: planned.mutations,
            requestDigest: spec.requestDigest,
            ...(planned.expectedScopeRevision !== undefined
              ? { expectedScopeRevision: planned.expectedScopeRevision }
              : {}),
          });
          if (result.status !== 'conflict')
            return finish(
              result.receipt,
              await written(result.receipt),
              result.status === 'replayed',
              attempt - 1,
            );
          if (!spec.retry || attempt >= maxAttempts) throw conflictError(result, planned, attempt);
        }
      },
    );
  }

  const internals: SessionInternals = {
    defaultMode,
    writeFacts(facts, plan, op) {
      if (plan.mode === 'reconcile' && !llm)
        throw invalid("supersede: 'reconcile' needs a memory LLM (options.llm).");
      return runOperation({ ...op, retry: true, plan: () => planFacts(facts, plan) });
    },
    change(mutation, op) {
      return runOperation({
        ...op,
        retry: false,
        plan: async () => {
          if (mutation.type !== 'revise' || mutation.changes.text === undefined || !embedder)
            return { mutations: [mutation] };
          // A new text gets its own vector; an unchanged one keeps the stored vector.
          const current = await store.get(scope, mutation.id, { includeRetracted: true });
          if (
            current?.revision !== mutation.expectedRevision ||
            current.text === mutation.changes.text
          )
            return { mutations: [mutation] };
          return { mutations: await attachVectors([{ ...mutation }]) };
        },
      });
    },
  };

  const session: MemorySession = {
    scope: copy(scope),

    async remember(input: MemoryRememberInput, writeOptions) {
      if (
        input === null ||
        typeof input !== 'object' ||
        typeof input.text !== 'string' ||
        !input.text.trim()
      )
        throw invalid('remember needs a non-empty text.');
      const origin = input.origin ?? 'asserted';
      if (!isOrigin(origin)) throw invalid("remember origin must be 'asserted' or 'inferred'.");
      if (input.kind !== undefined && !isMemoryKind(input.kind))
        throw invalid('remember has an unknown kind.');
      if (
        input.supersede !== undefined &&
        input.supersede !== 'reconcile' &&
        input.supersede !== 'add'
      )
        throw invalid("supersede must be 'reconcile' or 'add'.");
      const mode = input.supersede ?? defaultMode;
      const sources =
        input.sources !== undefined
          ? checkSources(input.sources, 'remember')
          : [{ kind: 'host' as const, digest: await textDigest(input.text) }];
      const importance = checkImportance(input.importance, 'remember');
      const ttlMs = checkTtl(input.ttlMs, 'remember');
      const links = checkLinks(input.links, 'remember');
      const metadata = checkMetadata(input.metadata, 'remember');
      const operationId = writeOptions?.operationId ?? deps.generateId();
      const requestDigest = await digestJson({
        type: 'remember',
        scope,
        text: input.text,
        origin,
        kind: input.kind,
        sources,
        importance,
        ttlMs,
        links,
        metadata,
        supersede: mode,
      });
      return internals.writeFacts(
        [{ text: input.text, sources }],
        {
          origin,
          mode,
          topK: 5,
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(importance !== undefined ? { importance } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(links !== undefined ? { links } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        },
        {
          name: 'remember',
          operationId,
          requestDigest,
          actor: 'host',
          ...(writeOptions?.signal !== undefined ? { signal: writeOptions.signal } : {}),
        },
      );
    },

    async extract(input: MemoryExtractionInput, writeOptions) {
      if (input === null || typeof input !== 'object') throw invalid('extract needs an input.');
      if (input.kind !== undefined && !isMemoryKind(input.kind))
        throw invalid('extract has an unknown kind.');
      if (
        input.supersede !== undefined &&
        input.supersede !== 'reconcile' &&
        input.supersede !== 'add'
      )
        throw invalid("supersede must be 'reconcile' or 'add'.");
      if (input.instructions !== undefined && typeof input.instructions !== 'string')
        throw invalid('extract instructions must be a string.');
      const topK = input.topK ?? 5;
      if (!Number.isSafeInteger(topK) || topK < 1)
        throw invalid('extract topK must be a positive integer.');
      const ttlMs = checkTtl(input.ttlMs, 'extract');
      const links = checkLinks(input.links, 'extract');
      const infer = input.infer !== false;
      if (infer && !llm)
        throw invalid(
          'extract infers facts with a memory LLM (options.llm), or pass infer: false.',
        );
      const mode = input.supersede ?? defaultMode;
      if (mode === 'reconcile' && !llm)
        throw invalid("supersede: 'reconcile' needs a memory LLM (options.llm).");
      const read = await readExtractionSources(input.messages, options.extraction, scope);
      const operationId = writeOptions?.operationId ?? deps.generateId();
      const requestDigest = await digestJson({
        type: 'extract',
        scope,
        sources: read.map((source) => source.ref),
        kind: input.kind,
        ttlMs,
        links,
        topK,
        supersede: mode,
        instructions: input.instructions,
        infer,
      });

      let facts: SessionFact[] | undefined;
      const extractFacts = async (): Promise<SessionFact[]> => {
        if (read.length === 0) return [];
        if (!infer) return read.map((source) => ({ text: source.text, sources: [source.ref] }));
        const answer = await charging.complete(
          llm!,
          buildExtractionPrompt(
            read.map((source) => ({ tag: source.tag, label: source.label, text: source.text })),
            input.instructions,
          ),
        );
        const byTag = new Map(read.map((source) => [source.tag, source.ref]));
        return parseExtractedFacts(answer).map((fact) => {
          const cited = [...new Set(fact.sources)]
            .map((tag) => byTag.get(tag))
            .filter((ref): ref is MemorySourceRef => ref !== undefined);
          return {
            text: fact.text,
            ...(fact.kind !== undefined ? { kind: fact.kind } : {}),
            ...(fact.importance !== undefined ? { importance: fact.importance } : {}),
            // A fact that cites nothing it was shown rests on everything it read.
            sources: cited.length > 0 ? cited : read.map((source) => source.ref),
          };
        });
      };
      return runOperation({
        name: 'extract',
        operationId,
        requestDigest,
        actor: 'extraction',
        retry: true,
        ...(writeOptions?.signal !== undefined ? { signal: writeOptions.signal } : {}),
        plan: async () => {
          // One extraction call, however many times reconciliation re-plans.
          facts ??= await extractFacts();
          return planFacts(facts, {
            origin: 'inferred',
            mode,
            topK,
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(ttlMs !== undefined ? { ttlMs } : {}),
            ...(links !== undefined ? { links } : {}),
          });
        },
      });
    },

    async recall(input = {}) {
      throwIfAborted(input.signal);
      const text = typeof input.text === 'string' && input.text.trim() ? input.text : undefined;
      let embedding: { vector: number[]; modelId: string } | undefined;
      if (embedder && text !== undefined && (await store.embeddings.active())) {
        const result = await embedChecked([text], 'search');
        if (result) embedding = { vector: result.vectors[0]!, modelId: result.model };
      }
      return store.search({
        scope,
        ...(text !== undefined ? { text } : {}),
        ...(embedding !== undefined ? { embedding } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.topK !== undefined ? { topK: input.topK } : {}),
        ...(input.recordedAsOf !== undefined ? { recordedAsOf: input.recordedAsOf } : {}),
        ...(input.includeRetracted !== undefined
          ? { includeRetracted: input.includeRetracted }
          : {}),
      });
    },

    async revise(id, changes, writeOptions) {
      if (typeof id !== 'string' || id === '') throw invalid('revise needs a record id.');
      if (changes === null || typeof changes !== 'object') throw invalid('revise needs changes.');
      const expectedRevision = writeOptions?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
        throw invalid('revise needs a positive expectedRevision.');
      const operationId = writeOptions.operationId ?? deps.generateId();
      const requestDigest = await digestJson({
        type: 'revise',
        scope,
        id,
        expectedRevision,
        changes,
      });
      return internals.change(
        { type: 'revise', id, expectedRevision, changes },
        {
          name: 'revise',
          operationId,
          requestDigest,
          actor: 'host',
          ...(writeOptions.signal !== undefined ? { signal: writeOptions.signal } : {}),
        },
      );
    },

    async retract(id, writeOptions) {
      if (typeof id !== 'string' || id === '') throw invalid('retract needs a record id.');
      const expectedRevision = writeOptions?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
        throw invalid('retract needs a positive expectedRevision.');
      const operationId = writeOptions.operationId ?? deps.generateId();
      const reason = writeOptions.reason;
      const requestDigest = await digestJson({
        type: 'retract',
        scope,
        id,
        expectedRevision,
        reason,
      });
      return internals.change(
        { type: 'retract', id, expectedRevision, ...(reason !== undefined ? { reason } : {}) },
        {
          name: 'retract',
          operationId,
          requestDigest,
          actor: 'host',
          ...(writeOptions.signal !== undefined ? { signal: writeOptions.signal } : {}),
        },
      );
    },

    async forget(id, writeOptions) {
      if (typeof id !== 'string' || id === '') throw invalid('forget needs a record id.');
      throwIfAborted(writeOptions?.signal);
      const operationId = writeOptions?.operationId ?? deps.generateId();
      return observeSpan(
        deps,
        DEUZ_SPAN.memoryOp,
        { [DEUZ_ATTR.memoryOperation]: 'forget' },
        async (annotate): Promise<MemoryForgetResult> => {
          annotate({ [DEUZ_ATTR.memoryOperation]: 'forget' });
          const event = await store.forget(scope, id, operationId);
          annotate({ [DEUZ_ATTR.memoryRecordCount]: event.revisions.length > 0 ? 1 : 0 });
          let redaction: MemoryForgetResult['redaction'] = 'none';
          // A record this scope forgot before goes to the listeners again (revisions []
          // meaning all of them): a retry finishes a redaction a crash or a failure cut short.
          const forgotten = event.revisions.length > 0 || event.alreadyForgotten === true;
          if (forgotten && listeners.length > 0) {
            redaction = 'complete';
            for (const listener of listeners) {
              try {
                await listener(copy(event));
              } catch (error) {
                redaction = 'failed';
                deps.logger.warn(
                  'A versioned memory onForget listener failed; the record stays forgotten. Forget it again to rerun the listeners, or run the redaction from the forget event.',
                  {
                    operationId,
                    recordId: id,
                    error: error instanceof Error ? error.name : typeof error,
                  },
                );
              }
            }
          }
          return { ...event, redaction };
        },
      );
    },

    async history(id) {
      if (typeof id !== 'string' || id === '') throw invalid('history needs a record id.');
      return store.history(scope, id);
    },

    async reembed(reembedOptions: MemoryReembedOptions) {
      if (reembedOptions === null || typeof reembedOptions !== 'object')
        throw invalid('reembed needs options.');
      const next = reembedOptions.embedder;
      if (next === null || typeof next !== 'object' || typeof next.embed !== 'function')
        throw invalid('reembed needs an embedder.');
      const { modelId, dims, signal } = reembedOptions;
      if (typeof modelId !== 'string' || modelId === '') throw invalid('reembed needs a modelId.');
      if (!Number.isSafeInteger(dims) || dims < 1)
        throw invalid('reembed dims must be a positive integer.');
      const batchSize = reembedOptions.batchSize ?? 64;
      const concurrency = reembedOptions.concurrency ?? 1;
      if (!Number.isSafeInteger(batchSize) || batchSize < 1)
        throw invalid('reembed batchSize must be a positive integer.');
      if (!Number.isSafeInteger(concurrency) || concurrency < 1)
        throw invalid('reembed concurrency must be a positive integer.');
      return observeSpan(
        deps,
        DEUZ_SPAN.memoryOp,
        { [DEUZ_ATTR.memoryOperation]: 'reembed' },
        async (annotate): Promise<MemoryReembedResult> => {
          annotate({ [DEUZ_ATTR.memoryOperation]: 'reembed' });
          throwIfAborted(signal);
          const { generation } = await store.embeddings.begin({ modelId, dims });
          annotate({ [DEUZ_ATTR.memoryEmbeddingGeneration]: generation });
          let embedded = 0;
          let skipped = 0;
          const result = (activated: boolean): MemoryReembedResult => {
            annotate({ [DEUZ_ATTR.memoryRecordCount]: embedded });
            if (activated) embedder = next;
            return { generation, embedded, skipped, activated };
          };

          /** Embeds one batch of the new generation and stores what is still current. */
          const fill = async (items: MemoryReembedItem[]): Promise<void> => {
            const out = await charging.embed(
              next,
              items.map((item) => item.text),
              'add',
              modelId,
            );
            for (const vector of out.vectors)
              if (out.model !== modelId || !Array.isArray(vector) || vector.length !== dims)
                throw new EmbeddingMismatchError({
                  expected: { modelId, dims, generation },
                  actual: { modelId: out.model, dims: Array.isArray(vector) ? vector.length : 0 },
                });
            const stored = await store.embeddings.put(
              generation,
              items.map((item, index) => ({
                id: item.id,
                revision: item.revision,
                textDigest: item.textDigest,
                vector: out.vectors[index]!,
              })),
            );
            embedded += stored;
            // A record whose revision moved meanwhile is embedded again from its new text.
            skipped += items.length - stored;
          };

          for (let pass = 0; pass < REEMBED_PASSES; pass++) {
            let after: string | undefined;
            let exhausted = false;
            while (!exhausted) {
              throwIfAborted(signal);
              const batches: MemoryReembedItem[][] = [];
              while (batches.length < concurrency) {
                const items = await store.embeddings.pending(generation, {
                  limit: batchSize,
                  ...(after !== undefined ? { after } : {}),
                });
                if (items.length > 0) {
                  batches.push(items);
                  after = items.at(-1)!.id;
                }
                if (items.length < batchSize) {
                  exhausted = true;
                  break;
                }
              }
              await Promise.all(batches.map(fill));
            }
            if (await store.embeddings.activate(generation)) return result(true);
            // Records changed behind the cursor: another pass from the start embeds them.
          }
          return result(false);
        },
      );
    },
  };
  sessionInternals.set(session, internals);
  return session;
}
