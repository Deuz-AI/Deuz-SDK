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

budgetStoreContracts(
  'memory budget store',
  async () => {
    const { clock, advance, now } = manualClock();
    return { store: createInMemoryBudgetStore({ clock }), advance, now };
  },
  { hours: true },
);

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

  // 2.2 summed a key's whole history on every admission: a lifetime budget a
  // year old walked thousands of buckets per model call (F25).
  it('admits against a long history without walking it', { timeout: 15_000 }, async () => {
    const { clock, advance } = manualClock(0);
    const store = createInMemoryBudgetStore({ clock });
    const scopes = [
      { key: 'org:life', limits: { tokens: 1e12 } },
      { key: 'org:week', limits: { tokens: 1e12 }, window: { ms: 7 * 3_600_000, buckets: 7 } },
    ];
    // An hourly call for two and a half years: 20 000 buckets per key.
    for (let hour = 0; hour < 20_000; hour++) {
      await store.reserve({ requestId: `h${hour}`, modelId: 'm', tokens: 1, scopes });
      await store.settle(`h${hour}`, { tokens: 1, usd: 0 });
      await advance(3_600_000);
    }
    for (let call = 0; call < 20_000; call++)
      await store.reserve({ requestId: `c${call}`, modelId: 'm', tokens: 0, scopes });
    expect(
      await store.reserve({ requestId: 'last', modelId: 'm', tokens: 1, scopes }),
    ).toMatchObject({
      admitted: true,
      // The week counts its last six hourly calls and this one.
      scopes: [
        { key: 'org:life', tokens: 20_001 },
        { key: 'org:week', tokens: 7 },
      ],
    });
  });
});
