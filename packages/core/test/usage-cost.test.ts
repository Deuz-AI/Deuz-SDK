import { describe, expect, it, vi } from 'vitest';
import { createUsageCostAccumulator } from '../src/internal/usage-cost';
import type { UsageCostSnapshot } from '../src/internal/usage-cost';
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

describe('legacy per-invocation usage cost', () => {
  it('accumulates cache savings by actual model and preserves them across resume', async () => {
    const cacheSavings = vi.fn((model: string) => (model === 'a' ? 0.1 : 0.2));
    const cost = createUsageCostAccumulator({
      priceProvider: { priceUsage: () => 1, cacheSavings },
    });
    cost.record(usage(1), { model: 'a' });
    cost.record(usage(1), { model: 'b' });
    expect((await cost.flush()).cacheSavingsUsd).toBeCloseTo(0.3);
    expect(cacheSavings.mock.calls.map(([model]) => model)).toEqual(['a', 'b']);
    const recovered = createUsageCostAccumulator({
      snapshot: cost.snapshot(),
      priceProvider: { priceUsage: () => 2, cacheSavings },
    });
    expect((await recovered.flush()).cacheSavingsUsd).toBeCloseTo(0.3);
    expect(cacheSavings).toHaveBeenCalledTimes(2);
    recovered.record(usage(1), { model: 'b' });
    expect((await recovered.flush()).cacheSavingsUsd).toBeCloseTo(0.5);
  });

  it('does not discard known cost when cache savings lookup fails', async () => {
    const cost = createUsageCostAccumulator({
      priceProvider: {
        priceUsage: () => 1,
        cacheSavings: () => {
          throw new Error('offline');
        },
      },
    });
    cost.record(usage(1), { model: 'm' });
    expect(await cost.flush()).toEqual({ pricedUsd: 1, costUsd: 1, calls: 1, unknownCalls: 0 });
  });

  it('prices actual models separately after handoff, including fixed per-call charges', async () => {
    const priceUsage = vi.fn(
      (model: string, value: Usage) => 1 + value.totalTokens * (model === 'cheap' ? 0.01 : 0.1),
    );
    const cost = createUsageCostAccumulator({ priceProvider: { priceUsage } });
    cost.record(usage(10), { model: 'cheap' });
    cost.record(usage(10), { model: 'expensive' });
    cost.record(usage(10), { model: 'cheap' });
    const summary = await cost.flush();
    expect(priceUsage.mock.calls.map(([model]) => model)).toEqual(['cheap', 'expensive', 'cheap']);
    expect(summary.costUsd).toBeCloseTo(4.2);
    expect(summary.calls).toBe(3);
    expect(summary.unknownCalls).toBe(0);
  });

  it('inherits child and compaction callbacks without double-charging aggregate usage', async () => {
    const priceProvider = { priceUsage: (_model: string, value: Usage) => value.totalTokens / 100 };
    const parent = createUsageCostAccumulator({ priceProvider });
    const child = createUsageCostAccumulator({ priceProvider });
    const callback = vi.fn();
    const rootHook = parent.wrap(callback);
    const childHook = child.wrap(rootHook);
    rootHook(usage(10), { model: 'root', reason: 'finished' });
    childHook(usage(20), { model: 'child', reason: 'finished', agentPath: ['child'] });
    childHook(usage(30), { model: 'summary', reason: 'finished', agentPath: ['child'] });
    expect((await parent.flush()).costUsd).toBeCloseTo(0.6);
    expect((await child.flush()).costUsd).toBeCloseTo(0.5);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback.mock.calls[1]?.[1]).toEqual({
      model: 'child',
      reason: 'finished',
      agentPath: ['child'],
    });
  });

  it('persists charged totals and never reprices historical usage during resume', async () => {
    const original = createUsageCostAccumulator({ priceProvider: { priceUsage: () => 1 } });
    original.record(usage(10), { model: 'old-model' });
    await original.flush();
    const saved = JSON.parse(JSON.stringify(original.snapshot())) as UsageCostSnapshot;
    const priceUsage = vi.fn((_model: string, _usage: Usage) => 5);
    const resumed = createUsageCostAccumulator({ snapshot: saved, priceProvider: { priceUsage } });
    expect((await resumed.flush()).costUsd).toBe(1);
    expect(priceUsage).not.toHaveBeenCalled();
    resumed.record(usage(20), { model: 'new-model' });
    expect((await resumed.flush()).costUsd).toBe(6);
    expect(priceUsage).toHaveBeenCalledTimes(1);
    expect(priceUsage.mock.calls[0]?.[0]).toBe('new-model');
  });

  it('retains unknown historical cost and reports the priced amount only as a lower bound', async () => {
    const cost = createUsageCostAccumulator({
      unpricedBaseUsage: true,
      priceProvider: { priceUsage: () => 0.2 },
    });
    cost.record(usage(1), { model: 'new' });
    expect(await cost.flush()).toEqual({ pricedUsd: 0.2, calls: 2, unknownCalls: 1 });
    const restored = createUsageCostAccumulator({
      snapshot: cost.snapshot(),
      priceProvider: { priceUsage: () => 999 },
    });
    expect(await restored.flush()).toEqual({ pricedUsd: 0.2, calls: 2, unknownCalls: 1 });
  });

  it('preserves pending async pricing as unknown in early snapshots and awaits it at flush', async () => {
    let resolve!: (price: number) => void;
    const pending = new Promise<number>((done) => {
      resolve = done;
    });
    const cost = createUsageCostAccumulator({ priceProvider: { priceUsage: () => pending } });
    const value = usage(10);
    cost.record(value, { model: 'm' });
    value.totalTokens = 999;
    expect(cost.snapshot()).toEqual({ version: 1, pricedUsd: 0, calls: 1, unknownCalls: 1 });
    const flush = cost.flush();
    resolve(0.5);
    expect(await flush).toEqual({ pricedUsd: 0.5, costUsd: 0.5, calls: 1, unknownCalls: 0 });
    expect(Object.isFrozen(cost.snapshot())).toBe(true);
  });

  it('does not treat unavailable or failed pricing as zero cost', async () => {
    for (const priceProvider of [
      undefined,
      { priceUsage: () => undefined },
      { priceUsage: () => Number.NaN },
      { priceUsage: () => -1 },
      {
        priceUsage: () => {
          throw new Error('offline');
        },
      },
    ]) {
      const cost = createUsageCostAccumulator({ priceProvider });
      cost.record(usage(1), { model: 'm' });
      expect(await cost.flush()).toEqual({ pricedUsd: 0, calls: 1, unknownCalls: 1 });
    }
  });

  it('records usage even when the user callback throws', async () => {
    const cost = createUsageCostAccumulator({ priceProvider: { priceUsage: () => 1 } });
    const callback = cost.wrap(() => {
      throw new Error('consumer');
    });
    expect(() => callback(usage(1), { model: 'm', reason: 'finished' })).toThrow('consumer');
    expect((await cost.flush()).costUsd).toBe(1);
  });

  it('rejects corrupt cost snapshots', () => {
    expect(() =>
      createUsageCostAccumulator({
        snapshot: { version: 1, pricedUsd: 1, calls: 1, unknownCalls: 2 },
      }),
    ).toThrow(/snapshot/);
    expect(() =>
      createUsageCostAccumulator({
        snapshot: { version: 1, pricedUsd: Number.NaN, calls: 1, unknownCalls: 0 },
      }),
    ).toThrow(/snapshot/);
  });
});
