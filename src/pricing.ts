/**
 * pricing.ts — optional USD cost estimation (Faz 1.D seam, filled in Faz 5).
 *
 * The core's GOLDEN RULE is that it only ever returns a token *breakdown*
 * (`Usage`); turning tokens into dollars is an app concern (margins, currency,
 * contracts differ per deployment). This module is therefore OPTIONAL: it ships
 * a pinned 2026 price table + a `PriceProvider` factory you can inject via
 * `deps.priceProvider`, but core never imports it and never bills automatically.
 *
 * Prices are USD per 1,000,000 tokens, sourced from public list prices
 * (verified 2026-07-02).
 * They WILL drift — verify against the provider's pricing page before you bill,
 * or pass your own table to `createPriceProvider(customTable)`.
 *
 *   import { createPriceProvider } from '@deuz-sdk/core/pricing';
 *   const deuz = createClient({ deps: { priceProvider: createPriceProvider() } });
 *   // …or price a single Usage directly:
 *   const usd = priceUsage('gpt-5.2', usage);
 */
import type { Usage } from './types/usage';
import type { PriceProvider } from './types/deps';

/** USD per 1,000,000 tokens for one model. Omitted fields fall back sensibly. */
export interface ModelPrice {
  /** Fresh (uncached) input tokens. */
  input: number;
  /** Output tokens (reasoning tokens are billed at the output rate). */
  output: number;
  /** Cached-read input tokens. Default: 10% of `input` (Anthropic/OpenAI norm). */
  cachedRead?: number;
  /** 5-minute cache-write tokens (Anthropic). Default: 1.25 × `input`. */
  cacheWrite?: number;
  /** 1-hour cache-write tokens (Anthropic). Default: 2 × `input`. */
  cacheWrite1h?: number;
  /** Audio input/output tokens, when billed separately. Default: `input`. */
  audio?: number;
  /** Long-context tier applied when `inputTokens + cachedReadTokens > 200_000` (Gemini Pro). */
  over200k?: { input: number; output: number; cachedRead?: number };
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Pinned 2026 list prices (USD / 1M tokens). NOT authoritative — list prices
 * change often and enterprise/Vertex/Bedrock rates differ. Treat as a starting
 * point; override per deployment.
 */
export const PRICES_2026: PriceTable = {
  // ---- OpenAI (GPT-5 family) ----
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
  'claude-fable-5': { input: 10, output: 50, cachedRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31; standard rates are
  // pinned so we never undercharge — nothing to flip on Sept 1.
  'claude-sonnet-5': { input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-opus-4-8': { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-5': { input: 5, output: 25, cachedRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4-5': { input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cachedRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },

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
  // mistral-large-latest → Mistral Large 3 list price (verified 2026-07).
  'mistral-large': { input: 0.5, output: 1.5 },
  // Moonshot list prices (verified 2026-07). kimi-k2 covers the legacy K2 family;
  // kimi-k2.6 is pinned explicitly so the prefix lookup can't undercharge it.
  'kimi-k2': { input: 0.6, output: 2.5, cachedRead: 0.15 },
  'kimi-k2.6': { input: 0.95, output: 4, cachedRead: 0.16 },

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

/** Tolerant lookup: exact slug, then a date-stamp / `-all` / region-suffix strip. */
function lookup(table: PriceTable, model: string): ModelPrice | undefined {
  if (table[model]) return table[model];
  // strip a trailing date stamp (gpt-5.2-2025-12-11 → gpt-5.2) or vendor prefix (google/…)
  const stripped = model
    .replace(/^[a-z-]+\//, '') // "google/gemini-2.5-flash" → "gemini-2.5-flash"
    .replace(/-\d{4}-\d{2}-\d{2}$/, '') // ISO date stamp
    .replace(/-\d{6,8}$/, '') // compact date stamp (…-250828)
    .replace(/-(all|latest|fast|preview|exp)$/, '');
  if (stripped !== model && table[stripped]) return table[stripped];
  // last resort: longest known prefix match (gpt-5.2-chat → gpt-5.2)
  let best: ModelPrice | undefined;
  let bestLen = 0;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = table[key];
      bestLen = key.length;
    }
  }
  return best;
}

const M = 1_000_000;

/**
 * Compute the USD cost of one `Usage` for `model` from a price table.
 * Returns `undefined` when the model is unknown (so callers can fall back).
 * Reasoning tokens bill at the output rate; cached-read/cache-write/audio use
 * their dedicated rate or a sensible multiple of `input`.
 */
export function priceUsage(
  model: string,
  usage: Usage,
  table: PriceTable = PRICES_2026,
): number | undefined {
  const p = lookup(table, model);
  if (!p) return undefined;

  // Long-context tier (Gemini Pro): different rates past 200k prompt tokens.
  const longContext = p.over200k && usage.inputTokens + usage.cachedReadTokens > 200_000;
  const rates = longContext ? { ...p, ...p.over200k } : p;

  const cachedRead = rates.cachedRead ?? rates.input * 0.1;
  const cacheWrite = rates.cacheWrite ?? rates.input * 1.25;
  const cacheWrite1h = rates.cacheWrite1h ?? rates.input * 2;
  const audioRate = rates.audio ?? rates.input;

  const cost =
    (usage.inputTokens * rates.input +
      (usage.outputTokens + usage.reasoningTokens) * rates.output +
      usage.cachedReadTokens * cachedRead +
      usage.cacheWriteTokens * cacheWrite +
      usage.cacheWrite1hTokens * cacheWrite1h +
      (usage.audioTokens ?? 0) * audioRate) /
    M;

  // Avoid -0 and float dust; round to micro-dollars.
  return Math.max(0, Math.round(cost * 1e6) / 1e6);
}

export interface CreatePriceProviderOptions {
  /** Override / extend the built-in 2026 table (merged shallow per-model). */
  table?: PriceTable;
  /** Multiply every computed cost (e.g. 1.3 for a 30% margin). Default 1. */
  margin?: number;
}

/**
 * Build a `PriceProvider` to inject via `deps.priceProvider`. The 2026 table is
 * the default; pass `{ table }` to override prices and `{ margin }` to apply a
 * markup. Unknown models yield `undefined` (never a wrong charge).
 */
export function createPriceProvider(options: CreatePriceProviderOptions = {}): PriceProvider {
  const table = options.table ? { ...PRICES_2026, ...options.table } : PRICES_2026;
  const margin = options.margin ?? 1;
  return {
    priceUsage(model: string, usage: Usage): number | undefined {
      const base = priceUsage(model, usage, table);
      return base === undefined ? undefined : Math.round(base * margin * 1e6) / 1e6;
    },
  };
}
