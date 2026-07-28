/**
 * `@deuz-sdk/core` — pure, web-first, multi-provider AI SDK.
 * Public surface lock (1.0). Faz 0: types are final, methods are stubs that
 * throw NotImplementedError until Faz 1.
 */

// Canonical free functions.
export { streamChat, generateText, generateObject, streamObject } from './generate';
export { embed, embedMany } from './inference/embed';

// Loop stop conditions (1.4 additive; totalTokensExceed/costExceeds read REAL usage).
export {
  stepCountIs,
  hasToolCall,
  totalTokensExceed,
  costExceeds,
  durationExceeds,
} from './inference/stop';

// Sub-agents (1.4 additive) — an agent as a tool, with live stream + approval inheritance.
export { agentTool } from './inference/agent-tool';
export type { AgentToolDef } from './inference/agent-tool';

// Typed tool authoring (1.9 additive) — `tool()` is a pure identity function
// (`tool(def) === def`); it exists only to flow the `parameters` schema's type
// into `execute(args)`, which `ToolSet = Record<string, Tool>` otherwise erases.
export { tool } from './tool';
export type { InferToolInput, InferToolOutput } from './tool';

// Content-part constructors (1.9 additive). `ImagePart` is the carrier for ALL
// binary media until the `file` Part kind lands in 2.0, so a PDF is an image
// part with `mediaType: 'application/pdf'` — correct but undiscoverable.
export { filePart, imagePart } from './parts';

// Capability matrix read accessor (1.9 additive) — gate UI on capabilities
// instead of hard-coding slug lists. Returns a frozen copy; never throws.
export { getModelCapabilities } from './core/registry';
export type { ModelCapabilities } from './core/registry';

// Optional convenience client + dependency resolution.
export { createClient, resolveDependencies } from './client';
export type { DeuzClient } from './client';

// Error taxonomy (base + full Faz 1.A hierarchy).
export {
  DeuzError,
  isDeuzError,
  NotImplementedError,
  APICallError,
  NetworkError,
  RateLimitError,
  OverloadedError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  ContextOverflowError,
  TimeoutError,
  AbortError,
  BreakerOpenError,
  NoObjectGeneratedError,
  ToolExecutionError,
  UnsupportedCapabilityError,
} from './errors';
export type { APICallErrorOptions, DeuzErrorJSON } from './errors';

// Optional cost estimation (token breakdown → USD). App injects via deps.priceProvider.
export { createPriceProvider, priceUsage, PRICES_2026 } from './pricing';
export type { ModelPrice, PriceTable, CreatePriceProviderOptions } from './pricing';

// Provider-executed (server-side) tool factories — web search phase 1.
export { anthropicWebSearch, openaiWebSearch, googleSearch } from './server-tools';
export type { AnthropicWebSearchConfig, OpenAIWebSearchConfig } from './server-tools';

// Optional model middleware (wrapModel + bundled logging/cache/redact/guard).
export {
  wrapModel,
  logging,
  simpleCache,
  redactPII,
  promptInjectionGuard,
  withFallback,
} from './middleware';
export type { LanguageModelMiddleware, WrappedModel, MiddlewareContext } from './middleware';
export type { FallbackHooks } from './internal/fallback';

// All canonical types (Message/Part/Usage/LanguageModel/CommonCallOptions/…).
export type * from './types';
