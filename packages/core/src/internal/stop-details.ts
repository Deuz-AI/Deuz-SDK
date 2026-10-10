import type { StopDetails } from '../types/methods';

/**
 * Read the provider's stop explanation off a finish part's `providerMetadata`
 * (2.3). Anthropic sends `stop_details` with a refusal; other providers send
 * nothing comparable today, so this returns `undefined` for them. The one
 * normalization every result shares: `streamChat` / `generateObject` /
 * `streamObject` (core/inference.ts) and the loops (inference/run-step.ts).
 */
export function stopDetailsFrom(
  providerMetadata: Record<string, unknown> | undefined,
): StopDetails | undefined {
  const anthropic = providerMetadata?.anthropic;
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
