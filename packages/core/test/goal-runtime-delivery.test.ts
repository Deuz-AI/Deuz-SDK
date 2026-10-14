/**
 * Inbox event semantics (2.4, spec §3.2 "Olay semantiği"): the digest that
 * tells a duplicate delivery from a conflicting one, how an entry settles
 * (an early event stays pending; unmatched, stale, expired and terminal
 * outcomes are explicit dispositions; an old event is never re-dated onto a
 * later wait), and dependency waits reconciled with the current completion
 * state.
 */
import { describe, expect, it } from 'vitest';
import { createGoal, createGoalEvent, goalEventFromOccurrence, transitionGoal } from '../src/goal';
import type { GoalEvent, GoalRecord, GoalWaitRequest } from '../src/goal';
import {
  goalDeliveryDigest,
  goalDependencyEvents,
  settleGoalEvent,
} from '../src/goal/runtime/delivery';
import { isSha256Digest } from '../src/internal/digest';
import { createScheduleStoreDouble } from './fixtures/goal-runtime-double';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const target = { scope: 'tenant', goalId: 'g' };

function goal(goalId = 'g', scope = 'tenant'): GoalRecord {
  return createGoal({ goalId, scope, objective: `Finish ${goalId}.` }, { now: T0 });
}

function waiting(wait: GoalWaitRequest, at = T0 + 1, record = goal()): GoalRecord {
  return transitionGoal(record, { type: 'wait', wait }, { now: at }).record;
}

function signal(extra: Partial<GoalEvent> = {}): GoalEvent {
  return createGoalEvent({
    ...target,
    source: { type: 'signal', id: 'webhook:github' },
    key: 'd-1',
    at: T0 + 10,
    ...extra,
  });
}

const entry = (event: GoalEvent) => ({
  id: 'inbox:1',
  scope: event.scope,
  goalId: event.goalId,
  event,
});

describe('goalDeliveryDigest', () => {
  it('covers the target, the event and the payload, but not the event times', async () => {
    const base = {
      ...target,
      event: signal(),
      payload: { body: '{"a":1}', mediaType: 'application/json' },
    };
    const digest = await goalDeliveryDigest(base);
    expect(isSha256Digest(digest)).toBe(true);
    // A sender's retry arrives later: the same delivery.
    expect(
      await goalDeliveryDigest({
        ...base,
        event: signal({ at: T0 + 99, notBefore: T0 + 99, expiresAt: T0 + 999 }),
      }),
    ).toBe(digest);
    for (const other of [
      { ...base, payload: { body: '{"a":2}', mediaType: 'application/json' } },
      { ...base, payload: { body: '{"a":1}', mediaType: 'text/plain' } },
      { ...base, payload: undefined },
      { ...base, goalId: 'h', event: signal({ goalId: 'h' }) },
      { ...base, scope: 'other', event: signal({ scope: 'other' }) },
      { ...base, event: signal({ correlationId: 'w-2' }) },
      { ...base, event: signal({ source: { type: 'signal', id: 'webhook:slack' } }) },
    ])
      expect(await goalDeliveryDigest(other)).not.toBe(digest);
  });
});

describe('settleGoalEvent', () => {
  it('applies a matching event, with the goal to save', () => {
    const record = waiting({ reason: 'event', source: { type: 'signal' } });
    const settled = settleGoalEvent(record, entry(signal()), { now: T0 + 20 });
    expect(settled.disposition).toBe('applied');
    if (settled.disposition === 'pending') throw new Error('unreachable');
    expect(settled.goal).toMatchObject({ status: 'active', revision: record.revision + 1 });
    expect(settled.application).toEqual({
      scope: 'tenant',
      goalId: 'g',
      entryId: 'inbox:1',
      disposition: 'applied',
      goal: settled.goal,
    });
    // The same event again: the goal already applied its key.
    const again = settleGoalEvent(settled.goal!, entry(signal()), { now: T0 + 21 });
    expect(again).toMatchObject({
      disposition: 'duplicate',
      application: { disposition: 'duplicate' },
    });
    expect(again.disposition !== 'pending' && again.goal).toBeUndefined();
  });

  it('records unmatched, stale, expired and terminal outcomes as explicit dispositions', () => {
    const now = { now: T0 + 20 };
    expect(settleGoalEvent(goal(), entry(signal()), now).disposition).toBe('unmatched');
    const waitingForEvent = waiting({ reason: 'event', source: { type: 'signal' } });
    expect(
      settleGoalEvent(waitingForEvent, entry(signal({ correlationId: 'an-older-wait' })), now)
        .disposition,
    ).toBe('stale');
    expect(
      settleGoalEvent(waitingForEvent, entry(signal({ expiresAt: T0 + 15 })), now).disposition,
    ).toBe('expired');
    const cancelled = transitionGoal(goal(), { type: 'cancel' }, { now: T0 + 1 }).record;
    const terminal = settleGoalEvent(cancelled, entry(signal()), now);
    expect(terminal).toMatchObject({
      disposition: 'terminal',
      application: { entryId: 'inbox:1', disposition: 'terminal' },
    });
  });

  it('leaves an event that is early for its notBefore pending, to try again then', () => {
    const record = waiting({ reason: 'event', source: { type: 'signal' } });
    const settled = settleGoalEvent(record, entry(signal({ notBefore: T0 + 50 })), {
      now: T0 + 20,
    });
    expect(settled).toMatchObject({ disposition: 'pending', retryAt: T0 + 50 });
    expect('application' in settled).toBe(false);
    expect(
      settleGoalEvent(record, entry(signal({ notBefore: T0 + 50 })), { now: T0 + 50 }).disposition,
    ).toBe('applied');
  });

  it('never re-dates an old occurrence onto a wait that began after it', () => {
    const occurrence = goalEventFromOccurrence(
      { id: 'nightly', at: T0 + 5, key: `nightly@${T0 + 5}` },
      target,
    );
    // Delivered late (catch-up), to a wakeup wait that opened after the occurrence.
    const later = waiting({ reason: 'wakeup', at: T0 + 5, schedule: 'nightly' }, T0 + 6);
    expect(settleGoalEvent(later, entry(occurrence), { now: T0 + 1_000 }).disposition).toBe(
      'stale',
    );
    // The wait it was meant for takes it.
    const meant = waiting({ reason: 'wakeup', at: T0 + 5, schedule: 'nightly' }, T0 + 2);
    expect(settleGoalEvent(meant, entry(occurrence), { now: T0 + 1_000 }).disposition).toBe(
      'applied',
    );
  });

  it('settles a goal whose deadline passed as terminal, with the failed goal to save', () => {
    const record = createGoal({ ...target, objective: 'Soon.', deadline: T0 + 15 }, { now: T0 });
    const settled = settleGoalEvent(record, entry(signal()), { now: T0 + 20 });
    expect(settled.disposition).toBe('terminal');
    if (settled.disposition === 'pending') throw new Error('unreachable');
    expect(settled.goal).toMatchObject({ status: 'failed', outcome: { reason: 'deadline' } });
    expect(settled.application.goal).toEqual(settled.goal);
  });
});

describe('goalDependencyEvents', () => {
  async function setup() {
    const store = createScheduleStoreDouble();
    for (const id of ['a', 'b']) await store.save(goal(id));
    await store.save(goal('elsewhere', 'other'));
    return store;
  }

  it('reports dependencies that already finished, even before the wait began', async () => {
    const store = await setup();
    const a = goal('a');
    await store.save(transitionGoal(a, { type: 'cancel' }, { now: T0 + 1 }).record);
    const record = waiting(
      {
        reason: 'dependency',
        on: [
          { kind: 'goal', id: 'a' },
          { kind: 'goal', id: 'b' },
        ],
      },
      T0 + 5,
    );
    const events = await goalDependencyEvents(record, { now: T0 + 10, goals: store });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'tenant',
      goalId: 'g',
      source: { type: 'goal', id: 'a' },
      correlationId: record.waiting!.id,
      at: T0 + 10,
    });
    // A completion is a state: the goal takes it although `a` ended before the wait.
    const settled = settleGoalEvent(record, entry(events[0]!), { now: T0 + 10 });
    expect(settled.disposition).toBe('applied');
    if (settled.disposition === 'pending') throw new Error('unreachable');
    const after = settled.goal!;
    expect(after.status).toBe('waiting');
    expect(after.waiting).toMatchObject({ on: [{ id: 'a', settled: true }, { id: 'b' }] });
    // Reconciling again reports nothing new for `a`; once `b` ends, its event ends the wait.
    expect(await goalDependencyEvents(after, { now: T0 + 11, goals: store })).toEqual([]);
    const b = (await store.load('b'))!;
    await store.save(transitionGoal(b, { type: 'cancel' }, { now: T0 + 12 }).record);
    const [last] = await goalDependencyEvents(after, { now: T0 + 13, goals: store });
    const done = settleGoalEvent(after, entry(last!), { now: T0 + 13 });
    expect(done.disposition !== 'pending' && done.goal?.status).toBe('active');
  });

  it('keys an event by dependency and wait, so a repeated reconcile is a duplicate', async () => {
    const store = await setup();
    await store.save(transitionGoal(goal('a'), { type: 'cancel' }, { now: T0 + 1 }).record);
    const record = waiting({
      reason: 'dependency',
      on: [
        { kind: 'goal', id: 'a' },
        { kind: 'goal', id: 'b' },
      ],
    });
    const [first] = await goalDependencyEvents(record, { now: T0 + 10, goals: store });
    const [second] = await goalDependencyEvents(record, { now: T0 + 30, goals: store });
    expect(second!.key).toBe(first!.key);
    expect(await goalDeliveryDigest({ ...target, event: second! })).toBe(
      await goalDeliveryDigest({ ...target, event: first! }),
    );
    const applied = settleGoalEvent(record, entry(first!), { now: T0 + 10 });
    if (applied.disposition === 'pending') throw new Error('unreachable');
    expect(settleGoalEvent(applied.goal!, entry(second!), { now: T0 + 30 }).disposition).toBe(
      'duplicate',
    );
  });

  it('reads goals only in the waiting goal scope, and runs only through the host', async () => {
    const store = await setup();
    await store.save(
      transitionGoal(goal('elsewhere', 'other'), { type: 'cancel' }, { now: T0 + 1 }).record,
    );
    const record = waiting({
      reason: 'dependency',
      on: [
        { kind: 'goal', id: 'elsewhere' },
        { kind: 'run', id: 'run-1' },
        { kind: 'run', id: 'run-2' },
      ],
    });
    expect(await goalDependencyEvents(record, { now: T0 + 10, goals: store })).toEqual([]);
    const events = await goalDependencyEvents(record, {
      now: T0 + 10,
      goals: store,
      runFinished: async (runId) => runId === 'run-2',
    });
    expect(events.map((event) => event.source)).toEqual([{ type: 'run', id: 'run-2' }]);
  });

  it('reports nothing for a goal that waits for something else, or for nothing', async () => {
    const store = await setup();
    expect(await goalDependencyEvents(goal(), { now: T0, goals: store })).toEqual([]);
    expect(
      await goalDependencyEvents(waiting({ reason: 'user' }), { now: T0, goals: store }),
    ).toEqual([]);
  });
});
