import { describe, expect, it } from 'vitest';
import { createBudgetLedger, intersectBudgetLimits } from '../src/budget-ledger';
import { createInMemoryBudgetStore } from '../src/budget-store';
import type { BudgetLedgerSnapshot, BudgetScope } from '../src/types/execution';
import type { Usage } from '../src/types/usage';

function usage(totalTokens: number): Usage {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens,
  };
}

/** A price table that knows only `priced`, at $0.01 per token. */
const prices = {
  priceUsage: (model: string, value: Usage) =>
    model === 'priced' ? value.totalTokens / 100 : undefined,
};

const roundTrip = (snapshot: BudgetLedgerSnapshot) =>
  JSON.parse(JSON.stringify(snapshot)) as BudgetLedgerSnapshot;

describe('unpriced models under a USD budget (decision 4)', () => {
  it('admits an unpriced call without a USD hold and still bounds its tokens', async () => {
    const ledger = createBudgetLedger({ budget: { usd: 1, tokens: 100 } });
    // 2.2 refused this with missing_reservation before any model call.
    const record = await ledger.reserve({
      requestId: 'a',
      modelId: 'glm-5.3',
      tokens: 60,
      unpriced: true,
    });
    expect(record).toMatchObject({
      state: 'reserved',
      unpriced: true,
      reservation: { tokens: 60 },
    });
    expect(record.reservation.usd).toBeUndefined();
    expect(ledger.totals()).toMatchObject({
      reserved: { tokens: 60, usd: 0 },
      unknownTokens: 1,
      unknownUsd: 1,
      unpriced: 1,
    });
    await expect(
      ledger.reserve({ requestId: 'b', modelId: 'glm-5.3', tokens: 50, unpriced: true }),
    ).rejects.toMatchObject({
      code: 'budget_exceeded',
      message: expect.stringContaining('tokens'),
    });
    await ledger.settleUsage('a', usage(40), prices);
    expect(ledger.get('a')).toMatchObject({ actual: { tokens: 40 }, unpriced: true });
    expect(ledger.totals()).toMatchObject({
      spent: { tokens: 40, usd: 0 },
      reserved: { tokens: 0, usd: 0 },
      unknownUsd: 1,
      unpriced: 1,
    });
  });

  it("refuses an unpriced call before it is sent under unknownPrice 'reject'", async () => {
    const ledger = createBudgetLedger({ budget: { usd: 1, unknownPrice: 'reject' } });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'glm-5.3', tokens: 10, unpriced: true }),
    ).rejects.toMatchObject({
      name: 'BudgetLedgerError',
      code: 'unpriced_model',
      message: expect.stringContaining('glm-5.3'),
    });
    expect(ledger.get('a')).toBeUndefined();
    // Without a USD bound there is nothing to protect: the policy does not apply.
    const tokensOnly = createBudgetLedger({ budget: { tokens: 100, unknownPrice: 'reject' } });
    await expect(
      tokensOnly.reserve({ requestId: 'a', modelId: 'glm-5.3', tokens: 10, unpriced: true }),
    ).resolves.toMatchObject({ unpriced: true });
  });

  it('keeps enforcing the USD bound on priced calls next to unpriced ones', async () => {
    const ledger = createBudgetLedger({ budget: { usd: 1 } });
    await ledger.reserve({ requestId: 'free', modelId: 'glm-5.3', tokens: 10, unpriced: true });
    await ledger.settleUsage('free', usage(10), prices);
    // The unpriced entry is not an unknown base that fails every later admission closed.
    await ledger.reserve({ requestId: 'paid', modelId: 'priced', tokens: 10, usd: 0.8 });
    await expect(
      ledger.reserve({ requestId: 'more', modelId: 'priced', tokens: 10, usd: 0.3 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    // A call with no estimate that does not say it is unpriced still fails closed.
    await expect(ledger.reserve({ requestId: 'blind', modelId: 'priced' })).rejects.toMatchObject({
      code: 'missing_reservation',
    });
    // Once priced commitments pass the bound, an unpriced call is refused too.
    await ledger.settle({ requestId: 'paid', tokens: 10, usd: 1.5 });
    await expect(
      ledger.reserve({ requestId: 'late', modelId: 'glm-5.3', tokens: 1, unpriced: true }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it("lets 'reject' win when budgets intersect, so a child can only tighten", async () => {
    expect(intersectBudgetLimits({ usd: 2 }, { unknownPrice: 'reject' })).toEqual({
      usd: 2,
      unknownPrice: 'reject',
    });
    expect(intersectBudgetLimits({ unknownPrice: 'reject' }, { unknownPrice: 'warn' })).toEqual({
      unknownPrice: 'reject',
    });
    expect(intersectBudgetLimits({ unknownPrice: 'warn' }, {})).toEqual({ unknownPrice: 'warn' });
    expect(intersectBudgetLimits({ usd: 1 }, { tokens: 5 })).toEqual({ tokens: 5, usd: 1 });
    expect(() => intersectBudgetLimits({ unknownPrice: 'maybe' as never })).toThrow(/unknownPrice/);

    const root: BudgetScope = { id: 'root', budget: { usd: 5 } };
    const strict: BudgetScope = {
      id: 'root/strict',
      budget: intersectBudgetLimits(root.budget, { unknownPrice: 'reject' }),
    };
    const ledger = createBudgetLedger({ budget: { usd: 5 } });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 1, unpriced: true, scopes: [root] }),
    ).resolves.toMatchObject({ unpriced: true });
    await expect(
      ledger.reserve({
        requestId: 'b',
        modelId: 'm',
        tokens: 1,
        unpriced: true,
        scopes: [root, strict],
      }),
    ).rejects.toMatchObject({
      code: 'unpriced_model',
      message: expect.stringContaining('root/strict'),
    });
    // A restore can tighten the policy, never loosen it.
    const restored = createBudgetLedger({
      snapshot: roundTrip(ledger.snapshot()),
      budget: { unknownPrice: 'reject' },
    });
    expect(restored.budget).toEqual({ usd: 5, unknownPrice: 'reject' });
    const loosened = createBudgetLedger({
      snapshot: roundTrip(restored.snapshot()),
      budget: { unknownPrice: 'warn' },
    });
    expect(loosened.budget.unknownPrice).toBe('reject');
  });

  it('settles a USD estimate held for an unpriced model as its charge', async () => {
    // t3b case G: a caller estimate kept the record unknown and the hold open forever.
    const ledger = createBudgetLedger({ budget: { usd: 1 } });
    await ledger.reserve({ requestId: 'a', modelId: 'glm-5.3', tokens: 4_102, usd: 0.05 });
    const settled = await ledger.settleUsage('a', usage(60), prices);
    expect(settled).toMatchObject({
      state: 'settled',
      actual: { tokens: 60, usd: 0.05 },
      unpriced: true,
    });
    expect(ledger.totals()).toMatchObject({
      spent: { tokens: 60, usd: 0.05 },
      reserved: { tokens: 0, usd: 0 },
      unknownUsd: 0,
    });
    // An outage is not a missing price: the hold stays, as in 2.2.
    await ledger.reserve({ requestId: 'b', modelId: 'priced', tokens: 10, usd: 0.2 });
    await ledger.settleUsage('b', usage(5), {
      priceUsage: () => {
        throw new Error('price db down');
      },
    });
    expect(ledger.get('b')).toMatchObject({ state: 'unknown', actual: { tokens: 5 } });
    expect(ledger.get('b')!.unpriced).toBeUndefined();
    expect(ledger.totals()).toMatchObject({ reserved: { usd: 0.2 }, unknownUsd: 1 });
  });

  it('prices an unpriced reservation whose actual usage turns out to have a price', async () => {
    const ledger = createBudgetLedger({ budget: { usd: 1 } });
    await ledger.reserve({ requestId: 'a', modelId: 'priced', tokens: 10, unpriced: true });
    const settled = await ledger.settleUsage('a', usage(50), prices);
    expect(settled).toMatchObject({ state: 'settled', actual: { tokens: 50, usd: 0.5 } });
    expect(settled.unpriced).toBeUndefined();
  });

  it('keeps unpriced usage out of USD admission after compaction and restore', async () => {
    const root: BudgetScope = { id: 'root', budget: { usd: 1 } };
    const task: BudgetScope = { id: 'root/task', budget: { usd: 1 } };
    const ledger = createBudgetLedger({ budget: { usd: 1 } });
    await ledger.reserve({
      requestId: 'a',
      modelId: 'glm-5.3',
      tokens: 10,
      unpriced: true,
      scopes: [root, task],
    });
    await ledger.settleUsage('a', usage(7), prices);
    expect(await ledger.compact('root/task')).toMatchObject({ folded: 1 });
    expect(ledger.snapshot().aggregates?.[0]).toMatchObject({
      count: 1,
      spent: { tokens: 7, usd: 0 },
      unknownUsd: 1,
      unestimatedUsd: 1,
      unpricedUsd: 1,
    });
    expect(ledger.totals()).toMatchObject({ spent: { tokens: 7, usd: 0 }, unpriced: 1 });
    // A 2.2 reader drops the 2.3 count and keeps failing a USD cap closed.
    const legacy = roundTrip(ledger.snapshot());
    const dropped = createBudgetLedger({
      snapshot: {
        ...legacy,
        aggregates: legacy.aggregates!.map(({ unpricedUsd: _unknownTo22, ...rest }) => rest),
      },
    });
    await expect(
      dropped.reserve({ requestId: 'b', modelId: 'priced', tokens: 1, usd: 0.5, scopes: [root] }),
    ).rejects.toMatchObject({ code: 'missing_reservation' });
    const restored = createBudgetLedger({ snapshot: roundTrip(ledger.snapshot()) });
    expect(restored.totals()).toMatchObject({ unknownUsd: 1, unpriced: 1 });
    await expect(
      restored.reserve({ requestId: 'b', modelId: 'priced', tokens: 1, usd: 0.5, scopes: [root] }),
    ).resolves.toMatchObject({ state: 'reserved' });
    // Records restore with their flag.
    const flagged = createBudgetLedger({ budget: { usd: 1 } });
    await flagged.reserve({ requestId: 'x', modelId: 'glm-5.3', tokens: 3, unpriced: true });
    const again = createBudgetLedger({ snapshot: roundTrip(flagged.snapshot()) });
    expect(again.get('x')).toMatchObject({ unpriced: true });
  });

  it('validates the unpriced marker and the policy', async () => {
    const ledger = createBudgetLedger({ budget: { usd: 1 } });
    // Malformed input throws before queueing, like every other reserve validation.
    expect(() =>
      ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 1, usd: 0.1, unpriced: true }),
    ).toThrow(expect.objectContaining({ code: 'invalid_budget' }));
    expect(() => createBudgetLedger({ budget: { unknownPrice: 'strict' as never } })).toThrow(
      /unknownPrice/,
    );
    // Existing snapshots and budgets keep their exact shape.
    expect(createBudgetLedger({ budget: { usd: 1 } }).snapshot().budget).toEqual({ usd: 1 });
  });
});

describe('unpriced models under a persistent BudgetStore scope', () => {
  const tenant = (extra: { unknownPrice?: 'warn' | 'reject' } = {}) => ({
    key: 'tenant:1',
    limits: { usd: 1, tokens: 10_000, ...extra },
  });

  it('settles the token hold to actual usage and holds no USD', async () => {
    // t3b case G: two unpriced calls held 8,204 tokens and $0.10 in the store forever.
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [tenant()] } });
    for (const id of ['a', 'b']) {
      await ledger.reserve({ requestId: id, modelId: 'glm-5.3', tokens: 4_102, unpriced: true });
      expect(await store.usage('tenant:1')).toMatchObject({ usd: 0 });
      await ledger.settleUsage(id, usage(60), prices);
    }
    expect(await store.usage('tenant:1', { byModel: true })).toEqual({
      tokens: 120,
      usd: 0,
      byModel: { 'glm-5.3': { tokens: 120, usd: 0 } },
    });
  });

  it('closes a caller USD estimate for an unpriced model as its charge', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [tenant()] } });
    for (const id of ['a', 'b']) {
      await ledger.reserve({ requestId: id, modelId: 'glm-5.3', tokens: 4_102, usd: 0.05 });
      await ledger.settleUsage(id, usage(60), prices);
    }
    // Tokens are actual usage and the USD holds are closed (charged at the estimate).
    expect(await store.usage('tenant:1')).toEqual({ tokens: 120, usd: 0.1 });
    expect(ledger.totals()).toMatchObject({ reserved: { tokens: 0, usd: 0 }, unknownUsd: 0 });
  });

  it("refuses an unpriced call when the scope or the run says 'reject'", async () => {
    for (const options of [
      { scopes: [tenant({ unknownPrice: 'reject' })] },
      { scopes: [tenant()], budget: { unknownPrice: 'reject' as const } },
    ]) {
      const store = createInMemoryBudgetStore();
      const ledger = createBudgetLedger({
        ...(options.budget ? { budget: options.budget } : {}),
        admission: { store, scopes: options.scopes },
      });
      await expect(
        ledger.reserve({ requestId: 'a', modelId: 'glm-5.3', tokens: 10, unpriced: true }),
      ).rejects.toMatchObject({
        code: 'unpriced_model',
        message: expect.stringContaining('tenant:1'),
      });
      expect(await store.usage('tenant:1')).toEqual({ tokens: 0, usd: 0 });
    }
  });
});
