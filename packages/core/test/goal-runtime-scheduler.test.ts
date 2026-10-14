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
import { goalInboxKey } from '../src/goal/runtime/store';
import type { DurableScheduleInput, GoalRuntimeStore } from '../src/goal/runtime/store-types';
import type { ObserveEvent } from '../src/types/observe';
import {
  SimulatedCrash,
  createScheduleStoreDouble,
  withStoreFaults,
  type ScheduleStoreDouble,
} from './fixtures/goal-runtime-double';
import { manualClock } from './fixtures/manual-clock';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const MINUTE = 60_000;

type SetupOptions = Partial<DurableSchedulerOptions> & {
  /** Wraps the store the scheduler sees (the test keeps the plain double). */
  wrap?: (store: ScheduleStoreDouble) => GoalRuntimeStore;
};

async function setup({ wrap, ...options }: SetupOptions = {}, start = T0) {
  const time = manualClock(start);
  const events: ObserveEvent[] = [];
  const logged: { message: string; fields?: Record<string, unknown> }[] = [];
  const store = createScheduleStoreDouble({ deps: { clock: time.clock } });
  for (const [goalId, scope] of [
    ['goal-1', 'tenant'],
    ['goal-2', 'tenant'],
    ['goal-x', 'other'],
  ] as const)
    await store.save(createGoal({ goalId, scope, objective: `Do ${goalId}.` }, { now: start }));
  let ids = 0;
  const log = (message: string, fields?: Record<string, unknown>) =>
    void logged.push({ message, ...(fields ? { fields } : {}) });
  const scheduler = createDurableScheduler({
    store: wrap ? wrap(store) : store,
    deps: {
      clock: time.clock,
      generateId: () => `id-${++ids}`,
      observer: { emit: (event) => void events.push(event) },
      logger: { debug: log, info: log, warn: log, error: log },
    },
    ...options,
  });
  return { store, time, scheduler, events, logged };
}

/** The delivery ids of a goal's pending inbox entries, oldest first. */
async function pending(store: GoalRuntimeStore, goalId = 'goal-1', scope = 'tenant') {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.inbox.list({
      scope,
      goalId,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.entries.map((entry) => entry.deliveryId));
    cursor = page.cursor;
  } while (cursor);
  return ids;
}

const occurrence = (scheduleId: string, iso: string) => `${scheduleId}@${Date.parse(iso)}`;

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

describe('createDurableScheduler: tick', () => {
  it('delivers an occurrence due within grace into the goal inbox, in the advance that moves the cursor', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(
      input({
        spec: { cron: '*/5 * * * *' },
        event: { correlationId: 'wait-1', expiresAfterMs: 5 * MINUTE },
      }),
    );
    await time.advance(5 * MINUTE + 10_000);
    const result = await scheduler.tick();
    const at = T0 + 5 * MINUTE;
    const occurrenceId = `s@${at}`;
    const entryId = goalInboxKey('tenant', 'schedule:s', occurrenceId);
    expect(result).toEqual({
      occurrences: [
        {
          occurrenceId,
          scheduleId: 's',
          scope: 'tenant',
          goalId: 'goal-1',
          at,
          disposition: 'delivered',
          inboxEntryId: entryId,
          recordedAt: T0 + 5 * MINUTE + 10_000,
        },
      ],
      duplicates: 0,
      backlog: 0,
      errors: [],
    });
    expect(await store.inbox.get('tenant', entryId)).toMatchObject({
      namespace: 'schedule:s',
      deliveryId: occurrenceId,
      disposition: 'pending',
      event: {
        kind: 'deuz-goal-event',
        id: occurrenceId,
        key: occurrenceId,
        source: { type: 'schedule', id: 's' },
        scope: 'tenant',
        goalId: 'goal-1',
        at,
        notBefore: at,
        correlationId: 'wait-1',
        expiresAt: at + 5 * MINUTE,
      },
    });
    expect((await store.schedules.get('tenant', 's'))?.scheduleCursor).toBe(
      T0 + 5 * MINUTE + 10_000,
    );
    // Nothing new until the next occurrence.
    expect((await scheduler.tick()).occurrences).toEqual([]);
    await time.advance(4 * MINUTE);
    expect((await scheduler.tick()).occurrences).toEqual([]);
    await time.advance(MINUTE);
    expect((await scheduler.tick()).occurrences.map((o) => o.occurrenceId)).toEqual([
      `s@${T0 + 10 * MINUTE}`,
    ]);
    expect(await pending(store)).toEqual([occurrenceId, `s@${T0 + 10 * MINUTE}`]);
  });

  it('never delivers an occurrence at or before the boundary of the schedule', async () => {
    const { scheduler, store, time } = await setup();
    // Put exactly at 10:00, when the cron matches: that run is not the schedule's.
    await scheduler.put(input({ spec: { cron: '0 10 * * *' } }));
    await time.advance(MINUTE);
    expect((await scheduler.tick()).occurrences).toEqual([]);
    expect(await pending(store)).toEqual([]);
  });

  it('takes the tick time from the caller when given', async () => {
    const { scheduler, store } = await setup();
    await scheduler.put(input({ spec: { cron: '*/5 * * * *' } }));
    await scheduler.tick({ now: T0 + 5 * MINUTE });
    expect(await pending(store)).toEqual([`s@${T0 + 5 * MINUTE}`]);
  });

  it('reports one deuz.schedule.delivery span per occurrence, with scalar ids only', async () => {
    const { scheduler, time, events } = await setup();
    await scheduler.put(input({ spec: { cron: '*/5 * * * *', catchUp: 'all' } }));
    await time.advance(10 * MINUTE);
    await scheduler.tick();
    const spans = events.filter(
      (event) =>
        event.type === 'operation.completed' && event.operation === 'deuz.schedule.delivery',
    );
    expect(spans.map((span) => (span as { attributes?: unknown }).attributes)).toEqual(
      [5, 10].map((minutes) => ({
        'deuz.schedule.id': 's',
        'deuz.schedule.occurrence_id': `s@${T0 + minutes * MINUTE}`,
        'deuz.schedule.disposition': 'delivered',
        'deuz.schedule.catch_up': 'all',
        'deuz.goal.id': 'goal-1',
      })),
    );
    for (const span of spans) expect(span).toMatchObject({ subsystem: 'schedule' });
  });

  it('lets two schedulers share a store without delivering an occurrence twice', async () => {
    const { scheduler, store, time } = await setup();
    const other = createDurableScheduler({ store, deps: { clock: time.clock } });
    await scheduler.put(input({ spec: { cron: '* * * * *', catchUp: 'all' } }));
    await scheduler.put(input({ scheduleId: 't', goalId: 'goal-2', spec: { cron: '* * * * *' } }));
    for (let minute = 0; minute < 5; minute++) {
      await time.advance(MINUTE);
      const [left, right] = await Promise.all([scheduler.tick(), other.tick()]);
      const delivered = [...left.occurrences, ...right.occurrences].filter(
        (o) => o.disposition === 'delivered',
      );
      expect(delivered).toHaveLength(2);
    }
    expect(await pending(store)).toHaveLength(5);
    expect(new Set(await pending(store)).size).toBe(5);
    expect(await pending(store, 'goal-2')).toHaveLength(5);
  });

  it('isolates a failing schedule: the others still advance, and the failure is reported', async () => {
    const { scheduler, store, time, logged } = await setup({
      wrap: (double) =>
        withStoreFaults(double, {
          advance: (_call, advance) => (advance.scheduleId === 'bad' ? 'before' : undefined),
        }),
    });
    await scheduler.put(input({ scheduleId: 'bad', spec: { cron: '* * * * *' } }));
    await scheduler.put(input({ scheduleId: 'good', spec: { cron: '* * * * *' } }));
    await time.advance(MINUTE);
    const result = await scheduler.tick();
    expect(result.occurrences.map((o) => o.scheduleId)).toEqual(['good']);
    expect(result.errors).toEqual([
      { scope: 'tenant', scheduleId: 'bad', error: expect.any(SimulatedCrash) },
    ]);
    expect(logged.some((entry) => entry.fields?.scheduleId === 'bad')).toBe(true);
    expect(await pending(store)).toEqual([occurrence('good', '2026-10-10T10:01:00Z')]);
  });
});
