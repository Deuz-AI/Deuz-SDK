/**
 * @internal The V3 native run's runtime (2.4, spec §2.3, §2.5, §4.1), loaded
 * on demand by the native executor when a run passes `checkpointVersion: 3`,
 * so a 2.3 run never pulls it in. The executor stays one: this module only
 * checks a V3 run's configuration and builds what the executor hands its
 * loop. Edge-safe.
 */
import { assertAgentRunStoreV3 } from './agent-run-v3';
import type { AgentRunSessionV3 } from './types/agent-run-v3';

/**
 * The configuration-time checks of a V3 run (spec §4.1), before anything is
 * read or written: a session is required, and its store must be an
 * `AgentRunStoreV3` (a Redis run store is refused with
 * `UnsupportedStoreError`, any other non-V3 store with a TypeError).
 */
export function assertV3Session(session: AgentRunSessionV3 | undefined): void {
  if (!session || typeof session !== 'object')
    throw new TypeError(
      'checkpointVersion 3 requires a session ({ store, runId, scope }) with an AgentRunStoreV3.',
    );
  assertAgentRunStoreV3(session.store);
}
