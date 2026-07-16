/**
 * Rich canonical token usage. The full shape is locked now — adding a field
 * later is breaking, and the credit system needs the cache/reasoning breakdown
 * to compute correct cost (cache_read ~10% price, 1h cache write 2x,
 * reasoning tokens billed as output but invisible in text).
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
