/**
 * @internal What the goal supervisor's parts share (2.4): the policy and its
 * checks, the ids it gives intents and runs, and the working memory
 * inheritance rule. Edge-safe.
 */
import type { WorkingMemorySnapshot } from '../../context/working-memory/types';
import { DEUZ_ATTR, DEUZ_SPAN, recordSpan } from '../../internal/telemetry';
import type { TelemetryAttributes } from '../../internal/telemetry';
import type { Logger, ResolvedDependencies } from '../../types/deps';
import type { GoalRecord } from '../types';
import { DEFAULT_GOAL_RUNTIME_POLICY } from './store';
import type { GoalRuntimePolicy } from './store-types';
import type { GoalSupervisorEvent } from './supervisor';

/** The goal lease key (2.4): `goal:` and the JSON of `[scope, goalId]`. */
export function goalLeaseKey(scope: string, goalId: string): string {
  return `goal:${JSON.stringify([scope, goalId])}`;
}

/**
 * The working memory a goal's new run inherits (spec §2.5): the last
 * snapshot, only when its scope and its `specGeneration` match the goal's,
 * as it is (hypotheses keep their status). A snapshot of another goal is
 * never handed over.
 */
export function inheritedWorkingMemory(
  snapshot: WorkingMemorySnapshot | undefined,
  goal: GoalRecord,
): WorkingMemorySnapshot | undefined {
  if (snapshot === undefined || snapshot.scope !== goal.scope) return undefined;
  const ref = snapshot.goalRef;
  if (ref !== undefined && ref.goalId !== goal.goalId) return undefined;
  if (ref?.specGeneration !== goal.specGeneration) return undefined;
  return snapshot;
}

/**
 * A run's snapshot as the supervisor keeps it: named after the goal and the
 * generation the run was launched under, when the run did not name them.
 */
export function stampWorkingMemory(
  snapshot: WorkingMemorySnapshot,
  launchedFor: GoalRecord,
): WorkingMemorySnapshot {
  if (snapshot.goalRef !== undefined) return snapshot;
  return {
    ...snapshot,
    goalRef: {
      goalId: launchedFor.goalId,
      ...(launchedFor.specGeneration !== undefined
        ? { specGeneration: launchedFor.specGeneration }
        : {}),
    },
  };
}

/** Reports a new spec generation: the transition is pure, so whoever applies it reports it. */
export function reportGeneration(
  deps: ResolvedDependencies,
  hub: EventHub<GoalSupervisorEvent>,
  before: GoalRecord,
  after: GoalRecord,
): void {
  if (after.specGeneration === undefined || after.specGeneration === before.specGeneration) return;
  recordSpan(deps, DEUZ_SPAN.goalGeneration, goalAttributes(after));
  hub.emit({
    type: 'generation-changed',
    scope: after.scope,
    goalId: after.goalId,
    specGeneration: after.specGeneration,
  });
}

const POLICY_KEYS: readonly (keyof GoalRuntimePolicy)[] = [
  'maxRuns',
  'maxRetries',
  'retryDelaysMs',
  'retainPayloadMs',
];

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Checks a whole policy. Throws a TypeError. */
export function checkPolicy(policy: GoalRuntimePolicy): GoalRuntimePolicy {
  if (!isCount(policy.maxRuns)) throw new TypeError('policy.maxRuns must be a count');
  if (!isCount(policy.maxRetries)) throw new TypeError('policy.maxRetries must be a count');
  if (!Array.isArray(policy.retryDelaysMs) || !policy.retryDelaysMs.every(isAmount))
    throw new TypeError('policy.retryDelaysMs must be a list of nonnegative milliseconds');
  if (!isAmount(policy.retainPayloadMs))
    throw new TypeError('policy.retainPayloadMs must be nonnegative milliseconds');
  return policy;
}

/**
 * A policy from layers over the defaults, later layers winning per key (an
 * undefined key leaves the layer below). Throws a TypeError for a malformed
 * layer or result.
 */
export function mergePolicy(
  base: GoalRuntimePolicy | undefined,
  ...layers: (Partial<GoalRuntimePolicy> | undefined)[]
): GoalRuntimePolicy {
  const start = base ?? DEFAULT_GOAL_RUNTIME_POLICY;
  const policy: GoalRuntimePolicy = {
    maxRuns: start.maxRuns,
    maxRetries: start.maxRetries,
    retryDelaysMs: [...start.retryDelaysMs],
    retainPayloadMs: start.retainPayloadMs,
  };
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer))
      throw new TypeError('A goal runtime policy must be an object');
    for (const key of POLICY_KEYS) {
      const value = layer[key];
      if (value === undefined) continue;
      if (key === 'retryDelaysMs') {
        if (!Array.isArray(value))
          throw new TypeError('policy.retryDelaysMs must be a list of nonnegative milliseconds');
        policy.retryDelaysMs = [...(value as number[])];
      } else policy[key] = value as number;
    }
  }
  return checkPolicy(policy);
}

/** Span attributes of a goal: ids and numbers only, never content. */
export function goalAttributes(
  goal: Pick<GoalRecord, 'goalId'> & Partial<Pick<GoalRecord, 'revision' | 'specGeneration'>>,
  run?: { runId: string; attempt?: number },
): TelemetryAttributes {
  return {
    [DEUZ_ATTR.goalId]: goal.goalId,
    ...(goal.revision !== undefined ? { [DEUZ_ATTR.goalRevision]: goal.revision } : {}),
    ...(goal.specGeneration !== undefined
      ? { [DEUZ_ATTR.goalSpecGeneration]: goal.specGeneration }
      : {}),
    ...(run !== undefined ? { [DEUZ_ATTR.goalRunId]: run.runId } : {}),
    ...(run?.attempt !== undefined ? { [DEUZ_ATTR.goalAttempt]: run.attempt } : {}),
  };
}

/** A fan-out of events: each iteration sees what is emitted after it starts, until its signal aborts. */
export interface EventHub<E> {
  emit(event: E): void;
  subscribe(signal?: AbortSignal): AsyncIterable<E>;
}

export function createEventHub<E>(): EventHub<E> {
  const subscribers = new Set<(event: E) => void>();
  return {
    emit(event) {
      for (const push of subscribers) push(event);
    },
    subscribe(signal) {
      return {
        [Symbol.asyncIterator](): AsyncIterator<E> {
          const queue: E[] = [];
          let ended = signal?.aborted === true;
          let wake: (() => void) | undefined;
          const push = (event: E): void => {
            queue.push(event);
            wake?.();
          };
          const end = (): void => {
            ended = true;
            subscribers.delete(push);
            signal?.removeEventListener('abort', end);
            wake?.();
          };
          if (!ended) {
            subscribers.add(push);
            signal?.addEventListener('abort', end, { once: true });
          }
          return {
            async next() {
              while (queue.length === 0 && !ended)
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              wake = undefined;
              if (queue.length > 0) return { value: queue.shift()!, done: false };
              return { value: undefined, done: true };
            },
            async return() {
              end();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
}

/** Runs `work` and logs, never throws: for best-effort notices (a cancel signal, a drain). */
export async function quietly<T>(
  logger: Logger,
  message: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    logger.warn(message, { error });
    return undefined;
  }
}

/** An intent's id: the goal and the runtime revision it is recorded with, so ids never repeat. */
export const intentIdFor = (goalId: string, runtimeRevision: number): string =>
  `${goalId}#${runtimeRevision}`;

/** The V3 run id of a goal's `run`-th automatic run (goal ids are globally unique). */
export const runIdFor = (goalId: string, run: number): string => `${goalId}:run:${run}`;
