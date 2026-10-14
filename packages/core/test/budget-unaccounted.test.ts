/**
 * budget-unaccounted.test.ts (2.4, spec §3.1) — attempts made through a host
 * callback that reports no usage. The ledger keeps them marked `unaccounted`,
 * holds their estimates (never free), counts them in `totals().unaccounted`
 * through compaction and restore, and refuses them with `unaccounted_call`
 * wherever a budget says `unknownPrice: 'reject'`.
 */
import { describe, expect, it } from 'vitest';
import { BudgetLedgerError, createBudgetLedger, reserveAll } from '../src/budget-ledger';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createExecutionContext } from '../src/execution-policy';
import type { BudgetLedgerSnapshot } from '../src/types/execution';

const roundTrip = (snapshot: BudgetLedgerSnapshot) =>
  JSON.parse(JSON.stringify(snapshot)) as BudgetLedgerSnapshot;

describe('unaccounted attempts', () => {
  it('holds the estimates of an attempt that reports no usage, and never frees them', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 100, usd: 1 } });
    const record = await ledger.reserve({
      requestId: 'llm-1',
      modelId: 'memory-llm',
      kind: 'memory-llm',
      tokens: 60,
      usd: 0.5,
      unaccounted: true,
    });
    expect(record).toMatchObject({ state: 'reserved', unaccounted: true });
    // The callback ran and said nothing about its usage.
    expect(await ledger.markUnknown('llm-1')).toMatchObject({
      state: 'unknown',
      unaccounted: true,
    });
    expect(ledger.totals()).toMatchObject({
      reserved: { tokens: 60, usd: 0.5 },
      committed: { tokens: 60, usd: 0.5 },
      unknownTokens: 1,
      unknownUsd: 1,
      unaccounted: 1,
    });
    // The held estimate keeps counting against the budget.
    await expect(
      ledger.reserve({ requestId: 'llm-2', modelId: 'memory-llm', tokens: 50, usd: 0.1 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('omits the count while there is none, and drops a released or settled attempt from it', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'm', modelId: 'm', tokens: 1, usd: 0 });
    expect(ledger.totals()).not.toHaveProperty('unaccounted');
    await ledger.reserve({ requestId: 'a', modelId: 'cb', tokens: 5, unaccounted: true });
    await ledger.reserve({ requestId: 'b', modelId: 'cb', tokens: 5, unaccounted: true });
    expect(ledger.totals().unaccounted).toBe(2);
    await ledger.release('a');
    await ledger.settle({ requestId: 'b', tokens: 4, usd: 0 });
    expect(ledger.totals()).not.toHaveProperty('unaccounted');
  });

  it('counts per scope', async () => {
    const root = createExecutionContext({ budget: { tokens: 1_000 } });
    const child = root.child({ scopeId: 'memory' });
    await child.reserve({ requestId: 'x', modelId: 'cb', tokens: 10, unaccounted: true });
    await root.reserve({ requestId: 'y', modelId: 'model', tokens: 10 });
    expect(root.ledger.totals(child.scopeId).unaccounted).toBe(1);
    expect(root.ledger.totals().unaccounted).toBe(1);
  });

  it('keeps the marker through a snapshot, a restore and a compaction', async () => {
    const root = createExecutionContext({ budget: { tokens: 1_000 } });
    const task = root.child({ scopeId: 'task' });
    await task.reserve({ requestId: 'x', modelId: 'cb', tokens: 10, unaccounted: true });
    await task.ledger.markUnknown('x');
    const restored = createBudgetLedger({ snapshot: roundTrip(root.ledger.snapshot()) });
    expect(restored.get('x')).toMatchObject({ unaccounted: true, state: 'unknown' });
    expect(restored.totals().unaccounted).toBe(1);
    await restored.compact(task.scopeId);
    expect(restored.get('x')).toBeUndefined();
    expect(restored.totals()).toMatchObject({ unaccounted: 1, reserved: { tokens: 10 } });
    const again = createBudgetLedger({ snapshot: roundTrip(restored.snapshot()) });
    expect(again.totals()).toMatchObject({ unaccounted: 1, reserved: { tokens: 10 } });
  });

  it('refuses a malformed marker in input or a snapshot', async () => {
    const ledger = createBudgetLedger();
    // Input is checked before it is queued, as every reservation field is.
    expect(() =>
      ledger.reserve({ requestId: 'a', modelId: 'cb', unaccounted: 'yes' as never }),
    ).toThrow(expect.objectContaining({ code: 'invalid_budget' }) as unknown as Error);
    expect(() =>
      createBudgetLedger({
        snapshot: {
          version: 1,
          revision: 1,
          budget: {},
          reservations: [
            {
              requestId: 'a',
              modelId: 'cb',
              kind: 'model',
              reservation: {},
              actual: {},
              scopes: [],
              state: 'reserved',
              unaccounted: false as never,
            },
          ],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_snapshot' }) as unknown as Error);
  });

  it('takes a repeat with another marker as a conflict', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'a', modelId: 'cb', tokens: 5, unaccounted: true });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'cb', tokens: 5, unaccounted: true }),
    ).resolves.toMatchObject({ unaccounted: true });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'cb', tokens: 5 }),
    ).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
  });

  it("is admitted under the default 'warn', with its estimates", async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 100, unknownPrice: 'warn' } });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'cb', tokens: 10, unaccounted: true }),
    ).resolves.toMatchObject({ state: 'reserved' });
  });

  it("is refused wherever a budget says unknownPrice: 'reject'", async () => {
    const strict = { unknownPrice: 'reject' as const };
    const cases = [
      () => createExecutionContext({ budget: { tokens: 100, ...strict } }),
      () => createExecutionContext({ budget: strict }),
      () =>
        createExecutionContext({ budget: { tokens: 100 } }).child({ scopeId: 'c', budget: strict }),
    ];
    for (const make of cases) {
      const context = make();
      const refused = await context
        .reserve({ requestId: 'a', modelId: 'cb', tokens: 10, unaccounted: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(BudgetLedgerError);
      expect(refused).toMatchObject({
        code: 'unaccounted_call',
        message: expect.stringContaining('accounted'),
      });
      expect(context.ledger.get('a')).toBeUndefined();
      // An accounted attempt still goes through.
      await expect(
        context.reserve({ requestId: 'b', modelId: 'cb', tokens: 10, usd: 0 }),
      ).resolves.toMatchObject({ state: 'reserved' });
    }
  });

  it("is refused by a batch, all or none, under 'reject'", async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 100, unknownPrice: 'reject' } });
    await expect(
      reserveAll(ledger, [
        { requestId: 'a', modelId: 'm', tokens: 5, usd: 0 },
        { requestId: 'b', modelId: 'cb', tokens: 5, unaccounted: true },
      ]),
    ).rejects.toMatchObject({ code: 'unaccounted_call' });
    expect(ledger.get('a')?.state).toBe('released');
    expect(ledger.get('b')).toBeUndefined();
  });

  it("is refused by a persistent scope that says 'reject', and the store keeps nothing", async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({
      admission: {
        store,
        scopes: [{ key: 'tenant:1', limits: { tokens: 1_000, unknownPrice: 'reject' } }],
      },
    });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'cb', tokens: 10, unaccounted: true }),
    ).rejects.toMatchObject({
      code: 'unaccounted_call',
      message: expect.stringContaining('tenant:1'),
    });
    expect(await store.usage('tenant:1')).toEqual({ tokens: 0, usd: 0 });
    // Under 'warn' the store holds its estimate like any other.
    const lenient = createBudgetLedger({
      admission: { store, scopes: [{ key: 'tenant:2', limits: { tokens: 1_000 } }] },
    });
    await lenient.reserve({ requestId: 'b', modelId: 'cb', tokens: 10, unaccounted: true });
    await lenient.markUnknown('b');
    expect(await store.usage('tenant:2')).toMatchObject({ tokens: 10 });
  });

  it('restores a 2.3 snapshot unchanged', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 100 } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 10 });
    const snapshot = roundTrip(ledger.snapshot());
    const restored = createBudgetLedger({ snapshot });
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.totals()).not.toHaveProperty('unaccounted');
  });
});
