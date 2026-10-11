/**
 * goal-transitions.test.ts (2.3, 23.6) — the pure transitions: waiting,
 * resume and cancel; acceptance on evidence (a model saying "done" never
 * completes a goal); budget and deadline; revision conflicts. Time is the
 * `now` each transition is given, read from a fake clock.
 */
import { describe, expect, it } from 'vitest';
import { GoalError, assessGoal, createGoal, createGoalEvent, transitionGoal } from '../src/goal';
import type { GoalCommand, GoalEventSource, GoalRecord, GoalTransition } from '../src/goal';
import { manualClock } from './fixtures/manual-clock';

const T0 = Date.parse('2026-10-10T10:00:00Z');

function newGoal(extra: Partial<Parameters<typeof createGoal>[0]> = {}): GoalRecord {
  return createGoal(
    {
      goalId: 'g',
      scope: 'tenant',
      objective: 'Make the nightly build green.',
      criteria: [
        { id: 'build', description: 'The nightly build passes.' },
        { id: 'notes', description: 'The fix is described.', required: false },
      ],
      ...extra,
    },
    { now: T0 },
  );
}

/** Apply commands in order, one millisecond apart; return every transition. */
function run(record: GoalRecord, ...commands: GoalCommand[]): GoalTransition[] {
  const out: GoalTransition[] = [];
  let current = record;
  let now = record.updatedAt;
  for (const command of commands) {
    const next = transitionGoal(current, command, { now: ++now });
    out.push(next);
    current = next.record;
  }
  return out;
}
const last = (transitions: GoalTransition[]) => transitions.at(-1)!;

/** An event for goal `g` from `source`, keyed `key`, dated `at`, answering `correlationId`. */
const answer = (source: GoalEventSource, key: string, at: number, correlationId?: string) =>
  createGoalEvent({
    scope: 'tenant',
    goalId: 'g',
    source,
    key,
    at,
    ...(correlationId !== undefined ? { correlationId } : {}),
  });

describe('waiting, resume and cancel', () => {
  it('enters a wait with an explicit reason and leaves it on resume', () => {
    const goal = newGoal();
    const waited = transitionGoal(
      goal,
      { type: 'wait', wait: { reason: 'user', note: 'Approve the deploy.' } },
      { now: T0 + 10 },
    );
    expect(waited).toMatchObject({ changed: true, outcome: 'applied' });
    expect(waited.record).toMatchObject({
      revision: 2,
      status: 'waiting',
      waiting: { reason: 'user', id: 'g#2', since: T0 + 10, note: 'Approve the deploy.' },
      updatedAt: T0 + 10,
    });
    const resumed = transitionGoal(waited.record, { type: 'resume' }, { now: T0 + 20 });
    expect(resumed.record).toMatchObject({ revision: 3, status: 'active' });
    expect(resumed.record.waiting).toBeUndefined();
    // Resuming an active goal changes nothing.
    expect(transitionGoal(resumed.record, { type: 'resume' }, { now: T0 + 30 })).toMatchObject({
      changed: false,
      outcome: 'ignored',
      reason: 'unchanged',
    });
  });

  it('never moves a goal forward because no model call is running', () => {
    const goal = newGoal();
    // Time alone does nothing to an active goal: it is not done, it waits for work.
    expect(transitionGoal(goal, { type: 'tick' }, { now: T0 + 86_400_000 })).toMatchObject({
      changed: false,
      reason: 'unchanged',
    });
    expect(goal.status).toBe('active');
  });

  it('replaces one wait with another', () => {
    const [, second] = run(
      newGoal(),
      { type: 'wait', wait: { reason: 'user' } },
      { type: 'wait', wait: { reason: 'event', source: { type: 'signal', id: 'ci' } } },
    );
    expect(second!.record.waiting).toMatchObject({ reason: 'event', id: 'g#3' });
  });

  it('cancels a goal from any state but a terminal one, once', () => {
    for (const before of [
      newGoal(),
      transitionGoal(newGoal(), { type: 'wait', wait: { reason: 'user' } }, { now: T0 + 1 }).record,
    ]) {
      const cancelled = transitionGoal(
        before,
        { type: 'cancel', reason: 'No longer needed.' },
        { now: T0 + 5 },
      );
      expect(cancelled.record).toMatchObject({
        status: 'cancelled',
        outcome: { reason: 'cancelled', detail: 'No longer needed.', at: T0 + 5 },
      });
      expect(cancelled.record.waiting).toBeUndefined();
      // A second cancel is a no-op; anything else on a terminal goal is refused.
      expect(transitionGoal(cancelled.record, { type: 'cancel' }, { now: T0 + 6 })).toMatchObject({
        changed: false,
        outcome: 'ignored',
        reason: 'unchanged',
      });
      for (const command of [
        { type: 'resume' },
        { type: 'wait', wait: { reason: 'user' } },
        { type: 'complete' },
        { type: 'fail', reason: 'x' },
        { type: 'revise', objective: 'y' },
      ] as GoalCommand[])
        expect(transitionGoal(cancelled.record, command, { now: T0 + 7 })).toMatchObject({
          changed: false,
          outcome: 'rejected',
          reason: 'terminal',
        });
    }
  });

  it('fails a goal by command', () => {
    expect(
      last(run(newGoal(), { type: 'fail', reason: 'The vendor API is gone.' })).record,
    ).toMatchObject({
      status: 'failed',
      outcome: { reason: 'failed', detail: 'The vendor API is gone.' },
    });
  });

  it('wakes a goal waiting for a time once a tick reaches it', async () => {
    const { clock, advance } = manualClock(T0);
    let goal = transitionGoal(
      newGoal(),
      { type: 'wait', wait: { reason: 'wakeup', at: T0 + 60_000 } },
      { now: clock.now() },
    ).record;
    await advance(59_999);
    expect(transitionGoal(goal, { type: 'tick' }, { now: clock.now() }).changed).toBe(false);
    await advance(1);
    const woken = transitionGoal(goal, { type: 'tick' }, { now: clock.now() });
    expect(woken).toMatchObject({ changed: true, outcome: 'applied' });
    goal = woken.record;
    expect(goal.status).toBe('active');
  });
});

describe('acceptance', () => {
  it('rejects completion without evidence', () => {
    const goal = newGoal();
    const attempt = transitionGoal(goal, { type: 'complete' }, { now: T0 + 1 });
    expect(attempt).toMatchObject({
      changed: false,
      outcome: 'rejected',
      reason: 'acceptance-not-passed',
      acceptance: { verdict: 'inconclusive' },
    });
    expect(attempt.record).toBe(goal);
  });

  it('never counts a model saying "done" as passed', () => {
    const [evaluated, completion] = run(
      newGoal(),
      {
        type: 'evaluate',
        evidence: [
          { id: 'claim', source: 'model', ref: 'run:r1#4', summary: 'The build is fixed.' },
        ],
        results: [
          { criterionId: 'build', verdict: 'passed', source: 'model', evidence: ['claim'] },
        ],
      },
      { type: 'complete' },
    );
    // Recorded as what it is: inconclusive, with why.
    expect(evaluated!.record.results).toEqual([
      expect.objectContaining({
        criterionId: 'build',
        verdict: 'inconclusive',
        source: 'model',
        evidence: ['claim'],
        note: expect.stringContaining('evidence'),
      }),
    ]);
    expect(evaluated!.acceptance?.verdict).toBe('inconclusive');
    expect(completion).toMatchObject({ outcome: 'rejected', reason: 'acceptance-not-passed' });
  });

  it('does not pass a verdict that rests on no evidence, or only on the model', () => {
    const [noEvidence, modelEvidence] = run(
      newGoal(),
      { type: 'evaluate', results: [{ criterionId: 'build', verdict: 'passed', source: 'human' }] },
      {
        type: 'evaluate',
        evidence: [{ id: 'm', source: 'model', ref: 'run:r1' }],
        results: [{ criterionId: 'build', verdict: 'passed', source: 'verifier', evidence: ['m'] }],
      },
    );
    for (const step of [noEvidence!, modelEvidence!])
      expect(step.record.results[0]).toMatchObject({ verdict: 'inconclusive' });
  });

  it('completes once every required criterion passed on evidence', () => {
    const steps = run(
      newGoal(),
      {
        type: 'evaluate',
        evidence: [
          { id: 'ci', source: 'test', ref: 'https://ci.example/run/42', summary: 'green' },
        ],
        results: [{ criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['ci'] }],
      },
      { type: 'complete' },
    );
    expect(steps[0]!.acceptance).toEqual({
      verdict: 'passed',
      criteria: [
        {
          criterionId: 'build',
          required: true,
          verdict: 'passed',
          source: 'test',
          evidence: ['ci'],
        },
        { criterionId: 'notes', required: false, verdict: 'inconclusive', evidence: [] },
      ],
    });
    expect(last(steps).record).toMatchObject({
      status: 'completed',
      outcome: { reason: 'accepted' },
      revision: 3,
    });
  });

  it('reports a failed required criterion, and keeps the goal open to fix it', () => {
    const [failed] = run(newGoal(), {
      type: 'evaluate',
      evidence: [{ id: 'ci', source: 'test', ref: 'ci/41' }],
      results: [{ criterionId: 'build', verdict: 'failed', source: 'test', evidence: ['ci'] }],
    });
    expect(failed!.acceptance?.verdict).toBe('failed');
    expect(failed!.record.status).toBe('active');
    expect(assessGoal(failed!.record).verdict).toBe('failed');
  });

  it('refuses verdicts on unknown criteria or evidence, and conflicting evidence', () => {
    const goal = newGoal();
    const [recorded] = run(goal, {
      type: 'evidence',
      evidence: [{ id: 'e1', source: 'test', ref: 'ci/1' }],
    });
    const now = { now: T0 + 100 };
    expect(
      transitionGoal(
        recorded!.record,
        { type: 'evaluate', results: [{ criterionId: 'nope', verdict: 'failed', source: 'test' }] },
        now,
      ),
    ).toMatchObject({ outcome: 'rejected', reason: 'unknown-criterion', changed: false });
    expect(
      transitionGoal(
        recorded!.record,
        {
          type: 'evaluate',
          results: [{ criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['e9'] }],
        },
        now,
      ),
    ).toMatchObject({ outcome: 'rejected', reason: 'unknown-evidence' });
    expect(
      transitionGoal(
        recorded!.record,
        { type: 'evidence', evidence: [{ id: 'e1', source: 'test', ref: 'ci/2' }] },
        now,
      ),
    ).toMatchObject({ outcome: 'rejected', reason: 'evidence-conflict' });
    // The same evidence again is nothing new.
    expect(
      transitionGoal(
        recorded!.record,
        { type: 'evidence', evidence: [{ id: 'e1', source: 'test', ref: 'ci/1', at: T0 + 1 }] },
        now,
      ),
    ).toMatchObject({ changed: false, outcome: 'ignored', reason: 'unchanged' });
  });
});

describe('budget', () => {
  it('waits on a spent budget until a revision raises it', () => {
    const steps = run(
      newGoal({ budget: { usd: 1, tokens: 1_000 } }),
      { type: 'charge', usd: 0.4, tokens: 100, key: 'run-1' },
      { type: 'charge', usd: 0.6, tokens: 100, key: 'run-2' },
    );
    expect(steps[0]!.record).toMatchObject({ status: 'active', spent: { usd: 0.4, tokens: 100 } });
    const spent = last(steps).record;
    expect(spent).toMatchObject({
      status: 'waiting',
      spent: { usd: 1, tokens: 200 },
      waiting: { reason: 'budget', limit: 'usd' },
    });
    // Neither resume, nor an event, nor another wait ends a budget wait.
    for (const command of [
      { type: 'resume' },
      { type: 'wait', wait: { reason: 'user' } },
    ] as GoalCommand[])
      expect(transitionGoal(spent, command, { now: spent.updatedAt + 1 })).toMatchObject({
        outcome: 'rejected',
        reason: 'budget-exhausted',
      });
    const raised = transitionGoal(
      spent,
      { type: 'revise', budget: { usd: 3, tokens: 1_000 } },
      { now: spent.updatedAt + 1 },
    );
    expect(raised.record).toMatchObject({ status: 'active', budget: { usd: 3 } });
    expect(raised.record.waiting).toBeUndefined();
  });

  it('counts tokens alone when a run had no price', () => {
    const steps = run(
      newGoal({ budget: { usd: 1, tokens: 1_000 } }),
      { type: 'charge', tokens: 999 },
      { type: 'charge', tokens: 1 },
    );
    expect(last(steps).record).toMatchObject({
      spent: { usd: 0, tokens: 1_000 },
      waiting: { reason: 'budget', limit: 'tokens' },
    });
  });

  it('charges a key once', () => {
    const [first, again] = run(
      newGoal(),
      { type: 'charge', usd: 0.5, key: 'run-1' },
      { type: 'charge', usd: 0.5, key: 'run-1' },
    );
    expect(first!.record.spent.usd).toBe(0.5);
    expect(again).toMatchObject({ changed: false, outcome: 'ignored', reason: 'duplicate' });
  });

  it('still records what a run spent after the goal ended', () => {
    const steps = run(newGoal(), { type: 'cancel' }, { type: 'charge', usd: 0.25, tokens: 5 });
    expect(last(steps)).toMatchObject({ changed: true, outcome: 'applied' });
    expect(last(steps).record).toMatchObject({
      status: 'cancelled',
      spent: { usd: 0.25, tokens: 5 },
    });
  });

  it('waits at once when a revision lowers the budget below what was spent', () => {
    const steps = run(
      newGoal(),
      { type: 'charge', usd: 2 },
      { type: 'revise', budget: { usd: 1 } },
    );
    expect(last(steps).record).toMatchObject({
      status: 'waiting',
      waiting: { reason: 'budget', limit: 'usd' },
    });
  });

  it('keeps the wait a spent budget interrupted, and puts it back once the budget is raised', () => {
    const [asked, charged, raised] = run(
      newGoal({ budget: { usd: 1 } }),
      { type: 'wait', wait: { reason: 'user', note: 'Approve the deploy.' } },
      { type: 'charge', usd: 1.5, key: 'run-1' },
      { type: 'revise', budget: { usd: 5 } },
    );
    const question = asked!.record.waiting;
    expect(question).toMatchObject({ reason: 'user', id: 'g#2', since: T0 + 1 });
    // The spent budget holds the goal, and keeps what it waited for.
    expect(charged!.record).toMatchObject({
      status: 'waiting',
      waiting: { reason: 'budget', id: 'g#3', limit: 'usd', interrupted: question },
    });
    // The person has not answered: the goal still waits for them, under the same wait.
    expect(raised!.record.status).toBe('waiting');
    expect(raised!.record.waiting).toEqual(question);
    expect(
      transitionGoal(
        raised!.record,
        { type: 'event', event: answer({ type: 'user' }, 'reply-1', T0 + 4, 'g#2') },
        { now: T0 + 5 },
      ),
    ).toMatchObject({ outcome: 'applied', record: { status: 'active' } });
  });

  it('keeps a dependency wait, and what settled in it, across a spent and raised budget', () => {
    let goal = transitionGoal(
      newGoal({ budget: { usd: 1 } }),
      {
        type: 'wait',
        wait: {
          reason: 'dependency',
          on: [
            { kind: 'run', id: 'r1' },
            { kind: 'run', id: 'r2' },
          ],
        },
      },
      { now: T0 + 1 },
    ).record;
    const done = (id: string, at: number) => answer({ type: 'run', id }, `${id}-done`, at);
    goal = transitionGoal(
      goal,
      { type: 'event', event: done('r1', T0 + 2) },
      { now: T0 + 2 },
    ).record;
    // r1's usage is charged as it completes, and spends the budget.
    goal = transitionGoal(goal, { type: 'charge', usd: 1.5, key: 'r1' }, { now: T0 + 3 }).record;
    const raised = transitionGoal(
      goal,
      { type: 'revise', budget: { usd: 5 } },
      { now: T0 + 4 },
    ).record;
    // r2 has not reported: the goal still waits for it, and its event ends the wait.
    expect(raised).toMatchObject({
      status: 'waiting',
      waiting: {
        reason: 'dependency',
        id: 'g#2',
        since: T0 + 1,
        on: [
          { kind: 'run', id: 'r1', settled: true },
          { kind: 'run', id: 'r2' },
        ],
      },
    });
    expect(
      transitionGoal(raised, { type: 'event', event: done('r2', T0 + 5) }, { now: T0 + 5 }),
    ).toMatchObject({ outcome: 'applied', record: { status: 'active' } });
  });

  it('applies what answers the interrupted wait while the budget stays spent', () => {
    const [, spent] = run(
      newGoal({ budget: { usd: 1 } }),
      {
        type: 'wait',
        wait: {
          reason: 'dependency',
          on: [
            { kind: 'goal', id: 'changelog' },
            { kind: 'run', id: 'link-check' },
          ],
        },
      },
      { type: 'charge', usd: 2 },
    );
    expect(spent!.record.waiting).toMatchObject({ reason: 'budget', interrupted: { id: 'g#2' } });
    // One dependency reports while the budget is spent: it settles, and is remembered.
    const one = transitionGoal(
      spent!.record,
      { type: 'event', event: answer({ type: 'goal', id: 'changelog' }, 'changelog-done', T0 + 4) },
      { now: T0 + 4 },
    );
    expect(one).toMatchObject({
      outcome: 'applied',
      record: {
        status: 'waiting',
        seen: ['changelog-done'],
        waiting: {
          reason: 'budget',
          interrupted: { on: [{ id: 'changelog', settled: true }, { id: 'link-check' }] },
        },
      },
    });
    // An answer to another wait is stale, and one the wait is not for unmatched.
    const other = answer({ type: 'run', id: 'link-check' }, 'late', T0 + 5, 'g#1');
    expect(
      transitionGoal(one.record, { type: 'event', event: other }, { now: T0 + 5 }),
    ).toMatchObject({ outcome: 'ignored', reason: 'stale' });
    const stranger = answer({ type: 'run', id: 'unrelated' }, 'stranger', T0 + 5);
    expect(
      transitionGoal(one.record, { type: 'event', event: stranger }, { now: T0 + 5 }),
    ).toMatchObject({ outcome: 'ignored', reason: 'unmatched' });
    // The last one ends the interrupted wait; the spent budget still holds the goal.
    const both = transitionGoal(
      one.record,
      { type: 'event', event: answer({ type: 'run', id: 'link-check' }, 'links-done', T0 + 6) },
      { now: T0 + 6 },
    );
    expect(both).toMatchObject({
      outcome: 'applied',
      record: { status: 'waiting', waiting: { reason: 'budget', id: 'g#3' } },
    });
    expect(both.record.waiting).not.toHaveProperty('interrupted');
    // Raised, nothing is left to wait for.
    expect(
      transitionGoal(both.record, { type: 'revise', budget: { usd: 5 } }, { now: T0 + 7 }).record,
    ).toMatchObject({ status: 'active' });
  });

  it('lets a wakeup that came due while the budget was spent pass', () => {
    const [, spent] = run(
      newGoal({ budget: { tokens: 10 } }),
      { type: 'wait', wait: { reason: 'wakeup', at: T0 + 60_000 } },
      { type: 'charge', tokens: 10 },
    );
    expect(transitionGoal(spent!.record, { type: 'tick' }, { now: T0 + 59_999 })).toMatchObject({
      changed: false,
      reason: 'unchanged',
    });
    const due = transitionGoal(spent!.record, { type: 'tick' }, { now: T0 + 60_000 });
    expect(due).toMatchObject({
      outcome: 'applied',
      record: { status: 'waiting', waiting: { reason: 'budget', limit: 'tokens' } },
    });
    expect(due.record.waiting).not.toHaveProperty('interrupted');
    expect(
      transitionGoal(due.record, { type: 'revise', budget: { tokens: 20 } }, { now: T0 + 60_001 })
        .record.status,
    ).toBe('active');
  });

  it('drops every event during a budget wait that interrupted nothing', () => {
    const [spent] = run(newGoal({ budget: { usd: 1 } }), { type: 'charge', usd: 1 });
    expect(spent!.record.waiting).not.toHaveProperty('interrupted');
    expect(
      transitionGoal(
        spent!.record,
        { type: 'event', event: answer({ type: 'user' }, 'reply', T0 + 2) },
        { now: T0 + 2 },
      ),
    ).toMatchObject({ outcome: 'ignored', reason: 'unmatched' });
  });
});

describe('deadline', () => {
  it('fails the goal at the first transition at or after its deadline', () => {
    const goal = newGoal({ deadline: T0 + 60_000 });
    expect(transitionGoal(goal, { type: 'tick' }, { now: T0 + 59_999 }).changed).toBe(false);
    const expired = transitionGoal(goal, { type: 'tick' }, { now: T0 + 60_000 });
    expect(expired).toMatchObject({ changed: true, outcome: 'applied' });
    expect(expired.record).toMatchObject({
      status: 'failed',
      outcome: { reason: 'deadline', at: T0 + 60_000 },
    });
  });

  it('expires a waiting goal before applying anything else, and says so', () => {
    const waiting = transitionGoal(
      newGoal({ deadline: T0 + 60_000 }),
      { type: 'wait', wait: { reason: 'user' } },
      { now: T0 + 1 },
    ).record;
    const late = transitionGoal(waiting, { type: 'resume' }, { now: T0 + 61_000 });
    expect(late).toMatchObject({ changed: true, outcome: 'rejected', reason: 'terminal' });
    expect(late.record).toMatchObject({ status: 'failed', outcome: { reason: 'deadline' } });
    expect(late.record.waiting).toBeUndefined();
    // An event is dropped, and the goal failed all the same: save on `changed`.
    const reply = answer({ type: 'user' }, 'reply', T0 + 61_000);
    expect(
      transitionGoal(waiting, { type: 'event', event: reply }, { now: T0 + 61_000 }),
    ).toMatchObject({
      changed: true,
      outcome: 'ignored',
      reason: 'terminal',
      record: { status: 'failed', outcome: { reason: 'deadline' } },
    });
  });

  it('can be extended or removed before it passes, never set in the past', () => {
    const goal = newGoal({ deadline: T0 + 60_000 });
    const extended = transitionGoal(
      goal,
      { type: 'revise', deadline: T0 + 120_000 },
      { now: T0 + 30_000 },
    );
    expect(extended.record.deadline).toBe(T0 + 120_000);
    expect(transitionGoal(extended.record, { type: 'tick' }, { now: T0 + 90_000 }).changed).toBe(
      false,
    );
    expect(
      transitionGoal(goal, { type: 'revise', deadline: T0 + 1_000 }, { now: T0 + 2_000 }),
    ).toMatchObject({ outcome: 'rejected', reason: 'deadline-passed', changed: false });
    const removed = transitionGoal(goal, { type: 'revise', deadline: null }, { now: T0 + 1 });
    expect(removed.record.deadline).toBeUndefined();
    expect(
      transitionGoal(removed.record, { type: 'tick' }, { now: T0 + 999_999_999 }).changed,
    ).toBe(false);
  });
});

describe('revisions', () => {
  it('applies a command only at the expected revision', () => {
    const goal = newGoal();
    const moved = transitionGoal(goal, { type: 'link-run', runId: 'r1' }, { now: T0 + 1 }).record;
    expect(moved).toMatchObject({ revision: 2, runId: 'r1' });
    let error: unknown;
    try {
      transitionGoal(moved, { type: 'cancel' }, { now: T0 + 2, expectedRevision: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GoalError);
    expect(error).toMatchObject({ code: 'revision_conflict' });
    expect(
      transitionGoal(moved, { type: 'cancel' }, { now: T0 + 2, expectedRevision: 2 }).record.status,
    ).toBe('cancelled');
  });

  it('never changes the record it was given', () => {
    const goal = newGoal({ budget: { usd: 1 } });
    const frozen = structuredClone(goal);
    run(
      goal,
      { type: 'wait', wait: { reason: 'dependency', on: [{ kind: 'run', id: 'r' }] } },
      { type: 'charge', usd: 5 },
    );
    transitionGoal(goal, { type: 'evaluate', results: [] }, { now: T0 + 1 });
    expect(goal).toEqual(frozen);
  });

  it('keeps only the verdicts a revision of the criteria leaves standing', () => {
    const steps = run(
      newGoal(),
      {
        type: 'evaluate',
        evidence: [{ id: 'ci', source: 'test', ref: 'ci/1' }],
        results: [
          { criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['ci'] },
          { criterionId: 'notes', verdict: 'failed', source: 'human', evidence: ['ci'] },
        ],
      },
      {
        type: 'revise',
        criteria: [
          { id: 'build', description: 'The nightly build passes.' },
          { id: 'notes', description: 'The fix is described in the changelog.', required: false },
        ],
      },
    );
    expect(last(steps).record.results.map((result) => result.criterionId)).toEqual(['build']);
    expect(last(steps).record.evidence).toHaveLength(1);
  });

  it('rejects a malformed command', () => {
    const goal = newGoal();
    for (const command of [
      { type: 'launch' },
      { type: 'wait', wait: { reason: 'budget', limit: 'usd' } },
      { type: 'wait', wait: { reason: 'wakeup' } },
      { type: 'wait', wait: { reason: 'event', source: { type: 'mail' } } },
      { type: 'wait', wait: { reason: 'dependency', on: [] } },
      { type: 'charge', usd: -1 },
      { type: 'charge', tokens: Number.NaN },
      { type: 'fail', reason: '' },
      { type: 'link-run', runId: '' },
      { type: 'revise', criteria: [] },
      { type: 'evidence', evidence: [{ id: 'e', source: 'model' }] },
    ])
      expect(
        () => transitionGoal(goal, command as GoalCommand, { now: T0 + 1 }),
        JSON.stringify(command),
      ).toThrow(expect.objectContaining({ code: 'invalid_command' }) as unknown as Error);
    expect(() => transitionGoal(goal, { type: 'tick' }, { now: Number.NaN })).toThrow(GoalError);
  });
});
