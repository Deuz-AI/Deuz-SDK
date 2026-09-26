import { describe, it, expect } from 'vitest';
import { priceUsage, cacheSavings, createPriceProvider, PRICES_2026 } from '../src/pricing';
import type { Usage } from '../src/types/usage';

function usage(over: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
    ...over,
  };
}

describe('priceUsage', () => {
  it('computes input + output cost per 1M tokens', () => {
    // gpt-5.2: input 1.25, output 10 (USD / 1M)
    const cost = priceUsage('gpt-5.2', usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(1.25 + 10, 6);
  });

  it('bills reasoning tokens at the output rate', () => {
    const cost = priceUsage('gpt-5.2', usage({ reasoningTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(10, 6);
  });

  it('uses the dedicated cached-read rate (Anthropic)', () => {
    // claude-opus: input 5, cachedRead 0.5
    const cost = priceUsage('claude-opus-4-8', usage({ cachedReadTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it('applies cache-write 5m and 1h rates', () => {
    const c = priceUsage(
      'claude-opus-4-8',
      usage({ cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 }),
    );
    // cacheWrite 6.25 + cacheWrite1h 10
    expect(c).toBeCloseTo(6.25 + 10, 6);
  });

  it('falls back to 10% of input for cachedRead when not specified', () => {
    // grok-4 has no explicit cachedRead → default = input * 0.1 = 0.3
    const explicit = PRICES_2026['grok-4']!;
    expect(explicit.cachedRead).toBe(0.75); // grok DOES specify it
    // qwen3-max has none → default 0.1 * 1.2 = 0.12
    const cost = priceUsage('qwen3-max', usage({ cachedReadTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(0.12, 6);
  });

  it('returns undefined for an unknown model', () => {
    expect(priceUsage('totally-made-up-model', usage({ inputTokens: 1000 }))).toBeUndefined();
  });

  it('strips date stamps and vendor prefixes (tolerant lookup)', () => {
    expect(priceUsage('gpt-5.2-2025-12-11', usage({ inputTokens: 1_000_000 }))).toBeCloseTo(
      1.25,
      6,
    );
    expect(priceUsage('google/gemini-2.5-flash', usage({ inputTokens: 1_000_000 }))).toBeCloseTo(
      0.3,
      6,
    );
    expect(priceUsage('doubao-seedream', usage())).toBeUndefined(); // genuinely unknown
  });

  it('prices embeddings as input-only', () => {
    expect(priceUsage('text-embedding-3-small', usage({ inputTokens: 1_000_000 }))).toBeCloseTo(
      0.02,
      6,
    );
  });
});

describe('createPriceProvider', () => {
  it('returns a PriceProvider usable as deps.priceProvider', () => {
    const pp = createPriceProvider();
    expect(pp.priceUsage('gpt-5.2', usage({ outputTokens: 1_000_000 }))).toBeCloseTo(10, 6);
    expect(pp.priceUsage('unknown', usage({ inputTokens: 1 }))).toBeUndefined();
  });

  it('applies a margin multiplier', () => {
    const pp = createPriceProvider({ margin: 1.3 });
    const c = pp.priceUsage('gpt-5.2', usage({ outputTokens: 1_000_000 })) as number;
    expect(c).toBeCloseTo(10 * 1.3, 5);
  });

  it('merges a custom table over the built-in one', () => {
    const pp = createPriceProvider({ table: { 'my-model': { input: 2, output: 4 } } });
    expect(pp.priceUsage('my-model', usage({ inputTokens: 1_000_000 }))).toBeCloseTo(2, 6);
    // built-ins still resolve
    expect(pp.priceUsage('gpt-5.2', usage({ inputTokens: 1_000_000 }))).toBeCloseTo(1.25, 6);
  });
});

describe('PRICES 2026-07 refresh', () => {
  const oneM = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };

  it('gpt-5.5 bills 5/30', () => {
    expect(priceUsage('gpt-5.5', usage(oneM))).toBe(35);
  });
  it('gpt-5.5-pro bills 30/180 (no more prefix leak to gpt-5.5)', () => {
    expect(priceUsage('gpt-5.5-pro', usage(oneM))).toBe(210);
  });
  it('grok-4.3 bills 1.25/2.5 (no more grok-4 prefix leak)', () => {
    expect(priceUsage('grok-4.3', usage(oneM))).toBe(3.75);
  });
  it('claude-fable-5 bills 10/50 with 1h cache write 20', () => {
    expect(
      priceUsage(
        'claude-fable-5',
        usage({ ...oneM, cacheWrite1hTokens: 1_000_000, totalTokens: 3_000_000 }),
      ),
    ).toBe(80);
  });
  it('claude-sonnet-5 bills standard 3/15', () => {
    expect(priceUsage('claude-sonnet-5', usage(oneM))).toBe(18);
  });
  it('gemini-3.1-pro-preview uses over200k tier when input exceeds 200k', () => {
    expect(
      priceUsage('gemini-3.1-pro-preview', usage({ inputTokens: 100_000, totalTokens: 100_000 })),
    ).toBe(0.2);
    expect(
      priceUsage('gemini-3.1-pro-preview', usage({ inputTokens: 300_000, totalTokens: 300_000 })),
    ).toBe(1.2);
  });
  it('dead slugs are gone', () => {
    expect(priceUsage('text-embedding-004', usage(oneM))).toBeUndefined();
  });
});

describe('PRICES 2026-09 current models', () => {
  it.each([
    ['gpt-6-astra', 6],
    ['gpt-5.6-sol', 2.4],
    ['gpt-5.6', 2.4],
    ['gpt-5.6-terra', 1.4],
    ['gpt-5.6-luna', 0.14],
    ['claude-fable-5-1', 6],
    ['claude-opus-5', 3],
  ])('prices 100k input and 100k output for %s', (model, expected) => {
    expect(
      priceUsage(model as string, usage({ inputTokens: 100_000, outputTokens: 100_000 })),
    ).toBe(expected);
  });

  it.each([
    ['gpt-6-astra', 1.35],
    ['gpt-5.6-sol', 0.54],
    ['gpt-5.6-terra', 0.27],
    ['gpt-5.6-luna', 0.027],
  ])('uses the explicit read and write rates for %s', (model, expected) => {
    expect(
      priceUsage(model as string, usage({ cachedReadTokens: 100_000, cacheWriteTokens: 100_000 })),
    ).toBe(expected);
  });

  it('resolves aliases, dated names, and vendor-prefixed names without legacy prefix leakage', () => {
    const tokens = usage({ inputTokens: 100_000 });
    expect(priceUsage('gpt-5.6', tokens)).toBe(0.4);
    expect(priceUsage('gpt-5.6-sol-2026-09-20', tokens)).toBe(0.4);
    expect(priceUsage('openai/gpt-6-astra', tokens)).toBe(1);
    expect(priceUsage('anthropic/claude-fable-5-1-20260901', tokens)).toBe(1);
    expect(priceUsage('anthropic/claude-opus-5', tokens)).toBe(0.5);
  });

  it('uses Fable 5.1 cache reads at 2.5% of input alongside both cache-write TTLs', () => {
    const tokens = usage({
      inputTokens: 10_000,
      outputTokens: 10_000,
      cachedReadTokens: 100_000,
      cacheWriteTokens: 100_000,
      cacheWrite1hTokens: 100_000,
    });
    expect(priceUsage('claude-fable-5-1', tokens)).toBe(3.875);
    expect(cacheSavings('claude-fable-5-1', tokens)).toBe(0.975);
    expect(cacheSavings('claude-fable-5', tokens)).toBe(0.9);
  });

  it('keeps Opus 5 and Fable 5.1 at standard pricing across the context window', () => {
    const tokens = usage({ inputTokens: 900_000, outputTokens: 100_000 });
    expect(priceUsage('claude-opus-5', tokens)).toBe(7);
    expect(priceUsage('claude-fable-5-1', tokens)).toBe(14);
  });
});

describe('272k prompt tier', () => {
  const boundary = usage({
    inputTokens: 72_000,
    cachedReadTokens: 100_000,
    cacheWriteTokens: 50_000,
    cacheWrite1hTokens: 50_000,
    outputTokens: 9_000,
    reasoningTokens: 1_000,
    totalTokens: 282_000,
  });

  it('keeps exactly 272k prompt tokens on standard rates, excluding output and reasoning', () => {
    expect(priceUsage('gpt-5.6-sol', boundary)).toBe(1.178);
    expect(cacheSavings('gpt-5.6-sol', boundary)).toBe(0.36);
  });

  it('counts every prompt bucket and switches the entire request above 272k', () => {
    const above = { ...boundary, inputTokens: 72_001, totalTokens: 282_001 };
    // Fresh input 0.576008 + reads 0.08 + writes 0.5/0.8 + output/reasoning 0.3.
    expect(priceUsage('gpt-5.6-sol', above)).toBe(2.256008);
    expect(cacheSavings('gpt-5.6-sol', above)).toBe(0.72);
  });

  it.each([
    ['gpt-6-astra', 13.6],
    ['gpt-5.6-sol', 5.44],
    ['gpt-5.6', 5.44],
    ['gpt-5.6-terra', 3.02],
    ['gpt-5.6-luna', 0.302],
  ])('applies the long-context input and output rates for %s', (model, expected) => {
    expect(
      priceUsage(model as string, usage({ inputTokens: 305_000, outputTokens: 100_000 })),
    ).toBe(expected);
  });

  it('uses a custom tier for both costs and cache savings, including a 1h-write override', () => {
    const provider = createPriceProvider({
      table: {
        'gpt-5.6-sol': {
          input: 2,
          output: 3,
          cachedRead: 0.2,
          cacheWrite: 2.5,
          cacheWrite1h: 4,
          over272k: { input: 6, output: 9, cachedRead: 0.6, cacheWrite: 7, cacheWrite1h: 11 },
        },
      },
    });
    const above = { ...boundary, inputTokens: 72_001 };
    expect(provider.priceUsage('gpt-5.6-sol', boundary)).toBe(0.519);
    expect(provider.priceUsage('gpt-5.6-sol', above)).toBe(1.482006);
    expect(provider.cacheSavings!('gpt-5.6-sol', above)).toBe(0.54);
    // Other rows remain available, with their own tier.
    expect(provider.priceUsage('gpt-6-astra', usage({ outputTokens: 100_000 }))).toBe(5);
  });

  it('replaces a built-in model completely when the custom row omits a long-context tier', () => {
    const provider = createPriceProvider({
      table: { 'gpt-6-astra': { input: 1, output: 2, cachedRead: 0.25 } },
    });
    const tokens = usage({ inputTokens: 300_000, cachedReadTokens: 100_000 });
    expect(provider.priceUsage('gpt-6-astra', tokens)).toBe(0.325);
    expect(provider.cacheSavings!('gpt-6-astra', tokens)).toBe(0.075);
  });

  it('preserves the existing 200k tier and cache savings for Gemini', () => {
    const tokens = usage({ inputTokens: 100_000, cachedReadTokens: 100_000, cacheWriteTokens: 1 });
    expect(priceUsage('gemini-3.1-pro', tokens)).toBe(0.220003);
    expect(cacheSavings('gemini-3.1-pro', tokens)).toBe(0.18);
    const above = { ...tokens, inputTokens: 100_001 };
    expect(priceUsage('gemini-3.1-pro', above)).toBe(0.440009);
    expect(cacheSavings('gemini-3.1-pro', above)).toBe(0.36);
  });
});

describe('cacheSavings (1.7, D2)', () => {
  it('computes USD saved by cache reads vs full input rate', async () => {
    const { cacheSavings, createPriceProvider } = await import('../src/pricing');
    const usage = {
      inputTokens: 1000,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 1_001_000,
    };
    // claude-opus-4-8 style: cachedRead defaults to 10% of input when unset.
    const table = { 'model-x': { input: 10, output: 20 } };
    expect(cacheSavings('model-x', usage, table)).toBe(9); // (10 - 1) * 1M/1M
    expect(cacheSavings('unknown-model', usage, table)).toBeUndefined();
    expect(cacheSavings('model-x', { ...usage, cachedReadTokens: 0 }, table)).toBe(0);
    // createPriceProvider wires the seam (margin applies to savings too).
    const provider = createPriceProvider({ table, margin: 2 });
    expect(provider.cacheSavings!('model-x', usage)).toBe(18);
  });
});
