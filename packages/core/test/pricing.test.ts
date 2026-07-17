import { describe, it, expect } from 'vitest';
import { priceUsage, createPriceProvider, PRICES_2026 } from '../src/pricing';
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
