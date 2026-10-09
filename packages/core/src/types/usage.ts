/**
 * Rich canonical token usage. The full shape is locked now — adding a field
 * later is breaking, and the credit system needs the cache/reasoning breakdown
 * to compute correct cost (cache_read ~10% price, 1h cache write 2x,
 * reasoning tokens billed as output but invisible in text).
 */
export interface Usage {
  /** Prompt tokens billed at the full input rate. Excludes `cachedReadTokens`. */
  inputTokens: number;
  /**
   * Every generated token, reasoning included. All adapters normalize to this
   * (2.3), so price `outputTokens` once at the output rate.
   */
  outputTokens: number;
  /** The reasoning share of `outputTokens` (a subset, never added on top). */
  reasoningTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  audioTokens?: number;
  /** Provider-executed tool invocations this turn (e.g. web searches) — billed per call, not tokens. */
  serverToolUses?: number;
  totalTokens: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'aborted';
