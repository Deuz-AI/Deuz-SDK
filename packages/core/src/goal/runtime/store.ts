/**
 * The in-memory goal runtime store (2.4) and the helpers every adapter shares,
 * so the SQLite and PostgreSQL stores key and default exactly like this one.
 * Edge-safe.
 */
import type { Dependencies } from '../../types/deps';
import { resolveDependencies } from '../../internal/resolve-deps';
import { notImplemented } from '../../internal/not-implemented';
import { planGoalList, goalListCursor } from '../store';
import type { GoalRecord } from '../types';
import {
  checkAdvance,
  checkApplication,
  checkEnqueue,
  checkGoal,
  checkIntentInput,
  checkRuntimeState,
  checkScheduleInput,
  checkScheduleOptions,
  goalsNewestFirst,
  inboxKey,
  inboxOldestFirst,
  isPendingDeliveryOf,
  jsonCopy,
  matchesInboxList,
  matchesOccurrenceList,
  matchesScheduleList,
  occurrenceKey,
  occurrencesOldestFirst,
  pageOf,
  planAdvance,
  planApply,
  planEnqueue,
  planGoalSave,
  planInboxList,
  planIntentRecord,
  planOccurrenceList,
  planRuntimeSave,
  planScheduleCancel,
  planScheduleList,
  planSchedulePause,
  planSchedulePut,
  planScheduleResume,
  scheduleKey,
  schedulesById,
  type GoalRuntimePlan,
  type GoalRuntimeWrite,
} from './store-shared';
import type {
  DurableSchedule,
  GoalInboxEnqueue,
  GoalInboxEntry,
  GoalRunIntent,
  GoalRuntimePolicy,
  GoalRuntimeState,
  GoalRuntimeStore,
  ScheduleOccurrenceRecord,
} from './store-types';

/** The supervisor's policy defaults (spec §3.1); copy `retryDelaysMs` before changing it. */
export const DEFAULT_GOAL_RUNTIME_POLICY = {
  maxRuns: 10,
  maxRetries: 3,
  retryDelaysMs: [1_000, 5_000, 30_000],
  retainPayloadMs: 7 * 24 * 60 * 60 * 1_000,
} as const satisfies { [K in keyof GoalRuntimePolicy]: GoalRuntimePolicy[K] | readonly number[] };

/**
 * The id of an inbox entry (2.4): `inbox:` and the JSON of
 * `[scope, namespace, deliveryId]`, like a native run's lease key. The same
 * delivery in the same scope and namespace always has the same id, on every
 * store.
 */
export function goalInboxKey(scope: string, namespace: string, deliveryId: string): string {
  for (const [name, value] of [
    ['scope', scope],
    ['namespace', namespace],
    ['deliveryId', deliveryId],
  ] as const) {
    if (typeof value !== 'string' || value === '')
      throw new TypeError(`An inbox ${name} must be a nonempty string`);
  }
  return `inbox:${JSON.stringify([scope, namespace, deliveryId])}`;
}

/** The inbox entry id of a delivery. */
export function deliveryKey(
  delivery: Pick<GoalInboxEnqueue, 'scope' | 'namespace' | 'deliveryId'>,
) {
  return goalInboxKey(delivery.scope, delivery.namespace, delivery.deliveryId);
}

/**
 * The in-memory `GoalRuntimeStore` (2.4): the reference for tests and one
 * process. Copies in and out; every multi-part write is applied whole or not
 * at all; passes the goal-store conformance fixture and the schedule-store
 * conformance fixture. Times it stamps come from `deps.clock`.
 */
export function createInMemoryGoalRuntimeStore(options?: {
  deps?: Dependencies;
}): GoalRuntimeStore {
  const { clock } = resolveDependencies(options?.deps);
  const goals = new Map<string, GoalRecord>();
  /** By goal ID, which is globally unique. */
  const runtimes = new Map<string, GoalRuntimeState>();
  /** By entry ID, which holds the scope. */
  const entries = new Map<string, GoalInboxEntry>();
  /** By `[scope, intentId]`. */
  const intents = new Map<string, GoalRunIntent>();
  /** By `[scope, scheduleId]`. */
  const schedules = new Map<string, DurableSchedule>();
  /** By `[scope, occurrenceId]`. */
  const occurrences = new Map<string, ScheduleOccurrenceRecord>();
  const scoped = (scope: string, id: string): string => JSON.stringify([scope, id]);

  /** Applies a plan's writes; each one is already checked, so nothing here can fail half way. */
  const apply = (writes: readonly GoalRuntimeWrite[]): void => {
    for (const write of writes) {
      if (write.kind === 'goal') goals.set(write.record.goalId, write.record);
      else if (write.kind === 'runtime') runtimes.set(write.state.goalId, write.state);
      else if (write.kind === 'entry') entries.set(write.entry.id, write.entry);
      else if (write.kind === 'intent')
        intents.set(scoped(write.intent.scope, write.intent.intentId), write.intent);
      else if (write.kind === 'schedule')
        schedules.set(scoped(write.schedule.scope, write.schedule.scheduleId), write.schedule);
      else occurrences.set(scoped(write.record.scope, write.record.occurrenceId), write.record);
    }
  };

  /**
   * Applies a plan's writes and answers a copy of its result. Reading the
   * snapshot, planning and applying happen in one synchronous step, so no
   * other call interleaves: that is this store's transaction.
   */
  const commit = <R>(plan: GoalRuntimePlan<R>): R => {
    apply(plan.writes);
    return jsonCopy(plan.result);
  };

  const inScope = <T extends { scope: string }>(value: T | undefined, scope: string) =>
    value !== undefined && value.scope === scope ? jsonCopy(value) : undefined;

  const todo = (): never => notImplemented('createInMemoryGoalRuntimeStore');

  return {
    async load(goalId, loadOptions) {
      const record = goals.get(goalId);
      if (!record || (loadOptions?.scope !== undefined && record.scope !== loadOptions.scope))
        return undefined;
      return structuredClone(record);
    },
    async save(record) {
      const next = checkGoal(record);
      apply([planGoalSave(goals.get(next.goalId), next)]);
    },
    async list(query) {
      const plan = planGoalList(query);
      const matches = [...goals.values()]
        .filter(
          (goal) =>
            (plan.statuses === undefined || plan.statuses.includes(goal.status)) &&
            (plan.scope === undefined || goal.scope === plan.scope) &&
            (plan.after === undefined || goalsNewestFirst(goal, plan.after) > 0),
        )
        .sort(goalsNewestFirst);
      const page = matches.slice(0, plan.limit).map((goal) => structuredClone(goal));
      const last = page.at(-1);
      return matches.length > plan.limit && last
        ? { goals: page, cursor: goalListCursor(last) }
        : { goals: page };
    },
    runtime: {
      async get(scope, goalId) {
        return inScope(runtimes.get(goalId), scope);
      },
      async save(state, goal) {
        const next = checkRuntimeState(state);
        const nextGoal = goal === undefined ? undefined : checkGoal(goal);
        return commit(
          planRuntimeSave(
            { goal: goals.get(next.goalId), runtime: runtimes.get(next.goalId) },
            next,
            nextGoal,
          ),
        );
      },
    },
    inbox: {
      async enqueue(delivery) {
        const next = checkEnqueue(delivery);
        const id = goalInboxKey(next.scope, next.namespace, next.deliveryId);
        return commit(
          planEnqueue(
            { entry: entries.get(id), goal: goals.get(next.goalId) },
            next,
            id,
            clock.now(),
          ),
        );
      },
      async apply(application) {
        const next = checkApplication(application);
        return commit(
          planApply(
            {
              entry: entries.get(next.entryId),
              goal: goals.get(next.goalId),
              runtime: runtimes.get(next.goalId),
              intentExists:
                next.intent !== undefined &&
                intents.has(scoped(next.intent.scope, next.intent.intentId)),
            },
            next,
            clock.now(),
          ),
        );
      },
      async get(scope, entryId) {
        return inScope(entries.get(entryId), scope);
      },
      async list(query) {
        const plan = planInboxList(query);
        const rows = [...entries.values()]
          .filter((entry) => matchesInboxList(entry, plan))
          .sort(inboxOldestFirst);
        const page = pageOf(rows, plan.limit, inboxKey);
        return jsonCopy(
          page.cursor ? { entries: page.rows, cursor: page.cursor } : { entries: page.rows },
        );
      },
    },
    schedules: {
      async put(schedule, putOptions) {
        const input = checkScheduleInput(schedule);
        const change = checkScheduleOptions(putOptions, true);
        return commit(
          planSchedulePut(
            {
              schedule: schedules.get(scoped(input.scope, input.scheduleId)),
              goal: goals.get(input.goalId),
            },
            input,
            change,
            clock.now(),
          ),
        );
      },
      async get(scope, scheduleId) {
        return inScope(schedules.get(scoped(scope, scheduleId)), scope);
      },
      async list(query) {
        const plan = planScheduleList(query);
        const rows = [...schedules.values()]
          .filter((schedule) => matchesScheduleList(schedule, plan))
          .sort(schedulesById);
        const page = pageOf(rows, plan.limit, scheduleKey);
        return jsonCopy(
          page.cursor ? { schedules: page.rows, cursor: page.cursor } : { schedules: page.rows },
        );
      },
      async pause(scope, scheduleId, pauseOptions) {
        const change = checkScheduleOptions(pauseOptions, false);
        return commit(
          planSchedulePause(schedules.get(scoped(scope, scheduleId)), change, clock.now()),
        );
      },
      async resume(scope, scheduleId, resumeOptions) {
        const change = checkScheduleOptions(resumeOptions, true);
        return commit(
          planScheduleResume(schedules.get(scoped(scope, scheduleId)), change, clock.now()),
        );
      },
      async cancel(scope, scheduleId, cancelOptions) {
        const change = checkScheduleOptions(cancelOptions, false);
        const schedule = schedules.get(scoped(scope, scheduleId));
        const named = new Set<string>();
        for (const record of occurrences.values())
          if (record.scope === scope && record.scheduleId === scheduleId && record.inboxEntryId)
            named.add(record.inboxEntryId);
        const pending = [...entries.values()].filter((entry) =>
          isPendingDeliveryOf(entry, { scope, scheduleId }, named),
        );
        return commit(planScheduleCancel({ schedule, pending }, change, clock.now()));
      },
      async advance(step) {
        const next = checkAdvance(step);
        const known = new Map<string, GoalInboxEntry>();
        const recorded = new Set<string>();
        for (const { occurrenceId, delivery } of next.occurrences) {
          if (occurrences.has(scoped(next.scope, occurrenceId))) recorded.add(occurrenceId);
          if (delivery === undefined) continue;
          const id = deliveryKey(delivery);
          const entry = entries.get(id);
          if (entry) known.set(id, entry);
        }
        return commit(
          planAdvance(
            {
              schedule: schedules.get(scoped(next.scope, next.scheduleId)),
              entries: known,
              recorded,
            },
            next,
            deliveryKey,
            clock.now(),
          ),
        );
      },
      async occurrences(query) {
        const plan = planOccurrenceList(query);
        const rows = [...occurrences.values()]
          .filter((record) => matchesOccurrenceList(record, plan))
          .sort(occurrencesOldestFirst);
        const page = pageOf(rows, plan.limit, occurrenceKey);
        return jsonCopy(
          page.cursor
            ? { occurrences: page.rows, cursor: page.cursor }
            : { occurrences: page.rows },
        );
      },
    },
    intents: {
      async record(intent) {
        const next = checkIntentInput(intent);
        return commit(
          planIntentRecord(
            {
              intent: intents.get(scoped(next.scope, next.intentId)),
              goal: goals.get(next.goalId),
            },
            next,
            clock.now(),
          ),
        );
      },
      async get(scope, intentId) {
        return inScope(intents.get(scoped(scope, intentId)), scope);
      },
      claim: todo,
      launched: todo,
      complete: todo,
      list: todo,
    },
    watermarks: { get: todo, advance: todo },
    prunePayloads: todo,
    pruneInbox: todo,
    pruneOccurrences: todo,
    pruneIntents: todo,
  };
}
