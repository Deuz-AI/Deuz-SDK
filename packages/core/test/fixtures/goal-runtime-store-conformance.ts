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
  });
}
