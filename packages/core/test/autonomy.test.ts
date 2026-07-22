import { describe, it, expect } from 'vitest';
import {
  createTaskList,
  updateTask,
  setTaskStatus,
  nextPendingTask,
  taskListProgress,
  allTasksSettled,
  serializeTaskList,
  parseTaskList,
  planTasks,
  bestOfN,
  selfConsistency,
  parallelAgents,
} from '../src/autonomy';
import { createMockModel } from '../src/testing';

describe('TaskList reducers (pure)', () => {
  it('creates, updates, and reports progress immutably', () => {
    const list = createTaskList('ship it', ['research', 'build', 'test']);
    expect(list.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(nextPendingTask(list)!.id).toBe('t1');

    const started = setTaskStatus(list, 't1', 'in_progress');
    expect(list.tasks[0]!.status).toBe('pending'); // original untouched (immutable)
    expect(started.tasks[0]!.status).toBe('in_progress');

    const done = setTaskStatus(setTaskStatus(started, 't1', 'done', 'ok'), 't2', 'done');
    const prog = taskListProgress(done);
    expect(prog).toMatchObject({ total: 3, done: 2, pending: 1 });
    expect(prog.ratio).toBeCloseTo(2 / 3);
    expect(nextPendingTask(done)!.id).toBe('t3');
    expect(allTasksSettled(done)).toBe(false);

    const finished = setTaskStatus(done, 't3', 'failed');
    expect(allTasksSettled(finished)).toBe(true);
    expect(updateTask(finished, 'missing', { status: 'done' })).toEqual(finished); // no-op
  });

  it('round-trips through plan.json', () => {
    const list = setTaskStatus(createTaskList('goal', ['a', 'b']), 't1', 'done', 'note');
    const restored = parseTaskList(serializeTaskList(list));
    expect(restored).toEqual(list);
    expect(() => parseTaskList('{"version":2}')).toThrow();
  });
});

describe('planTasks', () => {
  it('decomposes a goal into a pending TaskList via generateObject', async () => {
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'TaskPlan', args: { tasks: ['research', 'draft', 'review'] } }] },
      ],
    });
    const plan = await planTasks('write an essay', { model });
    expect(plan.goal).toBe('write an essay');
    expect(plan.tasks.map((t) => t.title)).toEqual(['research', 'draft', 'review']);
    expect(plan.tasks.every((t) => t.status === 'pending')).toBe(true);
  });

  it('respects maxTasks', async () => {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'TaskPlan', args: { tasks: ['a', 'b', 'c', 'd'] } }] }],
    });
    const plan = await planTasks('goal', { model, maxTasks: 2 });
    expect(plan.tasks.map((t) => t.title)).toEqual(['a', 'b']);
  });
});

describe('bestOfN', () => {
  it('returns the highest-scoring candidate (first-highest on a tie)', async () => {
    const r = await bestOfN({
      n: 3,
      generate: (i) => `cand${i}`,
      score: (_v, i) => i,
    });
    expect(r.best).toBe('cand2');
    expect(r.bestScore).toBe(2);
    expect(r.candidates).toHaveLength(3);
  });
});

describe('selfConsistency', () => {
  it('majority-votes candidates by key', async () => {
    const r = await selfConsistency({ n: 5, generate: (i) => (i % 2 === 0 ? 'A' : 'B') });
    expect(r.answer).toBe('A'); // 0,2,4 → A (3) vs 1,3 → B (2)
    expect(r.votes).toBe(3);
    expect(r.total).toBe(5);
    expect(r.tally[0]).toMatchObject({ key: '"A"', votes: 3 });
  });
});

describe('parallelAgents (Wide Research fan-out)', () => {
  it('runs one agent per task and sums usage, preserving order + labels', async () => {
    const model = createMockModel({
      responses: [{ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } }],
    });
    const r = await parallelAgents({
      model,
      tasks: ['task one', { prompt: 'task two', label: 'two' }],
      concurrency: 2,
    });
    expect(r.results).toHaveLength(2);
    expect(r.results[0]!.text).toBe('done');
    expect(r.results[0]!.prompt).toBe('task one');
    expect(r.results[1]!.label).toBe('two');
    expect(r.usage.totalTokens).toBe(30); // 2 × (10 + 5)
  });
});
