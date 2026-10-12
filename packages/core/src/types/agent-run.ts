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
import type { LanguageModel, ModelSurface } from './model';
import type { Dependencies } from './deps';
import type { ChatPersistOptions } from '../chat';
import type { MemoryCallOptions, MemoryScope } from '../memory';

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
         * again and `reconciledToolResults` for the ones that landed; a tool
         * declared `replay: 'idempotent'` runs again by itself. Every call the
         * store still holds as unknown is listed, also one the stopped resume
         * tried to settle: settle them all in one resume.
         */
        unknownEffects?: AgentToolReceipt[];
      }
    | { status: 'failed'; error: { name: string; message: string; code?: string } }
  );

/** Native persistence is deliberately separate from legacy AgentCheckpoint v1. */
export interface AgentRunEnvelope {
  kind: 'deuz-agent-run';
  /**
   * `2` (2.3) when the envelope records run memory, a chat projection or model
   * fail-over (`memory`, `transcript`, `chat`, `models`): a 2.2 reader knows none
   * of them, so it refuses the run instead of resuming it without them. Every
   * other envelope stays `1`. Readers accept both.
   */
  version: 1 | 2;
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
     * rejects a catalog that drifted from it unless `onCatalogChange` is
     * `'accept'`; a hot refresh, or an accepting resume, records the new one.
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
    /**
     * The run's memory scope (2.3), as JSON: absent for a run without `memory`.
     * Resume rejects a changed, added or removed scope.
     */
    memory?: string;
    /**
     * The run's chat (2.3): its `chatId` and scope, as JSON; absent without
     * `chat`. Resume rejects a changed, added or removed chat.
     */
    chat?: string;
    /**
     * The run's `fallbackModels` (2.3), as JSON: each candidate's provider,
     * protocol and model id, in order; absent without fail-over. Resume rejects
     * a changed list.
     */
    fallback?: string;
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
  /** Run memory (2.3): the recall the run was given and its extraction. */
  memory?: AgentRunMemoryState;
  /**
   * The run's user-facing transcript (2.3), kept for `chat` and `memory`: the
   * caller's input, then the run's assistant and tool turns as they happened.
   * Append-only, so compaction or a `prepareStep` history never rewrites it.
   */
  transcript?: AgentRunTranscript;
  /** Where the run's chat projection stands (2.3). */
  chat?: AgentRunChatState;
  /** Model fail-over (2.3): which models failed and which one the run calls now. */
  models?: AgentRunModelState;
  /**
   * A failure a resume may retry (2.3): written with a `failed` result whose
   * cause was transient, and only then. `retryFailed` re-enters the run from
   * its last checkpoint. A reader that does not know it (2.2) returns the
   * failed result, as before.
   */
  retry?: AgentRunRetry;
}

/** A transient failure of a native run (2.3); see `AgentRunOptions.retryFailed`. */
export interface AgentRunRetry {
  /**
   * `'model-call'`: a model call failed with a retryable transport or provider
   * error (network, transport timeout, 5xx, 429/529 after the call's own
   * retries, an open breaker) or its stream broke off. `'admission'`: the
   * persistent budget store refused to admit a call with a serialization
   * conflict (40001 or 40P01) after its own retries, so nothing was admitted.
   */
  cause: 'model-call' | 'admission';
  /** The phase the run failed in; a retry re-enters it there. */
  phase: 'running' | 'finalizing';
}

/** A model a native run called (2.3): who serves it, over which protocol. */
export interface AgentRunModelRef {
  provider: string;
  /** The wire protocol (`LanguageModel.surface`). */
  protocol: ModelSurface;
  modelId: string;
}

/** One fail-over of a native run (2.3): a model call that failed and where it went next. */
export interface AgentRunModelAttempt {
  /** 1 for the run's first fail-over, counting up. */
  attempt: number;
  /** The model whose call failed; the run never calls it again. */
  model: AgentRunModelRef;
  /** The model the call went to instead. */
  next: AgentRunModelRef;
  /** The run's model step the failed call was. */
  modelStep: number;
  phase: 'running' | 'finalizing';
  /** The retryable error that triggered it. */
  error: { name: string; message: string; code?: string };
}

/** Model fail-over state of a native run (2.3). */
export interface AgentRunModelState {
  /**
   * The fail-over rules the record was written under: `1` (2.3). A call fails
   * over only on a retryable transport or provider error before its first
   * content (network, transport timeout, 5xx, 429/529 after the call's own
   * retries, an open breaker); never on a refusal, a policy, budget or
   * validation rejection, or after content.
   */
  policy: 1;
  /** The model the run's own calls go to now: `model` until it failed over. */
  selected: AgentRunModelRef;
  /** Every fail-over so far, in order. */
  attempts: AgentRunModelAttempt[];
}

/** The run's user-facing transcript (2.3); see `AgentRunEnvelope.transcript`. */
export interface AgentRunTranscript {
  messages: Message[];
  /** How many leading messages are the caller's input. */
  input: number;
  /**
   * The turns the SDK wrote among `messages`, by index: the recall message, the
   * finalization prompt, output-repair and verifier feedback. The chat gets
   * them like every other turn (the next run replays the exact prefix the
   * model's thinking is bound to); memory extraction leaves them out.
   */
  internal: number[];
  /**
   * How far the run's checkpointed history has been folded in: its length and
   * a fingerprint of its last message. An interrupted leg's turns are folded in
   * from the checkpoint on resume when the history was not rewritten meanwhile.
   */
  synced: { length: number; last?: string };
}

/** The recall a native run was given (2.3), once, before its first model call. */
export interface AgentRunRecall {
  /**
   * `'recalled'`: memories were found and appended at `index` as a
   * `role: 'system'` message; `'empty'`: none matched; `'failed'`: the store or
   * embedder failed and the run went on without (best-effort, as in the legacy
   * loops); `'skipped'`: `recall: false`, or no user text to query with.
   */
  status: 'recalled' | 'empty' | 'failed' | 'skipped';
  /** The recall message's index in `messages` and in the transcript. */
  index?: number;
  /** How many memories it carries. */
  count?: number;
}

/**
 * The extraction of a completed native run (2.3), tracked apart from the run's
 * own outcome: `'pending'` is written with the terminal commit, before any
 * memory is written; the outcome follows in a later save.
 */
export interface AgentRunMemoryExtraction {
  /** Unique per extraction; every record it writes carries it (`metadata.deuz.operationId`). */
  operationId: string;
  status: 'pending' | 'completed' | 'failed';
  /** Whether the pass infers facts with the memory LLM (`extract.infer`). */
  infer: boolean;
  /** How many store mutations it applied, once completed. */
  mutations?: number;
  error?: { name: string; message: string; code?: string };
}

/** Run memory (2.3); see `AgentRunEnvelope.memory`. */
export interface AgentRunMemoryState {
  /** The scope the run recalled in and writes to. */
  scope: MemoryScope;
  recall: AgentRunRecall;
  /** Absent until a completed run hands its turns to extraction. */
  extraction?: AgentRunMemoryExtraction;
}

/** One tool invocation in a run's chat projection (2.3). */
export interface AgentRunChatInvocation {
  toolCallId: string;
  /** The run's model step that issued it: the step half of its receipt key. */
  modelStep?: number;
  /** The projected message that carries the call. */
  messageId: string;
  /** The projected message that carries its result, once there is one. */
  resultId?: string;
}

/**
 * Where a native run's chat projection stands (2.3). The run's checkpoint is
 * the canonical record and the chat store a projection of it: the two are
 * written one after the other, never as one transaction. The projection is
 * saved after the checkpoint and this state after the projection, so a failed
 * or interrupted projection leaves `cursor` behind the transcript; the next
 * projection save, a resume or `reconcileAgentRun` writes it again. Each save
 * replaces the whole record, so a repeat never appends a message twice.
 */
export interface AgentRunChatState {
  chatId: string;
  /** How many transcript messages the chat store has acknowledged. */
  cursor: number;
  /**
   * The ids of the projected messages, in record order (`ChatRecord.messageIds`):
   * an input message keeps the id the stored chat gave it, a message of this
   * run is `<runId>:<transcript index>`.
   */
  messageIds: string[];
  /** The projected assistant turns of the run, by message id, in order. */
  turns: string[];
  /** The run's tool invocations and the messages that carry them. */
  invocations: AgentRunChatInvocation[];
  /**
   * The last projection attempt: `'saved'`, `'failed'` (the store threw;
   * `error` says why), or `'scope-mismatch'` (the stored chat belongs to
   * another scope, so it was left untouched).
   */
  status: 'saved' | 'failed' | 'scope-mismatch';
  error?: { name: string; message: string; code?: string };
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
  /**
   * The outcome was recorded by `reconciledToolResults` (2.3): the caller found
   * it in the system the effect touched after the run lost track of it; the
   * tool itself never reported it.
   */
  reconciled?: boolean;
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
   * memory, SQLite, Postgres and Redis stores have it. Rejects a malformed
   * query with a TypeError.
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
   * Postgres, the server's TIME for Redis). Stale-run discovery passes
   * `now - staleMs`.
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
   *
   * On resume, a catalog that differs from the recorded one fails the resume
   * under `'stop'`. Under `'accept'` the resume's first write records it as a
   * new binding revision, before any model call, with the same warning; it
   * still fails while a call the model made against the recorded catalog is
   * in flight (an MCP receipt in stage `'executing'`, or a call of the last
   * turn that waits for its verdict or never started), and when the resume
   * dropped the `mcp` entries.
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
  /**
   * Built-in memory in a native run (2.3). The recall runs ONCE, before the
   * first model call of a new run, and enters the run's history as an appended
   * `role: 'system'` message, so every step and every resume sends the same
   * prefix (preserved thinking); a resume never recalls again. Extraction runs
   * only for a run that completed, after its terminal commit, under an
   * operation id the checkpoint records as pending first; a terminal resume
   * never extracts again, and `reconcileAgentRun` settles one an interruption
   * left pending. `recall: false`, `extract: false`, `writePolicy` and `sweep`
   * behave as in the legacy loops. The scope is part of the resume binding, and
   * a run under another native run's execution may only narrow that run's scope.
   */
  memory?: MemoryCallOptions;
  /**
   * Chat projection (2.3): the run's transcript as the conversation goes on
   * (the input, then every turn the run appended, raw: before compaction or a
   * `prepareStep` history; reasoning blocks byte for byte), saved to
   * `chat.store` after the run's own checkpoint at every suspension and at the
   * end, with stable `messageIds`. A store failure never fails the run: it is
   * reported as a `warning` part and repaired by the next save (see
   * `AgentRunChatState`). A stored chat of another scope is never overwritten.
   * The chat is part of the resume binding.
   */
  chat?: ChatPersistOptions;
  /**
   * Model fail-over inside the run (2.3). A model call that fails with a
   * retryable error before its first content (network, transport timeout, 5xx,
   * 429/529 after the call's own retries, an open breaker) is repeated on the
   * next candidate of `[that model, ...fallbackModels]`, within the same run,
   * budget and checkpoint: completed tool effects are never repeated, and a
   * refusal, a policy, budget or validation rejection never fails over. The
   * failed model is skipped for the rest of the run, and the checkpoint records
   * each fail-over (`AgentRunEnvelope.models`). Each candidate gets the call's
   * `capabilities` override and its own request profile. Part of the resume
   * binding.
   */
  fallbackModels?: LanguageModel[];
  /** Explicitly reconcile interrupted effects before permitting these call IDs to execute again. */
  retryToolCallIds?: readonly string[];
  /**
   * Record the outcome of an effect that landed (2.3), supplied only on
   * resume: for each call the run stopped on with reason
   * `'tool-reconciliation-required'` that you checked in the system it touched.
   * The receipt takes `output` as the call's raw result (marked `reconciled`),
   * and the step goes on from it exactly as from a recorded result: validated
   * and projected like the tool's own, and the call never runs again. With
   * `isError` the call is answered with `output` as its error (a string, or
   * JSON for any other value). Only the run's unknown effects are accepted,
   * each once and never also in `retryToolCallIds`; anything else fails the
   * resume with a TypeError before anything is written. A resume that leaves
   * an unknown effect unsettled stops again and records nothing.
   */
  reconciledToolResults?: readonly { toolCallId: string; output: unknown; isError?: boolean }[];
  /**
   * Re-enter a run that failed in transit (2.3), on resume. A failed run stays
   * failed, and a resume returns its stored result. With `retryFailed: true`, a
   * run whose envelope records a transient cause (`AgentRunEnvelope.retry`: a
   * model call that failed with a retryable transport or provider error or
   * whose stream broke off, or a budget admission refused with a serialization
   * conflict) goes on from its last checkpoint, in the phase it failed in, with
   * every check of a resume. The failed call stays counted, as a model step and,
   * while its outcome is unknown, in the accounting at its estimate; the retried
   * call is reserved anew. Any other failure fails the resume with a TypeError
   * before anything is written. Ignored for a run that did not fail.
   */
  retryFailed?: boolean;
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

/** What `reconcileAgentRun` settles (2.3). */
export interface AgentRunReconcileOptions {
  session: AgentRunSession;
  /** Write the chat projection again when the stored run says it is behind or failed. */
  chat?: ChatPersistOptions;
  /**
   * Settle an extraction the run left pending: when records of its operation
   * already exist it is recorded completed without another memory LLM call;
   * otherwise it runs now.
   */
  memory?: MemoryCallOptions;
  deps?: Dependencies;
}

/** What `reconcileAgentRun` did (2.3). */
export interface AgentRunReconciliation {
  runId: string;
  /** The projection's state after the call; `'current'` when nothing was behind. */
  chat?: AgentRunChatState['status'] | 'current';
  /** The extraction's state after the call; absent when the run has none. */
  memory?: AgentRunMemoryExtraction['status'];
}
