import type { ModelCapabilities } from '../core/registry';
import type { CommonCallOptions } from '../types/config';
import type { ModelSurface } from '../types/model';

/** `thinking.budget_tokens` per effort, exactly as `adapters/anthropic.ts` sends it. */
const ANTHROPIC_THINKING_BUDGET = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
  xhigh: 48_000,
  max: 48_000,
} as const;

/**
 * The output cap a wire puts on the request (2.3, F12): the most output a
 * provider can bill for one attempt, reasoning included. Native admission
 * reserves the price of this many output tokens, so a reservation can no
 * longer be smaller than what the provider is allowed to charge.
 *
 * It mirrors the adapters' request building — `test/output-cap.test.ts`
 * compares it with every adapter's `buildRequest`, so the two cannot drift:
 * - OpenAI Responses, Chat Completions and Gemini send `maxOutputTokens`, else
 *   the row's `maxOutput`;
 * - Anthropic sends the same, raised to `budget_tokens + 1024` while extended
 *   thinking runs on the `budget_tokens` wire (even over an explicit cap).
 *
 * `undefined` means the wire sends no cap; the caller then has no provider
 * bound to reserve against.
 */
export function wireOutputCap(
  surface: ModelSurface,
  caps: Pick<ModelCapabilities, 'maxOutput' | 'reasoning' | 'effortWire'>,
  options: Pick<CommonCallOptions, 'maxOutputTokens' | 'effort'>,
): number | undefined {
  const cap = options.maxOutputTokens ?? caps.maxOutput;
  const effort = options.effort;
  if (
    surface !== 'anthropic' ||
    !caps.reasoning ||
    effort === undefined ||
    effort === 'none' ||
    caps.effortWire === 'output_config'
  )
    return cap;
  return Math.max(cap, ANTHROPIC_THINKING_BUDGET[effort] + 1_024);
}
