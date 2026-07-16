import type { StopCondition } from '../types/tool';

/**
 * Metadata carried on built-in conditions: `conditionName` feeds the
 * `providerMetadata.deuz.stoppedBy` marker; `requiresCost` makes the loop
 * compute `costUSD` (and warn when no `priceProvider` is injected).
 */
export interface NamedStopCondition {
  conditionName?: string;
  requiresCost?: boolean;
  /** Set on the loop's own `maxSteps` bound — never reported as `stoppedBy`. */
  implicitMaxSteps?: boolean;
}

function named(name: string, fn: StopCondition, extra?: NamedStopCondition): StopCondition {
  return Object.assign(fn, { conditionName: name, ...extra });
}

/** Stop once the loop has run `n` model steps. */
export const stepCountIs = (n: number): StopCondition =>
  named('stepCountIs', ({ stepCount }) => stepCount >= n);

/** Stop once the latest step called a tool named `name`. */
export const hasToolCall = (name: string): StopCondition =>
  named(
    'hasToolCall',
    ({ steps }) => steps.at(-1)?.toolCalls.some((c) => c.toolName === name) ?? false,
  );

/**
 * Stop once cumulative REAL token usage (all steps, sub-agents included)
 * reaches `n`. Reads provider-reported usage — no estimation involved.
 */
export const totalTokensExceed = (n: number): StopCondition =>
  named('totalTokensExceed', ({ usage }) => (usage?.totalTokens ?? 0) >= n);

/**
 * Stop once cumulative cost reaches `usd`. Requires `deps.priceProvider`;
 * without one the loop warns once and the condition never fires.
 */
export const costExceeds = (usd: number): StopCondition =>
  named('costExceeds', ({ costUSD }) => costUSD !== undefined && costUSD >= usd, {
    requiresCost: true,
  });

/**
 * Stop once the loop has been running for at least `ms` milliseconds. Time
 * comes from the injected `deps.clock` (deterministic in tests). Evaluated at
 * step boundaries only — an in-flight model step always finishes first.
 */
export const durationExceeds = (ms: number): StopCondition =>
  named('durationExceeds', ({ elapsedMs }) => (elapsedMs ?? 0) >= ms);
