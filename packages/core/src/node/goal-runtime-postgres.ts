/**
 * `@deuz-sdk/core/goal/runtime/postgres` (2.4): the goal runtime store on
 * PostgreSQL (`pg` peer). New tables with their own
 * `deuz_goal_runtime_schema` version table; each multi-part write pins one
 * pooled connection in one transaction. Node-only.
 */
import type { GoalRuntimeStore } from '../goal/runtime/store-types';
import { notImplemented } from '../internal/not-implemented';
import type { PostgresConnectionOptions } from './store-connection';

/** Options of `createPostgresGoalRuntimeStore`. */
export type PostgresGoalRuntimeStoreOptions = PostgresConnectionOptions;

/** A PostgreSQL `GoalRuntimeStore` with an explicit `migrate`. */
export type PostgresGoalRuntimeStore = GoalRuntimeStore & {
  migrate(): Promise<void>;
  close(): Promise<void>;
};

/** The PostgreSQL goal runtime store (2.4). */
export function createPostgresGoalRuntimeStore(
  _options: PostgresGoalRuntimeStoreOptions,
): PostgresGoalRuntimeStore {
  return notImplemented('createPostgresGoalRuntimeStore');
}
