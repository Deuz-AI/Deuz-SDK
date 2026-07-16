import type { Usage } from '../types/usage';
import type { UsageMeta, FinishMeta, ResolvedDependencies } from '../types/deps';
import type { CommonCallOptions } from '../types/config';

/** A zero-token canonical Usage (used as the baseline / abort fallback). */
export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
};

/** Fill in `totalTokens` if an adapter left it at 0. */
export function withTotal(usage: Usage): Usage {
  if (usage.totalTokens > 0) return usage;
  return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
}

/**
 * Normalize embedding usage (Faz 3) onto the canonical `Usage`. Embeddings have
 * only input tokens — no output/reasoning/cache. `tokens` may be undefined when
 * a provider omits usage (Gemini AI-Studio embeddings) → treated as 0 so
 * `priceProvider` still receives a well-formed Usage.
 */
export function embeddingUsage(tokens: number | undefined): Usage {
  const t = tokens ?? 0;
  return {
    inputTokens: t,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: t,
  };
}

/**
 * Fire the usage callback exactly ONCE (G10): a call-level `options.onUsage`
 * overrides a `deps.onUsage` — never both, so the credit system is never
 * double-charged.
 */
export function fireUsage(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  usage: Usage,
  meta: UsageMeta,
): void {
  const cb = options.onUsage ?? deps.onUsage;
  cb?.(usage, meta);
}

/** Fire the finish callback exactly once (same precedence as `fireUsage`). */
export function fireFinish(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  meta: FinishMeta,
): void {
  const cb = options.onFinish ?? deps.onFinish;
  cb?.(meta);
}
