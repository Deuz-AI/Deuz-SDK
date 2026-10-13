/** Why a goal function refused its input (2.3). */
export type GoalErrorCode =
  /** A goal record that does not match the GoalRecord contract. */
  | 'invalid_goal'
  /** A goal event that does not match the GoalEvent contract. */
  | 'invalid_event'
  /** A command `transitionGoal` cannot apply as given. */
  | 'invalid_command'
  /** A record or event of a version this build cannot read. */
  | 'unsupported_version'
  /** A save, or a transition with `expectedRevision`, that another writer overtook. */
  | 'revision_conflict'
  /** An event addressed to another goal or scope. */
  | 'scope_mismatch';

/**
 * A goal function's refusal (2.3). Malformed input, a version from a newer
 * build, a revision conflict and a misrouted event throw it; everything a goal
 * itself decides (a duplicate event, a completion without evidence) is a
 * `GoalTransition` instead.
 */
export class GoalError extends Error {
  readonly name = 'GoalError';
  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
  }
}
