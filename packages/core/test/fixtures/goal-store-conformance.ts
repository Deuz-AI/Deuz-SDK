import { describe, expect, it } from 'vitest';
import { createGoal, transitionGoal } from '../../src/goal';
import type { GoalListQuery, GoalRecord, GoalStore } from '../../src/goal';

const T0 = Date.parse('2026-10-10T10:00:00Z');

/** A goal at revision 1, created at `now`. */
export function goalRecord(goalId: string, now = T0, scope = 'tenant'): GoalRecord {
  return createGoal({ goalId, scope, objective: `Finish ${goalId}.` }, { now });
}

/**
 * The goal store contract (2.3): the persistence boundary a host implements.
 * A store keeps copies, and saves a record only at the stored revision plus
 * one (1 for a new goal), so a writer working from an old copy cannot
 * overwrite a newer one. Stores with `list` page newest change first. Run it
 * against your own store:
 *
 * ```ts
 * goalStoreContracts('my store', () => createMyGoalStore());
 * ```
 */
export function goalStoreContracts(name: string, make: () => GoalStore | Promise<GoalStore>): void {
  describe(name, () => {
    it('keeps copies, and returns undefined for an unknown goal', async () => {
      const store = await make();
      expect(await store.load('missing')).toBeUndefined();
      const goal = goalRecord('g');
      await store.save(goal);
      goal.objective = 'changed after the save';
      const loaded = await store.load('g');
      expect(loaded).toEqual(goalRecord('g'));
      loaded!.criteria.length = 0;
      expect((await store.load('g'))!.criteria).toHaveLength(1);
    });

    it('saves each revision once, in order', async () => {
      const store = await make();
      const goal = goalRecord('g');
      await store.save(goal);
      const next = transitionGoal(goal, { type: 'link-run', runId: 'r1' }, { now: T0 + 1 }).record;
      await store.save(next);
      expect(await store.load('g')).toEqual(next);
      // A writer that loaded revision 1 computes its own revision 2: refused.
      const stale = transitionGoal(goal, { type: 'cancel' }, { now: T0 + 2 }).record;
      await expect(Promise.resolve().then(() => store.save(stale))).rejects.toThrow(/revision/i);
      // Skipping a revision is refused too, and so is a new goal not at revision 1.
      const skipped = { ...next, revision: 4 };
      await expect(Promise.resolve().then(() => store.save(skipped))).rejects.toThrow(/revision/i);
      const late = { ...goalRecord('h'), revision: 2 };
      await expect(Promise.resolve().then(() => store.save(late))).rejects.toThrow(/revision/i);
      expect(await store.load('g')).toEqual(next);
      expect(await store.load('h')).toBeUndefined();
    });

    it('lists goals newest change first, by status and scope, page by page', async () => {
      const store = await make();
      if (!store.list) return;
      const list = store.list.bind(store);
      await store.save(goalRecord('a', T0 + 1));
      await store.save(goalRecord('b', T0 + 2, 'other'));
      const c = goalRecord('c', T0 + 3);
      await store.save(c);
      await store.save(transitionGoal(c, { type: 'cancel' }, { now: T0 + 4 }).record);
      await store.save(goalRecord('d', T0 + 5));
      await store.save(goalRecord('e', T0 + 5));

      const ids = async (query?: GoalListQuery) =>
        (await list(query)).goals.map((goal) => goal.goalId);
      expect(await ids()).toEqual(['e', 'd', 'c', 'b', 'a']);
      expect(await ids({ statuses: ['cancelled'] })).toEqual(['c']);
      expect(await ids({ statuses: ['active'], scope: 'tenant' })).toEqual(['e', 'd', 'a']);
      expect(await ids({ statuses: [] })).toEqual([]);
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ limit: 2, ...(cursor ? { cursor } : {}) });
        pages.push(page.goals.map((goal) => goal.goalId));
        cursor = page.cursor;
      } while (cursor);
      expect(pages).toEqual([['e', 'd'], ['c', 'b'], ['a']]);
      for (const query of [{ limit: 0 }, { limit: 1001 }, { cursor: 'nope' }, { statuses: ['x'] }])
        await expect(
          Promise.resolve().then(() => list(query as GoalListQuery)),
          JSON.stringify(query),
        ).rejects.toThrow(TypeError);
    });
  });
}
