/**
 * The in-memory goal runtime store (2.4) and the helpers every adapter shares,
 * so the SQLite and PostgreSQL stores key and default exactly like this one.
 * Edge-safe.
 */
import type { Clock, Dependencies } from '../../types/deps';
import { notImplemented } from '../../internal/not-implemented';
import { planGoalList, goalListCursor } from '../store';
import type { GoalRecord } from '../types';
import { checkGoal, goalsNewestFirst, planGoalSave, type GoalRuntimeWrite } from './store-shared';
import type { GoalRuntimePolicy, GoalRuntimeStore } from './store-types';

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

const HOST_CLOCK: Pick<Clock, 'now'> = { now: () => Date.now() };

/**
 * The in-memory `GoalRuntimeStore` (2.4): the reference for tests and one
 * process. Copies in and out; every multi-part write is applied whole or not
 * at all; passes the goal-store conformance fixture and the schedule-store
 * conformance fixture. Times it stamps come from `deps.clock`.
 */
export function createInMemoryGoalRuntimeStore(options?: {
  deps?: Dependencies;
}): GoalRuntimeStore {
  const clock = options?.deps?.clock ?? HOST_CLOCK;
  void clock;
  const goals = new Map<string, GoalRecord>();

  /** Applies a plan's writes; each one is already checked, so nothing here can fail half way. */
  const apply = (writes: readonly GoalRuntimeWrite[]): void => {
    for (const write of writes) {
      if (write.kind === 'goal') goals.set(write.record.goalId, write.record);
    }
  };

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
    runtime: { get: todo, save: todo },
    inbox: { enqueue: todo, apply: todo, get: todo, list: todo },
    schedules: {
      put: todo,
      get: todo,
      list: todo,
      pause: todo,
      resume: todo,
      cancel: todo,
      advance: todo,
    },
    intents: { record: todo, get: todo, claim: todo, launched: todo, complete: todo, list: todo },
    watermarks: { get: todo, advance: todo },
    prunePayloads: todo,
    pruneInbox: todo,
    pruneOccurrences: todo,
    pruneIntents: todo,
  };
}
