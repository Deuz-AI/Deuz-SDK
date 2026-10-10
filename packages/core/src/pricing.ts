/**
 * pricing.ts — optional USD cost estimation (Faz 1.D seam, filled in Faz 5).
 *
 * The core's GOLDEN RULE is that it only ever returns a token *breakdown*
 * (`Usage`); turning tokens into dollars is an app concern (margins, currency,
 * contracts differ per deployment). This module is therefore OPTIONAL: it ships
 * a pinned 2026 price table + a `PriceProvider` factory you can inject via
 * `deps.priceProvider`, but core never imports it and never bills automatically.
 *
 * Prices are USD per 1,000,000 tokens, sourced from public list prices.
 * GPT-6 Astra and GPT-5.6 rates were verified 2026-09-20; the Claude 5.x rows
 * were checked against Anthropic's Claude API reference on 2026-10-06;
 * gpt-6.1-sol carries research-dated (2026-10-09) rates; legacy rows retain
 * their earlier price snapshots. Every row and alias is explicit: an id the
 * table does not list prices as `undefined`, never as a related model.
 * They WILL drift — verify against the provider's pricing page before you bill,
 * or pass your own table to `createPriceProvider({ table: customTable })`.
 *
 *   import { createPriceProvider } from '@deuz-sdk/core/pricing';
 *   const deuz = createClient({ deps: { priceProvider: createPriceProvider() } });
 *   // …or price a single Usage directly:
 *   const usd = priceUsage('gpt-5.6-sol', usage);
 *
 * Batch requests (2.3, `@deuz-sdk/core/batch`) are priced from a row's `batch`
 * card: `priceUsage(model, usage, table, { tier: 'batch' })`. Only rates a
 * primary source states explicitly are carded; a row without one has no batch
 * price, never a guessed discount.
 */
import type { Usage } from './types/usage';
import type { PriceProvider, PriceUsageOptions } from './types/deps';

export type { PriceUsageOptions, ServiceTier } from './types/deps';

/** A long-context price card: its rates bill the whole request once the prompt passes `above`. */
export interface PriceTier {
  /**
   * Prompt-token threshold, exclusive. The prompt counts fresh input, cache
   * reads and both cache-write buckets — everything but the output.
   */
  above: number;
  input: number;
  output: number;
  cachedRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** USD per 1,000,000 tokens for one model. Omitted fields fall back sensibly. */
export interface ModelPrice {
  /** Fresh (uncached) input tokens. */
  input: number;
  /** Output tokens, reasoning included (`Usage.outputTokens` already contains it). */
  output: number;
  /** Cached-read input tokens. Default: 10% of `input` (Anthropic/OpenAI norm). */
  cachedRead?: number;
  /** Cache-write tokens (5-minute TTL for Anthropic). Default: 1.25 × `input`. */
  cacheWrite?: number;
  /** 1-hour cache-write tokens (Anthropic). Default: 2 × `input`. */
  cacheWrite1h?: number;
  /**
   * Audio tokens, when billed at their own rate. `Usage.audioTokens` is a share
   * of the input and output buckets, which already bill it at the text rate, so
   * this re-prices that share from `input` to `audio`. Omit it when audio bills
   * like text. Usage merges prompt and completion audio, so a model whose audio
   * output has a different rate again needs its own `PriceProvider`.
   */
  audio?: number;
  /**
   * Long-context price cards. The tier with the highest `above` that the
   * prompt exceeds prices the whole request; a rate the tier omits falls back
   * to this row's own rate. `over200k` and `over272k` take part in the same choice.
   */
  tiers?: PriceTier[];
  /** Long-context tier applied when `inputTokens + cachedReadTokens > 200_000` (Gemini Pro). */
  over200k?: { input: number; output: number; cachedRead?: number };
  /** Full-request tier above 272,000 prompt tokens, including both cache-write buckets. */
  over272k?: {
    input: number;
    output: number;
    cachedRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
  };
  /**
   * The rates of the provider's asynchronous batch tier (2.3), read by
   * `{ tier: 'batch' }` lookups. A complete card: nothing falls back to the
   * standard rates above, so list its long-context cards too; omitted cache
   * rates take their usual multiples of the card's own `input`. Only rates a
   * primary source states belong here: a row without a card has no batch
   * price, and a batch request on it is unpriced.
   */
  batch?: Omit<ModelPrice, 'batch'>;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Pinned 2026 list prices (USD / 1M tokens). NOT authoritative — list prices
 * change often and enterprise/Vertex/Bedrock rates differ. Treat as a starting
 * point; override per deployment.
 */
export const PRICES_2026: PriceTable = {
  // ---- OpenAI (GPT-6 / GPT-5.6; verified 2026-09-20) ----
  // Standard rates: https://developers.openai.com/api/docs/pricing
  // Above 272k prompt tokens, each model's full request uses 2x input/cache
  // and 1.5x output rates: https://developers.openai.com/api/docs/models/gpt-6-astra
  // OpenAI lists cache writes at 1.25x input, but neither OpenAI usage shape
  // carries a cache-write counter (only cached reads), so the adapters report
  // cacheWriteTokens 0 and those prompt tokens bill at the input rate. The rows
  // leave cacheWrite to the 1.25x default, which equals the list rate for a
  // counter you supply yourself. Not live-verified.
  'gpt-6-astra': {
    input: 10,
    output: 50,
    cachedRead: 1,
    over272k: { input: 20, output: 75, cachedRead: 2 },
  },
  // Research-dated, not re-verified. source: https://developers.openai.com/api/docs/models/gpt-6.1-sol
  // checkedAt: 2026-10-09 (research). The listed $2.50 cache write is the 1.25x
  // default. Long-context, tier and regional multipliers are unverified, so a
  // prompt above 272k bills at these standard rates.
  'gpt-6.1-sol': { input: 2, output: 10, cachedRead: 0.1 },
  'gpt-5.6-sol': {
    input: 4,
    output: 20,
    cachedRead: 0.4,
    over272k: { input: 8, output: 30, cachedRead: 0.8 },
  },
  // GPT-5.6 is an alias for Sol, kept as its own row for direct table reads.
  'gpt-5.6': {
    input: 4,
    output: 20,
    cachedRead: 0.4,
    over272k: { input: 8, output: 30, cachedRead: 0.8 },
  },
  'gpt-5.6-terra': {
    input: 2,
    output: 12,
    cachedRead: 0.2,
    over272k: { input: 4, output: 18, cachedRead: 0.4 },
  },
  'gpt-5.6-luna': {
    input: 0.2,
    output: 1.2,
    cachedRead: 0.02,
    over272k: { input: 0.4, output: 1.8, cachedRead: 0.04 },
  },

  // ---- OpenAI (earlier GPT-5 family snapshots) ----
  'gpt-5.2': { input: 1.25, output: 10, cachedRead: 0.125 },
  'gpt-5.2-pro': { input: 15, output: 120, cachedRead: 1.5 },
  'gpt-5.2-codex': { input: 1.25, output: 10, cachedRead: 0.125 },
  'gpt-5.1': { input: 1.25, output: 10, cachedRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cachedRead: 0.125 },
  'gpt-5-pro': { input: 15, output: 120, cachedRead: 1.5 },
  'gpt-5-mini': { input: 0.25, output: 2, cachedRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cachedRead: 0.005 },
  'gpt-5.5': { input: 5, output: 30, cachedRead: 0.5 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.4': { input: 2.5, output: 15, cachedRead: 0.25 },
  'gpt-5.4-pro': { input: 30, output: 180 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cachedRead: 0.075 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cachedRead: 0.02 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cachedRead: 0.175 },
  'o4-mini': { input: 1.1, output: 4.4, cachedRead: 0.275 },

  // ---- Anthropic (Claude 5 + 4 families) ----
  // source: https://platform.claude.com/docs/en/about-claude/pricing (Claude API
  // reference). Standard pricing across the 1M context unless a row lists tiers.
  // Batch cards (2.3): the same reference (cached 2026-10-06) prices Message
  // Batches "at 50% of standard prices", "50% off every token in the request,
  // including cache reads and writes", and lists Claude Fable 5.1 at batch
  // $5/$25. Only the rows that reference lists carry one; Opus 4.5 and Sonnet
  // 4.5 are not in it, so their batch requests are unpriced. Not live-verified.
  // checkedAt 2026-10-06; cache reads at 5% of input.
  'claude-opus-5-5': {
    input: 4,
    output: 20,
    cachedRead: 0.2,
    cacheWrite: 5,
    cacheWrite1h: 8,
    batch: { input: 2, output: 10, cachedRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  },
  // checkedAt 2026-10-06.
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    cachedRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
    batch: { input: 1, output: 5, cachedRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  },
  // checkedAt 2026-10-06. Two cards by prompt length: up to 100K tokens, and above.
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cachedRead: 0.01,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2,
    tiers: [
      {
        above: 100_000,
        input: 0.5,
        output: 2.5,
        cachedRead: 0.05,
        cacheWrite: 0.625,
        cacheWrite1h: 1,
      },
    ],
    batch: {
      input: 0.05,
      output: 0.25,
      cachedRead: 0.005,
      cacheWrite: 0.0625,
      cacheWrite1h: 0.1,
      tiers: [
        {
          above: 100_000,
          input: 0.25,
          output: 1.25,
          cachedRead: 0.025,
          cacheWrite: 0.3125,
          cacheWrite1h: 0.5,
        },
      ],
    },
  },
  // checkedAt 2026-10-06 (unchanged since 2026-09-20); cache reads at 2.5% of input.
  'claude-fable-5-1': {
    input: 10,
    output: 50,
    cachedRead: 0.25,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
    batch: { input: 5, output: 25, cachedRead: 0.125, cacheWrite: 6.25, cacheWrite1h: 10 },
  },
  // checkedAt 2026-10-06 (unchanged since 2026-09-20).
  'claude-opus-5': {
    input: 5,
    output: 25,
    cachedRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
    batch: { input: 2.5, output: 12.5, cachedRead: 0.25, cacheWrite: 3.125, cacheWrite1h: 5 },
  },
  'claude-fable-5': {
    input: 10,
    output: 50,
    cachedRead: 1,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
    batch: { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  },
  // checkedAt 2026-10-06: the reference lists $2/$10. The earlier $3/$15 pin
  // assumed an intro price that the reference no longer shows.
  'claude-sonnet-5': {
    input: 2,
    output: 10,
    cachedRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
    batch: { input: 1, output: 5, cachedRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  },
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cachedRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
    batch: { input: 2.5, output: 12.5, cachedRead: 0.25, cacheWrite: 3.125, cacheWrite1h: 5 },
  },
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cachedRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
    batch: { input: 2.5, output: 12.5, cachedRead: 0.25, cacheWrite: 3.125, cacheWrite1h: 5 },
  },
  'claude-opus-4-6': {
    input: 5,
    output: 25,
    cachedRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
    batch: { input: 2.5, output: 12.5, cachedRead: 0.25, cacheWrite: 3.125, cacheWrite1h: 5 },
  },
  'claude-opus-4-5': { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cachedRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    batch: { input: 1.5, output: 7.5, cachedRead: 0.15, cacheWrite: 1.875, cacheWrite1h: 3 },
  },
  'claude-sonnet-4-5': { input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cachedRead: 0.1,
    cacheWrite: 1.25,
    cacheWrite1h: 2,
    batch: { input: 0.5, output: 2.5, cachedRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 },
  },

  // ---- Google Gemini (3.x / 2.5) ----
  'gemini-3.1-pro-preview': {
    input: 2,
    output: 12,
    cachedRead: 0.2,
    over200k: { input: 4, output: 18, cachedRead: 0.4 },
  },
  'gemini-3.1-pro': {
    input: 2,
    output: 12,
    cachedRead: 0.2,
    over200k: { input: 4, output: 18, cachedRead: 0.4 },
  },
  // gemini-3-pro was shut down 2026-03-09; the slug aliases gemini-3.1-pro-preview.
  'gemini-3-pro': { input: 2, output: 12, cachedRead: 0.2 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cachedRead: 0.15 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cachedRead: 0.025 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cachedRead: 0.125 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedRead: 0.03 },

  // ---- xAI Grok ----
  'grok-4.3': { input: 1.25, output: 2.5, cachedRead: 0.125 },
  'grok-4.2': { input: 3, output: 15, cachedRead: 0.75 },
  'grok-4.1': { input: 3, output: 15, cachedRead: 0.75 },
  'grok-4': { input: 3, output: 15, cachedRead: 0.75 },
  'grok-4-fast': { input: 0.2, output: 0.5, cachedRead: 0.05 },

  // ---- DeepSeek ----
  'deepseek-v3.2': { input: 0.28, output: 0.42, cachedRead: 0.028 },
  'deepseek-r1': { input: 0.55, output: 2.19, cachedRead: 0.14 },

  // ---- OpenAI-compatible hosts (providers-compat) ----
  // Mistral Large 3 list price (verified 2026-07); `mistral-large-latest` is an alias.
  'mistral-large': { input: 0.5, output: 1.5 },
  // Moonshot list prices (verified 2026-07). Each row prices its exact id only:
  // other K2 variants need a row or an alias of their own.
  'kimi-k2': { input: 0.6, output: 2.5, cachedRead: 0.15 },
  'kimi-k2.6': { input: 0.95, output: 4, cachedRead: 0.16 },

  // ---- Perplexity Sonar (2.0; approximate — verify at publish) ----
  // INCOMPLETE BY CONSTRUCTION: Perplexity also bills PER REQUEST for the
  // search itself (a few dollars per 1,000 requests, tiered by search mode).
  // That dimension has no token equivalent, so `priceUsage` returns the token
  // floor, never the invoice. Add the request fee in your own accounting.
  // `sonar-reasoning-pro` has no row of its own, so it is unpriced (it no longer
  // borrows the cheaper `sonar` row); pass a custom table if you bill on it.
  sonar: { input: 1, output: 1 },
  'sonar-pro': { input: 3, output: 15 },

  // ---- Cohere (OpenAI compatibility endpoint; approximate) ----
  'command-a-03-2025': { input: 2.5, output: 10 },

  // ---- Others on the Yunwu catalog ----
  'qwen3-max': { input: 1.2, output: 6 },
  'glm-4.6': { input: 0.6, output: 2.2 },
  'kimi-k2-thinking': { input: 0.6, output: 2.5 },
  'minimax-m2': { input: 0.3, output: 1.2 },

  // ---- Embeddings (input-only; output/cache fields ignored) ----
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'gemini-embedding-2': { input: 0.2, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
  'voyage-3.5': { input: 0.06, output: 0 },
  'voyage-3.5-lite': { input: 0.02, output: 0 },
};

/**
 * Explicit aliases: an id → the row that prices it. Lookup resolves an id by
 * exact row, then this table, then the same two after dropping one vendor
 * prefix (`google/…`, `Qwen/…`) and a trailing snapshot date. It never falls
 * back to a family prefix, so a new or invented id stays unpriced.
 */
export const PRICE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Mistral's moving alias for Mistral Large 3, the id the registry uses.
  'mistral-large-latest': 'mistral-large',
});

const VENDOR_PREFIX = /^[A-Za-z0-9][\w.-]*\//;
// -2025-12-11, -20251211 or -251211, with a real month and day.
const DATE_STAMP =
  /-(?:20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function lookup(
  table: PriceTable,
  model: string,
  aliases: Readonly<Record<string, string>>,
): ModelPrice | undefined {
  const find = (id: string): ModelPrice | undefined => {
    const target = own(aliases, id);
    return own(table, id) ?? (target === undefined ? undefined : own(table, target));
  };
  const bare = model.replace(VENDOR_PREFIX, '');
  return find(model) ?? find(bare) ?? find(bare.replace(DATE_STAMP, ''));
}

/**
 * The card that bills `options.tier` on a row (2.3): the row itself for the
 * standard tier, its `batch` card for the batch tier, nothing for a tier the
 * row has no rates for (or one this table does not know).
 */
function cardFor(
  price: ModelPrice | undefined,
  options: PriceUsageOptions | undefined,
): ModelPrice | undefined {
  const tier = options?.tier ?? 'standard';
  if (tier === 'standard') return price;
  return tier === 'batch' ? price?.batch : undefined;
}

const M = 1_000_000;

type TierRates = Omit<PriceTier, 'above'>;

/**
 * Select the full-request rates once for both cost and cache-savings
 * estimates: the applicable tier with the highest threshold, if any.
 */
function ratesForUsage(price: ModelPrice, usage: Usage): ModelPrice {
  const prompt =
    usage.inputTokens + usage.cachedReadTokens + usage.cacheWriteTokens + usage.cacheWrite1hTokens;
  const candidates: [above: number, measured: number, rates: TierRates | undefined][] = [
    // The legacy Gemini threshold keeps counting fresh and cached reads only.
    [200_000, usage.inputTokens + usage.cachedReadTokens, price.over200k],
    [272_000, prompt, price.over272k],
    ...(price.tiers ?? []).map((tier): [number, number, TierRates] => [tier.above, prompt, tier]),
  ];
  let selected: TierRates | undefined;
  let selectedAbove = -Infinity;
  for (const [above, measured, rates] of candidates) {
    if (rates && measured > above && above > selectedAbove) {
      selected = rates;
      selectedAbove = above;
    }
  }
  return selected ? { ...price, ...selected } : price;
}

/**
 * Compute the USD cost of one `Usage` for `model` from a price table.
 * Returns `undefined` when the model is unknown (so callers can fall back).
 * Every token bills once: `outputTokens` (reasoning included) at the output
 * rate, the cache buckets at their dedicated rate or a sensible multiple of
 * `input`. `reasoningTokens` and `audioTokens` are shares of those buckets,
 * not extra tokens; a row's `audio` rate re-prices the audio share only.
 * `options.tier` (2.3) picks the rates: `'batch'` prices the row's `batch`
 * card and returns `undefined` for a row without one.
 */
export function priceUsage(
  model: string,
  usage: Usage,
  table: PriceTable = PRICES_2026,
  options?: PriceUsageOptions,
): number | undefined {
  const p = cardFor(lookup(table, model, PRICE_ALIASES), options);
  return p && costOf(p, usage);
}

function costOf(p: ModelPrice, usage: Usage): number {
  const rates = ratesForUsage(p, usage);

  const cachedRead = rates.cachedRead ?? rates.input * 0.1;
  const cacheWrite = rates.cacheWrite ?? rates.input * 1.25;
  const cacheWrite1h = rates.cacheWrite1h ?? rates.input * 2;
  // A subset never exceeds its superset: usage built the 2.2 way, with reasoning
  // counted beside the output, shows up like this and still bills in full.
  const output =
    usage.reasoningTokens > usage.outputTokens
      ? usage.outputTokens + usage.reasoningTokens
      : usage.outputTokens;
  const audioPremium =
    rates.audio === undefined ? 0 : (usage.audioTokens ?? 0) * (rates.audio - rates.input);

  const cost =
    (usage.inputTokens * rates.input +
      output * rates.output +
      usage.cachedReadTokens * cachedRead +
      usage.cacheWriteTokens * cacheWrite +
      usage.cacheWrite1hTokens * cacheWrite1h +
      audioPremium) /
    M;

  // Avoid -0 and float dust; round to micro-dollars.
  return Math.max(0, Math.round(cost * 1e6) / 1e6);
}

/**
 * USD SAVED by prompt-cache reads (1.7): what the `cachedReadTokens` would
 * have cost at the full input rate minus what they actually cost at the
 * cached-read rate. Cache WRITES are the investment side and are not netted
 * here. Returns `undefined` for unknown models, `0` when nothing was cached.
 * `options.tier` (2.3) picks the rates, as for {@link priceUsage}.
 */
export function cacheSavings(
  model: string,
  usage: Usage,
  table: PriceTable = PRICES_2026,
  options?: PriceUsageOptions,
): number | undefined {
  const p = cardFor(lookup(table, model, PRICE_ALIASES), options);
  return p && savingsOf(p, usage);
}

function savingsOf(p: ModelPrice, usage: Usage): number {
  if (usage.cachedReadTokens <= 0) return 0;
  const rates = ratesForUsage(p, usage);
  const cachedRead = rates.cachedRead ?? rates.input * 0.1;
  const saved = (usage.cachedReadTokens * (rates.input - cachedRead)) / M;
  return Math.max(0, Math.round(saved * 1e6) / 1e6);
}

export interface CreatePriceProviderOptions {
  /** Override / extend the built-in 2026 table (merged shallow per-model). */
  table?: PriceTable;
  /** Multiply every computed cost (e.g. 1.3 for a 30% margin). Default 1. */
  margin?: number;
  /**
   * More explicit aliases (your id → a row id), merged over `PRICE_ALIASES`:
   * deployment names, gateway ids or snapshots the bundled table does not list.
   * An alias resolves only when its target row exists in the merged table.
   */
  aliases?: Record<string, string>;
}

/**
 * Build a `PriceProvider` to inject via `deps.priceProvider`. The 2026 table is
 * the default; pass `{ table }` to override prices, `{ aliases }` to map your
 * own ids onto rows and `{ margin }` to apply a markup. Unknown models yield
 * `undefined` (never a wrong charge). Implements the optional `cacheSavings`
 * seam, so the live `cost` stream part carries `cacheSavingsUsd` out of the box.
 * Both honour the service tier (2.3): `{ tier: 'batch' }` reads a row's `batch`
 * card, and a row your `table` replaces keeps only the cards you give it.
 */
export function createPriceProvider(options: CreatePriceProviderOptions = {}): PriceProvider {
  const table = options.table ? { ...PRICES_2026, ...options.table } : PRICES_2026;
  const aliases = options.aliases ? { ...PRICE_ALIASES, ...options.aliases } : PRICE_ALIASES;
  const margin = options.margin ?? 1;
  return {
    priceUsage(model: string, usage: Usage, priceOptions?: PriceUsageOptions) {
      const p = cardFor(lookup(table, model, aliases), priceOptions);
      return p && Math.round(costOf(p, usage) * margin * 1e6) / 1e6;
    },
    cacheSavings(model: string, usage: Usage, priceOptions?: PriceUsageOptions) {
      const p = cardFor(lookup(table, model, aliases), priceOptions);
      return p && Math.round(savingsOf(p, usage) * margin * 1e6) / 1e6;
    },
  };
}
