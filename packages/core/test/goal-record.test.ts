/**
 * goal-record.test.ts (2.3, 23.6) — the GoalRecord contract: creation,
 * validation, and serialization, including the records that earlier releases
 * of the format wrote.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GOAL_RECORD_VERSION,
  GoalError,
  createGoal,
  parseGoal,
  serializeGoal,
  transitionGoal,
} from '../src/goal';
import type { GoalRecord } from '../src/goal';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** A copy of `record` changed by `change`, for the invalid cases. */
function mutated(record: GoalRecord, change: (copy: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(record) as unknown as Record<string, unknown>;
  change(copy);
  return copy;
}

describe('createGoal', () => {
  it('creates an active version 1 record at revision 1', () => {
    const goal = createGoal(
      {
        goalId: 'g1',
        scope: 'tenant',
        objective: 'Ship the report.',
        criteria: [{ id: 'tests', description: 'The test suite passes.' }],
        parentGoalId: 'quarter',
        budget: { usd: 2 },
        deadline: T0 + 3_600_000,
        meta: { owner: 'ops' },
      },
      { now: T0 },
    );
    expect(goal).toEqual({
      kind: 'deuz-goal',
      version: GOAL_RECORD_VERSION,
      goalId: 'g1',
      scope: 'tenant',
      revision: 1,
      parentGoalId: 'quarter',
      objective: 'Ship the report.',
      criteria: [{ id: 'tests', description: 'The test suite passes.' }],
      evidence: [],
      results: [],
      budget: { usd: 2 },
      spent: { usd: 0, tokens: 0 },
      deadline: T0 + 3_600_000,
      status: 'active',
      seen: [],
      createdAt: T0,
      updatedAt: T0,
      meta: { owner: 'ops' },
    });
  });

  it('gives a goal without criteria one: the objective itself', () => {
    const goal = createGoal({ goalId: 'g', scope: 's', objective: 'Fix the build.' }, { now: T0 });
    expect(goal.criteria).toEqual([{ id: 'objective', description: 'Fix the build.' }]);
  });

  it('refuses a malformed goal', () => {
    const base = { goalId: 'g', scope: 's', objective: 'x' };
    for (const input of [
      { ...base, goalId: '' },
      { ...base, scope: '' },
      { ...base, objective: '' },
      { ...base, criteria: [] },
      {
        ...base,
        criteria: [
          { id: 'a', description: 'a' },
          { id: 'a', description: 'b' },
        ],
      },
      { ...base, budget: { usd: -1 } },
      { ...base, deadline: T0 },
      { ...base, deadline: Number.NaN },
      { ...base, meta: { at: new Date(0) } },
    ])
      expect(() => createGoal(input as never, { now: T0 }), JSON.stringify(input)).toThrow(
        GoalError,
      );
    expect(() => createGoal(base, { now: Number.NaN })).toThrow(GoalError);
  });
});

describe('GoalRecord serialization', () => {
  const goal = transitionGoal(
    createGoal({ goalId: 'g', scope: 's', objective: 'x', budget: { tokens: 10 } }, { now: T0 }),
    { type: 'wait', wait: { reason: 'wakeup', at: T0 + 60_000, note: 'Check back later.' } },
    { now: T0 + 1 },
  ).record;

  it('round-trips a record through its JSON text', () => {
    const text = serializeGoal(goal);
    expect(typeof text).toBe('string');
    expect(parseGoal(text)).toEqual(goal);
    // A parsed object is accepted as well as text.
    expect(parseGoal(JSON.parse(text))).toEqual(goal);
  });

  it('loads the version 1 record written by 2.3 as it was written', () => {
    const text = fixture('goal-record-v1.json');
    const loaded = parseGoal(text);
    expect(loaded).toEqual(JSON.parse(text));
    expect(loaded).toMatchObject({
      version: 1,
      revision: 7,
      status: 'waiting',
      waiting: { reason: 'dependency' },
    });
    expect(JSON.parse(serializeGoal(loaded))).toEqual(JSON.parse(text));
  });

  it('loads a minimal version 1 record, filling what a writer may leave out', () => {
    const minimal = {
      kind: 'deuz-goal',
      version: 1,
      goalId: 'old',
      scope: 's',
      revision: 3,
      objective: 'x',
      criteria: [{ id: 'objective', description: 'x' }],
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    };
    expect(parseGoal(JSON.stringify(minimal))).toEqual({
      ...minimal,
      evidence: [],
      results: [],
      spent: { usd: 0, tokens: 0 },
      seen: [],
    });
  });

  it('keeps fields a later 2.x release added', () => {
    const later = { ...JSON.parse(serializeGoal(goal)), inbox: [{ key: 'k' }] };
    const loaded = parseGoal(later) as GoalRecord & { inbox?: unknown };
    expect(loaded.inbox).toEqual([{ key: 'k' }]);
    const next = transitionGoal(loaded, { type: 'resume' }, { now: T0 + 2 }).record;
    expect((next as GoalRecord & { inbox?: unknown }).inbox).toEqual([{ key: 'k' }]);
  });

  it('refuses a version it cannot read, and anything that is not a goal record', () => {
    const newer = { ...JSON.parse(serializeGoal(goal)), version: 2 };
    expect(() => parseGoal(newer)).toThrow(
      expect.objectContaining({ code: 'unsupported_version' }) as unknown as Error,
    );
    expect(() => parseGoal(newer)).toThrow(/version 2/);
    for (const input of ['not json', '[]', 'null', JSON.stringify({ kind: 'deuz-agent-run' })])
      expect(() => parseGoal(input), input).toThrow(GoalError);
  });

  it('refuses an invalid record, naming what is wrong', () => {
    const cases: [string, unknown][] = [
      ['revision', mutated(goal, (copy) => (copy.revision = 0))],
      ['status', mutated(goal, (copy) => (copy.status = 'done'))],
      ['waiting', mutated(goal, (copy) => delete copy.waiting)],
      ['waiting', mutated(goal, (copy) => (copy.status = 'active'))],
      ['outcome', mutated(goal, (copy) => (copy.outcome = { reason: 'accepted', at: T0 }))],
      ['criteria', mutated(goal, (copy) => (copy.criteria = []))],
      ['evidence', mutated(goal, (copy) => (copy.evidence = [{ id: 'e', source: 'rumour' }]))],
      [
        'results',
        mutated(
          goal,
          (copy) =>
            (copy.results = [
              { criterionId: 'nope', verdict: 'passed', source: 'test', evidence: [], at: T0 },
            ]),
        ),
      ],
      ['spent', mutated(goal, (copy) => (copy.spent = { usd: Number.NaN, tokens: 0 }))],
      ['seen', mutated(goal, (copy) => (copy.seen = [7]))],
      ['seen', mutated(goal, (copy) => (copy.seen = Array.from({ length: 65 }, (_, i) => `${i}`)))],
      ['meta', mutated(goal, (copy) => (copy.meta = [1]))],
      ['goalId', mutated(goal, (copy) => (copy.goalId = ''))],
    ];
    for (const [field, record] of cases) {
      let error: unknown;
      try {
        parseGoal(record);
      } catch (caught) {
        error = caught;
      }
      expect(error, field).toBeInstanceOf(GoalError);
      expect((error as GoalError).code, field).toBe('invalid_goal');
      expect((error as Error).message, field).toContain(field);
    }
  });

  it('refuses to serialize what JSON would change', () => {
    expect(() => serializeGoal({ ...goal, meta: { when: undefined } } as never)).not.toThrow();
    expect(() => serializeGoal({ ...goal, meta: { n: Number.POSITIVE_INFINITY } })).toThrow(
      GoalError,
    );
    expect(() => serializeGoal({ ...goal, meta: { f: () => 1 } } as never)).toThrow(GoalError);
  });
});
