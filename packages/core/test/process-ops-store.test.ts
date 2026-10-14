/**
 * ProcessOperationStore (2.4, spec §3.3): the in-memory store and the SQLite
 * store run one contract. SQLite adds its own rules: a version table of its
 * own (`deuz_process_ops_schema`), records that survive a reopen, a borrowed
 * handle left open, and a newer schema refused.
 */
import { describe } from 'vitest';
import { createInMemoryProcessOperationStore } from '../src/compute/docker';
import { processOperationStoreContracts } from './fixtures/process-ops-store-conformance';

function clock(start = 1_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('ProcessOperationStore', () => {
  processOperationStoreContracts('in-memory', async () => {
    const time = clock();
    return {
      store: createInMemoryProcessOperationStore({ deps: { clock: time.clock } }),
      advance: time.advance,
      now: time.now,
    };
  });
});
