import { describe, expect, it } from 'vitest';
import { generateText } from '../src/generate';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { BudgetLedgerError } from '../src/budget-ledger';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { BudgetStore } from '../src/types/budget-store';

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
      code: 'settlement_failed',
      requestId: record!.requestId,
      settlement: { requestId: record!.requestId, usage: { totalTokens: 15 } },
      cause: { code: 'admission_failed' },
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
    await recovered.ledger.settleUsage(
      error.settlement!.requestId,
      error.settlement!.usage!,
      prices,
    );
    expect(await inner.usage('user:1')).toEqual({ tokens: 15, usd: 0.01 });
    expect(recovered.ledger.get(error.requestId!)).toMatchObject({ state: 'settled' });
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
