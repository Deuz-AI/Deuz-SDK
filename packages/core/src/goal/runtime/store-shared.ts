/**
 * @internal What the three goal runtime stores share (2.4): validation, the
 * order rows are listed in, and one planner per write method, so the
 * in-memory, SQLite and PostgreSQL stores answer every call identically.
 *
 * A write method reads a snapshot of the rows it touches, inside its
 * transaction, hands it to a planner here, and applies the writes the planner
 * returns in the same transaction. A planner is pure and synchronous: it
 * decides the result (committed, a conflict reason, a duplicate) and the row
 * writes, and a refused write returns no writes at all. Input is validated
 * before the transaction begins, so a malformed call throws without touching
 * the store. Edge-safe.
 */
import { compareDigestPaths } from '../../internal/digest';
import { GoalError } from '../errors';
import { readGoal } from '../validate';
import type { GoalRecord } from '../types';
import type { GoalRuntimeCommitResult, GoalRuntimePhase, GoalRuntimeState } from './store-types';

/**
 * Code point order, which is the byte order of UTF-8: what SQLite's BINARY
 * collation and PostgreSQL's `COLLATE "C"` give, so ties list alike everywhere.
 */
export const compareText: (left: string, right: string) => number = compareDigestPaths;

/** Newest change first, then goal ID descending (code point order). */
export function goalsNewestFirst(
  left: Pick<GoalRecord, 'updatedAt' | 'goalId'>,
  right: Pick<GoalRecord, 'updatedAt' | 'goalId'>,
): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return compareText(right.goalId, left.goalId);
}

// ===================================================================
// Plans
// ===================================================================

/** What a planner needs to know of a stored goal. */
export interface StoredGoal {
  scope: string;
  revision: number;
}

/** One row a planner asks its store to write. `created` rows are inserted, the others updated. */
export type GoalRuntimeWrite =
  | { kind: 'goal'; record: GoalRecord; created: boolean }
  | { kind: 'runtime'; state: GoalRuntimeState; created: boolean };

/** A planner's answer: the result, and the writes that commit it (none when refused). */
export interface GoalRuntimePlan<R> {
  result: R;
  writes: GoalRuntimeWrite[];
}

export type GoalRuntimeConflictReason = Extract<
  GoalRuntimeCommitResult,
  { status: 'conflict' }
>['reason'];

/** A refusal: nothing to write. */
export function refused(
  reason: GoalRuntimeConflictReason,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  return { result: { status: 'conflict', reason }, writes: [] };
}

function committed(writes: GoalRuntimeWrite[]): GoalRuntimePlan<GoalRuntimeCommitResult> {
  return { result: { status: 'committed' }, writes };
}

// ===================================================================
// Validation
// ===================================================================

/** Checks a value field by field and throws the first problem as a TypeError. */
export class RuntimeChecker {
  constructor(private readonly subject: string) {}

  fail(path: string, problem: string): never {
    throw new TypeError(`Invalid ${this.subject}: ${path} ${problem}`);
  }

  object(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      this.fail(path, 'must be an object');
    return value as Record<string, unknown>;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string' || value === '') this.fail(path, 'must be a nonempty string');
    return value;
  }

  optionalString(value: unknown, path: string): void {
    if (value !== undefined && typeof value !== 'string') this.fail(path, 'must be a string');
  }

  time(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      this.fail(path, 'must be a finite number');
    return value;
  }

  optionalTime(value: unknown, path: string): void {
    if (value !== undefined) this.time(value, path);
  }

  count(value: unknown, path: string, min = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < min)
      this.fail(path, `must be an integer of at least ${min}`);
    return value as number;
  }

  amount(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      this.fail(path, 'must be a finite number of at least 0');
    return value;
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (!allowed.includes(value as T)) this.fail(path, `must be one of ${allowed.join(', ')}`);
    return value as T;
  }

  /** JSON a store keeps as it is: plain objects, arrays, strings, finite numbers, booleans, null. */
  json(value: unknown, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) this.fail(path, 'must be a finite number');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item === undefined) this.fail(`${path}[${index}]`, 'must not be undefined');
        this.json(item, `${path}[${index}]`);
      });
      return;
    }
    if (typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null)
        this.fail(path, 'must be plain JSON');
      for (const [key, item] of Object.entries(value))
        if (item !== undefined) this.json(item, path === '' ? key : `${path}.${key}`);
      return;
    }
    this.fail(path, 'must be plain JSON');
  }
}

/** A JSON copy: what a SQL store reads back, so the in-memory store returns the same. */
export function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A checked goal record, copied, with its defaults filled in. Throws `invalid_goal`. */
export function checkGoal(record: unknown): GoalRecord {
  return structuredClone(readGoal(record));
}

const PHASES: readonly GoalRuntimePhase[] = [
  'idle',
  'dispatching',
  'running',
  'retrying',
  'draining',
  'done',
];

/** A checked runtime state, as a JSON copy. Throws a TypeError naming the first field at fault. */
export function checkRuntimeState(value: unknown): GoalRuntimeState {
  const check = new RuntimeChecker('goal runtime state');
  const state = check.object(value, 'state');
  check.string(state.goalId, 'goalId');
  check.string(state.scope, 'scope');
  check.count(state.revision, 'revision', 1);
  const policy = check.object(state.policy, 'policy');
  check.count(policy.maxRuns, 'policy.maxRuns');
  check.count(policy.maxRetries, 'policy.maxRetries');
  if (!Array.isArray(policy.retryDelaysMs)) check.fail('policy.retryDelaysMs', 'must be an array');
  (policy.retryDelaysMs as unknown[]).forEach((delay, index) =>
    check.amount(delay, `policy.retryDelaysMs[${index}]`),
  );
  check.amount(policy.retainPayloadMs, 'policy.retainPayloadMs');
  check.oneOf(state.phase, PHASES, 'phase');
  if (state.activeRun !== undefined) {
    const run = check.object(state.activeRun, 'activeRun');
    check.string(run.intentId, 'activeRun.intentId');
    check.string(run.runId, 'activeRun.runId');
    check.count(run.attempt, 'activeRun.attempt', 1);
    check.time(run.startedAt, 'activeRun.startedAt');
  }
  check.count(state.runs, 'runs');
  check.count(state.retries, 'retries');
  check.optionalTime(state.retryAt, 'retryAt');
  if (state.cancel !== undefined) {
    const cancel = check.object(state.cancel, 'cancel');
    check.time(cancel.requestedAt, 'cancel.requestedAt');
    check.optionalString(cancel.reason, 'cancel.reason');
    check.optionalTime(cancel.appliedAt, 'cancel.appliedAt');
  }
  if (state.maintenance !== undefined) {
    const maintenance = check.object(state.maintenance, 'maintenance');
    check.oneOf(maintenance.status, ['pending', 'complete', 'failed'], 'maintenance.status');
    check.optionalString(maintenance.runId, 'maintenance.runId');
  }
  if (state.workingMemory !== undefined) check.object(state.workingMemory, 'workingMemory');
  check.time(state.createdAt, 'createdAt');
  check.time(state.updatedAt, 'updatedAt');
  check.json(state, '');
  return jsonCopy(state as unknown as GoalRuntimeState);
}

// ===================================================================
// Goals
// ===================================================================

/**
 * Whether `record` may be saved over `stored`: the stored revision plus one (1
 * for a new goal), in the stored goal's scope. Returns the reason it may not.
 */
export function goalWriteRefusal(
  stored: StoredGoal | undefined,
  record: GoalRecord,
): 'goal-revision' | 'scope-mismatch' | undefined {
  if (stored !== undefined && stored.scope !== record.scope) return 'scope-mismatch';
  if (record.revision !== (stored?.revision ?? 0) + 1) return 'goal-revision';
  return undefined;
}

/** The `GoalStore.save` of a goal runtime store: the write, or the 2.3 `GoalError`. */
export function planGoalSave(stored: StoredGoal | undefined, record: GoalRecord): GoalRuntimeWrite {
  const refusal = goalWriteRefusal(stored, record);
  if (refusal === 'scope-mismatch')
    throw new GoalError(
      'scope_mismatch',
      `Goal ${record.goalId} belongs to another scope: a goal never changes scope`,
    );
  if (refusal === 'goal-revision')
    throw new GoalError(
      'revision_conflict',
      `Goal revision conflict for ${record.goalId}: expected ${(stored?.revision ?? 0) + 1}, got ${record.revision}`,
    );
  return { kind: 'goal', record, created: stored === undefined };
}

/** A record that names a goal shares its id and scope. */
function namesGoal(record: { goalId: string; scope: string }, goal: GoalRecord): boolean {
  return record.goalId === goal.goalId && record.scope === goal.scope;
}

/**
 * Whether a record naming a goal in `scope` names a goal of that scope: the
 * stored one, or `goal`, saved in the same write.
 */
function goalInScope(
  stored: StoredGoal | undefined,
  scope: string,
  goal: GoalRecord | undefined,
): boolean {
  if (stored !== undefined) return stored.scope === scope;
  return goal !== undefined && goal.scope === scope;
}

/** The goal write of a multi-part write, or why it is refused. */
function goalPart(
  stored: StoredGoal | undefined,
  owner: { goalId: string; scope: string },
  goal: GoalRecord | undefined,
): GoalRuntimeConflictReason | GoalRuntimeWrite | undefined {
  if (goal === undefined) return undefined;
  if (!namesGoal(owner, goal)) return 'scope-mismatch';
  return goalWriteRefusal(stored, goal) ?? { kind: 'goal', record: goal, created: !stored };
}

// ===================================================================
// Runtime state
// ===================================================================

/**
 * A runtime save never withdraws a recorded cancel request, nor the time it
 * took effect: a cancel accepted once is never lost (spec §3.1).
 */
function assertCancelKept(stored: GoalRuntimeState | undefined, next: GoalRuntimeState): void {
  const before = stored?.cancel;
  if (before === undefined) return;
  const after = next.cancel;
  if (
    after === undefined ||
    after.requestedAt !== before.requestedAt ||
    after.reason !== before.reason ||
    (before.appliedAt !== undefined && after.appliedAt !== before.appliedAt)
  )
    throw new TypeError(
      `A runtime save cannot withdraw or rewrite the recorded cancel request of goal ${next.goalId}`,
    );
}

/** The runtime part of a multi-part write, or why it is refused. */
function runtimePart(
  snapshot: { goal: StoredGoal | undefined; runtime: GoalRuntimeState | undefined },
  owner: { goalId: string; scope: string },
  state: GoalRuntimeState | undefined,
  goal: GoalRecord | undefined,
): GoalRuntimeConflictReason | GoalRuntimeWrite | undefined {
  if (state === undefined) return undefined;
  if (state.goalId !== owner.goalId || state.scope !== owner.scope) return 'scope-mismatch';
  if (!goalInScope(snapshot.goal, state.scope, goal)) return 'scope-mismatch';
  if (snapshot.runtime !== undefined && snapshot.runtime.scope !== state.scope)
    return 'scope-mismatch';
  if (state.revision !== (snapshot.runtime?.revision ?? 0) + 1) return 'runtime-revision';
  return { kind: 'runtime', state, created: snapshot.runtime === undefined };
}

/** `runtime.save(state, goal?)`: scope, then the state's revision, then the goal's. */
export function planRuntimeSave(
  snapshot: { goal: StoredGoal | undefined; runtime: GoalRuntimeState | undefined },
  state: GoalRuntimeState,
  goal: GoalRecord | undefined,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  if (goal !== undefined && !namesGoal(state, goal)) return refused('scope-mismatch');
  const runtime = runtimePart(snapshot, state, state, goal);
  if (typeof runtime === 'string') return refused(runtime);
  const goalWrite = goalPart(snapshot.goal, state, goal);
  if (typeof goalWrite === 'string') return refused(goalWrite);
  assertCancelKept(snapshot.runtime, state);
  return committed([runtime!, ...(goalWrite ? [goalWrite] : [])]);
}
