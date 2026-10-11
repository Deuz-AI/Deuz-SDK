/**
 * Goal transitions (2.3): pure functions from a record, a command and a time
 * to the next record. They read no clock, start no timer and write nothing;
 * the host saves what they return, fenced by the record's revision.
 */
import { GoalError } from './errors';
import { UNSUPPORTED_PASS, assessGoal, supportsPass } from './acceptance';
import {
  GOAL_RECORD_VERSION,
  GOAL_SEEN_LIMIT,
  GoalChecker,
  TERMINAL_STATUSES,
  checkBudget,
  checkCriteria,
  checkEvidence,
  checkGoalEvent,
  checkResult,
  checkWaitDetails,
  readGoal,
} from './validate';
import type {
  GoalAcceptance,
  GoalBudget,
  GoalCommand,
  GoalCriterion,
  GoalCriterionInput,
  GoalCriterionResult,
  GoalCriterionResultInput,
  GoalEvent,
  GoalEvidence,
  GoalEvidenceInput,
  GoalRecord,
  GoalTransition,
  GoalTransitionReason,
  GoalWaitRequest,
  GoalWaiting,
} from './types';

/** What `createGoal` needs. */
export interface CreateGoalInput {
  goalId: string;
  scope: string;
  objective: string;
  /** Default: one criterion, `objective`, that the objective is met. */
  criteria?: GoalCriterionInput[];
  parentGoalId?: string;
  runId?: string;
  budget?: GoalBudget;
  /** Epoch ms, after `now`. */
  deadline?: number;
  meta?: Record<string, unknown>;
}

/** The time a goal function works at, and the revision it expects. */
export interface GoalTransitionOptions {
  /** The transition's time, epoch ms: your clock's, a fake one in tests. */
  now: number;
  /** Apply only to this revision; any other throws `revision_conflict`. */
  expectedRevision?: number;
}

const COMMANDS: readonly GoalCommand['type'][] = [
  'wait',
  'resume',
  'event',
  'evidence',
  'evaluate',
  'complete',
  'fail',
  'cancel',
  'charge',
  'revise',
  'link-run',
  'tick',
];

const isTerminal = (record: GoalRecord): boolean => TERMINAL_STATUSES.includes(record.status);

/** The limit a spend reached, if any. */
function exhausted(record: GoalRecord): 'usd' | 'tokens' | undefined {
  const { budget, spent } = record;
  if (budget?.usd !== undefined && spent.usd >= budget.usd) return 'usd';
  if (budget?.tokens !== undefined && spent.tokens >= budget.tokens) return 'tokens';
  return undefined;
}

/**
 * The wait events and time answer: the goal's own, or the one a spent budget
 * interrupted, which still ends meanwhile. None while the goal is not waiting.
 */
function answerable(record: GoalRecord): Exclude<GoalWaiting, { reason: 'budget' }> | undefined {
  const wait = record.status === 'waiting' ? record.waiting : undefined;
  return wait?.reason === 'budget' ? wait.interrupted : wait;
}

const criterionOf = (input: GoalCriterionInput): GoalCriterion => ({
  id: input.id,
  description: input.description,
  ...(input.required !== undefined ? { required: input.required } : {}),
});

const evidenceOf = (input: GoalEvidenceInput, now: number): GoalEvidence => ({
  id: input.id,
  source: input.source,
  ref: input.ref,
  ...(input.digest !== undefined ? { digest: input.digest } : {}),
  ...(input.summary !== undefined ? { summary: input.summary } : {}),
  ...(input.runId !== undefined ? { runId: input.runId } : {}),
  at: input.at ?? now,
});

/** Evidence that says the same, whenever it was recorded. */
const sameEvidence = (left: GoalEvidence, right: GoalEvidence): boolean =>
  JSON.stringify({ ...left, at: 0 }) === JSON.stringify({ ...right, at: 0 });

/**
 * A new goal (2.3): `active`, at revision 1. Without criteria, the objective
 * itself is the one criterion. Throws `invalid_goal` for malformed input,
 * including a deadline that is not after `now`.
 */
export function createGoal(input: CreateGoalInput, options: { now: number }): GoalRecord {
  const check = new GoalChecker('invalid_goal', 'goal');
  const now = check.time(options?.now, 'now');
  const fields = check.object(input, 'input');
  const objective = check.string(fields.objective, 'objective');
  const criteria = checkCriteria(
    check,
    fields.criteria ?? [{ id: 'objective', description: objective }],
    'criteria',
  );
  if (fields.budget !== undefined) checkBudget(check, fields.budget, 'budget');
  if (fields.deadline !== undefined && check.time(fields.deadline, 'deadline') <= now)
    check.fail('deadline', 'must be after now');
  if (fields.meta !== undefined) {
    check.object(fields.meta, 'meta');
    check.json(fields.meta, 'meta');
  }
  return readGoal({
    kind: 'deuz-goal',
    version: GOAL_RECORD_VERSION,
    goalId: input.goalId,
    scope: input.scope,
    revision: 1,
    ...(input.parentGoalId !== undefined ? { parentGoalId: input.parentGoalId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    objective,
    criteria: criteria.map(criterionOf),
    evidence: [],
    results: [],
    ...(input.budget !== undefined ? { budget: { ...input.budget } } : {}),
    spent: { usd: 0, tokens: 0 },
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    status: 'active',
    seen: [],
    charged: [],
    createdAt: now,
    updatedAt: now,
    ...(input.meta !== undefined ? { meta: structuredClone(input.meta) } : {}),
  });
}

/** Checks a command's shape; throws `invalid_command` (or `invalid_event` for its event). */
function checkCommand(command: GoalCommand): void {
  const check = new GoalChecker('invalid_command', 'goal command');
  const fields = check.object(command, 'command');
  const type = check.oneOf(fields.type, COMMANDS, 'type');
  if (type === 'wait') {
    const wait = check.object(fields.wait, 'wait');
    if (wait.reason === 'budget') check.fail('wait.reason', 'budget is entered by a charge');
    check.optionalString(wait.id, 'wait.id');
    checkWaitDetails(check, wait, 'wait');
  } else if (type === 'event') checkGoalEvent(fields.event);
  else if (type === 'evidence' || (type === 'evaluate' && fields.evidence !== undefined))
    check.array(fields.evidence, 'evidence').forEach((item, index) => {
      checkEvidence(check, item, `evidence[${index}]`, true);
    });
  if (type === 'evaluate') {
    const judged = new Set<string>();
    check.array(fields.results, 'results').forEach((item, index) => {
      const result = checkResult(check, item, `results[${index}]`, true);
      if (judged.has(result.criterionId))
        check.fail(`results[${index}].criterionId`, `repeats ${result.criterionId}`);
      judged.add(result.criterionId);
    });
  } else if (type === 'fail') check.string(fields.reason, 'reason');
  else if (type === 'cancel') check.optionalString(fields.reason, 'reason');
  else if (type === 'charge') {
    if (fields.usd !== undefined) check.amount(fields.usd, 'usd');
    if (fields.tokens !== undefined) check.amount(fields.tokens, 'tokens');
    check.optionalString(fields.key, 'key');
  } else if (type === 'revise') {
    if (fields.objective !== undefined) check.string(fields.objective, 'objective');
    if (fields.criteria !== undefined) checkCriteria(check, fields.criteria, 'criteria');
    if (fields.budget !== undefined && fields.budget !== null)
      checkBudget(check, fields.budget, 'budget');
    if (fields.deadline !== undefined && fields.deadline !== null)
      check.time(fields.deadline, 'deadline');
    if (fields.meta !== undefined && fields.meta !== null) {
      check.object(fields.meta, 'meta');
      check.json(fields.meta, 'meta');
    }
  } else if (type === 'link-run') check.string(fields.runId, 'runId');
}

type Step = {
  outcome: GoalTransition['outcome'];
  reason?: GoalTransitionReason;
  acceptance?: GoalAcceptance;
};
const applied = (acceptance?: GoalAcceptance): Step => ({
  outcome: 'applied',
  ...(acceptance ? { acceptance } : {}),
});
const ignored = (reason: GoalTransitionReason): Step => ({ outcome: 'ignored', reason });
const rejected = (reason: GoalTransitionReason, acceptance?: GoalAcceptance): Step => ({
  outcome: 'rejected',
  reason,
  ...(acceptance ? { acceptance } : {}),
});

/** The record a transition works on: the given one until the first change, then a copy. */
class Draft {
  private copy: GoalRecord | undefined;
  constructor(
    private readonly base: GoalRecord,
    readonly now: number,
  ) {}

  get current(): GoalRecord {
    return this.copy ?? this.base;
  }

  get changed(): boolean {
    return this.copy !== undefined;
  }

  edit(): GoalRecord {
    if (!this.copy) {
      try {
        this.copy = structuredClone(this.base);
      } catch (error) {
        throw new GoalError(
          'invalid_goal',
          `Invalid goal record: record must be JSON (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return this.copy;
  }

  /** The revision a change made now is saved at. */
  get nextRevision(): number {
    return this.base.revision + 1;
  }

  /** Remembers an applied key: an event's in `seen`, a charge's apart from them in `charged`. */
  remember(key: string, window: 'seen' | 'charged' = 'seen'): void {
    const record = this.edit();
    record[window] = [...record[window], key].slice(-GOAL_SEEN_LIMIT);
  }

  activate(): void {
    const record = this.edit();
    record.status = 'active';
    delete record.waiting;
  }

  /** Ends the wait an event or a tick answered; a spent budget still holds the goal. */
  answer(): void {
    const record = this.edit();
    if (record.waiting?.reason === 'budget') delete record.waiting.interrupted;
    else this.activate();
  }

  end(status: 'completed' | 'failed' | 'cancelled', outcome: GoalRecord['outcome']): void {
    const record = this.edit();
    record.status = status;
    record.outcome = outcome;
    delete record.waiting;
  }

  /**
   * A spent budget holds a goal that has not ended, keeping the wait it
   * interrupts; a raised one releases it, back to that wait if there is one.
   */
  settleBudget(): void {
    const record = this.current;
    if (isTerminal(record)) return;
    const limit = exhausted(record);
    const budgetWait = record.status === 'waiting' && record.waiting?.reason === 'budget';
    if (limit && !budgetWait) {
      const next = this.edit();
      const interrupted = answerable(next);
      next.status = 'waiting';
      next.waiting = {
        reason: 'budget',
        id: `${record.goalId}#${this.nextRevision}`,
        since: this.now,
        limit,
        ...(interrupted ? { interrupted } : {}),
      };
    } else if (!limit && budgetWait) {
      const next = this.edit();
      const interrupted = answerable(next);
      if (interrupted) next.waiting = interrupted;
      else this.activate();
    }
  }

  finish(step: Step): GoalTransition {
    if (!this.copy) return { record: this.base, changed: false, ...step };
    this.copy.revision = this.nextRevision;
    this.copy.updatedAt = Math.max(this.base.updatedAt, this.now);
    return { record: readGoal(this.copy), changed: true, ...step };
  }
}

/**
 * The one way a goal changes (2.3). Pure: it reads no clock and writes
 * nothing. It returns the next record, one revision higher, with `changed`
 * when there is anything to save, and says what it did: `'applied'`,
 * `'ignored'` (an event or charge the goal drops, with why) or `'rejected'` (a
 * command the goal refuses, with why).
 *
 * A deadline at or before `now` fails the goal before the command applies.
 * A record or command that is malformed, an `expectedRevision` the record is
 * not at, or an event meant for another goal throws `GoalError`.
 */
export function transitionGoal(
  record: GoalRecord,
  command: GoalCommand,
  options: GoalTransitionOptions,
): GoalTransition {
  const now = new GoalChecker('invalid_command', 'goal transition').time(options?.now, 'now');
  const current = readGoal(record);
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision)
    throw new GoalError(
      'revision_conflict',
      `Goal ${current.goalId} is at revision ${current.revision}, not ${String(options.expectedRevision)}.`,
    );
  checkCommand(command);
  const draft = new Draft(current, now);
  // Time first: once its deadline passed, the goal ended there.
  if (!isTerminal(current) && current.deadline !== undefined && now >= current.deadline)
    draft.end('failed', { reason: 'deadline', at: current.deadline });
  return draft.finish(apply(draft, command));
}

function apply(draft: Draft, command: GoalCommand): Step {
  const goal = draft.current;
  const now = draft.now;
  switch (command.type) {
    case 'tick': {
      if (draft.changed) return applied();
      if (isTerminal(goal)) return ignored('terminal');
      const wait = answerable(goal);
      if (wait?.reason === 'wakeup' && now >= wait.at) {
        draft.answer();
        return applied();
      }
      return ignored('unchanged');
    }
    case 'event':
      return applyEvent(draft, command.event);
    case 'charge': {
      // Charge keys are a space of their own: a run's charge and its completion
      // event may both be keyed by the run ID.
      if (command.key !== undefined && goal.charged.includes(command.key))
        return ignored('duplicate');
      const usd = command.usd ?? 0;
      const tokens = command.tokens ?? 0;
      if (usd === 0 && tokens === 0 && command.key === undefined) return ignored('unchanged');
      // A run's spend is recorded even after the goal ended.
      const next = draft.edit();
      next.spent = { usd: next.spent.usd + usd, tokens: next.spent.tokens + tokens };
      if (command.key !== undefined) draft.remember(command.key, 'charged');
      draft.settleBudget();
      return applied();
    }
    case 'cancel':
      if (goal.status === 'cancelled') return ignored('unchanged');
      break;
  }
  if (isTerminal(goal)) return rejected('terminal');
  switch (command.type) {
    case 'wait': {
      if (goal.waiting?.reason === 'budget') return rejected('budget-exhausted');
      const wait = waitingOf(command.wait, `${goal.goalId}#${draft.nextRevision}`, now);
      // A dependency wait whose every dependency settled is over as it begins.
      if (wait.reason === 'dependency' && wait.on.every((dependency) => dependency.settled)) {
        if (goal.status === 'active') return ignored('unchanged');
        draft.activate();
        return applied();
      }
      const next = draft.edit();
      next.status = 'waiting';
      next.waiting = wait;
      return applied();
    }
    case 'resume': {
      if (goal.status === 'active') return ignored('unchanged');
      if (goal.waiting?.reason === 'budget' && exhausted(goal)) return rejected('budget-exhausted');
      draft.activate();
      return applied();
    }
    case 'evidence': {
      const added = addEvidence(draft, command.evidence);
      if (typeof added === 'string') return rejected(added);
      return added ? applied() : ignored('unchanged');
    }
    case 'evaluate':
      return evaluate(draft, command.results, command.evidence ?? []);
    case 'complete': {
      const acceptance = assessGoal(goal);
      if (acceptance.verdict !== 'passed') return rejected('acceptance-not-passed', acceptance);
      draft.end('completed', { reason: 'accepted', at: now });
      return applied(acceptance);
    }
    case 'fail':
      draft.end('failed', { reason: 'failed', detail: command.reason, at: now });
      return applied();
    case 'cancel':
      draft.end('cancelled', {
        reason: 'cancelled',
        ...(command.reason !== undefined ? { detail: command.reason } : {}),
        at: now,
      });
      return applied();
    case 'link-run':
      if (goal.runId === command.runId) return ignored('unchanged');
      draft.edit().runId = command.runId;
      return applied();
    case 'revise':
      return revise(draft, command);
  }
  // 'tick', 'event' and 'charge' returned above.
  return ignored('unchanged');
}

function waitingOf(request: GoalWaitRequest, fallbackId: string, now: number): GoalWaiting {
  const base = {
    id: request.id ?? fallbackId,
    since: now,
    ...(request.note !== undefined ? { note: request.note } : {}),
  };
  switch (request.reason) {
    case 'user':
      return { reason: 'user', ...base };
    case 'event':
      return {
        reason: 'event',
        ...base,
        source: {
          type: request.source.type,
          ...(request.source.id !== undefined ? { id: request.source.id } : {}),
        },
      };
    case 'dependency':
      // Settled only where the request says the dependency already finished.
      return {
        reason: 'dependency',
        ...base,
        on: request.on.map((dependency) => ({
          kind: dependency.kind,
          id: dependency.id,
          ...(dependency.settled ? { settled: true } : {}),
        })),
      };
    case 'wakeup':
      return {
        reason: 'wakeup',
        ...base,
        at: request.at,
        ...(request.schedule !== undefined ? { schedule: request.schedule } : {}),
      };
  }
}

/**
 * Applies an outside event. In order: an event for another goal throws; a
 * goal that ended, an event already applied, one past its `expiresAt` or
 * before its `notBefore`, one while the goal waits for nothing, one answering
 * another wait or older than this one (a dependency's completion is never too
 * old), and one the wait is not for are dropped, each with its reason.
 * Otherwise the event ends the wait (a dependency wait once every dependency
 * reported) and its key is remembered. During a budget wait, the wait is the
 * one the budget interrupted.
 */
function applyEvent(draft: Draft, event: GoalEvent): Step {
  const goal = draft.current;
  if (event.scope !== goal.scope || event.goalId !== goal.goalId)
    throw new GoalError(
      'scope_mismatch',
      `Event ${event.id} is for goal ${event.goalId} in scope ${event.scope}, not goal ${goal.goalId} in scope ${goal.scope}.`,
    );
  if (isTerminal(goal)) return ignored('terminal');
  if (goal.seen.includes(event.key)) return ignored('duplicate');
  if (event.expiresAt !== undefined && draft.now >= event.expiresAt) return ignored('expired');
  if (event.notBefore !== undefined && draft.now < event.notBefore) return ignored('early');
  const wait = answerable(goal);
  if (!wait) return ignored('unmatched');
  if (event.correlationId !== undefined && event.correlationId !== wait.id) return ignored('stale');
  // A completion is a state: a dependency that finished just before the wait
  // began has still finished.
  if (wait.reason !== 'dependency' && event.at < wait.since) return ignored('stale');
  const { source } = event;
  switch (wait.reason) {
    case 'user':
      if (source.type !== 'user') return ignored('unmatched');
      break;
    case 'event':
      if (
        source.type !== wait.source.type ||
        (wait.source.id !== undefined && source.id !== wait.source.id)
      )
        return ignored('unmatched');
      break;
    case 'wakeup': {
      const fromSchedule =
        source.type === 'schedule' && (wait.schedule === undefined || source.id === wait.schedule);
      const own = source.type === 'wakeup' && wait.schedule === undefined;
      if (!(fromSchedule || own) || event.at < wait.at) return ignored('unmatched');
      break;
    }
    case 'dependency': {
      const index = wait.on.findIndex(
        (dependency) =>
          !dependency.settled && dependency.kind === source.type && dependency.id === source.id,
      );
      if (index < 0) return ignored('unmatched');
      draft.remember(event.key);
      const { on } = answerable(draft.edit()) as Extract<GoalWaiting, { reason: 'dependency' }>;
      on[index] = { ...on[index]!, settled: true };
      if (on.every((dependency) => dependency.settled)) draft.answer();
      return applied();
    }
  }
  draft.remember(event.key);
  draft.answer();
  return applied();
}

/**
 * Adds evidence: true when anything was added, false when all of it was
 * there already, or the reason to refuse it all.
 */
function addEvidence(
  draft: Draft,
  inputs: readonly GoalEvidenceInput[],
): boolean | GoalTransitionReason {
  const known = new Map(draft.current.evidence.map((item) => [item.id, item]));
  const added: GoalEvidence[] = [];
  for (const input of inputs) {
    const evidence = evidenceOf(input, draft.now);
    const existing = known.get(evidence.id);
    if (existing) {
      if (!sameEvidence(existing, evidence)) return 'evidence-conflict';
      continue;
    }
    known.set(evidence.id, evidence);
    added.push(evidence);
  }
  if (added.length === 0) return false;
  const next = draft.edit();
  next.evidence = [...next.evidence, ...added];
  return true;
}

function evaluate(
  draft: Draft,
  inputs: readonly GoalCriterionResultInput[],
  evidence: readonly GoalEvidenceInput[],
): Step {
  const goal = draft.current;
  const criteria = new Set(goal.criteria.map((criterion) => criterion.id));
  const evidenceIds = new Set([...goal.evidence, ...evidence].map((item) => item.id));
  for (const input of inputs) {
    if (!criteria.has(input.criterionId)) return rejected('unknown-criterion');
    if ((input.evidence ?? []).some((id) => !evidenceIds.has(id)))
      return rejected('unknown-evidence');
  }
  const added = addEvidence(draft, evidence);
  if (typeof added === 'string') return rejected(added);
  const recorded = draft.current.evidence;
  let changed = added;
  const results = [...draft.current.results];
  for (const input of inputs) {
    const result: GoalCriterionResult = {
      criterionId: input.criterionId,
      verdict: input.verdict,
      source: input.source,
      evidence: [...(input.evidence ?? [])],
      ...(input.note !== undefined ? { note: input.note } : {}),
      at: input.at ?? draft.now,
    };
    // A model saying "done" is recorded as what it is.
    if (result.verdict === 'passed' && !supportsPass(result, recorded)) {
      result.verdict = 'inconclusive';
      result.note =
        input.note !== undefined ? `${UNSUPPORTED_PASS} ${input.note}` : UNSUPPORTED_PASS;
    }
    const index = results.findIndex((item) => item.criterionId === result.criterionId);
    if (index < 0) results.push(result);
    else results[index] = result;
    changed = true;
  }
  if (!changed) return ignored('unchanged');
  draft.edit().results = results;
  return applied(assessGoal(draft.current));
}

function revise(draft: Draft, command: Extract<GoalCommand, { type: 'revise' }>): Step {
  if (typeof command.deadline === 'number' && command.deadline <= draft.now)
    return rejected('deadline-passed');
  const goal = draft.current;
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  let changed = false;
  if (command.objective !== undefined && command.objective !== goal.objective) {
    draft.edit().objective = command.objective;
    changed = true;
  }
  if (command.criteria !== undefined) {
    const criteria = command.criteria.map(criterionOf);
    if (differs(criteria, goal.criteria)) {
      const next = draft.edit();
      // A verdict stands only for a criterion that still says the same.
      const kept = new Map(
        goal.criteria.map((criterion) => [criterion.id, JSON.stringify(criterion)]),
      );
      next.results = next.results.filter((result) => {
        const criterion = criteria.find((item) => item.id === result.criterionId);
        return criterion !== undefined && kept.get(criterion.id) === JSON.stringify(criterion);
      });
      next.criteria = criteria;
      changed = true;
    }
  }
  if (command.budget !== undefined && differs(command.budget ?? undefined, goal.budget)) {
    const next = draft.edit();
    if (command.budget === null) delete next.budget;
    else next.budget = { ...command.budget };
    changed = true;
  }
  if (command.deadline !== undefined && (command.deadline ?? undefined) !== goal.deadline) {
    const next = draft.edit();
    if (command.deadline === null) delete next.deadline;
    else next.deadline = command.deadline;
    changed = true;
  }
  if (command.meta !== undefined && differs(command.meta ?? undefined, goal.meta)) {
    const next = draft.edit();
    if (command.meta === null) delete next.meta;
    else next.meta = structuredClone(command.meta);
    changed = true;
  }
  if (!changed) return ignored('unchanged');
  draft.settleBudget();
  return applied();
}
