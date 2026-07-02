/**
 * `@deuz-sdk/core` — pure, web-first, multi-provider AI SDK.
 * Public surface lock (1.0). Faz 0: types are final, methods are stubs that
 * throw NotImplementedError until Faz 1.
 */

// Canonical free functions.
export { streamChat, generateText, generateObject } from './generate';
export { embed, embedMany } from './inference/embed';

// Optional convenience client + dependency resolution.
export { createClient, resolveDependencies } from './client';
export type { DeuzClient } from './client';

// Error taxonomy (base + full Faz 1.A hierarchy).
export {
  DeuzError,
  NotImplementedError,
  APICallError,
  RateLimitError,
  OverloadedError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  ContextOverflowError,
  TimeoutError,
  AbortError,
  NoObjectGeneratedError,
  ToolExecutionError,
  UnsupportedCapabilityError,
} from './errors';
export type { APICallErrorOptions } from './errors';

// Optional cost estimation (token breakdown → USD). App injects via deps.priceProvider.
export { createPriceProvider, priceUsage, PRICES_2026 } from './pricing';
export type { ModelPrice, PriceTable, CreatePriceProviderOptions } from './pricing';

// Provider-executed (server-side) tool factories — web search phase 1.
export { anthropicWebSearch, openaiWebSearch, googleSearch } from './server-tools';
export type { AnthropicWebSearchConfig, OpenAIWebSearchConfig } from './server-tools';

// Optional model middleware (wrapModel + bundled logging/cache/redact/guard).
export { wrapModel, logging, simpleCache, redactPII, promptInjectionGuard } from './middleware';
export type { LanguageModelMiddleware, WrappedModel, MiddlewareContext } from './middleware';

// All canonical types (Message/Part/Usage/LanguageModel/CommonCallOptions/…).
export type * from './types';
