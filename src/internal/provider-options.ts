import type { CommonCallOptions } from '../types/config';

/**
 * Apply the per-provider escape hatch: shallow-merge `providerOptions[provider]`
 * into the wire body, WITHOUT overriding fields the adapter already set —
 * canonical fields always win. Top-level keys only (nested objects like
 * Gemini's `generationConfig` are replaced wholesale if the adapter left the
 * key unset; they are never deep-merged).
 */
export function applyProviderOptions(
  body: Record<string, unknown>,
  provider: string,
  options: CommonCallOptions,
): void {
  const po = options.providerOptions?.[provider];
  if (!po) return;
  for (const [key, value] of Object.entries(po)) {
    if (!(key in body)) body[key] = value;
  }
}
