/**
 * versioned-memory-store-conformance.ts (2.4) — the `VersionedMemoryStore`
 * contract (`src/memory/versioned/types.ts`) as one suite every backend runs:
 * the in-memory reference, SQLite and PostgreSQL.
 *
 * ```ts
 * assertVersionedMemoryStoreContract('sqlite', async ({ clock, logger }) => {
 *   const store = createSqliteVersionedMemoryStore({ path: ':memory:', clock, logger });
 *   return { store, cleanup: () => store.close() };
 * });
 * ```
 *
 * `make()` runs FRESH for every `it`, with a manual clock the suite moves and a
 * logger it watches, so no case sees another's rows and every timestamp is
 * known. Only what the contract states is asserted: ranking ORDER of clearly
 * separated candidates (never a raw score), receipt and revision shapes,
 * all-or-nothing commits, replay, forget and the embedding generations.
 * Lexical queries use one word that appears as a whole word in exactly the
 * records meant to match, so FTS5, tsvector, LIKE and simple substring
 * matching all agree.
 *
 * Readings of the JSDoc the suite relies on (each follows from its text):
 * - a commit that answers `'conflict'` leaves no receipt, so the session can
 *   re-plan and commit under the same operation id;
 * - the first stored vector starts the active generation (`active()` is
 *   "absent before any vector was stored");
 * - a vector search never returns a record without a vector in the active
 *   generation (no score-0 fillers, spec §2.2).
 *
 * `options.hybrid: false` (the in-memory reference, which does "simple
 * matching") skips only the assertion that a text + vector hit is reported as
 * `match: 'hybrid'`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemoryKind, MemoryScope } from '../../src/memory';
import type {
  MemorySourceRef,
  VersionedMemoryActor,
  VersionedMemoryCommit,
  VersionedMemoryMutation,
  VersionedMemoryStore,
} from '../../src/memory/versioned/types';
import type { Clock, Logger } from '../../src/types/deps';
import { EmbeddingMismatchError, OperationConflictError } from '../../src/errors';
import { digestJson, isSha256Digest, sha256Digest } from '../../src/internal/digest';
import { manualClock } from './manual-clock';

/** What a backend hands the suite. */
export interface VersionedMemoryStoreHarness {
  store: VersionedMemoryStore;
  cleanup?: () => Promise<void>;
}

/** The clock the store must read its time from, and the logger it must warn through. */
export interface VersionedMemoryStoreEnv {
  clock: Clock;
  logger: Logger;
}

export type VersionedMemoryStoreFactory = (
  env: VersionedMemoryStoreEnv,
) => Promise<VersionedMemoryStoreHarness>;

export interface VersionedMemoryStoreSuiteOptions {
  /** The store fuses text and vector matches (`match: 'hybrid'`). Default true. */
  hybrid?: boolean;
  /** Per-case timeout in ms (live servers). */
  timeout?: number;
}

const T0 = 1_700_000_000_000;
const SCOPE: MemoryScope = { userId: 'user-a', agentId: 'agent-1' };
const OTHER: MemoryScope = { userId: 'user-b', agentId: 'agent-1' };
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

interface Fixture {
  store: VersionedMemoryStore;
  clock: Clock;
  advance(ms: number): Promise<void>;
  warn: ReturnType<typeof vi.fn>;
}

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    warn,
    logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
  };
}

async function hostSource(text: string): Promise<MemorySourceRef> {
  return { kind: 'host', digest: await sha256Digest(text) };
}

async function vectorOf(text: string, vector: number[], modelId = MODEL_A) {
  return { vector, modelId, textDigest: await sha256Digest(text) };
}

async function create(
  id: string,
  text: string,
  extra: {
    kind?: MemoryKind;
    expiresAt?: number;
    vector?: number[];
    modelId?: string;
  } = {},
): Promise<VersionedMemoryMutation> {
  return {
    type: 'create',
    record: {
      id,
      text,
      kind: extra.kind ?? 'semantic',
      origin: 'asserted',
      sources: [await hostSource(text)],
      ...(extra.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
    },
    ...(extra.vector ? { embedding: await vectorOf(text, extra.vector, extra.modelId) } : {}),
  };
}

async function revise(
  id: string,
  expectedRevision: number,
  text: string,
  vector?: number[],
  modelId?: string,
): Promise<VersionedMemoryMutation> {
  return {
    type: 'revise',
    id,
    expectedRevision,
    changes: { text },
    ...(vector ? { embedding: await vectorOf(text, vector, modelId) } : {}),
  };
}

function retract(id: string, expectedRevision: number): VersionedMemoryMutation {
  return { type: 'retract', id, expectedRevision };
}

/** A commit whose `requestDigest` is the canonical digest of the request, operation id excluded. */
async function operation(
  operationId: string,
  mutations: VersionedMemoryMutation[],
  extra: { scope?: MemoryScope; expectedScopeRevision?: number; actor?: VersionedMemoryActor } = {},
): Promise<VersionedMemoryCommit> {
  const request = {
    scope: extra.scope ?? SCOPE,
    actor: extra.actor ?? ('host' as const),
    mutations,
    ...(extra.expectedScopeRevision !== undefined
      ? { expectedScopeRevision: extra.expectedScopeRevision }
      : {}),
  };
  return { operationId, ...request, requestDigest: await digestJson(request) };
}

/** Commits and insists on `'committed'`. */
async function commit(store: VersionedMemoryStore, op: VersionedMemoryCommit) {
  const result = await store.commit(op);
  if (result.status !== 'committed')
    throw new Error(`expected ${op.operationId} to commit, got ${JSON.stringify(result)}`);
  return result.receipt;
}

function ids(hits: { record: { id: string } }[]): string[] {
  return hits.map((hit) => hit.record.id);
}

export function assertVersionedMemoryStoreContract(
  name: string,
  make: VersionedMemoryStoreFactory,
  options: VersionedMemoryStoreSuiteOptions = {},
): void {
  const hybrid = options.hybrid !== false;
  const timeout = options.timeout;

  async function withStore(fn: (f: Fixture) => Promise<void>): Promise<void> {
    const time = manualClock(T0);
    const { logger, warn } = spyLogger();
    const harness = await make({ clock: time.clock, logger });
    try {
      await fn({ store: harness.store, clock: time.clock, advance: time.advance, warn });
    } finally {
      await harness.cleanup?.();
    }
  }

  describe(`VersionedMemoryStore contract: ${name}`, () => {
    describe('commit and receipts', () => {
      it(
        'commits a create as revision 1 with a receipt and bumps the scope revision',
        { timeout },
        async () => {
          await withStore(async ({ store, clock }) => {
            const op = await operation('op-1', [await create('r1', 'The user likes green tea')]);
            const result = await store.commit(op);
            expect(result.status).toBe('committed');
            if (result.status !== 'committed') return;
            expect(result.receipt).toMatchObject({
              operationId: 'op-1',
              actor: 'host',
              requestDigest: op.requestDigest,
              scopeRevision: 1,
              entries: [{ type: 'create', id: 'r1', revision: 1 }],
              committedAt: clock.now(),
            });
            expect(result.receipt.scope).toEqual(SCOPE);
            expect(result.receipt.redacted).toBeFalsy();

            const record = await store.get(SCOPE, 'r1');
            expect(record).toMatchObject({
              id: 'r1',
              revision: 1,
              text: 'The user likes green tea',
              kind: 'semantic',
              origin: 'asserted',
              status: 'active',
              operationId: 'op-1',
              recordedAt: clock.now(),
              createdAt: clock.now(),
            });
            expect(record!.scope).toEqual(SCOPE);
            expect(record!.sources).toEqual([await hostSource('The user likes green tea')]);
            expect(isSha256Digest(record!.digest)).toBe(true);
            expect(await store.scopeRevision(SCOPE)).toBe(1);
            expect(await store.receipt('op-1')).toEqual(result.receipt);
          });
        },
      );

      it(
        'commits several mutations in one receipt and one scope revision',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            const receipt = await commit(
              store,
              await operation('op-1', [
                await create('r1', 'first fact'),
                await create('r2', 'second fact'),
              ]),
            );
            expect(receipt.entries).toEqual([
              { type: 'create', id: 'r1', revision: 1 },
              { type: 'create', id: 'r2', revision: 1 },
            ]);
            expect(receipt.scopeRevision).toBe(1);
            expect((await store.get(SCOPE, 'r2'))?.revision).toBe(1);
          });
        },
      );

      it('applies nothing when one mutation of the operation conflicts', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(store, await operation('op-1', [await create('r1', 'first fact')]));
          const result = await store.commit(
            await operation('op-2', [
              await create('r2', 'second fact'),
              await revise('r1', 7, 'changed'),
            ]),
          );
          expect(result.status).toBe('conflict');
          if (result.status !== 'conflict') return;
          expect(result.scopeRevision).toBe(1);
          expect(result.conflicts).toContainEqual({
            id: 'r1',
            expectedRevision: 7,
            actualRevision: 1,
          });
          expect(await store.get(SCOPE, 'r2')).toBeUndefined();
          expect(await store.get(SCOPE, 'r2', { includeRetracted: true })).toBeUndefined();
          expect((await store.get(SCOPE, 'r1'))?.text).toBe('first fact');
          expect(await store.history(SCOPE, 'r1')).toHaveLength(1);
          expect(await store.scopeRevision(SCOPE)).toBe(1);
          expect(await store.receipt('op-2')).toBeUndefined();
        });
      });

      it(
        'revises against the expected revision and writes revision n + 1',
        { timeout },
        async () => {
          await withStore(async ({ store, clock, advance }) => {
            await commit(store, await operation('op-1', [await create('r1', 'first draft')]));
            const created = clock.now();
            await advance(1_000);
            const receipt = await commit(
              store,
              await operation('op-2', [await revise('r1', 1, 'second draft')]),
            );
            expect(receipt.entries).toEqual([{ type: 'revise', id: 'r1', revision: 2 }]);
            const record = await store.get(SCOPE, 'r1');
            expect(record).toMatchObject({
              revision: 2,
              text: 'second draft',
              status: 'active',
              operationId: 'op-2',
              createdAt: created,
              recordedAt: clock.now(),
            });
            // Sources default to the previous revision's.
            expect(record!.sources).toEqual([await hostSource('first draft')]);

            const stale = await store.commit(
              await operation('op-3', [await revise('r1', 1, 'third draft')]),
            );
            expect(stale.status).toBe('conflict');
            if (stale.status !== 'conflict') return;
            expect(stale.conflicts).toContainEqual({
              id: 'r1',
              expectedRevision: 1,
              actualRevision: 2,
            });
            expect((await store.get(SCOPE, 'r1'))?.text).toBe('second draft');
          });
        },
      );

      it('checks expectedScopeRevision before applying anything', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(store, await operation('op-1', [await create('r1', 'first fact')]));
          const stale = await store.commit(
            await operation('op-2', [await create('r2', 'second fact')], {
              expectedScopeRevision: 0,
            }),
          );
          expect(stale.status).toBe('conflict');
          if (stale.status !== 'conflict') return;
          expect(stale.scopeRevision).toBe(1);
          expect(Array.isArray(stale.conflicts)).toBe(true);
          expect(await store.get(SCOPE, 'r2')).toBeUndefined();

          const current = await commit(
            store,
            await operation('op-3', [await create('r2', 'second fact')], {
              expectedScopeRevision: 1,
            }),
          );
          expect(current.scopeRevision).toBe(2);
        });
      });

      it(
        'conflicts on a revise of an unknown record, without an actual revision',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            const result = await store.commit(
              await operation('op-1', [await revise('ghost', 1, 'text')]),
            );
            expect(result.status).toBe('conflict');
            if (result.status !== 'conflict') return;
            const entry = result.conflicts.find((c) => c.id === 'ghost');
            expect(entry).toMatchObject({ id: 'ghost', expectedRevision: 1 });
            expect(entry!.actualRevision).toBeUndefined();
            expect(await store.scopeRevision(SCOPE)).toBe(0);
          });
        },
      );

      it('conflicts on a create of an id that already exists', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(store, await operation('op-1', [await create('r1', 'first fact')]));
          const result = await store.commit(
            await operation('op-2', [await create('r1', 'other fact')]),
          );
          expect(result.status).toBe('conflict');
          if (result.status !== 'conflict') return;
          expect(result.conflicts.map((c) => c.id)).toContain('r1');
          expect((await store.get(SCOPE, 'r1'))?.text).toBe('first fact');
        });
      });

      it(
        'writes a receipt for an empty operation and for a retract-only operation',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            const empty = await commit(store, await operation('op-empty', []));
            expect(empty.entries).toEqual([]);
            expect(empty.scopeRevision).toBe(1);
            expect(await store.receipt('op-empty')).toEqual(empty);

            await commit(store, await operation('op-1', [await create('r1', 'first fact')]));
            const retracted = await commit(store, await operation('op-2', [retract('r1', 1)]));
            expect(retracted.entries).toEqual([{ type: 'retract', id: 'r1', revision: 2 }]);
            expect(retracted.scopeRevision).toBe(3);
            expect(await store.get(SCOPE, 'r1')).toBeUndefined();
            expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toMatchObject({
              revision: 2,
              status: 'retracted',
              text: 'first fact',
            });
          });
        },
      );

      it(
        'leaves no receipt on a conflict, so the operation id can commit after a re-plan',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(store, await operation('op-1', [await create('r1', 'first draft')]));
            await commit(store, await operation('op-2', [await revise('r1', 1, 'second draft')]));
            const first = await store.commit(
              await operation('op-3', [await revise('r1', 1, 'third draft')]),
            );
            expect(first.status).toBe('conflict');
            expect(await store.receipt('op-3')).toBeUndefined();
            const replanned = await store.commit(
              await operation('op-3', [await revise('r1', 2, 'third draft')]),
            );
            expect(replanned.status).toBe('committed');
            expect((await store.get(SCOPE, 'r1'))?.revision).toBe(3);
          });
        },
      );

      it('keeps one scope revision per scope, 0 for an empty one', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(store, await operation('a-1', [await create('a1', 'first fact')]));
          await commit(store, await operation('a-2', []));
          await commit(
            store,
            await operation('b-1', [await create('b1', 'other fact')], { scope: OTHER }),
          );
          expect(await store.scopeRevision(SCOPE)).toBe(2);
          expect(await store.scopeRevision(OTHER)).toBe(1);
          expect(await store.scopeRevision({ userId: 'nobody' })).toBe(0);
        });
      });
    });

    describe('idempotent replay', () => {
      it(
        'replays the same operation id and request without applying it again',
        { timeout },
        async () => {
          await withStore(async ({ store, advance }) => {
            const op = await operation('op-1', [await create('r1', 'first fact')]);
            const first = await commit(store, op);
            await advance(5_000);
            const again = await store.commit(op);
            expect(again).toEqual({ status: 'replayed', receipt: first });
            expect(await store.scopeRevision(SCOPE)).toBe(1);
            expect(await store.history(SCOPE, 'r1')).toHaveLength(1);
          });
        },
      );

      it('replays even after the scope moved on', { timeout }, async () => {
        await withStore(async ({ store }) => {
          const op = await operation('op-1', [await create('r1', 'first fact')], {
            expectedScopeRevision: 0,
          });
          const first = await commit(store, op);
          await commit(store, await operation('op-2', [await create('r2', 'second fact')]));
          expect(await store.commit(op)).toEqual({ status: 'replayed', receipt: first });
          expect(await store.scopeRevision(SCOPE)).toBe(2);
        });
      });

      it(
        'throws OperationConflictError for the same id with another request',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(store, await operation('op-1', [await create('r1', 'first fact')]));
            const other = await operation('op-1', [await create('r2', 'another fact')]);
            const error = await store.commit(other).then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(error).toBeInstanceOf(OperationConflictError);
            expect(error).toMatchObject({ code: 'operation_conflict', operationId: 'op-1' });
            expect(await store.get(SCOPE, 'r2')).toBeUndefined();
            expect(await store.scopeRevision(SCOPE)).toBe(1);
          });
        },
      );
    });

    describe('reads', () => {
      it('get honours the scope, a past revision and includeRetracted', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(store, await operation('op-1', [await create('r1', 'first draft')]));
          await commit(store, await operation('op-2', [await revise('r1', 1, 'second draft')]));
          expect(await store.get(OTHER, 'r1')).toBeUndefined();
          expect(await store.get(SCOPE, 'nope')).toBeUndefined();
          expect(await store.get(SCOPE, 'r1', { revision: 1 })).toMatchObject({
            revision: 1,
            text: 'first draft',
          });
          expect((await store.get(SCOPE, 'r1'))?.revision).toBe(2);
        });
      });

      it(
        'history lists every revision oldest first, the retracted one included',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(store, await operation('op-1', [await create('r1', 'first draft')]));
            await commit(store, await operation('op-2', [await revise('r1', 1, 'second draft')]));
            await commit(store, await operation('op-3', [retract('r1', 2)]));
            const history = await store.history(SCOPE, 'r1');
            expect(history.map((r) => [r.revision, r.status, r.text, r.operationId])).toEqual([
              [1, 'active', 'first draft', 'op-1'],
              [2, 'active', 'second draft', 'op-2'],
              [3, 'retracted', 'second draft', 'op-3'],
            ]);
            expect(await store.history(OTHER, 'r1')).toEqual([]);
          });
        },
      );

      it(
        'searches current revisions by text: not old text, not retracted, not another scope',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('r1', 'The user likes green tea'),
                await create('r2', 'The user rides a red bicycle'),
              ]),
            );
            await commit(
              store,
              await operation('op-x', [await create('x1', 'green tea again')], { scope: OTHER }),
            );

            const tea = await store.search({ scope: SCOPE, text: 'tea' });
            expect(ids(tea)).toEqual(['r1']);
            expect(tea[0]!.match).toBe('lexical');
            expect(tea[0]!.score).toBeGreaterThan(0);

            await commit(
              store,
              await operation('op-2', [await revise('r1', 1, 'The user likes black coffee')]),
            );
            expect(ids(await store.search({ scope: SCOPE, text: 'tea' }))).toEqual([]);
            const coffee = await store.search({ scope: SCOPE, text: 'coffee' });
            expect(ids(coffee)).toEqual(['r1']);
            expect(coffee[0]!.record.revision).toBe(2);

            await commit(store, await operation('op-3', [retract('r2', 1)]));
            expect(ids(await store.search({ scope: SCOPE, text: 'bicycle' }))).toEqual([]);
            const withRetracted = await store.search({
              scope: SCOPE,
              text: 'bicycle',
              includeRetracted: true,
            });
            expect(ids(withRetracted)).toEqual(['r2']);
            expect(withRetracted[0]!.record.status).toBe('retracted');
          });
        },
      );

      it('search honours kind and topK (default 5)', { timeout }, async () => {
        await withStore(async ({ store }) => {
          const mutations: VersionedMemoryMutation[] = [];
          for (let i = 0; i < 7; i++)
            mutations.push(
              await create(`n${i}`, `note number ${i}`, {
                kind: i < 2 ? 'procedural' : 'semantic',
              }),
            );
          await commit(store, await operation('op-1', mutations));
          expect(await store.search({ scope: SCOPE, text: 'note' })).toHaveLength(5);
          expect(await store.search({ scope: SCOPE, text: 'note', topK: 2 })).toHaveLength(2);
          const procedural = await store.search({
            scope: SCOPE,
            text: 'note',
            kind: 'procedural',
            topK: 10,
          });
          expect(ids(procedural).sort()).toEqual(['n0', 'n1']);
        });
      });

      it(
        'searches by vector over the active generation, ranked by cosine',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('far', 'orthogonal fact', { vector: [0, 0, 1] }),
                await create('near', 'exact fact', { vector: [1, 0, 0] }),
                await create('mid', 'related fact', { vector: [0.6, 0.8, 0] }),
              ]),
            );
            const hits = await store.search({
              scope: SCOPE,
              embedding: { vector: [1, 0, 0], modelId: MODEL_A },
              topK: 3,
            });
            expect(ids(hits)).toEqual(['near', 'mid', 'far']);
            expect(hits.every((hit) => hit.match === 'vector')).toBe(true);
            expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
            expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);

            const active = await store.embeddings.active();
            expect((await store.get(SCOPE, 'near'))?.embedding).toEqual({
              generation: active!.generation,
              modelId: MODEL_A,
              dims: 3,
              revision: 1,
              textDigest: await sha256Digest('exact fact'),
            });
          });
        },
      );

      it(
        'a vector search never fills topK with records that have no vector',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('vec', 'embedded fact', { vector: [1, 0, 0] }),
                await create('plain', 'fact written without an embedder'),
              ]),
            );
            const hits = await store.search({
              scope: SCOPE,
              embedding: { vector: [1, 0, 0], modelId: MODEL_A },
              topK: 5,
            });
            expect(ids(hits)).toEqual(['vec']);
            // Still found by text.
            expect(ids(await store.search({ scope: SCOPE, text: 'embedder' }))).toEqual(['plain']);
          });
        },
      );

      it('fuses a text and a vector match (hybrid)', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(
            store,
            await operation('op-1', [
              await create('alpha', 'alpha fact', { vector: [1, 0, 0] }),
              await create('beta', 'beta fact', { vector: [0, 1, 0] }),
              await create('gamma', 'gamma fact', { vector: [0.9, 0.1, 0] }),
            ]),
          );
          const hits = await store.search({
            scope: SCOPE,
            text: 'alpha',
            embedding: { vector: [1, 0, 0], modelId: MODEL_A },
            topK: 3,
          });
          expect(hits[0]!.record.id).toBe('alpha');
          if (hybrid) {
            expect(hits[0]!.match).toBe('hybrid');
            expect(hits.find((hit) => hit.record.id === 'gamma')?.match).toBe('vector');
          }
        });
      });

      it(
        'throws EmbeddingMismatchError for a query vector of another model or size',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [await create('r1', 'fact', { vector: [1, 0, 0] })]),
            );
            await expect(
              store.search({ scope: SCOPE, embedding: { vector: [1, 0, 0], modelId: MODEL_B } }),
            ).rejects.toBeInstanceOf(EmbeddingMismatchError);
            await expect(
              store.search({ scope: SCOPE, embedding: { vector: [1, 0], modelId: MODEL_A } }),
            ).rejects.toBeInstanceOf(EmbeddingMismatchError);
          });
        },
      );

      it(
        'refuses a commit vector of another model or size and applies nothing',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [await create('r1', 'fact', { vector: [1, 0, 0] })]),
            );
            await expect(
              store.commit(
                await operation('op-2', [
                  await create('r2', 'second', { vector: [1, 0, 0], modelId: MODEL_B }),
                ]),
              ),
            ).rejects.toBeInstanceOf(EmbeddingMismatchError);
            await expect(
              store.commit(
                await operation('op-3', [await create('r3', 'third', { vector: [1, 0] })]),
              ),
            ).rejects.toBeInstanceOf(EmbeddingMismatchError);
            expect(await store.get(SCOPE, 'r2')).toBeUndefined();
            expect(await store.get(SCOPE, 'r3')).toBeUndefined();
            expect(await store.scopeRevision(SCOPE)).toBe(1);
          });
        },
      );

      it('never carries a vector over to a revised text', { timeout }, async () => {
        await withStore(async ({ store }) => {
          await commit(
            store,
            await operation('op-1', [
              await create('r1', 'old meaning', { vector: [1, 0, 0] }),
              await create('r2', 'neighbour', { vector: [0.9, 0.1, 0] }),
            ]),
          );
          await commit(store, await operation('op-2', [await revise('r1', 1, 'new meaning')]));
          expect((await store.get(SCOPE, 'r1'))?.embedding).toBeUndefined();
          const hits = await store.search({
            scope: SCOPE,
            embedding: { vector: [1, 0, 0], modelId: MODEL_A },
          });
          expect(ids(hits)).toEqual(['r2']);
          expect(ids(await store.search({ scope: SCOPE, text: 'meaning' }))).toEqual(['r1']);

          await commit(
            store,
            await operation('op-3', [await revise('r1', 2, 'newer meaning', [1, 0, 0])]),
          );
          expect((await store.get(SCOPE, 'r1'))?.embedding).toMatchObject({
            revision: 3,
            textDigest: await sha256Digest('newer meaning'),
          });
        });
      });

      it('recordedAsOf answers with the revisions the store knew then', { timeout }, async () => {
        await withStore(async ({ store, clock, advance }) => {
          const before = clock.now() - 1;
          await commit(store, await operation('op-1', [await create('r1', 'first draft')]));
          const t1 = clock.now();
          await advance(1_000);
          await commit(store, await operation('op-2', [await revise('r1', 1, 'second draft')]));
          const t2 = clock.now();
          await advance(1_000);
          await commit(store, await operation('op-3', [retract('r1', 2)]));
          const t3 = clock.now();
          await advance(1_000);
          await commit(store, await operation('op-4', [await create('r2', 'late draft')]));

          const at = async (recordedAsOf: number, includeRetracted = false) =>
            (
              await store.search({
                scope: SCOPE,
                text: 'draft',
                recordedAsOf,
                includeRetracted,
                topK: 10,
              })
            ).map((hit) => [hit.record.id, hit.record.revision, hit.record.text]);
          expect(await at(before)).toEqual([]);
          expect(await at(t1)).toEqual([['r1', 1, 'first draft']]);
          expect(await at(t2 + 500)).toEqual([['r1', 2, 'second draft']]);
          expect(await at(t3)).toEqual([]);
          expect(await at(t3, true)).toEqual([['r1', 3, 'second draft']]);
          expect(await at(clock.now())).toEqual([['r2', 1, 'late draft']]);
        });
      });

      it(
        'a record past its TTL leaves normal retrieval; its history stays',
        { timeout },
        async () => {
          await withStore(async ({ store, clock, advance }) => {
            const expiresAt = clock.now() + 1_000;
            await commit(
              store,
              await operation('op-1', [await create('r1', 'temporary fact', { expiresAt })]),
            );
            expect(ids(await store.search({ scope: SCOPE, text: 'temporary' }))).toEqual(['r1']);
            await advance(1_001);
            expect(ids(await store.search({ scope: SCOPE, text: 'temporary' }))).toEqual([]);
            expect(
              ids(await store.search({ scope: SCOPE, text: 'temporary', includeExpired: true })),
            ).toEqual(['r1']);
            expect(
              ids(await store.search({ scope: SCOPE, text: 'temporary', now: expiresAt - 1 })),
            ).toEqual(['r1']);
            expect(await store.history(SCOPE, 'r1')).toHaveLength(1);
          });
        },
      );
    });

    describe('forget', () => {
      it(
        'deletes content, revisions and vectors; the receipts stay, content-free',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [await create('r1', 'secret fact', { vector: [1, 0, 0] })]),
            );
            await commit(
              store,
              await operation('op-2', [await revise('r1', 1, 'secret fact revised', [1, 0, 0])]),
            );
            await commit(
              store,
              await operation('op-k', [await create('keep', 'kept fact', { vector: [0, 1, 0] })]),
            );

            const event = await store.forget(SCOPE, 'r1', 'forget-1');
            expect(event).toEqual({
              scope: SCOPE,
              recordId: 'r1',
              revisions: [1, 2],
              operationId: 'forget-1',
            });

            expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toBeUndefined();
            expect(
              await store.get(SCOPE, 'r1', { revision: 1, includeRetracted: true }),
            ).toBeUndefined();
            expect(await store.history(SCOPE, 'r1')).toEqual([]);
            expect(
              ids(await store.search({ scope: SCOPE, text: 'secret', includeRetracted: true })),
            ).toEqual([]);
            expect(
              ids(
                await store.search({
                  scope: SCOPE,
                  embedding: { vector: [1, 0, 0], modelId: MODEL_A },
                  includeRetracted: true,
                }),
              ),
            ).toEqual(['keep']);

            const receipt = await store.receipt('op-1');
            expect(receipt).toMatchObject({ operationId: 'op-1', redacted: true });
            expect(await store.receipt('op-2')).toMatchObject({
              operationId: 'op-2',
              redacted: true,
            });
            expect((await store.receipt('op-k'))?.redacted).toBeFalsy();
            expect(JSON.stringify(receipt)).not.toContain('secret');
          });
        },
      );

      it('a redelivered operation cannot bring a forgotten record back', { timeout }, async () => {
        await withStore(async ({ store }) => {
          const op = await operation('op-1', [await create('r1', 'secret fact')]);
          await commit(store, op);
          await store.forget(SCOPE, 'r1', 'forget-1');

          const redelivered = await store.commit(op);
          expect(redelivered.status).toBe('replayed');
          expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toBeUndefined();

          for (const mutation of [
            await create('r1', 'secret fact'),
            await revise('r1', 1, 'again'),
          ]) {
            const result = await store.commit(await operation(`op-${mutation.type}`, [mutation]));
            expect(result.status).toBe('conflict');
            if (result.status !== 'conflict') continue;
            const entry = result.conflicts.find((c) => c.id === 'r1');
            expect(entry).toBeDefined();
            expect(entry!.actualRevision).toBeUndefined();
          }
          expect(await store.history(SCOPE, 'r1')).toEqual([]);
        });
      });

      it(
        'returns no revisions for an unknown record, a second forget or another scope',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            expect((await store.forget(SCOPE, 'ghost', 'f-0')).revisions).toEqual([]);
            await commit(store, await operation('op-1', [await create('r1', 'fact')]));
            expect((await store.forget(OTHER, 'r1', 'f-1')).revisions).toEqual([]);
            expect((await store.get(SCOPE, 'r1'))?.revision).toBe(1);
            expect((await store.forget(SCOPE, 'r1', 'f-2')).revisions).toEqual([1]);
            expect((await store.forget(SCOPE, 'r1', 'f-3')).revisions).toEqual([]);
          });
        },
      );

      it(
        'reports a record forgotten before in the scope, so a retry can finish its redaction',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(store, await operation('op-1', [await create('r1', 'fact')]));
            const first = await store.forget(SCOPE, 'r1', 'f-1');
            expect(first).toEqual({
              scope: SCOPE,
              recordId: 'r1',
              revisions: [1],
              operationId: 'f-1',
            });
            // A replay of the same forget, and a new forget of the same record, both say so:
            // revisions [] then stands for every revision the record had.
            const already = { scope: SCOPE, recordId: 'r1', revisions: [], alreadyForgotten: true };
            expect(await store.forget(SCOPE, 'r1', 'f-1')).toEqual({
              ...already,
              operationId: 'f-1',
            });
            expect(await store.forget(SCOPE, 'r1', 'f-2')).toEqual({
              ...already,
              operationId: 'f-2',
            });
            // Never for an id the scope does not own: unknown, or forgotten in another scope.
            expect(await store.forget(OTHER, 'r1', 'f-3')).toEqual({
              scope: OTHER,
              recordId: 'r1',
              revisions: [],
              operationId: 'f-3',
            });
            expect(await store.forget(SCOPE, 'ghost', 'f-4')).toEqual({
              scope: SCOPE,
              recordId: 'ghost',
              revisions: [],
              operationId: 'f-4',
            });
            expect(await store.forget(SCOPE, 'ghost', 'f-4')).toEqual({
              scope: SCOPE,
              recordId: 'ghost',
              revisions: [],
              operationId: 'f-4',
            });
          });
        },
      );

      it(
        'is an operation: a content-free receipt, a scope revision, an id never reused',
        { timeout },
        async () => {
          await withStore(async ({ store, clock }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('r1', 'first fact'),
                await create('r2', 'second fact'),
                await create('r3', 'third fact'),
              ]),
            );
            expect(await store.scopeRevision(SCOPE)).toBe(1);

            // Every committed forget moves its scope's revision, even one that deleted nothing.
            await store.forget(SCOPE, 'ghost', 'f-0');
            expect(await store.scopeRevision(SCOPE)).toBe(2);
            await store.forget(OTHER, 'r1', 'f-other');
            expect(await store.scopeRevision(OTHER)).toBe(1);
            expect(await store.scopeRevision(SCOPE)).toBe(2);

            // A host that lost the answer finds out from the receipt whether it committed.
            await store.forget(SCOPE, 'r1', 'f-1');
            const receipt = await store.receipt('f-1');
            expect(receipt).toMatchObject({
              operationId: 'f-1',
              scope: SCOPE,
              actor: 'host',
              scopeRevision: 3,
              entries: [],
              committedAt: clock.now(),
            });
            expect(isSha256Digest(receipt!.requestDigest)).toBe(true);
            expect(JSON.stringify(receipt)).not.toContain('first fact');
            expect(await store.receipt('f-0')).toMatchObject({ scopeRevision: 2, entries: [] });

            // The same forget again replays: nothing moves.
            expect((await store.forget(SCOPE, 'r1', 'f-1')).revisions).toEqual([]);
            expect(await store.scopeRevision(SCOPE)).toBe(3);

            // Its id, or a commit's, is refused for another forget, and a commit cannot take it.
            await expect(store.forget(SCOPE, 'r2', 'op-1')).rejects.toBeInstanceOf(
              OperationConflictError,
            );
            await expect(store.forget(SCOPE, 'r3', 'f-1')).rejects.toBeInstanceOf(
              OperationConflictError,
            );
            await expect(
              store.commit(await operation('f-1', [await create('r4', 'fourth fact')])),
            ).rejects.toBeInstanceOf(OperationConflictError);
            expect((await store.get(SCOPE, 'r2'))?.text).toBe('second fact');
            expect((await store.get(SCOPE, 'r3'))?.text).toBe('third fact');
            expect(await store.get(SCOPE, 'r4')).toBeUndefined();
            expect(await store.scopeRevision(SCOPE)).toBe(3);
          });
        },
      );
    });

    describe('embedding generations', () => {
      it('has no active generation until a vector is stored', { timeout }, async () => {
        await withStore(async ({ store }) => {
          expect(await store.embeddings.active()).toBeUndefined();
          await commit(store, await operation('op-0', [await create('plain', 'no vector here')]));
          expect(await store.embeddings.active()).toBeUndefined();
          await commit(
            store,
            await operation('op-1', [await create('r1', 'fact', { vector: [1, 0, 0] })]),
          );
          expect(await store.embeddings.active()).toMatchObject({
            modelId: MODEL_A,
            dims: 3,
            status: 'active',
          });
        });
      });

      it(
        're-embeds into a pending generation and switches atomically once complete',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('r1', 'first fact', { vector: [1, 0, 0] }),
                await create('r2', 'second fact', { vector: [0, 1, 0] }),
              ]),
            );
            const old = (await store.embeddings.active())!;

            const next = await store.embeddings.begin({ modelId: MODEL_B, dims: 2 });
            expect(next).toMatchObject({ modelId: MODEL_B, dims: 2, status: 'pending' });
            expect(next.generation).not.toBe(old.generation);
            expect((await store.embeddings.begin({ modelId: MODEL_B, dims: 2 })).generation).toBe(
              next.generation,
            );

            const pending = await store.embeddings.pending(next.generation, { limit: 10 });
            expect(pending).toEqual([
              {
                id: 'r1',
                revision: 1,
                scope: SCOPE,
                text: 'first fact',
                textDigest: await sha256Digest('first fact'),
              },
              {
                id: 'r2',
                revision: 1,
                scope: SCOPE,
                text: 'second fact',
                textDigest: await sha256Digest('second fact'),
              },
            ]);
            expect(
              (await store.embeddings.pending(next.generation, { limit: 1 })).map((i) => i.id),
            ).toEqual(['r1']);
            expect(
              (await store.embeddings.pending(next.generation, { limit: 1, after: 'r1' })).map(
                (i) => i.id,
              ),
            ).toEqual(['r2']);

            expect(
              await store.embeddings.put(next.generation, [
                {
                  id: 'r1',
                  revision: 1,
                  textDigest: await sha256Digest('first fact'),
                  vector: [1, 0],
                },
              ]),
            ).toBe(1);
            // Incomplete: nothing switches, the old generation keeps answering.
            expect(await store.embeddings.activate(next.generation)).toBe(false);
            expect((await store.embeddings.active())?.generation).toBe(old.generation);
            expect(
              ids(
                await store.search({
                  scope: SCOPE,
                  embedding: { vector: [1, 0, 0], modelId: MODEL_A },
                }),
              )[0],
            ).toBe('r1');
            await expect(
              store.search({ scope: SCOPE, embedding: { vector: [1, 0], modelId: MODEL_B } }),
            ).rejects.toBeInstanceOf(EmbeddingMismatchError);

            // r2 changes meanwhile: a vector of its old text is skipped, and it is pending again.
            await commit(
              store,
              await operation('op-2', [await revise('r2', 1, 'second fact revised', [0, 1, 0])]),
            );
            expect(
              await store.embeddings.put(next.generation, [
                {
                  id: 'r2',
                  revision: 1,
                  textDigest: await sha256Digest('second fact'),
                  vector: [0, 1],
                },
              ]),
            ).toBe(0);
            expect(await store.embeddings.pending(next.generation, { limit: 10 })).toEqual([
              {
                id: 'r2',
                revision: 2,
                scope: SCOPE,
                text: 'second fact revised',
                textDigest: await sha256Digest('second fact revised'),
              },
            ]);
            expect(
              await store.embeddings.put(next.generation, [
                {
                  id: 'r2',
                  revision: 2,
                  textDigest: await sha256Digest('second fact revised'),
                  vector: [0, 1],
                },
              ]),
            ).toBe(1);

            expect(await store.embeddings.activate(next.generation)).toBe(true);
            expect(await store.embeddings.active()).toMatchObject({
              generation: next.generation,
              modelId: MODEL_B,
              dims: 2,
              status: 'active',
            });
            expect(
              ids(
                await store.search({
                  scope: SCOPE,
                  embedding: { vector: [0, 1], modelId: MODEL_B },
                }),
              )[0],
            ).toBe('r2');
            await expect(
              store.search({ scope: SCOPE, embedding: { vector: [1, 0, 0], modelId: MODEL_A } }),
            ).rejects.toBeInstanceOf(EmbeddingMismatchError);
            expect((await store.get(SCOPE, 'r1'))?.embedding).toMatchObject({
              generation: next.generation,
              modelId: MODEL_B,
              dims: 2,
              revision: 1,
            });
          });
        },
      );

      it(
        'prepares one generation at a time: another model or size retires the pending one',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('r1', 'first fact', { vector: [1, 0, 0] }),
                await create('r2', 'second fact', { vector: [0, 1, 0] }),
              ]),
            );
            const old = (await store.embeddings.active())!;
            const vector = async (id: string, text: string, values: number[]) => ({
              id,
              revision: 1,
              textDigest: await sha256Digest(text),
              vector: values,
            });

            const abandoned = await store.embeddings.begin({ modelId: MODEL_B, dims: 2 });
            expect(
              await store.embeddings.put(abandoned.generation, [
                await vector('r1', 'first fact', [1, 0]),
              ]),
            ).toBe(1);
            // Another size of the same model replaces it.
            const resized = await store.embeddings.begin({ modelId: MODEL_B, dims: 3 });
            expect(resized).toMatchObject({ modelId: MODEL_B, dims: 3, status: 'pending' });
            expect(resized.generation).not.toBe(abandoned.generation);

            // The retired one lists nothing, takes nothing (a racing filler
            // loses quietly) and never becomes active.
            expect(await store.embeddings.pending(abandoned.generation, { limit: 10 })).toEqual([]);
            expect(
              await store.embeddings.put(abandoned.generation, [
                await vector('r2', 'second fact', [0, 1]),
              ]),
            ).toBe(0);
            expect(await store.embeddings.activate(abandoned.generation)).toBe(false);
            expect((await store.embeddings.active())?.generation).toBe(old.generation);

            // Asking for the first model again starts afresh: its old vectors are gone.
            const again = await store.embeddings.begin({ modelId: MODEL_B, dims: 2 });
            expect(again.generation).not.toBe(abandoned.generation);
            expect(again.generation).not.toBe(resized.generation);
            expect(await store.embeddings.pending(resized.generation, { limit: 10 })).toEqual([]);
            expect(
              (await store.embeddings.pending(again.generation, { limit: 10 })).map(
                (item) => item.id,
              ),
            ).toEqual(['r1', 'r2']);
            expect(
              await store.embeddings.put(again.generation, [
                await vector('r1', 'first fact', [1, 0]),
                await vector('r2', 'second fact', [0, 1]),
              ]),
            ).toBe(2);
            expect(await store.embeddings.activate(again.generation)).toBe(true);
            expect(await store.embeddings.activate(abandoned.generation)).toBe(false);
            expect(await store.embeddings.activate(resized.generation)).toBe(false);
            expect(await store.embeddings.active()).toMatchObject({
              generation: again.generation,
              modelId: MODEL_B,
              dims: 2,
              status: 'active',
            });
          });
        },
      );

      it(
        'never stores into, lists or activates an unknown or retired generation',
        { timeout },
        async () => {
          await withStore(async ({ store }) => {
            const unknown = 9_999;
            expect(await store.embeddings.pending(unknown, { limit: 10 })).toEqual([]);
            expect(await store.embeddings.put(unknown, [])).toBe(0);
            expect(await store.embeddings.activate(unknown)).toBe(false);

            // An empty store: every generation is complete at once.
            const first = await store.embeddings.begin({ modelId: MODEL_A, dims: 3 });
            expect(await store.embeddings.activate(first.generation)).toBe(true);
            expect(await store.embeddings.activate(first.generation)).toBe(true);
            const second = await store.embeddings.begin({ modelId: MODEL_B, dims: 2 });
            expect(await store.embeddings.activate(second.generation)).toBe(true);
            // The generation it replaced is retired for good, never active again.
            expect(await store.embeddings.activate(first.generation)).toBe(false);
            expect((await store.embeddings.active())?.generation).toBe(second.generation);

            await commit(
              store,
              await operation('op-1', [
                await create('r1', 'first fact', { vector: [1, 0], modelId: MODEL_B }),
              ]),
            );
            const r1 = {
              id: 'r1',
              revision: 1,
              textDigest: await sha256Digest('first fact'),
            };
            expect(await store.embeddings.pending(first.generation, { limit: 10 })).toEqual([]);
            expect(
              await store.embeddings.put(first.generation, [{ ...r1, vector: [1, 0, 0] }]),
            ).toBe(0);
            expect(await store.embeddings.put(unknown, [{ ...r1, vector: [1, 0] }])).toBe(0);
            expect(await store.embeddings.activate(first.generation)).toBe(false);
            expect(await store.embeddings.active()).toMatchObject({
              generation: second.generation,
              modelId: MODEL_B,
            });
            expect((await store.get(SCOPE, 'r1'))?.embedding).toMatchObject({
              generation: second.generation,
            });
          });
        },
      );
    });

    describe('retention', () => {
      it(
        'pruneHistory deletes past revisions of retracted or expired records only',
        { timeout },
        async () => {
          await withStore(async ({ store, clock, advance }) => {
            await commit(
              store,
              await operation('op-1', [
                await create('gone', 'retracted fact'),
                await create('live', 'living fact'),
                await create('ttl', 'expiring fact', { expiresAt: clock.now() + 5_000 }),
              ]),
            );
            await advance(1_000);
            await commit(
              store,
              await operation('op-2', [
                await revise('gone', 1, 'retracted fact v2'),
                await revise('live', 1, 'living fact v2'),
                await revise('ttl', 1, 'expiring fact v2'),
              ]),
            );
            await advance(1_000);
            await commit(store, await operation('op-3', [retract('gone', 2)]));
            await advance(10_000);

            expect(await store.pruneHistory({ olderThan: T0 })).toBe(0);
            expect(await store.pruneHistory({ olderThan: clock.now() })).toBe(3);
            expect((await store.history(SCOPE, 'gone')).map((r) => r.revision)).toEqual([3]);
            expect((await store.history(SCOPE, 'ttl')).map((r) => r.revision)).toEqual([2]);
            expect((await store.history(SCOPE, 'live')).map((r) => r.revision)).toEqual([1, 2]);
            expect(await store.receipt('op-1')).toBeDefined();
            expect(await store.get(SCOPE, 'gone', { includeRetracted: true })).toMatchObject({
              revision: 3,
            });
          });
        },
      );

      it(
        'pruneOperations deletes old receipts, warns, and gives up their dedupe',
        { timeout },
        async () => {
          await withStore(async ({ store, clock, advance, warn }) => {
            const old = await operation('op-old', []);
            await commit(store, old);
            await advance(1_000);
            const cutoff = clock.now();
            await commit(store, await operation('op-new', []));

            expect(await store.pruneOperations({ olderThan: cutoff })).toBe(1);
            expect(warn).toHaveBeenCalled();
            expect(await store.receipt('op-old')).toBeUndefined();
            expect(await store.receipt('op-new')).toBeDefined();
            // The protection is gone: a redelivery is applied again.
            expect((await store.commit(old)).status).toBe('committed');
            expect(await store.scopeRevision(SCOPE)).toBe(3);
          });
        },
      );
    });
  });
}
