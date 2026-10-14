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
  DurableScheduleInput,
  DurableScheduleQuery,
  GoalInboxApplication,
  GoalInboxEnqueue,
  GoalInboxQuery,
  GoalRunIntentInput,
  GoalRuntimeState,
  GoalRuntimeStore,
  ScheduleAdvance,
  ScheduleOccurrenceRecord,
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

/** A run intent for `goal`. */
export function runIntent(
  goal: Pick<GoalRecord, 'goalId' | 'scope'>,
  intentId: string,
  patch: Partial<GoalRunIntentInput> = {},
): GoalRunIntentInput {
  return {
    intentId,
    scope: goal.scope,
    goalId: goal.goalId,
    kind: 'start',
    runId: `run-${intentId}`,
    attempt: 1,
    ...patch,
  };
}

/** A schedule for `goal`, every minute in UTC unless patched. */
export function scheduleInput(
  goal: Pick<GoalRecord, 'goalId' | 'scope'>,
  scheduleId: string,
  patch: Partial<DurableScheduleInput> = {},
): DurableScheduleInput {
  return {
    scheduleId,
    scope: goal.scope,
    goalId: goal.goalId,
    spec: { cron: '* * * * *' },
    ...patch,
  };
}

const MINUTE = 60_000;

/** The occurrence of schedule `scheduleId` at `at`, delivered to `goal` or skipped. */
export function occurrence(
  goal: Pick<GoalRecord, 'goalId' | 'scope'>,
  scheduleId: string,
  at: number,
  skipped?: ScheduleOccurrenceRecord['reason'],
): ScheduleAdvance['occurrences'][number] {
  const occurrenceId = `${scheduleId}@${at}`;
  const base = { occurrenceId, scheduleId, scope: goal.scope, goalId: goal.goalId, at };
  if (skipped) return { ...base, disposition: 'skipped', reason: skipped };
  return {
    ...base,
    disposition: 'delivered',
    delivery: {
      scope: goal.scope,
      goalId: goal.goalId,
      namespace: `schedule:${scheduleId}`,
      deliveryId: occurrenceId,
      event: createGoalEvent({
        source: { type: 'schedule', id: scheduleId },
        scope: goal.scope,
        goalId: goal.goalId,
        key: occurrenceId,
        at,
        notBefore: at,
      }),
      digest: DIGEST_A,
    },
  };
}

/** A goal with a schedule `s1` created at `T0` (its cursor there). */
async function goalWithSchedule(store: GoalRuntimeStore) {
  const goal = runtimeGoal('g');
  await store.save(goal);
  await store.schedules.put(scheduleInput(goal, 's1'), { expectedRevision: 0, effectiveFrom: T0 });
  return goal;
}

/** A goal with one queued delivery `d1` and a runtime state at revision 1. */
async function goalWithDelivery(store: GoalRuntimeStore, goalId = 'g') {
  const goal = runtimeGoal(goalId);
  await store.runtime.save(runtimeState(goal), goal);
  const { entry } = await store.inbox.enqueue(delivery(goal, 'd1'));
  return { goal, entry };
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

    describe('inbox apply', () => {
      it(
        'settles the entry with the goal, the runtime state and a run intent in one write',
        withStore(async (store, time) => {
          const { goal, entry } = await goalWithDelivery(store);
          await time.advance(500);
          const next = nextGoal(goal);
          const result = await store.inbox.apply({
            scope: 'tenant',
            goalId: 'g',
            entryId: entry.id,
            disposition: 'applied',
            goal: next,
            runtime: runtimeState(goal, 2, { phase: 'dispatching' }),
            intent: runIntent(goal, 'g#2', { cause: { inboxEntryId: entry.id } }),
          });
          expect(result).toEqual({ status: 'committed' });
          expect(await store.inbox.get('tenant', entry.id)).toEqual({
            ...entry,
            disposition: 'applied',
            settledAt: T0 + 500,
            goalRevision: 2,
            intentId: 'g#2',
          });
          expect(await store.load('g')).toEqual(next);
          expect((await store.runtime.get('tenant', 'g'))?.phase).toBe('dispatching');
          expect(await store.intents.get('tenant', 'g#2')).toEqual({
            ...runIntent(goal, 'g#2', { cause: { inboxEntryId: entry.id } }),
            status: 'pending',
            revision: 1,
            recordedAt: T0 + 500,
            updatedAt: T0 + 500,
          });
          expect(await store.intents.get('other', 'g#2')).toBeUndefined();
          expect((await store.inbox.list({ scope: 'tenant' })).entries).toEqual([]);
        }),
      );

      it(
        'settles an entry alone with an explicit disposition',
        withStore(async (store) => {
          const { goal, entry } = await goalWithDelivery(store);
          for (const disposition of ['unmatched', 'stale', 'expired', 'terminal'] as const) {
            const { entry: other } = await store.inbox.enqueue(delivery(goal, disposition));
            expect(
              await store.inbox.apply({
                scope: 'tenant',
                goalId: 'g',
                entryId: other.id,
                disposition,
              }),
            ).toEqual({ status: 'committed' });
            expect((await store.inbox.get('tenant', other.id))?.disposition).toBe(disposition);
          }
          expect((await store.inbox.get('tenant', entry.id))?.disposition).toBe('pending');
          expect((await store.load('g'))?.revision).toBe(1);
          expect(
            (
              await store.inbox.list({ scope: 'tenant', dispositions: ['stale', 'expired'] })
            ).entries
              .map((settled) => settled.deliveryId)
              .sort(),
          ).toEqual(['expired', 'stale']);
        }),
      );

      it(
        'writes nothing when any one check fails',
        withStore(async (store) => {
          const { goal, entry } = await goalWithDelivery(store);
          await store.intents.record(runIntent(goal, 'taken'));
          const full = (patch: Partial<GoalInboxApplication>): GoalInboxApplication => ({
            scope: 'tenant',
            goalId: 'g',
            entryId: entry.id,
            disposition: 'applied',
            goal: nextGoal(goal),
            runtime: runtimeState(goal, 2),
            intent: runIntent(goal, 'g#2'),
            ...patch,
          });
          const cases: [Partial<GoalInboxApplication>, string][] = [
            [{ goal: { ...nextGoal(goal), revision: 3 } }, 'goal-revision'],
            [{ runtime: runtimeState(goal, 1) }, 'runtime-revision'],
            [{ intent: runIntent(goal, 'taken') }, 'intent-exists'],
            [{ entryId: goalInboxKey('tenant', 'webhook:github', 'nope') }, 'scope-mismatch'],
            [{ scope: 'other' }, 'scope-mismatch'],
            [{ goalId: 'h' }, 'scope-mismatch'],
            [{ intent: runIntent(runtimeGoal('h'), 'g#2') }, 'scope-mismatch'],
            [{ runtime: runtimeState({ goalId: 'g', scope: 'other' }, 2) }, 'scope-mismatch'],
          ];
          for (const [patch, reason] of cases)
            expect(await store.inbox.apply(full(patch)), JSON.stringify(patch)).toEqual({
              status: 'conflict',
              reason,
            });
          expect(await store.inbox.get('tenant', entry.id)).toEqual(entry);
          expect((await store.load('g'))?.revision).toBe(1);
          expect((await store.runtime.get('tenant', 'g'))?.revision).toBe(1);
          expect(await store.intents.get('tenant', 'g#2')).toBeUndefined();
          // Then the full write commits, and a second apply finds the entry settled.
          expect(await store.inbox.apply(full({}))).toEqual({ status: 'committed' });
          expect(
            await store.inbox.apply(
              full({
                goal: nextGoal(nextGoal(goal)),
                runtime: runtimeState(goal, 3),
                intent: undefined,
              }),
            ),
          ).toEqual({ status: 'conflict', reason: 'entry-settled' });
          expect((await store.load('g'))?.revision).toBe(2);
        }),
      );

      it(
        "refuses to settle an entry as 'pending'",
        withStore(async (store) => {
          const { entry } = await goalWithDelivery(store);
          await expect(
            Promise.resolve().then(() =>
              store.inbox.apply({
                scope: 'tenant',
                goalId: 'g',
                entryId: entry.id,
                disposition: 'pending' as never,
              }),
            ),
          ).rejects.toThrow(TypeError);
          expect((await store.inbox.get('tenant', entry.id))?.disposition).toBe('pending');
        }),
      );
    });

    describe('schedules', () => {
      it(
        'creates a schedule at revision 1 with its cursor at the effective instant',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await time.advance(7);
          const input = scheduleInput(goal, 's1', {
            spec: { cron: '30 2 * * *', timezone: 'America/New_York', dstGap: 'skip' },
            event: { correlationId: 'nightly', expiresAfterMs: 60_000 },
          });
          const created = await store.schedules.put(input, {
            expectedRevision: 0,
            effectiveFrom: T0 + 5,
          });
          const expected = {
            ...input,
            status: 'active',
            revision: 1,
            effectiveFrom: T0 + 5,
            scheduleCursor: T0 + 5,
            createdAt: T0 + 7,
            updatedAt: T0 + 7,
          };
          expect(created).toEqual({ status: 'committed', schedule: expected });
          expect(await store.schedules.get('tenant', 's1')).toEqual(expected);
          expect(await store.schedules.get('other', 's1')).toBeUndefined();
          // A second create of the same id conflicts.
          expect(
            await store.schedules.put(input, { expectedRevision: 0, effectiveFrom: T0 + 9 }),
          ).toEqual({ status: 'conflict' });
        }),
      );

      it(
        'changes a schedule at its revision: a new revision and boundary, the cursor kept',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.schedules.put(scheduleInput(goal, 's1'), {
            expectedRevision: 0,
            effectiveFrom: T0,
          });
          await time.advance(1_000);
          const changed = await store.schedules.put(
            scheduleInput(goal, 's1', { spec: { cron: '0 * * * *' } }),
            { expectedRevision: 1, effectiveFrom: T0 + 1_000 },
          );
          expect(changed).toEqual({
            status: 'committed',
            schedule: {
              ...scheduleInput(goal, 's1', { spec: { cron: '0 * * * *' } }),
              status: 'active',
              revision: 2,
              effectiveFrom: T0 + 1_000,
              scheduleCursor: T0,
              createdAt: T0,
              updatedAt: T0 + 1_000,
            },
          });
          expect(
            await store.schedules.put(scheduleInput(goal, 's1'), {
              expectedRevision: 1,
              effectiveFrom: T0 + 2_000,
            }),
          ).toEqual({ status: 'conflict' });
          expect(
            await store.schedules.put(scheduleInput(goal, 'unknown'), {
              expectedRevision: 1,
              effectiveFrom: T0,
            }),
          ).toEqual({ status: 'conflict' });
          expect((await store.schedules.get('tenant', 's1'))?.spec.cron).toBe('0 * * * *');
        }),
      );

      it(
        'targets only an existing goal of its own scope',
        withStore(async (store) => {
          await store.save(runtimeGoal('g', 'tenant-a'));
          for (const input of [
            scheduleInput({ goalId: 'g', scope: 'tenant-b' }, 's1'),
            scheduleInput({ goalId: 'missing', scope: 'tenant-a' }, 's1'),
          ])
            await expect(
              store.schedules.put(input, { expectedRevision: 0, effectiveFrom: T0 }),
            ).rejects.toMatchObject({ code: 'scope_mismatch' });
          expect((await store.schedules.list()).schedules).toEqual([]);
        }),
      );

      it(
        'pauses an active schedule and resumes a paused one from a new boundary',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.schedules.put(scheduleInput(goal, 's1'), {
            expectedRevision: 0,
            effectiveFrom: T0,
          });
          await time.advance(10);
          const paused = await store.schedules.pause('tenant', 's1', { expectedRevision: 1 });
          expect(paused).toMatchObject({
            status: 'committed',
            schedule: { status: 'paused', revision: 2, scheduleCursor: T0, updatedAt: T0 + 10 },
          });
          expect(await store.schedules.pause('tenant', 's1', { expectedRevision: 2 })).toEqual({
            status: 'conflict',
          });
          expect(
            await store.schedules.resume('tenant', 's1', {
              expectedRevision: 1,
              effectiveFrom: T0 + 20,
            }),
          ).toEqual({ status: 'conflict' });
          expect(
            await store.schedules.resume('other', 's1', {
              expectedRevision: 2,
              effectiveFrom: T0 + 20,
            }),
          ).toEqual({ status: 'conflict' });
          const resumed = await store.schedules.resume('tenant', 's1', {
            expectedRevision: 2,
            effectiveFrom: T0 + 20,
          });
          expect(resumed).toMatchObject({
            status: 'committed',
            schedule: { status: 'active', revision: 3, effectiveFrom: T0 + 20, scheduleCursor: T0 },
          });
          expect(
            await store.schedules.resume('tenant', 's1', {
              expectedRevision: 3,
              effectiveFrom: T0 + 30,
            }),
          ).toEqual({ status: 'conflict' });
        }),
      );

      it(
        'cancels a schedule for good and disposes its pending deliveries',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.schedules.put(scheduleInput(goal, 's1'), {
            expectedRevision: 0,
            effectiveFrom: T0,
          });
          const fromSchedule = (deliveryId: string) =>
            delivery(goal, deliveryId, { namespace: 'schedule:s1' });
          const { entry: pending } = await store.inbox.enqueue(fromSchedule('s1@1'));
          const { entry: settled } = await store.inbox.enqueue(fromSchedule('s1@2'));
          const { entry: webhook } = await store.inbox.enqueue(delivery(goal, 'w1'));
          await store.inbox.apply({
            scope: 'tenant',
            goalId: 'g',
            entryId: settled.id,
            disposition: 'applied',
          });
          await time.advance(50);
          expect(await store.schedules.cancel('tenant', 's1', { expectedRevision: 2 })).toEqual({
            status: 'conflict',
          });
          const cancelled = await store.schedules.cancel('tenant', 's1', { expectedRevision: 1 });
          expect(cancelled).toMatchObject({
            status: 'committed',
            schedule: { status: 'cancelled', revision: 2 },
          });
          expect(await store.inbox.get('tenant', pending.id)).toEqual({
            ...pending,
            disposition: 'cancelled',
            settledAt: T0 + 50,
          });
          expect((await store.inbox.get('tenant', settled.id))?.disposition).toBe('applied');
          expect((await store.inbox.get('tenant', webhook.id))?.disposition).toBe('pending');
          // A cancelled schedule takes no further change.
          const options = { expectedRevision: 2, effectiveFrom: T0 + 60 };
          expect(await store.schedules.put(scheduleInput(goal, 's1'), options)).toEqual({
            status: 'conflict',
          });
          expect(await store.schedules.pause('tenant', 's1', options)).toEqual({
            status: 'conflict',
          });
          expect(await store.schedules.resume('tenant', 's1', options)).toEqual({
            status: 'conflict',
          });
          expect(await store.schedules.cancel('tenant', 's1', options)).toEqual({
            status: 'conflict',
          });
        }),
      );

      it(
        'lists schedules by id, by scope, goal and status, page by page',
        withStore(async (store) => {
          const g = runtimeGoal('g');
          const h = runtimeGoal('h');
          const x = runtimeGoal('x', 'other');
          for (const goal of [g, h, x]) await store.save(goal);
          const create = (input: DurableScheduleInput) =>
            store.schedules.put(input, { expectedRevision: 0, effectiveFrom: T0 });
          await create(scheduleInput(g, 'c'));
          await create(scheduleInput(h, 'a'));
          await create(scheduleInput(g, 'b'));
          await create(scheduleInput(x, 'a'));
          await store.schedules.pause('tenant', 'b', { expectedRevision: 1 });
          const ids = async (query?: DurableScheduleQuery) =>
            (await store.schedules.list(query)).schedules.map((s) => `${s.scope}/${s.scheduleId}`);
          expect(await ids()).toEqual(['other/a', 'tenant/a', 'tenant/b', 'tenant/c']);
          expect(await ids({ scope: 'tenant' })).toEqual(['tenant/a', 'tenant/b', 'tenant/c']);
          expect(await ids({ goalId: 'g' })).toEqual(['tenant/b', 'tenant/c']);
          expect(await ids({ statuses: ['paused'] })).toEqual(['tenant/b']);
          expect(await ids({ statuses: [] })).toEqual([]);
          const pages: string[][] = [];
          let cursor: string | undefined;
          do {
            const page = await store.schedules.list({ limit: 3, cursor });
            pages.push(page.schedules.map((s) => `${s.scope}/${s.scheduleId}`));
            cursor = page.cursor;
          } while (cursor);
          expect(pages).toEqual([['other/a', 'tenant/a', 'tenant/b'], ['tenant/c']]);
          for (const query of [{ limit: 0 }, { cursor: 'nope' }, { statuses: ['done'] }])
            await expect(
              Promise.resolve().then(() => store.schedules.list(query as DurableScheduleQuery)),
              JSON.stringify(query),
            ).rejects.toThrow(TypeError);
        }),
      );

      it(
        'refuses a malformed schedule without writing',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          const options = { expectedRevision: 0, effectiveFrom: T0 };
          for (const [input, opts] of [
            [scheduleInput(goal, 's1', { spec: { cron: '' } }), options],
            [
              scheduleInput(goal, 's1', { spec: { cron: '* * * * *', dstGap: 'never' as never } }),
              options,
            ],
            [
              scheduleInput(goal, 's1', { spec: { cron: '* * * * *', catchUp: 'some' as never } }),
              options,
            ],
            [scheduleInput(goal, ''), options],
            [scheduleInput(goal, 's1', { event: { expiresAfterMs: -1 } }), options],
            [scheduleInput(goal, 's1'), { expectedRevision: -1, effectiveFrom: T0 }],
            [scheduleInput(goal, 's1'), { expectedRevision: 0, effectiveFrom: Number.NaN }],
          ] as const)
            await expect(
              Promise.resolve().then(() => store.schedules.put(input, opts)),
              JSON.stringify(input),
            ).rejects.toThrow(TypeError);
          expect((await store.schedules.list()).schedules).toEqual([]);
        }),
      );
    });

    describe('schedule advance', () => {
      /** The occurrence records of `s1` (the store's optional read, which ours all have). */
      const recorded = async (store: GoalRuntimeStore) =>
        (await store.schedules.occurrences!({ scope: 'tenant', scheduleId: 's1' })).occurrences;

      it(
        'moves the cursor, records the occurrences and queues the deliveries in one write',
        withStore(async (store, time) => {
          const goal = await goalWithSchedule(store);
          await time.advance(3 * MINUTE + 5);
          const now = T0 + 3 * MINUTE + 5;
          const result = await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + 3 * MINUTE,
            occurrences: [
              occurrence(goal, 's1', T0 + MINUTE),
              occurrence(goal, 's1', T0 + 2 * MINUTE, 'catch-up-latest'),
              occurrence(goal, 's1', T0 + 3 * MINUTE),
            ],
          });
          expect(result).toMatchObject({
            status: 'advanced',
            enqueued: 2,
            duplicates: 0,
            schedule: { revision: 1, scheduleCursor: T0 + 3 * MINUTE, updatedAt: now },
          });
          expect((await store.schedules.get('tenant', 's1'))?.scheduleCursor).toBe(T0 + 3 * MINUTE);
          const first = occurrence(goal, 's1', T0 + MINUTE);
          const firstId = goalInboxKey('tenant', 'schedule:s1', `s1@${T0 + MINUTE}`);
          expect(await recorded(store)).toEqual([
            {
              occurrenceId: `s1@${T0 + MINUTE}`,
              scheduleId: 's1',
              scope: 'tenant',
              goalId: 'g',
              at: T0 + MINUTE,
              disposition: 'delivered',
              inboxEntryId: firstId,
              recordedAt: now,
            },
            {
              occurrenceId: `s1@${T0 + 2 * MINUTE}`,
              scheduleId: 's1',
              scope: 'tenant',
              goalId: 'g',
              at: T0 + 2 * MINUTE,
              disposition: 'skipped',
              reason: 'catch-up-latest',
              recordedAt: now,
            },
            expect.objectContaining({ occurrenceId: `s1@${T0 + 3 * MINUTE}` }),
          ]);
          expect(await store.inbox.get('tenant', firstId)).toEqual({
            ...first.delivery,
            id: firstId,
            disposition: 'pending',
            enqueuedAt: now,
          });
          expect(
            (await store.inbox.list({ scope: 'tenant' })).entries.map((entry) => entry.deliveryId),
          ).toEqual([`s1@${T0 + MINUTE}`, `s1@${T0 + 3 * MINUTE}`]);
          expect(await store.schedules.occurrences!({ scope: 'other' })).toEqual({
            occurrences: [],
          });
        }),
      );

      it(
        'counts a delivery already queued as a duplicate, and keeps it as it was',
        withStore(async (store, time) => {
          const goal = await goalWithSchedule(store);
          const early = occurrence(goal, 's1', T0 + MINUTE);
          const { entry } = await store.inbox.enqueue(early.delivery!);
          await time.advance(2 * MINUTE);
          const result = await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + 2 * MINUTE,
            occurrences: [early, occurrence(goal, 's1', T0 + 2 * MINUTE)],
          });
          expect(result).toMatchObject({ status: 'advanced', enqueued: 1, duplicates: 1 });
          expect(await store.inbox.get('tenant', entry.id)).toEqual(entry);
          expect((await recorded(store))[0]?.inboxEntryId).toBe(entry.id);
        }),
      );

      it(
        'writes nothing when the revision, the cursor or the status moved',
        withStore(async (store) => {
          const goal = await goalWithSchedule(store);
          const step = (patch: Partial<ScheduleAdvance>): ScheduleAdvance => ({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + MINUTE,
            occurrences: [occurrence(goal, 's1', T0 + MINUTE)],
            ...patch,
          });
          const stored = await store.schedules.get('tenant', 's1');
          expect(await store.schedules.advance(step({ expectedRevision: 2 }))).toEqual({
            status: 'conflict',
            schedule: stored,
          });
          expect(
            await store.schedules.advance(step({ fromCursor: T0 - MINUTE, occurrences: [] })),
          ).toEqual({ status: 'conflict', schedule: stored });
          expect(
            await store.schedules.advance(step({ scheduleId: 'unknown', occurrences: [] })),
          ).toEqual({ status: 'conflict' });
          expect(await store.schedules.advance(step({ scope: 'other', occurrences: [] }))).toEqual({
            status: 'conflict',
          });
          await store.schedules.pause('tenant', 's1', { expectedRevision: 1 });
          expect(await store.schedules.advance(step({ expectedRevision: 2 }))).toMatchObject({
            status: 'conflict',
            schedule: { status: 'paused' },
          });
          await store.schedules.cancel('tenant', 's1', { expectedRevision: 2 });
          expect(await store.schedules.advance(step({ expectedRevision: 3 }))).toMatchObject({
            status: 'conflict',
            schedule: { status: 'cancelled' },
          });
          expect((await store.schedules.get('tenant', 's1'))?.scheduleCursor).toBe(T0);
          expect(await recorded(store)).toEqual([]);
          expect((await store.inbox.list({ scope: 'tenant', dispositions: [] })).entries).toEqual(
            [],
          );
          expect(
            (await store.inbox.list({ scope: 'tenant', dispositions: ['pending', 'cancelled'] }))
              .entries,
          ).toEqual([]);
        }),
      );

      it(
        'lets one of two advances from the same cursor win, and never delivers twice',
        withStore(async (store) => {
          const goal = await goalWithSchedule(store);
          const step: ScheduleAdvance = {
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + MINUTE,
            occurrences: [occurrence(goal, 's1', T0 + MINUTE)],
          };
          const results = await Promise.all([
            store.schedules.advance(step),
            store.schedules.advance(step),
          ]);
          expect(results.map((result) => result.status).sort()).toEqual(['advanced', 'conflict']);
          expect((await store.inbox.list({ scope: 'tenant' })).entries).toHaveLength(1);
          expect(await recorded(store)).toHaveLength(1);
        }),
      );

      it(
        'keeps an unfinished scan until a step completes it',
        withStore(async (store) => {
          await goalWithSchedule(store);
          const first = await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + 10 * MINUTE,
            scanTo: T0 + 20 * MINUTE,
            occurrences: [],
          });
          expect(first).toMatchObject({
            status: 'advanced',
            enqueued: 0,
            schedule: { scheduleCursor: T0 + 10 * MINUTE, scanTo: T0 + 20 * MINUTE },
          });
          const second = await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0 + 10 * MINUTE,
            toCursor: T0 + 20 * MINUTE,
            occurrences: [],
          });
          expect(second.status).toBe('advanced');
          expect((await store.schedules.get('tenant', 's1'))?.scanTo).toBeUndefined();
          expect((await store.schedules.get('tenant', 's1'))?.scheduleCursor).toBe(
            T0 + 20 * MINUTE,
          );
        }),
      );

      it(
        'refuses a malformed step without writing',
        withStore(async (store) => {
          const goal = await goalWithSchedule(store);
          const step = (patch: Partial<ScheduleAdvance>): ScheduleAdvance => ({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + 2 * MINUTE,
            occurrences: [occurrence(goal, 's1', T0 + MINUTE)],
            ...patch,
          });
          const { delivery: _delivery, ...undelivered } = occurrence(goal, 's1', T0 + MINUTE);
          const other = runtimeGoal('h');
          await store.save(other);
          for (const bad of [
            step({ toCursor: T0 - 1, occurrences: [] }),
            step({ occurrences: [occurrence(goal, 's1', T0 + 3 * MINUTE)] }),
            step({ occurrences: [occurrence(goal, 's1', T0)] }),
            step({ occurrences: [undelivered] }),
            step({ occurrences: [occurrence(goal, 's2', T0 + MINUTE)] }),
            step({ occurrences: [occurrence(other, 's1', T0 + MINUTE)] }),
            step({
              occurrences: [
                occurrence(goal, 's1', T0 + MINUTE),
                occurrence(goal, 's1', T0 + MINUTE),
              ],
            }),
          ])
            await expect(
              Promise.resolve().then(() => store.schedules.advance(bad)),
              JSON.stringify(bad.occurrences.map((item) => item.occurrenceId)),
            ).rejects.toThrow(TypeError);
          expect((await store.schedules.get('tenant', 's1'))?.scheduleCursor).toBe(T0);
          expect(await recorded(store)).toEqual([]);
          expect((await store.inbox.list({ scope: 'tenant' })).entries).toEqual([]);
        }),
      );

      it(
        'lists occurrence records oldest first, page by page',
        withStore(async (store) => {
          const goal = await goalWithSchedule(store);
          await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + 3 * MINUTE,
            occurrences: [1, 2, 3].map((n) => occurrence(goal, 's1', T0 + n * MINUTE, 'paused')),
          });
          const pages: number[][] = [];
          let cursor: string | undefined;
          do {
            const page = await store.schedules.occurrences!({ scope: 'tenant', limit: 2, cursor });
            pages.push(page.occurrences.map((record) => (record.at - T0) / MINUTE));
            cursor = page.cursor;
          } while (cursor);
          expect(pages).toEqual([[1, 2], [3]]);
          await expect(
            Promise.resolve().then(() =>
              store.schedules.occurrences!({ scope: 'tenant', cursor: 'nope' }),
            ),
          ).rejects.toThrow(TypeError);
        }),
      );
    });

    describe('run intents', () => {
      it(
        'records an intent once, for a goal of its scope',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await time.advance(3);
          expect(await store.intents.record(runIntent(goal, 'i1'))).toEqual({
            status: 'committed',
          });
          expect(await store.intents.get('tenant', 'i1')).toEqual({
            ...runIntent(goal, 'i1'),
            status: 'pending',
            revision: 1,
            recordedAt: T0 + 3,
            updatedAt: T0 + 3,
          });
          expect(await store.intents.record(runIntent(goal, 'i1', { attempt: 2 }))).toEqual({
            status: 'conflict',
            reason: 'intent-exists',
          });
          expect(
            await store.intents.record(runIntent({ goalId: 'g', scope: 'other' }, 'i2')),
          ).toEqual({ status: 'conflict', reason: 'scope-mismatch' });
          expect(await store.intents.record(runIntent(runtimeGoal('missing'), 'i3'))).toEqual({
            status: 'conflict',
            reason: 'scope-mismatch',
          });
          for (const bad of [
            runIntent(goal, 'i4', { kind: 'restart' as never }),
            runIntent(goal, 'i4', { attempt: 0 }),
            runIntent(goal, ''),
          ])
            await expect(
              Promise.resolve().then(() => store.intents.record(bad)),
              JSON.stringify(bad),
            ).rejects.toThrow(TypeError);
          expect(await store.intents.get('tenant', 'i4')).toBeUndefined();
        }),
      );

      it(
        'claims a pending intent, and lets a higher token fence the old executor out',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.intents.record(runIntent(goal, 'i1'));
          await time.advance(10);
          const first = await store.intents.claim('tenant', 'i1', {
            owner: 'worker-a',
            token: 1,
            expectedRevision: 1,
          });
          expect(first).toMatchObject({
            status: 'committed',
            intent: {
              status: 'claimed',
              revision: 2,
              claim: { owner: 'worker-a', token: 1, at: T0 + 10 },
            },
          });
          // The same token, a lower one, or a stale revision: refused.
          for (const claim of [
            { owner: 'worker-b', token: 1, expectedRevision: 2 },
            { owner: 'worker-b', token: 0, expectedRevision: 2 },
            { owner: 'worker-b', token: 2, expectedRevision: 1 },
          ])
            expect(await store.intents.claim('tenant', 'i1', claim), JSON.stringify(claim)).toEqual(
              { status: 'conflict' },
            );
          expect(
            await store.intents.claim('tenant', 'nope', {
              owner: 'worker-b',
              token: 5,
              expectedRevision: 1,
            }),
          ).toEqual({ status: 'conflict' });
          expect(
            await store.intents.claim('other', 'i1', {
              owner: 'worker-b',
              token: 5,
              expectedRevision: 2,
            }),
          ).toEqual({ status: 'conflict' });
          // A higher token takes it over; the old holder can no longer mark it.
          const second = await store.intents.claim('tenant', 'i1', {
            owner: 'worker-b',
            token: 2,
            expectedRevision: 2,
          });
          expect(second).toMatchObject({
            status: 'committed',
            intent: { status: 'claimed', revision: 3, claim: { owner: 'worker-b', token: 2 } },
          });
          expect(
            await store.intents.launched('tenant', 'i1', { token: 1, expectedRevision: 3 }),
          ).toEqual({ status: 'conflict', reason: 'intent-revision' });
          expect(
            await store.intents.launched('tenant', 'i1', { token: 2, expectedRevision: 2 }),
          ).toEqual({ status: 'conflict', reason: 'intent-revision' });
          expect(
            await store.intents.launched('tenant', 'i1', { token: 2, expectedRevision: 3 }),
          ).toEqual({ status: 'committed' });
          expect(await store.intents.get('tenant', 'i1')).toMatchObject({
            status: 'launched',
            revision: 4,
          });
          // A launched run's intent is taken over too, and stays launched (resume, not restart).
          const third = await store.intents.claim('tenant', 'i1', {
            owner: 'worker-c',
            token: 3,
            expectedRevision: 4,
          });
          expect(third).toMatchObject({
            status: 'committed',
            intent: { status: 'launched', revision: 5, claim: { owner: 'worker-c', token: 3 } },
          });
          expect(
            await store.intents.launched('nope', 'i1', { token: 3, expectedRevision: 5 }),
          ).toEqual({ status: 'conflict', reason: 'scope-mismatch' });
        }),
      );

      it(
        'records the outcome with the runtime state and the goal in one write',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.runtime.save(runtimeState(goal, 1, { phase: 'running' }), goal);
          await store.intents.record(runIntent(goal, 'i1'));
          await store.intents.claim('tenant', 'i1', { owner: 'w', token: 1, expectedRevision: 1 });
          await store.intents.launched('tenant', 'i1', { token: 1, expectedRevision: 2 });
          await time.advance(100);
          const outcome = { status: 'failed' as const, error: { name: 'Error', message: 'boom' } };
          const completion = (patch: object) => ({
            token: 1,
            expectedRevision: 3,
            status: 'failed' as const,
            outcome,
            runtime: runtimeState(goal, 2, { phase: 'retrying', retries: 1 }),
            goal: nextGoal(goal),
            ...patch,
          });
          const cases: [object, string][] = [
            [{ token: 2 }, 'intent-revision'],
            [{ expectedRevision: 2 }, 'intent-revision'],
            [{ runtime: runtimeState(goal, 1) }, 'runtime-revision'],
            [{ goal: { ...nextGoal(goal), revision: 3 } }, 'goal-revision'],
            [{ runtime: runtimeState({ goalId: 'g', scope: 'other' }, 2) }, 'scope-mismatch'],
            [{ goal: { ...nextGoal(goal), goalId: 'h' } }, 'scope-mismatch'],
          ];
          for (const [patch, reason] of cases)
            expect(
              await store.intents.complete('tenant', 'i1', completion(patch)),
              JSON.stringify(patch),
            ).toEqual({ status: 'conflict', reason });
          expect((await store.intents.get('tenant', 'i1'))?.status).toBe('launched');
          expect((await store.runtime.get('tenant', 'g'))?.revision).toBe(1);
          expect((await store.load('g'))?.revision).toBe(1);
          expect(await store.intents.complete('tenant', 'i1', completion({}))).toEqual({
            status: 'committed',
          });
          expect(await store.intents.get('tenant', 'i1')).toMatchObject({
            status: 'failed',
            outcome,
            revision: 4,
            updatedAt: T0 + 100,
          });
          expect((await store.runtime.get('tenant', 'g'))?.phase).toBe('retrying');
          expect((await store.load('g'))?.revision).toBe(2);
          // A finished intent takes no claim, mark or second outcome.
          expect(
            await store.intents.claim('tenant', 'i1', {
              owner: 'w2',
              token: 9,
              expectedRevision: 4,
            }),
          ).toEqual({ status: 'conflict' });
          expect(
            await store.intents.complete('tenant', 'i1', {
              token: 1,
              expectedRevision: 4,
              status: 'completed',
            }),
          ).toEqual({ status: 'conflict', reason: 'intent-revision' });
        }),
      );

      it(
        'completes only a claimed intent, under its claim',
        withStore(async (store) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          await store.intents.record(runIntent(goal, 'i1'));
          expect(
            await store.intents.complete('tenant', 'i1', {
              token: 0,
              expectedRevision: 1,
              status: 'cancelled',
            }),
          ).toEqual({ status: 'conflict', reason: 'intent-revision' });
          expect(
            await store.intents.complete('tenant', 'nope', {
              token: 0,
              expectedRevision: 1,
              status: 'cancelled',
            }),
          ).toEqual({ status: 'conflict', reason: 'scope-mismatch' });
          await store.intents.claim('tenant', 'i1', { owner: 'w', token: 4, expectedRevision: 1 });
          expect(
            await store.intents.complete('tenant', 'i1', {
              token: 4,
              expectedRevision: 2,
              status: 'cancelled',
              outcome: { status: 'stopped', reason: 'cancel requested' },
            }),
          ).toEqual({ status: 'committed' });
          expect((await store.intents.get('tenant', 'i1'))?.status).toBe('cancelled');
        }),
      );

      it(
        'lists the intents to recover by default, oldest first, page by page',
        withStore(async (store, time) => {
          const g = runtimeGoal('g');
          const x = runtimeGoal('x', 'other');
          await store.save(g);
          await store.save(x);
          await store.intents.record(runIntent(g, 'b'));
          await store.intents.record(runIntent(g, 'a'));
          await time.advance(1);
          await store.intents.record(runIntent(x, 'c'));
          await time.advance(1);
          await store.intents.record(runIntent(g, 'd'));
          await store.intents.claim('tenant', 'd', { owner: 'w', token: 1, expectedRevision: 1 });
          await store.intents.complete('tenant', 'd', {
            token: 1,
            expectedRevision: 2,
            status: 'completed',
          });
          const ids = async (query?: Parameters<GoalRuntimeStore['intents']['list']>[0]) =>
            (await store.intents.list(query)).intents.map((intent) => intent.intentId);
          expect(await ids()).toEqual(['a', 'b', 'c']);
          expect(await ids({ scope: 'tenant' })).toEqual(['a', 'b']);
          expect(await ids({ goalId: 'x' })).toEqual(['c']);
          expect(await ids({ statuses: ['completed'] })).toEqual(['d']);
          expect(await ids({ statuses: [] })).toEqual([]);
          const pages: string[][] = [];
          let cursor: string | undefined;
          do {
            const page = await store.intents.list({ limit: 2, cursor });
            pages.push(page.intents.map((intent) => intent.intentId));
            cursor = page.cursor;
          } while (cursor);
          expect(pages).toEqual([['a', 'b'], ['c']]);
          for (const query of [{ limit: 0 }, { cursor: 'nope' }, { statuses: ['lost'] }])
            await expect(
              Promise.resolve().then(() => store.intents.list(query as never)),
              JSON.stringify(query),
            ).rejects.toThrow(TypeError);
        }),
      );
    });

    describe('ledger watermarks', () => {
      const charged = (goal: GoalRecord, tokens: number, key: string) =>
        transitionGoal(goal, { type: 'charge', tokens, usd: tokens / 1000, key }, { now: T0 + 1 })
          .record;

      it(
        'advances a watermark with the charged goal in one write, once per revision',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          expect(await store.watermarks.get('tenant', 'g', 'r1')).toBeUndefined();
          await time.advance(20);
          const next = { tokens: 100, usd: 0.1, reservedTokens: 20, reservedUsd: 0.02 };
          const first = charged(goal, 100, 'r1:100');
          const advance = {
            scope: 'tenant',
            goalId: 'g',
            runId: 'r1',
            expectedRevision: 0,
            next,
            goal: first,
          };
          expect(await store.watermarks.advance(advance)).toEqual({ status: 'committed' });
          expect(await store.watermarks.get('tenant', 'g', 'r1')).toEqual({
            scope: 'tenant',
            goalId: 'g',
            runId: 'r1',
            ...next,
            revision: 1,
            updatedAt: T0 + 20,
          });
          expect(await store.load('g')).toEqual(first);
          expect(await store.watermarks.get('other', 'g', 'r1')).toBeUndefined();
          // The same advance again charges nothing twice.
          expect(await store.watermarks.advance(advance)).toEqual({
            status: 'conflict',
            reason: 'watermark-revision',
          });
          // A stale goal refuses the whole write.
          const later = { ...next, tokens: 150, usd: 0.15, reservedTokens: 0, reservedUsd: 0 };
          expect(
            await store.watermarks.advance({
              ...advance,
              expectedRevision: 1,
              next: later,
              goal: charged(goal, 50, 'r1:150'),
            }),
          ).toEqual({ status: 'conflict', reason: 'goal-revision' });
          expect((await store.watermarks.get('tenant', 'g', 'r1'))?.tokens).toBe(100);
          // Reservations may be released; charged amounts never go back.
          expect(
            await store.watermarks.advance({
              ...advance,
              expectedRevision: 1,
              next: later,
              goal: charged(first, 50, 'r1:150'),
            }),
          ).toEqual({ status: 'committed' });
          expect(await store.watermarks.get('tenant', 'g', 'r1')).toMatchObject({
            ...later,
            revision: 2,
          });
          await expect(
            store.watermarks.advance({
              ...advance,
              expectedRevision: 2,
              next: { ...later, tokens: 140 },
              goal: charged(charged(first, 50, 'r1:150'), 1, 'r1:x'),
            }),
          ).rejects.toThrow(TypeError);
        }),
      );

      it(
        "keeps a watermark in its goal's scope",
        withStore(async (store) => {
          const goal = runtimeGoal('g', 'tenant-a');
          await store.save(goal);
          const advance = {
            scope: 'tenant-a',
            goalId: 'g',
            runId: 'r1',
            expectedRevision: 0,
            next: { tokens: 1, usd: 0, reservedTokens: 0, reservedUsd: 0 },
            goal: charged(goal, 1, 'k'),
          };
          for (const patch of [
            { scope: 'tenant-b' },
            { goalId: 'h' },
            { goal: { ...charged(goal, 1, 'k'), scope: 'tenant-b' } },
          ])
            expect(
              await store.watermarks.advance({ ...advance, ...patch }),
              JSON.stringify(patch),
            ).toEqual({ status: 'conflict', reason: 'scope-mismatch' });
          expect(await store.watermarks.get('tenant-a', 'g', 'r1')).toBeUndefined();
          for (const next of [
            { tokens: -1, usd: 0, reservedTokens: 0, reservedUsd: 0 },
            { tokens: 1, usd: Number.NaN, reservedTokens: 0, reservedUsd: 0 },
          ])
            await expect(
              Promise.resolve().then(() => store.watermarks.advance({ ...advance, next })),
            ).rejects.toThrow(TypeError);
        }),
      );
    });

    describe('retention', () => {
      /** Settles `deliveryId` of goal `g` at the current clock time. */
      const settle = async (store: GoalRuntimeStore, deliveryId: string) => {
        const id = goalInboxKey('tenant', 'webhook:github', deliveryId);
        await store.inbox.apply({
          scope: 'tenant',
          goalId: 'g',
          entryId: id,
          disposition: 'stale',
        });
        return id;
      };

      it(
        'drops settled payloads to content-free tombstones, keeping ids and dedupe',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          const x = runtimeGoal('x', 'other');
          await store.save(x);
          for (const id of ['old', 'recent', 'pending', 'bare'])
            await store.inbox.enqueue(
              delivery(goal, id, id === 'bare' ? { payload: undefined } : {}),
            );
          await store.inbox.enqueue(delivery(x, 'foreign'));
          const old = await settle(store, 'old');
          await settle(store, 'bare');
          await store.inbox.apply({
            scope: 'other',
            goalId: 'x',
            entryId: goalInboxKey('other', 'webhook:github', 'foreign'),
            disposition: 'stale',
          });
          await time.advance(1_000);
          const recent = await settle(store, 'recent');
          expect(await store.prunePayloads({ before: T0 + 1_000, scope: 'tenant' })).toBe(1);
          const tomb = await store.inbox.get('tenant', old);
          expect(tomb).toMatchObject({ id: old, deliveryId: 'old', payloadPruned: true });
          expect(tomb?.payload).toBeUndefined();
          expect((await store.inbox.get('tenant', recent))?.payload).toBeDefined();
          expect(
            (await store.inbox.get('tenant', goalInboxKey('tenant', 'webhook:github', 'pending')))
              ?.payload,
          ).toBeDefined();
          expect(
            (await store.inbox.get('other', goalInboxKey('other', 'webhook:github', 'foreign')))
              ?.payload,
          ).toBeDefined();
          // The id still dedupes.
          expect((await store.inbox.enqueue(delivery(goal, 'old'))).status).toBe('duplicate');
          // Without a scope, every scope; a second prune finds nothing left to drop.
          expect(await store.prunePayloads({ before: T0 + 1_001 })).toBe(2);
          expect(await store.prunePayloads({ before: T0 + 1_001 })).toBe(0);
        }),
      );

      it(
        'deletes settled entries, ids included, only when asked',
        withStore(async (store, time) => {
          const goal = runtimeGoal('g');
          await store.save(goal);
          for (const id of ['old', 'pending']) await store.inbox.enqueue(delivery(goal, id));
          const old = await settle(store, 'old');
          await time.advance(10);
          expect(await store.pruneInbox({ before: T0, scope: 'tenant' })).toBe(0);
          expect(await store.pruneInbox({ before: T0 + 10, scope: 'other' })).toBe(0);
          expect(await store.pruneInbox({ before: T0 + 10 })).toBe(1);
          expect(await store.inbox.get('tenant', old)).toBeUndefined();
          expect((await store.inbox.list({ scope: 'tenant' })).entries).toHaveLength(1);
          // A repeated delivery is queued again once its id is gone.
          expect((await store.inbox.enqueue(delivery(goal, 'old'))).status).toBe('enqueued');
        }),
      );

      it(
        'deletes old occurrence records and finished intents',
        withStore(async (store, time) => {
          const goal = await goalWithSchedule(store);
          await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0,
            toCursor: T0 + MINUTE,
            occurrences: [occurrence(goal, 's1', T0 + MINUTE, 'catch-up-none')],
          });
          for (const id of ['done', 'open']) await store.intents.record(runIntent(goal, id));
          await store.intents.claim('tenant', 'done', {
            owner: 'w',
            token: 1,
            expectedRevision: 1,
          });
          await store.intents.complete('tenant', 'done', {
            token: 1,
            expectedRevision: 2,
            status: 'completed',
          });
          await time.advance(5);
          await store.schedules.advance({
            scope: 'tenant',
            scheduleId: 's1',
            expectedRevision: 1,
            fromCursor: T0 + MINUTE,
            toCursor: T0 + 2 * MINUTE,
            occurrences: [occurrence(goal, 's1', T0 + 2 * MINUTE, 'catch-up-none')],
          });
          expect(await store.pruneOccurrences({ before: T0 + 5, scope: 'other' })).toBe(0);
          expect(await store.pruneOccurrences({ before: T0 + 5 })).toBe(1);
          expect(
            (await store.schedules.occurrences!({ scope: 'tenant' })).occurrences.map(
              (record) => record.at,
            ),
          ).toEqual([T0 + 2 * MINUTE]);
          expect(await store.pruneIntents({ before: T0 + 5, scope: 'other' })).toBe(0);
          expect(await store.pruneIntents({ before: T0 + 5 })).toBe(1);
          expect(await store.intents.get('tenant', 'done')).toBeUndefined();
          expect((await store.intents.get('tenant', 'open'))?.status).toBe('pending');
        }),
      );

      it(
        'refuses malformed retention options',
        withStore(async (store) => {
          for (const options of [{ before: Number.NaN }, { before: T0, scope: '' }, {}])
            for (const prune of [
              store.prunePayloads,
              store.pruneInbox,
              store.pruneOccurrences,
              store.pruneIntents,
            ])
              await expect(
                Promise.resolve().then(() => prune.call(store, options as never)),
                JSON.stringify(options),
              ).rejects.toThrow(TypeError);
        }),
      );
    });
  });
}
