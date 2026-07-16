import type { Usage } from './usage';

/**
 * Deuz-native observation event protocol (1.6). Versioned, provider-agnostic
 * lifecycle events for runs, model calls, agent steps, tools, approvals,
 * durable checkpoints, compaction and sub-agents. Consumed by `Observer`
 * implementations injected via `Dependencies.observer` — no external service,
 * no OpenTelemetry dependency. The full protocol contract lives in 1.6.0.md.
 *
 * Security default: events carry only counts, ids, names, durations and small
 * enums. Message content, tool inputs/outputs, reasoning and error messages
 * are captured ONLY when explicitly opted in via `ObservationCaptureOptions`,
 * and always pass through redaction first.
 */

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export type ObservePrimitive = string | number | boolean | null;

export type ObserveAttributeValue = ObservePrimitive | readonly ObservePrimitive[];

/** Flat, JSON-safe metadata. Functions/symbols/bigints/cycles are rejected at snapshot time. */
export type ObserveAttributes = Readonly<Record<string, ObserveAttributeValue>>;

// ---------------------------------------------------------------------------
// Observer seam
// ---------------------------------------------------------------------------

export interface Observer {
  readonly options?: ObservationOptions;
  /**
   * Synchronous event sink. The SDK never awaits an observer; observers that
   * ship events asynchronously must manage their own internal queue. A throw
   * here is swallowed by the runtime — it can never affect the run.
   */
  emit(event: ObserveEvent): void;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ObservationOptions {
  /** Default true. */
  enabled?: boolean;
  /**
   * Deterministic run sampling in [0, 1]. Default 1. The decision hashes the
   * already-generated `runId` (FNV-1a — same helper as retry jitter), so the
   * same run always samples the same way and no extra `generateId()` is drawn.
   */
  sampleRate?: number;
  /**
   * When an UNSAMPLED run fails, still emit one minimal `run.failed` carrying
   * only error category/code/status + identity — no content, no metadata.
   * Default true.
   */
  sampleErrors?: boolean;
  /** App metadata merged into every event. */
  metadata?: ObserveAttributes;
  capture?: ObservationCaptureOptions;
  limits?: ObservationLimits;
  /** Runs AFTER default secret redaction — it can further redact, never restore. */
  redact?: ObservationRedactor;
}

/** Raw-content capture. Everything defaults to false (counts/ids/enums are always safe). */
export interface ObservationCaptureOptions {
  /** Raw message content on run/model start events. Default false. */
  messages?: boolean;
  /** Model-produced text on completion events. Default false. */
  outputText?: boolean;
  /** Reasoning content. Default false. */
  reasoning?: boolean;
  /** Tool input payloads. Default false. */
  toolInputs?: boolean;
  /** Tool output payloads. Default false. */
  toolOutputs?: boolean;
  /** Error message text (name/code/category are always recorded). Default false. */
  errorMessages?: boolean;
  /** Sanitized provider metadata. Default false. */
  providerMetadata?: boolean;
}

/**
 * Structural payload limits, applied during snapshot (never via
 * JSON.stringify on the hot path). Overflow replaces the excess with
 * "[Truncated]" and sets `truncated: true` on the event — the event is never
 * dropped and the run is never affected. `maxEventBytes` is enforced only by
 * serializing sinks (the JSONL observer), per emitted line.
 */
export interface ObservationLimits {
  /** Default 4096. */
  maxStringLength?: number;
  /** Default 100. */
  maxArrayLength?: number;
  /** Default 6. */
  maxObjectDepth?: number;
  /** Default 100. */
  maxObjectKeys?: number;
  /** Default 65536 (64 KiB). Serializing sinks only. */
  maxEventBytes?: number;
}

export type ObservationRedactor = (
  value: unknown,
  context: {
    eventType: ObserveEvent['type'];
    field:
      | 'messages'
      | 'output'
      | 'reasoning'
      | 'tool-input'
      | 'tool-output'
      | 'error'
      | 'provider-metadata'
      | 'metadata';
  },
) => unknown;

// ---------------------------------------------------------------------------
// Normalized error
// ---------------------------------------------------------------------------

/**
 * Safe error snapshot. Category derives from `DeuzError.code` (stable
 * strings), never from class names; the authentication/authorization split
 * branches on AuthenticationError.statusCode 401 vs 403. `message` exists only
 * when `capture.errorMessages` is on, and always passes redaction first. The
 * cause chain is never serialized.
 */
export interface ObservedError {
  name: string;
  category:
    | 'authentication'
    | 'authorization'
    | 'rate-limit'
    | 'overloaded'
    | 'timeout'
    | 'network'
    | 'provider'
    | 'validation'
    | 'tool'
    | 'approval'
    | 'checkpoint'
    | 'aborted'
    | 'unknown';
  code?: string;
  statusCode?: number;
  retryable?: boolean;
  provider?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Event base + identity
// ---------------------------------------------------------------------------

export interface ObserveEventBase {
  schemaVersion: 1;

  /** Unique per event (`deps.generateId()`). */
  eventId: string;
  /** 0-based, +1 monotonic within one `executionId`. Emit order = sequence order. */
  sequence: number;
  /** `deps.clock.now()`. */
  timestamp: number;

  /**
   * Logical top-level run. Durable runs adopt the session runId
   * (`session.runId ?? generateId()`); sub-agents inherit the parent's runId
   * and differ by `agentPath`.
   */
  runId: string;
  /**
   * One execution leg of a run. A resume (after approval/crash) keeps the
   * runId but gets a fresh executionId; `sequence` restarts per leg.
   */
  executionId: string;

  /** Timeline node: run → step → (model | tool | compaction) → sub-agent run. */
  spanId: string;
  parentSpanId?: string;

  /** Sub-agent chain (same mechanism as `CommonCallOptions.agentPath`). */
  agentPath?: readonly string[];
  /** Loop step counter (0-based, continues across durable legs). */
  stepIndex?: number;

  metadata?: ObserveAttributes;
  /** Set when structural limits replaced part of the payload with "[Truncated]". */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Run events
// ---------------------------------------------------------------------------

export interface RunStartedEvent extends ObserveEventBase {
  type: 'run.started';

  /**
   * The public entry point. Resume legs keep the underlying operation
   * ('generate-text' buffered / 'stream-chat' streaming) and set `resumed`.
   */
  operation:
    | 'stream-chat'
    | 'generate-text'
    | 'generate-object'
    | 'stream-object'
    | 'embed'
    | 'embed-many';

  provider: string;
  model: string;
  surface: string;

  durable: boolean;
  resumed: boolean;
  /** Checkpoint stepId (`${runId}#${stepIndex}`) this leg resumed from. */
  resumeFromStepId?: string;
  resumeFromStepIndex?: number;

  /** Absent for embed operations. */
  messageCount?: number;
  toolCount?: number;

  /** Only with `capture.messages`. */
  capturedMessages?: unknown;
}

export interface RunCompletedEvent extends ObserveEventBase {
  type: 'run.completed';
  status: 'completed';
  durationMs: number;

  /** Canonical FinishReason of the final step. */
  finishReason: string;
  /**
   * Why the loop ended — broader than finishReason. 'runaway-tool-errors'
   * (MAX_SAME_TOOL_ERRORS guard) is otherwise invisible in results today.
   */
  endReason: 'natural' | 'stop-condition' | 'max-steps' | 'runaway-tool-errors';
  /** Existing `shouldStop` output (providerMetadata.deuz.stoppedBy) when a stop condition fired. */
  stoppedBy?: string;

  stepCount: number;
  /** Includes compaction summarize side-calls. */
  modelCallCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  deniedToolCount: number;
  retryCount: number;
  approvalCount: number;
  checkpointCount: number;
  subAgentCount: number;

  /** THIS leg's usage (same semantics as the call result). */
  usage: Usage;
  /** Durable runs: cumulative across all legs (checkpoint semantics). */
  cumulativeUsage?: Usage;
  /** Present only when `deps.priceProvider` resolved synchronously. */
  costUsd?: number;
}

export interface RunSuspendedEvent extends ObserveEventBase {
  type: 'run.suspended';
  status: 'suspended';

  /**
   * Derived at the loop break site (checkpoints carry no reason).
   * 'client-tool' also covers unknown/hallucinated tool names.
   */
  reason: 'approval' | 'client-tool' | 'sub-agent-approval';

  durationMs: number;
  /** 0 is legal — pure client-tool suspensions persist no approvals. */
  pendingApprovalCount: number;
  /** Unanswered client-tool calls. */
  pendingToolCount: number;
  checkpointStepId?: string;
  checkpointStepIndex?: number;
  usage: Usage;
}

export interface RunAbortedEvent extends ObserveEventBase {
  type: 'run.aborted';
  status: 'aborted';
  durationMs: number;
  /**
   * Honest partials only: a single-turn mid-stream abort usually reports
   * zeros (usage arrives on the 'finish' part); real partial usage exists
   * only for completed loop steps.
   */
  usage: Usage;
}

export interface RunFailedEvent extends ObserveEventBase {
  type: 'run.failed';
  status: 'failed';
  durationMs: number;
  error: ObservedError;
  stepCount: number;
  modelCallCount: number;
  toolCallCount: number;
  retryCount: number;
  /** Loop failures carry accumulated usage; single-turn errors have none. */
  partialUsage?: Usage;
}

// ---------------------------------------------------------------------------
// Model events (one model.started per model call — retries live inside it)
// ---------------------------------------------------------------------------

export interface ModelStartedEvent extends ObserveEventBase {
  type: 'model.started';

  provider: string;
  /** EFFECTIVE per-step model (after prepareStep). */
  model: string;
  surface: string;

  /** Marks compaction summarize side-calls; absent on normal calls. */
  purpose?: 'compaction-summary';
  maxRetries: number;

  messageCount: number;
  toolCount: number;

  responseFormat?: 'text' | 'json';
  /** The REQUESTED value (only effective on Anthropic models with caching). */
  promptCaching?: 'auto' | 'auto-1h';
  inputModalities?: readonly string[];

  capturedMessages?: unknown;
}

export interface ModelFirstContentEvent extends ObserveEventBase {
  type: 'model.first-content';
  provider: string;
  model: string;
  /** tool-call counts as first content (TTFT) as of 1.6. */
  contentType: 'text' | 'reasoning' | 'tool-call';
  /** Measured from before the retry loop — includes backoff time. */
  ttftMs: number;
}

export interface ModelRetryEvent extends ObserveEventBase {
  type: 'model.retry';
  provider: string;
  model: string;

  /** 0-based: 0 = the first attempt failed. */
  failedAttempt: number;
  nextAttempt: number;

  delayMs: number;
  retryAfterMs?: number;

  /** No 'timeout': TimeoutError is never retried. */
  reason: 'network' | 'rate-limit' | 'overloaded' | 'server-error';
  statusCode?: number;
  /** DeuzError.code: 'network_error' | 'rate_limit' | 'overloaded' | 'api_call_error'. */
  errorCode?: string;
}

export interface ModelCompletedEvent extends ObserveEventBase {
  type: 'model.completed';
  provider: string;
  model: string;

  durationMs: number;
  ttftMs?: number;

  /** Retries performed; 0 = first-try success. */
  retryCount: number;
  /** A user abort completes the model call with finishReason 'aborted' (not model.failed). */
  finishReason: string;
  usage: Usage;

  outputTextLength: number;
  reasoningLength: number;
  toolCallCount: number;

  capturedOutputText?: string;
  capturedReasoning?: string;
  capturedProviderMetadata?: unknown;
}

export interface ModelFailedEvent extends ObserveEventBase {
  type: 'model.failed';
  provider: string;
  model: string;
  durationMs: number;
  ttftMs?: number;
  retryCount: number;
  error: ObservedError;
}

// ---------------------------------------------------------------------------
// Agent step events
// ---------------------------------------------------------------------------

export interface StepStartedEvent extends ObserveEventBase {
  type: 'step.started';
  /** Effective model after applyPrepareStep. */
  model: string;
  /** History size after compaction + prepareStep. */
  messageCount: number;
  /** Calibrated ESTIMATE (compaction estimator) — never provider-reported usage. */
  estimatedInputTokens?: number;
  /** After activeTools/prepareStep filtering. */
  activeToolCount: number;
  /** durableUsage: all prior steps + legs + sub-agents. */
  cumulativeUsage: Usage;
}

export interface StepCompletedEvent extends ObserveEventBase {
  type: 'step.completed';
  durationMs: number;
  finishReason: string;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  deniedToolCount: number;
  /** This step's usage (StepResult.usage). */
  usage: Usage;
  cumulativeUsage: Usage;
  stoppedBy?: string;
}

// ---------------------------------------------------------------------------
// Tool events
// ---------------------------------------------------------------------------

export interface ToolStartedEvent extends ObserveEventBase {
  type: 'tool.started';
  toolCallId: string;
  toolName: string;

  /** The Tool field's real name (not "requiresApproval"). */
  needsApproval: boolean;

  /**
   * DERIVED: 'server' = has execute; 'client' = no execute and not a provider
   * tool. Provider-executed tools (type 'provider') never enter executeTools
   * and emit NO tool events — their footprint is 'source' stream parts and
   * Usage.serverToolUses.
   */
  executionMode: 'server' | 'client';

  /** More than one call in this step's batch. */
  parallel: boolean;
  capturedInput?: unknown;
}

export interface ToolCompletedEvent extends ObserveEventBase {
  type: 'tool.completed';
  toolCallId: string;
  toolName: string;
  durationMs: number;
  outputType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'undefined';
  /** String outputs only (length); no stringify is performed to measure. */
  outputSize?: number;
  capturedOutput?: unknown;
}

export interface ToolFailedEvent extends ObserveEventBase {
  type: 'tool.failed';
  toolCallId: string;
  toolName: string;
  durationMs: number;
  /** True when the error became an is_error tool_result fed back to the model. */
  selfHealed: boolean;
  /** bumpErrorGuard counter for this tool (hard stop at 3). */
  consecutiveFailureCount: number;
  error: ObservedError;
}

export interface ToolDeniedEvent extends ObserveEventBase {
  type: 'tool.denied';
  toolCallId: string;
  toolName: string;

  /**
   * Synthesized at the deny site — no such enum exists in results. Signature
   * verification outcomes are NOT observable here: ApprovalSigner.verify()
   * collapses all failures to null and runs outside the loop.
   */
  cause: 'server-denied' | 'response-denied' | 'no-response' | 'client-tool-no-result';

  /** Free-text verdict reason (ToolApprovalResponse.reason), when present. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Approval events
// ---------------------------------------------------------------------------

export interface ApprovalRequestedEvent extends ObserveEventBase {
  type: 'approval.requested';
  /** Equals toolCallId today; kept distinct for the signed scheme. */
  approvalId: string;
  toolCallId: string;
  toolName: string;
  /** 'server' when approveToolCall is provided, else 'client'. */
  mode: 'server' | 'client';
  /** Only with `capture.toolInputs`. */
  capturedInput?: unknown;
}

export interface ApprovalResolvedEvent extends ObserveEventBase {
  type: 'approval.resolved';
  approvalId: string;
  toolCallId: string;
  toolName: string;

  approved: boolean;
  /** 'default-deny' covers verdict-less settles ('No approval response.' etc.). */
  source: 'server' | 'client-response' | 'default-deny';

  /** Resume legs only: clock.now() - checkpoint.createdAt. */
  waitDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Durable checkpoint events
// ---------------------------------------------------------------------------

export interface CheckpointSavedEvent extends ObserveEventBase {
  type: 'checkpoint.saved';
  checkpointRunId: string;
  /** `${runId}#${stepIndex}`. */
  stepId: string;
  /** AgentCheckpoint.stepIndex — 1-based BOUNDARY counter (distinct from base stepIndex). */
  checkpointStepIndex: number;
  checkpointStatus: 'running' | 'suspended' | 'completed';
  /** store.save duration. */
  durationMs: number;
  messageCount: number;
  pendingApprovalCount: number;
  /** CUMULATIVE across legs (checkpoint semantics). */
  usage: Usage;
}

export interface CheckpointLoadedEvent extends ObserveEventBase {
  type: 'checkpoint.loaded';
  checkpointRunId: string;
  stepId: string;
  checkpointStepIndex: number;
  /** Not validated by resume — may be 'completed'. */
  checkpointStatus: string;
  /** store.load duration. */
  durationMs: number;
  messageCount: number;
  pendingApprovalCount: number;
  /** clock.now() - checkpoint.createdAt (≈ approval wait). */
  checkpointAgeMs?: number;
}

export interface CheckpointFailedEvent extends ObserveEventBase {
  type: 'checkpoint.failed';
  operation: 'save' | 'load';
  checkpointRunId: string;
  stepId?: string;
  durationMs: number;
  /** Load: CheckpointNotFoundError → code 'checkpoint_not_found'. */
  error: ObservedError;
  /** Save failures never kill the run (true); load failures fail the resume (false). */
  runContinued: boolean;
}

// ---------------------------------------------------------------------------
// Compaction events (one per APPLIED layer — mirrors the internal CompactionEvent)
// ---------------------------------------------------------------------------

/**
 * Named CompactionObserveEvent deliberately: inference/compaction.ts already
 * exports an internal `CompactionEvent` interface.
 */
export interface CompactionObserveEvent extends ObserveEventBase {
  type: 'compaction';
  layer: 'prune-tool-results' | 'prune-reasoning' | 'summarize';
  /** The only trigger — there is no manual compaction API. */
  trigger: 'threshold';
  threshold: number;
  /** Frozen at loop setup from the registry (not re-read per step). */
  contextWindow: number;
  /** Calibrated ESTIMATES, never provider-reported usage. */
  tokensBefore: number;
  tokensAfter: number;
  messageCountBefore: number;
  messageCountAfter: number;
  durationMs: number;
}

/** A layer was skipped (today: summarize threw or had too little to work with). Never fails the run. */
export interface CompactionSkippedEvent extends ObserveEventBase {
  type: 'compaction.skipped';
  layer: 'prune-tool-results' | 'prune-reasoning' | 'summarize';
  reason: string;
}

// ---------------------------------------------------------------------------
// Sub-agent events (identity = parent runId + agentPath)
// ---------------------------------------------------------------------------

export interface SubAgentStartedEvent extends ObserveEventBase {
  type: 'subagent.started';
  agentName: string;
  /** agentPath.length. */
  depth: number;
  parentToolCallId: string;
  model: string;
  durable: boolean;
  /** Durable only: `${parentRunId}::${name}#${toolCallId}` (the child's store key). */
  childRunId?: string;
}

export interface SubAgentCompletedEvent extends ObserveEventBase {
  type: 'subagent.completed';
  agentName: string;
  depth: number;
  durationMs: number;
  stepCount: number;
  /** Already folded into the parent's totals via reportUsage — never sum twice. */
  usage: Usage;
}

export interface SubAgentSuspendedEvent extends ObserveEventBase {
  type: 'subagent.suspended';
  agentName: string;
  depth: number;
  durationMs: number;
  pendingApprovalCount: number;
}

export interface SubAgentFailedEvent extends ObserveEventBase {
  type: 'subagent.failed';
  agentName: string;
  depth: number;
  durationMs: number;
  /** maxDepth overruns land here too (self-healed Error). */
  error: ObservedError;
}

// ---------------------------------------------------------------------------
// Cost (async priceProvider resolution — may arrive after the terminal event)
// ---------------------------------------------------------------------------

export interface CostCalculatedEvent extends ObserveEventBase {
  type: 'cost.calculated';
  target: 'model' | 'run';
  provider: string;
  model: string;
  usage: Usage;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Auxiliary subsystem operations
// ---------------------------------------------------------------------------

export type ObservedSubsystem =
  | 'embedding'
  | 'image'
  | 'midjourney'
  | 'rag'
  | 'memory'
  | 'mcp'
  | 'skills';

export interface OperationStartedEvent extends ObserveEventBase {
  type: 'operation.started';
  subsystem: ObservedSubsystem;
  operation: string;
  itemCount?: number;
}

export interface OperationCompletedEvent extends ObserveEventBase {
  type: 'operation.completed';
  subsystem: ObservedSubsystem;
  operation: string;
  durationMs: number;
  itemCount?: number;
  resultCount?: number;
  usage?: Usage;
}

export interface OperationFailedEvent extends ObserveEventBase {
  type: 'operation.failed';
  subsystem: ObservedSubsystem;
  operation: string;
  durationMs: number;
  error: ObservedError;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type ObserveEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunSuspendedEvent
  | RunAbortedEvent
  | RunFailedEvent
  | ModelStartedEvent
  | ModelFirstContentEvent
  | ModelRetryEvent
  | ModelCompletedEvent
  | ModelFailedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolDeniedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | CheckpointSavedEvent
  | CheckpointLoadedEvent
  | CheckpointFailedEvent
  | CompactionObserveEvent
  | CompactionSkippedEvent
  | SubAgentStartedEvent
  | SubAgentCompletedEvent
  | SubAgentSuspendedEvent
  | SubAgentFailedEvent
  | CostCalculatedEvent
  | OperationStartedEvent
  | OperationCompletedEvent
  | OperationFailedEvent;
