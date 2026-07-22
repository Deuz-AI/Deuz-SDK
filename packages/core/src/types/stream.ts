import type { Usage, FinishReason } from './usage';
import type { CompactionLayer } from './config';

/**
 * Canonical streaming delta. Open discriminated union — consumers should keep a
 * `default` case because Faz 1+ may add variants (additive). `fullStream`
 * yields these; `textStream` is the text-only convenience projection.
 */
export interface TextDeltaPart {
  type: 'text-delta';
  text: string;
}

export interface ReasoningDeltaPart {
  type: 'reasoning-delta';
  text: string;
  signature?: string;
  /** True when `text` is an opaque encrypted reasoning payload (OpenAI Responses) — not display text. */
  encrypted?: boolean;
}

export interface ToolCallDeltaPart {
  type: 'tool-call-delta';
  id: string;
  name?: string;
  /** Raw argument JSON fragment — accumulate as string, parse once at block end. */
  argsTextDelta: string;
  /** Provider round-trip data (e.g. Gemini thought_signature) to echo back. */
  providerMetadata?: Record<string, unknown>;
}

export interface SourcePart {
  type: 'source';
  id: string;
  url?: string;
  title?: string;
}

export interface FinishStreamPart {
  type: 'finish';
  usage: Usage;
  finishReason: FinishReason;
  /** Provider-specific finish detail (e.g. `{ anthropic: { stop_details } }`). Additive, optional. */
  providerMetadata?: Record<string, unknown>;
}

export interface ErrorStreamPart {
  type: 'error';
  error: unknown;
}

// --- Agentic loop parts (Faz 2; additive to the open union) ---

export interface StepStartPart {
  type: 'step-start';
  stepIndex: number;
}

export interface StepFinishPart {
  type: 'step-finish';
  stepIndex: number;
  finishReason: FinishReason;
  usage: Usage;
}

/** Final, parsed tool call (emitted after `tool-call-delta` fragments complete). */
export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Result of executing a `tool-call`, emitted after server-side execution. */
export interface ToolResultStreamPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
}

/**
 * A tool call that needs the user's approval before it may run (client-mode
 * approval: `needsApproval` triggered and no `approveToolCall` was provided).
 * The loop breaks after emitting these; resume with `approvalResponses`.
 */
export interface ToolApprovalRequestPart {
  type: 'tool-approval-request';
  /** Equals `toolCallId` today; distinct field for future signed approvals. */
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /**
   * Present when the pending call lives inside a suspended durable sub-agent
   * (1.5 additive): the sub-agent path it belongs to. Answer with the same
   * `approvalId` — the resume leg routes the verdict back down the tree.
   */
  agentPath?: string[];
  /** HMAC-signed approval token (1.7 additive, D4) — echo it back on the verdict. */
  token?: string;
}

/**
 * Automatic compaction ran before a step (1.4 additive): `layer` names what
 * ran, token counts are ESTIMATES (the loop's calibrated heuristic).
 */
export interface CompactionPart {
  type: 'compaction';
  layer: CompactionLayer;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * A sub-agent (`agentTool`) part, forwarded live into the parent stream (1.4
 * additive). `agentPath` is the full path (`['researcher']`, `['researcher',
 * 'coder']`); `part` is the sub-agent's own canonical part. Single-wrapped —
 * a 2nd-level part rides `agentPath.length === 2`, never a nested `sub-agent`.
 */
export interface SubAgentPart {
  type: 'sub-agent';
  agentPath: string[];
  part: StreamPart;
}

/**
 * App-defined typed data part (1.7 additive): the server writes it via
 * `createDeuzStream(...).writeData(name, payload)` and the UI wire frames it
 * as `data-{name}` (optionally validated against a Standard Schema while
 * streaming — see `dataSchemas`).
 */
export interface DataPart {
  type: 'data';
  name: string;
  payload: unknown;
}

/**
 * Built-in RAG citation part (1.7 additive): provenance for retrieved chunks.
 * Build from retrieve/rerank hits with `citationsFromHits` (`./rag`).
 */
export interface CitationPart {
  type: 'citation';
  id: string;
  sourceId?: string;
  url?: string;
  title?: string;
  snippet?: string;
  /** `Chunk.index` of the cited chunk (stable across BM25 indexing and RRF fusion). */
  chunkIndex?: number;
  score?: number;
}

/**
 * Live cumulative USD cost (1.7 additive, D2): emitted after every step (and
 * on single-turn finish) whenever `deps.priceProvider` is injected. `costUsd`
 * is cumulative for the run (cross-leg on durable resumes); `deltaUsd` is this
 * step's increment; `cacheSavingsUsd` is what prompt-cache reads saved vs
 * full-price input tokens (needs `PriceProvider.cacheSavings`).
 */
export interface CostPart {
  type: 'cost';
  costUsd: number;
  deltaUsd?: number;
  cacheSavingsUsd?: number;
  stepIndex?: number;
}

/**
 * A `budget: { usd, tokens }` guardrail tripped (1.7 additive, D3). Emitted
 * right before the terminal `finish` part; `providerMetadata.deuz.stoppedBy`
 * carries the matching `budget.usd` / `budget.tokens` marker.
 */
export interface BudgetExceededPart {
  type: 'budget-exceeded';
  kind: 'usd' | 'tokens';
  limit: number;
  value: number;
}

/**
 * A `verifyStep` verdict (1.8 additive): emitted on the streaming loop at every
 * natural-completion verification. `willRetry` is true when the loop will
 * re-drive with `feedback` (bounded by `maxVerifyAttempts`).
 */
export interface VerifyPart {
  type: 'verify';
  stepIndex: number;
  attempt: number;
  ok: boolean;
  willRetry: boolean;
  feedback?: string;
}

/** One task in a plan snapshot (structural — mirrors `Task` in `./plan`). */
export interface PlanTaskSnapshot {
  id: string;
  title: string;
  /** 'pending' | 'in_progress' | 'done' | 'failed' — kept loose for the wire. */
  status: string;
  notes?: string;
}

/**
 * A live plan snapshot (1.8 additive): an autonomous run pushes its `TaskList`
 * as it changes so a UI can render a to-do panel. Emit via `emitPlanUpdate`
 * (`@deuz-sdk/core/runtime`) from a tool's `ctx.emitPart`.
 */
export interface PlanUpdatePart {
  type: 'plan-update';
  goal?: string;
  tasks: PlanTaskSnapshot[];
}

/**
 * A live activity log line (1.8 additive): the "Computer" feed of what an
 * autonomous agent is doing (opened a page, ran code, wrote a file). Emit via
 * `emitActivity` (`@deuz-sdk/core/runtime`).
 */
export interface ActivityPart {
  type: 'activity';
  message: string;
  level?: 'info' | 'warn' | 'error';
  /** Optional structured payload (a url, a file path, a command, …). */
  data?: unknown;
  /** Sub-agent path this activity came from, when inside an `agentTool`. */
  agentPath?: string[];
}

/** Tool-call lifecycle states surfaced by the streaming loop (1.7 additive). */
export type ToolRunState =
  | 'input-streaming'
  | 'input-complete'
  | 'awaiting-approval'
  | 'executing'
  | 'complete'
  | 'error';

/**
 * Tool state machine (1.7 additive): the streaming loop emits one of these at
 * every lifecycle transition of a tool call, so UIs render status ("running
 * getWeather…") without re-deriving it from part ordering.
 */
export interface ToolStatePart {
  type: 'tool-state';
  toolCallId: string;
  toolName?: string;
  state: ToolRunState;
}

export type StreamPart =
  | TextDeltaPart
  | ReasoningDeltaPart
  | ToolCallDeltaPart
  | SourcePart
  | FinishStreamPart
  | ErrorStreamPart
  | StepStartPart
  | StepFinishPart
  | ToolCallPart
  | ToolResultStreamPart
  | ToolApprovalRequestPart
  | CompactionPart
  | SubAgentPart
  | DataPart
  | CitationPart
  | ToolStatePart
  | CostPart
  | BudgetExceededPart
  | VerifyPart
  | PlanUpdatePart
  | ActivityPart;
