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
  serializeCheckpoint,
  deserializeCheckpoint,
  createApprovalSigner,
  CheckpointNotFoundError,
} from './durable';
export type {
  ResumeOptions,
  SignedApprovalPayload,
  CreateApprovalSignerOptions,
  ApprovalSigner,
} from './durable';
export { DeuzError, isDeuzError, NotImplementedError, NoObjectGeneratedError } from './errors';
export type { DeuzErrorJSON } from './errors';
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
