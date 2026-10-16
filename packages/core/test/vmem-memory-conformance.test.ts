/**
 * L1b's VersionedMemoryStore contract on L1a's in-memory reference store,
 * wired at the W1a integration (the two lanes were written in parallel).
 */
import { createInMemoryVersionedMemoryStore } from '../src/memory/versioned';
import { assertVersionedMemoryStoreContract } from './fixtures/versioned-memory-store-conformance';

assertVersionedMemoryStoreContract('in-memory (reference)', async ({ clock, logger }) => {
  const store = createInMemoryVersionedMemoryStore({ deps: { clock, logger } });
  return {
    store,
    cleanup: async () => {
      await store.close?.();
    },
  };
});
