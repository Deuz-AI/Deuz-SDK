/**
 * Rich canonical token usage. The full shape is locked now — adding a field
 * later is breaking, and the credit system needs the cache/reasoning breakdown
 * to compute correct cost (cache_read ~10% price, 1h cache write 2x,
 * reasoning tokens billed as output but invisible in text).
 *
 * Every adapter normalizes to one contract (2.3): the input buckets
 * (`inputTokens`, `cachedReadTokens`, `cacheWriteTokens`, `cacheWrite1hTokens`)
 * are disjoint, `outputTokens` holds every generated token, and
 * `reasoningTokens` / `audioTokens` are shares of those buckets. Pricing each
 * bucket once therefore bills each token once.
 */
export interface Usage {
  /** Prompt tokens billed at the full input rate. Excludes cache reads and cache writes. */
  inputTokens: number;
  /**
   * Every generated token, reasoning included. All adapters normalize to this
   * (2.3), so price `outputTokens` once at the output rate.
   */
  outputTokens: number;
  /** The reasoning share of `outputTokens` (a subset, never added on top). */
  reasoningTokens: number;
  /** Prompt tokens served from the provider's cache. */
  cachedReadTokens: number;
  /** Prompt tokens written to the cache (5-minute TTL for Anthropic). */
  cacheWriteTokens: number;
  /** Prompt tokens written to the 1-hour cache (Anthropic). */
  cacheWrite1hTokens: number;
  /** The audio share of the prompt and output buckets (a subset, never added on top). */
  audioTokens?: number;
  /** Provider-executed tool invocations this turn (e.g. web searches) — billed per call, not tokens. */
  serverToolUses?: number;
  /** The provider's reported total when it sends one; otherwise the sum of the buckets above. */
  totalTokens: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'aborted';
