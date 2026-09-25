import { describe, expect, it, vi } from 'vitest';
import {
  BudgetLedgerError,
  createBudgetLedger,
  subtreeLedgerSnapshot,
} from '../src/budget-ledger';
import type { BudgetLedgerSnapshot } from '../src/budget-ledger';
import type { Usage } from '../src/types/usage';

function usage(tokens: number): Usage {
  return {
    inputTokens: tokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: tokens,
  };
}

describe('native shared budget ledger', () => {
  it('composes durable sinks under the same queue and unsubscribes independently', async () => {
    const writes: string[] = [];
    const ledger = createBudgetLedger({
      persist: (snapshot) => {
        writes.push(`base:${snapshot.revision}`);
      },
    });
    const first = ledger.addPersistence((snapshot) => {
      writes.push(`first:${snapshot.revision}`);
    });
    ledger.addPersistence((snapshot) => {
      writes.push(`second:${snapshot.revision}`);
    });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 1 });
    first();
    first();
    await ledger.settle({ requestId: 'a', tokens: 1, usd: 0 });
    expect(writes).toEqual(['base:1', 'first:1', 'second:1', 'base:2', 'second:2']);
  });

  it('awaits added native session persistence before admission succeeds', async () => {
    let resolve!: () => void;
    const barrier = new Promise<void>((done) => {
      resolve = done;
    });
    const ledger = createBudgetLedger();
    ledger.addPersistence(async () => {
      await barrier;
    });
    let admitted = false;
    const pending = ledger.reserve({ requestId: 'a', modelId: 'm' }).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    resolve();
    await pending;
    expect(admitted).toBe(true);
  });

  it('poisons every alias when an added durable sink fails', async () => {
    const ledger = createBudgetLedger();
    const remove = ledger.addPersistence(() => {
      throw new Error('native store offline');
    });
    await expect(ledger.reserve({ requestId: 'a', modelId: 'm' })).rejects.toMatchObject({
      code: 'persistence_failed',
    });
    remove();
    await expect(ledger.reserve({ requestId: 'b', modelId: 'm' })).rejects.toMatchObject({
      code: 'persistence_failed',
    });
    expect(() => ledger.addPersistence(() => {})).toThrow(/recover a new ledger/);
    expect(ledger.get('b')).toBeUndefined();
  });

  it('rejects synchronous persistence re-entry instead of deadlocking admission', async () => {
    const ledger = createBudgetLedger();
    ledger.addPersistence(() =>
      ledger.reserve({ requestId: 'nested', modelId: 'm' }).then(() => {}),
    );
    await expect(ledger.reserve({ requestId: 'a', modelId: 'm' })).rejects.toMatchObject({
      code: 'persistence_failed',
      cause: { message: 'Persistence callbacks must not mutate their ledger.' },
    });
    expect(ledger.get('nested')).toBeUndefined();
  });

  it('serializes admission and persistence across concurrent callers', async () => {
    let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const writes: number[] = [];
    const ledger = createBudgetLedger({
      budget: { tokens: 10 },
      persist: async (snapshot) => {
        writes.push(snapshot.revision);
        await barrier;
      },
    });
    const first = ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 6 });
    const second = ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 6 });
    const result = Promise.allSettled([first, second]);
    await Promise.resolve();
    expect(writes).toEqual([1]);
    expect(ledger.get('b')).toBeUndefined();
    unblock();
    const [a, b] = await result;
    expect(a?.status).toBe('fulfilled');
    expect(b).toMatchObject({
      status: 'rejected',
      reason: { code: 'budget_exceeded', fatalExecution: true },
    });
    expect(ledger.totals().committed.tokens).toBe(6);
  });

  it('prices each actual model once, including auxiliary calls and child calls', async () => {
    const price = vi.fn(
      (model: string, value: Usage) => value.totalTokens * (model === 'small' ? 0.01 : 0.1),
    );
    const ledger = createBudgetLedger({ budget: { tokens: 1000, usd: 100 } });
    for (const [requestId, modelId, kind] of [
      ['main', 'small', 'model'],
      ['child', 'large', 'child'],
      ['compact', 'small', 'compaction'],
      ['finish', 'large', 'finalizer'],
      ['verify', 'small', 'verifier'],
    ]) {
      await ledger.reserve({ requestId: requestId!, modelId: modelId!, kind, tokens: 50, usd: 10 });
      await ledger.settleUsage(requestId!, usage(10), { priceUsage: price });
      await ledger.settleUsage(requestId!, usage(10), { priceUsage: price });
    }
    expect(price.mock.calls.map(([model]) => model)).toEqual([
      'small',
      'large',
      'small',
      'large',
      'small',
    ]);
    expect(ledger.totals().spent.tokens).toBe(50);
    expect(ledger.totals().spent.usd).toBeCloseTo(2.3);
    expect(ledger.totals().reserved).toEqual({ tokens: 0, usd: 0 });
  });

  it('keeps reservations for aborted or unpriced calls and supports later reconciliation', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 100, usd: 2 } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 40, usd: 1 });
    await ledger.markUnknown('a');
    expect(ledger.totals()).toMatchObject({
      reserved: { tokens: 40, usd: 1 },
      unknownTokens: 1,
      unknownUsd: 1,
    });
    await ledger.settleUsage('a', usage(10), {
      priceUsage: () => {
        throw new Error('pricing down');
      },
    });
    expect(ledger.totals()).toMatchObject({
      spent: { tokens: 10, usd: 0 },
      reserved: { tokens: 0, usd: 1 },
      unknownTokens: 0,
      unknownUsd: 1,
    });
    await ledger.settleUsage('a', usage(10), { priceUsage: () => 0.25 });
    expect(ledger.get('a')?.state).toBe('settled');
    expect(ledger.totals().committed).toEqual({ tokens: 10, usd: 0.25 });
  });

  it('flags unknown usage even with zero held estimates', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'zero', modelId: 'm', tokens: 0, usd: 0 });
    await ledger.markUnknown('zero');
    const recovered = createBudgetLedger({
      snapshot: JSON.parse(JSON.stringify(ledger.snapshot())) as BudgetLedgerSnapshot,
    });
    expect(recovered.totals()).toMatchObject({
      committed: { tokens: 0, usd: 0 },
      unknownTokens: 1,
      unknownUsd: 1,
    });
  });

  it('does not infer free usage when pricing is missing or invalid', async () => {
    const ledger = createBudgetLedger({ budget: { usd: 1 } });
    await expect(ledger.reserve({ requestId: 'missing', modelId: 'm' })).rejects.toMatchObject({
      code: 'missing_reservation',
    });
    await ledger.reserve({ requestId: 'a', modelId: 'm', usd: 1 });
    await ledger.settleUsage('a', usage(1), { priceUsage: () => Number.NaN });
    expect(ledger.totals().reserved.usd).toBe(1);
    await expect(ledger.reserve({ requestId: 'b', modelId: 'm', usd: 0.1 })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
  });

  it('fails closed when adding a cap after unreserved unknown usage', async () => {
    const first = createBudgetLedger();
    await first.reserve({ requestId: 'a', modelId: 'm' });
    const recovered = createBudgetLedger({ snapshot: first.snapshot(), budget: { tokens: 100 } });
    await expect(
      recovered.reserve({ requestId: 'b', modelId: 'm', tokens: 10 }),
    ).rejects.toMatchObject({ code: 'missing_reservation' });
  });

  it('records actual overages and prevents subsequent admission', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 10 } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 5 });
    await ledger.settle({ requestId: 'a', tokens: 12, usd: 0.1 });
    expect(ledger.totals().spent.tokens).toBe(12);
    await expect(ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 0 })).rejects.toMatchObject(
      { code: 'budget_exceeded' },
    );
  });

  it('recovers request IDs and settles idempotently without counting twice', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 100 } });
    const input = { requestId: 'a', modelId: 'm', tokens: 50 };
    await ledger.reserve(input);
    await ledger.settle({ requestId: 'a', usage: usage(10), usd: 0.2 });
    const saved = JSON.parse(JSON.stringify(ledger.snapshot())) as BudgetLedgerSnapshot;
    const recovered = createBudgetLedger({ snapshot: saved, budget: { tokens: 1000 } });
    await recovered.reserve(input);
    await recovered.settle({ requestId: 'a', usage: usage(10), usd: 0.2 });
    expect(recovered.snapshot().revision).toBe(saved.revision);
    expect(recovered.budget.tokens).toBe(100);
    expect(recovered.totals().spent).toEqual({ tokens: 10, usd: 0.2 });
    await expect(recovered.reserve({ ...input, modelId: 'different' })).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
    await expect(recovered.settle({ requestId: 'a', usd: 0.3 })).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
    await expect(recovered.settle({ requestId: 'a', usage: usage(11) })).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
  });

  it('only releases unbilled calls and treats released IDs as tombstones', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 10 } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 10 });
    await ledger.markUnknown('a');
    await ledger.release('a');
    await ledger.release('a');
    expect(ledger.totals().committed.tokens).toBe(0);
    expect((await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 10 })).state).toBe(
      'released',
    );
    await expect(ledger.settle({ requestId: 'a', tokens: 1 })).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
    await ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 10 });
    await ledger.settle({ requestId: 'b', tokens: 1 });
    await expect(ledger.release('b')).rejects.toMatchObject({ code: 'reservation_conflict' });
  });

  it('poisons admission after persistence failure and preserves the diagnostic hold', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('store offline'))
      .mockResolvedValue(undefined);
    const ledger = createBudgetLedger({ budget: { tokens: 10 }, persist });
    const input = { requestId: 'a', modelId: 'm', tokens: 10 };
    await expect(ledger.reserve(input)).rejects.toMatchObject({
      code: 'persistence_failed',
      fatalExecution: true,
      cause: { message: 'store offline' },
    });
    expect(ledger.totals().reserved.tokens).toBe(10);
    await expect(ledger.reserve(input)).rejects.toMatchObject({ code: 'persistence_failed' });
    await expect(ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 0 })).rejects.toMatchObject(
      { code: 'persistence_failed' },
    );
    await expect(ledger.release('a')).rejects.toMatchObject({ code: 'persistence_failed' });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().revision).toBe(1);
  });

  it('rejects already-queued admissions after a failed durable write', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('store offline'))
      .mockResolvedValue(undefined);
    const ledger = createBudgetLedger({ budget: { tokens: 100 }, persist });
    const results = await Promise.allSettled([
      ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 10 }),
      ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 10 }),
    ]);
    expect(results).toMatchObject([
      { status: 'rejected', reason: { code: 'persistence_failed', fatalExecution: true } },
      { status: 'rejected', reason: { code: 'persistence_failed', fatalExecution: true } },
    ]);
    expect(ledger.get('b')).toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('makes saved records immutable and rejects corrupted snapshots', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 10 });
    const saved = ledger.snapshot();
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.reservations)).toBe(true);
    expect(Object.isFrozen(saved.reservations[0]?.reservation)).toBe(true);
    expect(() =>
      createBudgetLedger({
        snapshot: { ...saved, reservations: [...saved.reservations, ...saved.reservations] },
      }),
    ).toThrow(BudgetLedgerError);
    expect(() => createBudgetLedger({ snapshot: { ...saved, revision: -1 } })).toThrow(
      BudgetLedgerError,
    );
    expect(() => createBudgetLedger({ budget: { tokens: Number.POSITIVE_INFINITY } })).toThrow(
      BudgetLedgerError,
    );
  });
});

describe('ledger compaction (2.2)', () => {
  const root = { id: 'root', budget: { tokens: 1000 } };
  const scoped = (id: string) => [root, { id, budget: {} }];

  it('folds a finished scope without changing global, ancestor or sibling totals', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 1000, usd: 10 } });
    await ledger.reserve({ requestId: 'a1', modelId: 'm', tokens: 50, usd: 1, scopes: scoped('a') });
    await ledger.settle({ requestId: 'a1', tokens: 40, usd: 0.5 });
    await ledger.reserve({ requestId: 'a2', modelId: 'm', tokens: 30, usd: 1, scopes: scoped('a') });
    await ledger.markUnknown('a2');
    await ledger.reserve({ requestId: 'a3', modelId: 'm', tokens: 5, usd: 0.1, scopes: scoped('a') });
    await ledger.release('a3');
    await ledger.reserve({ requestId: 'b1', modelId: 'm', tokens: 20, usd: 1, scopes: scoped('b') });
    const before = { all: ledger.totals(), root: ledger.totals('root'), b: ledger.totals('b') };
    expect(await ledger.compact('a')).toEqual({ scopeId: 'a', folded: 2, dropped: 1, retained: 0 });
    expect(ledger.totals()).toEqual(before.all);
    expect(ledger.totals('root')).toEqual(before.root);
    expect(ledger.totals('b')).toEqual(before.b);
    expect(ledger.totals('a').committed).toEqual({ tokens: 0, usd: 0 });
    expect(ledger.get('a1')).toBeUndefined();
    const saved = ledger.snapshot();
    expect(saved.version).toBe(2);
    expect(saved.reservations.map((item) => item.requestId)).toEqual(['b1']);
    expect(saved.aggregates).toEqual([
      {
        scopes: [root],
        count: 2,
        spent: { tokens: 40, usd: 0.5 },
        held: { tokens: 30, usd: 1 },
        unknownTokens: 1,
        unknownUsd: 1,
        unestimatedTokens: 0,
        unestimatedUsd: 0,
      },
    ]);
  });

  it('retains in-flight reservations and folds them after they settle', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'live', modelId: 'm', tokens: 10, scopes: scoped('a') });
    expect(await ledger.compact('a')).toEqual({ scopeId: 'a', folded: 0, dropped: 0, retained: 1 });
    expect(ledger.snapshot().version).toBe(1);
    await ledger.settle({ requestId: 'live', tokens: 7, usd: 0 });
    expect(await ledger.compact('a')).toMatchObject({ folded: 1, retained: 0 });
    expect(ledger.totals('root').spent).toEqual({ tokens: 7, usd: 0 });
  });

  it('keeps a later cap fail-closed for folded usage that had no estimate', async () => {
    const first = createBudgetLedger();
    await first.reserve({ requestId: 'a', modelId: 'm', tokens: 10, scopes: scoped('a') });
    await first.settle({ requestId: 'a', tokens: 8 });
    await first.compact('a');
    expect(first.snapshot().aggregates?.[0]).toMatchObject({ unknownUsd: 1, unestimatedUsd: 1 });
    const capped = createBudgetLedger({ snapshot: first.snapshot(), budget: { usd: 5 } });
    await expect(
      capped.reserve({ requestId: 'b', modelId: 'm', usd: 1, scopes: [root] }),
    ).rejects.toMatchObject({ code: 'missing_reservation' });
  });

  it('counts folded usage against ancestor limits on later admission', async () => {
    const tight = { id: 'root', budget: { tokens: 100 } };
    const ledger = createBudgetLedger();
    const under = (id: string) => [tight, { id, budget: {} }];
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 80, scopes: under('a') });
    await ledger.settle({ requestId: 'a', tokens: 80, usd: 0 });
    await ledger.compact('a');
    await expect(
      ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 30, scopes: under('b') }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await ledger.reserve({ requestId: 'c', modelId: 'm', tokens: 20, scopes: under('c') });
  });

  it('round-trips version 2 snapshots and rejects malformed or sliced ones', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 5, usd: 0.1, scopes: scoped('a') });
    await ledger.settle({ requestId: 'a', tokens: 5, usd: 0.1 });
    await ledger.compact('a');
    const saved = JSON.parse(JSON.stringify(ledger.snapshot())) as BudgetLedgerSnapshot;
    const recovered = createBudgetLedger({ snapshot: saved });
    expect(recovered.totals()).toEqual(ledger.totals());
    expect(recovered.snapshot()).toEqual(saved);
    expect(() => createBudgetLedger({ snapshot: { ...saved, version: 1 } })).toThrow(
      BudgetLedgerError,
    );
    expect(() =>
      createBudgetLedger({
        snapshot: { ...saved, aggregates: [...saved.aggregates!, ...saved.aggregates!] },
      }),
    ).toThrow(BudgetLedgerError);
    expect(() =>
      createBudgetLedger({
        snapshot: { ...saved, aggregates: [{ ...saved.aggregates![0]!, unestimatedUsd: 3 }] },
      }),
    ).toThrow(BudgetLedgerError);
    expect(() => createBudgetLedger({ snapshot: subtreeLedgerSnapshot(saved, 'root') })).toThrow(
      /subtree/,
    );
  });

  it('writes version 1 snapshots until compaction is used and slices one scope', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 1, scopes: scoped('a') });
    await ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 1, scopes: scoped('b') });
    expect(Object.keys(ledger.snapshot())).toEqual([
      'version',
      'revision',
      'budget',
      'reservations',
    ]);
    const slice = subtreeLedgerSnapshot(ledger.snapshot(), 'a');
    expect(slice).toMatchObject({ version: 2, subtree: 'a', revision: 2 });
    expect(slice.reservations.map((item) => item.requestId)).toEqual(['a']);
  });

  it('persists a compaction once and skips persistence when nothing folds', async () => {
    const writes: number[] = [];
    const ledger = createBudgetLedger({ persist: (saved) => void writes.push(saved.revision) });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 1, scopes: scoped('a') });
    await ledger.settle({ requestId: 'a', tokens: 1, usd: 0 });
    await ledger.compact('b');
    await ledger.compact('a');
    expect(writes).toEqual([1, 2, 3]);
  });
});
