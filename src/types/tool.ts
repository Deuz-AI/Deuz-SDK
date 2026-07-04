import type { StandardSchemaV1, JSONSchema } from './schema';
import type { Usage, FinishReason } from './usage';
import type { Message } from './message';

/** Context handed to a tool's `execute`. */
export interface ToolExecuteContext {
  toolCallId: string;
  /** Conversation-so-far (immutable snapshot) for context-aware tools. */
  messages: Message[];
  /** Propagated from the call — long-running tools should honor it. */
  signal?: AbortSignal;
}

/**
 * A tool the model can call. `parameters` is any Standard Schema (zod/valibot)
 * or a raw JSON Schema (reuses `schema/bridge.ts`). Omit `execute` for a
 * "client tool" (emitted to the UI, never run server-side). `needsApproval` is
 * locked as a field now; the streaming approval round-trip lands in Faz 2.5.
 */
export interface Tool<Args = unknown, Result = unknown> {
  description?: string;
  parameters: StandardSchemaV1<unknown, Args> | JSONSchema;
  execute?: (args: Args, ctx: ToolExecuteContext) => Promise<Result> | Result;
  needsApproval?: boolean | ((args: Args, ctx: ToolExecuteContext) => boolean | Promise<boolean>);
  /**
   * 'provider' marks a provider-executed (server-side) tool: the provider runs
   * it during the turn and streams results back — it is never executed locally
   * and never breaks the loop as a client tool. Default: 'function'.
   */
  type?: 'function' | 'provider';
  /** Raw native tool definition (already in the target wire's shape) for `type: 'provider'`. */
  providerTool?: Record<string, unknown>;
  /**
   * Expected result shape — carried METADATA only (never sent on chat wires;
   * the loop does not validate results against it). MCP tools populate it from
   * the server's outputSchema; the MCP SDK itself validates structured results.
   */
  outputSchema?: JSONSchema;
}

export type ToolSet = Record<string, Tool>;

/** Canonical tool choice; each adapter maps it to its wire form. */
export type ToolChoice = 'auto' | 'required' | 'none' | { type: 'tool'; toolName: string };

/** A fully accumulated + parsed tool call (args parsed once at block end). */
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** The result of executing a `ToolCall`. */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

/**
 * A tool call awaiting user approval (client-mode approval break).
 * `approvalId === toolCallId` today; kept as a distinct field so a future
 * signed-approval scheme stays additive.
 */
export interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** The caller's verdict on a pending `ToolApprovalRequest` (resume call). */
export interface ToolApprovalResponse {
  approvalId: string;
  approved: boolean;
  /** Optional denial reason — fed back to the model inside the is_error tool_result. */
  reason?: string;
}

/** One turn of the agentic loop. */
export interface StepResult {
  stepType: 'initial' | 'tool-result';
  text: string;
  reasoningText?: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  finishReason: FinishReason;
  usage: Usage;
  /** Messages this step appended (assistant turn + the tool-result turn). */
  response: { messages: Message[] };
}

/** Loop stop predicate. Return true to stop after the current step. */
export type StopCondition = (info: {
  steps: StepResult[];
  stepCount: number;
  /** Cumulative REAL usage across all steps so far (sub-agents included). Additive (1.4). */
  usage?: Usage;
  /** Cumulative cost in USD — present only when `deps.priceProvider` is set AND a condition needs it. Additive (1.4). */
  costUSD?: number;
}) => boolean | Promise<boolean>;
