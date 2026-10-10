import type {
  CommonCallOptions,
  McpClientLoopEntry,
  McpHttpLoopConfig,
  McpStdioLoopConfig,
} from './config';
import type { McpClient } from '../mcp/shared';
import type { Message } from './message';
import type { Usage } from './usage';
import type { StreamPart } from './stream';
import type { AgentCheckpoint } from './session';
import type { JSONSchema, StandardSchemaV1 } from './schema';
import type { Tool, ToolApprovalRequest, ToolCall, ToolExecuteContext } from './tool';
import type { BudgetTotals, ExecutionContextSnapshot, NativeExecutionContext } from './execution';
import type { FinishReason } from './usage';
import type { StopDetails } from './methods';

/** A validator returns its validated (possibly transformed) value or throws. */
export type AgentValidator<T> = (value: unknown) => T | Promise<T>;
export type AgentValidation<T> =
  | { schema: StandardSchemaV1<unknown, T>; validate?: AgentValidator<T> }
  | { schema: JSONSchema; validate: AgentValidator<T> };

export type AgentOutput<T> = AgentValidation<T> & {
  name?: string;
  description?: string;
  mode?: 'auto' | 'json' | 'tool';
  /** Optional independent validator for completed top-level array elements. */
  element?: AgentValidation<T extends readonly (infer E)[] ? E : never>;
};

export interface AgentToolContext<T = unknown> extends Pick<
  ToolExecuteContext,
  'toolCallId' | 'messages' | 'signal' | 'agentPath' | 'execution'
> {
  /** Only this tool's validated context. Never sent to the provider. */
  context?: T;
  /**
   * The root model step that issued this call (2.2). Together with
   * `toolCallId` it is stable across resume, so it can key an idempotent write.
   */
  modelStep?: number;
}

export interface AgentTool<A = unknown, R = unknown, C = unknown> extends Omit<
  Tool<A, R>,
  'execute' | 'needsApproval' | 'outputSchema'
> {
  execute?: (args: A, context: AgentToolContext<C>) => R | Promise<R>;
  needsApproval?: boolean | ((args: A, context: AgentToolContext<C>) => boolean | Promise<boolean>);
  contextSchema?: StandardSchemaV1<unknown, C> | JSONSchema;
  validateContext?: AgentValidator<C>;
  outputSchema?: StandardSchemaV1<unknown, R> | JSONSchema;
  validateResult?: AgentValidator<R>;
  /** Provider history receives this projection; result events retain the raw result. */
  toModelOutput?: (result: R, context: AgentToolContext<C>) => unknown | Promise<unknown>;
  /**
   * `'idempotent'` (2.2): repeating this call with the same `toolCallId` and
   * `modelStep` has no further effect, so an interrupted call runs again on
   * resume without `retryToolCallIds`. Bump `bindingId` when changing it.
   */
  replay?: 'idempotent';
}

// Heterogeneous tool registries intentionally erase each entry's generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentToolSet = Record<string, AgentTool<any, any, any>>;

/**
 * Which interrupted calls of an MCP server a native run may repeat on resume
 * (2.3): `'idempotent'` for every tool of the server, or a map from the server's
 * own tool names (before any `namespace` prefix) to `'idempotent'`. The MCP
 * counterpart of {@link AgentTool.replay}; bump `bindingId` when changing it.
 */
export type AgentMcpReplay = 'idempotent' | Readonly<Record<string, 'idempotent'>>;

/**
 * One `mcp` entry of a native run (2.3): any `CommonCallOptions.mcp` entry. A
 * config or `{ client }` entry may also declare `replay`.
 */
export type AgentMcpEntry =
  | McpClient
  | ((McpHttpLoopConfig | McpStdioLoopConfig | McpClientLoopEntry) & {
      replay?: AgentMcpReplay;
    });

export type AgentVerification =
  | { status: 'verified' }
  | { status: 'rejected'; feedback?: string }
  | { status: 'inconclusive'; reason?: string };

export interface AgentVerifyContext<T> {
  output: T;
  text: string;
  messages: Message[];
  usage: Usage;
  /** Zero-based, persisted across resume. */
  attempt: number;
  execution: NativeExecutionContext;
  signal?: AbortSignal;
}

interface AgentResultBase {
  runId: string;
  text: string;
  messages: Message[];
  usage: Usage;
  modelSteps: number;
  accounting?: BudgetTotals;
  verification?: AgentVerification['status'];
  /**
   * The provider's explanation of an early stop (2.3), e.g. on a `stopped` result
   * with reason `'refusal'`: the refusal category and explanation.
   */
  stopDetails?: StopDetails;
}

/** Only a completed result has an accepted, runtime-validated output. */
export type AgentResult<T = string> = AgentResultBase &
  (
    | { status: 'completed'; output: T }
    | {
        status: 'suspended';
        pendingApprovals: ToolApprovalRequest[];
        pendingClientCalls: ToolCall[];
      }
    | { status: 'stopped'; reason: string }
    | { status: 'failed'; error: { name: string; message: string; code?: string } }
  );

/** Native persistence is deliberately separate from legacy AgentCheckpoint v1. */
export interface AgentRunEnvelope {
  kind: 'deuz-agent-run';
  version: 1;
  runId: string;
  /**
   * Increases by one on every save (2.2). Durable stores reject a save that is
   * not the stored revision plus one, which fences out an executor that lost
   * the run. A 2.1 envelope has none and counts as 0.
   */
  revision?: number;
  scope: string;
  phase: 'running' | 'finalizing' | 'terminal';
  messages: Message[];
  usage: Usage;
  modelSteps: number;
  finalizationAttempts: number;
  /** Attempts for the current verifier candidate; finalizationAttempts remains cumulative. */
  outputAttempts?: number;
  verificationAttempts: number;
  checkpoints: Record<string, AgentCheckpoint>;
  execution?: ExecutionContextSnapshot;
  /** A persisted candidate avoids another model call after a verifier/store interruption. */
  candidateText?: string;
  verification?: AgentVerification['status'];
  binding?: {
    model: string;
    tools: string;
    output: string;
    revision?: string;
    /**
     * The MCP servers' tool catalog (2.3): `fingerprintTools` JSON. Resume
     * rejects a catalog that drifted from it; a hot refresh records the new one.
     * Absent before 2.3 and for runs without MCP; resume then records the catalog.
     */
    mcp?: string;
  };
  limits?: { maxSteps: number; maxOutputAttempts: number; maxVerifyAttempts: number };
  loopOutcome?: {
    finishReason: FinishReason;
    endReason: string;
    stoppedBy?: string;
    /** The provider's stop explanation for the loop's last turn (2.3). */
    stopDetails?: StopDetails;
  };
  toolResults?: Record<string, AgentToolReceipt>;
  pendingClientCalls?: ToolCall[];
  result?: AgentResult<unknown>;
}

export interface AgentToolReceipt {
  /** Disambiguates provider call IDs reused in a later root model turn. */
  modelStep?: number;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /**
   * `executing` means the outcome is unknown, so a resume stops for
   * reconciliation. `failed` (2.3) means `execute` threw and the model was given
   * the error; a replay reports the recorded `error` and runs nothing again.
   */
  stage:
    | 'executing'
    | 'suspended'
    | 'executed'
    | 'completed'
    | 'failed'
    | 'validation-failed'
    | 'projection-failed';
  rawResult?: unknown;
  modelOutput?: unknown;
  error?: string;
}

export interface AgentRunStore {
  load(runId: string): AgentRunEnvelope | undefined | Promise<AgentRunEnvelope | undefined>;
  /**
   * Must durably commit before resolving; failures stop execution. Durable
   * stores (2.2) reject an envelope whose revision is not the stored one plus one.
   */
  save(envelope: AgentRunEnvelope): void | Promise<void>;
}

export interface AgentRunSession {
  store: AgentRunStore;
  runId: string;
  /** Application-selected tenant/workflow scope, checked on every resume. */
  scope: string;
}

export type AgentRunOptions<T = string> = Omit<
  CommonCallOptions,
  | 'messages'
  | 'session'
  | 'tools'
  | 'verifyStep'
  | 'maxVerifyAttempts'
  | 'doneWhen'
  | 'falseFinishGuard'
  | 'chat'
  | 'memory'
  | 'fallbackModels'
  | 'mcp'
> & {
  messages?: Message[];
  tools?: AgentToolSet;
  /**
   * MCP servers, as `CommonCallOptions.mcp` (2.3: through the native run's effect
   * receipts, with the servers' tool catalog in the resume binding). An entry may
   * declare `replay` for its idempotent tools.
   */
  mcp?: AgentMcpEntry[];
  toolsContext?: Record<string, unknown>;
  session?: AgentRunSession;
  output?: AgentOutput<T>;
  /** Bump when changing tool implementation or verifier semantics for a durable run. */
  bindingId?: string;
  /** Explicitly reconcile interrupted effects before permitting these call IDs to execute again. */
  retryToolCallIds?: readonly string[];
  /** Results for pending client-side tool calls, supplied only on resume. */
  clientToolResults?: readonly { toolCallId: string; output: unknown; isError?: boolean }[];
  verify?: (context: AgentVerifyContext<T>) => AgentVerification | Promise<AgentVerification>;
  /** Total candidate validation attempts, including the first. Default 2. */
  maxOutputAttempts?: number;
  /** Total verifier invocations, including the first. Default 3. */
  maxVerifyAttempts?: number;
} & (string extends T ? unknown : { output: AgentOutput<T> });

/** Drafts are not T: only the completed result certifies the entire output. */
export interface AgentPartialOutput {
  attempt: number;
  value: unknown;
}
export interface AgentArrayElement<T = unknown> {
  attempt: number;
  index: number;
  value: T;
}
export type AgentEvent<T = string> =
  | { type: 'part'; part: StreamPart; phase: 'running' | 'finalizing' }
  | { type: 'phase'; phase: 'running' | 'finalizing' }
  | { type: 'partial-output'; attempt: number; value: unknown }
  | { type: 'array-element'; attempt: number; index: number; value: unknown }
  | {
      type: 'tool-output';
      toolCallId: string;
      toolName: string;
      rawResult: unknown;
      modelOutput?: unknown;
      error?: string;
    }
  | { type: 'result'; result: AgentResult<T> };

export interface AgentStream<T = string> {
  /** Subscribe before starting result/consume when the complete event history is required. */
  readonly events: AsyncIterable<AgentEvent<T>>;
  readonly textStream: AsyncIterable<string>;
  readonly partialOutputStream: AsyncIterable<AgentPartialOutput>;
  readonly elementStream: AsyncIterable<
    AgentArrayElement<T extends readonly (infer E)[] ? E : never>
  >;
  readonly result: Promise<AgentResult<T>>;
  consume(): Promise<AgentResult<T>>;
}
