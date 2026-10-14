/**
 * The PostgreSQL V3 run store (2.4), published from
 * `@deuz-sdk/core/ops/postgres`: separate tables with their own
 * `deuz_runs_v3_schema` version table; existing migrate versions unchanged.
 * Node-only.
 */
import type { AgentRunStoreV3 } from '../types/agent-run-v3';
import { notImplemented } from '../internal/not-implemented';
import type { PostgresConnectionOptions } from './store-connection';

/** Options of `createPostgresAgentRunStoreV3`. */
export type PostgresAgentRunStoreV3Options = PostgresConnectionOptions;

/** The PostgreSQL V3 run store (2.4). */
export function createPostgresAgentRunStoreV3(
  _options: PostgresAgentRunStoreV3Options,
): AgentRunStoreV3 & { migrate(): Promise<void>; close(): Promise<void> } {
  return notImplemented('createPostgresAgentRunStoreV3');
}
