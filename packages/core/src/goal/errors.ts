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
  | 'scope_mismatch'
  /**
   * The supervisor lost the goal's lease (2.4): it stops writing, drains the
   * native run it started, and starts no new one.
   */
  | 'lease_lost'
  /**
   * A write from a view the store has moved past (2.4): a supervisor whose
   * lease token or goal revision is older than the stored one, or a command
   * for an older `specGeneration`. Nothing was written; read the goal again.
   */
  | 'stale'
  /**
   * A goal policy limit was reached (2.4): its automatic runs or retries. Only
   * a revision-checked `updatePolicy` by the host raises it.
   */
  | 'policy_limit'
  /**
   * A webhook delivery ID seen before with another payload or target goal
   * (2.4). The webhook handler answers 409 and records nothing.
   */
  | 'delivery_conflict';

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
