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
export { DeuzError, isDeuzError, NotImplementedError, NoObjectGeneratedError } from './errors';
export type { DeuzErrorJSON } from './errors';
// Chat engine (1.7 additive, P2+P6) — pure reducers + ChatStore seam,
// zero runtime imports: edge-safe by construction.
export {
  createAssistantTurn,
  applyUIPart,
  assistantMessageFromTurn,
  clientToolResultMessage,
  uiFromMessages,
  dropTrailingAssistant,
  branchBeforeUserMessage,
  createInMemoryChatStore,
  serializeChatRecord,
  deserializeChatRecord,
} from './chat';
export type {
  UIMessage,
  UIToolCall,
  AssistantTurnState,
  ChatHistory,
  ChatRecord,
  ChatStore,
  ChatPersistOptions,
} from './chat';
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
export type * from './types';
