/**
 * deuz meter (2.5): the default, deliberately conservative estimate a request
 * is admitted with before its usage is known. Edge-safe.
 *
 * Tokens: the body's characters divided by `charsPerToken` (default 3, below
 * the 3.5-4 that English and code average), plus the request's output cap or
 * `defaultMaxOutputTokens`, times the Chat Completions `n`. A base64 run of
 * 1 024 characters or more (an inline image or document) counts one token per
 * 32 characters instead.
 * USD: those tokens priced by the price provider, the prompt at the model's
 * dearest prompt rate unless `promptRate: 'input'`.
 */
import type { PriceProvider } from '../types/deps';
import type { Usage } from '../types/usage';
import type { MeterEstimate, MeterEstimateOptions } from './types';
import { MeterError } from './errors';

/** Default body characters per prompt token. */
export const DEFAULT_METER_CHARS_PER_TOKEN = 3;
/** Default output cap assumed for a request that sets none. */
export const DEFAULT_METER_MAX_OUTPUT_TOKENS = 32_000;

const BASE64_RUN = /[A-Za-z0-9+/=]{1024,}/g;
const BASE64_CHARS_PER_TOKEN = 32;

/** The default estimator's prompt tokens for a request body (see the module notes). */
export function estimatePromptTokens(body: string, charsPerToken: number): number {
  let blobTokens = 0;
  let blobChars = 0;
  for (const match of body.matchAll(BASE64_RUN)) {
    blobChars += match[0].length;
    blobTokens += Math.ceil(match[0].length / BASE64_CHARS_PER_TOKEN);
  }
  return Math.ceil((body.length - blobChars) / charsPerToken) + blobTokens;
}

const usageOf = (fields: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
  ...fields,
});

/** @internal The default estimate of one request. */
export async function defaultMeterEstimate(input: {
  body: string;
  model: string;
  maxOutputTokens: number | undefined;
  /** Completions generated, each up to the output cap (Chat Completions `n`); default 1. */
  choices?: number;
  options: MeterEstimateOptions;
  priceProvider: PriceProvider;
}): Promise<MeterEstimate> {
  const charsPerToken = input.options.charsPerToken ?? DEFAULT_METER_CHARS_PER_TOKEN;
  const prompt = estimatePromptTokens(input.body, charsPerToken);
  const output =
    (input.maxOutputTokens ??
      input.options.defaultMaxOutputTokens ??
      DEFAULT_METER_MAX_OUTPUT_TOKENS) * (input.choices ?? 1);
  const tokens = prompt + output;
  const plain = await input.priceProvider.priceUsage(
    input.model,
    usageOf({ inputTokens: prompt, outputTokens: output, totalTokens: tokens }),
  );
  if (plain === undefined || (input.options.promptRate ?? 'max') === 'input')
    return { tokens, usd: plain };
  // The dearest prompt bucket: a 1-hour cache write bills above every other.
  const written = await input.priceProvider.priceUsage(
    input.model,
    usageOf({ cacheWrite1hTokens: prompt, outputTokens: output, totalTokens: tokens }),
  );
  return { tokens, usd: Math.max(plain, written ?? plain) };
}

/** @internal Validate estimate options; throws a `MeterError` naming the field. */
export function assertEstimateOptions(options: MeterEstimateOptions): void {
  const { charsPerToken, defaultMaxOutputTokens, promptRate } = options;
  if (
    charsPerToken !== undefined &&
    (typeof charsPerToken !== 'number' || !Number.isFinite(charsPerToken) || charsPerToken <= 0)
  )
    throw new MeterError('invalid_options', 'estimate.charsPerToken must be a positive number.');
  if (
    defaultMaxOutputTokens !== undefined &&
    (!Number.isSafeInteger(defaultMaxOutputTokens) || defaultMaxOutputTokens < 0)
  )
    throw new MeterError(
      'invalid_options',
      'estimate.defaultMaxOutputTokens must be a nonnegative integer.',
    );
  if (promptRate !== undefined && promptRate !== 'max' && promptRate !== 'input')
    throw new MeterError('invalid_options', "estimate.promptRate must be 'max' or 'input'.");
}
