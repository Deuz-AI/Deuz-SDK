/**
 * realtime/usage.ts — realtime token accounting and pricing.
 *
 * Realtime providers bill audio at several times the text rate and price
 * input and output audio differently, so one aggregate `Usage` cannot be
 * priced correctly. Usage is therefore kept per modality and priced through
 * the public `PriceProvider` seam once per modality, under three keys:
 *
 *   text tokens   → `<model>`          e.g. 'gpt-realtime'
 *   audio tokens  → `audio:<model>`    e.g. 'audio:gpt-realtime'
 *   image tokens  → `image:<model>`    (image and video frames)
 *
 * Each call gets a plain `Usage` with only input / cached-read / output
 * filled — no `audioTokens`, no `reasoningTokens` — so the price is the same
 * under every reading of those two fields. `realtimePriceTable` builds the
 * three rows from one per-model entry for `createPriceProvider({ table })`.
 *
 * No realtime prices ship with Deuz: they could not be verified offline.
 */
import type { PriceTable } from '../pricing';
import type { PriceProvider } from '../types/deps';
import type { Usage } from '../types/usage';
import { isPromiseLike } from './encoding';
import type { DecodedUsage } from './protocol';
import type { RealtimeModalityTokens, RealtimeModelPrice, RealtimeTokenBreakdown } from './types';

export const AUDIO_PRICE_PREFIX = 'audio:';
export const IMAGE_PRICE_PREFIX = 'image:';

/**
 * Expand per-modality realtime prices into the flat `PriceTable` that
 * `createPriceProvider({ table })` takes: text under the model id, audio
 * under `audio:<model>`, image under `image:<model>`.
 *
 * ```ts
 * const priceProvider = createPriceProvider({
 *   table: realtimePriceTable({
 *     'gpt-realtime': { text: { input: 4, output: 16, cachedRead: 0.4 }, audio: { input: 32, output: 64, cachedRead: 0.4 } },
 *   }),
 * });
 * ```
 */
export function realtimePriceTable(prices: Record<string, RealtimeModelPrice>): PriceTable {
  const table: PriceTable = {};
  for (const [model, price] of Object.entries(prices)) {
    table[model] = price.text;
    table[`${AUDIO_PRICE_PREFIX}${model}`] = price.audio;
    if (price.image) table[`${IMAGE_PRICE_PREFIX}${model}`] = price.image;
  }
  return table;
}

const zero = (): RealtimeModalityTokens => ({ input: 0, cachedInput: 0, output: 0 });

export function emptyTokens(): RealtimeTokenBreakdown {
  return { text: zero(), audio: zero(), image: zero() };
}

const addModality = (
  a: RealtimeModalityTokens,
  b: RealtimeModalityTokens,
): RealtimeModalityTokens => ({
  input: a.input + b.input,
  cachedInput: a.cachedInput + b.cachedInput,
  output: a.output + b.output,
});

export function addTokens(
  a: RealtimeTokenBreakdown,
  b: RealtimeTokenBreakdown,
): RealtimeTokenBreakdown {
  return {
    text: addModality(a.text, b.text),
    audio: addModality(a.audio, b.audio),
    image: addModality(a.image, b.image),
  };
}

const sumOf = (t: RealtimeModalityTokens): number => t.input + t.cachedInput + t.output;

/**
 * The canonical core `Usage` of one response: every modality summed.
 * `inputTokens` excludes cached reads, `outputTokens` includes reasoning, and
 * `audioTokens` is the audio share of input + cached + output (a subset).
 */
export function toUsage(decoded: DecodedUsage): Usage {
  const { text, audio, image } = decoded.tokens;
  const inputTokens = text.input + audio.input + image.input;
  const cachedReadTokens = text.cachedInput + audio.cachedInput + image.cachedInput;
  const outputTokens = text.output + audio.output + image.output;
  const usage: Usage = {
    inputTokens,
    outputTokens,
    reasoningTokens: decoded.reasoningTokens ?? 0,
    cachedReadTokens,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: decoded.totalTokens ?? inputTokens + cachedReadTokens + outputTokens,
  };
  const audioTokens = sumOf(audio);
  if (audioTokens > 0) usage.audioTokens = audioTokens;
  return usage;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const usage: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  const audio = (a.audioTokens ?? 0) + (b.audioTokens ?? 0);
  if (audio > 0) usage.audioTokens = audio;
  return usage;
}

/** USD rounded to micro-dollars, as `priceUsage` does. */
export const roundUsd = (usd: number): number => Math.max(0, Math.round(usd * 1e6) / 1e6);

/** One modality as a plain `Usage` for `PriceProvider.priceUsage`. */
function modalityUsage(tokens: RealtimeModalityTokens): Usage {
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: 0,
    cachedReadTokens: tokens.cachedInput,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: sumOf(tokens),
  };
}

type Price = number | undefined | PromiseLike<number | undefined>;

/** A throwing or rejecting price provider reads as "no price", never as a crashed session. */
function safePrice(provider: PriceProvider, key: string, usage: Usage): Price {
  try {
    const price = provider.priceUsage(key, usage);
    return isPromiseLike<number | undefined>(price)
      ? Promise.resolve(price).then(
          (value) => value,
          () => undefined,
        )
      : price;
  } catch {
    return undefined;
  }
}

function total(prices: (number | undefined)[]): number | undefined {
  let sum = 0;
  for (const price of prices) {
    if (typeof price !== 'number' || !Number.isFinite(price)) return undefined;
    sum += price;
  }
  return roundUsd(sum);
}

/**
 * Price a response's tokens, one `priceUsage` call per modality that has any.
 * `undefined` when any of them has no price (the whole response is then
 * unpriced, never partially charged). Async only if the provider is.
 */
export function priceTokens(
  provider: PriceProvider,
  modelId: string,
  tokens: RealtimeTokenBreakdown,
): Price {
  const parts: Price[] = [];
  if (sumOf(tokens.text) > 0) parts.push(safePrice(provider, modelId, modalityUsage(tokens.text)));
  if (sumOf(tokens.audio) > 0) {
    parts.push(safePrice(provider, `${AUDIO_PRICE_PREFIX}${modelId}`, modalityUsage(tokens.audio)));
  }
  if (sumOf(tokens.image) > 0) {
    parts.push(safePrice(provider, `${IMAGE_PRICE_PREFIX}${modelId}`, modalityUsage(tokens.image)));
  }
  if (parts.some((part) => isPromiseLike(part))) return Promise.all(parts).then(total);
  return total(parts as (number | undefined)[]);
}
