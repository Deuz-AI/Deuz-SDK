/**
 * Validation and serialization of goal records and events (2.3). A record or
 * event is plain JSON with a `kind` and a `version`. A reader accepts every
 * version up to its own and refuses a newer one; within a version, later 2.x
 * releases only add optional fields, which a reader keeps as they are, and a
 * reader fills in the fields a writer may leave out.
 */
import { GoalError, type GoalErrorCode } from './errors';
import type {
  GoalCriterion,
  GoalCriterionResult,
  GoalDependency,
  GoalEvent,
  GoalEventSource,
  GoalEvidence,
  GoalOutcome,
  GoalRecord,
  GoalStatus,
  GoalWaiting,
} from './types';

/** The GoalRecord format this build writes, and the newest it reads. */
export const GOAL_RECORD_VERSION = 1;
/** The GoalEvent format this build writes, and the newest it reads. */
export const GOAL_EVENT_VERSION = 1;
/** How many applied event and charge keys a record remembers. */
export const GOAL_SEEN_LIMIT = 64;

export const GOAL_STATUSES: readonly GoalStatus[] = [
  'active',
  'waiting',
  'completed',
  'failed',
  'cancelled',
];
export const TERMINAL_STATUSES: readonly GoalStatus[] = ['completed', 'failed', 'cancelled'];
const WAIT_REASONS = ['user', 'event', 'dependency', 'wakeup', 'budget'] as const;
export const SOURCE_TYPES = [
  'schedule',
  'signal',
  'user',
  'run',
  'goal',
  'wakeup',
  'custom',
] as const;
export const EVIDENCE_SOURCES = [
  'test',
  'artifact',
  'human',
  'verifier',
  'tool',
  'external',
  'model',
] as const;
export const VERDICTS = ['passed', 'failed', 'inconclusive'] as const;
const OUTCOMES: Record<GoalOutcome['reason'], GoalStatus> = {
  accepted: 'completed',
  deadline: 'failed',
  failed: 'failed',
  cancelled: 'cancelled',
};

type Fields = Record<string, unknown>;

/** Field checks that throw one GoalError code and name the field at fault. */
export class GoalChecker {
  constructor(
    readonly code: GoalErrorCode,
    readonly subject: string,
  ) {}

  fail(path: string, problem: string): never {
    throw new GoalError(this.code, `Invalid ${this.subject}: ${path} ${problem}`);
  }

  object(value: unknown, path: string): Fields {
    if (!isPlainObject(value)) this.fail(path, 'must be a plain object');
    return value;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string' || value === '') this.fail(path, 'must be a nonempty string');
    return value;
  }

  optionalString(value: unknown, path: string): void {
    if (value !== undefined) this.string(value, path);
  }

  time(value: unknown, path: string): number {
    // Number.isFinite is false for every non-number, with no coercion.
    if (!Number.isFinite(value)) this.fail(path, 'must be a finite epoch millisecond value');
    return value as number;
  }

  optionalTime(value: unknown, path: string): void {
    if (value !== undefined) this.time(value, path);
  }

  amount(value: unknown, path: string): number {
    if (!Number.isFinite(value) || (value as number) < 0)
      this.fail(path, 'must be a finite number of at least 0');
    return value as number;
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (!allowed.includes(value as T)) this.fail(path, `must be one of ${allowed.join(', ')}`);
    return value as T;
  }

  array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) this.fail(path, 'must be an array');
    return value;
  }

  json(value: unknown, path: string): void {
    const problem = jsonProblem(value, path);
    if (problem) this.fail(problem[0] || 'value', problem[1]);
  }
}

function isPlainObject(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Where a value stops being JSON that round-trips: anything but plain
 * objects, arrays, strings, finite numbers, booleans and null. An object
 * property that is undefined is left out, as JSON.stringify does.
 */
function jsonProblem(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): [string, string] | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) ? undefined : [path, 'must be a finite number'];
  if (typeof value === 'object') {
    if (seen.has(value)) return [path, 'must not contain a cycle'];
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const item: unknown = value[index];
          if (item === undefined) return [`${path}[${index}]`, 'must not be undefined'];
          const problem = jsonProblem(item, `${path}[${index}]`, seen);
          if (problem) return problem;
        }
        return undefined;
      }
      if (!isPlainObject(value))
        return [path, 'must be JSON: a plain object, not a class instance'];
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const problem = jsonProblem(item, path ? `${path}.${key}` : key, seen);
        if (problem) return problem;
      }
      return undefined;
    } finally {
      seen.delete(value);
    }
  }
  return [path, `must be JSON, not a ${typeof value}`];
}

export function checkSource(check: GoalChecker, value: unknown, path: string): GoalEventSource {
  const source = check.object(value, path);
  check.oneOf(source.type, SOURCE_TYPES, `${path}.type`);
  check.optionalString(source.id, `${path}.id`);
  return source as unknown as GoalEventSource;
}

export function checkCriterion(check: GoalChecker, value: unknown, path: string): GoalCriterion {
  const criterion = check.object(value, path);
  check.string(criterion.id, `${path}.id`);
  check.string(criterion.description, `${path}.description`);
  if (criterion.required !== undefined && typeof criterion.required !== 'boolean')
    check.fail(`${path}.required`, 'must be a boolean');
  return criterion as unknown as GoalCriterion;
}

/**
 * A goal's criteria: at least one, and at least one required, so that no goal
 * can complete without a verdict resting on evidence.
 */
export function checkCriteria(check: GoalChecker, value: unknown, path: string): GoalCriterion[] {
  const criteria = check.array(value, path);
  if (criteria.length === 0) check.fail(path, 'must hold at least one criterion');
  const ids = new Set<string>();
  criteria.forEach((item, index) => {
    const criterion = checkCriterion(check, item, `${path}[${index}]`);
    if (ids.has(criterion.id)) check.fail(`${path}[${index}].id`, `repeats ${criterion.id}`);
    ids.add(criterion.id);
  });
  if ((criteria as GoalCriterion[]).every((criterion) => criterion.required === false))
    check.fail(path, 'must hold at least one required criterion');
  return criteria as GoalCriterion[];
}

/** Evidence; `at` may be left out where the caller fills it in. */
export function checkEvidence(
  check: GoalChecker,
  value: unknown,
  path: string,
  atOptional = false,
): GoalEvidence {
  const evidence = check.object(value, path);
  check.string(evidence.id, `${path}.id`);
  check.oneOf(evidence.source, EVIDENCE_SOURCES, `${path}.source`);
  check.string(evidence.ref, `${path}.ref`);
  check.optionalString(evidence.digest, `${path}.digest`);
  check.optionalString(evidence.summary, `${path}.summary`);
  check.optionalString(evidence.runId, `${path}.runId`);
  if (atOptional) check.optionalTime(evidence.at, `${path}.at`);
  else check.time(evidence.at, `${path}.at`);
  return evidence as unknown as GoalEvidence;
}

/** A verdict; `at` and `evidence` may be left out where the caller fills them in. */
export function checkResult(
  check: GoalChecker,
  value: unknown,
  path: string,
  partial = false,
): GoalCriterionResult {
  const result = check.object(value, path);
  check.string(result.criterionId, `${path}.criterionId`);
  check.oneOf(result.verdict, VERDICTS, `${path}.verdict`);
  check.oneOf(result.source, EVIDENCE_SOURCES, `${path}.source`);
  if (!partial || result.evidence !== undefined)
    check.array(result.evidence, `${path}.evidence`).forEach((id, index) => {
      check.string(id, `${path}.evidence[${index}]`);
    });
  check.optionalString(result.note, `${path}.note`);
  if (partial) check.optionalTime(result.at, `${path}.at`);
  else check.time(result.at, `${path}.at`);
  return result as unknown as GoalCriterionResult;
}

export function checkBudget(check: GoalChecker, value: unknown, path: string): void {
  const budget = check.object(value, path);
  if (budget.usd !== undefined) check.amount(budget.usd, `${path}.usd`);
  if (budget.tokens !== undefined) check.amount(budget.tokens, `${path}.tokens`);
}

export function checkDependencies(
  check: GoalChecker,
  value: unknown,
  path: string,
): GoalDependency[] {
  const on = check.array(value, path);
  if (on.length === 0) check.fail(path, 'must name at least one goal or run');
  const keys = new Set<string>();
  on.forEach((item, index) => {
    const dependency = check.object(item, `${path}[${index}]`);
    check.oneOf(dependency.kind, ['goal', 'run'], `${path}[${index}].kind`);
    check.string(dependency.id, `${path}[${index}].id`);
    if (dependency.settled !== undefined && typeof dependency.settled !== 'boolean')
      check.fail(`${path}[${index}].settled`, 'must be a boolean');
    const key = `${String(dependency.kind)}:${String(dependency.id)}`;
    if (keys.has(key)) check.fail(`${path}[${index}]`, `repeats ${key}`);
    keys.add(key);
  });
  return on as GoalDependency[];
}

/** A wait's reason-specific fields; `id` and `since` are checked by the caller. */
export function checkWaitDetails(check: GoalChecker, wait: Fields, path: string): void {
  const reason = check.oneOf(wait.reason, WAIT_REASONS, `${path}.reason`);
  check.optionalString(wait.note, `${path}.note`);
  if (reason === 'event') checkSource(check, wait.source, `${path}.source`);
  else if (reason === 'dependency') checkDependencies(check, wait.on, `${path}.on`);
  else if (reason === 'wakeup') {
    check.time(wait.at, `${path}.at`);
    check.optionalString(wait.schedule, `${path}.schedule`);
  } else if (reason === 'budget') check.oneOf(wait.limit, ['usd', 'tokens'], `${path}.limit`);
}

function checkWaiting(check: GoalChecker, value: unknown, path: string): GoalWaiting {
  const wait = check.object(value, path);
  check.string(wait.id, `${path}.id`);
  check.time(wait.since, `${path}.since`);
  checkWaitDetails(check, wait, path);
  return wait as unknown as GoalWaiting;
}

/**
 * Checks a version 1 record whose defaulted fields are filled in, and returns
 * it. Throws `invalid_goal` naming the first field at fault.
 */
export function checkGoalRecord(value: unknown): GoalRecord {
  const check = new GoalChecker('invalid_goal', 'goal record');
  const record = check.object(value, 'record');
  if (record.kind !== 'deuz-goal') check.fail('kind', "must be 'deuz-goal'");
  if (record.version !== GOAL_RECORD_VERSION)
    check.fail('version', `must be ${GOAL_RECORD_VERSION}`);
  check.string(record.goalId, 'goalId');
  check.string(record.scope, 'scope');
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1)
    check.fail('revision', 'must be an integer of at least 1');
  check.optionalString(record.parentGoalId, 'parentGoalId');
  check.optionalString(record.runId, 'runId');
  check.string(record.objective, 'objective');
  const criteria = checkCriteria(check, record.criteria, 'criteria');
  const evidenceIds = new Set<string>();
  check.array(record.evidence, 'evidence').forEach((item, index) => {
    const evidence = checkEvidence(check, item, `evidence[${index}]`);
    if (evidenceIds.has(evidence.id)) check.fail(`evidence[${index}].id`, `repeats ${evidence.id}`);
    evidenceIds.add(evidence.id);
  });
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const judged = new Set<string>();
  check.array(record.results, 'results').forEach((item, index) => {
    const result = checkResult(check, item, `results[${index}]`);
    if (!criterionIds.has(result.criterionId))
      check.fail(
        `results[${index}].criterionId`,
        `must name a criterion, not ${result.criterionId}`,
      );
    if (judged.has(result.criterionId))
      check.fail(`results[${index}].criterionId`, `repeats ${result.criterionId}`);
    judged.add(result.criterionId);
    result.evidence.forEach((id, at) => {
      if (!evidenceIds.has(id))
        check.fail(`results[${index}].evidence[${at}]`, `must name recorded evidence, not ${id}`);
    });
  });
  if (record.budget !== undefined) checkBudget(check, record.budget, 'budget');
  const spent = check.object(record.spent, 'spent');
  check.amount(spent.usd, 'spent.usd');
  check.amount(spent.tokens, 'spent.tokens');
  check.optionalTime(record.deadline, 'deadline');
  const status = check.oneOf(record.status, GOAL_STATUSES, 'status');
  if (status === 'waiting') {
    if (record.waiting === undefined)
      check.fail('waiting', "is required while status is 'waiting'");
    checkWaiting(check, record.waiting, 'waiting');
  } else if (record.waiting !== undefined)
    check.fail('waiting', "must be absent unless status is 'waiting'");
  if (TERMINAL_STATUSES.includes(status)) {
    const outcome = check.object(record.outcome, 'outcome');
    const reason = check.oneOf(
      outcome.reason,
      Object.keys(OUTCOMES) as GoalOutcome['reason'][],
      'outcome.reason',
    );
    if (OUTCOMES[reason] !== status)
      check.fail('outcome.reason', `${reason} does not end a goal as ${status}`);
    check.optionalString(outcome.detail, 'outcome.detail');
    check.time(outcome.at, 'outcome.at');
  } else if (record.outcome !== undefined)
    check.fail('outcome', 'must be absent until the goal ends');
  const seen = check.array(record.seen, 'seen');
  if (seen.length > GOAL_SEEN_LIMIT)
    check.fail('seen', `must hold at most ${GOAL_SEEN_LIMIT} keys`);
  seen.forEach((key, index) => check.string(key, `seen[${index}]`));
  check.time(record.createdAt, 'createdAt');
  check.time(record.updatedAt, 'updatedAt');
  if (record.meta !== undefined) {
    check.object(record.meta, 'meta');
    check.json(record.meta, 'meta');
  }
  return record as unknown as GoalRecord;
}

/**
 * Fills the fields a version 1 writer may leave out (no evidence, results,
 * spend or applied keys yet). Returns the record itself when none is missing.
 */
export function withGoalDefaults(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const missing: Fields = {};
  if (value.evidence === undefined) missing.evidence = [];
  if (value.results === undefined) missing.results = [];
  if (value.spent === undefined) missing.spent = { usd: 0, tokens: 0 };
  if (value.seen === undefined) missing.seen = [];
  return Object.keys(missing).length ? { ...value, ...missing } : value;
}

/** A record, checked, with its defaults filled in: what every goal function works on. */
export function readGoal(value: unknown): GoalRecord {
  return checkGoalRecord(withGoalDefaults(value));
}

/** Checks a version 1 event, and returns it. Throws `invalid_event`. */
export function checkGoalEvent(value: unknown): GoalEvent {
  const check = new GoalChecker('invalid_event', 'goal event');
  const event = check.object(value, 'event');
  if (event.kind !== 'deuz-goal-event') check.fail('kind', "must be 'deuz-goal-event'");
  if (event.version !== GOAL_EVENT_VERSION) check.fail('version', `must be ${GOAL_EVENT_VERSION}`);
  check.string(event.id, 'id');
  check.string(event.key, 'key');
  checkSource(check, event.source, 'source');
  check.string(event.scope, 'scope');
  check.string(event.goalId, 'goalId');
  check.optionalString(event.runId, 'runId');
  check.time(event.at, 'at');
  check.optionalTime(event.notBefore, 'notBefore');
  check.optionalTime(event.expiresAt, 'expiresAt');
  if (
    event.notBefore !== undefined &&
    event.expiresAt !== undefined &&
    (event.expiresAt as number) <= (event.notBefore as number)
  )
    check.fail('expiresAt', 'must be after notBefore');
  if (event.payload !== undefined) {
    const payload = check.object(event.payload, 'payload');
    check.string(payload.ref, 'payload.ref');
    check.optionalString(payload.digest, 'payload.digest');
    check.optionalString(payload.mediaType, 'payload.mediaType');
    if (
      payload.bytes !== undefined &&
      (!Number.isSafeInteger(payload.bytes) || (payload.bytes as number) < 0)
    )
      check.fail('payload.bytes', 'must be an integer of at least 0');
  }
  check.optionalString(event.correlationId, 'correlationId');
  check.optionalString(event.causationId, 'causationId');
  return event as unknown as GoalEvent;
}

/** Reads one version into the next, keyed by the version it reads. */
type Migrations = Readonly<Record<number, (value: Fields) => Fields>>;

/**
 * The record migrations. Empty: version 1 is the first format (2.3). A format
 * change adds the step from the version before it, so every record an earlier
 * release wrote still loads.
 */
const GOAL_MIGRATIONS: Migrations = {};
const EVENT_MIGRATIONS: Migrations = {};

/**
 * Reads a record or an event from JSON text or a parsed value: the kind, then
 * the version (newer than this build reads: `unsupported_version`; older: the
 * migrations bring it forward), as a deep copy with any JSON problem refused.
 */
function readVersioned(
  input: unknown,
  format: {
    kind: string;
    version: number;
    migrations: Migrations;
    code: 'invalid_goal' | 'invalid_event';
    subject: string;
    root: string;
  },
): Fields {
  const check = new GoalChecker(format.code, format.subject);
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      check.fail(
        'text',
        `must be JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const object = check.object(value, format.root);
  if (object.kind !== format.kind) check.fail('kind', `must be '${format.kind}'`);
  const found = object.version;
  if (!Number.isSafeInteger(found) || (found as number) < 1)
    check.fail('version', 'must be a positive integer');
  if ((found as number) > format.version)
    throw new GoalError(
      'unsupported_version',
      `A ${format.subject} of version ${String(found)} needs a newer @deuz-sdk/core; this build reads version ${format.version}.`,
    );
  check.json(object, '');
  let current = structuredClone(object);
  for (let version = found as number; version < format.version; version++) {
    const step = format.migrations[version];
    if (!step)
      throw new GoalError(
        'unsupported_version',
        `A ${format.subject} of version ${version} cannot be read by this build.`,
      );
    current = step(current);
  }
  return current;
}

/**
 * Reads a goal record from its JSON text, or from the parsed value, as a new
 * object: any version up to `GOAL_RECORD_VERSION`, with the fields a writer
 * may leave out filled in and every field a later 2.x release added kept.
 * Throws `GoalError`: `unsupported_version` for a newer version,
 * `invalid_goal` for anything else that is not a valid record.
 */
export function parseGoal(input: unknown): GoalRecord {
  return readGoal(
    readVersioned(input, {
      kind: 'deuz-goal',
      version: GOAL_RECORD_VERSION,
      migrations: GOAL_MIGRATIONS,
      code: 'invalid_goal',
      subject: 'goal record',
      root: 'record',
    }),
  );
}

/** The JSON text of a valid goal record. Throws `invalid_goal` for anything JSON would change. */
export function serializeGoal(record: GoalRecord): string {
  const checked = readGoal(record);
  new GoalChecker('invalid_goal', 'goal record').json(checked, '');
  return JSON.stringify(checked);
}

/** Reads a goal event from its JSON text, or from the parsed value, as a new object. */
export function parseGoalEvent(input: unknown): GoalEvent {
  return checkGoalEvent(
    readVersioned(input, {
      kind: 'deuz-goal-event',
      version: GOAL_EVENT_VERSION,
      migrations: EVENT_MIGRATIONS,
      code: 'invalid_event',
      subject: 'goal event',
      root: 'event',
    }),
  );
}

/** The JSON text of a valid goal event. */
export function serializeGoalEvent(event: GoalEvent): string {
  const checked = checkGoalEvent(event);
  new GoalChecker('invalid_event', 'goal event').json(checked, '');
  return JSON.stringify(checked);
}
