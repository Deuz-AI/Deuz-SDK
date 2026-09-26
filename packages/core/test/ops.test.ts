import { createInMemoryLeaseProvider } from '../src/ops';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';

/** A clock that only moves when the test says so. */
export function manualClock(start = 1_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: async (ms: number) => {
      now += ms;
    },
  };
}

leaseProviderContracts('memory lease provider', async () => {
  const { clock, advance } = manualClock();
  return { provider: createInMemoryLeaseProvider({ clock }), advance, ttl: 1_000 };
});
