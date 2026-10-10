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
import type { LeaseProvider } from './lease';

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

/** `AgentRunOptions.onCatalogChange` (2.3): stop the run, or accept the new MCP catalog. */
export type AgentMcpCatalogChange = 'stop' | 'accept';

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
    | {
        status: 'stopped';
        reason: string;
        /**
         * With reason `'tool-reconciliation-required'` (2.3): the receipts of the
         * calls whose effect is unknown — each started (stage `'executing'`) and
         * its outcome was never recorded. Check each effect in the system it
         * touched, then resume with `retryToolCallIds` for the ones to run
         * again; a tool declared `replay: 'idempotent'` runs again by itself.
         */
        unknownEffects?: AgentToolReceipt[];
      }
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
    /**
     * The run's handoff targets (2.3), as JSON: each target's name, model,
     * instructions and own tools, which run in this native run once a transfer
     * is accepted. Resume rejects a change like a changed root tool. Absent
     * before 2.3 and for runs without targets; resume then records them.
     */
    handoffs?: string;
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
  /**
   * Whether the tool running this call declared `replay: 'idempotent'` (2.3). A
   * resume judges an interrupted call by it, so a handoff target's tool is never
   * mistaken for a root tool of the same name. A receipt written before 2.3 has
   * none; its tool is then looked up by name.
   */
  idempotent?: boolean;
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
  /**
   * Native run discovery (2.3): a page of the stored runs, newest change first
   * (last save descending, then run ID descending), summarised without their
   * transcripts. Pass a page's `cursor` back for the next one. Optional: the
   * memory, SQLite and Postgres stores have it. Rejects a malformed query
   * with a TypeError.
   */
  list?(query?: AgentRunListQuery): Promise<AgentRunListPage>;
}

/** Where a native run stands, as its envelope records it (2.3 names the union). */
export type AgentRunPhase = AgentRunEnvelope['phase'];

/** Which runs `AgentRunStore.list` returns (2.3). Every filter is optional. */
export interface AgentRunListQuery {
  /** Only runs in one of these phases; an empty list matches none. */
  phases?: readonly AgentRunPhase[];
  /**
   * Only runs last saved before this time: epoch ms on the store's clock (the
   * injected clock for the memory and SQLite stores, the database clock for
   * Postgres). Stale-run discovery passes `now - staleMs`.
   */
  updatedBefore?: number;
  /** Only this scope's runs. */
  scope?: string;
  /** The most runs per page, 1..1000. Default 100. */
  limit?: number;
  /** The `cursor` of the previous page: only runs after it in the order. */
  cursor?: string;
}

/** One run in a listing (2.3): what a supervisor needs without loading its transcript. */
export interface AgentRunSummary {
  runId: string;
  scope: string;
  phase: AgentRunPhase;
  /** The envelope's revision; 0 for an envelope written by 2.1. */
  revision: number;
  /** Epoch ms of the run's last save, on the store's clock. */
  updatedAt: number;
  /**
   * The status of the result the envelope records: `'suspended'` for a run
   * waiting on approvals or client results (its phase stays `'running'`), the
   * outcome of a terminal run. Absent while the run is in progress.
   */
  status?: AgentResult['status'];
}

/** A page of runs (2.3). */
export interface AgentRunListPage {
  runs: AgentRunSummary[];
  /**
   * Present when more runs follow: pass it as `cursor`. Opaque, and only
   * meaningful to the store that made it. A run saved while you page moves
   * ahead of the cursor, so a traversal never repeats a run but can miss one
   * that was saved meanwhile.
   */
  cursor?: string;
}

export interface AgentRunSession {
  store: AgentRunStore;
  runId: string;
  /** Application-selected tenant/workflow scope, checked on every resume. */
  scope: string;
}

/**
 * A native run's cross-process claim (2.3), like `createSwarm`'s `lease`: the
 * executor holds the run's lease while it drives the run and renews it every
 * `ttlMs / 3` on `deps.clock`.
 */
export interface AgentRunLeaseOptions {
  provider: LeaseProvider;
  /** This process's identity; defaults to a generated ID per run. */
  owner?: string;
  /** An integer of at least 3. Default 30 000. */
  ttlMs?: number;
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
  /**
   * What the run does when an MCP server changes its tool catalog mid-run (2.3):
   * `'stop'` (the default) ends it with reason `'mcp-catalog-changed'` before the
   * model is offered the new catalog, and keeps the catalog the run is bound to;
   * `'accept'` records the new catalog as the run's binding and carries on. Both
   * report the change as a `warning` part (`setting: 'mcp'`); an announcement
   * that changed nothing does neither.
   */
  onCatalogChange?: AgentMcpCatalogChange;
  toolsContext?: Record<string, unknown>;
  session?: AgentRunSession;
  /**
   * Claim the session's run through a `LeaseProvider` (2.3), so two processes
   * never drive it at once. Its key is `agentRunLeaseKey(session)` from
   * `@deuz-sdk/core/ops`. While another executor holds it, the run fails with
   * code `'lease_held'` before reading or writing anything; an executor that
   * loses it stops writing and fails with `'lease_lost'`, leaving the run as
   * its last save had it for the next executor. A `'cancel'` signalled to the
   * key stops the run with reason `'cancelled'`, and is acknowledged once that
   * is saved. Requires `session`.
   */
  lease?: AgentRunLeaseOptions;
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
