import { describe, expect, it } from 'vitest';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';

/** A clock that only moves when the test says so. */
function manualClock(start = 1_000_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: async (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

budgetStoreContracts('memory budget store', async () => {
  const { clock, advance, now } = manualClock();
  return { store: createInMemoryBudgetStore({ clock }), advance, now };
});

describe('memory budget store', () => {
  it('counts a window in whole buckets', async () => {
    const { clock, advance } = manualClock(0);
    const store = createInMemoryBudgetStore({ clock });
    const scope = { key: 'k', limits: { tokens: 10 }, window: { ms: 1_000, buckets: 10 } };
    await store.reserve({ requestId: 'a', modelId: 'm', tokens: 10, scopes: [scope] });
    // 950 ms later the first bucket (0–99 ms) is still one of the ten counted.
    await advance(950);
    expect(
      await store.reserve({ requestId: 'b', modelId: 'm', tokens: 1, scopes: [scope] }),
    ).toMatchObject({ admitted: false });
    await advance(50);
    expect(
      await store.reserve({ requestId: 'c', modelId: 'm', tokens: 1, scopes: [scope] }),
    ).toMatchObject({ admitted: true });
  });
});
