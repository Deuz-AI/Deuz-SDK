import { describe, expect, it, vi } from 'vitest';
import {
  adoptReservation,
  BudgetLedgerError,
  createBudgetLedger,
  reserveAll,
  subtreeLedgerSnapshot,
} from '../src/budget-ledger';
import type {
  BudgetLedger,
  BudgetLedgerOptions,
  BudgetLedgerSnapshot,
  BudgetLimits,
  BudgetReservationInput,
} from '../src/budget-ledger';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createExecutionContext, reserveAllInContext } from '../src/execution-policy';
import type { BudgetStore, PersistentBudgetScope } from '../src/types/budget-store';
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
    await ledger.reserve({
      requestId: 'a1',
      modelId: 'm',
      tokens: 50,
      usd: 1,
      scopes: scoped('a'),
    });
    await ledger.settle({ requestId: 'a1', tokens: 40, usd: 0.5 });
    await ledger.reserve({
      requestId: 'a2',
      modelId: 'm',
      tokens: 30,
      usd: 1,
      scopes: scoped('a'),
    });
    await ledger.markUnknown('a2');
    await ledger.reserve({
      requestId: 'a3',
      modelId: 'm',
      tokens: 5,
      usd: 0.1,
      scopes: scoped('a'),
    });
    await ledger.release('a3');
    await ledger.reserve({
      requestId: 'b1',
      modelId: 'm',
      tokens: 20,
      usd: 1,
      scopes: scoped('b'),
    });
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
    await ledger.reserve({
      requestId: 'a',
      modelId: 'm',
      tokens: 5,
      usd: 0.1,
      scopes: scoped('a'),
    });
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

// 2.3 (W2a S5-1): a batch hold read back by a fresh ledger after a restart was
// admitted where it was reserved. Its provider request already ran.
describe('adopting a reservation admitted elsewhere (2.3)', () => {
  const org: PersistentBudgetScope = { key: 'org:1', limits: { tokens: 100 } };

  it('records it without local admission, and its overage refuses later work', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 10, usd: 1, unknownPrice: 'reject' } });
    await ledger.reserve({ requestId: 'mine', modelId: 'm', tokens: 10, usd: 1 });
    const adopted = await adoptReservation(ledger, {
      requestId: 'old',
      modelId: 'm',
      kind: 'batch',
      tokens: 5,
      usd: 0.5,
    });
    expect(adopted).toMatchObject({ state: 'reserved', kind: 'batch', reservation: { tokens: 5 } });
    // Neither the budget nor its unknownPrice policy refuses it.
    await adoptReservation(ledger, {
      requestId: 'unpriced',
      modelId: 'm',
      tokens: 1,
      unpriced: true,
    });
    expect(ledger.totals().committed).toEqual({ tokens: 16, usd: 1.5 });
    await ledger.settle({ requestId: 'old', tokens: 7, usd: 0.7 });
    await expect(
      ledger.reserve({ requestId: 'next', modelId: 'm', tokens: 0, usd: 0 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('treats an identical repeat as a no-op and a different one as a conflict', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 1 } });
    const input = { requestId: 'old', modelId: 'm', tokens: 5 };
    const first = await adoptReservation(ledger, input);
    const revision = ledger.snapshot().revision;
    expect(await adoptReservation(ledger, input)).toBe(first);
    expect(ledger.snapshot().revision).toBe(revision);
    await expect(adoptReservation(ledger, { ...input, tokens: 6 })).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
  });

  it('still goes through the BudgetStore, which counts the same hold once', async () => {
    const store = createInMemoryBudgetStore();
    const first = createBudgetLedger({ admission: { store, scopes: [org] } });
    await first.reserve({ requestId: 'old', modelId: 'm', tokens: 60 });
    // A fresh ledger after a restart, whose own budget the hold exceeds.
    const fresh = createBudgetLedger({
      budget: { tokens: 10 },
      admission: { store, scopes: [org] },
    });
    await adoptReservation(fresh, { requestId: 'old', modelId: 'm', tokens: 60 });
    expect(await store.usage('org:1')).toEqual({ tokens: 60, usd: 0 });
    await fresh.settle({ requestId: 'old', tokens: 70, usd: 0 });
    expect(await store.usage('org:1')).toEqual({ tokens: 70, usd: 0 });
    // The store recorded other amounts under that id: a conflict, and nothing changes.
    const other = createBudgetLedger({ admission: { store, scopes: [org] } });
    await expect(
      adoptReservation(other, { requestId: 'old', modelId: 'm', tokens: 50 }),
    ).rejects.toMatchObject({ name: 'BudgetLedgerError', code: 'reservation_conflict' });
    expect(other.get('old')).toBeUndefined();
    expect(await store.usage('org:1')).toEqual({ tokens: 70, usd: 0 });
  });

  it('keeps the store’s refusal when the store no longer knows the hold and is full', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [org] } });
    await ledger.reserve({ requestId: 'new', modelId: 'm', tokens: 100 });
    await expect(
      adoptReservation(createBudgetLedger({ admission: { store, scopes: [org] } }), {
        requestId: 'forgotten',
        modelId: 'm',
        tokens: 10,
      }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('reserves through a ledger createBudgetLedger did not make', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 10 } });
    const reserve = vi.fn(ledger.reserve);
    const foreign = { ...ledger, reserve };
    await expect(
      adoptReservation(foreign, { requestId: 'old', modelId: 'm', tokens: 50 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});

// 2.3 (W2a S5-2): a batch's holds are admitted in one ledger step, each
// against the ones before it, instead of one reservation per request (which
// walked every record and persisted a full snapshot each time).
describe('reserving many attempts in one step (2.3)', () => {
  type Inputs = readonly BudgetReservationInput[];
  const hold = (requestId: string, extra: Partial<BudgetReservationInput> = {}) => ({
    requestId,
    modelId: 'm',
    ...extra,
  });
  const root = { id: 'root', budget: { tokens: 100 } };
  const under = (id: string, budget: BudgetLimits = {}) => [root, { id, budget }];

  /** Reserve one by one, releasing the ones made when one is refused (what batches did). */
  async function oneByOne(ledger: BudgetLedger, inputs: Inputs): Promise<unknown> {
    const made: string[] = [];
    try {
      for (const input of inputs) made.push((await ledger.reserve(input)).requestId);
    } catch (error) {
      for (const requestId of made.reverse()) await ledger.release(requestId);
      return error;
    }
    return undefined;
  }

  const scenarios: {
    name: string;
    options?: BudgetLedgerOptions;
    before?: (ledger: BudgetLedger) => Promise<unknown>;
    inputs: Inputs;
  }[] = [
    {
      name: 'every attempt fits',
      options: { budget: { tokens: 100 } },
      inputs: [hold('a', { tokens: 40 }), hold('b', { tokens: 60 })],
    },
    {
      name: 'the third exceeds the budget',
      options: { budget: { tokens: 100 } },
      inputs: [hold('a', { tokens: 40 }), hold('b', { tokens: 40 }), hold('c', { tokens: 40 })],
    },
    {
      name: 'a scope budget refuses the second',
      inputs: [
        hold('a', { tokens: 30, scopes: under('child', { tokens: 50 }) }),
        hold('b', { tokens: 30, scopes: under('child', { tokens: 50 }) }),
      ],
    },
    {
      name: 'a later scope budget tightens the scope for it',
      inputs: [
        hold('a', { tokens: 30, scopes: under('child') }),
        hold('b', { tokens: 30, scopes: under('child', { tokens: 50 }) }),
      ],
    },
    {
      name: 'an attempt without an estimate fails a later bound closed',
      inputs: [
        hold('a', { scopes: [{ id: 'child', budget: {} }] }),
        hold('b', { tokens: 1, scopes: [{ id: 'child', budget: { tokens: 10 } }] }),
      ],
    },
    {
      name: 'an unpriced model adds no USD',
      options: { budget: { usd: 1 } },
      inputs: [hold('a', { usd: 0.5 }), hold('b', { unpriced: true }), hold('c', { usd: 0.6 })],
    },
    {
      name: 'unknownPrice reject refuses an unpriced model',
      options: { budget: { usd: 1, unknownPrice: 'reject' } },
      inputs: [hold('a', { usd: 0.1 }), hold('b', { unpriced: true })],
    },
    {
      name: 'records and folded aggregates already count',
      before: async (ledger) => {
        await ledger.reserve(hold('x', { tokens: 30, scopes: under('done') }));
        await ledger.settle({ requestId: 'x', tokens: 40, usd: 0 });
        await ledger.compact('done');
        await ledger.reserve(hold('y', { tokens: 20, scopes: under('live') }));
      },
      inputs: [
        hold('a', { tokens: 30, scopes: under('live') }),
        hold('b', { tokens: 20, scopes: under('live') }),
      ],
    },
    {
      name: 'a repeat is not admitted again',
      options: { budget: { tokens: 100 } },
      before: (ledger) => ledger.reserve(hold('a', { tokens: 60 })),
      inputs: [hold('a', { tokens: 60 }), hold('b', { tokens: 40 })],
    },
  ];

  for (const scenario of scenarios)
    it(`leaves what reserving one by one leaves: ${scenario.name}`, async () => {
      const run = async (step: (ledger: BudgetLedger) => Promise<unknown>) => {
        const ledger = createBudgetLedger(scenario.options);
        await scenario.before?.(ledger);
        const error = (await step(ledger)) as BudgetLedgerError | undefined;
        return {
          error: error && { code: error.code, message: error.message },
          totals: ledger.totals(),
          records: ledger.snapshot().reservations,
        };
      };
      const expected = await run((ledger) => oneByOne(ledger, scenario.inputs));
      const actual = await run((ledger) =>
        reserveAll(ledger, scenario.inputs).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(actual).toEqual(expected);
    });

  it('writes one revision and one snapshot per step', async () => {
    const writes: number[] = [];
    const ledger = createBudgetLedger({
      budget: { tokens: 100 },
      persist: (saved) => void writes.push(saved.reservations.length),
    });
    const made = await reserveAll(ledger, [
      hold('a', { tokens: 10 }),
      hold('b', { tokens: 10 }),
      hold('c', { tokens: 10 }),
    ]);
    expect(made.map((item) => [item.requestId, item.state])).toEqual([
      ['a', 'reserved'],
      ['b', 'reserved'],
      ['c', 'reserved'],
    ]);
    expect(writes).toEqual([3]);
    expect(ledger.snapshot().revision).toBe(1);
    // A refusal leaves the ones admitted before it released, in one more revision.
    await expect(
      reserveAll(ledger, [hold('d', { tokens: 50 }), hold('e', { tokens: 50 })]),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(writes).toEqual([3, 4]);
    expect(ledger.snapshot().revision).toBe(2);
    expect(ledger.get('d')?.state).toBe('released');
    expect(ledger.get('e')).toBeUndefined();
    expect(ledger.totals().committed.tokens).toBe(30);
  });

  it('refuses a conflict or a repeated id before admitting anything', async () => {
    const ledger = createBudgetLedger();
    await ledger.reserve(hold('a', { tokens: 1 }));
    await expect(
      reserveAll(ledger, [hold('b', { tokens: 1 }), hold('a', { tokens: 2 })]),
    ).rejects.toMatchObject({ code: 'reservation_conflict' });
    await expect(
      reserveAll(ledger, [hold('c', { tokens: 1 }), hold('c', { tokens: 1 })]),
    ).rejects.toMatchObject({ code: 'invalid_budget' });
    expect(ledger.get('b')).toBeUndefined();
    expect(ledger.get('c')).toBeUndefined();
    expect(ledger.snapshot().revision).toBe(1);
  });

  it('mirrors each into the BudgetStore, which takes back the ones made when it refuses one', async () => {
    const store = createInMemoryBudgetStore();
    const org: PersistentBudgetScope = { key: 'org:1', limits: { tokens: 100 } };
    const ledger = createBudgetLedger({ admission: { store, scopes: [org] } });
    await reserveAll(ledger, [hold('a', { tokens: 40 }), hold('b', { tokens: 40 })]);
    expect(await store.usage('org:1')).toEqual({ tokens: 80, usd: 0 });
    await expect(
      reserveAll(ledger, [hold('c', { tokens: 10 }), hold('d', { tokens: 20 })]),
    ).rejects.toMatchObject({ code: 'budget_exceeded', message: /org:1/ });
    expect(await store.usage('org:1')).toEqual({ tokens: 80, usd: 0 });
    expect(ledger.get('c')?.state).toBe('released');
    expect(ledger.get('d')).toBeUndefined();
  });

  it('keeps a hold the store would not take back, as a failed release does', async () => {
    const inner = createInMemoryBudgetStore();
    const release = vi.fn(() => Promise.reject(new Error('store offline')));
    const store: BudgetStore = { ...inner, release };
    const org: PersistentBudgetScope = { key: 'org:1', limits: { tokens: 50 } };
    const ledger = createBudgetLedger({ admission: { store, scopes: [org] } });
    await expect(
      reserveAll(ledger, [hold('a', { tokens: 40 }), hold('b', { tokens: 40 })]),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    // Fail closed: the store still holds it, so the ledger does too.
    expect(release).toHaveBeenCalledTimes(3);
    expect(ledger.get('a')?.state).toBe('reserved');
    expect(await store.usage('org:1')).toEqual({ tokens: 40, usd: 0 });
  });

  it('reserves one by one through a ledger createBudgetLedger did not make', async () => {
    const ledger = createBudgetLedger({ budget: { tokens: 10 } });
    await expect(
      reserveAll({ ...ledger }, [hold('a', { tokens: 6 }), hold('b', { tokens: 6 })]),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(ledger.get('a')?.state).toBe('released');
    expect(ledger.snapshot().revision).toBe(2);
  });

  it('checks a context’s policy for every attempt first and adds its scopes', async () => {
    const context = createExecutionContext({
      budget: { tokens: 100 },
      policy: { allowedModels: ['m'] },
    });
    const child = context.child({ scopeId: 'job', budget: { tokens: 50 } });
    await expect(
      reserveAllInContext(child, [hold('a', { tokens: 10 }), hold('b', { modelId: 'x' })]),
    ).rejects.toMatchObject({ code: 'model_not_allowed' });
    expect(child.ledger.get('a')).toBeUndefined();
    const made = await reserveAllInContext(child, [
      hold('a', { tokens: 20 }),
      hold('b', { tokens: 20 }),
    ]);
    expect(made.map((item) => item.scopes.map((scope) => scope.id))).toEqual([
      ['root', 'root/job'],
      ['root', 'root/job'],
    ]);
    await expect(reserveAllInContext(child, [hold('c', { tokens: 20 })])).rejects.toMatchObject({
      code: 'budget_exceeded',
      message: 'tokens budget exceeded in root/job.',
    });
  });

  it('reserves one by one through a context createExecutionContext did not make', async () => {
    const context = createExecutionContext({ budget: { tokens: 10 } });
    const reserve = vi.fn(context.reserve);
    await expect(
      reserveAllInContext({ ...context, reserve }, [
        hold('a', { tokens: 6 }),
        hold('b', { tokens: 6 }),
      ]),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(context.ledger.get('a')?.state).toBe('released');
  });
});
