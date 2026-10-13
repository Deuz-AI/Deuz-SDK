import { describe, expect, it } from 'vitest';
import {
  cacheSavings,
  createPriceProvider,
  priceUsage,
  PRICES_2026,
  type ModelPrice,
  type PriceTable,
} from '../src/pricing';
import type { PriceProvider } from '../src/types/deps';
import type { Usage } from '../src/types/usage';

// 2.3 (BA2): price lookups take an optional service tier. `'batch'` prices a
// row's explicit batch card; a row without one has no batch price, so a batch
// request is unpriced (decision 4) instead of billed at a guessed discount.

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

const MILLION = usage({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cachedReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
  cacheWrite1hTokens: 1_000_000,
});

/**
 * The Claude rows whose standard rates the Anthropic Claude API reference
 * (cached 2026-10-06) lists. It prices Message Batches at 50% of standard
 * prices, "including cache reads and writes".
 */
const VERIFIED_CLAUDE = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
];

describe('priceUsage with a service tier', () => {
  const table: PriceTable = {
    m: { input: 2, output: 10, cachedRead: 0.2, batch: { input: 1, output: 5, cachedRead: 0.1 } },
    plain: { input: 2, output: 10 },
  };

  it('prices the standard rates by default and for tier standard', () => {
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(priceUsage('m', u, table)).toBe(12);
    expect(priceUsage('m', u, table, { tier: 'standard' })).toBe(12);
  });

  it("prices a row's batch card for tier batch", () => {
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 500_000 });
    expect(priceUsage('m', u, table, { tier: 'batch' })).toBe(6.05);
  });

  it('leaves a row without a batch card unpriced instead of guessing a discount', () => {
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(priceUsage('plain', u, table, { tier: 'batch' })).toBeUndefined();
    expect(
      cacheSavings('plain', usage({ cachedReadTokens: 10 }), table, { tier: 'batch' }),
    ).toBeUndefined();
  });

  it('prices nothing for a tier it does not know', () => {
    const u = usage({ inputTokens: 1_000 });
    expect(priceUsage('m', u, table, { tier: 'priority' as never })).toBeUndefined();
  });

  it('resolves aliases, vendor prefixes and snapshot dates before reading the batch card', () => {
    const u = usage({ inputTokens: 1_000_000 });
    expect(
      priceUsage('anthropic/claude-opus-5-5-20261001', u, PRICES_2026, { tier: 'batch' }),
    ).toBe(2);
  });

  it('applies the default cache multiples to the batch card’s own input rate', () => {
    const own: PriceTable = { m: { input: 4, output: 20, batch: { input: 2, output: 10 } } };
    // 2 input + 10 output + 0.2 cached read (10% of the batch input)
    // + 2.5 5-minute write (1.25x) + 4 1-hour write (2x).
    expect(priceUsage('m', MILLION, own, { tier: 'batch' })).toBe(18.7);
  });

  it('never inherits a long-context card from the standard rates', () => {
    const own: PriceTable = {
      m: {
        input: 2,
        output: 10,
        over272k: { input: 4, output: 15 },
        batch: { input: 1, output: 5 },
      },
    };
    const long = usage({ inputTokens: 300_000, outputTokens: 1_000 });
    expect(priceUsage('m', long, own)).toBe(1.215);
    // The batch card lists no long-context rates, so its own apply above 272k.
    expect(priceUsage('m', long, own, { tier: 'batch' })).toBe(0.305);
  });

  it('applies the long-context cards a batch card lists', () => {
    const own: PriceTable = {
      m: {
        input: 2,
        output: 10,
        batch: { input: 1, output: 5, tiers: [{ above: 100_000, input: 3, output: 7 }] },
      },
    };
    expect(priceUsage('m', usage({ inputTokens: 100_001 }), own, { tier: 'batch' })).toBe(0.300003);
  });

  it('prices cache savings on the batch card', () => {
    const u = usage({ cachedReadTokens: 1_000_000 });
    expect(cacheSavings('m', u, table)).toBe(1.8);
    expect(cacheSavings('m', u, table, { tier: 'batch' })).toBe(0.9);
  });
});

describe('PRICES_2026 batch cards', () => {
  it.each(VERIFIED_CLAUDE)('%s bills every token at half its standard rate in a batch', (id) => {
    const row = PRICES_2026[id]!;
    const batch = row.batch;
    expect(batch).toBeDefined();
    const half = (value: number | undefined) => (value === undefined ? undefined : value / 2);
    expect(batch).toEqual({
      input: row.input / 2,
      output: row.output / 2,
      ...(row.cachedRead !== undefined ? { cachedRead: half(row.cachedRead) } : {}),
      ...(row.cacheWrite !== undefined ? { cacheWrite: half(row.cacheWrite) } : {}),
      ...(row.cacheWrite1h !== undefined ? { cacheWrite1h: half(row.cacheWrite1h) } : {}),
      ...(row.tiers
        ? {
            tiers: row.tiers.map((tier) => ({
              above: tier.above,
              input: tier.input / 2,
              output: tier.output / 2,
              ...(tier.cachedRead !== undefined ? { cachedRead: half(tier.cachedRead) } : {}),
              ...(tier.cacheWrite !== undefined ? { cacheWrite: half(tier.cacheWrite) } : {}),
              ...(tier.cacheWrite1h !== undefined ? { cacheWrite1h: half(tier.cacheWrite1h) } : {}),
            })),
          }
        : {}),
    });
    expect(priceUsage(id, MILLION, PRICES_2026, { tier: 'batch' })).toBeCloseTo(
      priceUsage(id, MILLION)! / 2,
      6,
    );
  });

  it('lists Claude Fable 5.1 at the batch $5/$25 the reference names', () => {
    expect(PRICES_2026['claude-fable-5-1']!.batch).toMatchObject({ input: 5, output: 25 });
  });

  it('bills a Haiku 5.5 batch prompt above 100K tokens on the halved long-context card', () => {
    const u = usage({ inputTokens: 100_001, outputTokens: 1_000_000 });
    // $0.25/$1.25 per million above 100K tokens (half of $0.50/$2.50).
    expect(priceUsage('claude-haiku-5-5', u, PRICES_2026, { tier: 'batch' })).toBe(1.275);
  });

  it('has no batch card where no primary source states a batch rate', () => {
    const verified = new Set(VERIFIED_CLAUDE);
    const carded = Object.entries(PRICES_2026)
      .filter(([, row]) => row.batch !== undefined)
      .map(([id]) => id)
      .sort();
    expect(carded).toEqual([...verified].sort());
    for (const id of ['gpt-5.6-sol', 'gpt-6-astra', 'gemini-3.1-pro', 'claude-sonnet-4-5']) {
      expect(priceUsage(id, MILLION, PRICES_2026, { tier: 'batch' })).toBeUndefined();
    }
  });
});

describe('createPriceProvider with a service tier', () => {
  it('honours the tier and the margin', async () => {
    const provider = createPriceProvider({ margin: 2 });
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(await provider.priceUsage('claude-opus-5-5', u)).toBe(48);
    expect(await provider.priceUsage('claude-opus-5-5', u, { tier: 'batch' })).toBe(24);
    expect(await provider.priceUsage('gpt-5.6-sol', u, { tier: 'batch' })).toBeUndefined();
    const read = usage({ cachedReadTokens: 1_000_000 });
    // ($2 batch input - $0.10 batch cached read) x margin 2.
    expect(await provider.cacheSavings!('claude-opus-5-5', read, { tier: 'batch' })).toBe(3.8);
  });

  it('drops the built-in batch card of a row your table replaces', async () => {
    const row: ModelPrice = { input: 3, output: 12 };
    const provider = createPriceProvider({ table: { 'claude-opus-5-5': row } });
    const u = usage({ inputTokens: 1_000_000 });
    expect(await provider.priceUsage('claude-opus-5-5', u)).toBe(3);
    expect(await provider.priceUsage('claude-opus-5-5', u, { tier: 'batch' })).toBeUndefined();
  });

  it('prices batch cards your table adds, for any provider', async () => {
    const provider = createPriceProvider({
      table: { 'gpt-5.6-sol': { ...PRICES_2026['gpt-5.6-sol']!, batch: { input: 2, output: 10 } } },
    });
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(await provider.priceUsage('gpt-5.6-sol', u, { tier: 'batch' })).toBe(12);
  });

  it('keeps a two-argument PriceProvider assignable (the tier is additive)', () => {
    const legacy: PriceProvider = { priceUsage: (_model, u) => u.inputTokens / 1_000_000 };
    expect(legacy.priceUsage('m', usage({ inputTokens: 1_000_000 }), { tier: 'batch' })).toBe(1);
  });
});
