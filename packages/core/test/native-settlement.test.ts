import { describe, expect, it } from 'vitest';
import { generateText } from '../src/generate';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { BudgetLedgerError, createBudgetLedger } from '../src/budget-ledger';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { BudgetStore } from '../src/types/budget-store';
import type { Usage } from '../src/types/usage';

const usage = (totalTokens: number): Usage => ({
  inputTokens: totalTokens,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens,
});

const prices = { priceUsage: () => 0.01 };
const scopes = [{ key: 'user:1', limits: { tokens: 100_000 } }];

/** An in-memory store whose `method` fails its first `failures` calls. */
function flaky(method: 'settle' | 'release', failures: number) {
  const inner = createInMemoryBudgetStore();
  let calls = 0;
  const store: BudgetStore = {
    ...inner,
    [method]: (...args: unknown[]) => {
      calls++;
      if (calls <= failures) return Promise.reject(new Error('could not serialize access (40001)'));
      return (inner[method] as (...a: unknown[]) => Promise<void>)(...args);
    },
  };
  return { store, inner, calls: () => calls };
}

const model = () =>
  createMockModel({ responses: [{ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } }] });

describe('native settlement survives a failing BudgetStore (F17)', () => {
  it('retries a failed settlement until the hold closes with the actual usage', async () => {
    const { store, calls } = flaky('settle', 2);
    const execution = createExecutionContext({ admission: { store, scopes } });
    // 2.2 cleared the request id first: one failure left the estimate held forever.
    await expect(
      generateText({ model: model(), prompt: 'hi', execution, deps: { priceProvider: prices } }),
    ).resolves.toMatchObject({ text: 'done' });
    expect(calls()).toBe(3);
    expect(await store.usage('user:1')).toEqual({ tokens: 15, usd: 0.01 });
    expect(execution.ledger.snapshot().reservations[0]).toMatchObject({
      state: 'settled',
      actual: { tokens: 15, usd: 0.01 },
    });
  });

  it('keeps the request id when the store stays down, and surfaces a recoverable error', async () => {
    const { store, calls } = flaky('settle', Number.POSITIVE_INFINITY);
    const execution = createExecutionContext({ admission: { store, scopes } });
    const error = (await generateText({
      model: model(),
      prompt: 'hi',
      execution,
      deps: { priceProvider: prices },
    }).catch((caught: unknown) => caught)) as BudgetLedgerError;
    expect(error).toBeInstanceOf(BudgetLedgerError);
    const [record] = execution.ledger.snapshot().reservations;
    expect(error).toMatchObject({
      code: 'admission_failed',
      requestId: record!.requestId,
      settlement: { requestId: record!.requestId, usage: { totalTokens: 15 }, usd: 0.01 },
      cause: { message: 'could not serialize access (40001)' },
    });
    expect(error.message).toContain(record!.requestId);
    // Bounded: three attempts on the finish path and three on the error path.
    expect(calls()).toBe(6);
    // Nothing was lost: the hold still counts at its estimate, in the ledger and the store.
    expect(record).toMatchObject({ state: 'reserved' });
    const held = (await store.usage('user:1')).tokens;
    expect(held).toBe(record!.reservation.tokens);
    expect(held).toBeGreaterThan(15);
  });

  it('closes a kept hold with the surfaced settlement once the store is back', async () => {
    const { store, inner } = flaky('settle', Number.POSITIVE_INFINITY);
    const execution = createExecutionContext({ admission: { store, scopes } });
    const error = (await generateText({
      model: model(),
      prompt: 'hi',
      execution,
      deps: { priceProvider: prices },
    }).catch((caught: unknown) => caught)) as BudgetLedgerError;
    // Recovery path: a ledger over the same durable state and a healthy store.
    const recovered = createExecutionContext({
      snapshot: execution.snapshot(),
      admission: { store: inner },
    });
    await recovered.ledger.settle(error.settlement!);
    expect(await inner.usage('user:1')).toEqual({ tokens: 15, usd: 0.01 });
    expect(recovered.ledger.get(error.requestId!)).toMatchObject({ state: 'settled' });
  });

  it('gives direct ledger callers the same retries and a replayable settlement', async () => {
    const flaked = flaky('settle', 2);
    const ledger = createBudgetLedger({ admission: { store: flaked.store, scopes } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 100, usd: 1 });
    await expect(ledger.settle({ requestId: 'a', tokens: 10, usd: 0.5 })).resolves.toMatchObject({
      state: 'settled',
    });
    expect(flaked.calls()).toBe(3);

    const down = flaky('settle', Number.POSITIVE_INFINITY);
    const stuck = createBudgetLedger({ admission: { store: down.store, scopes } });
    await stuck.reserve({ requestId: 'b', modelId: 'm', tokens: 100, usd: 1 });
    const error = (await stuck
      .settleUsage('b', usage(12), prices)
      .catch((caught: unknown) => caught)) as BudgetLedgerError;
    expect(error).toMatchObject({
      code: 'admission_failed',
      requestId: 'b',
      settlement: { requestId: 'b', usage: { totalTokens: 12 }, usd: 0.01 },
    });
    expect(stuck.get('b')?.state).toBe('reserved');
    // Errors that close no hold carry no request id.
    const plain = await createBudgetLedger({
      admission: {
        store: { ...down.store, reserve: () => Promise.reject(new Error('down')) },
        scopes,
      },
    })
      .reserve({ requestId: 'c', modelId: 'm', tokens: 1 })
      .catch((caught: unknown) => caught);
    expect(plain).toMatchObject({ code: 'admission_failed' });
    expect(Object.keys(plain as object)).not.toContain('requestId');
  });

  it('retries releasing the hold of a request the provider refused', async () => {
    const { store, calls } = flaky('release', 1);
    const execution = createExecutionContext({ admission: { store, scopes } });
    const base = model();
    // A 400 is never billed, so its hold is released rather than kept.
    const refused = attachConfig(
      { ...base },
      {
        ...readConfig(base)!,
        fetch: (async () =>
          new Response(JSON.stringify({ error: { message: 'bad request' } }), {
            status: 400,
          })) as typeof fetch,
      },
    );
    await expect(
      generateText({ model: refused, prompt: 'hi', execution, deps: { priceProvider: prices } }),
    ).rejects.toThrow('bad request');
    expect(calls()).toBe(2);
    expect(execution.ledger.snapshot().reservations[0]).toMatchObject({ state: 'released' });
    expect(await store.usage('user:1')).toEqual({ tokens: 0, usd: 0 });
  });
});

describe('a sweep that closed the hold first (F17)', () => {
  /** The documented periodic sweep (default: settle at the estimate) runs before `method`'s first call. */
  function sweptFirst(method: 'settle' | 'release') {
    const inner = createInMemoryBudgetStore();
    let calls = 0;
    const store: BudgetStore = {
      ...inner,
      [method]: async (...args: unknown[]) => {
        calls++;
        if (calls === 1) await inner.sweep({ before: Date.now() + 60_000 });
        return (inner[method] as (...a: unknown[]) => Promise<void>)(...args);
      },
    };
    return { store, inner, calls: () => calls };
  }

  it('accepts a settlement as already closed: no retry, no error, the local entry settles', async () => {
    const { store, inner, calls } = sweptFirst('settle');
    const ledger = createBudgetLedger({ admission: { store, scopes } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 100, usd: 1 });
    // Before: three attempts, then admission_failed, and the entry stayed 'reserved' for good.
    await expect(ledger.settle({ requestId: 'a', tokens: 10, usd: 0.5 })).resolves.toMatchObject({
      state: 'settled',
      actual: { tokens: 10, usd: 0.5 },
    });
    expect(calls()).toBe(1);
    expect(ledger.totals()).toMatchObject({ reserved: { tokens: 0, usd: 0 }, unknownUsd: 0 });
    // The store keeps what the sweep billed.
    expect(await inner.usage('user:1')).toEqual({ tokens: 100, usd: 1 });
    // A replay is a no-op.
    await expect(ledger.settle({ requestId: 'a', tokens: 10, usd: 0.5 })).resolves.toMatchObject({
      state: 'settled',
    });
    expect(calls()).toBe(1);
    expect(await ledger.compact('root')).toMatchObject({ retained: 0 });
  });

  it('accepts a release as already closed', async () => {
    const { store, calls } = sweptFirst('release');
    const ledger = createBudgetLedger({ admission: { store, scopes } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 100, usd: 1 });
    // The sweep billed the hold, so the store refuses to release it.
    await expect(ledger.release('a')).resolves.toMatchObject({ state: 'released' });
    expect(calls()).toBe(1);
    await expect(ledger.release('a')).resolves.toMatchObject({ state: 'released' });
    expect(calls()).toBe(1);
  });

  it('lets a call whose hold a sweep closed in flight succeed', async () => {
    const { store, inner, calls } = sweptFirst('settle');
    const execution = createExecutionContext({ admission: { store, scopes } });
    await expect(
      generateText({ model: model(), prompt: 'hi', execution, deps: { priceProvider: prices } }),
    ).resolves.toMatchObject({ text: 'done' });
    // Before: six store calls, then admission_failed although the call succeeded.
    expect(calls()).toBe(1);
    expect(execution.ledger.snapshot().reservations[0]).toMatchObject({
      state: 'settled',
      actual: { tokens: 15, usd: 0.01 },
    });
    expect(await inner.holds({ before: Date.now() + 60_000 })).toEqual([]);
  });

  it('closes the entry when error.settlement is replayed after a sweep', async () => {
    const { store, inner } = flaky('settle', Number.POSITIVE_INFINITY);
    const execution = createExecutionContext({ admission: { store, scopes } });
    const error = (await generateText({
      model: model(),
      prompt: 'hi',
      execution,
      deps: { priceProvider: prices },
    }).catch((caught: unknown) => caught)) as BudgetLedgerError;
    expect(error).toMatchObject({ code: 'admission_failed' });
    // The store is back; the operator's periodic sweep ran before the replay.
    await inner.sweep({ before: Date.now() + 60_000 });
    const recovered = createExecutionContext({
      snapshot: execution.snapshot(),
      admission: { store: inner },
    });
    await expect(recovered.ledger.settle(error.settlement!)).resolves.toMatchObject({
      state: 'settled',
    });
    expect(recovered.ledger.get(error.requestId!)?.state).toBe('settled');
  });
});
