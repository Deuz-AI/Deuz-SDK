/**
 * `@deuz-sdk/core` — pure, web-first, multi-provider AI SDK.
 *
 * This file IS the public surface: `tooling/api-contract.json` locks every name
 * exported here, so an accidental removal fails the release gate instead of a
 * consumer's build.
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

// Agent HANDOFF (2.0 additive) — transfer the run to another agent, history and
// all. The counterpart to `agentTool`, which delegates and comes back.
export { handoff } from './inference/handoff';
export type { HandoffAgentDef, HandoffOptions } from './inference/handoff';

// Built-in guardrails (2.0 additive) — ready-made values for the `guardrails`
// call option; the contract types ride the `./types` re-export below.
export { promptInjectionGuardrail, maxOutputLength } from './guardrails';

// Manual context compaction (2.0 additive) — the loop's layers over a plain
// array, for callers who own the history. Pure unless given a `summarize`.
export { compactMessages } from './compaction';
export type { CompactMessagesDeps, CompactMessagesResult, CompactionEvent } from './compaction';

// Typed tool authoring (1.9 additive) — `tool()` is a pure identity function
// (`tool(def) === def`); it exists only to flow the `parameters` schema's type
// into `execute(args)`, which `ToolSet = Record<string, Tool>` otherwise erases.
export { tool } from './tool';
export type { InferToolInput, InferToolOutput } from './tool';

// Content-part constructors (1.9 additive). `ImagePart` is the carrier for ALL
// binary media, so a PDF is an image part with `mediaType: 'application/pdf'` —
// correct but undiscoverable, which is what these two names are for. 2.0 kept
// the Part union at five members deliberately: no wire we speak needs a sixth,
// and adding one breaks every exhaustive switch a consumer wrote.
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
  McpAuthorizationRequiredError,
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
