import type { ModelCapabilities } from '../core/registry';
import {
  anthropicMaxTokens,
  effortWire,
  optionalOutputCap,
  planEffort,
} from '../core/request-rules';
import type { CommonCallOptions } from '../types/config';
import type { ModelSurface } from '../types/model';

/**
 * The output cap a wire puts on the request (2.3, F12): the most output a
 * provider can bill for one attempt, reasoning included. Native admission
 * reserves the price of this many output tokens, so a reservation can no
 * longer be smaller than what the provider is allowed to charge.
 *
 * It calls the same rules the adapters build the request with
 * (`core/request-rules.ts`), and `test/output-cap.test.ts` compares it with
 * every adapter's `buildRequest`:
 * - OpenAI Responses, Chat Completions and Gemini send `maxOutputTokens`, else
 *   the row's `maxOutput`, and nothing for a placeholder row;
 * - Anthropic always sends a cap, raised to `budget_tokens + 1024` while
 *   extended thinking runs on the `budget_tokens` wire (even over an explicit
 *   cap).
 *
 * `undefined` means the wire sends no cap; the caller then has no provider
 * bound to reserve against.
 */
export function wireOutputCap(
  surface: ModelSurface,
  caps: ModelCapabilities,
  options: Pick<CommonCallOptions, 'maxOutputTokens' | 'effort'>,
  modelId = '',
): number | undefined {
  if (surface !== 'anthropic') return optionalOutputCap(caps, options);
  // No warnings sink and no logger: the adapter reports the same plan when it
  // builds the request.
  const plan = planEffort(
    { call: { provider: 'anthropic', modelId }, caps, options },
    effortWire('anthropic', caps, modelId),
  );
  return anthropicMaxTokens(caps, options.maxOutputTokens, plan.budget);
}
