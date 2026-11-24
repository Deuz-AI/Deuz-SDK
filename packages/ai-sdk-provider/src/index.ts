/**
 * @deuz-sdk/ai-sdk-provider — Deuz budgets, fail-over and circuit breaker for
 * Vercel AI SDK models. Wrap any AI SDK 7 `LanguageModelV4` in one line and
 * every call is reserved against a persistent Deuz budget, priced by Deuz's
 * price table and settled with the usage the provider reports.
 */
export { deuz, defaultShouldFallback } from './model';
export type { DeuzFallback, DeuzLanguageModel, DeuzModelOptions } from './model';
export { deuzMiddleware } from './middleware';
export type { DeuzMiddleware } from './middleware';
export {
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_OUTPUT_TOKENS,
  isProviderFailure,
} from './guard';
export type {
  DeuzBreakerOptions,
  DeuzBudgetOptions,
  DeuzCostReceipt,
  DeuzEstimateOptions,
  DeuzOptions,
} from './guard';
export { DeuzBudgetError, DeuzUnsupportedModelError } from './errors';
export type { DeuzBudgetErrorCode } from './errors';
export { defaultPriceKey, estimatePromptTokens, toDeuzUsage } from './spec';
export type { DeuzModelRef } from './spec';
