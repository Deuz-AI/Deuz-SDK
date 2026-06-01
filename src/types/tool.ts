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
}) => boolean | Promise<boolean>;
