import { describe, it, expect } from 'vitest';
import {
  priceUsage,
  cacheSavings,
  createPriceProvider,
  PRICE_ALIASES,
  PRICES_2026,
} from '../src/pricing';
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

  it('bills reasoning once, as part of outputTokens (F02)', () => {
    // 600k of the 1M output tokens are reasoning: the output rate applies to 1M, not 1.6M.
    const cost = priceUsage(
      'gpt-5.2',
      usage({ outputTokens: 1_000_000, reasoningTokens: 600_000, totalTokens: 1_000_000 }),
    );
    expect(cost).toBe(10);
  });

  it('still bills 2.2-shaped usage whose reasoning exceeds outputTokens in full', () => {
    // A subset cannot exceed its superset, so these counters were kept apart.
    const cost = priceUsage('gpt-5.2', usage({ outputTokens: 200_000, reasoningTokens: 800_000 }));
    expect(cost).toBe(10);
  });

  it('keeps audio tokens inside the input and output buckets (F18)', () => {
    const cost = priceUsage(
      'gpt-5.2',
      usage({ inputTokens: 1_000_000, audioTokens: 300_000, totalTokens: 1_000_000 }),
    );
    expect(cost).toBe(1.25);
  });

  it('re-prices only the audio share when a row has a dedicated audio rate', () => {
    const table = { voice: { input: 2, output: 10, audio: 40 } };
    // 700 text tokens at $2 + 300 audio tokens at $40, not 1,000 at $2 plus 300 at $40.
    expect(priceUsage('voice', usage({ inputTokens: 1000, audioTokens: 300 }), table)).toBe(0.0134);
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

  it('resolves your own aliases to a row, merged over the built-in ones', () => {
    const pp = createPriceProvider({
      aliases: { 'prod-sonnet': 'claude-sonnet-5-5', 'gone-model': 'no-such-row' },
    });
    expect(pp.priceUsage('prod-sonnet', usage({ inputTokens: 1_000_000 }))).toBe(2);
    expect(pp.priceUsage('mistral-large-latest', usage({ inputTokens: 1_000_000 }))).toBe(0.5);
    expect(pp.priceUsage('gone-model', usage({ inputTokens: 1 }))).toBeUndefined();
  });

  it('resolves an alias against the merged table, so an overridden row wins', () => {
    const pp = createPriceProvider({ table: { 'mistral-large': { input: 1, output: 1 } } });
    expect(pp.priceUsage('mistral-large-latest', usage({ inputTokens: 1_000_000 }))).toBe(1);
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
  it('claude-sonnet-5 bills 2/10, the rate the 2026-10-06 reference lists (F19)', () => {
    expect(priceUsage('claude-sonnet-5', usage(oneM))).toBe(12);
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
  ])('prices cache reads and 1.25x cache writes for %s', (model, expected) => {
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
    outputTokens: 10_000, // 1,000 of them reasoning
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

describe('model lookup: exact ids and explicit aliases (F09)', () => {
  const oneM = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });

  it('prices a newer model at its own row, never a shorter family row', () => {
    expect(priceUsage('claude-opus-5-5', oneM)).toBe(24);
    expect(priceUsage('claude-sonnet-5-5', oneM)).toBe(12);
    // Adding the 5.5 rows leaves the older models' prices alone.
    expect(priceUsage('claude-opus-5', oneM)).toBe(30);
  });

  it.each([
    'claude-opus-5-not-a-real-model',
    'kimi-k2.7-code',
    'sonar-reasoning-pro',
    'grok-4.1-fast',
    'gpt-5.2-chat',
    'claude-opus-4-8-12345678',
  ])('returns undefined for %s instead of borrowing a related row', (model) => {
    expect(priceUsage(model, oneM)).toBeUndefined();
  });

  it('resolves explicit aliases, also behind a vendor prefix', () => {
    expect(priceUsage('mistral-large-latest', oneM)).toBe(2);
    expect(priceUsage('mistralai/mistral-large-latest', oneM)).toBe(2);
  });

  it('resolves dated snapshots of a priced model', () => {
    const tokens = usage({ inputTokens: 1_000_000 });
    expect(priceUsage('claude-haiku-4-5-20251001', tokens)).toBe(1);
    expect(priceUsage('claude-sonnet-4-5-20250929', tokens)).toBe(3);
    expect(priceUsage('gpt-5.2-2025-12-11', tokens)).toBe(1.25);
  });

  it('strips an organization prefix in any case', () => {
    const tokens = usage({ inputTokens: 1_000_000 });
    expect(priceUsage('Qwen/qwen3-max', tokens)).toBe(1.2);
    expect(priceUsage('deepseek-ai/deepseek-v3.2', tokens)).toBe(0.28);
    // The model part still has to match exactly.
    expect(priceUsage('Qwen/Qwen3-Coder-Next', tokens)).toBeUndefined();
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not resolve the inherited key %s',
    (model) => {
      expect(priceUsage(model, oneM)).toBeUndefined();
      expect(cacheSavings(model, usage({ cachedReadTokens: 1 }))).toBeUndefined();
    },
  );

  it('prices a custom table by exact id and keeps the built-in aliases available to it', () => {
    const table = { 'mistral-large': { input: 3, output: 3 }, 'my-model': { input: 1, output: 1 } };
    expect(priceUsage('my-model', oneM, table)).toBe(2);
    expect(priceUsage('mistral-large-latest', oneM, table)).toBe(6);
    expect(priceUsage('gpt-5.2', oneM, table)).toBeUndefined();
  });

  it('exposes the alias table read-only', () => {
    expect(PRICE_ALIASES['mistral-large-latest']).toBe('mistral-large');
    expect(Object.isFrozen(PRICE_ALIASES)).toBe(true);
  });
});

describe('PRICES 2026-10 rows (F19)', () => {
  const allBuckets = usage({
    inputTokens: 100_000,
    outputTokens: 100_000,
    cachedReadTokens: 100_000,
    cacheWriteTokens: 100_000,
    cacheWrite1hTokens: 100_000,
  });

  it.each([
    // input + output + cache read + 5-minute write + 1-hour write, 100k each
    ['claude-opus-5-5', 3.72], // 0.4 + 2 + 0.02 + 0.5 + 0.8
    ['claude-sonnet-5-5', 1.87], // 0.2 + 1 + 0.02 + 0.25 + 0.4
    ['claude-sonnet-5', 1.87],
  ])('prices every Anthropic bucket for %s', (model, expected) => {
    expect(priceUsage(model as string, allBuckets)).toBe(expected);
  });

  it('prices a Haiku 5.5 prompt of up to 100K tokens on the lower card', () => {
    expect(
      priceUsage('claude-haiku-5-5', usage({ inputTokens: 100_000, outputTokens: 1_000 })),
    ).toBe(0.0105);
  });

  it('prices a 100,001-token Haiku 5.5 prompt at $0.50/$2.50', () => {
    expect(
      priceUsage('claude-haiku-5-5', usage({ inputTokens: 100_001, outputTokens: 1_001 })),
    ).toBe(0.052503);
  });

  it('counts cache reads and writes toward the Haiku 5.5 threshold', () => {
    // 60,000 fresh + 40,001 cached = 100,001 prompt tokens: the upper card.
    expect(
      priceUsage('claude-haiku-5-5', usage({ inputTokens: 60_000, cachedReadTokens: 40_001 })),
    ).toBe(0.032);
    // Writes alone push the prompt to 200K: 0.625 and 1.00 per 1M.
    expect(
      priceUsage(
        'claude-haiku-5-5',
        usage({ cacheWriteTokens: 100_000, cacheWrite1hTokens: 100_000 }),
      ),
    ).toBe(0.1625);
    expect(cacheSavings('claude-haiku-5-5', usage({ cachedReadTokens: 200_000 }))).toBe(0.09);
  });

  it('prices gpt-6.1-sol at its research-dated standard rates', () => {
    expect(priceUsage('gpt-6.1-sol', usage({ inputTokens: 100_000, outputTokens: 100_000 }))).toBe(
      1.2,
    );
    expect(
      priceUsage('gpt-6.1-sol', usage({ cachedReadTokens: 100_000, cacheWriteTokens: 100_000 })),
    ).toBe(0.26);
  });
});

describe('threshold tiers (F19)', () => {
  const tiered = {
    t: {
      input: 1,
      output: 2,
      cachedRead: 0.05,
      // Deliberately unsorted: the highest threshold the prompt exceeds wins.
      tiers: [
        { above: 5_000, input: 5, output: 6 },
        { above: 1_000, input: 3, output: 4 },
      ],
    },
  };

  it('keeps the base rates up to and including the lowest threshold', () => {
    expect(priceUsage('t', usage({ inputTokens: 1_000, outputTokens: 1_000 }), tiered)).toBe(0.003);
  });

  it('applies the highest tier the whole prompt exceeds to the whole request', () => {
    expect(priceUsage('t', usage({ inputTokens: 1_001, outputTokens: 1_000 }), tiered)).toBe(
      0.007003,
    );
    expect(priceUsage('t', usage({ inputTokens: 5_001, outputTokens: 1_000 }), tiered)).toBe(
      0.031005,
    );
  });

  it("falls back to the row's own rate for a rate the tier omits", () => {
    // The tier names no cachedRead, so the row's 0.05 holds (not 10% of the tier input).
    expect(priceUsage('t', usage({ inputTokens: 1_000, cachedReadTokens: 1_000 }), tiered)).toBe(
      0.00305,
    );
  });

  it('combines a tier list with the legacy over272k field', () => {
    const table = {
      both: {
        input: 1,
        output: 1,
        tiers: [{ above: 100_000, input: 2, output: 2 }],
        over272k: { input: 4, output: 4 },
      },
    };
    expect(priceUsage('both', usage({ inputTokens: 150_000 }), table)).toBe(0.3);
    expect(priceUsage('both', usage({ inputTokens: 300_000 }), table)).toBe(1.2);
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
