import { afterEach, describe, expect, it } from 'vitest';
import { createGoal } from '../../src/goal';
import { goalEventFromOccurrence } from '../../src/goal/events';
import { goalInboxKey } from '../../src/goal/runtime/store';
import { sha256Digest } from '../../src/internal/digest';
import type { Dependencies } from '../../src/types/deps';
import type {
  DurableScheduleInput,
  GoalInboxEnqueue,
  GoalRuntimeStore,
  ScheduleAdvance,
} from '../../src/goal/runtime/store-types';
import { manualClock } from './manual-clock';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const MINUTE = 60_000;

function scheduleInput(
  scheduleId: string,
  overrides: Partial<DurableScheduleInput> = {},
): DurableScheduleInput {
  return {
    scheduleId,
    scope: 'tenant',
    goalId: 'goal-1',
    spec: { cron: '* * * * *', timezone: 'UTC' },
    ...overrides,
  };
}

/** The inbox delivery of the occurrence of `scheduleId` at `at`. */
async function occurrenceDelivery(
  scheduleId: string,
  at: number,
  options: { scope?: string; goalId?: string; content?: string } = {},
): Promise<GoalInboxEnqueue> {
  const scope = options.scope ?? 'tenant';
  const goalId = options.goalId ?? 'goal-1';
  const occurrenceId = `${scheduleId}@${at}`;
  return {
    scope,
    goalId,
    namespace: `schedule:${scheduleId}`,
    deliveryId: occurrenceId,
    event: goalEventFromOccurrence({ id: scheduleId, at, key: occurrenceId }, { scope, goalId }),
    digest: await sha256Digest(`${scope}|${goalId}|${occurrenceId}|${options.content ?? ''}`),
  };
}

async function delivered(
  scheduleId: string,
  at: number,
  options?: { scope?: string; goalId?: string },
): Promise<ScheduleAdvance['occurrences'][number]> {
  const delivery = await occurrenceDelivery(scheduleId, at, options);
  return {
    occurrenceId: delivery.deliveryId,
    scheduleId,
    scope: delivery.scope,
    goalId: delivery.goalId,
    at,
    disposition: 'delivered',
    delivery,
  };
}

function skipped(scheduleId: string, at: number): ScheduleAdvance['occurrences'][number] {
  return {
    occurrenceId: `${scheduleId}@${at}`,
    scheduleId,
    scope: 'tenant',
    goalId: 'goal-1',
    at,
    disposition: 'skipped',
    reason: 'catch-up-latest',
  };
}

/**
 * The schedule and inbox part of the goal runtime store contract (2.4, spec
 * §3.2), the part the durable scheduler and the webhook handler build on.
 * Run it against every `GoalRuntimeStore`:
 *
 * ```ts
 * scheduleStoreContracts('sqlite', (deps) => createSqliteGoalRuntimeStore({ database, deps }));
 * ```
 *
 * `make` gets the dependencies whose clock the store must use for its own
 * times (`createdAt`, `enqueuedAt`, `settledAt`, `recordedAt`). Pinned here
 * beyond the interface text: a new schedule's cursor is its `effectiveFrom`;
 * `advance` changes neither the revision nor anything but the cursor, `scanTo`
 * and `updatedAt`; a cancelled schedule is final.
 */
export function scheduleStoreContracts(
  name: string,
  make: (deps: Dependencies) => GoalRuntimeStore | Promise<GoalRuntimeStore>,
  options: { timeout?: number } = {},
): void {
  describe(name, () => {
    const open: GoalRuntimeStore[] = [];
    afterEach(async () => {
      for (const store of open.splice(0)) await store.close?.();
    });

    async function setup() {
      const time = manualClock(T0);
      const store = await make({ clock: time.clock });
      open.push(store);
      for (const [goalId, scope] of [
        ['goal-1', 'tenant'],
        ['goal-2', 'tenant'],
        ['goal-x', 'other'],
      ] as const)
        await store.save(createGoal({ goalId, scope, objective: `Do ${goalId}.` }, { now: T0 }));
      return { store, time };
    }

    const test = (title: string, fn: () => Promise<void>) =>
      it(title, { timeout: options.timeout }, fn);

    test('creates a schedule at revision 1 with its cursor at the boundary, in its scope only', async () => {
      const { store } = await setup();
      const input = scheduleInput('daily', {
        spec: { cron: '0 9 * * *', timezone: 'Europe/Istanbul', catchUp: 'all' },
        event: { correlationId: 'w-1', expiresAfterMs: 5 * MINUTE },
      });
      const created = await store.schedules.put(input, { expectedRevision: 0, effectiveFrom: T0 });
      expect(created.status).toBe('committed');
      const schedule = created.status === 'committed' ? created.schedule : undefined;
      expect(schedule).toMatchObject({
        ...input,
        status: 'active',
        revision: 1,
        effectiveFrom: T0,
        scheduleCursor: T0,
        createdAt: T0,
        updatedAt: T0,
      });
      expect(schedule?.scanTo).toBeUndefined();
      expect(await store.schedules.get('tenant', 'daily')).toEqual(schedule);
      expect(await store.schedules.get('other', 'daily')).toBeUndefined();
      expect(await store.schedules.get('tenant', 'missing')).toBeUndefined();
      // Copies out: changing what came back changes nothing stored.
      schedule!.spec.cron = '1 1 1 1 1';
      expect((await store.schedules.get('tenant', 'daily'))?.spec.cron).toBe('0 9 * * *');
      // A second create of the same id is a conflict, in the same scope only.
      expect(await store.schedules.put(input, { expectedRevision: 0, effectiveFrom: T0 })).toEqual({
        status: 'conflict',
      });
      const elsewhere = await store.schedules.put(
        { ...input, scope: 'other', goalId: 'goal-x' },
        { expectedRevision: 0, effectiveFrom: T0 },
      );
      expect(elsewhere.status).toBe('committed');
    });

    test('changes a schedule only at its revision, as a new revision with a new boundary', async () => {
      const { store, time } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      const moved = await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 5 * MINUTE,
        occurrences: [],
      });
      expect(moved.status).toBe('advanced');
      await time.advance(10 * MINUTE);
      const change = scheduleInput('s', {
        goalId: 'goal-2',
        spec: { cron: '*/5 * * * *', timezone: 'Asia/Kolkata' },
      });
      const result = await store.schedules.put(change, {
        expectedRevision: 1,
        effectiveFrom: T0 + 10 * MINUTE,
      });
      expect(result.status).toBe('committed');
      expect(await store.schedules.get('tenant', 's')).toMatchObject({
        ...change,
        revision: 2,
        effectiveFrom: T0 + 10 * MINUTE,
        // The change sets a boundary; it never rewinds or skips the cursor itself.
        scheduleCursor: T0 + 5 * MINUTE,
        createdAt: T0,
        updatedAt: T0 + 10 * MINUTE,
      });
      for (const expectedRevision of [1, 3])
        expect(await store.schedules.put(change, { expectedRevision, effectiveFrom: T0 })).toEqual({
          status: 'conflict',
        });
      expect(
        await store.schedules.put(scheduleInput('unknown'), {
          expectedRevision: 1,
          effectiveFrom: T0,
        }),
      ).toEqual({ status: 'conflict' });
      expect((await store.schedules.get('tenant', 's'))?.revision).toBe(2);
    });

    test('takes only the definition from a put: status, cursor, scanTo and times stay the store\x27s', async () => {
      const { store, time } = await setup();
      // A whole stored schedule passes as an input (no excess-property check on a variable).
      const extras = {
        status: 'paused',
        revision: 9,
        scheduleCursor: 1,
        scanTo: T0 + 99 * MINUTE,
        createdAt: 1,
        updatedAt: 1,
        effectiveFrom: 1,
        note: 'not a schedule field',
      };
      const created = await store.schedules.put(
        { ...scheduleInput('s'), ...extras } as DurableScheduleInput,
        { expectedRevision: 0, effectiveFrom: T0 },
      );
      expect(created.status === 'committed' && created.schedule).toEqual({
        ...scheduleInput('s'),
        status: 'active',
        revision: 1,
        effectiveFrom: T0,
        scheduleCursor: T0,
        createdAt: T0,
        updatedAt: T0,
      });
      const before = (await store.schedules.get('tenant', 's'))!;
      await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 2 * MINUTE,
        occurrences: [await delivered('s', T0 + MINUTE), await delivered('s', T0 + 2 * MINUTE)],
      });
      const after = (await store.schedules.get('tenant', 's'))!;
      await time.advance(5 * MINUTE);

      // A stale read-modify-put passes the revision check (advance keeps the revision)
      // but cannot rewind the cursor.
      const stale = await store.schedules.put(before, {
        expectedRevision: after.revision,
        effectiveFrom: T0 + 5 * MINUTE,
      });
      expect(stale.status).toBe('committed');
      expect(await store.schedules.get('tenant', 's')).toMatchObject({
        revision: 2,
        status: 'active',
        scheduleCursor: after.scheduleCursor,
        effectiveFrom: T0 + 5 * MINUTE,
        createdAt: T0,
      });
      // A schedule read before a pause does not resume it, and no put cancels one
      // behind the inbox's back: its pending deliveries stay pending only while it lives.
      await store.schedules.pause('tenant', 's', { expectedRevision: 2 });
      for (const status of ['active', 'cancelled'] as const) {
        const revision = (await store.schedules.get('tenant', 's'))!.revision;
        await store.schedules.put({ ...after, status } as DurableScheduleInput, {
          expectedRevision: revision,
          effectiveFrom: T0 + 5 * MINUTE,
        });
        const stored = (await store.schedules.get('tenant', 's'))!;
        expect(stored).toMatchObject({ status: 'paused', revision: revision + 1 });
        expect(stored.scanTo).toBeUndefined();
        expect(stored).not.toHaveProperty('note');
      }
      const dispositions = (await store.inbox.list({ scope: 'tenant', goalId: 'goal-1' })).entries;
      expect(dispositions.map((entry) => entry.disposition)).toEqual(['pending', 'pending']);
    });

    test('lists schedules by scope, goal and status, by schedule id, page by page', async () => {
      const { store } = await setup();
      for (const [id, scope, goalId] of [
        ['c', 'tenant', 'goal-1'],
        ['a', 'tenant', 'goal-2'],
        ['e', 'other', 'goal-x'],
        ['b', 'tenant', 'goal-1'],
        ['d', 'tenant', 'goal-1'],
      ] as const)
        await store.schedules.put(scheduleInput(id, { scope, goalId }), {
          expectedRevision: 0,
          effectiveFrom: T0,
        });
      await store.schedules.pause('tenant', 'd', { expectedRevision: 1 });
      const ids = async (query?: Parameters<GoalRuntimeStore['schedules']['list']>[0]) =>
        (await store.schedules.list(query)).schedules.map((s) => s.scheduleId);
      expect(await ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(await ids({ scope: 'tenant' })).toEqual(['a', 'b', 'c', 'd']);
      expect(await ids({ scope: 'tenant', goalId: 'goal-1' })).toEqual(['b', 'c', 'd']);
      expect(await ids({ statuses: ['active'] })).toEqual(['a', 'b', 'c', 'e']);
      expect(await ids({ statuses: ['paused'] })).toEqual(['d']);
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await store.schedules.list({ limit: 2, ...(cursor ? { cursor } : {}) });
        pages.push(page.schedules.map((s) => s.scheduleId));
        cursor = page.cursor;
      } while (cursor);
      expect(pages.flat()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(pages[0]).toEqual(['a', 'b']);
    });

    test('pauses, resumes and cancels at the expected revision; a cancel is final', async () => {
      const { store, time } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      expect(await store.schedules.pause('tenant', 's', { expectedRevision: 2 })).toEqual({
        status: 'conflict',
      });
      const paused = await store.schedules.pause('tenant', 's', { expectedRevision: 1 });
      expect(paused).toMatchObject({
        status: 'committed',
        schedule: { status: 'paused', revision: 2 },
      });
      await time.advance(MINUTE);
      const resumed = await store.schedules.resume('tenant', 's', {
        expectedRevision: 2,
        effectiveFrom: T0 + MINUTE,
      });
      expect(resumed).toMatchObject({
        status: 'committed',
        schedule: { status: 'active', revision: 3, effectiveFrom: T0 + MINUTE, scheduleCursor: T0 },
      });
      expect(await store.schedules.pause('other', 's', { expectedRevision: 3 })).toEqual({
        status: 'conflict',
      });
      const cancelled = await store.schedules.cancel('tenant', 's', { expectedRevision: 3 });
      expect(cancelled).toMatchObject({
        status: 'committed',
        schedule: { status: 'cancelled', revision: 4 },
      });
      expect(
        await store.schedules.resume('tenant', 's', { expectedRevision: 4, effectiveFrom: T0 }),
      ).toEqual({ status: 'conflict' });
      expect(await store.schedules.pause('tenant', 's', { expectedRevision: 4 })).toEqual({
        status: 'conflict',
      });
      expect((await store.schedules.get('tenant', 's'))?.status).toBe('cancelled');
    });

    test('moves the cursor and fills the inbox in one advance; the revision stays', async () => {
      const { store, time } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      await time.advance(3 * MINUTE);
      const first = await delivered('s', T0 + 2 * MINUTE);
      const result = await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 3 * MINUTE,
        scanTo: T0 + 9 * MINUTE,
        occurrences: [skipped('s', T0 + MINUTE), first, await delivered('s', T0 + 3 * MINUTE)],
      });
      expect(result).toMatchObject({
        status: 'advanced',
        enqueued: 2,
        duplicates: 0,
        schedule: {
          revision: 1,
          scheduleCursor: T0 + 3 * MINUTE,
          scanTo: T0 + 9 * MINUTE,
          updatedAt: T0 + 3 * MINUTE,
        },
      });
      const id = goalInboxKey('tenant', 'schedule:s', `s@${T0 + 2 * MINUTE}`);
      expect(await store.inbox.get('tenant', id)).toMatchObject({
        id,
        scope: 'tenant',
        goalId: 'goal-1',
        namespace: 'schedule:s',
        deliveryId: `s@${T0 + 2 * MINUTE}`,
        event: first.delivery!.event,
        digest: first.delivery!.digest,
        disposition: 'pending',
        enqueuedAt: T0 + 3 * MINUTE,
      });
      const page = await store.inbox.list({ scope: 'tenant', goalId: 'goal-1' });
      expect(page.entries.map((entry) => entry.deliveryId)).toEqual([
        `s@${T0 + 2 * MINUTE}`,
        `s@${T0 + 3 * MINUTE}`,
      ]);
      // Finishing the scan clears `scanTo`.
      const done = await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0 + 3 * MINUTE,
        toCursor: T0 + 9 * MINUTE,
        occurrences: [],
      });
      expect(done.status).toBe('advanced');
      const stored = await store.schedules.get('tenant', 's');
      expect(stored?.scheduleCursor).toBe(T0 + 9 * MINUTE);
      expect(stored?.scanTo).toBeUndefined();
      expect(stored?.revision).toBe(1);
    });

    test('refuses an advance from another cursor, revision or an inactive schedule, writing nothing', async () => {
      const { store } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      // The occurrences follow the overridden scope and schedule, so each request is
      // well formed and only its cursor, revision, scope or schedule is wrong.
      const step = async (overrides: Partial<ScheduleAdvance>) => {
        const scope = overrides.scope ?? 'tenant';
        const scheduleId = overrides.scheduleId ?? 's';
        return store.schedules.advance({
          scope,
          scheduleId,
          expectedRevision: 1,
          fromCursor: T0,
          toCursor: T0 + 2 * MINUTE,
          occurrences: [await delivered(scheduleId, T0 + MINUTE, { scope })],
          ...overrides,
        });
      };
      expect((await step({ fromCursor: T0 - 1 })).status).toBe('conflict');
      expect((await step({ expectedRevision: 2 })).status).toBe('conflict');
      expect((await step({ scope: 'other' })).status).toBe('conflict');
      expect((await step({ scheduleId: 'missing' })).status).toBe('conflict');
      await store.schedules.pause('tenant', 's', { expectedRevision: 1 });
      expect((await step({ expectedRevision: 2 })).status).toBe('conflict');
      expect((await store.inbox.list({ scope: 'tenant' })).entries).toEqual([]);
      expect(await store.pruneOccurrences({ before: T0 + 365 * 24 * 60 * MINUTE })).toBe(0);
      const stored = await store.schedules.get('tenant', 's');
      expect(stored).toMatchObject({ scheduleCursor: T0, revision: 2, status: 'paused' });
    });

    test('counts a delivery already in the inbox as a duplicate and leaves it as it was', async () => {
      const { store, time } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      const occurrence = await delivered('s', T0 + MINUTE);
      const queued = await store.inbox.enqueue(occurrence.delivery!);
      expect(queued.status).toBe('enqueued');
      await time.advance(MINUTE);
      const result = await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + MINUTE,
        occurrences: [occurrence],
      });
      expect(result).toMatchObject({ status: 'advanced', enqueued: 0, duplicates: 1 });
      expect(await store.inbox.get('tenant', queued.entry.id)).toEqual(queued.entry);
    });

    test('lets exactly one of two concurrent advances from the same cursor win', async () => {
      const { store } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      const advance = async (at: number) =>
        store.schedules.advance({
          scope: 'tenant',
          scheduleId: 's',
          expectedRevision: 1,
          fromCursor: T0,
          toCursor: at,
          occurrences: [await delivered('s', at)],
        });
      const [left, right] = await Promise.all([advance(T0 + MINUTE), advance(T0 + 2 * MINUTE)]);
      expect([left.status, right.status].sort()).toEqual(['advanced', 'conflict']);
      const winner = left.status === 'advanced' ? T0 + MINUTE : T0 + 2 * MINUTE;
      expect((await store.schedules.get('tenant', 's'))?.scheduleCursor).toBe(winner);
      const entries = (await store.inbox.list({ scope: 'tenant' })).entries;
      expect(entries.map((entry) => entry.deliveryId)).toEqual([`s@${winner}`]);
    });

    test('cancel ends the deliveries not yet applied and keeps the settled ones', async () => {
      const { store, time } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      await store.schedules.put(scheduleInput('t'), { expectedRevision: 0, effectiveFrom: T0 });
      const occurrences = [
        await delivered('s', T0 + MINUTE),
        await delivered('s', T0 + 2 * MINUTE),
      ];
      await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 2 * MINUTE,
        occurrences,
      });
      const other = await delivered('t', T0 + MINUTE);
      await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 't',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + MINUTE,
        occurrences: [other],
      });
      const [applied, pending] = occurrences.map((o) =>
        goalInboxKey('tenant', o.delivery!.namespace, o.delivery!.deliveryId),
      ) as [string, string];
      expect(
        await store.inbox.apply({
          scope: 'tenant',
          goalId: 'goal-1',
          entryId: applied,
          disposition: 'unmatched',
        }),
      ).toEqual({ status: 'committed' });
      await time.advance(MINUTE);
      const result = await store.schedules.cancel('tenant', 's', { expectedRevision: 1 });
      expect(result.status).toBe('committed');
      expect(await store.inbox.get('tenant', applied)).toMatchObject({
        disposition: 'unmatched',
        settledAt: T0,
      });
      expect(await store.inbox.get('tenant', pending)).toMatchObject({
        disposition: 'cancelled',
        settledAt: T0 + MINUTE,
      });
      // Another schedule's delivery to the same goal is untouched.
      const otherId = goalInboxKey('tenant', 'schedule:t', other.occurrenceId);
      expect((await store.inbox.get('tenant', otherId))?.disposition).toBe('pending');
    });

    test('queues a delivery once per entry id: duplicate with its digest, conflict with another', async () => {
      const { store, time } = await setup();
      const delivery = {
        ...(await occurrenceDelivery('hook', T0)),
        namespace: 'webhook:github',
        deliveryId: 'd-1',
        payload: { body: '{"action":"opened"}', mediaType: 'application/json' },
      };
      const queued = await store.inbox.enqueue(delivery);
      expect(queued).toMatchObject({
        status: 'enqueued',
        entry: {
          id: goalInboxKey('tenant', 'webhook:github', 'd-1'),
          disposition: 'pending',
          payload: delivery.payload,
          enqueuedAt: T0,
        },
      });
      await time.advance(MINUTE);
      const again = await store.inbox.enqueue({ ...delivery, payload: { body: 'retry body' } });
      expect(again).toEqual({ status: 'duplicate', entry: queued.entry });
      // The same entry id addressed (event and all) to another goal.
      const other = await store.inbox.enqueue({
        ...(await occurrenceDelivery('hook', T0, { goalId: 'goal-2' })),
        namespace: delivery.namespace,
        deliveryId: delivery.deliveryId,
        payload: delivery.payload,
        digest: await sha256Digest('another target'),
      });
      expect(other).toEqual({ status: 'conflict', entry: queued.entry });
      expect(await store.inbox.get('tenant', queued.entry.id)).toEqual(queued.entry);
      // The same delivery id in another namespace or scope is another entry.
      expect((await store.inbox.enqueue({ ...delivery, namespace: 'webhook:slack' })).status).toBe(
        'enqueued',
      );
      const elsewhere = await occurrenceDelivery('hook', T0, { scope: 'other', goalId: 'goal-x' });
      expect(
        (
          await store.inbox.enqueue({
            ...elsewhere,
            namespace: delivery.namespace,
            deliveryId: delivery.deliveryId,
            payload: delivery.payload,
          })
        ).status,
      ).toBe('enqueued');
    });

    test('reads inbox entries in their scope only; lists pending oldest first, due by notBefore, by page', async () => {
      const { store, time } = await setup();
      const ids: string[] = [];
      for (const [index, notBefore] of [T0 + 5 * MINUTE, T0 + MINUTE, undefined].entries()) {
        const base = await occurrenceDelivery('s', T0 + index * MINUTE);
        const event = { ...base.event };
        if (notBefore === undefined) delete event.notBefore;
        else event.notBefore = notBefore;
        ids.push((await store.inbox.enqueue({ ...base, event })).entry.id);
        await time.advance(1);
      }
      await store.inbox.enqueue(
        await occurrenceDelivery('s', T0, { scope: 'other', goalId: 'goal-x' }),
      );
      expect(await store.inbox.get('other', ids[0]!)).toBeUndefined();
      const listed = async (
        query: Omit<Parameters<GoalRuntimeStore['inbox']['list']>[0], 'scope'>,
      ) => (await store.inbox.list({ scope: 'tenant', ...query })).entries.map((entry) => entry.id);
      expect(await listed({})).toEqual(ids);
      expect(await listed({ dueBy: T0 + MINUTE })).toEqual([ids[1], ids[2]]);
      expect(await listed({ dueBy: T0 })).toEqual([ids[2]]);
      expect(await listed({ goalId: 'goal-2' })).toEqual([]);
      await store.inbox.apply({
        scope: 'tenant',
        goalId: 'goal-1',
        entryId: ids[1]!,
        disposition: 'stale',
      });
      expect(await listed({})).toEqual([ids[0], ids[2]]);
      expect(await listed({ dispositions: ['stale'] })).toEqual([ids[1]]);
      expect(await listed({ dispositions: ['pending', 'stale'] })).toEqual(ids);
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await store.inbox.list({
          scope: 'tenant',
          dispositions: ['pending', 'stale'],
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        pages.push(page.entries.map((entry) => entry.id));
        cursor = page.cursor;
      } while (cursor);
      expect(pages).toEqual([[ids[0], ids[1]], [ids[2]]]);
    });

    test('settles an entry once; another settle is refused', async () => {
      const { store } = await setup();
      const { entry } = await store.inbox.enqueue(await occurrenceDelivery('s', T0));
      const settle = () =>
        store.inbox.apply({
          scope: 'tenant',
          goalId: 'goal-1',
          entryId: entry.id,
          disposition: 'expired',
        });
      expect(await settle()).toEqual({ status: 'committed' });
      expect(await settle()).toMatchObject({ status: 'conflict', reason: 'entry-settled' });
      expect(await store.inbox.get('tenant', entry.id)).toMatchObject({
        disposition: 'expired',
        settledAt: T0,
      });
    });

    test('prunes occurrence records by age and scope', async () => {
      const { store, time } = await setup();
      await store.schedules.put(scheduleInput('s'), { expectedRevision: 0, effectiveFrom: T0 });
      await store.schedules.put(scheduleInput('s', { scope: 'other', goalId: 'goal-x' }), {
        expectedRevision: 0,
        effectiveFrom: T0,
      });
      await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 2 * MINUTE,
        occurrences: [skipped('s', T0 + MINUTE), await delivered('s', T0 + 2 * MINUTE)],
      });
      await time.advance(10 * MINUTE);
      await store.schedules.advance({
        scope: 'tenant',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0 + 2 * MINUTE,
        toCursor: T0 + 3 * MINUTE,
        occurrences: [skipped('s', T0 + 3 * MINUTE)],
      });
      await store.schedules.advance({
        scope: 'other',
        scheduleId: 's',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + MINUTE,
        occurrences: [{ ...skipped('s', T0 + MINUTE), scope: 'other', goalId: 'goal-x' }],
      });
      expect(await store.pruneOccurrences({ before: T0 + MINUTE, scope: 'tenant' })).toBe(2);
      expect(await store.pruneOccurrences({ before: T0 + MINUTE, scope: 'tenant' })).toBe(0);
      expect(await store.pruneOccurrences({ before: T0 + 11 * MINUTE })).toBe(2);
      // Records are only history: the delivered entry stays in the inbox.
      expect((await store.inbox.list({ scope: 'tenant' })).entries).toHaveLength(1);
    });

    test('prunes settled payloads to tombstones and keeps their ids, so dedupe holds', async () => {
      const { store, time } = await setup();
      const delivery = {
        ...(await occurrenceDelivery('hook', T0)),
        namespace: 'webhook:x',
        deliveryId: 'd-9',
        payload: { body: 'secret payload', mediaType: 'text/plain' },
      };
      const { entry } = await store.inbox.enqueue(delivery);
      const pendingOne = await store.inbox.enqueue({ ...delivery, deliveryId: 'd-10' });
      await store.inbox.apply({
        scope: 'tenant',
        goalId: 'goal-1',
        entryId: entry.id,
        disposition: 'applied',
      });
      await time.advance(MINUTE);
      expect(await store.prunePayloads({ before: T0 })).toBe(0);
      expect(await store.prunePayloads({ before: T0 + MINUTE })).toBe(1);
      const tombstone = await store.inbox.get('tenant', entry.id);
      expect(tombstone).toMatchObject({
        id: entry.id,
        disposition: 'applied',
        payloadPruned: true,
      });
      expect(tombstone?.payload).toBeUndefined();
      expect((await store.inbox.get('tenant', pendingOne.entry.id))?.payload).toEqual(
        delivery.payload,
      );
      expect((await store.inbox.enqueue(delivery)).status).toBe('duplicate');
    });
  });
}
