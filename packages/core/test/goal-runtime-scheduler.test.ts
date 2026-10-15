/**
 * The durable scheduler (2.4, spec §3.2): schedules on existing goals with
 * revisions and explicit UTC boundaries, occurrences committed into the goal
 * inbox in the same advance as the cursor, catch-up and backlog limits, and
 * the `deuz.schedule.delivery` span. Runs on the L5 store double; the
 * scenarios in `scenarios-2-4/l5.test.ts` run on the real store once it lands.
 */
import { describe, expect, it, vi } from 'vitest';
import { GoalError, createGoal } from '../src/goal';
import { createDurableScheduler } from '../src/goal/runtime/scheduler';
import type { DurableSchedulerOptions } from '../src/goal/runtime/scheduler';
import { createInMemoryGoalRuntimeStore, goalInboxKey } from '../src/goal/runtime/store';
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
  /** The timer-firing manual clock, for `start()`; otherwise a clock that only moves. */
  timers?: boolean;
};

/** A clock that moves only when told and fires no timers: ticks are driven by hand. */
function steppedClock(start: number): ReturnType<typeof manualClock> {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: async (ms) => {
      now += ms;
    },
    pending: () => 0,
  };
}

async function setup({ wrap, timers, ...options }: SetupOptions = {}, start = T0) {
  const time = timers ? manualClock(start) : steppedClock(start);
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

  it('an unchanged put (the boot-time ensure) is no change: no revision, no boundary, no write', async () => {
    const { scheduler, store, time } = await setup();
    const first = await scheduler.put(input({ event: { correlationId: 'c-1' } }));
    await time.advance(10 * MINUTE);
    // The same schedule, with its defaults spelled out or left out, is the stored one.
    const put = vi.spyOn(store.schedules, 'put');
    expect(await scheduler.put(input({ event: { correlationId: 'c-1' } }))).toEqual(first);
    expect(
      await scheduler.put(
        input({
          spec: {
            cron: '0 9 * * *',
            timezone: 'UTC',
            dstGap: 'shift',
            dstOverlap: 'first',
            catchUp: 'latest',
          },
          event: { correlationId: 'c-1' },
        }),
        { expectedRevision: 1 },
      ),
    ).toEqual(first);
    expect(put).not.toHaveBeenCalled();
    // A paused schedule stays paused, at its revision.
    const paused = await scheduler.pause('tenant', 's');
    expect(await scheduler.put(input({ event: { correlationId: 'c-1' } }))).toEqual(paused);
    expect(put).not.toHaveBeenCalled();
    // Any difference is a change: the event, the spec or the goal.
    const changed = await scheduler.put(input());
    expect(changed).toMatchObject({
      revision: 3,
      status: 'paused',
      effectiveFrom: T0 + 10 * MINUTE,
    });
    expect(put).toHaveBeenCalledTimes(1);
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

  it('stops before stepping when its signal is aborted', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '* * * * *' } }));
    await time.advance(MINUTE);
    const controller = new AbortController();
    controller.abort();
    const result = await scheduler.tick({ signal: controller.signal });
    expect(result).toMatchObject({ occurrences: [], backlog: 1 });
    expect(await pending(store)).toEqual([]);
  });
});

describe('createDurableScheduler: catch-up and backlog', () => {
  const skippedReasons = (result: { occurrences: { disposition: string; reason?: string }[] }) =>
    result.occurrences.filter((o) => o.disposition === 'skipped').map((o) => o.reason);
  const deliveredIds = (result: { occurrences: { disposition: string; occurrenceId: string }[] }) =>
    result.occurrences.filter((o) => o.disposition === 'delivered').map((o) => o.occurrenceId);

  it('latest (the default) delivers only the newest missed occurrence and records the rest as skipped', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '*/10 * * * *' } }));
    await time.advance(65 * MINUTE);
    const result = await scheduler.tick();
    expect(result.occurrences.map((o) => o.at)).toEqual(
      [10, 20, 30, 40, 50, 60].map((minutes) => T0 + minutes * MINUTE),
    );
    expect(skippedReasons(result)).toEqual(Array(5).fill('catch-up-latest'));
    expect(deliveredIds(result)).toEqual([`s@${T0 + 60 * MINUTE}`]);
    expect(result.backlog).toBe(0);
    expect(await pending(store)).toEqual([`s@${T0 + 60 * MINUTE}`]);
    expect(await store.schedules.get('tenant', 's')).toMatchObject({
      scheduleCursor: T0 + 65 * MINUTE,
    });
    expect((await store.schedules.get('tenant', 's'))?.scanTo).toBeUndefined();
  });

  it('latest delivers nothing before a window longer than the scan limit is fully scanned', async () => {
    const { scheduler, store, time } = await setup({ maxScanMinutes: 60 });
    await scheduler.put(input({ spec: { cron: '*/10 * * * *' } }));
    await time.advance(3 * 60 * MINUTE);
    const first = await scheduler.tick();
    expect(deliveredIds(first)).toEqual([]);
    expect(skippedReasons(first)).toHaveLength(6);
    expect(first.backlog).toBe(1);
    expect(await pending(store)).toEqual([]);
    // The window survives a restart: it lives in the store, not in the scheduler.
    expect(await store.schedules.get('tenant', 's')).toMatchObject({
      scheduleCursor: T0 + 60 * MINUTE,
      scanTo: T0 + 180 * MINUTE,
    });
    const restarted = createDurableScheduler({
      store,
      deps: { clock: time.clock },
      maxScanMinutes: 60,
    });
    const second = await restarted.tick();
    expect(deliveredIds(second)).toEqual([]);
    expect(await pending(store)).toEqual([]);
    await time.advance(30_000);
    const third = await restarted.tick();
    expect(skippedReasons(third)).toHaveLength(5);
    expect(deliveredIds(third)).toEqual([`s@${T0 + 180 * MINUTE}`]);
    expect(third.backlog).toBe(0);
    expect(await pending(store)).toEqual([`s@${T0 + 180 * MINUTE}`]);
  });

  it('latest writes at most maxDeliveriesPerTick records per advance, finishing the window in one tick', async () => {
    let largest = 0;
    let advances = 0;
    const { scheduler, store, time } = await setup({
      wrap: (double) =>
        withStoreFaults(double, {
          advance: (_call, advance) => {
            advances += 1;
            largest = Math.max(largest, advance.occurrences.length);
            return undefined;
          },
        }),
    });
    await scheduler.put(input({ spec: { cron: '* * * * *' } }));
    await time.advance(250 * MINUTE);
    const result = await scheduler.tick();
    expect(result.occurrences).toHaveLength(250);
    expect(deliveredIds(result)).toEqual([`s@${T0 + 250 * MINUTE}`]);
    expect(largest).toBe(100);
    expect(advances).toBe(3);
    expect(await pending(store)).toEqual([`s@${T0 + 250 * MINUTE}`]);
  });

  it('all delivers every missed occurrence, 100 per tick, the rest from the persistent cursor', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '* * * * *', catchUp: 'all' } }));
    await time.advance(250 * MINUTE);
    const expected = Array.from({ length: 250 }, (_, index) => `s@${T0 + (index + 1) * MINUTE}`);
    const first = await scheduler.tick();
    expect(deliveredIds(first)).toEqual(expected.slice(0, 100));
    expect(first.backlog).toBe(1);
    const restarted = createDurableScheduler({ store, deps: { clock: time.clock } });
    const second = await restarted.tick();
    expect(deliveredIds(second)).toEqual(expected.slice(100, 200));
    const third = await restarted.tick();
    expect(deliveredIds(third)).toEqual(expected.slice(200));
    expect(third.backlog).toBe(0);
    expect(await pending(store)).toEqual(expected);
    expect((await restarted.tick()).occurrences).toEqual([]);
  });

  it('none skips missed occurrences and delivers those still within grace', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '* * * * *', catchUp: 'none' } }));
    await time.advance(10 * MINUTE + 30_000);
    const result = await scheduler.tick();
    expect(skippedReasons(result)).toEqual(Array(9).fill('catch-up-none'));
    expect(deliveredIds(result)).toEqual([`s@${T0 + 10 * MINUTE}`]);
    expect(await pending(store)).toEqual([`s@${T0 + 10 * MINUTE}`]);
  });

  it('counts an occurrence found within graceMs as on time', async () => {
    const strict = await setup({ graceMs: 0 });
    await strict.scheduler.put(input({ spec: { cron: '*/5 * * * *', catchUp: 'none' } }));
    await strict.time.advance(5 * MINUTE + 1_000);
    expect(skippedReasons(await strict.scheduler.tick())).toEqual(['catch-up-none']);
    const lenient = await setup();
    await lenient.scheduler.put(input({ spec: { cron: '*/5 * * * *', catchUp: 'none' } }));
    await lenient.time.advance(5 * MINUTE + 59_000);
    expect(deliveredIds(await lenient.scheduler.tick())).toEqual([`s@${T0 + 5 * MINUTE}`]);
  });

  it('scans at most maxScanMinutes of UTC time per schedule per tick', async () => {
    const { scheduler, store, time } = await setup({ maxScanMinutes: 24 * 60 });
    await scheduler.put(input({ spec: { cron: '0 12 * * *', catchUp: 'all' } }));
    await time.advance(5 * 24 * 60 * MINUTE);
    const noon = (day: number) => `s@${Date.parse(`2026-10-${10 + day}T12:00:00Z`)}`;
    for (let day = 0; day < 5; day++) {
      const result = await scheduler.tick();
      expect(deliveredIds(result)).toEqual([noon(day)]);
      expect(result.backlog).toBe(day < 4 ? 1 : 0);
      expect((await store.schedules.get('tenant', 's'))?.scheduleCursor).toBe(
        T0 + (day + 1) * 24 * 60 * MINUTE,
      );
    }
    expect(await pending(store)).toEqual([0, 1, 2, 3, 4].map(noon));
  });

  it('serves schedules in turn, so one backlog never starves the others', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(
      input({ scheduleId: 'backlog', spec: { cron: '* * * * *', catchUp: 'all' } }),
    );
    await time.advance(500 * MINUTE);
    for (const scheduleId of ['b', 'c'])
      await scheduler.put(input({ scheduleId, goalId: 'goal-2', spec: { cron: '* * * * *' } }));
    await time.advance(MINUTE);
    const result = await scheduler.tick();
    const byId = (id: string) => result.occurrences.filter((o) => o.scheduleId === id).length;
    expect([byId('backlog'), byId('b'), byId('c')]).toEqual([98, 1, 1]);
    expect(result.backlog).toBe(1);
    expect(await pending(store, 'goal-2')).toHaveLength(2);
  });

  it('starts the next tick after the schedule served last', async () => {
    const { scheduler, time } = await setup({ maxDeliveriesPerTick: 2 });
    for (const scheduleId of ['a', 'b', 'c'])
      await scheduler.put(input({ scheduleId, spec: { cron: '* * * * *', catchUp: 'all' } }));
    await time.advance(10 * MINUTE);
    const served = async () =>
      (await scheduler.tick()).occurrences.map((o) => o.scheduleId).join('');
    // Three backlogs, two deliveries per tick: each schedule waits at most one tick.
    expect([await served(), await served(), await served()]).toEqual(['ab', 'ca', 'bc']);
  });

  it('catches up after downtime although the host ensured the same schedule at boot', async () => {
    // On the real in-memory store: put at boot, tick on time, down 5 hours, put again, tick.
    const boot = async (catchUp: 'latest' | 'all', putAtBoot: boolean) => {
      let now = Date.parse('2026-10-10T10:30:00Z');
      const clock = { now: () => now, setTimeout: () => () => {} };
      const store = createInMemoryGoalRuntimeStore({ deps: { clock } });
      await store.save(createGoal({ goalId: 'g', scope: 't', objective: 'Do g.' }, { now }));
      const ensured: DurableScheduleInput = {
        scheduleId: 's',
        scope: 't',
        goalId: 'g',
        spec: { cron: '0 * * * *', catchUp },
      };
      const first = createDurableScheduler({ store, deps: { clock } });
      await first.put(ensured);
      now = Date.parse('2026-10-10T11:00:30Z');
      expect(deliveredIds(await first.tick())).toHaveLength(1);
      now += 5 * 60 * MINUTE;
      const second = createDurableScheduler({ store, deps: { clock } });
      if (putAtBoot) await second.put(ensured);
      return deliveredIds(await second.tick());
    };
    const hours = (from: number, to: number) =>
      Array.from(
        { length: to - from + 1 },
        (_, i) => `s@${Date.parse('2026-10-10T00:00:00Z') + (from + i) * 60 * MINUTE}`,
      );
    for (const putAtBoot of [false, true]) {
      expect(await boot('all', putAtBoot)).toEqual(hours(12, 16));
      expect(await boot('latest', putAtBoot)).toEqual(hours(16, 16));
    }
  });

  it('applies a change from its boundary: no occurrence of either revision is invented before it', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '0 * * * *' } }));
    await time.advance(3.5 * 60 * MINUTE);
    await scheduler.put(input({ goalId: 'goal-2', spec: { cron: '30 * * * *', catchUp: 'all' } }));
    await time.advance(MINUTE);
    expect((await scheduler.tick()).occurrences).toEqual([]);
    await time.advance(59 * MINUTE);
    const result = await scheduler.tick();
    expect(deliveredIds(result)).toEqual([`s@${Date.parse('2026-10-10T14:30:00Z')}`]);
    expect(result.occurrences[0]?.goalId).toBe('goal-2');
    expect(await pending(store, 'goal-2')).toHaveLength(1);
    expect(await pending(store, 'goal-1')).toEqual([]);
  });

  it('stops scanning while paused and continues from the resume boundary', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '*/5 * * * *', catchUp: 'all' } }));
    await time.advance(2 * MINUTE);
    await scheduler.pause('tenant', 's');
    await time.advance(28 * MINUTE);
    expect((await scheduler.tick()).occurrences).toEqual([]);
    await scheduler.resume('tenant', 's');
    await time.advance(MINUTE);
    expect((await scheduler.tick()).occurrences).toEqual([]);
    await time.advance(4 * MINUTE);
    expect(deliveredIds(await scheduler.tick())).toEqual([`s@${T0 + 35 * MINUTE}`]);
    expect(await pending(store)).toEqual([`s@${T0 + 35 * MINUTE}`]);
  });

  it('cancel ends the deliveries not yet applied and the schedule with them', async () => {
    const { scheduler, store, time } = await setup();
    await scheduler.put(input({ spec: { cron: '*/5 * * * *', catchUp: 'all' } }));
    await time.advance(10 * MINUTE);
    await scheduler.tick();
    expect(await pending(store)).toHaveLength(2);
    await scheduler.cancel('tenant', 's');
    expect(await pending(store)).toEqual([]);
    const ended = await store.inbox.list({ scope: 'tenant', dispositions: ['cancelled'] });
    expect(ended.entries).toHaveLength(2);
    await time.advance(10 * MINUTE);
    expect((await scheduler.tick()).occurrences).toEqual([]);
  });

  it('moves an idle cursor up now and then, so a later scan starts close by', async () => {
    const { scheduler, store, time } = await setup({ maxScanMinutes: 60 });
    await scheduler.put(input({ spec: { cron: '0 0 1 1 *' } }));
    await time.advance(29 * MINUTE);
    await scheduler.tick();
    expect((await store.schedules.get('tenant', 's'))?.scheduleCursor).toBe(T0);
    await time.advance(MINUTE);
    const idle = await scheduler.tick();
    expect(idle.occurrences).toEqual([]);
    expect((await store.schedules.get('tenant', 's'))?.scheduleCursor).toBe(T0 + 30 * MINUTE);
  });
});

describe('createDurableScheduler: start', () => {
  /** Moves the clock one poll at a time, each time once the loop has armed its next timer. */
  async function polls(time: ReturnType<typeof manualClock>, count: number, pollMs = 30_000) {
    for (let index = 0; index < count; index++) {
      await vi.waitFor(() => expect(time.pending()).toBe(1));
      await time.advance(pollMs);
    }
  }

  it('ticks every pollMs on the injected clock until stopped', { timeout: 20_000 }, async () => {
    const { scheduler, store, time } = await setup({ pollMs: MINUTE, timers: true });
    await scheduler.put(input({ spec: { cron: '* * * * *' } }));
    const loop = scheduler.start();
    await polls(time, 3, MINUTE);
    await vi.waitFor(() => expect(time.pending()).toBe(1));
    expect(await pending(store)).toEqual([1, 2, 3].map((m) => `s@${T0 + m * MINUTE}`));
    await loop.stop();
    expect(time.pending()).toBe(0);
    await time.advance(5 * MINUTE);
    expect(await pending(store)).toHaveLength(3);
  });

  it('stops once the tick in flight finished', { timeout: 20_000 }, async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    const { scheduler, store, time } = await setup({
      pollMs: 30_000,
      timers: true,
      wrap: (double) => ({
        ...double,
        schedules: {
          ...double.schedules,
          advance: async (advance) => {
            entered();
            await new Promise<void>((resolve) => (release = resolve));
            return double.schedules.advance(advance);
          },
        },
      }),
    });
    await scheduler.put(input({ spec: { cron: '* * * * *' } }));
    const loop = scheduler.start();
    await polls(time, 2);
    await inFlight;
    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await pending(store)).toEqual([`s@${T0 + MINUTE}`]);
  });

  it('stops on its signal, and refuses a second start while running', async () => {
    const { scheduler, time } = await setup({ timers: true });
    const controller = new AbortController();
    const loop = scheduler.start({ signal: controller.signal });
    expect(() => scheduler.start()).toThrow(/already started/);
    controller.abort();
    await loop.stop();
    expect(time.pending()).toBe(0);
    // Once stopped it can start again; an aborted signal stops it at once.
    const aborted = new AbortController();
    aborted.abort();
    await scheduler.start({ signal: aborted.signal }).stop();
  });

  it('logs a tick that throws and goes on', { timeout: 20_000 }, async () => {
    let failures = 1;
    const { scheduler, store, time, logged } = await setup({
      pollMs: 30_000,
      timers: true,
      wrap: (double) => ({
        ...double,
        schedules: {
          ...double.schedules,
          list: async (query) => {
            if (failures-- > 0) throw new Error('store unavailable');
            return double.schedules.list(query);
          },
        },
      }),
    });
    await scheduler.put(input({ spec: { cron: '* * * * *' } }));
    const loop = scheduler.start();
    await polls(time, 2);
    await vi.waitFor(() => expect(time.pending()).toBe(1));
    await loop.stop();
    expect(logged.map((entry) => entry.message)).toContain('durable scheduler tick failed');
    expect(await pending(store)).toEqual([`s@${T0 + MINUTE}`]);
  });
});
