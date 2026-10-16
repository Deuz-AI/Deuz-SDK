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
   * Reserved (2.4): nothing throws it yet. A supervisor that loses a goal's
   * lease never throws: it reports a `lease-lost` event, stops writing,
   * drains the native run it started and starts no new one.
   */
  | 'lease_lost'
  /**
   * Reserved (2.4): nothing throws it yet. A write from a view the store has
   * moved past is refused as `revision_conflict` (an `expectedRevision`
   * another writer overtook) or a store's `{ status: 'conflict' }`, and an
   * event for an older wait or `specGeneration` is recorded with the inbox
   * disposition `'stale'`. Nothing was written; read the goal again.
   */
  | 'stale'
  /**
   * Reserved (2.4): nothing throws it yet. A goal whose automatic runs or
   * retries are spent stays as it is, and the supervisor reports a
   * `policy-limit` event; only a revision-checked `updatePolicy` by the host
   * raises the limits.
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
