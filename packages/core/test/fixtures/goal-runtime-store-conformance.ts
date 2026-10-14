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
import type { GoalRecord } from '../../src/goal';
import { DEFAULT_GOAL_RUNTIME_POLICY } from '../../src/goal/runtime';
import type { GoalRuntimeState, GoalRuntimeStore } from '../../src/goal/runtime';
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
export function goalEvent(goal: Pick<GoalRecord, 'goalId' | 'scope'>, key: string, at = T0) {
  return createGoalEvent({
    source: { type: 'signal', id: 'hook' },
    scope: goal.scope,
    goalId: goal.goalId,
    key,
    at,
  });
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
  });
}
