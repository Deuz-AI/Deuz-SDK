/**
 * goal-generation.test.ts (2.4, spec §3.5) — spec generations. On a goal that
 * carries `specGeneration`, a change of the objective, of a criterion, or a
 * revise naming a changed host constraint or verifier starts the next
 * generation, and every verdict reached before it becomes inconclusive; only
 * evidence of the current generation supports a pass. A goal without the
 * field keeps the 2.3 rules exactly. Charges and maintenance never touch the
 * evidence.
 */
import { describe, expect, it } from 'vitest';
import { assessGoal, createGoal, transitionGoal } from '../src/goal';
import type { GoalCommand, GoalRecord, GoalTransition } from '../src/goal';

const T0 = Date.parse('2026-10-10T10:00:00Z');

function newGoal(extra: Partial<Parameters<typeof createGoal>[0]> = {}): GoalRecord {
  return createGoal(
    {
      goalId: 'g',
      scope: 'tenant',
      objective: 'Make the nightly build green.',
      criteria: [
        { id: 'build', description: 'The nightly build passes.' },
        { id: 'docs', description: 'The fix is documented.' },
      ],
      ...extra,
    },
    { now: T0 },
  );
}

/** Apply commands in order, one millisecond apart; return the last transition. */
function run(record: GoalRecord, ...commands: GoalCommand[]): GoalTransition {
  let current: GoalTransition = { record, changed: false, outcome: 'ignored' };
  let now = record.updatedAt;
  for (const command of commands) current = transitionGoal(current.record, command, { now: ++now });
  return current;
}

/** Both criteria passed on test evidence. */
const passBoth: GoalCommand = {
  type: 'evaluate',
  evidence: [{ id: 'ci', source: 'test', ref: 'ci/1' }],
  results: [
    { criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['ci'] },
    { criterionId: 'docs', verdict: 'passed', source: 'human', evidence: ['ci'] },
  ],
};

const verdicts = (record: GoalRecord) =>
  Object.fromEntries(record.results.map((result) => [result.criterionId, result.verdict]));

describe('a goal without a spec generation keeps the 2.3 rules', () => {
  it('keeps every verdict when the objective changes', () => {
    const judged = run(newGoal(), passBoth).record;
    const revised = run(judged, { type: 'revise', objective: 'Ship the release.' }).record;
    expect(revised.results).toEqual(judged.results);
    expect('specGeneration' in revised).toBe(false);
    expect(assessGoal(revised).verdict).toBe('passed');
  });

  it('drops only the verdict of a criterion whose text changed', () => {
    const judged = run(newGoal(), passBoth).record;
    const revised = run(judged, {
      type: 'revise',
      criteria: [
        { id: 'build', description: 'The nightly build passes.' },
        { id: 'docs', description: 'The fix is documented in the changelog.' },
      ],
    }).record;
    expect(revised.results.map((result) => result.criterionId)).toEqual(['build']);
    expect(revised.results[0]).toEqual(judged.results[0]);
    expect('specGeneration' in revised).toBe(false);
  });

  it('takes evidence without stamping a generation on it', () => {
    const judged = run(newGoal(), passBoth).record;
    expect('specGeneration' in judged.evidence[0]!).toBe(false);
  });
});

describe('a goal with a spec generation', () => {
  it('starts the next generation on a new objective and makes every verdict inconclusive', () => {
    const judged = run(newGoal({ specGeneration: 1 }), passBoth).record;
    expect(judged.evidence[0]!.specGeneration).toBe(1);
    expect(assessGoal(judged).verdict).toBe('passed');
    const revised = run(judged, { type: 'revise', objective: 'Ship the release.' });
    expect(revised.record.specGeneration).toBe(2);
    expect(verdicts(revised.record)).toEqual({ build: 'inconclusive', docs: 'inconclusive' });
    // What each verdict rested on stays visible.
    expect(revised.record.results.map((result) => result.evidence)).toEqual([['ci'], ['ci']]);
    expect(revised.record.results[0]!.note).toMatch(/generation 1/);
    expect(revised.record.evidence).toEqual(judged.evidence);
    expect(assessGoal(revised.record).verdict).toBe('inconclusive');
    expect(run(revised.record, { type: 'complete' })).toMatchObject({
      outcome: 'rejected',
      reason: 'acceptance-not-passed',
    });
  });

  it('starts the next generation on any change to the criteria, dropping removed ones', () => {
    const judged = run(newGoal({ specGeneration: 4 }), passBoth).record;
    const required = run(judged, {
      type: 'revise',
      criteria: [
        { id: 'build', description: 'The nightly build passes.' },
        { id: 'docs', description: 'The fix is documented.', required: false },
      ],
    }).record;
    expect(required.specGeneration).toBe(5);
    expect(verdicts(required)).toEqual({ build: 'inconclusive', docs: 'inconclusive' });
    const removed = run(judged, {
      type: 'revise',
      criteria: [{ id: 'build', description: 'The nightly build passes.' }],
    }).record;
    expect(removed.specGeneration).toBe(5);
    expect(verdicts(removed)).toEqual({ build: 'inconclusive' });
  });

  it('starts the next generation when a host constraint or verifier changed', () => {
    const judged = run(newGoal({ specGeneration: 1 }), passBoth).record;
    const next = run(judged, { type: 'revise', nextSpecGeneration: true });
    expect(next).toMatchObject({ changed: true, outcome: 'applied' });
    expect(next.record.specGeneration).toBe(2);
    expect(verdicts(next.record)).toEqual({ build: 'inconclusive', docs: 'inconclusive' });
    // Passed back as they were read, objective and criteria change nothing.
    const same = run(judged, {
      type: 'revise',
      objective: judged.objective,
      criteria: judged.criteria,
    });
    expect(same).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('opts a goal in at generation 1 when a revise asks for the next generation', () => {
    const judged = run(newGoal(), passBoth).record;
    const opted = run(judged, { type: 'revise', nextSpecGeneration: true }).record;
    expect(opted.specGeneration).toBe(1);
    expect(verdicts(opted)).toEqual({ build: 'inconclusive', docs: 'inconclusive' });
    // `false` asks for nothing.
    expect(run(judged, { type: 'revise', nextSpecGeneration: false })).toMatchObject({
      changed: false,
      reason: 'unchanged',
    });
  });

  it('passes again only on evidence of the current generation', () => {
    const revised = run(newGoal({ specGeneration: 1 }), passBoth, {
      type: 'revise',
      objective: 'Ship the release.',
    }).record;
    // The old evidence, cited again, is of generation 1.
    const stale = run(revised, {
      type: 'evaluate',
      results: [{ criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['ci'] }],
    });
    expect(verdicts(stale.record).build).toBe('inconclusive');
    expect(stale.record.results[0]!.note).toMatch(/current spec generation/);
    // Evidence named for another generation is recorded as given, and supports nothing now.
    const named = run(revised, {
      type: 'evaluate',
      evidence: [{ id: 'old', source: 'test', ref: 'ci/0', specGeneration: 1 }],
      results: [{ criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['old'] }],
    });
    expect(named.record.evidence.at(-1)!.specGeneration).toBe(1);
    expect(verdicts(named.record).build).toBe('inconclusive');
    // New evidence, stamped with generation 2, passes.
    const fresh = run(revised, {
      type: 'evaluate',
      evidence: [{ id: 'ci-2', source: 'test', ref: 'ci/2' }],
      results: [
        { criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['ci-2'] },
        { criterionId: 'docs', verdict: 'passed', source: 'human', evidence: ['ci-2'] },
      ],
    });
    expect(fresh.record.evidence.at(-1)!.specGeneration).toBe(2);
    expect(fresh.acceptance?.verdict).toBe('passed');
    expect(run(fresh.record, { type: 'complete' }).record.status).toBe('completed');
  });

  it('never invalidates evidence on a charge, a run link, a tick, an event or maintenance', () => {
    const judged = run(newGoal({ specGeneration: 1, budget: { usd: 10 } }), passBoth).record;
    const after = run(
      judged,
      { type: 'charge', usd: 1, tokens: 100, key: 'run-1' },
      { type: 'link-run', runId: 'run-2' },
      { type: 'tick' },
      { type: 'wait', wait: { reason: 'user' } },
      { type: 'resume' },
      { type: 'revise', budget: { usd: 20 } },
      { type: 'revise', deadline: T0 + 86_400_000 },
      { type: 'revise', meta: { owner: 'ops' } },
      { type: 'evidence', evidence: [{ id: 'log', source: 'tool', ref: 'logs/1' }] },
    ).record;
    expect(after.specGeneration).toBe(1);
    expect(after.results).toEqual(judged.results);
    expect(assessGoal(after).verdict).toBe('passed');
  });

  it('still needs a source other than the model, and evidence from outside it', () => {
    const goal = newGoal({ specGeneration: 1 });
    const claimed = run(goal, {
      type: 'evaluate',
      evidence: [{ id: 'says', source: 'model', ref: 'transcript' }],
      results: [
        { criterionId: 'build', verdict: 'passed', source: 'test', evidence: ['says'] },
        { criterionId: 'docs', verdict: 'passed', source: 'model', evidence: ['says'] },
      ],
    });
    expect(verdicts(claimed.record)).toEqual({ build: 'inconclusive', docs: 'inconclusive' });
    expect(claimed.acceptance?.verdict).toBe('inconclusive');
  });
});

describe('evidence bound to a criterion', () => {
  it('supports a verdict on its own criterion only, with or without generations', () => {
    for (const goal of [newGoal(), newGoal({ specGeneration: 1 })]) {
      const judged = run(goal, {
        type: 'evaluate',
        evidence: [{ id: 'junit', source: 'verifier', ref: 'junit.xml', criterionId: 'build' }],
        results: [
          { criterionId: 'build', verdict: 'passed', source: 'verifier', evidence: ['junit'] },
          { criterionId: 'docs', verdict: 'passed', source: 'verifier', evidence: ['junit'] },
        ],
      });
      expect(verdicts(judged.record)).toEqual({ build: 'passed', docs: 'inconclusive' });
    }
  });
});
