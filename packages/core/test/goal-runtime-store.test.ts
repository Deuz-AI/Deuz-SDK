/**
 * goal-runtime-store.test.ts (2.4, spec §3.1) — the in-memory goal runtime
 * store: the 2.3 goal-store conformance fixture, the goal runtime store
 * conformance fixture, and the scope-checked `load` it adds to `GoalStore`.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryGoalStore, transitionGoal } from '../src/goal';
import { createInMemoryGoalRuntimeStore } from '../src/goal/runtime';
import { goalRecord, goalStoreContracts } from './fixtures/goal-store-conformance';

goalStoreContracts('memory goal runtime store (GoalStore)', () => createInMemoryGoalRuntimeStore());

const T0 = Date.parse('2026-10-10T10:00:00Z');

describe('memory goal runtime store: goals', () => {
  it('reads a goal of another scope as undefined when a scope is given', async () => {
    const store = createInMemoryGoalRuntimeStore();
    await store.save(goalRecord('g', T0, 'tenant-a'));
    expect((await store.load('g', { scope: 'tenant-a' }))?.goalId).toBe('g');
    expect(await store.load('g', { scope: 'tenant-b' })).toBeUndefined();
    expect((await store.load('g'))?.scope).toBe('tenant-a');
  });

  it('never moves a goal to another scope', async () => {
    const store = createInMemoryGoalRuntimeStore();
    const goal = goalRecord('g', T0, 'tenant-a');
    await store.save(goal);
    const next = transitionGoal(goal, { type: 'link-run', runId: 'r1' }, { now: T0 + 1 }).record;
    await expect(store.save({ ...next, scope: 'tenant-b' })).rejects.toMatchObject({
      code: 'scope_mismatch',
    });
    expect((await store.load('g'))?.revision).toBe(1);
  });

  it('refuses a record that is not a valid goal', async () => {
    const store = createInMemoryGoalRuntimeStore();
    await expect(store.save({ ...goalRecord('g'), status: 'done' } as never)).rejects.toMatchObject(
      { code: 'invalid_goal' },
    );
  });
});

describe('createInMemoryGoalStore: scope-checked load (2.4)', () => {
  it('reads a goal of another scope as undefined when a scope is given', async () => {
    const store = createInMemoryGoalStore();
    await store.save(goalRecord('g', T0, 'tenant-a'));
    expect((await store.load('g', { scope: 'tenant-a' }))?.goalId).toBe('g');
    expect(await store.load('g', { scope: 'tenant-b' })).toBeUndefined();
    expect((await store.load('g'))?.goalId).toBe('g');
  });
});
