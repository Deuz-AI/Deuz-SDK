/**
 * The in-memory V3 run store (2.4), beside `createInMemoryAgentRunStore`:
 * published from `@deuz-sdk/core/agent` by the integrator. The contract is in
 * `types/agent-run-v3.ts`. Edge-safe.
 */
import type { AgentRunStoreV3 } from './types/agent-run-v3';
import type { Dependencies } from './types/deps';
import { notImplemented } from './internal/not-implemented';

/**
 * The in-memory `AgentRunStoreV3` (2.4): a valid V3 store for tests and one
 * process. Copies in and out, saves at the stored revision plus one, blobs
 * deduplicated by digest and redacted on `redactForgotten`.
 */
export function createInMemoryAgentRunStoreV3(_options?: { deps?: Dependencies }): AgentRunStoreV3 {
  return notImplemented('createInMemoryAgentRunStoreV3');
}
