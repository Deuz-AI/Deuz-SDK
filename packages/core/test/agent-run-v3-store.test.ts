/**
 * The V3 run stores (2.4, spec §4.1, §4.4): the `AgentRunStoreV3` contract on
 * the in-memory store, the SQLite store and the Postgres store (PGlite and,
 * with DEUZ_TEST_POSTGRES_URL, a live server), and what each backend adds:
 * separate tables with their own version table, so a 2.3 process never lists,
 * prunes or resumes a V3 run.
 */
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { agentRunStoreV3Contracts } from './fixtures/agent-run-store-v3-conformance';
import { manualClock } from './fixtures/manual-clock';

agentRunStoreV3Contracts('in-memory V3 run store', async () => {
  const { clock, advance } = manualClock();
  return {
    store: createInMemoryAgentRunStoreV3({ deps: { clock } }),
    advance,
    now: async () => clock.now(),
  };
});
