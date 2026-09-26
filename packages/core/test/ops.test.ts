import { createInMemoryLeaseProvider } from '../src/ops';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import { manualClock } from './fixtures/manual-clock';

leaseProviderContracts('memory lease provider', async () => {
  const { clock, advance } = manualClock();
  return { provider: createInMemoryLeaseProvider({ clock }), advance, ttl: 1_000 };
});
