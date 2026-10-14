/**
 * Inbox event semantics (2.4, spec §3.2): what tells a duplicate delivery
 * from a conflicting one, what becomes of an inbox entry when it is settled
 * against its goal, and how a dependency wait catches up with dependencies
 * that already finished. Pure functions over the 2.3 goal records: the
 * durable scheduler and the webhook handler digest their deliveries here,
 * and the supervisor settles entries with them. Edge-safe.
 */
import { digestJson, sha256Digest } from '../../internal/digest';
import type { Sha256Digest } from '../../internal/digest';
import { createGoalEvent } from '../events';
import { transitionGoal } from '../transition';
import { TERMINAL_STATUSES } from '../validate';
import type { GoalDependency, GoalEvent, GoalRecord, GoalTransition, GoalWaiting } from '../types';
import type {
  GoalInboxApplication,
  GoalInboxDisposition,
  GoalInboxEntry,
  GoalRuntimeStore,
} from './store-types';

/** What a delivery's inbox digest covers. */
export interface GoalDeliveryContent {
  scope: string;
  goalId: string;
  event: GoalEvent;
  payload?: { body: string; mediaType?: string };
}

/**
 * The inbox digest of a delivery (2.4): the canonical-JSON `sha256:<hex>` of
 * its target (scope and goal), its event without the event times (`at`,
 * `notBefore`, `expiresAt`: a sender's retry arrives later) and its payload's
 * digest and media type. The same entry id with another digest is a conflict.
 */
export async function goalDeliveryDigest(content: GoalDeliveryContent): Promise<Sha256Digest> {
  const { at: _at, notBefore: _notBefore, expiresAt: _expiresAt, ...event } = content.event;
  const payload = content.payload && {
    digest: await sha256Digest(content.payload.body),
    ...(content.payload.mediaType !== undefined ? { mediaType: content.payload.mediaType } : {}),
  };
  return digestJson({
    scope: content.scope,
    goalId: content.goalId,
    event,
    ...(payload ? { payload } : {}),
  });
}

/** The final dispositions a settlement can give (a cancel is the schedule's, not the goal's). */
export type GoalSettledDisposition = Exclude<GoalInboxDisposition, 'pending' | 'cancelled'>;

/** What settling an inbox entry against its goal decided. */
export type GoalInboxSettlement =
  /**
   * The event is early for its `notBefore`: the entry stays pending, as it is
   * (an early event is never re-dated), and is due again at `retryAt`.
   */
  | { disposition: 'pending'; retryAt: number; transition: GoalTransition }
  | {
      disposition: GoalSettledDisposition;
      transition: GoalTransition;
      /** The goal to save with it, when the transition changed the goal. */
      goal?: GoalRecord;
      /** The `store.inbox.apply` input; add the runtime state and run intent it implies. */
      application: GoalInboxApplication;
    };

const SETTLED_BY_REASON: Partial<Record<string, GoalSettledDisposition>> = {
  duplicate: 'duplicate',
  unmatched: 'unmatched',
  stale: 'stale',
  expired: 'expired',
  terminal: 'terminal',
};

/**
 * Settles an inbox entry against its goal (2.4) with `transitionGoal`: an
 * applied event gives `'applied'`; a goal that drops it gives the reason as
 * an explicit disposition (`'duplicate'`, `'unmatched'`, `'stale'`,
 * `'expired'`, `'terminal'`); an event before its `notBefore` stays
 * `'pending'`. The event is applied exactly as it was queued, so an event
 * older than a wait that began after it is stale, never re-dated to fit it.
 * Throws `GoalError('scope_mismatch')` for an entry of another goal.
 */
export function settleGoalEvent(
  goal: GoalRecord,
  entry: Pick<GoalInboxEntry, 'id' | 'scope' | 'goalId' | 'event'>,
  options: { now: number },
): GoalInboxSettlement {
  const transition = transitionGoal(goal, { type: 'event', event: entry.event }, options);
  if (transition.outcome === 'ignored' && transition.reason === 'early' && !transition.changed)
    return {
      disposition: 'pending',
      retryAt: entry.event.notBefore ?? options.now,
      transition,
    };
  const disposition: GoalSettledDisposition =
    transition.outcome === 'applied'
      ? 'applied'
      : (SETTLED_BY_REASON[transition.reason ?? ''] ?? 'unmatched');
  const changed = transition.changed ? { goal: transition.record } : {};
  return {
    disposition,
    transition,
    ...changed,
    application: {
      scope: entry.scope,
      goalId: entry.goalId,
      entryId: entry.id,
      disposition,
      ...changed,
    },
  };
}

/** The wait that events answer now: a budget wait answers the one it interrupted. */
function answerable(goal: GoalRecord): Exclude<GoalWaiting, { reason: 'budget' }> | undefined {
  const wait = goal.waiting;
  return wait?.reason === 'budget' ? wait.interrupted : wait;
}

/** Options of `goalDependencyEvents`. */
export interface GoalDependencyEventsOptions {
  /** The time of the reconcile, epoch ms: the events are dated then. */
  now: number;
  /** Where goal dependencies are read, in the waiting goal's scope (a `GoalRuntimeStore`). */
  goals?: Pick<GoalRuntimeStore, 'load'>;
  /** Whether a native run finished; run dependencies are left alone without it. */
  runFinished?: (runId: string) => boolean | Promise<boolean>;
}

/**
 * Reconciles a dependency wait with the current completion state (2.4): one
 * event per unsettled dependency that has already finished (a goal in the
 * same scope that is terminal; a run `runFinished` reports), answering the
 * wait. A completion is a state, so the goal takes such an event even when
 * the dependency ended before the wait began. Each event is keyed by the
 * dependency and the wait, so a repeated reconcile is a duplicate. Queue
 * them in the inbox, or settle them one at a time.
 */
export async function goalDependencyEvents(
  goal: GoalRecord,
  options: GoalDependencyEventsOptions,
): Promise<GoalEvent[]> {
  const wait = answerable(goal);
  if (goal.status !== 'waiting' || wait?.reason !== 'dependency') return [];
  const finished = async (dependency: GoalDependency): Promise<boolean> => {
    if (dependency.kind === 'run') return (await options.runFinished?.(dependency.id)) === true;
    const other = await options.goals?.load(dependency.id, { scope: goal.scope });
    return other !== undefined && TERMINAL_STATUSES.includes(other.status);
  };
  const events: GoalEvent[] = [];
  for (const dependency of wait.on) {
    if (dependency.settled || !(await finished(dependency))) continue;
    events.push(
      createGoalEvent({
        scope: goal.scope,
        goalId: goal.goalId,
        source: { type: dependency.kind, id: dependency.id },
        key: `dependency:${JSON.stringify([dependency.kind, dependency.id, wait.id])}`,
        at: options.now,
        correlationId: wait.id,
      }),
    );
  }
  return events;
}
