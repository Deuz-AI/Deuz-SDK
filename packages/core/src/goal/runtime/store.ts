/**
 * The in-memory goal runtime store (2.4) and the helpers every adapter shares,
 * so the SQLite and PostgreSQL stores key and default exactly like this one.
 * Edge-safe.
 */
import type { Dependencies } from '../../types/deps';
import { notImplemented } from '../../internal/not-implemented';
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

/**
 * The in-memory `GoalRuntimeStore` (2.4): the reference for tests and one
 * process. Copies in and out; every multi-part write is applied whole or not
 * at all; passes the goal-store conformance fixture and the schedule-store
 * conformance fixture.
 */
export function createInMemoryGoalRuntimeStore(_options?: {
  deps?: Dependencies;
}): GoalRuntimeStore {
  return notImplemented('createInMemoryGoalRuntimeStore');
}
