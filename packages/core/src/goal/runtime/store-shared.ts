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

/** What a planner needs to know of a stored goal. */
export interface StoredGoal {
  scope: string;
  revision: number;
}

/** One row a planner asks its store to write. `created` rows are inserted, the others updated. */
export type GoalRuntimeWrite = { kind: 'goal'; record: GoalRecord; created: boolean };

/** A checked goal record, copied, with its defaults filled in. Throws `invalid_goal`. */
export function checkGoal(record: unknown): GoalRecord {
  return structuredClone(readGoal(record));
}

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
