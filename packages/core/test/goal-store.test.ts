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
