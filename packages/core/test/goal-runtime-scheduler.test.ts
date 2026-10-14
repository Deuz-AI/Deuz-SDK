/**
 * The durable scheduler (2.4, spec §3.2): schedules on existing goals with
 * revisions and explicit UTC boundaries, occurrences committed into the goal
 * inbox in the same advance as the cursor, catch-up and backlog limits, and
 * the `deuz.schedule.delivery` span. Runs on the L5 store double; the
 * scenarios in `scenarios-2-4/l5.test.ts` run on the real store once it lands.
 */
import { describe, expect, it } from 'vitest';
import { GoalError, createGoal } from '../src/goal';
import { createDurableScheduler } from '../src/goal/runtime/scheduler';
import type { DurableSchedulerOptions } from '../src/goal/runtime/scheduler';
import type { DurableScheduleInput } from '../src/goal/runtime/store-types';
import type { ObserveEvent } from '../src/types/observe';
import { createScheduleStoreDouble } from './fixtures/goal-runtime-double';
import { manualClock } from './fixtures/manual-clock';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const MINUTE = 60_000;

async function setup(options: Partial<DurableSchedulerOptions> = {}, start = T0) {
  const time = manualClock(start);
  const events: ObserveEvent[] = [];
  const store = createScheduleStoreDouble({ deps: { clock: time.clock } });
  for (const [goalId, scope] of [
    ['goal-1', 'tenant'],
    ['goal-2', 'tenant'],
    ['goal-x', 'other'],
  ] as const)
    await store.save(createGoal({ goalId, scope, objective: `Do ${goalId}.` }, { now: start }));
  let ids = 0;
  const scheduler = createDurableScheduler({
    store,
    deps: {
      clock: time.clock,
      generateId: () => `id-${++ids}`,
      observer: { emit: (event) => void events.push(event) },
    },
    ...options,
  });
  return { store, time, scheduler, events };
}

const input = (overrides: Partial<DurableScheduleInput> = {}): DurableScheduleInput => ({
  scheduleId: 's',
  scope: 'tenant',
  goalId: 'goal-1',
  spec: { cron: '0 9 * * *' },
  ...overrides,
});

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('createDurableScheduler: schedules', () => {
  it('puts a schedule on an existing goal at revision 1, its cursor at the time it is put', async () => {
    const { scheduler } = await setup();
    const schedule = await scheduler.put(
      input({ event: { correlationId: 'wait-1', expiresAfterMs: 5 * MINUTE } }),
    );
    expect(schedule).toEqual({
      scheduleId: 's',
      scope: 'tenant',
      goalId: 'goal-1',
      // Every default is spelled out, so a stored schedule never depends on them.
      spec: {
        cron: '0 9 * * *',
        timezone: 'UTC',
        dstGap: 'shift',
        dstOverlap: 'first',
        catchUp: 'latest',
      },
      event: { correlationId: 'wait-1', expiresAfterMs: 5 * MINUTE },
      status: 'active',
      revision: 1,
      effectiveFrom: T0,
      scheduleCursor: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await scheduler.get('tenant', 's')).toEqual(schedule);
    expect(await scheduler.get('other', 's')).toBeUndefined();
    expect((await scheduler.list({ scope: 'tenant' })).schedules).toEqual([schedule]);
  });

  it('refuses a malformed schedule before writing anything', async () => {
    const { scheduler } = await setup();
    for (const bad of [
      input({ scheduleId: '' }),
      input({ scope: '' }),
      input({ goalId: 42 as never }),
      input({ spec: { cron: 'every day' } }),
      input({ spec: { cron: '0 9 * * *', timezone: 'Mars/Base' } }),
      input({ spec: { cron: '0 9 * * *', dstGap: 'later' as never } }),
      input({ spec: { cron: '0 9 * * *', dstOverlap: 'last' as never } }),
      input({ spec: { cron: '0 9 * * *', catchUp: 'some' as never } }),
      input({ event: { expiresAfterMs: 0 } }),
      input({ event: { correlationId: '' } }),
      input({ spec: undefined as never }),
    ])
      expect(await refusal(scheduler.put(bad))).toBeInstanceOf(TypeError);
    expect((await scheduler.list()).schedules).toEqual([]);
  });

  it('targets only a goal that exists in its scope', async () => {
    const { scheduler } = await setup();
    for (const target of [{ goalId: 'missing' }, { goalId: 'goal-x' }]) {
      const error = await refusal(scheduler.put(input(target)));
      expect(error).toBeInstanceOf(GoalError);
      expect((error as GoalError).code).toBe('scope_mismatch');
    }
    expect((await scheduler.list()).schedules).toEqual([]);
  });

  it('changes a schedule as a new revision whose UTC boundary is the time of the change', async () => {
    const { scheduler, time } = await setup();
    await scheduler.put(input());
    await time.advance(10 * MINUTE);
    const changed = await scheduler.put(
      input({ goalId: 'goal-2', spec: { cron: '30 8 * * *', timezone: 'Europe/Istanbul' } }),
    );
    expect(changed).toMatchObject({
      goalId: 'goal-2',
      spec: { cron: '30 8 * * *', timezone: 'Europe/Istanbul' },
      revision: 2,
      effectiveFrom: T0 + 10 * MINUTE,
      scheduleCursor: T0,
      createdAt: T0,
    });
    const third = await scheduler.put(input(), { expectedRevision: 2 });
    expect(third.revision).toBe(3);
    for (const expectedRevision of [0, 2, 4]) {
      const error = await refusal(scheduler.put(input(), { expectedRevision }));
      expect((error as GoalError).code).toBe('revision_conflict');
    }
    expect((await scheduler.get('tenant', 's'))?.revision).toBe(3);
  });

  it('pauses, resumes and cancels as new revisions; repeating one writes nothing', async () => {
    const { scheduler, time } = await setup();
    await scheduler.put(input());
    const paused = await scheduler.pause('tenant', 's');
    expect(paused).toMatchObject({ status: 'paused', revision: 2 });
    expect(await scheduler.pause('tenant', 's')).toEqual(paused);
    await time.advance(MINUTE);
    const resumed = await scheduler.resume('tenant', 's', { expectedRevision: 2 });
    // Resuming sets a new boundary: nothing due while paused is delivered.
    expect(resumed).toMatchObject({ status: 'active', revision: 3, effectiveFrom: T0 + MINUTE });
    expect(await scheduler.resume('tenant', 's')).toEqual(resumed);
    const stale = await refusal(scheduler.pause('tenant', 's', { expectedRevision: 2 }));
    expect((stale as GoalError).code).toBe('revision_conflict');
    const cancelled = await scheduler.cancel('tenant', 's');
    expect(cancelled).toMatchObject({ status: 'cancelled', revision: 4 });
    expect(await scheduler.cancel('tenant', 's')).toEqual(cancelled);
    for (const change of [
      scheduler.resume('tenant', 's'),
      scheduler.pause('tenant', 's'),
      scheduler.put(input()),
    ]) {
      const error = await refusal(change);
      expect((error as GoalError).code).toBe('invalid_command');
    }
    const unknown = await refusal(scheduler.pause('tenant', 'nope'));
    expect((unknown as GoalError).code).toBe('scope_mismatch');
    expect(await refusal(scheduler.cancel('other', 's'))).toBeInstanceOf(GoalError);
  });
});
