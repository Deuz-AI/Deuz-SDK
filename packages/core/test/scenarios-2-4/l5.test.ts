/**
 * Lane L5 acceptance scenarios (new.txt §5.1, "Scheduler/inbox": DST gap, DST
 * repeat, backlog, atomic cursor, dedupe, verified target). Every scenario
 * builds its own store, clock and scheduler; the store is the real in-memory
 * `GoalRuntimeStore` once lane L4a has landed it, the L5 double until then.
 */
import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import { createGoal, transitionGoal } from '../../src/goal';
import { settleGoalEvent } from '../../src/goal/runtime/delivery';
import { createDurableScheduler } from '../../src/goal/runtime/scheduler';
import type { DurableScheduler } from '../../src/goal/runtime/scheduler';
import { goalInboxKey } from '../../src/goal/runtime/store';
import type { GoalRuntimeStore } from '../../src/goal/runtime/store-types';
import { createWebhookHandler } from '../../src/goal/runtime/webhook';
import { occurrencesBetween } from '../../src/schedule/cron';
import {
  SimulatedCrash,
  makeGoalRuntimeStore,
  withStoreFaults,
  type StoreFault,
} from '../fixtures/goal-runtime-double';
import { scenario } from './registry';

const MINUTE = 60_000;
const at = (iso: string): number => Date.parse(iso);

/** A clock that moves only when told; ticks are driven by hand. */
function steppedClock(start: number) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    set: (iso: string) => {
      now = at(iso);
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function world(start: string, goals: [goalId: string, scope: string][] = []) {
  const time = steppedClock(at(start));
  const store = makeGoalRuntimeStore({ clock: time.clock });
  for (const [goalId, scope] of [['goal-1', 'tenant'], ...goals] as const)
    await store.save(createGoal({ goalId, scope, objective: `Do ${goalId}.` }, { now: at(start) }));
  return { time, store };
}

/** Every inbox entry of a scope (any disposition), oldest first. */
async function entries(store: GoalRuntimeStore, scope = 'tenant') {
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await store.inbox.list({
      scope,
      dispositions: [
        'pending',
        'applied',
        'duplicate',
        'unmatched',
        'stale',
        'expired',
        'terminal',
        'cancelled',
      ],
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.entries);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

const delivered = (result: Awaited<ReturnType<DurableScheduler['tick']>>) =>
  result.occurrences.filter((o) => o.disposition === 'delivered').map((o) => o.at);

scenario('scheduler', 'dst-gap-shift', async () => {
  // America/New_York skips 02:00-03:00 on 2026-03-08. A daily 02:30 job still
  // runs that day, once, at 03:00 EDT; with dstGap 'skip' it does not.
  const { time, store } = await world('2026-03-07T12:00:00Z');
  const scheduler = createDurableScheduler({ store, deps: { clock: time.clock } });
  const spec = { cron: '30 2 * * *', timezone: 'America/New_York' };
  await scheduler.put({ scheduleId: 'shift', scope: 'tenant', goalId: 'goal-1', spec });
  await scheduler.put({
    scheduleId: 'skip',
    scope: 'tenant',
    goalId: 'goal-1',
    spec: { ...spec, dstGap: 'skip' },
  });
  const runs: Record<string, number[]> = { shift: [], skip: [] };
  for (const iso of [
    '2026-03-08T06:59:30Z',
    '2026-03-08T07:00:30Z',
    '2026-03-08T07:31:00Z',
    '2026-03-09T06:30:30Z',
  ]) {
    time.set(iso);
    for (const o of (await scheduler.tick()).occurrences)
      if (o.disposition === 'delivered') runs[o.scheduleId]!.push(o.at);
  }
  expect(runs.shift).toEqual([at('2026-03-08T07:00:00Z'), at('2026-03-09T06:30:00Z')]);
  expect(runs.skip).toEqual([at('2026-03-09T06:30:00Z')]);
  // The shifted run is one inbox entry, dated at the instant it ran.
  const id = goalInboxKey('tenant', 'schedule:shift', `shift@${at('2026-03-08T07:00:00Z')}`);
  const entry = await store.inbox.get('tenant', id);
  expect(entry?.event).toMatchObject({
    at: at('2026-03-08T07:00:00Z'),
    notBefore: at('2026-03-08T07:00:00Z'),
  });
});

scenario('scheduler', 'dst-overlap-first', async () => {
  // America/New_York repeats 01:00-02:00 on 2026-11-01. A daily 01:30 job runs
  // once (dstOverlap 'first'); 'both' delivers both instants under distinct ids.
  const { time, store } = await world('2026-10-31T12:00:00Z');
  const scheduler = createDurableScheduler({ store, deps: { clock: time.clock } });
  const spec = { cron: '30 1 * * *', timezone: 'America/New_York' };
  await scheduler.put({ scheduleId: 'first', scope: 'tenant', goalId: 'goal-1', spec });
  await scheduler.put({
    scheduleId: 'both',
    scope: 'tenant',
    goalId: 'goal-1',
    spec: { ...spec, dstOverlap: 'both' },
  });
  const runs: Record<string, string[]> = { first: [], both: [] };
  for (const iso of ['2026-11-01T05:30:30Z', '2026-11-01T06:30:30Z', '2026-11-02T06:30:30Z']) {
    time.set(iso);
    for (const o of (await scheduler.tick()).occurrences)
      if (o.disposition === 'delivered') runs[o.scheduleId]!.push(o.occurrenceId);
  }
  expect(runs.first).toEqual([
    `first@${at('2026-11-01T05:30:00Z')}`,
    `first@${at('2026-11-02T06:30:00Z')}`,
  ]);
  expect(runs.both).toEqual([
    `both@${at('2026-11-01T05:30:00Z')}`,
    `both@${at('2026-11-01T06:30:00Z')}`,
    `both@${at('2026-11-02T06:30:00Z')}`,
  ]);
  const ids = (await entries(store)).map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(5);
});

scenario(
  'scheduler',
  'backlog-cursor',
  async () => {
    // 250 missed minutes under catchUp 'all': the scheduler crashes twice
    // mid-backlog (once after a commit it never saw, once before one), is
    // restarted on the same store, and finishes from the persistent cursor.
    const { time, store } = await world('2026-10-10T10:00:00Z');
    const t0 = time.clock.now();
    const faults: StoreFault[] = [undefined, 'after', undefined, 'before'];
    const crashing = createDurableScheduler({
      store: withStoreFaults(store, { advance: (call) => faults[call - 1] }),
      deps: { clock: time.clock },
      maxDeliveriesPerTick: 40,
    });
    await crashing.put({
      scheduleId: 'every-minute',
      scope: 'tenant',
      goalId: 'goal-1',
      spec: { cron: '* * * * *', catchUp: 'all' },
    });
    time.advance(250 * MINUTE);
    const crashes: unknown[] = [];
    for (let attempt = 0; attempt < 4; attempt++)
      crashes.push(...(await crashing.tick()).errors.map((failure) => failure.error));
    expect(crashes).toHaveLength(2);
    for (const crash of crashes) expect(crash).toBeInstanceOf(SimulatedCrash);

    const restarted = createDurableScheduler({ store, deps: { clock: time.clock } });
    let result = await restarted.tick();
    for (let guard = 0; result.backlog > 0 && guard < 10; guard++) result = await restarted.tick();
    expect(result.backlog).toBe(0);
    const expected = occurrencesBetween('* * * * *', t0, t0 + 250 * MINUTE).map(
      (ms) => `every-minute@${ms}`,
    );
    const inbox = (await entries(store)).map((entry) => entry.deliveryId);
    expect(inbox).toEqual(expected);
    expect(await store.schedules.get('tenant', 'every-minute')).toMatchObject({
      scheduleCursor: t0 + 250 * MINUTE,
    });

    // 'latest' over a window longer than one tick's scan, with a crash in
    // the middle: still exactly one delivery, the newest, after the window.
    await restarted.pause('tenant', 'every-minute');
    const latest = createDurableScheduler({
      store: withStoreFaults(store, { advance: (call) => (call === 2 ? 'before' : undefined) }),
      deps: { clock: time.clock },
      maxScanMinutes: 60,
    });
    await latest.put({
      scheduleId: 'latest',
      scope: 'tenant',
      goalId: 'goal-1',
      spec: { cron: '*/10 * * * *' },
    });
    time.advance(5 * 60 * MINUTE);
    const end = time.clock.now();
    const deliveries: number[] = [];
    for (let tick = 0; tick < 8; tick++) deliveries.push(...delivered(await latest.tick()));
    expect(deliveries).toEqual([end]);
    const latestInbox = (await entries(store)).filter(
      (entry) => entry.namespace === 'schedule:latest',
    );
    expect(latestInbox.map((entry) => entry.event.at)).toEqual([end]);
  },
  { fault: true, timeout: 30_000 },
);

scenario(
  'scheduler',
  'atomic-cursor-inbox',
  async () => {
    // The cursor never moves without its deliveries, nor the deliveries
    // without the cursor: a crash before a commit leaves both as they were,
    // one after it leaves both moved; racing schedulers deliver each
    // occurrence once; cancel ends the deliveries not yet applied.
    const { time, store } = await world('2026-10-10T10:00:00Z');
    const t0 = time.clock.now();
    const snapshot = async () => ({
      cursor: (await store.schedules.get('tenant', 's'))?.scheduleCursor,
      inbox: (await entries(store)).map((entry) => entry.deliveryId),
    });
    let fault: StoreFault;
    const scheduler = createDurableScheduler({
      store: withStoreFaults(store, { advance: () => fault }),
      deps: { clock: time.clock },
    });
    await scheduler.put({
      scheduleId: 's',
      scope: 'tenant',
      goalId: 'goal-1',
      spec: { cron: '*/5 * * * *', catchUp: 'all' },
    });
    time.advance(10 * MINUTE);
    const before = await snapshot();
    fault = 'before';
    expect((await scheduler.tick()).errors).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    fault = 'after';
    expect((await scheduler.tick()).errors).toHaveLength(1);
    const moved = await snapshot();
    expect(moved.cursor).toBe(t0 + 10 * MINUTE);
    expect(moved.inbox).toEqual([`s@${t0 + 5 * MINUTE}`, `s@${t0 + 10 * MINUTE}`]);
    fault = undefined;
    expect((await scheduler.tick()).occurrences).toEqual([]);

    const rival = createDurableScheduler({ store, deps: { clock: time.clock } });
    for (let round = 0; round < 6; round++) {
      time.advance(5 * MINUTE);
      await Promise.all([scheduler.tick(), rival.tick()]);
      const { cursor, inbox } = await snapshot();
      // Exactly the occurrences up to the cursor are in the inbox, each once.
      expect(inbox).toEqual(occurrencesBetween('*/5 * * * *', t0, cursor!).map((ms) => `s@${ms}`));
    }

    const settled = (await entries(store))[0]!;
    const goal = (await store.load('goal-1', { scope: 'tenant' }))!;
    const settlement = settleGoalEvent(goal, settled, { now: time.clock.now() });
    expect(settlement.disposition).toBe('unmatched');
    if (settlement.disposition !== 'pending')
      expect(await store.inbox.apply(settlement.application)).toEqual({ status: 'committed' });
    await scheduler.cancel('tenant', 's');
    const after = await entries(store);
    expect(after[0]?.disposition).toBe('unmatched');
    expect(after.slice(1).map((entry) => entry.disposition)).toEqual(
      Array(after.length - 1).fill('cancelled'),
    );
  },
  { fault: true, timeout: 30_000 },
);

const secret = 'webhook secret';
const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const hook = (body: string, deliveryId = 'd-1', signature = sign(body)) =>
  new Request('https://app.example.com/hooks/github', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
    },
  });

scenario('scheduler', 'webhook-dedupe-conflict', async () => {
  const { time, store } = await world('2026-10-10T10:00:00Z', [
    ['goal-2', 'tenant'],
    ['goal-9', 'other'],
  ]);
  let route = { scope: 'tenant', goalId: 'goal-1' };
  const handler = (namespace: string) =>
    createWebhookHandler({
      store,
      verify: { kind: 'github', secret },
      target: () => route,
      namespace,
      deps: { clock: time.clock },
    });
  const github = handler('webhook:github:acme');
  const body = '{"action":"opened"}';
  expect((await github(hook(body))).status).toBe(202);
  const [first] = await entries(store);
  time.advance(30_000);
  // A retry of the same delivery: 200, nothing new.
  expect((await github(hook(body))).status).toBe(200);
  // The same delivery id with another payload, or for another goal: 409, nothing recorded.
  const conflict = await github(hook('{"action":"closed"}'));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ ok: false, reason: 'delivery_conflict' });
  route = { scope: 'tenant', goalId: 'goal-2' };
  expect((await github(hook(body))).status).toBe(409);
  expect(await entries(store)).toEqual([first]);
  // Dedupe is per scope and namespace: another account, or another scope, is another delivery.
  route = { scope: 'tenant', goalId: 'goal-1' };
  expect((await handler('webhook:github:globex')(hook(body))).status).toBe(202);
  route = { scope: 'other', goalId: 'goal-9' };
  expect((await github(hook(body))).status).toBe(202);
  expect((await entries(store)).map((entry) => entry.namespace)).toEqual([
    'webhook:github:acme',
    'webhook:github:globex',
  ]);
  expect((await entries(store, 'other')).map((entry) => entry.id)).toEqual([
    goalInboxKey('other', 'webhook:github:acme', 'd-1'),
  ]);
});

scenario('scheduler', 'verified-target-only', async () => {
  // The scope and goal come from host configuration only: an unverified
  // request writes nothing, a body naming another goal changes nothing, and
  // the queued event answers the goal's wait when it is settled.
  const { time, store } = await world('2026-10-10T10:00:00Z', [
    ['goal-2', 'tenant'],
    ['goal-9', 'other'],
  ]);
  const waiting = transitionGoal(
    (await store.load('goal-1'))!,
    { type: 'wait', wait: { reason: 'event', source: { type: 'signal', id: 'webhook:github' } } },
    { now: time.clock.now() },
  ).record;
  await store.save(waiting);
  time.advance(1_000);
  const handler = createWebhookHandler({
    store,
    verify: { kind: 'github', secret },
    target: { scope: 'tenant', goalId: 'goal-1' },
    namespace: 'webhook:github',
    deps: { clock: time.clock },
  });
  const redirect = '{"scope":"other","goalId":"goal-9","action":"opened"}';
  expect((await handler(hook(redirect, 'd-1', sign('{}')))).status).toBe(401);
  expect((await handler(hook(redirect, 'd-1', 'sha256=00'))).status).toBe(401);
  expect([...(await entries(store)), ...(await entries(store, 'other'))]).toEqual([]);

  expect((await handler(hook(redirect))).status).toBe(202);
  expect(await entries(store, 'other')).toEqual([]);
  const [entry] = await entries(store);
  expect(entry).toMatchObject({ scope: 'tenant', goalId: 'goal-1' });
  expect(entry?.event).toMatchObject({ scope: 'tenant', goalId: 'goal-1' });

  // A configured goal outside its scope is no target at all.
  const elsewhere = createWebhookHandler({
    store,
    verify: { kind: 'github', secret },
    target: { scope: 'tenant', goalId: 'goal-9' },
    namespace: 'webhook:github',
    deps: { clock: time.clock },
  });
  expect((await elsewhere(hook('{}', 'd-2'))).status).toBe(404);

  const goal = (await store.load('goal-1', { scope: 'tenant' }))!;
  const settlement = settleGoalEvent(goal, entry!, { now: time.clock.now() });
  expect(settlement.disposition).toBe('applied');
  if (settlement.disposition === 'pending') throw new Error('unreachable');
  expect(await store.inbox.apply(settlement.application)).toEqual({ status: 'committed' });
  expect((await store.load('goal-1'))?.status).toBe('active');
});
