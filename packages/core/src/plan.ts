/**
 * Task planning (1.8) — the planner half of a planner→executor→verifier loop.
 * `planTasks` decomposes a goal into an ordered `TaskList` (via `generateObject`),
 * and the pure reducers below track progress across steps. Persist the list to a
 * `Workspace` as `plan.json` (`serializeTaskList`/`parseTaskList`) so an
 * autonomous run's plan survives compaction, a durable checkpoint, or a restart
 * — Manus's "turn the goal into a to-do list and work through it".
 *
 * Edge-safe: pure data + one `generateObject` call through the normal seam.
 */
import type { LanguageModel } from './types/model';
import type { Dependencies } from './types/deps';
import type { JSONSchema } from './types/schema';
import { generateObject } from './inference/generate-object';

/** Lifecycle of a single task. */
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed';

/** One unit of work in a plan. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Free-form notes (result summary, failure reason, …). */
  notes?: string;
}

/** An ordered plan for a goal. Immutable — reducers return new lists. */
export interface TaskList {
  goal: string;
  tasks: Task[];
}

/** Build a `TaskList` from a goal and ordered task titles (ids `t1`, `t2`, …). */
export function createTaskList(goal: string, titles: string[]): TaskList {
  return {
    goal,
    tasks: titles.map((title, i) => ({ id: `t${i + 1}`, title, status: 'pending' })),
  };
}

/** Return a NEW list with `patch` applied to the task with `id` (no-op if absent). */
export function updateTask(list: TaskList, id: string, patch: Partial<Omit<Task, 'id'>>): TaskList {
  return {
    ...list,
    tasks: list.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  };
}

/** Sugar over `updateTask` for the common status (+ optional notes) transition. */
export function setTaskStatus(
  list: TaskList,
  id: string,
  status: TaskStatus,
  notes?: string,
): TaskList {
  return updateTask(list, id, notes !== undefined ? { status, notes } : { status });
}

/** The first task still `pending` (execution order), or `undefined` when none remain. */
export function nextPendingTask(list: TaskList): Task | undefined {
  return list.tasks.find((t) => t.status === 'pending');
}

/** Counts + completion ratio for a plan (drives progress UIs / stop conditions). */
export function taskListProgress(list: TaskList): {
  total: number;
  done: number;
  failed: number;
  pending: number;
  inProgress: number;
  ratio: number;
} {
  const total = list.tasks.length;
  const done = list.tasks.filter((t) => t.status === 'done').length;
  const failed = list.tasks.filter((t) => t.status === 'failed').length;
  const pending = list.tasks.filter((t) => t.status === 'pending').length;
  const inProgress = list.tasks.filter((t) => t.status === 'in_progress').length;
  return { total, done, failed, pending, inProgress, ratio: total === 0 ? 1 : done / total };
}

/** True when every task is terminal (`done` or `failed`). */
export function allTasksSettled(list: TaskList): boolean {
  return list.tasks.every((t) => t.status === 'done' || t.status === 'failed');
}

/** Serialize a plan for a workspace `plan.json` (stable, versioned). */
export function serializeTaskList(list: TaskList): string {
  return JSON.stringify({ version: 1, ...list }, null, 2);
}

/** Parse a plan from `plan.json`. Throws on a shape/version mismatch. */
export function parseTaskList(json: string): TaskList {
  const parsed = JSON.parse(json) as { version?: number; goal?: unknown; tasks?: unknown };
  if (parsed.version !== 1 || typeof parsed.goal !== 'string' || !Array.isArray(parsed.tasks)) {
    throw new Error('Invalid plan.json: expected { version: 1, goal: string, tasks: [] }.');
  }
  return { goal: parsed.goal, tasks: parsed.tasks as Task[] };
}

export interface PlanTasksOptions {
  model: LanguageModel;
  /** Extra planning guidance appended to the built-in planner system prompt. */
  system?: string;
  /** Cap the number of tasks kept from the model's plan. Default: no cap. */
  maxTasks?: number;
  signal?: AbortSignal;
  deps?: Dependencies;
}

const PLAN_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'Ordered, concrete, individually verifiable sub-tasks that achieve the goal.',
      items: { type: 'string' },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

const PLANNER_SYSTEM =
  'You are a planning module. Decompose the user goal into an ordered list of concrete, individually verifiable sub-tasks. Each task should be a single actionable step, specific enough to execute and check. Do not include meta-tasks like "make a plan". Return only the task list.';

/**
 * Decompose a goal into a `TaskList` using `generateObject`. The result is a
 * plain data structure you drive with the reducers here and persist to a
 * workspace — no agent class, no hidden runtime.
 */
export async function planTasks(goal: string, options: PlanTasksOptions): Promise<TaskList> {
  const system = options.system ? `${PLANNER_SYSTEM}\n\n${options.system}` : PLANNER_SYSTEM;
  const { object } = await generateObject<{ tasks: string[] }>({
    model: options.model,
    schema: PLAN_SCHEMA,
    schemaName: 'TaskPlan',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: goal },
    ],
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deps ? { deps: options.deps } : {}),
  });
  const titles = Array.isArray(object.tasks)
    ? object.tasks.filter((t) => typeof t === 'string')
    : [];
  return createTaskList(goal, options.maxTasks ? titles.slice(0, options.maxTasks) : titles);
}
