/**
 * goal-events.test.ts (2.3, 23.6) — the wakeup/event envelope: its keys are
 * the schedule occurrence keys and the signal keys that `createScheduler` and
 * `handleSignal` produce, an invalid envelope is refused, and a goal says why
 * it drops a duplicate, stale, expired, early or unmatched event.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GOAL_EVENT_VERSION,
  GoalError,
  createGoal,
  createGoalEvent,
  goalEventFromOccurrence,
  goalEventFromSignal,
  goalWakeupEvent,
  goalWakeupKey,
  parseGoalEvent,
  serializeGoalEvent,
  transitionGoal,
} from '../src/goal';
import type { GoalEvent, GoalRecord, GoalWaitRequest } from '../src/goal';
import { createScheduler } from '../src/schedule/scheduler';
import { handleSignal } from '../src/schedule/signal';
import type { ScheduleOccurrence } from '../src/schedule/scheduler';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const target = { scope: 'tenant', goalId: 'g' };

function waiting(wait: GoalWaitRequest, at = T0 + 1): GoalRecord {
  const goal = createGoal({ ...target, objective: 'Ship it.' }, { now: T0 });
  return transitionGoal(goal, { type: 'wait', wait }, { now: at }).record;
}

function event(extra: Partial<GoalEvent> = {}): GoalEvent {
  return createGoalEvent({
    ...target,
    source: { type: 'user', id: 'ada' },
    key: 'answer-1',
    at: T0 + 10,
    ...extra,
  });
}

const apply = (record: GoalRecord, value: GoalEvent, now = T0 + 20) =>
  transitionGoal(record, { type: 'event', event: value }, { now });

describe('goal event envelope', () => {
  it('builds an event from a schedule occurrence, keyed by the occurrence key', async () => {
    const occurrences: ScheduleOccurrence[] = [];
    const scheduler = createScheduler({
      schedules: [{ id: 'nightly', cron: '0 2 * * *', run: (o) => void occurrences.push(o) }],
    });
    await scheduler.tick(Date.parse('2026-10-10T02:00:30Z'));
    const occurrence = occurrences[0]!;
    expect(goalEventFromOccurrence(occurrence, { ...target, runId: 'r1' })).toEqual({
      kind: 'deuz-goal-event',
      version: GOAL_EVENT_VERSION,
      id: occurrence.key,
      key: occurrence.key,
      source: { type: 'schedule', id: 'nightly' },
      scope: 'tenant',
      goalId: 'g',
      runId: 'r1',
      at: occurrence.at,
      notBefore: occurrence.at,
    });
    expect(occurrence.key).toBe(`nightly@${Date.parse('2026-10-10T02:00:00Z')}`);
  });

  it('builds an event from a verified signal, keyed by the signal key', async () => {
    const built: GoalEvent[] = [];
    const deliver = (body: string, headers: Record<string, string> = {}) =>
      handleSignal(new Request('https://example.com/hooks/ci', { method: 'POST', body, headers }), {
        verify: async (request) => ({ ok: true, body: await request.text() }),
        key: ({ request }) => request.headers.get('x-delivery') ?? undefined,
        dispatch: ({ key }) =>
          void built.push(
            goalEventFromSignal(
              { key },
              {
                ...target,
                name: 'ci',
                at: T0 + 5,
                payload: { ref: `blob://ci/${key}`, mediaType: 'application/json' },
                correlationId: 'g#2',
              },
            ),
          ),
      });
    expect((await deliver('{"ok":true}', { 'x-delivery': 'd-1' })).status).toBe(202);
    expect((await deliver('{"ok":true}')).status).toBe(202);
    expect(built[0]).toMatchObject({
      id: 'd-1',
      key: 'd-1',
      source: { type: 'signal', id: 'ci' },
      at: T0 + 5,
      correlationId: 'g#2',
    });
    // Without a delivery ID the key is handleSignal's: the SHA-256 of the body.
    expect(built[1]!.key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('builds the event that ends a wakeup wait, keyed like an occurrence', () => {
    const goal = waiting({ reason: 'wakeup', at: T0 + 60_000 });
    const wakeup = goalWakeupEvent(goal);
    expect(wakeup).toEqual({
      kind: 'deuz-goal-event',
      version: 1,
      id: `goal:g@${T0 + 60_000}`,
      key: goalWakeupKey('g', T0 + 60_000),
      source: { type: 'wakeup' },
      scope: 'tenant',
      goalId: 'g',
      at: T0 + 60_000,
      notBefore: T0 + 60_000,
      correlationId: 'g#2',
    });
    expect(goalWakeupKey('g', T0)).toBe(`goal:g@${T0}`);
    expect(() => goalWakeupEvent(waiting({ reason: 'user' }))).toThrow(GoalError);
  });

  it('round-trips the version 1 envelope 2.3 wrote and refuses a newer one', () => {
    const text = readFileSync(new URL('./fixtures/goal-event-v1.json', import.meta.url), 'utf8');
    const loaded = parseGoalEvent(text);
    expect(loaded).toEqual(JSON.parse(text));
    expect(JSON.parse(serializeGoalEvent(loaded))).toEqual(JSON.parse(text));
    expect(() => parseGoalEvent({ ...loaded, version: 2 })).toThrow(
      expect.objectContaining({ code: 'unsupported_version' }) as unknown as Error,
    );
  });

  it('refuses an invalid envelope', () => {
    const valid = event();
    const invalid: unknown[] = [
      { ...valid, kind: 'deuz-goal' },
      { ...valid, key: '' },
      { ...valid, id: 7 },
      { ...valid, goalId: '' },
      { ...valid, scope: undefined },
      { ...valid, source: { type: 'mail' } },
      { ...valid, source: { type: 'user', id: '' } },
      { ...valid, at: Number.NaN },
      { ...valid, notBefore: T0 + 100, expiresAt: T0 + 100 },
      { ...valid, expiresAt: Number.POSITIVE_INFINITY },
      { ...valid, payload: { digest: 'sha256:00' } },
      { ...valid, payload: { ref: 'blob://x', bytes: -1 } },
      { ...valid, correlationId: '' },
    ];
    for (const value of invalid) {
      expect(() => parseGoalEvent(value), JSON.stringify(value)).toThrow(
        expect.objectContaining({ code: 'invalid_event' }) as unknown as Error,
      );
      expect(() => apply(waiting({ reason: 'user' }), value as GoalEvent)).toThrow(
        expect.objectContaining({ code: 'invalid_event' }) as unknown as Error,
      );
    }
  });
});

describe('applying events', () => {
  it('ends a wait it answers, and remembers its key', () => {
    const goal = waiting({ reason: 'user' });
    const answered = apply(goal, event({ correlationId: 'g#2' }));
    expect(answered).toMatchObject({ changed: true, outcome: 'applied' });
    expect(answered.record).toMatchObject({ status: 'active', seen: ['answer-1'], revision: 3 });
  });

  it('drops a duplicate: the same key again, even under a new wait', () => {
    const goal = waiting({ reason: 'user' });
    const first = apply(goal, event());
    const again = transitionGoal(
      first.record,
      { type: 'wait', wait: { reason: 'user' } },
      { now: T0 + 30 },
    ).record;
    expect(apply(again, event({ at: T0 + 40 }), T0 + 50)).toMatchObject({
      changed: false,
      outcome: 'ignored',
      reason: 'duplicate',
    });
  });

  it('drops a stale event: one answering an earlier wait, or older than the wait', () => {
    const first = waiting({ reason: 'user' });
    const answered = apply(first, event({ key: 'a1', correlationId: 'g#2' })).record;
    const second = transitionGoal(
      answered,
      { type: 'wait', wait: { reason: 'user' } },
      { now: T0 + 30 },
    ).record;
    expect(second.waiting?.id).toBe('g#4');
    // A second answer to the first question, delivered through another channel.
    expect(
      apply(second, event({ key: 'a2', correlationId: 'g#2', at: T0 + 35 }), T0 + 40),
    ).toMatchObject({ changed: false, outcome: 'ignored', reason: 'stale' });
    // An uncorrelated event from before the wait began.
    expect(apply(second, event({ key: 'a3', at: T0 + 29 }), T0 + 40)).toMatchObject({
      reason: 'stale',
    });
    expect(
      apply(second, event({ key: 'a4', correlationId: 'g#4', at: T0 + 35 }), T0 + 40),
    ).toMatchObject({ outcome: 'applied' });
  });

  it('drops an expired event and defers an early one', () => {
    const goal = waiting({ reason: 'user' });
    expect(apply(goal, event({ expiresAt: T0 + 20 }), T0 + 20)).toMatchObject({
      changed: false,
      outcome: 'ignored',
      reason: 'expired',
    });
    const early = event({ notBefore: T0 + 100 });
    expect(apply(goal, early, T0 + 99)).toMatchObject({ changed: false, reason: 'early' });
    expect(apply(goal, early, T0 + 100)).toMatchObject({ outcome: 'applied' });
  });

  it('drops an event the goal does not wait for', () => {
    const active = createGoal({ ...target, objective: 'x' }, { now: T0 });
    expect(apply(active, event())).toMatchObject({ outcome: 'ignored', reason: 'unmatched' });
    const ci = waiting({ reason: 'event', source: { type: 'signal', id: 'ci' } });
    for (const source of [
      { type: 'signal' as const, id: 'github' },
      { type: 'signal' as const },
      { type: 'user' as const },
    ])
      expect(apply(ci, event({ source })), JSON.stringify(source)).toMatchObject({
        reason: 'unmatched',
      });
    expect(apply(ci, event({ source: { type: 'signal', id: 'ci' } }))).toMatchObject({
      outcome: 'applied',
    });
    // A filter without an ID takes any event of its type.
    expect(
      apply(
        waiting({ reason: 'event', source: { type: 'signal' } }),
        event({ source: { type: 'signal', id: 'x' } }),
      ),
    ).toMatchObject({ outcome: 'applied' });
    expect(
      apply(waiting({ reason: 'user' }), event({ source: { type: 'schedule', id: 'n' } })),
    ).toMatchObject({ reason: 'unmatched' });
  });

  it('drops events for an ended goal, and refuses one meant for another goal', () => {
    const goal = waiting({ reason: 'user' });
    const cancelled = transitionGoal(goal, { type: 'cancel' }, { now: T0 + 5 }).record;
    expect(apply(cancelled, event())).toMatchObject({
      changed: false,
      outcome: 'ignored',
      reason: 'terminal',
    });
    for (const misrouted of [event({ scope: 'other' }), event({ goalId: 'other' })])
      expect(() => apply(goal, misrouted)).toThrow(
        expect.objectContaining({ code: 'scope_mismatch' }) as unknown as Error,
      );
  });

  it('ends a dependency wait once every dependency reported', () => {
    const goal = waiting({
      reason: 'dependency',
      on: [
        { kind: 'goal', id: 'changelog' },
        { kind: 'run', id: 'link-check' },
      ],
    });
    const one = apply(
      goal,
      event({ key: 'changelog-done', source: { type: 'goal', id: 'changelog' } }),
    );
    expect(one).toMatchObject({ changed: true, outcome: 'applied' });
    expect(one.record).toMatchObject({
      status: 'waiting',
      waiting: {
        reason: 'dependency',
        on: [
          { kind: 'goal', id: 'changelog', settled: true },
          { kind: 'run', id: 'link-check' },
        ],
      },
    });
    expect(
      apply(one.record, event({ key: 'other', source: { type: 'run', id: 'unrelated' } }), T0 + 30),
    ).toMatchObject({ reason: 'unmatched' });
    const both = apply(
      one.record,
      event({ key: 'links-done', source: { type: 'run', id: 'link-check' } }),
      T0 + 30,
    );
    expect(both.record.status).toBe('active');
  });

  it('ends a wakeup wait with an event dated at or after the wakeup', () => {
    const goal = waiting({ reason: 'wakeup', at: T0 + 60_000, schedule: 'nightly' });
    const occurrence = (id: string, at: number) =>
      goalEventFromOccurrence({ id, at, key: `${id}@${at}` }, target);
    expect(apply(goal, occurrence('nightly', T0 + 30_000), T0 + 60_000)).toMatchObject({
      reason: 'unmatched',
    });
    expect(apply(goal, occurrence('weekly', T0 + 60_000), T0 + 60_000)).toMatchObject({
      reason: 'unmatched',
    });
    expect(apply(goal, occurrence('nightly', T0 + 60_000), T0 + 60_000)).toMatchObject({
      outcome: 'applied',
      record: { status: 'active' },
    });
    // The goal's own wakeup event works without a schedule filter.
    const plain = waiting({ reason: 'wakeup', at: T0 + 60_000 });
    expect(apply(plain, goalWakeupEvent(plain), T0 + 60_000).record.status).toBe('active');
  });

  it('remembers the last 64 event keys, and apart from them the last 64 charge keys', () => {
    let goal = createGoal({ ...target, objective: 'x' }, { now: T0 });
    let now = T0;
    for (let index = 0; index < 65; index++)
      goal = transitionGoal(
        goal,
        { type: 'charge', tokens: 1, key: `k${index}` },
        { now: ++now },
      ).record;
    expect(goal.charged).toHaveLength(64);
    expect(goal.charged[0]).toBe('k1');
    expect(goal.seen).toEqual([]);
    // The oldest key fell out of the window.
    expect(
      transitionGoal(goal, { type: 'charge', tokens: 1, key: 'k0' }, { now: ++now }).changed,
    ).toBe(true);
    expect(
      transitionGoal(goal, { type: 'charge', tokens: 1, key: 'k64' }, { now: ++now }).reason,
    ).toBe('duplicate');
    // Events fill a window of their own, and push no charge key out.
    for (let index = 0; index < 65; index++) {
      goal = transitionGoal(
        goal,
        { type: 'wait', wait: { reason: 'user' } },
        { now: ++now },
      ).record;
      goal = apply(goal, event({ key: `e${index}`, at: now }), ++now).record;
    }
    expect(goal.seen).toHaveLength(64);
    expect(goal.seen[0]).toBe('e1');
    expect(goal.charged[0]).toBe('k1');
    // Further back, pair the goal with a durable claim on the event's key.
    goal = transitionGoal(goal, { type: 'wait', wait: { reason: 'user' } }, { now: ++now }).record;
    expect(apply(goal, event({ key: 'e0', at: now }), ++now).outcome).toBe('applied');
  });

  it("keeps a run's charge and its completion event apart, both keyed by the run ID", () => {
    const goal = waiting({ reason: 'dependency', on: [{ kind: 'run', id: 'run-1' }] });
    const completed = event({ key: 'run-1', source: { type: 'run', id: 'run-1' }, at: T0 + 3 });
    const charge = { type: 'charge', usd: 0.5, tokens: 100, key: 'run-1' } as const;
    // The charge first: the completion still ends the wait.
    const charged = transitionGoal(goal, charge, { now: T0 + 2 }).record;
    expect(apply(charged, completed, T0 + 4)).toMatchObject({
      outcome: 'applied',
      record: { status: 'active', seen: ['run-1'], charged: ['run-1'] },
    });
    // The completion first: the charge still counts.
    const settled = apply(goal, completed, T0 + 4).record;
    const counted = transitionGoal(settled, charge, { now: T0 + 5 });
    expect(counted).toMatchObject({
      outcome: 'applied',
      record: { spent: { usd: 0.5, tokens: 100 } },
    });
    // Each again is a duplicate of itself.
    expect(transitionGoal(counted.record, charge, { now: T0 + 6 })).toMatchObject({
      outcome: 'ignored',
      reason: 'duplicate',
    });
    const again = transitionGoal(
      counted.record,
      { type: 'wait', wait: { reason: 'dependency', on: [{ kind: 'run', id: 'run-1' }] } },
      { now: T0 + 6 },
    ).record;
    expect(apply(again, completed, T0 + 7)).toMatchObject({
      outcome: 'ignored',
      reason: 'duplicate',
    });
  });
});
