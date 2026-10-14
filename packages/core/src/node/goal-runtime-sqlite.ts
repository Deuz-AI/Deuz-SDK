/**
 * `@deuz-sdk/core/goal/runtime/sqlite` (2.4): the goal runtime store on
 * `node:sqlite`, the first durable `GoalStore`. New tables with their own
 * `deuz_goal_runtime_schema` version table; every multi-part write is one
 * `BEGIN IMMEDIATE` transaction. Several processes may share the file.
 * Node-only.
 */
import type { GoalRuntimeStore } from '../goal/runtime/store-types';
import type { Clock } from '../types/deps';
import { notImplemented } from '../internal/not-implemented';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteGoalRuntimeStore`. */
export type SqliteGoalRuntimeStoreOptions = SqliteConnectionOptions & {
  /** The store clock. Every process sharing the file must agree on it. */
  clock?: Clock;
};

/** A SQLite `GoalRuntimeStore`; `close()` closes only a connection it opened. */
export type SqliteGoalRuntimeStore = GoalRuntimeStore & { close(): Promise<void> };

/** The SQLite goal runtime store (2.4). */
export function createSqliteGoalRuntimeStore(
  _options: SqliteGoalRuntimeStoreOptions,
): SqliteGoalRuntimeStore {
  return notImplemented('createSqliteGoalRuntimeStore');
}
