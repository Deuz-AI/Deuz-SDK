/**
 * goal-store.test.ts (2.3, 23.6) — the in-memory reference GoalStore, run
 * against the conformance fixture every goal store should pass, and the loop
 * a host runs around a store: load, transition, save, and on a revision
 * conflict load again.
 */
import { describe, expect, it } from 'vitest';
import { GoalError, createInMemoryGoalStore, transitionGoal } from '../src/goal';
import type { GoalCommand, GoalStore } from '../src/goal';
import { goalRecord, goalStoreContracts } from './fixtures/goal-store-conformance';

goalStoreContracts('memory goal store', () => createInMemoryGoalStore());

const T0 = Date.parse('2026-10-10T10:00:00Z');

/** The host's loop around a store: apply, save, and retry from a fresh copy on a conflict. */
async function update(store: GoalStore, goalId: string, command: GoalCommand, now: number) {
  for (let attempt = 0; ; attempt++) {
    const current = await store.load(goalId);
    if (!current) throw new Error(`Unknown goal ${goalId}`);
    const next = transitionGoal(current, command, { now });
    if (!next.changed) return next;
    try {
      await store.save(next.record);
      return next;
    } catch (error) {
      if (!(error instanceof GoalError && error.code === 'revision_conflict') || attempt >= 3)
        throw error;
    }
  }
}

describe('memory goal store', () => {
  it('refuses a record that is not a valid goal', async () => {
    const store = createInMemoryGoalStore();
    await expect(
      Promise.resolve().then(() => store.save({ ...goalRecord('g'), status: 'done' } as never)),
    ).rejects.toThrow(expect.objectContaining({ code: 'invalid_goal' }) as unknown as Error);
    await expect(
      Promise.resolve().then(() => store.save({ ...goalRecord('g'), revision: 2 })),
    ).rejects.toThrow(expect.objectContaining({ code: 'revision_conflict' }) as unknown as Error);
  });

  it('lets two writers race on one goal without losing either change', async () => {
    const store = createInMemoryGoalStore();
    await store.save(goalRecord('g'));
    // Both writers load revision 1; the second save conflicts and retries.
    let held = true;
    const racing: GoalStore = {
      load: async (goalId) => {
        const record = await store.load(goalId);
        if (held) {
          held = false;
          await update(store, 'g', { type: 'link-run', runId: 'r1' }, T0 + 1);
        }
        return record;
      },
      save: (record) => store.save(record),
    };
    await update(racing, 'g', { type: 'charge', tokens: 10, key: 'r1' }, T0 + 2);
    expect(await store.load('g')).toMatchObject({
      revision: 3,
      runId: 'r1',
      spent: { tokens: 10 },
      charged: ['r1'],
    });
    // The same charge delivered again is a duplicate, and nothing is saved.
    const again = await update(store, 'g', { type: 'charge', tokens: 10, key: 'r1' }, T0 + 3);
    expect(again).toMatchObject({ changed: false, reason: 'duplicate' });
    expect((await store.load('g'))!.revision).toBe(3);
  });
});

/** A store whose first listing races a charge that another writer saves meanwhile. */
function chargedWhileListing(store: ReturnType<typeof createInMemoryGoalStore>) {
  let raced = false;
  return {
    ...store,
    async list(query?: Parameters<typeof store.list>[0]) {
      const page = await store.list(query);
      if (!raced) {
        raced = true;
        const current = (await store.load('g'))!;
        await store.save(
          transitionGoal(current, { type: 'charge', tokens: 10, key: 'run-1' }, { now: T0 + 2 })
            .record,
        );
      }
      return page;
    },
  };
}

/** A goal `g` waiting for a wakeup a minute after T0. */
async function sleeping(store: GoalStore): Promise<void> {
  const created = goalRecord('g');
  await store.save(created);
  await store.save(
    transitionGoal(
      created,
      { type: 'wait', wait: { reason: 'wakeup', at: T0 + 60_000 } },
      { now: T0 + 1 },
    ).record,
  );
}

/**
 * goals.mdx's wakeDueGoals job ("Wakeups and events") over `goals`, its body
 * as the page shows it. Keep the two in step.
 */
function wakeupJob(goals: GoalStore & Required<Pick<GoalStore, 'list'>>) {
  /** Ticks the goals whose wakeup is due, and returns those this pass woke. */
  return async function wakeDueGoals(now: number): Promise<string[]> {
    const woken: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await goals.list({ statuses: ['waiting'], cursor });
      for (const goal of page.goals) {
        const wait = goal.waiting;
        if (wait?.reason !== 'wakeup' || wait.at > now) continue;
        const next = transitionGoal(goal, { type: 'tick' }, { now });
        if (!next.changed) continue;
        try {
          await goals.save(next.record);
        } catch (error) {
          // Another writer saved the goal since the listing: the next pass sees it.
          if (error instanceof GoalError && error.code === 'revision_conflict') continue;
          throw error;
        }
        // This pass woke it: resume the goal's run here (a passed deadline failed it instead).
        if (next.record.status === 'active') woken.push(goal.goalId);
      }
      cursor = page.cursor;
    } while (cursor);
    return woken;
  };
}

describe("goals.mdx's wakeup job", () => {
  it('still wakes a due goal after a pass lost its save to another writer', async () => {
    const store = createInMemoryGoalStore();
    await sleeping(store);
    const wakeDueGoals = wakeupJob(chargedWhileListing(store));
    // The charge wins: this pass leaves the goal for the next one.
    expect(await wakeDueGoals(T0 + 60_000)).toEqual([]);
    expect(await store.load('g')).toMatchObject({ status: 'waiting', spent: { tokens: 10 } });
    // A minute later the job runs again.
    expect(await wakeDueGoals(T0 + 120_000)).toEqual(['g']);
    expect(await store.load('g')).toMatchObject({ status: 'active', spent: { tokens: 10 } });
  });

  it('lets one of two processes running it wake each goal', async () => {
    const store = createInMemoryGoalStore();
    await sleeping(store);
    const passes = await Promise.all([
      wakeupJob({ ...store })(T0 + 60_000),
      wakeupJob({ ...store })(T0 + 60_000),
    ]);
    expect(passes.flat()).toEqual(['g']);
    expect(await store.load('g')).toMatchObject({ status: 'active', revision: 3 });
  });
});
