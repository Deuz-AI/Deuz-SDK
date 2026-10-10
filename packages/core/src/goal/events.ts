/**
 * Wakeup and event envelopes (2.3). An event's `key` lives in one space with
 * the schedule's occurrence keys (`<scheduleId>@<at>`) and the keys
 * `handleSignal` derives (a delivery ID, or `sha256:<hex>` of the body), so
 * one durable claim, such as the ops stores' `claims`, dedupes them all.
 */
import { GoalError } from './errors';
import { GOAL_EVENT_VERSION, checkGoalEvent, readGoal } from './validate';
import type { GoalEvent, GoalPayloadRef, GoalRecord } from './types';
import type { ScheduleOccurrence } from '../schedule/scheduler';
import type { SignalDispatchInput } from '../schedule/signal';

/** An event's fields; `id` defaults to `key`. */
export type GoalEventInput = Omit<GoalEvent, 'kind' | 'version' | 'id'> & { id?: string };

/** Where an event built from a schedule occurrence or a signal goes. */
export interface GoalEventTarget {
  scope: string;
  goalId: string;
  runId?: string;
  /** The wait it answers. */
  correlationId?: string;
  causationId?: string;
  expiresAt?: number;
  payload?: GoalPayloadRef;
}

function targetFields(target: GoalEventTarget): Omit<GoalEventTarget, 'scope' | 'goalId'> {
  return {
    ...(target.runId !== undefined ? { runId: target.runId } : {}),
    ...(target.correlationId !== undefined ? { correlationId: target.correlationId } : {}),
    ...(target.causationId !== undefined ? { causationId: target.causationId } : {}),
    ...(target.expiresAt !== undefined ? { expiresAt: target.expiresAt } : {}),
    ...(target.payload !== undefined ? { payload: { ...target.payload } } : {}),
  };
}

/** A version 1 goal event from its fields, checked. Throws `invalid_event`. */
export function createGoalEvent(input: GoalEventInput): GoalEvent {
  return checkGoalEvent({
    kind: 'deuz-goal-event',
    version: GOAL_EVENT_VERSION,
    id: input?.id ?? input?.key,
    source: input?.source && {
      type: input.source.type,
      ...(input.source.id !== undefined ? { id: input.source.id } : {}),
    },
    scope: input?.scope,
    goalId: input?.goalId,
    key: input?.key,
    at: input?.at,
    ...(input?.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
    ...(input ? targetFields(input as GoalEventTarget) : {}),
  });
}

/**
 * The event of a schedule occurrence: keyed and identified by the
 * occurrence's key, dated at its scheduled minute, and not to be applied
 * before it.
 */
export function goalEventFromOccurrence(
  occurrence: Pick<ScheduleOccurrence, 'id' | 'at' | 'key'>,
  target: GoalEventTarget,
): GoalEvent {
  return createGoalEvent({
    scope: target.scope,
    goalId: target.goalId,
    source: { type: 'schedule', id: occurrence.id },
    key: occurrence.key,
    at: occurrence.at,
    notBefore: occurrence.at,
    ...targetFields(target),
  });
}

/**
 * The event of a verified signal, from `handleSignal`'s dispatch input:
 * keyed and identified by the signal's key. `name` names the sender (a
 * webhook), `at` is when it arrived. Keep the body in your storage and pass
 * its reference as `payload`.
 */
export function goalEventFromSignal(
  signal: Pick<SignalDispatchInput, 'key'>,
  target: GoalEventTarget & { name: string; at: number },
): GoalEvent {
  return createGoalEvent({
    scope: target.scope,
    goalId: target.goalId,
    source: { type: 'signal', id: target.name },
    key: signal.key,
    at: target.at,
    ...targetFields(target),
  });
}

/**
 * The key of a goal's wakeup at `at`: `goal:<goalId>@<at>`, the shape of a
 * schedule occurrence key, so a claim on it dedupes the wakeup across
 * processes as it dedupes an occurrence.
 */
export function goalWakeupKey(goalId: string, at: number): string {
  return `goal:${goalId}@${at}`;
}

/**
 * The event that ends a goal's wakeup wait: dated at the wakeup, answering
 * the wait. Throws `invalid_event` for a goal that waits for no wakeup.
 */
export function goalWakeupEvent(record: GoalRecord): GoalEvent {
  const goal = readGoal(record);
  const wait = goal.waiting;
  if (goal.status !== 'waiting' || wait?.reason !== 'wakeup')
    throw new GoalError('invalid_event', `Goal ${goal.goalId} is not waiting for a wakeup.`);
  return createGoalEvent({
    scope: goal.scope,
    goalId: goal.goalId,
    source: { type: 'wakeup' },
    key: goalWakeupKey(goal.goalId, wait.at),
    at: wait.at,
    notBefore: wait.at,
    ...(goal.runId !== undefined ? { runId: goal.runId } : {}),
    correlationId: wait.id,
  });
}
