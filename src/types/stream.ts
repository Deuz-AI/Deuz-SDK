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
  | SubAgentPart;
