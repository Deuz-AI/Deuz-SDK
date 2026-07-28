/**
 * Edge-safe entry. Re-exports the Web-API-only subset (no node: imports) so
 * Next.js Edge / Cloudflare Workers / Deno can import a guaranteed-safe build.
 * Existence of this entry is itself the edge smoke test for the build.
 */
export { streamChat, generateText, generateObject, streamObject } from './generate';
export {
  stepCountIs,
  hasToolCall,
  totalTokensExceed,
  costExceeds,
  durationExceeds,
} from './inference/stop';
export { agentTool } from './inference/agent-tool';
export type { AgentToolDef } from './inference/agent-tool';
// Typed tool authoring + content-part constructors (1.9 additive). Both modules
// are pure: type-only imports and a plain object literal, no ambient clock,
// randomness or Node API — edge-safe by construction.
export { tool } from './tool';
export type { InferToolInput, InferToolOutput } from './tool';
export { filePart, imagePart } from './parts';
// Capability matrix read accessor (1.9 additive) — the registry is a static
// table plus a Symbol read; nothing it touches leaves the Web API surface.
export { getModelCapabilities } from './core/registry';
export type { ModelCapabilities } from './core/registry';
export { anthropicWebSearch, openaiWebSearch, googleSearch } from './server-tools';
export { createClient, resolveDependencies } from './client';
export type { DeuzClient } from './client';
// Durable sessions (1.5 additive) — checkpoint/resume + HMAC-signed approvals,
// WebCrypto only, edge-safe by construction.
export {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
  resumeDeuzChatResponse,
  serializeCheckpoint,
  deserializeCheckpoint,
  createApprovalSigner,
  CheckpointNotFoundError,
} from './durable';
export type {
  ResumeOptions,
  ResumeDeuzChatOptions,
  SignedApprovalPayload,
  CreateApprovalSignerOptions,
  ApprovalSigner,
} from './durable';
export {
  DeuzError,
  isDeuzError,
  NotImplementedError,
  NoObjectGeneratedError,
  BreakerOpenError,
} from './errors';
export type { DeuzErrorJSON } from './errors';
// Chat engine (1.7 additive, P2+P6) — pure reducers + ChatStore seam.
// 1.9 adds the inverse projection (canonicalFromUI), the tail seal, and the
// multimodal input primitives; `filesToImageParts` reads a Blob through
// `arrayBuffer()`, a Web API — no FileReader, no Buffer, still edge-safe.
export {
  createAssistantTurn,
  applyUIPart,
  sealAssistantTurn,
  assistantMessageFromTurn,
  clientToolResultMessage,
  uiFromMessages,
  canonicalFromUI,
  userMessageFromInput,
  filesToImageParts,
  dropTrailingAssistant,
  branchBeforeUserMessage,
  createInMemoryChatStore,
  serializeChatRecord,
  deserializeChatRecord,
} from './chat';
export type {
  UIMessage,
  UIMessagePart,
  UIToolCall,
  AssistantTurnState,
  ChatHistory,
  ChatRecord,
  ChatStore,
  ChatPersistOptions,
  ChatInput,
} from './chat';
// Chat request validation (1.9 additive) — pure structural validation of the
// POSTed body; errors.ts + internal/redact.ts + TextEncoder only, edge-safe.
// Defaults reject an injected system turn and client-authored tool results.
export { validateChatRequest, parseDeuzChatRequest } from './chat-request';
export type { DeuzChatRequest, ValidateChatOptions, ValidateChatResult } from './chat-request';
// Observation (1.6 additive) — local-first observers, pure aggregation,
// no ambient time/id/console: edge-safe by construction.
export {
  createCallbackObserver,
  createMemoryObserver,
  composeObservers,
  filterObserver,
  summarizeRun,
} from './observe';
export type { MemoryObserver, RunSummary } from './observe';
// Reusable agent VALUE (1.9 additive) — a frozen free-function factory over the
// existing free functions, not a class and not a new runtime. Pure composition,
// so it is edge-safe by construction.
export { createAgent } from './agent';
export type { AgentDef, DeuzAgent, AgentCallOptions, AgentObjectCallOptions } from './agent';

// OpenTelemetry bridge (1.9 additive) — an implementation of the `Tracer` / `Observer`
// seams, edge-safe because `@opentelemetry/api` is an OPTIONAL peer resolved through a
// lazy variable specifier. Content capture stays opt-in and double-redacted.
// NOTE: `renderRunReport` is deliberately NOT re-exported here. It is pure and would be
// legal, but it carries ~7 KB gzip of inline HTML/CSS/JS template for a LOCAL debugging
// workflow, and this barrel exists to keep worker bundles small. It is already reachable
// from every runtime via `@deuz-sdk/core/observe`.
export { createOtelTracer, createOtelObserver, otelReady } from './otel';
export type { OtelTracerOptions } from './otel';

export type * from './types';
