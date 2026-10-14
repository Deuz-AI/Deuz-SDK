/**
 * The working memory patch engine (2.4, spec §2.5): snapshot creation and the
 * one way a snapshot changes. Pure and deterministic: no clock (the caller
 * passes `now`), no randomness (ids come from the revision and the operation
 * index, or the caller's generator), and the input snapshot is never
 * mutated. Edge-safe.
 *
 * There is no free-form JSON Patch: each operation names one schema-checked
 * change, and the engine alone stamps the writer, the revision and the time,
 * so no patch can touch an internal field (`writer`, `revision`, `applied`).
 */
import { isSha256Digest } from '../../internal/digest';
import type { MemorySourceKind, MemorySourceRef } from '../../memory/versioned/types';
import type { Task, TaskList, TaskStatus } from '../../plan';
import type {
  ApplyWorkingMemoryPatchOptions,
  CreateWorkingMemoryInput,
  WorkingMemoryAttempt,
  WorkingMemoryItemBase,
  WorkingMemoryList,
  WorkingMemoryOperation,
  WorkingMemoryPatch,
  WorkingMemoryPatchResult,
  WorkingMemoryRejection,
  WorkingMemorySnapshot,
  WorkingMemoryWriter,
} from './types';

/** Operation ids a snapshot remembers for replay dedupe. */
export const WORKING_MEMORY_APPLIED_LIMIT = 64;

const LISTS: readonly WorkingMemoryList[] = [
  'observations',
  'hypotheses',
  'decisions',
  'questions',
  'attempts',
];
const HOST_ONLY: ReadonlySet<string> = new Set([
  'set-goal',
  'add-constraint',
  'remove-constraint',
  'set-tasks',
  'set-hypothesis-status',
  'set-decision-status',
]);
const SOURCE_KINDS: readonly MemorySourceKind[] = ['user', 'assistant', 'tool', 'external', 'host'];
const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'done', 'failed'];
const OUTCOMES: readonly WorkingMemoryAttempt['outcome'][] = [
  'in-progress',
  'succeeded',
  'failed',
  'abandoned',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Why a task list is malformed, or undefined when it is a `TaskList` with unique task ids. */
function taskListProblem(list: unknown): string | undefined {
  if (!isObject(list) || typeof list.goal !== 'string' || !Array.isArray(list.tasks))
    return 'a task list needs a goal and a tasks list';
  const ids = new Set<string>();
  for (const task of list.tasks) {
    if (
      !isObject(task) ||
      !isId(task.id) ||
      typeof task.title !== 'string' ||
      !TASK_STATUSES.includes(task.status as TaskStatus) ||
      (task.notes !== undefined && typeof task.notes !== 'string')
    )
      return 'every task needs an id, a title and a known status';
    if (ids.has(task.id)) return `task id ${JSON.stringify(task.id)} appears twice`;
    ids.add(task.id);
  }
  return undefined;
}

/** A copy of the task list: the planner's record, never a reference to it. */
function copyTaskList(list: TaskList): TaskList {
  return {
    goal: list.goal,
    tasks: list.tasks.map((task): Task => ({ ...task })),
  };
}

function hasTask(list: TaskList, id: string): boolean {
  return list.tasks.some((task) => task.id === id);
}

/**
 * Checks sources: `MemorySourceRef`s with a known kind and a sha256 digest.
 * Returns the copies to store, `'invalid'`, or `'forbidden'` for a model
 * that cites the host.
 */
function checkSources(
  value: unknown,
  writer: WorkingMemoryWriter,
): MemorySourceRef[] | undefined | 'invalid' | 'forbidden' {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return 'invalid';
  const sources: MemorySourceRef[] = [];
  for (const source of value) {
    if (
      !isObject(source) ||
      !SOURCE_KINDS.includes(source.kind as MemorySourceKind) ||
      !isSha256Digest(source.digest)
    )
      return 'invalid';
    for (const key of ['runId', 'chatId', 'messageId', 'toolCallId', 'toolName', 'uri'])
      if (source[key] !== undefined && typeof source[key] !== 'string') return 'invalid';
    if (writer === 'model' && source.kind === 'host') return 'forbidden';
    sources.push({ ...(source as unknown as MemorySourceRef) });
  }
  return sources;
}

/** Throws a TypeError unless `value` is a version 1 working memory snapshot. */
export function assertWorkingMemorySnapshot(
  value: unknown,
): asserts value is WorkingMemorySnapshot {
  if (
    !isObject(value) ||
    value.kind !== 'deuz-working-memory' ||
    value.version !== 1 ||
    !isCount(value.revision) ||
    typeof value.scope !== 'string' ||
    !Array.isArray(value.constraints) ||
    !LISTS.every((list) => Array.isArray(value[list])) ||
    !Array.isArray(value.applied)
  )
    throw new TypeError('Expected a deuz-working-memory snapshot, version 1.');
}

/** See `createWorkingMemory`. */
export function createSnapshot(input: CreateWorkingMemoryInput): WorkingMemorySnapshot {
  if (!isObject(input)) throw new TypeError('createWorkingMemory needs an input object.');
  const { scope, goal, constraints = [], tasks, goalRef, now } = input;
  if (!isId(scope)) throw new TypeError('createWorkingMemory needs a non-empty scope.');
  if (!Number.isFinite(now)) throw new TypeError('createWorkingMemory needs now (epoch ms).');
  if (goal !== undefined && !isText(goal))
    throw new TypeError('The working memory goal must be non-empty text.');
  if (!Array.isArray(constraints) || !constraints.every(isText))
    throw new TypeError('Every working memory constraint must be non-empty text.');
  if (tasks !== undefined) {
    const problem = isObject(tasks) ? taskListProblem(tasks.list) : 'tasks needs a list';
    if (problem) throw new TypeError(`Invalid working memory tasks: ${problem}.`);
    if (tasks.activeTaskId !== undefined && !hasTask(tasks.list, tasks.activeTaskId))
      throw new TypeError(
        `The active task ${JSON.stringify(tasks.activeTaskId)} is not in the task list.`,
      );
  }
  if (
    goalRef !== undefined &&
    (!isObject(goalRef) ||
      !isId(goalRef.goalId) ||
      (goalRef.specGeneration !== undefined && !isCount(goalRef.specGeneration)))
  )
    throw new TypeError('goalRef needs a goalId, and a specGeneration that is a whole number.');
  return {
    kind: 'deuz-working-memory',
    version: 1,
    revision: 0,
    scope,
    ...(goalRef !== undefined
      ? {
          goalRef: {
            goalId: goalRef.goalId,
            ...(goalRef.specGeneration !== undefined
              ? { specGeneration: goalRef.specGeneration }
              : {}),
          },
        }
      : {}),
    ...(goal !== undefined ? { goal: { text: goal, writer: 'host', revision: 0, at: now } } : {}),
    constraints: constraints.map((text, index) => ({
      id: `constraints-0-${index}`,
      text,
      writer: 'host',
      revision: 0,
      at: now,
    })),
    ...(tasks !== undefined
      ? {
          tasks: {
            list: copyTaskList(tasks.list),
            listRevision: 1,
            ...(tasks.activeTaskId !== undefined ? { activeTaskId: tasks.activeTaskId } : {}),
          },
        }
      : {}),
    observations: [],
    hypotheses: [],
    decisions: [],
    questions: [],
    attempts: [],
    applied: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** What every operation of one patch shares. */
interface PatchContext {
  draft: WorkingMemorySnapshot;
  writer: WorkingMemoryWriter;
  /** The revision the patch creates. */
  revision: number;
  now: number;
  generateId?: () => string;
}

/** An item's stamp: who changed it, in which revision, when. */
function stamp(ctx: PatchContext): Pick<WorkingMemoryItemBase, 'writer' | 'revision' | 'at'> {
  return { writer: ctx.writer, revision: ctx.revision, at: ctx.now };
}

/**
 * The id of an added item: its own, the caller's generator's, or
 * `<list>-<revision>-<index>`. `'invalid'` or `'duplicate-id'` when unusable.
 */
function newId(
  ctx: PatchContext,
  list: readonly { id: string }[],
  name: string,
  index: number,
  given: unknown,
): string | WorkingMemoryRejection {
  if (given !== undefined && !isId(given)) return 'invalid';
  const id = given ?? (ctx.generateId ? ctx.generateId() : `${name}-${ctx.revision}-${index}`);
  if (!isId(id)) return 'invalid';
  return list.some((item) => item.id === id) ? 'duplicate-id' : id;
}

/**
 * The item a change targets: `'unknown-id'` when the list lacks it,
 * `'forbidden'` when a model targets an item the host wrote last.
 */
function target<T extends WorkingMemoryItemBase>(
  ctx: PatchContext,
  list: T[],
  id: unknown,
): T | WorkingMemoryRejection {
  if (!isId(id)) return 'invalid';
  const item = list.find((candidate) => candidate.id === id);
  if (!item) return 'unknown-id';
  if (ctx.writer === 'model' && item.writer === 'host') return 'forbidden';
  return item;
}

/** Applies one checked operation to the draft; returns why it was refused, or nothing. */
function applyOperation(
  ctx: PatchContext,
  operation: unknown,
  index: number,
): WorkingMemoryRejection | undefined {
  if (!isObject(operation) || typeof operation.op !== 'string') return 'invalid';
  const op = operation as Record<string, unknown> & { op: WorkingMemoryOperation['op'] };
  if (ctx.writer === 'model' && HOST_ONLY.has(op.op)) return 'forbidden';
  const { draft } = ctx;
  const add = <T extends WorkingMemoryItemBase>(
    list: T[],
    name: WorkingMemoryList | 'constraints',
    fields: Omit<T, keyof WorkingMemoryItemBase>,
  ): WorkingMemoryRejection | undefined => {
    if (!isText(op.text)) return 'invalid';
    const sources = checkSources(op.sources, ctx.writer);
    if (sources === 'invalid' || sources === 'forbidden') return sources;
    const id = newId(ctx, list, name, index, op.id);
    if (id === 'invalid' || id === 'duplicate-id') return id;
    list.push({
      id,
      text: op.text,
      ...stamp(ctx),
      ...(sources !== undefined ? { sources } : {}),
      ...fields,
    } as unknown as T);
    return undefined;
  };

  switch (op.op) {
    case 'set-goal':
      if (!isText(op.text)) return 'invalid';
      draft.goal = { text: op.text, writer: 'host', revision: ctx.revision, at: ctx.now };
      return undefined;
    case 'add-constraint':
      return add(draft.constraints, 'constraints', {});
    case 'remove-constraint': {
      if (!isId(op.id)) return 'invalid';
      const at = draft.constraints.findIndex((constraint) => constraint.id === op.id);
      if (at < 0) return 'unknown-id';
      draft.constraints.splice(at, 1);
      return undefined;
    }
    case 'set-tasks': {
      if (taskListProblem(op.list)) return 'invalid';
      const list = copyTaskList(op.list as TaskList);
      if (
        op.activeTaskId !== undefined &&
        (!isId(op.activeTaskId) || !hasTask(list, op.activeTaskId))
      )
        return 'unknown-id';
      const previous = draft.tasks?.activeTaskId;
      const active =
        (op.activeTaskId as string | undefined) ??
        (previous !== undefined && hasTask(list, previous) ? previous : undefined);
      draft.tasks = {
        list,
        listRevision: (draft.tasks?.listRevision ?? 0) + 1,
        ...(active !== undefined ? { activeTaskId: active } : {}),
      };
      return undefined;
    }
    case 'set-active-task': {
      if (op.taskId === null) {
        if (draft.tasks) delete draft.tasks.activeTaskId;
        return undefined;
      }
      if (!isId(op.taskId)) return 'invalid';
      if (!draft.tasks || !hasTask(draft.tasks.list, op.taskId)) return 'unknown-id';
      draft.tasks.activeTaskId = op.taskId;
      return undefined;
    }
    case 'add-observation':
      return add(draft.observations, 'observations', {});
    case 'add-hypothesis':
      // A hypothesis is a proposal whoever writes it; only the host confirms one.
      return add(draft.hypotheses, 'hypotheses', { status: 'proposed' });
    case 'set-hypothesis-status': {
      if (op.status !== 'confirmed' && op.status !== 'rejected') return 'invalid';
      const item = target(ctx, draft.hypotheses, op.id);
      if (typeof item === 'string') return item;
      Object.assign(item, { status: op.status, ...stamp(ctx) });
      return undefined;
    }
    case 'add-decision':
      if (op.rationale !== undefined && !isText(op.rationale)) return 'invalid';
      return add(draft.decisions, 'decisions', {
        status: ctx.writer === 'host' ? 'accepted' : 'proposed',
        ...(op.rationale !== undefined ? { rationale: op.rationale } : {}),
      });
    case 'set-decision-status': {
      if (op.status !== 'accepted' && op.status !== 'reverted') return 'invalid';
      const item = target(ctx, draft.decisions, op.id);
      if (typeof item === 'string') return item;
      Object.assign(item, { status: op.status, ...stamp(ctx) });
      return undefined;
    }
    case 'add-question':
      if (op.sources !== undefined) return 'invalid';
      return add(draft.questions, 'questions', { status: 'open' });
    case 'answer-question': {
      if (!isText(op.answer)) return 'invalid';
      const item = target(ctx, draft.questions, op.id);
      if (typeof item === 'string') return item;
      Object.assign(item, { status: 'answered', answer: op.answer, ...stamp(ctx) });
      return undefined;
    }
    case 'drop-question': {
      const item = target(ctx, draft.questions, op.id);
      if (typeof item === 'string') return item;
      Object.assign(item, { status: 'dropped', ...stamp(ctx) });
      return undefined;
    }
    case 'record-attempt':
      if (!OUTCOMES.includes(op.outcome as WorkingMemoryAttempt['outcome'])) return 'invalid';
      if (op.detail !== undefined && !isText(op.detail)) return 'invalid';
      return add(draft.attempts, 'attempts', {
        outcome: op.outcome as WorkingMemoryAttempt['outcome'],
        ...(op.detail !== undefined ? { detail: op.detail } : {}),
      });
    case 'update-attempt': {
      if (!OUTCOMES.includes(op.outcome as WorkingMemoryAttempt['outcome'])) return 'invalid';
      if (op.detail !== undefined && !isText(op.detail)) return 'invalid';
      const item = target(ctx, draft.attempts, op.id);
      if (typeof item === 'string') return item;
      Object.assign(item, {
        outcome: op.outcome,
        ...(op.detail !== undefined ? { detail: op.detail } : {}),
        ...stamp(ctx),
      });
      return undefined;
    }
    case 'remove': {
      if (!LISTS.includes(op.list as WorkingMemoryList)) return 'invalid';
      const list = draft[op.list as WorkingMemoryList] as WorkingMemoryItemBase[];
      const item = target(ctx, list, op.id);
      if (typeof item === 'string') return item;
      list.splice(list.indexOf(item), 1);
      return undefined;
    }
    default:
      return 'invalid';
  }
}

/** See `applyWorkingMemoryPatch`. */
export function applyPatch(
  snapshot: WorkingMemorySnapshot,
  patch: WorkingMemoryPatch,
  options: ApplyWorkingMemoryPatchOptions,
): WorkingMemoryPatchResult {
  assertWorkingMemorySnapshot(snapshot);
  if (
    !isObject(patch) ||
    !isId(patch.operationId) ||
    !Number.isSafeInteger(patch.expectedRevision) ||
    (patch.writer !== 'host' && patch.writer !== 'model') ||
    !Array.isArray(patch.operations) ||
    patch.operations.length === 0
  )
    throw new TypeError(
      'A working memory patch needs an operationId, an expectedRevision, a writer (host or model) and at least one operation.',
    );
  if (!isObject(options) || !Number.isFinite(options.now))
    throw new TypeError('applyWorkingMemoryPatch needs options.now (epoch ms).');
  if (options.generateId !== undefined && typeof options.generateId !== 'function')
    throw new TypeError('options.generateId must be a function.');
  if (snapshot.applied.includes(patch.operationId)) return { status: 'duplicate', snapshot };
  if (patch.expectedRevision !== snapshot.revision) return { status: 'conflict', snapshot };
  const ctx: PatchContext = {
    draft: structuredClone(snapshot),
    writer: patch.writer,
    revision: snapshot.revision + 1,
    now: options.now,
    ...(options.generateId ? { generateId: options.generateId } : {}),
  };
  for (const [index, operation] of patch.operations.entries()) {
    const reason = applyOperation(ctx, operation, index);
    if (reason) return { status: 'rejected', snapshot, reason, operation: index };
  }
  const { draft } = ctx;
  draft.revision = ctx.revision;
  draft.applied = [...snapshot.applied, patch.operationId].slice(-WORKING_MEMORY_APPLIED_LIMIT);
  draft.updatedAt = options.now;
  return { status: 'applied', snapshot: draft };
}
