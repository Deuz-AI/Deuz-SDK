/**
 * The reference goal store (2.3): the persistence boundary in its smallest
 * form, for tests and single-process applications. A durable store keeps the
 * same contract on its own storage; the conformance fixture checks it.
 */
import { GoalError } from './errors';
import { GOAL_STATUSES, readGoal } from './validate';
import type { GoalListQuery, GoalRecord, GoalStatus, GoalStore } from './types';

const MAX_LIMIT = 1000;

/** Newest change first, then goal ID descending. */
function newestFirst(
  left: Pick<GoalRecord, 'updatedAt' | 'goalId'>,
  right: Pick<GoalRecord, 'updatedAt' | 'goalId'>,
): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return left.goalId < right.goalId ? 1 : left.goalId > right.goalId ? -1 : 0;
}

function decodeCursor(cursor: unknown): { updatedAt: number; goalId: string } {
  let position: unknown;
  try {
    position = typeof cursor === 'string' ? JSON.parse(cursor) : undefined;
  } catch {
    position = undefined;
  }
  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    !Number.isFinite(position[0]) ||
    typeof position[1] !== 'string'
  )
    throw new TypeError('Malformed goal listing cursor');
  return { updatedAt: position[0] as number, goalId: position[1] as string };
}

/** A validated listing query: what every goal store filters and pages on. */
export interface GoalListPlan {
  statuses: readonly GoalStatus[] | undefined;
  scope: string | undefined;
  limit: number;
  /** The last goal of the previous page. */
  after: { updatedAt: number; goalId: string } | undefined;
}

/**
 * Validates a listing query; a malformed one throws a TypeError. Shared with
 * the 2.4 goal runtime stores, so every store refuses the same queries.
 */
export function planGoalList(query: GoalListQuery | undefined): GoalListPlan {
  if (query !== undefined && (typeof query !== 'object' || query === null))
    throw new TypeError('A goal listing query must be an object');
  const { statuses, scope, limit = 100, cursor } = query ?? {};
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new TypeError(`Goal listing limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (
    statuses !== undefined &&
    (!Array.isArray(statuses) ||
      statuses.some((status) => !GOAL_STATUSES.includes(status as GoalStatus)))
  )
    throw new TypeError(`Goal listing statuses must be among ${GOAL_STATUSES.join(', ')}`);
  if (scope !== undefined && typeof scope !== 'string')
    throw new TypeError('Goal listing scope must be a string');
  return {
    statuses: statuses as readonly GoalStatus[] | undefined,
    scope,
    limit,
    after: cursor !== undefined ? decodeCursor(cursor) : undefined,
  };
}

/** The cursor after `goal`, the last of a page. */
export function goalListCursor(goal: Pick<GoalRecord, 'updatedAt' | 'goalId'>): string {
  return JSON.stringify([goal.updatedAt, goal.goalId]);
}

/**
 * An in-memory `GoalStore` (2.3): copies in and out, a save only at the
 * stored revision plus one (1 for a new goal), and `list`. Records are checked
 * on save (`invalid_goal`); a conflict rejects with `revision_conflict`.
 * Since 2.4 `load` also takes a `scope`: a goal of another scope then reads as
 * undefined.
 */
export function createInMemoryGoalStore(): GoalStore &
  Required<Pick<GoalStore, 'list'>> & {
    load(goalId: string, options?: { scope?: string }): GoalRecord | undefined;
  } {
  const goals = new Map<string, GoalRecord>();
  return {
    load(goalId: string, options?: { scope?: string }) {
      const record = goals.get(goalId);
      if (!record || (options?.scope !== undefined && record.scope !== options.scope))
        return undefined;
      return structuredClone(record);
    },
    save(record) {
      const next = readGoal(record);
      const stored = goals.get(next.goalId)?.revision ?? 0;
      if (next.revision !== stored + 1)
        throw new GoalError(
          'revision_conflict',
          `Goal revision conflict for ${next.goalId}: expected ${stored + 1}, got ${next.revision}`,
        );
      goals.set(next.goalId, structuredClone(next));
    },
    async list(query) {
      const plan = planGoalList(query);
      const matches = [...goals.values()]
        .filter(
          (goal) =>
            (plan.statuses === undefined || plan.statuses.includes(goal.status)) &&
            (plan.scope === undefined || goal.scope === plan.scope) &&
            (plan.after === undefined || newestFirst(goal, plan.after) > 0),
        )
        .sort(newestFirst);
      const page = matches.slice(0, plan.limit).map((goal) => structuredClone(goal));
      const last = page.at(-1);
      return matches.length > plan.limit && last
        ? { goals: page, cursor: goalListCursor(last) }
        : { goals: page };
    },
  };
}
