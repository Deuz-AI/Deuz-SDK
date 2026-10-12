import type { StopDetails } from '../types/methods';

/**
 * Read the provider's stop explanation off a finish part's `providerMetadata`
 * (2.3). Anthropic sends `stop_details` with a refusal. An OpenAI refusal is
 * the model's own refusal text, which both OpenAI wires and the batch parser
 * keep as `openai.refusal` (2.3, K4): it becomes `{ type: 'refusal',
 * explanation }`, without a category, since OpenAI sends none. Other
 * providers send nothing comparable today, so this returns `undefined` for
 * them. The one normalization every result shares: `streamChat` /
 * `generateObject` / `streamObject` (core/inference.ts), the loops
 * (inference/run-step.ts) and batch results (batch/parse.ts).
 */
export function stopDetailsFrom(
  providerMetadata: Record<string, unknown> | undefined,
): StopDetails | undefined {
  return (
    anthropicStopDetails(providerMetadata?.anthropic) ?? openaiRefusal(providerMetadata?.openai)
  );
}

function anthropicStopDetails(anthropic: unknown): StopDetails | undefined {
  const raw =
    anthropic && typeof anthropic === 'object'
      ? (anthropic as { stop_details?: unknown }).stop_details
      : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const { type, category, explanation } = raw as Record<string, unknown>;
  if (typeof type !== 'string') return undefined;
  return {
    type,
    ...(typeof category === 'string' || category === null ? { category } : {}),
    ...(typeof explanation === 'string' || explanation === null ? { explanation } : {}),
  };
}

function openaiRefusal(openai: unknown): StopDetails | undefined {
  const refusal =
    openai && typeof openai === 'object' ? (openai as { refusal?: unknown }).refusal : undefined;
  return typeof refusal === 'string' && refusal !== ''
    ? { type: 'refusal', explanation: refusal }
    : undefined;
}
