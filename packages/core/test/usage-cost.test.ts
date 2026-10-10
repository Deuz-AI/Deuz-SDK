import { describe, expect, it, vi } from 'vitest';
import { createUsageCostAccumulator } from '../src/internal/usage-cost';
import type { UsageCostSnapshot } from '../src/internal/usage-cost';
import { UnpricedModelError } from '../src/internal/unpriced';
import { createWarningSink } from '../src/internal/warnings';
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

  it('does not treat failed pricing as zero cost', async () => {
    for (const priceProvider of [
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

  it('keeps costUsd as the sum of priced calls when a model has no price (F13)', async () => {
    // 2.2 dropped costUsd for good after one unpriced call, so budget.usd never fired again.
    const priceProvider = { priceUsage: (model: string) => (model === 'priced' ? 0.5 : undefined) };
    const cost = createUsageCostAccumulator({ priceProvider });
    cost.record(usage(1), { model: 'unpriced' });
    cost.record(usage(1), { model: 'priced' });
    cost.record(usage(1), { model: 'unpriced' });
    cost.record(usage(1), { model: 'priced' });
    expect(await cost.flush()).toEqual({
      pricedUsd: 1,
      costUsd: 1,
      calls: 4,
      unknownCalls: 0,
      unpricedCalls: 2,
      unpricedModels: ['unpriced'],
    });
    for (const missing of [undefined, { priceUsage: () => undefined }]) {
      const none = createUsageCostAccumulator({ priceProvider: missing });
      none.record(usage(1), { model: 'm' });
      expect(await none.flush()).toEqual({
        pricedUsd: 0,
        costUsd: 0,
        calls: 1,
        unknownCalls: 0,
        unpricedCalls: 1,
        unpricedModels: ['m'],
      });
    }
  });

  it('carries unpriced calls across resume without repricing them', async () => {
    const priceUsage = vi.fn((model: string) => (model === 'priced' ? 2 : undefined));
    const cost = createUsageCostAccumulator({ priceProvider: { priceUsage } });
    cost.record(usage(1), { model: 'free-tier' });
    cost.record(usage(1), { model: 'priced' });
    await cost.flush();
    const saved = JSON.parse(JSON.stringify(cost.snapshot())) as UsageCostSnapshot;
    expect(saved).toEqual({
      version: 1,
      pricedUsd: 2,
      calls: 2,
      unknownCalls: 0,
      unpricedCalls: 1,
      unpricedModels: ['free-tier'],
    });
    const resumed = createUsageCostAccumulator({ snapshot: saved, priceProvider: { priceUsage } });
    expect(await resumed.flush()).toMatchObject({ costUsd: 2, unpricedModels: ['free-tier'] });
    expect(priceUsage).toHaveBeenCalledTimes(2);
    expect(() =>
      createUsageCostAccumulator({
        snapshot: { ...saved, unknownCalls: 2 },
      }),
    ).toThrow(/snapshot/);
  });

  it('records usage even when the user callback throws', async () => {
    const cost = createUsageCostAccumulator({ priceProvider: { priceUsage: () => 1 } });
    const callback = cost.wrap(() => {
      throw new Error('consumer');
    });
    expect(() => callback(usage(1), { model: 'm', reason: 'finished' })).toThrow('consumer');
    expect((await cost.flush()).costUsd).toBe(1);
  });

  it('warns once per model while a USD budget is set, through the loop sink', async () => {
    const warnings = createWarningSink();
    const cost = createUsageCostAccumulator({
      priceProvider: { priceUsage: (model: string) => (model === 'priced' ? 1 : undefined) },
      budget: { usd: 5 },
      warnings,
    });
    for (const model of ['glm-5.3', 'priced', 'glm-5.3', 'kimi-k3', 'glm-5.3'])
      cost.record(usage(1), { model });
    await cost.flush();
    expect(warnings.list().map((w) => [w.type, w.setting])).toEqual([
      ['unpriced-model', 'budget.usd'],
      ['unpriced-model', 'budget.usd'],
    ]);
    expect(warnings.list()[0]!.message).toContain('glm-5.3');
    expect(warnings.list()[1]!.message).toContain('kimi-k3');
    // Without a USD bound nothing was waived, so nothing is reported.
    const quiet = createWarningSink();
    const tokensOnly = createUsageCostAccumulator({
      priceProvider: { priceUsage: () => undefined },
      budget: { tokens: 100 },
      warnings: quiet,
    });
    tokensOnly.record(usage(1), { model: 'glm-5.3' });
    await tokensOnly.flush();
    expect(quiet.list()).toEqual([]);
  });

  it('admits a model before its call: warns, or refuses it under unknownPrice reject', async () => {
    const priceUsage = vi.fn((model: string) => (model === 'priced' ? 1 : undefined));
    const warnings = createWarningSink();
    const warn = createUsageCostAccumulator({
      priceProvider: { priceUsage },
      budget: { usd: 5 },
      warnings,
    });
    await warn.admit('priced');
    await warn.admit('glm-5.3');
    await warn.admit('glm-5.3');
    expect(warnings.list()).toHaveLength(1);
    expect(warnings.list()[0]).toMatchObject({ type: 'unpriced-model' });
    // One probe per model per run.
    expect(priceUsage.mock.calls.map(([model]) => model)).toEqual(['priced', 'glm-5.3']);

    const strict = createUsageCostAccumulator({
      priceProvider: { priceUsage },
      budget: { usd: 5, unknownPrice: 'reject' },
    });
    await expect(strict.admit('priced')).resolves.toBeUndefined();
    const refused = await strict.admit('glm-5.3').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnpricedModelError);
    expect(refused).toMatchObject({ code: 'unpriced_model', modelId: 'glm-5.3' });
    // No price provider at all is the same as no price.
    const bare = createUsageCostAccumulator({ budget: { usd: 5, unknownPrice: 'reject' } });
    await expect(bare.admit('priced')).rejects.toMatchObject({ code: 'unpriced_model' });
    // The policy only guards a USD bound.
    const tokensOnly = createUsageCostAccumulator({ budget: { unknownPrice: 'reject' } });
    await expect(tokensOnly.admit('glm-5.3')).resolves.toBeUndefined();
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
