import type { DeuzAgent } from '../agent';
import type { LeaseProvider } from './lease';
import type { AgentRunEnvelope, AgentRunOptions, AgentResult } from './agent-run';
import type { Dependencies } from './deps';
import type { ToolApprovalResponse } from './tool';
import type {
  BudgetAdmission,
  BudgetLimits,
  ExecutionContextSnapshot,
  ExecutionPolicy,
  NativeExecutionContext,
} from './execution';

/** Independent of the legacy RunStatus and UI wire unions. */
export type SwarmTaskStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'needs_reconciliation';
export type SwarmRunStatus = 'running' | 'completed' | 'partial' | 'suspended' | 'cancelled';

interface SwarmTaskBase {
  id: string;
  /** Tasks that must COMPLETE first; a failed one blocks this task. */
  dependsOn?: readonly string[];
  /**
   * Tasks that must SETTLE first, in any terminal state (2.2). Their completed
   * results arrive like dependencies; a failed one does not block this task.
   */
  after?: readonly string[];
  /** Manual (default) never repeats interrupted work without explicit authorization. */
  replay?: 'manual' | 'safe';
  /** Wall-clock budget for each attempt (2.2); expiry fails the task. */
  timeoutMs?: number;
  /**
   * Blackboard group (2.2): the task posts to this channel and, with
   * read: 'group', reads it. Letters, digits and underscores, starting with a
   * letter. Tasks without a group share the 'main' channel.
   */
  group?: string;
}

export type SwarmTask =
  | (SwarmTaskBase & { agent: string; prompt: string; reducer?: never })
  | (SwarmTaskBase & { reducer: string; agent?: never; prompt?: never });

/**
 * A task created at runtime by a finished task (2.2). Its ID is
 * `${parentId}/${key}`; `dependsOn` lists full IDs of existing tasks or of
 * tasks spawned in the same request.
 */
export type SwarmSpawnRequest =
  | (Omit<SwarmTaskBase, 'id'> & { key: string; agent: string; prompt: string; reducer?: never })
  | (Omit<SwarmTaskBase, 'id'> & { key: string; reducer: string; agent?: never; prompt?: never });

/** What a spawning task knows when it spawns (2.2). */
export interface SwarmSpawnContext extends SwarmKey {
  taskId: string;
  /** 0 for a root task. */
  depth: number;
  /** Results of the finished task's direct dependencies. */
  dependencies: Readonly<Record<string, SwarmTaskResult>>;
}

/** What a failed task's compensation hook receives (2.2). */
export interface SwarmFailureContext extends SwarmSpawnContext {
  error: { name: string; message: string; code?: string };
}

/** Bounds on runtime task spawning (2.2). */
export interface SwarmDynamicLimits {
  /** Upper bound on the run's task count, root tasks included (at most 10 000). */
  maxTasks: number;
  /** Spawn generations allowed below a root task (at most 64). */
  maxSpawnDepth: number;
  /** Tasks one finished task may spawn; defaults to maxTasks. */
  maxSpawnPerTask?: number;
}

/** A persistence feature a store supports (2.2). */
export type SwarmStoreCapability = 'spawn' | 'channels' | 'list';

/** One durable blackboard note (2.2), ordered within its channel. */
export interface SwarmChannelEntry {
  channel: string;
  /** 1-based, gapless within the channel. */
  sequence: number;
  /** Idempotency key: an identical repeat is a no-op, a different one is rejected. */
  entryId: string;
  taskId: string;
  attempt: number;
  text: string;
  data?: unknown;
  at: number;
}

/** A note to append (2.2); the store assigns its sequence. */
export type SwarmChannelPost = Omit<SwarmChannelEntry, 'sequence'>;

export interface SwarmTaskResult {
  output: unknown;
  text?: string;
  agentResult?: AgentResult<unknown>;
}

export interface SwarmTaskRecord {
  task: SwarmTask;
  bindingVersion: string;
  status: SwarmTaskStatus;
  attempt: number;
  /** Resolved once, before dispatch; immutable across recovery. */
  resolvedPrompt?: string;
  agentState?: AgentRunEnvelope;
  result?: SwarmTaskResult;
  error?: { name: string; message: string; code?: string };
  startedAt?: number;
  finishedAt?: number;
  /** Set on a spawned task (2.2): the parent attempt that created it. */
  spawnedBy?: { taskId: string; attempt: number; on: 'completed' | 'failed' };
  /** Spawn depth (2.2); absent means 0. */
  depth?: number;
}

export interface SwarmKey {
  scope: string;
  runId: string;
}

export interface SwarmRunRecord extends SwarmKey {
  kind: 'deuz-swarm';
  /** Version 2 (2.2) marks a dynamic run; 2.1 rejects it. */
  version: 1 | 2;
  definitionVersion: string;
  status: SwarmRunStatus;
  revision: number;
  lastSequence: number;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  executionState?: ExecutionContextSnapshot;
  /** Version 2: the limits fixed at creation; resume can only tighten them. */
  dynamic?: Required<SwarmDynamicLimits>;
}

export interface SwarmSnapshot {
  run: SwarmRunRecord;
  tasks: SwarmTaskRecord[];
}

export interface SwarmEventInput {
  type:
    | 'run.started'
    | 'run.resumed'
    | 'run.settled'
    | 'run.cancelled'
    | 'run.drained'
    | 'task.started'
    | 'task.completed'
    | 'task.failed'
    | 'task.suspended'
    | 'task.blocked'
    | 'task.cancelled'
    | 'task.reconciliation'
    | 'task.spawned'
    | 'channel.posted';
  taskId?: string;
  timestamp: number;
  /** Small control metadata only; task output is retrieved from the snapshot. */
  detail?: string;
}

export interface SwarmEvent extends SwarmEventInput, SwarmKey {
  version: 1;
  sequence: number;
}

export interface SwarmCommit extends SwarmKey {
  expectedRevision: number;
  run?: Partial<
    Pick<SwarmRunRecord, 'status' | 'updatedAt' | 'cancelRequested' | 'executionState'>
  >;
  tasks?: readonly SwarmTaskRecord[];
  /** Tasks created by this commit (2.2); each commits with its parent's terminal state. */
  spawn?: readonly SwarmTaskRecord[];
  /**
   * Blackboard notes to append (2.2). The store journals a channel.posted event
   * for each new one; an identical repeat is a no-op.
   */
  posts?: readonly SwarmChannelPost[];
  events?: readonly SwarmEventInput[];
}

/** Every commit is atomic, including its event rows. Failed writes MUST reject. */
export interface SwarmStore {
  /**
   * Features this store persists (2.2). A dynamic swarm requires 'spawn': a
   * store without it would silently drop spawned tasks from its commits.
   */
  readonly capabilities?: readonly SwarmStoreCapability[];
  create(snapshot: SwarmSnapshot, events: readonly SwarmEventInput[]): Promise<SwarmRunRecord>;
  load(key: SwarmKey): Promise<SwarmSnapshot | undefined>;
  /**
   * The run record alone (2.2). Event readers poll it instead of `load`, which
   * reads every task. Optional: a store without it falls back to `load`.
   */
  head?(key: SwarmKey): Promise<SwarmRunRecord | undefined>;
  commit(change: SwarmCommit): Promise<SwarmRunRecord>;
  /** A channel's notes after a sequence cursor (2.2); needs the 'channels' capability. */
  readChannel?(
    key: SwarmKey,
    channel: string,
    afterSequence: number,
    limit: number,
  ): Promise<SwarmChannelEntry[]>;
  readEvents(key: SwarmKey, afterSequence: number, limit: number): Promise<SwarmEvent[]>;
  /** Run records matching a query (2.2); needs the 'list' capability. */
  listRuns?(query: SwarmRunQuery): Promise<SwarmRunRecord[]>;
}

export interface SwarmAgentBinding {
  agent: DeuzAgent;
  /** Change when instructions, tools or output schema change incompatibly. */
  version?: string;
  output?: AgentRunOptions<unknown>['output'];
  /** Native validation, scoped context and projection; defaults to the template's tools. */
  tools?: AgentRunOptions<unknown>['tools'];
  toolsContext?: AgentRunOptions<unknown>['toolsContext'];
  verify?: AgentRunOptions<unknown>['verify'];
  maxOutputAttempts?: number;
  maxVerifyAttempts?: number;
  policy?: ExecutionPolicy;
  budget?: BudgetLimits;
  /** Tasks to create when this agent's task completes (2.2), from its accepted output. */
  spawn?: (
    output: unknown,
    context: SwarmSpawnContext,
  ) => readonly SwarmSpawnRequest[] | Promise<readonly SwarmSpawnRequest[]>;
  /** Compensation tasks to create when this agent's task fails (2.2). */
  onFailure?: (
    context: SwarmFailureContext,
  ) => readonly SwarmSpawnRequest[] | Promise<readonly SwarmSpawnRequest[]>;
  /**
   * Blackboard tools for this agent (2.2): blackboard_read over its group's
   * channel ('group') or the listed channels, and blackboard_post to its own
   * group. Both are idempotent on replay. Needs a store with 'channels'.
   */
  blackboard?: { read?: 'group' | readonly string[]; post?: boolean };
}

export interface SwarmReducerContext extends SwarmKey {
  taskId: string;
  signal: AbortSignal;
  execution: NativeExecutionContext;
  /** Queue tasks to create when this reducer completes (2.2); discarded if it throws. */
  spawn(requests: readonly SwarmSpawnRequest[]): void;
  /** Terminal statuses of the tasks this reducer runs after (2.2). */
  settled: Readonly<Record<string, SwarmTaskStatus>>;
  /** Page a blackboard channel after a sequence cursor (2.2); limit defaults to 100. */
  readChannel(
    channel: string,
    afterSequence?: number,
    limit?: number,
  ): Promise<SwarmChannelEntry[]>;
}

export interface SwarmReducerBinding {
  version?: string;
  policy?: ExecutionPolicy;
  budget?: BudgetLimits;
  execute(
    results: Readonly<Record<string, SwarmTaskResult>>,
    context: SwarmReducerContext,
  ): unknown | Promise<unknown>;
  /** Compensation tasks to create when this reducer fails (2.2). */
  onFailure?: (
    context: SwarmFailureContext,
  ) => readonly SwarmSpawnRequest[] | Promise<readonly SwarmSpawnRequest[]>;
}

export interface SwarmOptions {
  agents: Readonly<Record<string, DeuzAgent | SwarmAgentBinding>>;
  reducers?: Readonly<Record<string, SwarmReducerBinding>>;
  store: SwarmStore;
  concurrency?: number;
  definitionVersion?: string;
  deps?: Dependencies;
  policy?: ExecutionPolicy;
  budget?: BudgetLimits;
  /**
   * Persistent budget scopes (2.2): every task's model calls are also admitted
   * by this BudgetStore. The run records the scopes, so resuming it needs the
   * store again; scopes given on resume only add or tighten.
   */
  admission?: BudgetAdmission;
  /** Let finished tasks spawn tasks at runtime (2.2); needs a store with 'spawn'. */
  dynamic?: SwarmDynamicLimits;
  /**
   * Cross-process liveness (2.2). The executor holds the run's lease while it
   * drives it and renews it every ttlMs / 3; losing it stops the executor
   * before its next write, so another process can take the run over.
   */
  lease?: SwarmLeaseOptions;
}

export interface SwarmLeaseOptions {
  provider: LeaseProvider;
  /** This process's identity; defaults to a generated ID per swarm instance. */
  owner?: string;
  /** Default 30 000. */
  ttlMs?: number;
}

export interface SwarmRunOptions {
  scope: string;
  runId?: string;
  tasks: readonly SwarmTask[];
  signal?: AbortSignal;
}

export interface SwarmResumeOptions extends SwarmKey {
  signal?: AbortSignal;
  /** Verdicts remain scoped to their task even when providers reuse call ids. */
  approvals?: Readonly<Record<string, readonly ToolApprovalResponse[]>>;
  clientToolResults?: Readonly<Record<string, NonNullable<AgentRunOptions['clientToolResults']>>>;
  /** Explicit authorization to repeat interrupted, manually reconciled tasks. */
  retryTaskIds?: readonly string[];
  /** Reconciled native tool calls, keyed by task id; requires retryTaskIds for that task. */
  retryToolCallIds?: Readonly<Record<string, readonly string[]>>;
  /** Claim the run only at this revision (2.2); otherwise SwarmConflictError. */
  expectedRevision?: number;
  /** Claim the run only in this status (2.2); otherwise SwarmConflictError. */
  expectedStatus?: SwarmRunStatus;
}

/** A page of runs (2.2), ordered by updatedAt, then scope and runId. */
export interface SwarmRunQuery {
  status?: SwarmRunStatus;
  scope?: string;
  /** 1..1000. */
  limit: number;
}

export type SwarmOutcome = SwarmSnapshot;

export interface SwarmHandle extends SwarmKey {
  /** Settles at terminal completion or when only suspended/reconciliation work remains. */
  result: Promise<SwarmOutcome>;
  events(options?: { afterSequence?: number; signal?: AbortSignal }): AsyncIterable<SwarmEvent>;
  cancel(): Promise<void>;
  /**
   * Stop dispatching, let in-flight tasks finish, and settle (2.2): the run is
   * 'suspended' with its remaining tasks pending, or terminal if nothing
   * remains. A 'run.drained' event precedes 'run.settled'; the lease is released.
   */
  drain(): Promise<SwarmOutcome>;
}

/** What requestCancel did (2.2). */
export type SwarmCancelRequest = 'signalled' | 'recorded' | 'settled';

/** What recover did (2.2). */
export interface SwarmRecovery {
  /** The executors this call started, one per run it took over. */
  handles: SwarmHandle[];
  /**
   * Runs it could not resume, for example one whose definitionVersion or
   * bindings this process lacks. Runs with a live lease holder, or that moved
   * on while being claimed, are skipped silently instead.
   */
  failed: { key: SwarmKey; error: unknown }[];
}

export interface Swarm {
  run(options: SwarmRunOptions): Promise<SwarmHandle>;
  resume(options: SwarmResumeOptions): Promise<SwarmHandle>;
  get(key: SwarmKey): Promise<SwarmSnapshot | undefined>;
  events(
    key: SwarmKey,
    options?: { afterSequence?: number; signal?: AbortSignal },
  ): AsyncIterable<SwarmEvent>;
  /**
   * Cancel a run from any process (2.2): 'signalled' when this process or a
   * lease holder drives it, 'recorded' when nobody does (the next executor
   * cancels it), 'settled' when it already finished. A signalled cancel
   * outlives its holder: if the holder settles or dies before reading it, the
   * next executor to claim the run cancels it before dispatching anything.
   */
  requestCancel(key: SwarmKey): Promise<SwarmCancelRequest>;
  /**
   * Take over 'running' runs whose executor is gone (2.2). Needs the `lease`
   * option and a store with 'list'; runs with a live lease holder, or that
   * changed while being claimed, are skipped. One run's failure never stops
   * the others: it is reported in `failed`, and every executor the call
   * started is returned in `handles`.
   */
  recover(options?: { scope?: string; limit?: number }): Promise<SwarmRecovery>;
}
