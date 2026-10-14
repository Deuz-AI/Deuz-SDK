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
import { compareDigestPaths, isSha256Digest } from '../../internal/digest';
import { GoalError } from '../errors';
import { checkGoalEvent, readGoal } from '../validate';
import type { GoalRecord } from '../types';
import type {
  DurableSchedule,
  DurableScheduleInput,
  DurableScheduleQuery,
  GoalInboxApplication,
  GoalInboxDisposition,
  GoalInboxEnqueue,
  GoalInboxEnqueueResult,
  GoalInboxEntry,
  GoalInboxQuery,
  GoalLedgerWatermark,
  GoalRunIntent,
  GoalRunIntentInput,
  GoalRunIntentQuery,
  GoalRuntimeCommitResult,
  GoalRuntimePhase,
  GoalRuntimePruneOptions,
  GoalRuntimeState,
  GoalWatermarkAdvance,
  ScheduleAdvance,
  ScheduleAdvanceResult,
  ScheduleOccurrenceQuery,
  ScheduleOccurrenceRecord,
} from './store-types';

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
  | { kind: 'runtime'; state: GoalRuntimeState; created: boolean }
  | { kind: 'entry'; entry: GoalInboxEntry; created: boolean }
  | { kind: 'intent'; intent: GoalRunIntent; created: boolean }
  | { kind: 'schedule'; schedule: DurableSchedule; created: boolean }
  | { kind: 'occurrence'; record: ScheduleOccurrenceRecord }
  | { kind: 'watermark'; watermark: GoalLedgerWatermark; created: boolean };

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

// ===================================================================
// Listing
// ===================================================================

const MAX_LIMIT = 1000;

/** A page size: 1..1000, default 100. */
export function checkLimit(limit: unknown, subject: string): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT)
    throw new TypeError(`${subject} limit must be an integer from 1 to ${MAX_LIMIT}`);
  return limit as number;
}

/** A listing cursor: the JSON of the last row's sort key. */
export function encodeCursor(key: readonly (string | number)[]): string {
  return JSON.stringify(key);
}

/** Reads a cursor whose parts have the types of `shape`. Throws a TypeError otherwise. */
export function decodeCursor<const S extends readonly ('number' | 'string')[]>(
  cursor: unknown,
  shape: S,
  subject: string,
): { [K in keyof S]: S[K] extends 'number' ? number : string } {
  let parts: unknown;
  try {
    parts = typeof cursor === 'string' ? JSON.parse(cursor) : undefined;
  } catch {
    parts = undefined;
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== shape.length ||
    shape.some((type, index) =>
      type === 'number'
        ? !Number.isFinite((parts as unknown[])[index])
        : typeof (parts as unknown[])[index] !== 'string',
    )
  )
    throw new TypeError(`Malformed ${subject} cursor`);
  return parts as { [K in keyof S]: S[K] extends 'number' ? number : string };
}

/** Checks a status filter: `undefined` (the default) or an array of known values. */
export function checkStatuses<T extends string>(
  value: unknown,
  allowed: readonly T[],
  subject: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item as T)))
    throw new TypeError(`${subject} must be among ${allowed.join(', ')}`);
  return value as T[];
}

/** A query's fields; `undefined` reads as no filter. */
export function checkQuery(query: unknown, subject: string): Record<string, unknown> {
  if (query === undefined) return {};
  if (typeof query !== 'object' || query === null)
    throw new TypeError(`A ${subject} query must be an object`);
  return query as Record<string, unknown>;
}

/** An optional nonempty string filter. */
export function optionalQueryString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

/** A page from the rows a store found: one row more than the limit tells that more follow. */
export function pageOf<T>(
  rows: T[],
  limit: number,
  key: (row: T) => readonly (string | number)[],
): { rows: T[]; cursor?: string } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return rows.length > limit && last !== undefined
    ? { rows: page, cursor: encodeCursor(key(last)) }
    : { rows: page };
}

// ===================================================================
// Inbox
// ===================================================================

export const INBOX_DISPOSITIONS: readonly GoalInboxDisposition[] = [
  'pending',
  'applied',
  'duplicate',
  'unmatched',
  'stale',
  'expired',
  'terminal',
  'cancelled',
];

/** A checked delivery, as a JSON copy. Throws a TypeError (`invalid_event` for the event). */
export function checkEnqueue(value: unknown): GoalInboxEnqueue {
  const check = new RuntimeChecker('inbox delivery');
  const delivery = check.object(value, 'delivery');
  const scope = check.string(delivery.scope, 'scope');
  const goalId = check.string(delivery.goalId, 'goalId');
  check.string(delivery.namespace, 'namespace');
  check.string(delivery.deliveryId, 'deliveryId');
  const event = checkGoalEvent(delivery.event);
  if (event.scope !== scope || event.goalId !== goalId)
    check.fail('event', 'must be addressed to the delivery scope and goal');
  if (delivery.payload !== undefined) {
    const payload = check.object(delivery.payload, 'payload');
    if (typeof payload.body !== 'string') check.fail('payload.body', 'must be a string');
    check.optionalString(payload.mediaType, 'payload.mediaType');
  }
  if (!isSha256Digest(delivery.digest)) check.fail('digest', 'must be sha256:<64 hex digits>');
  check.json(delivery, '');
  return jsonCopy(delivery as unknown as GoalInboxEnqueue);
}

/**
 * `inbox.enqueue`: once per entry id `id`. The same digest for the same goal
 * is a duplicate; anything else under the id is a conflict. The target goal
 * must be stored in the delivery's scope (`GoalError` `scope_mismatch`).
 */
export function planEnqueue(
  snapshot: { entry: GoalInboxEntry | undefined; goal: StoredGoal | undefined },
  delivery: GoalInboxEnqueue,
  id: string,
  now: number,
): GoalRuntimePlan<GoalInboxEnqueueResult> {
  if (snapshot.goal === undefined || snapshot.goal.scope !== delivery.scope)
    throw new GoalError(
      'scope_mismatch',
      `No goal ${delivery.goalId} in scope ${delivery.scope} to deliver to`,
    );
  const stored = snapshot.entry;
  if (stored !== undefined) {
    const same = stored.digest === delivery.digest && stored.goalId === delivery.goalId;
    return { result: { status: same ? 'duplicate' : 'conflict', entry: stored }, writes: [] };
  }
  const entry: GoalInboxEntry = { ...delivery, id, disposition: 'pending', enqueuedAt: now };
  return {
    result: { status: 'enqueued', entry },
    writes: [{ kind: 'entry', entry, created: true }],
  };
}

/** A validated inbox listing. */
export interface InboxListPlan {
  scope: string;
  goalId: string | undefined;
  dispositions: readonly GoalInboxDisposition[];
  dueBy: number | undefined;
  limit: number;
  /** The sort key of the previous page's last entry. */
  after: readonly [enqueuedAt: number, id: string] | undefined;
}

export function planInboxList(query: GoalInboxQuery): InboxListPlan {
  const fields = checkQuery(query, 'inbox listing');
  const scope = optionalQueryString(fields.scope, 'Inbox listing scope');
  if (scope === undefined) throw new TypeError('Inbox listing scope must be a nonempty string');
  if (fields.dueBy !== undefined && !Number.isFinite(fields.dueBy))
    throw new TypeError('Inbox listing dueBy must be a finite number');
  return {
    scope,
    goalId: optionalQueryString(fields.goalId, 'Inbox listing goalId'),
    dispositions: checkStatuses(
      fields.dispositions,
      INBOX_DISPOSITIONS,
      'Inbox listing dispositions',
    ) ?? ['pending'],
    dueBy: fields.dueBy as number | undefined,
    limit: checkLimit(fields.limit, 'Inbox listing'),
    after:
      fields.cursor === undefined
        ? undefined
        : decodeCursor(fields.cursor, ['number', 'string'] as const, 'inbox listing'),
  };
}

/** Oldest first, then entry id (code point order). */
export function inboxOldestFirst(
  left: Pick<GoalInboxEntry, 'enqueuedAt' | 'id'>,
  right: Pick<GoalInboxEntry, 'enqueuedAt' | 'id'>,
): number {
  if (left.enqueuedAt !== right.enqueuedAt) return left.enqueuedAt - right.enqueuedAt;
  return compareText(left.id, right.id);
}

/** The sort key an inbox cursor carries. */
export const inboxKey = (entry: GoalInboxEntry): [number, string] => [entry.enqueuedAt, entry.id];

/** Whether `entry` belongs on an inbox listing (for a store that filters in process). */
export function matchesInboxList(entry: GoalInboxEntry, plan: InboxListPlan): boolean {
  if (entry.scope !== plan.scope) return false;
  if (plan.goalId !== undefined && entry.goalId !== plan.goalId) return false;
  if (!plan.dispositions.includes(entry.disposition)) return false;
  if (
    plan.dueBy !== undefined &&
    entry.disposition === 'pending' &&
    entry.event.notBefore !== undefined &&
    entry.event.notBefore > plan.dueBy
  )
    return false;
  if (plan.after !== undefined)
    return inboxOldestFirst(entry, { enqueuedAt: plan.after[0], id: plan.after[1] }) > 0;
  return true;
}

/** A checked application, its goal, runtime state and intent checked and copied. */
export function checkApplication(value: unknown): GoalInboxApplication {
  const check = new RuntimeChecker('inbox application');
  const application = check.object(value, 'application');
  check.string(application.scope, 'scope');
  check.string(application.goalId, 'goalId');
  check.string(application.entryId, 'entryId');
  check.oneOf(
    application.disposition,
    INBOX_DISPOSITIONS.filter((disposition) => disposition !== 'pending'),
    'disposition',
  );
  return {
    scope: application.scope as string,
    goalId: application.goalId as string,
    entryId: application.entryId as string,
    disposition: application.disposition as GoalInboxApplication['disposition'],
    ...(application.goal !== undefined ? { goal: checkGoal(application.goal) } : {}),
    ...(application.runtime !== undefined
      ? { runtime: checkRuntimeState(application.runtime) }
      : {}),
    ...(application.intent !== undefined ? { intent: checkIntentInput(application.intent) } : {}),
  };
}

/** What `inbox.apply` reads before it plans. */
export interface ApplySnapshot {
  entry: GoalInboxEntry | undefined;
  goal: StoredGoal | undefined;
  runtime: GoalRuntimeState | undefined;
  /** Whether the application's intent id is already recorded in its scope. */
  intentExists: boolean;
}

/**
 * `inbox.apply`: every check first (scope, the entry still pending, the goal
 * and the runtime state at their stored revisions plus one, the intent id
 * new), then the entry's disposition, the goal, the state and the intent.
 */
export function planApply(
  snapshot: ApplySnapshot,
  application: GoalInboxApplication,
  now: number,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  const { entry } = snapshot;
  const owner = { goalId: application.goalId, scope: application.scope };
  if (entry === undefined || entry.scope !== owner.scope || entry.goalId !== owner.goalId)
    return refused('scope-mismatch');
  if (application.goal !== undefined && !namesGoal(owner, application.goal))
    return refused('scope-mismatch');
  if (snapshot.goal !== undefined && snapshot.goal.scope !== owner.scope)
    return refused('scope-mismatch');
  const { intent } = application;
  if (intent !== undefined && (intent.goalId !== owner.goalId || intent.scope !== owner.scope))
    return refused('scope-mismatch');
  const runtime = runtimePart(snapshot, owner, application.runtime, application.goal);
  if (runtime === 'scope-mismatch') return refused(runtime);
  if (entry.disposition !== 'pending') return refused('entry-settled');
  const goal = goalPart(snapshot.goal, owner, application.goal);
  if (typeof goal === 'string') return refused(goal);
  if (typeof runtime === 'string') return refused(runtime);
  if (intent !== undefined && snapshot.intentExists) return refused('intent-exists');
  if (application.runtime !== undefined) assertCancelKept(snapshot.runtime, application.runtime);
  const settled: GoalInboxEntry = {
    ...entry,
    disposition: application.disposition,
    settledAt: now,
    ...(application.goal !== undefined ? { goalRevision: application.goal.revision } : {}),
    ...(intent !== undefined ? { intentId: intent.intentId } : {}),
  };
  const writes: GoalRuntimeWrite[] = [{ kind: 'entry', entry: settled, created: false }];
  if (goal) writes.push(goal);
  if (runtime) writes.push(runtime);
  if (intent !== undefined)
    writes.push({ kind: 'intent', intent: newIntent(intent, now), created: true });
  return committed(writes);
}

// ===================================================================
// Run intents
// ===================================================================

export const INTENT_STATUSES: readonly GoalRunIntent['status'][] = [
  'pending',
  'claimed',
  'launched',
  'completed',
  'failed',
  'cancelled',
];

/** A checked intent, as a JSON copy. Throws a TypeError naming the first field at fault. */
export function checkIntentInput(value: unknown): GoalRunIntentInput {
  const check = new RuntimeChecker('run intent');
  const intent = check.object(value, 'intent');
  check.string(intent.intentId, 'intentId');
  check.string(intent.scope, 'scope');
  check.string(intent.goalId, 'goalId');
  check.oneOf(intent.kind, ['start', 'resume', 'retry'], 'kind');
  check.string(intent.runId, 'runId');
  check.count(intent.attempt, 'attempt', 1);
  check.optionalTime(intent.notBefore, 'notBefore');
  if (intent.cause !== undefined) {
    const cause = check.object(intent.cause, 'cause');
    check.optionalString(cause.inboxEntryId, 'cause.inboxEntryId');
    check.optionalString(cause.command, 'cause.command');
  }
  if (intent.approvalResponses !== undefined && !Array.isArray(intent.approvalResponses))
    check.fail('approvalResponses', 'must be an array');
  check.json(intent, '');
  return jsonCopy(intent as unknown as GoalRunIntentInput);
}

/** A newly recorded intent: pending, at revision 1. */
function newIntent(input: GoalRunIntentInput, now: number): GoalRunIntent {
  return { ...input, status: 'pending', revision: 1, recordedAt: now, updatedAt: now };
}

/** The optional state an intent is recorded with, checked and copied. Throws a TypeError. */
export function checkIntentRecordOptions(value: unknown): {
  runtime?: GoalRuntimeState;
  goal?: GoalRecord;
} {
  if (value === undefined) return {};
  const options = new RuntimeChecker('intent record options').object(value, 'options');
  return {
    ...(options.runtime !== undefined ? { runtime: checkRuntimeState(options.runtime) } : {}),
    ...(options.goal !== undefined ? { goal: checkGoal(options.goal) } : {}),
  };
}

/**
 * `intents.record`: a new id, for a goal stored in the intent's scope; with
 * `runtime` and `goal`, those at their stored revisions plus one, together.
 */
export function planIntentRecord(
  snapshot: {
    intent: GoalRunIntent | undefined;
    goal: StoredGoal | undefined;
    runtime: GoalRuntimeState | undefined;
  },
  input: GoalRunIntentInput,
  options: { runtime?: GoalRuntimeState; goal?: GoalRecord },
  now: number,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  const owner = { goalId: input.goalId, scope: input.scope };
  if (!goalInScope(snapshot.goal, input.scope, options.goal)) return refused('scope-mismatch');
  if (options.goal !== undefined && !namesGoal(owner, options.goal))
    return refused('scope-mismatch');
  const runtime = runtimePart(snapshot, owner, options.runtime, options.goal);
  if (runtime === 'scope-mismatch') return refused(runtime);
  if (snapshot.intent !== undefined) return refused('intent-exists');
  const goal = goalPart(snapshot.goal, owner, options.goal);
  if (typeof goal === 'string') return refused(goal);
  if (typeof runtime === 'string') return refused(runtime);
  if (options.runtime !== undefined) assertCancelKept(snapshot.runtime, options.runtime);
  const writes: GoalRuntimeWrite[] = [
    { kind: 'intent', intent: newIntent(input, now), created: true },
  ];
  if (goal) writes.push(goal);
  if (runtime) writes.push(runtime);
  return committed(writes);
}

/** Checks a claim. Throws a TypeError. */
export function checkClaim(value: unknown): {
  owner: string;
  token: number;
  expectedRevision: number;
} {
  const check = new RuntimeChecker('intent claim');
  const claim = check.object(value, 'claim');
  return {
    owner: check.string(claim.owner, 'owner'),
    token: check.count(claim.token, 'token'),
    expectedRevision: check.count(claim.expectedRevision, 'expectedRevision', 1),
  };
}

/** What `intents.claim` answers. */
export type IntentClaimResult =
  | { status: 'committed'; intent: GoalRunIntent }
  | { status: 'conflict' };

/** An intent that holds a claim and has not finished yet. */
function claimable(intent: GoalRunIntent): boolean {
  return intent.status === 'claimed' || intent.status === 'launched';
}

/**
 * `intents.claim`: a pending intent, or one held under a lower token (claimed
 * or launched), at `expectedRevision`. A taken-over launched intent stays
 * launched: its run exists and is resumed, never started again.
 */
export function planIntentClaim(
  stored: GoalRunIntent | undefined,
  claim: { owner: string; token: number; expectedRevision: number },
  now: number,
): GoalRuntimePlan<IntentClaimResult> {
  const free =
    stored !== undefined &&
    stored.revision === claim.expectedRevision &&
    (stored.status === 'pending' ||
      (claimable(stored) && stored.claim !== undefined && stored.claim.token < claim.token));
  if (!free) return { result: { status: 'conflict' }, writes: [] };
  const intent: GoalRunIntent = {
    ...stored,
    status: stored.status === 'pending' ? 'claimed' : stored.status,
    revision: stored.revision + 1,
    claim: { owner: claim.owner, token: claim.token, at: now },
    updatedAt: now,
  };
  return {
    result: { status: 'committed', intent },
    writes: [{ kind: 'intent', intent, created: false }],
  };
}

/** Checks the options of `launched`. Throws a TypeError. */
export function checkMark(value: unknown): { token: number; expectedRevision: number } {
  const check = new RuntimeChecker('intent mark');
  const mark = check.object(value, 'options');
  return {
    token: check.count(mark.token, 'token'),
    expectedRevision: check.count(mark.expectedRevision, 'expectedRevision', 1),
  };
}

/** Whether `stored` is held under exactly `token` at `expectedRevision`. */
function heldBy(stored: GoalRunIntent, mark: { token: number; expectedRevision: number }): boolean {
  return (
    claimable(stored) &&
    stored.claim?.token === mark.token &&
    stored.revision === mark.expectedRevision
  );
}

/** `intents.launched`: the holder of the claim marks the run launched. */
export function planIntentLaunched(
  stored: GoalRunIntent | undefined,
  mark: { token: number; expectedRevision: number },
  now: number,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  if (stored === undefined) return refused('scope-mismatch');
  if (!heldBy(stored, mark)) return refused('intent-revision');
  return committed([
    {
      kind: 'intent',
      intent: { ...stored, status: 'launched', revision: stored.revision + 1, updatedAt: now },
      created: false,
    },
  ]);
}

/** A checked completion, its runtime state and goal checked and copied. Throws a TypeError. */
export function checkCompletion(value: unknown): {
  token: number;
  expectedRevision: number;
  status: 'completed' | 'failed' | 'cancelled';
  outcome?: GoalRunIntent['outcome'];
  runtime?: GoalRuntimeState;
  goal?: GoalRecord;
} {
  const check = new RuntimeChecker('intent completion');
  const completion = check.object(value, 'completion');
  const { token, expectedRevision } = checkMark(completion);
  const status = check.oneOf(
    completion.status,
    ['completed', 'failed', 'cancelled'] as const,
    'status',
  );
  let outcome: GoalRunIntent['outcome'];
  if (completion.outcome !== undefined) {
    const fields = check.object(completion.outcome, 'outcome');
    check.string(fields.status, 'outcome.status');
    check.optionalString(fields.reason, 'outcome.reason');
    if (fields.error !== undefined) {
      const error = check.object(fields.error, 'outcome.error');
      check.string(error.name, 'outcome.error.name');
      if (typeof error.message !== 'string')
        check.fail('outcome.error.message', 'must be a string');
      check.optionalString(error.code, 'outcome.error.code');
    }
    check.json(fields, 'outcome');
    outcome = jsonCopy(fields) as unknown as GoalRunIntent['outcome'];
  }
  return {
    token,
    expectedRevision,
    status,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(completion.runtime !== undefined ? { runtime: checkRuntimeState(completion.runtime) } : {}),
    ...(completion.goal !== undefined ? { goal: checkGoal(completion.goal) } : {}),
  };
}

/**
 * `intents.complete`: the holder of the claim records the outcome, with the
 * runtime state and the goal at their stored revisions plus one.
 */
export function planIntentComplete(
  snapshot: {
    intent: GoalRunIntent | undefined;
    goal: StoredGoal | undefined;
    runtime: GoalRuntimeState | undefined;
  },
  completion: ReturnType<typeof checkCompletion>,
  now: number,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  const stored = snapshot.intent;
  if (stored === undefined) return refused('scope-mismatch');
  const owner = { goalId: stored.goalId, scope: stored.scope };
  if (completion.goal !== undefined && !namesGoal(owner, completion.goal))
    return refused('scope-mismatch');
  const runtime = runtimePart(snapshot, owner, completion.runtime, completion.goal);
  if (runtime === 'scope-mismatch') return refused(runtime);
  if (!heldBy(stored, completion)) return refused('intent-revision');
  const goal = goalPart(snapshot.goal, owner, completion.goal);
  if (typeof goal === 'string') return refused(goal);
  if (typeof runtime === 'string') return refused(runtime);
  if (completion.runtime !== undefined) assertCancelKept(snapshot.runtime, completion.runtime);
  const { outcome: _outcome, ...rest } = stored;
  const writes: GoalRuntimeWrite[] = [
    {
      kind: 'intent',
      intent: {
        ...rest,
        status: completion.status,
        ...(completion.outcome !== undefined ? { outcome: completion.outcome } : {}),
        revision: stored.revision + 1,
        updatedAt: now,
      },
      created: false,
    },
  ];
  if (goal) writes.push(goal);
  if (runtime) writes.push(runtime);
  return committed(writes);
}

/** A validated intent listing. */
export interface IntentListPlan {
  scope: string | undefined;
  goalId: string | undefined;
  statuses: readonly GoalRunIntent['status'][];
  limit: number;
  /** The sort key of the previous page's last intent. */
  after: readonly [recordedAt: number, scope: string, intentId: string] | undefined;
}

export function planIntentList(query: GoalRunIntentQuery | undefined): IntentListPlan {
  const fields = checkQuery(query, 'intent listing');
  return {
    scope: optionalQueryString(fields.scope, 'Intent listing scope'),
    goalId: optionalQueryString(fields.goalId, 'Intent listing goalId'),
    statuses: checkStatuses(fields.statuses, INTENT_STATUSES, 'Intent listing statuses') ?? [
      'pending',
      'claimed',
      'launched',
    ],
    limit: checkLimit(fields.limit, 'Intent listing'),
    after:
      fields.cursor === undefined
        ? undefined
        : decodeCursor(fields.cursor, ['number', 'string', 'string'] as const, 'intent listing'),
  };
}

/** Oldest first, then scope, then intent id (code point order). */
export function intentsOldestFirst(
  left: Pick<GoalRunIntent, 'recordedAt' | 'scope' | 'intentId'>,
  right: Pick<GoalRunIntent, 'recordedAt' | 'scope' | 'intentId'>,
): number {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt - right.recordedAt;
  return compareText(left.scope, right.scope) || compareText(left.intentId, right.intentId);
}

/** The sort key an intent cursor carries. */
export const intentKey = (intent: GoalRunIntent): [number, string, string] => [
  intent.recordedAt,
  intent.scope,
  intent.intentId,
];

/** Whether `intent` belongs on a listing (for a store that filters in process). */
export function matchesIntentList(intent: GoalRunIntent, plan: IntentListPlan): boolean {
  if (plan.scope !== undefined && intent.scope !== plan.scope) return false;
  if (plan.goalId !== undefined && intent.goalId !== plan.goalId) return false;
  if (!plan.statuses.includes(intent.status)) return false;
  if (plan.after !== undefined)
    return (
      intentsOldestFirst(intent, {
        recordedAt: plan.after[0],
        scope: plan.after[1],
        intentId: plan.after[2],
      }) > 0
    );
  return true;
}

// ===================================================================
// Schedules
// ===================================================================

export const SCHEDULE_STATUSES: readonly DurableSchedule['status'][] = [
  'active',
  'paused',
  'cancelled',
];

/** The namespace a schedule's deliveries use: `schedule:<scheduleId>`. */
export function scheduleNamespace(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

/** A checked schedule as the host defines it, as a JSON copy. Throws a TypeError. */
export function checkScheduleInput(value: unknown): DurableScheduleInput {
  const check = new RuntimeChecker('durable schedule');
  const input = check.object(value, 'schedule');
  check.string(input.scheduleId, 'scheduleId');
  check.string(input.scope, 'scope');
  check.string(input.goalId, 'goalId');
  const spec = check.object(input.spec, 'spec');
  check.string(spec.cron, 'spec.cron');
  if (spec.timezone !== undefined) check.string(spec.timezone, 'spec.timezone');
  if (spec.dstGap !== undefined) check.oneOf(spec.dstGap, ['shift', 'skip'], 'spec.dstGap');
  if (spec.dstOverlap !== undefined)
    check.oneOf(spec.dstOverlap, ['first', 'both'], 'spec.dstOverlap');
  if (spec.catchUp !== undefined)
    check.oneOf(spec.catchUp, ['latest', 'all', 'none'], 'spec.catchUp');
  if (input.event !== undefined) {
    const event = check.object(input.event, 'event');
    check.optionalString(event.correlationId, 'event.correlationId');
    if (event.expiresAfterMs !== undefined)
      check.amount(event.expiresAfterMs, 'event.expiresAfterMs');
  }
  check.json(input, '');
  return jsonCopy(input as unknown as DurableScheduleInput);
}

/** Checks the options of a schedule change. Throws a TypeError. */
export function checkScheduleOptions(
  value: unknown,
  boundary: boolean,
): { expectedRevision: number; effectiveFrom: number } {
  const check = new RuntimeChecker('schedule change');
  const options = check.object(value, 'options');
  const expectedRevision = check.count(options.expectedRevision, 'expectedRevision');
  const effectiveFrom = boundary ? check.time(options.effectiveFrom, 'effectiveFrom') : 0;
  return { expectedRevision, effectiveFrom };
}

/** What a schedule change answers. */
export type ScheduleChangeResult =
  | { status: 'committed'; schedule: DurableSchedule }
  | { status: 'conflict' };

const SCHEDULE_CONFLICT: GoalRuntimePlan<ScheduleChangeResult> = {
  result: { status: 'conflict' },
  writes: [],
};

function scheduleCommitted(
  schedule: DurableSchedule,
  created: boolean,
  more: GoalRuntimeWrite[] = [],
): GoalRuntimePlan<ScheduleChangeResult> {
  return {
    result: { status: 'committed', schedule },
    writes: [{ kind: 'schedule', schedule, created }, ...more],
  };
}

/**
 * `schedules.put`: a create at `expectedRevision` 0 (its cursor at
 * `effectiveFrom`), or a change of a schedule that is not cancelled at its
 * stored revision (a new revision and boundary; the cursor stays, only
 * `advance` moves it). The target goal must be stored in the schedule's scope.
 */
export function planSchedulePut(
  snapshot: { schedule: DurableSchedule | undefined; goal: StoredGoal | undefined },
  input: DurableScheduleInput,
  options: { expectedRevision: number; effectiveFrom: number },
  now: number,
): GoalRuntimePlan<ScheduleChangeResult> {
  if (snapshot.goal === undefined || snapshot.goal.scope !== input.scope)
    throw new GoalError(
      'scope_mismatch',
      `No goal ${input.goalId} in scope ${input.scope} for schedule ${input.scheduleId}`,
    );
  const stored = snapshot.schedule;
  if (options.expectedRevision === 0) {
    if (stored !== undefined) return SCHEDULE_CONFLICT;
    return scheduleCommitted(
      {
        ...input,
        status: 'active',
        revision: 1,
        effectiveFrom: options.effectiveFrom,
        scheduleCursor: options.effectiveFrom,
        createdAt: now,
        updatedAt: now,
      },
      true,
    );
  }
  if (!changeable(stored, options.expectedRevision)) return SCHEDULE_CONFLICT;
  const { event: _event, ...kept } = stored;
  return scheduleCommitted(
    {
      ...kept,
      ...input,
      revision: stored.revision + 1,
      effectiveFrom: options.effectiveFrom,
      updatedAt: now,
    },
    false,
  );
}

/** A stored schedule at `expectedRevision` that is not cancelled. */
function changeable(
  stored: DurableSchedule | undefined,
  expectedRevision: number,
): stored is DurableSchedule {
  return (
    stored !== undefined && stored.revision === expectedRevision && stored.status !== 'cancelled'
  );
}

/** `schedules.pause`: an active schedule at its revision stops scanning. */
export function planSchedulePause(
  stored: DurableSchedule | undefined,
  options: { expectedRevision: number },
  now: number,
): GoalRuntimePlan<ScheduleChangeResult> {
  if (!changeable(stored, options.expectedRevision) || stored.status !== 'active')
    return SCHEDULE_CONFLICT;
  return scheduleCommitted(
    { ...stored, status: 'paused', revision: stored.revision + 1, updatedAt: now },
    false,
  );
}

/** `schedules.resume`: a paused schedule at its revision is active again from `effectiveFrom`. */
export function planScheduleResume(
  stored: DurableSchedule | undefined,
  options: { expectedRevision: number; effectiveFrom: number },
  now: number,
): GoalRuntimePlan<ScheduleChangeResult> {
  if (!changeable(stored, options.expectedRevision) || stored.status !== 'paused')
    return SCHEDULE_CONFLICT;
  return scheduleCommitted(
    {
      ...stored,
      status: 'active',
      revision: stored.revision + 1,
      effectiveFrom: options.effectiveFrom,
      updatedAt: now,
    },
    false,
  );
}

/**
 * `schedules.cancel`: the schedule ends at its revision, and `pending` (its
 * still-pending deliveries, read by the store) are disposed as `'cancelled'`.
 */
export function planScheduleCancel(
  snapshot: { schedule: DurableSchedule | undefined; pending: readonly GoalInboxEntry[] },
  options: { expectedRevision: number },
  now: number,
): GoalRuntimePlan<ScheduleChangeResult> {
  const stored = snapshot.schedule;
  if (!changeable(stored, options.expectedRevision)) return SCHEDULE_CONFLICT;
  return scheduleCommitted(
    { ...stored, status: 'cancelled', revision: stored.revision + 1, updatedAt: now },
    false,
    snapshot.pending
      .filter((entry) => entry.disposition === 'pending')
      .map((entry) => ({
        kind: 'entry' as const,
        entry: { ...entry, disposition: 'cancelled' as const, settledAt: now },
        created: false,
      })),
  );
}

/**
 * Whether `entry` is a still-pending delivery of the schedule: in its scope,
 * under its namespace or named by one of its occurrence records.
 */
export function isPendingDeliveryOf(
  entry: GoalInboxEntry,
  schedule: Pick<DurableSchedule, 'scope' | 'scheduleId'>,
  occurrenceEntryIds: ReadonlySet<string>,
): boolean {
  return (
    entry.scope === schedule.scope &&
    entry.disposition === 'pending' &&
    (entry.namespace === scheduleNamespace(schedule.scheduleId) || occurrenceEntryIds.has(entry.id))
  );
}

/** A validated schedule listing. */
export interface ScheduleListPlan {
  scope: string | undefined;
  goalId: string | undefined;
  statuses: readonly DurableSchedule['status'][] | undefined;
  limit: number;
  /** The sort key of the previous page's last schedule. */
  after: readonly [scheduleId: string, scope: string] | undefined;
}

export function planScheduleList(query: DurableScheduleQuery | undefined): ScheduleListPlan {
  const fields = checkQuery(query, 'schedule listing');
  return {
    scope: optionalQueryString(fields.scope, 'Schedule listing scope'),
    goalId: optionalQueryString(fields.goalId, 'Schedule listing goalId'),
    statuses: checkStatuses(fields.statuses, SCHEDULE_STATUSES, 'Schedule listing statuses'),
    limit: checkLimit(fields.limit, 'Schedule listing'),
    after:
      fields.cursor === undefined
        ? undefined
        : decodeCursor(fields.cursor, ['string', 'string'] as const, 'schedule listing'),
  };
}

/** By schedule id, then scope (code point order). */
export function schedulesById(
  left: Pick<DurableSchedule, 'scheduleId' | 'scope'>,
  right: Pick<DurableSchedule, 'scheduleId' | 'scope'>,
): number {
  return compareText(left.scheduleId, right.scheduleId) || compareText(left.scope, right.scope);
}

/** The sort key a schedule cursor carries. */
export const scheduleKey = (schedule: DurableSchedule): [string, string] => [
  schedule.scheduleId,
  schedule.scope,
];

/** Whether `schedule` belongs on a listing (for a store that filters in process). */
export function matchesScheduleList(schedule: DurableSchedule, plan: ScheduleListPlan): boolean {
  if (plan.scope !== undefined && schedule.scope !== plan.scope) return false;
  if (plan.goalId !== undefined && schedule.goalId !== plan.goalId) return false;
  if (plan.statuses !== undefined && !plan.statuses.includes(schedule.status)) return false;
  if (plan.after !== undefined)
    return schedulesById(schedule, { scheduleId: plan.after[0], scope: plan.after[1] }) > 0;
  return true;
}

// ===================================================================
// Schedule advance and occurrence records
// ===================================================================

const OCCURRENCE_REASONS: readonly NonNullable<ScheduleOccurrenceRecord['reason']>[] = [
  'dst-gap-skip',
  'catch-up-none',
  'catch-up-latest',
  'paused',
  'cancelled',
];

/**
 * A checked advance, its deliveries checked and copied. Each occurrence lies in
 * `(fromCursor, toCursor]`, belongs to the schedule and its scope, appears
 * once, and is delivered to its own goal exactly when it is `'delivered'`.
 * Throws a TypeError.
 */
export function checkAdvance(value: unknown): ScheduleAdvance {
  const check = new RuntimeChecker('schedule advance');
  const advance = check.object(value, 'advance');
  const scope = check.string(advance.scope, 'scope');
  const scheduleId = check.string(advance.scheduleId, 'scheduleId');
  check.count(advance.expectedRevision, 'expectedRevision', 1);
  const from = check.time(advance.fromCursor, 'fromCursor');
  const to = check.time(advance.toCursor, 'toCursor');
  if (to < from) check.fail('toCursor', 'must not be before fromCursor');
  check.optionalTime(advance.scanTo, 'scanTo');
  if (!Array.isArray(advance.occurrences)) check.fail('occurrences', 'must be an array');
  const seen = new Set<string>();
  const occurrences = (advance.occurrences as unknown[]).map((item, index) => {
    const path = `occurrences[${index}]`;
    const occurrence = check.object(item, path);
    const occurrenceId = check.string(occurrence.occurrenceId, `${path}.occurrenceId`);
    if (seen.has(occurrenceId)) check.fail(`${path}.occurrenceId`, `repeats ${occurrenceId}`);
    seen.add(occurrenceId);
    if (occurrence.scheduleId !== scheduleId)
      check.fail(`${path}.scheduleId`, `must be ${scheduleId}`);
    if (occurrence.scope !== scope) check.fail(`${path}.scope`, `must be ${scope}`);
    const goalId = check.string(occurrence.goalId, `${path}.goalId`);
    const at = check.time(occurrence.at, `${path}.at`);
    if (!(at > from && at <= to)) check.fail(`${path}.at`, 'must lie in (fromCursor, toCursor]');
    const disposition = check.oneOf(
      occurrence.disposition,
      ['delivered', 'skipped'] as const,
      `${path}.disposition`,
    );
    if (occurrence.reason !== undefined)
      check.oneOf(occurrence.reason, OCCURRENCE_REASONS, `${path}.reason`);
    if ((disposition === 'delivered') !== (occurrence.delivery !== undefined))
      check.fail(`${path}.delivery`, "is required exactly when the occurrence is 'delivered'");
    if (occurrence.delivery === undefined) return jsonCopy(occurrence);
    const delivery = checkEnqueue(occurrence.delivery);
    if (delivery.scope !== scope || delivery.goalId !== goalId)
      check.fail(`${path}.delivery`, "must go to the occurrence's goal in its scope");
    return { ...jsonCopy(occurrence), delivery };
  });
  return { ...jsonCopy(advance), occurrences } as unknown as ScheduleAdvance;
}

/** What `schedules.advance` reads before it plans. */
export interface AdvanceSnapshot {
  schedule: DurableSchedule | undefined;
  /** The stored inbox entries under the advance's delivery ids. */
  entries: ReadonlyMap<string, GoalInboxEntry>;
  /** The occurrence ids of the advance already recorded in its scope. */
  recorded: ReadonlySet<string>;
}

/**
 * `schedules.advance`: only for an active schedule at `expectedRevision` with
 * its cursor at `fromCursor`. Records each occurrence once (a recorded one is
 * kept), queues each delivery whose entry id is new and counts the others as
 * duplicates (the first delivery stands), and moves the cursor and the
 * unfinished scan. The revision stays: the cursor is its own fence.
 */
export function planAdvance(
  snapshot: AdvanceSnapshot,
  advance: ScheduleAdvance,
  entryId: (delivery: GoalInboxEnqueue) => string,
  now: number,
): GoalRuntimePlan<ScheduleAdvanceResult> {
  const stored = snapshot.schedule;
  if (
    stored === undefined ||
    stored.status !== 'active' ||
    stored.revision !== advance.expectedRevision ||
    stored.scheduleCursor !== advance.fromCursor
  )
    return {
      result:
        stored === undefined ? { status: 'conflict' } : { status: 'conflict', schedule: stored },
      writes: [],
    };
  const writes: GoalRuntimeWrite[] = [];
  const queued = new Set<string>();
  let enqueued = 0;
  let duplicates = 0;
  for (const { delivery, ...occurrence } of advance.occurrences) {
    if (occurrence.goalId !== stored.goalId)
      throw new TypeError(
        `Invalid schedule advance: occurrence ${occurrence.occurrenceId} must go to goal ${stored.goalId}`,
      );
    let inboxEntryId: string | undefined;
    if (delivery !== undefined) {
      inboxEntryId = entryId(delivery);
      if (snapshot.entries.has(inboxEntryId) || queued.has(inboxEntryId)) duplicates++;
      else {
        queued.add(inboxEntryId);
        enqueued++;
        writes.push({
          kind: 'entry',
          entry: { ...delivery, id: inboxEntryId, disposition: 'pending', enqueuedAt: now },
          created: true,
        });
      }
    }
    if (!snapshot.recorded.has(occurrence.occurrenceId))
      writes.push({
        kind: 'occurrence',
        record: {
          ...occurrence,
          ...(inboxEntryId !== undefined ? { inboxEntryId } : {}),
          recordedAt: now,
        },
      });
  }
  const { scanTo: _scanTo, ...rest } = stored;
  const schedule: DurableSchedule = {
    ...rest,
    scheduleCursor: advance.toCursor,
    ...(advance.scanTo !== undefined ? { scanTo: advance.scanTo } : {}),
    updatedAt: now,
  };
  writes.unshift({ kind: 'schedule', schedule, created: false });
  return { result: { status: 'advanced', schedule, enqueued, duplicates }, writes };
}

/** A validated occurrence listing. */
export interface OccurrenceListPlan {
  scope: string;
  scheduleId: string | undefined;
  limit: number;
  /** The sort key of the previous page's last record. */
  after: readonly [at: number, occurrenceId: string] | undefined;
}

export function planOccurrenceList(query: ScheduleOccurrenceQuery): OccurrenceListPlan {
  const fields = checkQuery(query, 'occurrence listing');
  const scope = optionalQueryString(fields.scope, 'Occurrence listing scope');
  if (scope === undefined)
    throw new TypeError('Occurrence listing scope must be a nonempty string');
  return {
    scope,
    scheduleId: optionalQueryString(fields.scheduleId, 'Occurrence listing scheduleId'),
    limit: checkLimit(fields.limit, 'Occurrence listing'),
    after:
      fields.cursor === undefined
        ? undefined
        : decodeCursor(fields.cursor, ['number', 'string'] as const, 'occurrence listing'),
  };
}

/** By occurrence time, then occurrence id (code point order). */
export function occurrencesOldestFirst(
  left: Pick<ScheduleOccurrenceRecord, 'at' | 'occurrenceId'>,
  right: Pick<ScheduleOccurrenceRecord, 'at' | 'occurrenceId'>,
): number {
  if (left.at !== right.at) return left.at - right.at;
  return compareText(left.occurrenceId, right.occurrenceId);
}

/** The sort key an occurrence cursor carries. */
export const occurrenceKey = (record: ScheduleOccurrenceRecord): [number, string] => [
  record.at,
  record.occurrenceId,
];

/** Whether `record` belongs on a listing (for a store that filters in process). */
export function matchesOccurrenceList(
  record: ScheduleOccurrenceRecord,
  plan: OccurrenceListPlan,
): boolean {
  if (record.scope !== plan.scope) return false;
  if (plan.scheduleId !== undefined && record.scheduleId !== plan.scheduleId) return false;
  if (plan.after !== undefined)
    return occurrencesOldestFirst(record, { at: plan.after[0], occurrenceId: plan.after[1] }) > 0;
  return true;
}

// ===================================================================
// Ledger watermarks
// ===================================================================

/** A checked watermark advance, its goal checked and copied. Throws a TypeError. */
export function checkWatermarkAdvance(value: unknown): GoalWatermarkAdvance {
  const check = new RuntimeChecker('watermark advance');
  const advance = check.object(value, 'advance');
  check.string(advance.scope, 'scope');
  check.string(advance.goalId, 'goalId');
  check.string(advance.runId, 'runId');
  check.count(advance.expectedRevision, 'expectedRevision');
  const next = check.object(advance.next, 'next');
  for (const key of ['tokens', 'usd', 'reservedTokens', 'reservedUsd'] as const)
    check.amount(next[key], `next.${key}`);
  return {
    scope: advance.scope as string,
    goalId: advance.goalId as string,
    runId: advance.runId as string,
    expectedRevision: advance.expectedRevision as number,
    next: {
      tokens: next.tokens as number,
      usd: next.usd as number,
      reservedTokens: next.reservedTokens as number,
      reservedUsd: next.reservedUsd as number,
    },
    goal: checkGoal(advance.goal),
  };
}

/**
 * `watermarks.advance`: the watermark at `expectedRevision` (0 for the first)
 * and the charged goal at its stored revision plus one, together. Charged
 * amounts never go back (a TypeError); reservations may be released.
 */
export function planWatermarkAdvance(
  snapshot: { watermark: GoalLedgerWatermark | undefined; goal: StoredGoal | undefined },
  advance: GoalWatermarkAdvance,
  now: number,
): GoalRuntimePlan<GoalRuntimeCommitResult> {
  const owner = { goalId: advance.goalId, scope: advance.scope };
  if (!namesGoal(owner, advance.goal)) return refused('scope-mismatch');
  if (snapshot.goal !== undefined && snapshot.goal.scope !== owner.scope)
    return refused('scope-mismatch');
  const stored = snapshot.watermark;
  if ((stored?.revision ?? 0) !== advance.expectedRevision) return refused('watermark-revision');
  const goal = goalPart(snapshot.goal, owner, advance.goal);
  if (typeof goal === 'string') return refused(goal);
  if (
    stored !== undefined &&
    (advance.next.tokens < stored.tokens || advance.next.usd < stored.usd)
  )
    throw new TypeError(
      `A ledger watermark never goes back: run ${advance.runId} of goal ${advance.goalId} is charged up to ${stored.tokens} tokens and ${stored.usd} USD`,
    );
  const watermark: GoalLedgerWatermark = {
    scope: advance.scope,
    goalId: advance.goalId,
    runId: advance.runId,
    ...advance.next,
    revision: (stored?.revision ?? 0) + 1,
    updatedAt: now,
  };
  return committed([{ kind: 'watermark', watermark, created: stored === undefined }, goal!]);
}

// ===================================================================
// Retention
// ===================================================================

/** Checked retention options. Throws a TypeError. */
export function checkPruneOptions(value: unknown): GoalRuntimePruneOptions {
  const check = new RuntimeChecker('retention options');
  const options = check.object(value, 'options');
  const before = check.time(options.before, 'before');
  if (options.scope === undefined) return { before };
  return { before, scope: check.string(options.scope, 'scope') };
}

/** Whether a settled entry falls under a retention cut. */
export function settledBefore(entry: GoalInboxEntry, options: GoalRuntimePruneOptions): boolean {
  return (
    entry.disposition !== 'pending' &&
    entry.settledAt !== undefined &&
    entry.settledAt < options.before &&
    (options.scope === undefined || entry.scope === options.scope)
  );
}

/** An entry's content-free tombstone: everything but the payload, marked pruned. */
export function tombstone(entry: GoalInboxEntry): GoalInboxEntry {
  const { payload: _payload, ...rest } = entry;
  return { ...rest, payloadPruned: true };
}

/** The intent statuses `pruneIntents` deletes. */
export const FINISHED_INTENT_STATUSES: readonly GoalRunIntent['status'][] = [
  'completed',
  'failed',
  'cancelled',
];
