/**
 * @internal The configuration-time check of a `checkpointVersion: 3`
 * session's store (2.4, spec §4.1). Only the V3 run (`agent-run-v3-run.ts`,
 * loaded on demand) calls it, so it stays out of the eager bundles that reach
 * the V3 stores. Edge-safe.
 */
import { AGENT_RUN_STORE_BACKEND } from './agent-run-v3';
import { UnsupportedStoreError } from './errors';
import type { AgentRunStoreV3 } from './types/agent-run-v3';

const STORE_V3_METHODS = [
  'load',
  'save',
  'list',
  'putBlob',
  'getBlob',
  'redactForgotten',
  'prune',
] as const;

/**
 * The configuration-time check of a `checkpointVersion: 3` session (spec
 * §4.1), before anything is read or written: a Redis run store is refused
 * with `UnsupportedStoreError` (2.4 has no Redis V3 store), any other store
 * that is not an `AgentRunStoreV3` (a 2.3 `AgentRunStore`) with a TypeError.
 */
export function assertAgentRunStoreV3(store: unknown): asserts store is AgentRunStoreV3 {
  const record =
    store !== null && (typeof store === 'object' || typeof store === 'function')
      ? (store as Record<string | symbol, unknown>)
      : undefined;
  if (record?.[AGENT_RUN_STORE_BACKEND] === 'redis')
    throw new UnsupportedStoreError({
      backend: 'redis',
      feature: 'agent-run-v3',
      message:
        'checkpointVersion 3 cannot run on a Redis AgentRunStore: Redis has no V3 run store in 2.4. ' +
        'Use createInMemoryAgentRunStoreV3, createSqliteAgentRunStoreV3 or createPostgresAgentRunStoreV3.',
    });
  if (
    record?.checkpointVersion !== 3 ||
    STORE_V3_METHODS.some((method) => typeof record[method] !== 'function')
  )
    throw new TypeError(
      'checkpointVersion 3 needs an AgentRunStoreV3 (createInMemoryAgentRunStoreV3, ' +
        'createSqliteAgentRunStoreV3 or createPostgresAgentRunStoreV3): a 2.3 AgentRunStore keeps ' +
        'version 1 and 2 runs only.',
    );
}
