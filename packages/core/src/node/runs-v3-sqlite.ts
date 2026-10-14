/**
 * The SQLite V3 run store (2.4), published from `@deuz-sdk/core/ops/sqlite`:
 * separate tables (runs, context blobs and their record index) with their own
 * `deuz_runs_v3_schema` version table, so `deuz_ops_schema` stays at its 2.3
 * value and 2.3's listing and pruning never see a V3 run. Node-only.
 */
import type { AgentRunStoreV3 } from '../types/agent-run-v3';
import type { Clock } from '../types/deps';
import { notImplemented } from '../internal/not-implemented';
import type { SqliteConnectionOptions } from './store-connection';

/** Options of `createSqliteAgentRunStoreV3`. */
export type SqliteAgentRunStoreV3Options = SqliteConnectionOptions & { clock?: Clock };

/** The SQLite V3 run store (2.4); `close()` closes only a connection it opened. */
export function createSqliteAgentRunStoreV3(
  _options: SqliteAgentRunStoreV3Options,
): AgentRunStoreV3 & { close(): Promise<void> } {
  return notImplemented('createSqliteAgentRunStoreV3');
}
