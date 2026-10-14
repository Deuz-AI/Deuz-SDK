/**
 * The goal runtime store contract (2.4, spec §3.1–§3.2): what the in-memory,
 * SQLite and PostgreSQL stores all keep beyond the 2.3 goal-store fixture.
 * Run it against your own store:
 *
 * ```ts
 * goalRuntimeStoreContracts('my store', async ({ clock }) => ({
 *   store: createMyGoalRuntimeStore({ clock }),
 *   cleanup: () => store.close(),
 * }));
 * ```
 *
 * The store must stamp its own times (`enqueuedAt`, `settledAt`, `recordedAt`,
 * `updatedAt`) from `clock`. Every multi-part write is checked whole: a write
 * refused for any one reason leaves every part of the store as it was.
 */
import { describe, expect, it } from 'vitest';
import { createGoal, createGoalEvent, transitionGoal } from '../../src/goal';
import type { GoalEvent, GoalRecord } from '../../src/goal';
import { DEFAULT_GOAL_RUNTIME_POLICY, goalInboxKey } from '../../src/goal/runtime';
import type {
  GoalInboxEnqueue,
  GoalInboxQuery,
  GoalRuntimeState,
  GoalRuntimeStore,
} from '../../src/goal/runtime';
import type { Sha256Digest } from '../../src/internal/digest';
import type { Clock } from '../../src/types/deps';
import { manualClock } from './manual-clock';

export const T0 = Date.parse('2026-10-10T10:00:00Z');

export interface GoalRuntimeStoreHarness {
  store: GoalRuntimeStore;
  cleanup?: () => unknown;
}

export interface GoalRuntimeStoreContext {
  /** The clock the store must stamp its times with; starts at `T0`. */
  clock: Clock;
}

export type GoalRuntimeStoreFactory = (
  context: GoalRuntimeStoreContext,
) => GoalRuntimeStoreHarness | Promise<GoalRuntimeStoreHarness>;

/** A goal at revision 1. */
export function runtimeGoal(goalId: string, scope = 'tenant', now = T0): GoalRecord {
  return createGoal({ goalId, scope, objective: `Finish ${goalId}.` }, { now });
}

/** The goal one revision on (a `link-run`, which every goal accepts). */
export function nextGoal(goal: GoalRecord, runId = `run-${goal.revision + 1}`): GoalRecord {
  return transitionGoal(goal, { type: 'link-run', runId }, { now: goal.updatedAt + 1 }).record;
}

/** A runtime state for `goal` at `revision`. */
export function runtimeState(
  goal: Pick<GoalRecord, 'goalId' | 'scope'>,
  revision = 1,
  patch: Partial<GoalRuntimeState> = {},
): GoalRuntimeState {
  return {
    goalId: goal.goalId,
    scope: goal.scope,
    revision,
    policy: {
      ...DEFAULT_GOAL_RUNTIME_POLICY,
      retryDelaysMs: [...DEFAULT_GOAL_RUNTIME_POLICY.retryDelaysMs],
    },
    phase: 'idle',
    runs: 0,
    retries: 0,
    createdAt: T0,
    updatedAt: T0 + revision,
    ...patch,
  };
}

/** An event for `goal`, keyed `key`. */
export function goalEvent(
  goal: Pick<GoalRecord, 'goalId' | 'scope'>,
  key: string,
  patch: Partial<Pick<GoalEvent, 'at' | 'notBefore' | 'expiresAt'>> = {},
): GoalEvent {
  return createGoalEvent({
    source: { type: 'signal', id: 'hook' },
    scope: goal.scope,
    goalId: goal.goalId,
    key,
    at: T0,
    ...patch,
  });
}

/** Two well-formed digests that differ. */
export const DIGEST_A: Sha256Digest = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B: Sha256Digest = `sha256:${'b'.repeat(64)}`;

/** A webhook delivery for `goal`. */
export function delivery(
  goal: Pick<GoalRecord, 'goalId' | 'scope'>,
  deliveryId: string,
  patch: Partial<GoalInboxEnqueue> = {},
): GoalInboxEnqueue {
  return {
    scope: goal.scope,
    goalId: goal.goalId,
    namespace: 'webhook:github',
    deliveryId,
    event: goalEvent(goal, deliveryId),
    payload: { body: `{"delivery":"${deliveryId}"}`, mediaType: 'application/json' },
    digest: DIGEST_A,
    ...patch,
  };
}

export function goalRuntimeStoreContracts(
  name: string,
  make: GoalRuntimeStoreFactory,
  options: { timeout?: number } = {},
): void {
  /** Runs `fn` on a fresh store and cleans it up, pass or fail. */
  const withStore =
    (fn: (store: GoalRuntimeStore, time: ReturnType<typeof manualClock>) => Promise<void>) =>
    async () => {
      const time = manualClock(T0);
      const harness = await make({ clock: time.clock });
      try {
        await fn(harness.store, time);
      } finally {
        await harness.cleanup?.();
      }
    };

  describe(`${name}: goal runtime store contract`, { timeout: options.timeout }, () => {
    describe('runtime state', () => {
      it(
        'saves a state at revision 1 for a stored goal, and returns copies in its scope only',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          expect(await store.runtime.get('tenant', 'g')).toBeUndefined();
          const state = runtimeState(goal);
          expect(await store.runtime.save(state)).toEqual({ status: 'committed' });
          state.phase = 'running';
          const loaded = await store.runtime.get('tenant', 'g');
          expect(loaded).toEqual(runtimeState(goal));
          loaded!.policy.retryDelaysMs.push(1);
          expect((await store.runtime.get('tenant', 'g'))!.policy.retryDelaysMs).toEqual([
            1_000, 5_000, 30_000,
          ]);
          expect(await store.runtime.get('other', 'g')).toBeUndefined();
        }),
      );

      it(
        'saves each revision once, in order (the compare-and-set fence)',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.runtime.save(runtimeState(goal, 1));
          const conflict = { status: 'conflict', reason: 'runtime-revision' };
          expect(await store.runtime.save(runtimeState(goal, 1, { phase: 'running' }))).toEqual(
            conflict,
          );
          expect(await store.runtime.save(runtimeState(goal, 3))).toEqual(conflict);
          expect(await store.runtime.save(runtimeState(goal, 2, { phase: 'dispatching' }))).toEqual(
            { status: 'committed' },
          );
          expect((await store.runtime.get('tenant', 'g'))?.phase).toBe('dispatching');
        }),
      );

      it(
        'saves the goal in the same write, all or nothing',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          // A new goal and its first state, together (a supervisor's submit).
          expect(await store.runtime.save(runtimeState(goal), goal)).toEqual({
            status: 'committed',
          });
          expect(await store.load('g')).toEqual(goal);
          // A stale goal refuses the whole write: the state does not move either.
          expect(await store.runtime.save(runtimeState(goal, 2), goal)).toEqual({
            status: 'conflict',
            reason: 'goal-revision',
          });
          expect((await store.runtime.get('tenant', 'g'))?.revision).toBe(1);
          // A stale state refuses the whole write: the goal does not move either.
          const next = nextGoal(goal);
          expect(await store.runtime.save(runtimeState(goal, 1), next)).toEqual({
            status: 'conflict',
            reason: 'runtime-revision',
          });
          expect((await store.load('g'))?.revision).toBe(1);
          expect(await store.runtime.save(runtimeState(goal, 2), next)).toEqual({
            status: 'committed',
          });
          expect(await store.load('g')).toEqual(next);
        }),
      );

      it(
        "keeps a state in its goal's scope",
        withStore(async (store) => {
          const goal = runtimeGoal('g', 'tenant-a');
          await store.save(goal);
          const mismatch = { status: 'conflict', reason: 'scope-mismatch' };
          // The goal lives in another scope.
          expect(
            await store.runtime.save(runtimeState({ goalId: 'g', scope: 'tenant-b' })),
          ).toEqual(mismatch);
          // No such goal, and none saved with it.
          expect(await store.runtime.save(runtimeState(runtimeGoal('missing')))).toEqual(mismatch);
          // A goal of another id or scope than the state's.
          expect(
            await store.runtime.save(runtimeState(goal), { ...nextGoal(goal), goalId: 'h' }),
          ).toEqual(mismatch);
          expect(await store.runtime.get('tenant-b', 'g')).toBeUndefined();
          expect(await store.runtime.get('tenant-a', 'g')).toBeUndefined();
          expect(await store.load('h')).toBeUndefined();
        }),
      );

      it(
        'persists a cancel request apart from the cancel, and never withdraws it',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.runtime.save(runtimeState(goal, 1, { phase: 'running' }));
          const requested = { requestedAt: T0 + 5, reason: 'host asked' };
          await store.runtime.save(runtimeState(goal, 2, { phase: 'running', cancel: requested }));
          const stored = await store.runtime.get('tenant', 'g');
          expect(stored?.cancel).toEqual(requested);
          expect((await store.load('g'))?.status).toBe('active');
          // A save that drops or rewrites the request is refused; nothing moves.
          await expect(
            store.runtime.save(runtimeState(goal, 3, { phase: 'idle' })),
          ).rejects.toThrow(TypeError);
          await expect(
            store.runtime.save(runtimeState(goal, 3, { cancel: { requestedAt: T0 + 6 } })),
          ).rejects.toThrow(TypeError);
          expect((await store.runtime.get('tenant', 'g'))?.revision).toBe(2);
          // Applying it keeps the request and adds when it took effect.
          const cancelled = transitionGoal(goal, { type: 'cancel' }, { now: T0 + 7 }).record;
          const applied = { ...requested, appliedAt: T0 + 7 };
          expect(
            await store.runtime.save(
              runtimeState(goal, 3, { phase: 'done', cancel: applied }),
              cancelled,
            ),
          ).toEqual({ status: 'committed' });
          expect((await store.runtime.get('tenant', 'g'))?.cancel).toEqual(applied);
          expect((await store.load('g'))?.status).toBe('cancelled');
          await expect(
            store.runtime.save(runtimeState(goal, 4, { phase: 'done', cancel: requested })),
          ).rejects.toThrow(TypeError);
        }),
      );

      it(
        'refuses a malformed state without writing',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          for (const bad of [
            { ...runtimeState(goal), revision: 0 },
            { ...runtimeState(goal), phase: 'sleeping' },
            { ...runtimeState(goal), policy: undefined },
            { ...runtimeState(goal), runs: -1 },
            { ...runtimeState(goal), goalId: '' },
            { ...runtimeState(goal), updatedAt: Number.NaN },
          ])
            await expect(
              Promise.resolve().then(() => store.runtime.save(bad as GoalRuntimeState)),
              JSON.stringify(bad),
            ).rejects.toThrow(TypeError);
          expect(await store.runtime.get('tenant', 'g')).toBeUndefined();
        }),
      );
    });

    describe('inbox enqueue', () => {
      it(
        'queues a delivery once under its scope, namespace and delivery id',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          const result = await store.inbox.enqueue(delivery(goal, 'd1'));
          const id = goalInboxKey('tenant', 'webhook:github', 'd1');
          const expected = {
            ...delivery(goal, 'd1'),
            id,
            disposition: 'pending',
            enqueuedAt: T0,
          };
          expect(result).toEqual({ status: 'enqueued', entry: expected });
          const loaded = await store.inbox.get('tenant', id);
          expect(loaded).toEqual(expected);
          loaded!.payload!.body = 'changed';
          expect((await store.inbox.get('tenant', id))!.payload!.body).toBe('{"delivery":"d1"}');
          expect(await store.inbox.get('other', id)).toBeUndefined();
          expect(
            await store.inbox.get('tenant', goalInboxKey('tenant', 'webhook:github', 'd2')),
          ).toBeUndefined();
        }),
      );

      it(
        'answers a repeat with the same content as a duplicate, and one with other content as a conflict',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          const other = runtimeGoal('h');
          await store.save(goal);
          await store.save(other);
          const first = await store.inbox.enqueue(delivery(goal, 'd1'));
          await time.advance(1_000);
          const stored = first.entry;
          // The same content: a duplicate, answered with the stored entry.
          expect(await store.inbox.enqueue(delivery(goal, 'd1'))).toEqual({
            status: 'duplicate',
            entry: stored,
          });
          // Another payload digest, or another target goal: a conflict, nothing written.
          expect(await store.inbox.enqueue(delivery(goal, 'd1', { digest: DIGEST_B }))).toEqual({
            status: 'conflict',
            entry: stored,
          });
          expect(await store.inbox.enqueue(delivery(other, 'd1'))).toEqual({
            status: 'conflict',
            entry: stored,
          });
          expect(await store.inbox.get('tenant', stored.id)).toEqual(stored);
          // Another namespace or scope is another delivery.
          const github = await store.inbox.enqueue(
            delivery(goal, 'd1', { namespace: 'webhook:slack' }),
          );
          expect(github.status).toBe('enqueued');
        }),
      );

      it(
        'queues only for a goal of the same scope',
        withStore(async (store) => {
          const goal = runtimeGoal('g', 'tenant-a');
          await store.save(goal);
          const foreign = { ...delivery(goal, 'd1'), scope: 'tenant-b' };
          foreign.event = { ...foreign.event, scope: 'tenant-b' };
          await expect(store.inbox.enqueue(foreign)).rejects.toMatchObject({
            code: 'scope_mismatch',
          });
          await expect(
            store.inbox.enqueue(delivery(runtimeGoal('missing', 'tenant-a'), 'd1')),
          ).rejects.toMatchObject({ code: 'scope_mismatch' });
          expect(await store.inbox.list({ scope: 'tenant-b', dispositions: [] })).toEqual({
            entries: [],
          });
          expect(
            await store.inbox.get('tenant-b', goalInboxKey('tenant-b', 'webhook:github', 'd1')),
          ).toBeUndefined();
        }),
      );

      it(
        'refuses a malformed delivery without writing',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          for (const bad of [
            delivery(goal, 'd1', { deliveryId: '' }),
            delivery(goal, 'd1', { namespace: '' }),
            delivery(goal, 'd1', { digest: 'sha256:nope' as Sha256Digest }),
            delivery(goal, 'd1', { event: goalEvent(runtimeGoal('h'), 'd1') }),
            delivery(goal, 'd1', { payload: { body: 42 as unknown as string } }),
          ])
            await expect(
              Promise.resolve().then(() => store.inbox.enqueue(bad)),
              JSON.stringify(bad),
            ).rejects.toThrow();
          expect((await store.inbox.list({ scope: 'tenant' })).entries).toEqual([]);
        }),
      );
    });

    describe('inbox listing', () => {
      it(
        'lists pending entries oldest first, by goal, disposition and due time, page by page',
        withStore(async (store, time) => {
          const g = runtimeGoal('g');
          const h = runtimeGoal('h');
          await store.save(g);
          await store.save(h);
          await store.inbox.enqueue(delivery(g, 'b'));
          await store.inbox.enqueue(delivery(g, 'a'));
          await time.advance(10);
          await store.inbox.enqueue(delivery(h, 'c'));
          await time.advance(10);
          await store.inbox.enqueue(
            delivery(g, 'later', { event: goalEvent(g, 'later', { notBefore: T0 + 100 }) }),
          );
          const ids = async (query: GoalInboxQuery) =>
            (await store.inbox.list(query)).entries.map((entry) => entry.deliveryId);
          // Same time: by entry id.
          expect(await ids({ scope: 'tenant' })).toEqual(['a', 'b', 'c', 'later']);
          expect(await ids({ scope: 'tenant', goalId: 'g' })).toEqual(['a', 'b', 'later']);
          expect(await ids({ scope: 'tenant', dueBy: T0 + 99 })).toEqual(['a', 'b', 'c']);
          expect(await ids({ scope: 'tenant', dueBy: T0 + 100 })).toEqual(['a', 'b', 'c', 'later']);
          expect(await ids({ scope: 'tenant', dispositions: ['applied'] })).toEqual([]);
          expect(await ids({ scope: 'other' })).toEqual([]);
          const pages: string[][] = [];
          let cursor: string | undefined;
          do {
            const page = await store.inbox.list({ scope: 'tenant', limit: 3, cursor });
            pages.push(page.entries.map((entry) => entry.deliveryId));
            cursor = page.cursor;
          } while (cursor);
          expect(pages).toEqual([['a', 'b', 'c'], ['later']]);
          for (const query of [
            { scope: 'tenant', limit: 0 },
            { scope: 'tenant', limit: 1001 },
            { scope: 'tenant', cursor: 'nope' },
            { scope: 'tenant', dispositions: ['lost'] },
            { scope: '' },
            {},
          ])
            await expect(
              Promise.resolve().then(() => store.inbox.list(query as GoalInboxQuery)),
              JSON.stringify(query),
            ).rejects.toThrow(TypeError);
        }),
      );
    });
  });
}
