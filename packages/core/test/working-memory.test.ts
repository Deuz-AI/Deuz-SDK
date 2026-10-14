/**
 * Working memory (2.4, spec §2.5): a snapshot changes only through
 * schema-checked patches carrying an expected revision and an operation id.
 * The host alone sets the goal, the constraints and the task list and
 * confirms hypotheses and decisions; what a model adds is a proposal, and a
 * model changes only items it wrote.
 */
import { describe, expect, it } from 'vitest';
import {
  applyWorkingMemoryPatch,
  createWorkingMemory,
  type WorkingMemoryOperation,
  type WorkingMemoryPatch,
  type WorkingMemorySnapshot,
} from '../src/context/working-memory';
import type { TaskList } from '../src/plan';

const DIGEST = `sha256:${'e'.repeat(64)}` as const;

const plan = (): TaskList => ({
  goal: 'Ship 2.4',
  tasks: [
    { id: 't1', title: 'Build', status: 'done' },
    { id: 't2', title: 'Publish', status: 'pending' },
  ],
});

const base = (): WorkingMemorySnapshot =>
  createWorkingMemory({
    scope: 'tenant',
    goal: 'Ship 2.4',
    constraints: ['No force pushes', 'Keep 2.x compatible'],
    tasks: { list: plan(), activeTaskId: 't1' },
    goalRef: { goalId: 'g-1', specGeneration: 2 },
    now: 1_000,
  });

let sequence = 0;
const patch = (
  snapshot: WorkingMemorySnapshot,
  writer: 'host' | 'model',
  ...operations: WorkingMemoryOperation[]
): WorkingMemoryPatch => ({
  operationId: `op-${++sequence}`,
  expectedRevision: snapshot.revision,
  writer,
  operations,
});

/** Applies and expects `'applied'`: the new snapshot. */
const applied = (
  snapshot: WorkingMemorySnapshot,
  writer: 'host' | 'model',
  ...operations: WorkingMemoryOperation[]
): WorkingMemorySnapshot => {
  const result = applyWorkingMemoryPatch(snapshot, patch(snapshot, writer, ...operations), {
    now: 2_000 + snapshot.revision,
  });
  expect(result.status, JSON.stringify(result)).toBe('applied');
  return result.snapshot;
};

describe('createWorkingMemory', () => {
  it('starts at revision 0 with the host goal, constraints and a copy of the task list', () => {
    const list = plan();
    const snapshot = createWorkingMemory({
      scope: 'tenant',
      goal: 'Ship 2.4',
      constraints: ['No force pushes'],
      tasks: { list, activeTaskId: 't2' },
      now: 1_000,
    });
    expect(snapshot).toEqual({
      kind: 'deuz-working-memory',
      version: 1,
      revision: 0,
      scope: 'tenant',
      goal: { text: 'Ship 2.4', writer: 'host', revision: 0, at: 1_000 },
      constraints: [
        { id: 'constraints-0-0', text: 'No force pushes', writer: 'host', revision: 0, at: 1_000 },
      ],
      tasks: { list: plan(), listRevision: 1, activeTaskId: 't2' },
      observations: [],
      hypotheses: [],
      decisions: [],
      questions: [],
      attempts: [],
      applied: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    // The snapshot holds the list itself, not a reference to the planner's.
    list.tasks[1]!.status = 'done';
    list.tasks.push({ id: 't3', title: 'Announce', status: 'pending' });
    expect(snapshot.tasks?.list).toEqual(plan());
  });

  it('keeps the supervised goal reference, and starts empty without goal or tasks', () => {
    expect(base().goalRef).toEqual({ goalId: 'g-1', specGeneration: 2 });
    const empty = createWorkingMemory({ scope: 's', now: 5 });
    expect(empty).not.toHaveProperty('goal');
    expect(empty).not.toHaveProperty('tasks');
    expect(empty.constraints).toEqual([]);
  });

  it('refuses malformed input with a TypeError', () => {
    const cases: unknown[] = [
      undefined,
      { now: 1 },
      { scope: '', now: 1 },
      { scope: 's' },
      { scope: 's', now: Number.NaN },
      { scope: 's', now: 1, goal: '  ' },
      { scope: 's', now: 1, constraints: ['ok', ''] },
      { scope: 's', now: 1, tasks: { list: { goal: 'g', tasks: [{ id: 't1' }] } } },
      { scope: 's', now: 1, tasks: { list: plan(), activeTaskId: 'nope' } },
      {
        scope: 's',
        now: 1,
        tasks: {
          list: {
            goal: 'g',
            tasks: [
              { id: 'a', title: 'x', status: 'pending' },
              { id: 'a', title: 'y', status: 'pending' },
            ],
          },
        },
      },
      { scope: 's', now: 1, goalRef: { goalId: '' } },
    ];
    for (const input of cases)
      expect(() => createWorkingMemory(input as never), JSON.stringify(input)).toThrow(TypeError);
  });
});

describe('applyWorkingMemoryPatch: revision, operation id and atomicity', () => {
  it('applies a patch whole: revision plus one, the operation id kept, changed items stamped', () => {
    const snapshot = base();
    const result = applyWorkingMemoryPatch(
      snapshot,
      {
        operationId: 'op-a',
        expectedRevision: 0,
        writer: 'model',
        operations: [
          {
            op: 'add-observation',
            text: 'CI is green',
            sources: [{ kind: 'tool', toolCallId: 'c1', digest: DIGEST }],
          },
          { op: 'add-question', text: 'Which registry?' },
        ],
      },
      { now: 5_000 },
    );
    expect(result.status).toBe('applied');
    const next = result.snapshot;
    expect(next.revision).toBe(1);
    expect(next.applied).toEqual(['op-a']);
    expect(next.updatedAt).toBe(5_000);
    expect(next.createdAt).toBe(1_000);
    expect(next.observations).toEqual([
      {
        id: 'observations-1-0',
        text: 'CI is green',
        writer: 'model',
        revision: 1,
        at: 5_000,
        sources: [{ kind: 'tool', toolCallId: 'c1', digest: DIGEST }],
      },
    ]);
    expect(next.questions).toEqual([
      {
        id: 'questions-1-1',
        text: 'Which registry?',
        writer: 'model',
        revision: 1,
        at: 5_000,
        status: 'open',
      },
    ]);
  });

  it('never mutates the snapshot it was given', () => {
    const snapshot = base();
    const frozen = structuredClone(snapshot);
    applied(
      snapshot,
      'host',
      { op: 'set-goal', text: 'Ship 2.5' },
      { op: 'add-constraint', text: 'x' },
    );
    applyWorkingMemoryPatch(snapshot, patch(snapshot, 'model', { op: 'set-goal', text: 'y' }), {
      now: 1,
    });
    expect(snapshot).toEqual(frozen);
  });

  it('answers a replayed operation id with duplicate and changes nothing', () => {
    const snapshot = base();
    const first = applyWorkingMemoryPatch(
      snapshot,
      {
        operationId: 'replayed',
        expectedRevision: 0,
        writer: 'model',
        operations: [{ op: 'add-observation', text: 'a' }],
      },
      { now: 2_000 },
    );
    const again = applyWorkingMemoryPatch(
      first.snapshot,
      {
        operationId: 'replayed',
        expectedRevision: 1,
        writer: 'model',
        operations: [{ op: 'add-observation', text: 'a' }],
      },
      { now: 3_000 },
    );
    expect(again.status).toBe('duplicate');
    expect(again.snapshot).toBe(first.snapshot);
    expect(again.snapshot.observations).toHaveLength(1);
  });

  it('answers a stale expected revision with conflict and changes nothing', () => {
    const snapshot = applied(base(), 'model', { op: 'add-observation', text: 'a' });
    const stale = applyWorkingMemoryPatch(
      snapshot,
      {
        operationId: 'late',
        expectedRevision: 0,
        writer: 'model',
        operations: [{ op: 'add-observation', text: 'b' }],
      },
      { now: 9 },
    );
    expect(stale.status).toBe('conflict');
    expect(stale.snapshot).toBe(snapshot);
  });

  it('rejects the whole patch at the first refused operation, with its index and reason', () => {
    const snapshot = base();
    const result = applyWorkingMemoryPatch(
      snapshot,
      patch(
        snapshot,
        'model',
        { op: 'add-observation', text: 'fine' },
        { op: 'add-question', text: 'fine too' },
        { op: 'set-goal', text: 'take over' },
      ),
      { now: 9 },
    );
    expect(result).toEqual({ status: 'rejected', snapshot, reason: 'forbidden', operation: 2 });
    expect(result.snapshot.observations).toEqual([]);
    expect(result.snapshot.revision).toBe(0);
  });

  it('keeps the last 64 operation ids, oldest dropped first', () => {
    let snapshot = base();
    for (let index = 0; index < 70; index++)
      snapshot = applyWorkingMemoryPatch(
        snapshot,
        {
          operationId: `bulk-${index}`,
          expectedRevision: snapshot.revision,
          writer: 'model',
          operations: [{ op: 'add-observation', text: `o${index}` }],
        },
        { now: index },
      ).snapshot;
    expect(snapshot.revision).toBe(70);
    expect(snapshot.applied).toHaveLength(64);
    expect(snapshot.applied[0]).toBe('bulk-6');
    expect(snapshot.applied.at(-1)).toBe('bulk-69');
  });

  it('uses generateId for added items without an id, and refuses an id that exists', () => {
    const snapshot = base();
    const ids = ['first', 'first'];
    const result = applyWorkingMemoryPatch(
      snapshot,
      patch(
        snapshot,
        'model',
        { op: 'add-observation', text: 'a' },
        { op: 'add-observation', text: 'b' },
      ),
      { now: 1, generateId: () => ids.shift()! },
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'duplicate-id', operation: 1 });
    const own = applied(snapshot, 'model', { op: 'add-observation', id: 'mine', text: 'a' });
    expect(own.observations[0]?.id).toBe('mine');
    const clash = applyWorkingMemoryPatch(
      own,
      patch(own, 'model', { op: 'add-observation', id: 'mine', text: 'b' }),
      { now: 1 },
    );
    expect(clash).toMatchObject({ status: 'rejected', reason: 'duplicate-id', operation: 0 });
  });

  it('refuses a malformed snapshot, patch or options with a TypeError', () => {
    const snapshot = base();
    const ok = patch(snapshot, 'host', { op: 'set-goal', text: 'x' });
    expect(() =>
      applyWorkingMemoryPatch({ ...snapshot, kind: 'x' } as never, ok, { now: 1 }),
    ).toThrow(TypeError);
    for (const bad of [
      { ...ok, operationId: '' },
      { ...ok, writer: 'system' },
      { ...ok, expectedRevision: 1.5 },
      { ...ok, operations: [] },
      { ...ok, operations: 'set-goal' },
    ])
      expect(() => applyWorkingMemoryPatch(snapshot, bad as never, { now: 1 })).toThrow(TypeError);
    expect(() => applyWorkingMemoryPatch(snapshot, ok, {} as never)).toThrow(TypeError);
  });
});

describe('applyWorkingMemoryPatch: who may change what', () => {
  it.each<[string, WorkingMemoryOperation]>([
    ['set the goal', { op: 'set-goal', text: 'mine now' }],
    ['add a constraint', { op: 'add-constraint', text: 'none' }],
    ['remove a constraint', { op: 'remove-constraint', id: 'constraints-0-0' }],
    ['replace the task list', { op: 'set-tasks', list: plan() }],
    ['confirm a hypothesis', { op: 'set-hypothesis-status', id: 'h', status: 'confirmed' }],
    ['accept a decision', { op: 'set-decision-status', id: 'd', status: 'accepted' }],
  ])('refuses a model that tries to %s', (_name, operation) => {
    const snapshot = base();
    expect(
      applyWorkingMemoryPatch(snapshot, patch(snapshot, 'model', operation), { now: 1 }),
    ).toMatchObject({
      status: 'rejected',
      reason: 'forbidden',
      operation: 0,
    });
  });

  it('lets the host set the goal and the constraints', () => {
    const next = applied(
      base(),
      'host',
      { op: 'set-goal', text: 'Ship 2.4.1' },
      { op: 'remove-constraint', id: 'constraints-0-1' },
      {
        op: 'add-constraint',
        id: 'c-new',
        text: 'Tag every release',
        sources: [{ kind: 'host', digest: DIGEST }],
      },
    );
    expect(next.goal).toEqual({ text: 'Ship 2.4.1', writer: 'host', revision: 1, at: 2_000 });
    expect(next.constraints.map((constraint) => constraint.id)).toEqual([
      'constraints-0-0',
      'c-new',
    ]);
    expect(next.constraints[1]).toMatchObject({
      writer: 'host',
      revision: 1,
      sources: [{ kind: 'host' }],
    });
  });

  it('keeps a model hypothesis and decision proposed until the host confirms or accepts them', () => {
    let snapshot = applied(
      base(),
      'model',
      { op: 'add-hypothesis', id: 'h', text: 'The registry is slow' },
      { op: 'add-decision', id: 'd', text: 'Publish from CI', rationale: 'Provenance' },
    );
    expect(snapshot.hypotheses[0]).toMatchObject({ status: 'proposed', writer: 'model' });
    expect(snapshot.decisions[0]).toMatchObject({
      status: 'proposed',
      writer: 'model',
      rationale: 'Provenance',
    });
    snapshot = applied(
      snapshot,
      'host',
      { op: 'set-hypothesis-status', id: 'h', status: 'confirmed' },
      { op: 'set-decision-status', id: 'd', status: 'accepted' },
    );
    expect(snapshot.hypotheses[0]).toMatchObject({
      status: 'confirmed',
      writer: 'host',
      revision: 2,
    });
    expect(snapshot.decisions[0]).toMatchObject({
      status: 'accepted',
      writer: 'host',
      revision: 2,
    });
    snapshot = applied(snapshot, 'host', {
      op: 'set-decision-status',
      id: 'd',
      status: 'reverted',
    });
    expect(snapshot.decisions[0]?.status).toBe('reverted');
  });

  it('records a host decision as accepted and a host hypothesis as proposed', () => {
    const snapshot = applied(
      base(),
      'host',
      { op: 'add-decision', text: 'Use npm 11' },
      { op: 'add-hypothesis', text: 'Maybe' },
    );
    expect(snapshot.decisions[0]?.status).toBe('accepted');
    expect(snapshot.hypotheses[0]?.status).toBe('proposed');
  });

  it('lets a model change only the items it wrote', () => {
    let snapshot = applied(
      base(),
      'host',
      { op: 'add-question', id: 'hq', text: 'Host question?' },
      { op: 'record-attempt', id: 'ha', text: 'Host attempt', outcome: 'in-progress' },
      { op: 'add-observation', id: 'ho', text: 'Host observation' },
    );
    snapshot = applied(
      snapshot,
      'model',
      { op: 'add-question', id: 'mq', text: 'Model question?' },
      { op: 'record-attempt', id: 'ma', text: 'Model attempt', outcome: 'in-progress' },
      { op: 'add-observation', id: 'mo', text: 'Model observation' },
    );
    for (const operation of [
      { op: 'answer-question', id: 'hq', answer: 'x' },
      { op: 'drop-question', id: 'hq' },
      { op: 'update-attempt', id: 'ha', outcome: 'failed' },
      { op: 'remove', list: 'observations', id: 'ho' },
    ] as WorkingMemoryOperation[])
      expect(
        applyWorkingMemoryPatch(snapshot, patch(snapshot, 'model', operation), { now: 1 }),
        operation.op,
      ).toMatchObject({ status: 'rejected', reason: 'forbidden' });
    const next = applied(
      snapshot,
      'model',
      { op: 'answer-question', id: 'mq', answer: 'npm' },
      { op: 'update-attempt', id: 'ma', outcome: 'failed', detail: 'timeout' },
      { op: 'remove', list: 'observations', id: 'mo' },
    );
    expect(next.questions.find((question) => question.id === 'mq')).toMatchObject({
      status: 'answered',
      answer: 'npm',
      revision: 3,
    });
    expect(next.attempts.find((attempt) => attempt.id === 'ma')).toMatchObject({
      outcome: 'failed',
      detail: 'timeout',
    });
    expect(next.observations.map((observation) => observation.id)).toEqual(['ho']);
    // The host may remove anything.
    const cleared = applied(
      next,
      'host',
      { op: 'remove', list: 'observations', id: 'ho' },
      { op: 'drop-question', id: 'mq' },
    );
    expect(cleared.observations).toEqual([]);
    expect(cleared.questions.find((question) => question.id === 'mq')).toMatchObject({
      status: 'dropped',
      writer: 'host',
    });
  });

  it('never lets a model cite the host as its source', () => {
    const snapshot = base();
    const result = applyWorkingMemoryPatch(
      snapshot,
      patch(snapshot, 'model', {
        op: 'add-observation',
        text: 'The host said so',
        sources: [{ kind: 'host', digest: DIGEST }],
      }),
      { now: 1 },
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'forbidden', operation: 0 });
  });
});

describe('applyWorkingMemoryPatch: the task list', () => {
  it('replaces the task list with a copy, bumps listRevision and keeps a surviving active task', () => {
    const list = {
      ...plan(),
      tasks: [...plan().tasks, { id: 't3', title: 'Announce', status: 'pending' as const }],
    };
    const next = applied(base(), 'host', { op: 'set-tasks', list });
    expect(next.tasks).toEqual({ list, listRevision: 2, activeTaskId: 't1' });
    list.tasks.pop();
    expect(next.tasks?.list.tasks).toHaveLength(3);
    const moved = applied(next, 'host', {
      op: 'set-tasks',
      list: { goal: 'g', tasks: [{ id: 'x', title: 'X', status: 'pending' }] },
    });
    expect(moved.tasks).toMatchObject({ listRevision: 3 });
    expect(moved.tasks).not.toHaveProperty('activeTaskId');
    const chosen = applied(moved, 'host', { op: 'set-tasks', list: plan(), activeTaskId: 't2' });
    expect(chosen.tasks).toMatchObject({ listRevision: 4, activeTaskId: 't2' });
  });

  it('moves or clears the active task, for the host or the model, only to a task the list has', () => {
    const moved = applied(base(), 'model', { op: 'set-active-task', taskId: 't2' });
    expect(moved.tasks).toMatchObject({ activeTaskId: 't2', listRevision: 1 });
    const cleared = applied(moved, 'host', { op: 'set-active-task', taskId: null });
    expect(cleared.tasks).not.toHaveProperty('activeTaskId');
    expect(
      applyWorkingMemoryPatch(
        moved,
        patch(moved, 'model', { op: 'set-active-task', taskId: 'nope' }),
        { now: 1 },
      ),
    ).toMatchObject({ status: 'rejected', reason: 'unknown-id' });
    const empty = createWorkingMemory({ scope: 's', now: 1 });
    expect(
      applyWorkingMemoryPatch(
        empty,
        patch(empty, 'host', { op: 'set-active-task', taskId: 't1' }),
        { now: 1 },
      ),
    ).toMatchObject({ status: 'rejected', reason: 'unknown-id' });
  });

  it('refuses a malformed task list or an active task it does not have', () => {
    const snapshot = base();
    for (const [operation, reason] of [
      [
        {
          op: 'set-tasks',
          list: { goal: 'g', tasks: [{ id: '', title: 'x', status: 'pending' }] },
        },
        'invalid',
      ],
      [
        { op: 'set-tasks', list: { goal: 'g', tasks: [{ id: 'a', title: 'x', status: 'later' }] } },
        'invalid',
      ],
      [{ op: 'set-tasks', list: plan(), activeTaskId: 'zzz' }, 'unknown-id'],
    ] as [WorkingMemoryOperation, string][])
      expect(
        applyWorkingMemoryPatch(snapshot, patch(snapshot, 'host', operation), { now: 1 }),
      ).toMatchObject({
        status: 'rejected',
        reason,
      });
  });
});

describe('applyWorkingMemoryPatch: malformed operations', () => {
  it.each<[string, unknown, string]>([
    ['an unknown op', { op: 'rewrite', path: '/goal' }, 'invalid'],
    ['a free-form JSON Patch', { op: 'replace', path: '/goal/writer', value: 'model' }, 'invalid'],
    ['empty text', { op: 'add-observation', text: '   ' }, 'invalid'],
    ['a non-string id', { op: 'add-observation', id: 7, text: 'x' }, 'invalid'],
    [
      'malformed sources',
      { op: 'add-observation', text: 'x', sources: [{ kind: 'tool' }] },
      'invalid',
    ],
    ['an unknown list', { op: 'remove', list: 'constraints', id: 'constraints-0-0' }, 'invalid'],
    ['an unknown status', { op: 'set-hypothesis-status', id: 'h', status: 'maybe' }, 'invalid'],
    ['an unknown outcome', { op: 'record-attempt', text: 'x', outcome: 'meh' }, 'invalid'],
    ['an empty answer', { op: 'answer-question', id: 'q', answer: '' }, 'invalid'],
    ['an unknown id', { op: 'remove', list: 'observations', id: 'ghost' }, 'unknown-id'],
    ['an unknown constraint', { op: 'remove-constraint', id: 'ghost' }, 'unknown-id'],
    ['a non-object', 'set-goal', 'invalid'],
  ])('refuses %s', (_name, operation, reason) => {
    const snapshot = applied(
      base(),
      'host',
      { op: 'add-hypothesis', id: 'h', text: 'x' },
      { op: 'add-question', id: 'q', text: 'y?' },
    );
    expect(
      applyWorkingMemoryPatch(
        snapshot,
        patch(snapshot, 'host', operation as WorkingMemoryOperation),
        { now: 1 },
      ),
    ).toMatchObject({ status: 'rejected', reason, operation: 0 });
  });
});
