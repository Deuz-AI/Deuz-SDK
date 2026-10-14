/**
 * The schedule/inbox store contract (2.4) on the L5 test double, and on the
 * real in-memory `GoalRuntimeStore` once lane L4a has landed it (until then
 * the stub throws `NotImplementedError` and that run is skipped). The SQLite
 * and PostgreSQL stores run the same fixture in their own test files.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryGoalRuntimeStore } from '../src/goal/runtime/store';
import { NotImplementedError } from '../src/internal/not-implemented';
import { scheduleStoreContracts } from './fixtures/schedule-store-conformance';
import {
  SimulatedCrash,
  createScheduleStoreDouble,
  withStoreFaults,
} from './fixtures/goal-runtime-double';

scheduleStoreContracts('the L5 schedule store double', (deps) =>
  createScheduleStoreDouble({ deps }),
);

const realStoreLanded = (() => {
  try {
    createInMemoryGoalRuntimeStore();
    return true;
  } catch (error) {
    if (error instanceof NotImplementedError) return false;
    throw error;
  }
})();

describe.runIf(realStoreLanded)('createInMemoryGoalRuntimeStore', () => {
  scheduleStoreContracts('schedule/inbox contract', (deps) =>
    createInMemoryGoalRuntimeStore({ deps }),
  );
});

describe('withStoreFaults', () => {
  it('crashes before a write (nothing committed) or after it (committed, unseen)', async () => {
    const store = createScheduleStoreDouble();
    await store.schedules.put(
      { scheduleId: 's', scope: 't', goalId: 'g', spec: { cron: '* * * * *' } },
      { expectedRevision: 0, effectiveFrom: 0 },
    );
    const faults = ['before', 'after', undefined] as const;
    const faulty = withStoreFaults(store, { advance: (call) => faults[call - 1] });
    const step = (from: number) =>
      faulty.schedules.advance({
        scope: 't',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: from,
        toCursor: from + 60_000,
        occurrences: [],
      });
    await expect(step(0)).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await store.schedules.get('t', 's'))?.scheduleCursor).toBe(0);
    await expect(step(0)).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await store.schedules.get('t', 's'))?.scheduleCursor).toBe(60_000);
    expect((await step(60_000)).status).toBe('advanced');
    // Everything else passes straight through, bound to the store.
    expect((await faulty.schedules.get('t', 's'))?.scheduleCursor).toBe(120_000);
    expect(await faulty.load('missing')).toBeUndefined();
  });
});
