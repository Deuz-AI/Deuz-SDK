import type { DeuzAgent } from '../agent';
import type { AgentRunEnvelope, AgentRunOptions, AgentResult } from './agent-run';
import type { Dependencies } from './deps';
import type { ToolApprovalResponse } from './tool';
import type {
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
  dependsOn?: readonly string[];
  /** Manual (default) never repeats interrupted work without explicit authorization. */
  replay?: 'manual' | 'safe';
}

export type SwarmTask =
  | (SwarmTaskBase & { agent: string; prompt: string; reducer?: never })
  | (SwarmTaskBase & { reducer: string; agent?: never; prompt?: never });

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
}

export interface SwarmKey {
  scope: string;
  runId: string;
}

export interface SwarmRunRecord extends SwarmKey {
  kind: 'deuz-swarm';
  version: 1;
  definitionVersion: string;
  status: SwarmRunStatus;
  revision: number;
  lastSequence: number;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  executionState?: ExecutionContextSnapshot;
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
    | 'task.started'
    | 'task.completed'
    | 'task.failed'
    | 'task.suspended'
    | 'task.blocked'
    | 'task.cancelled'
    | 'task.reconciliation';
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
  events?: readonly SwarmEventInput[];
}

/** Every commit is atomic, including its event rows. Failed writes MUST reject. */
export interface SwarmStore {
  create(snapshot: SwarmSnapshot, events: readonly SwarmEventInput[]): Promise<SwarmRunRecord>;
  load(key: SwarmKey): Promise<SwarmSnapshot | undefined>;
  /**
   * The run record alone (2.2). Event readers poll it instead of `load`, which
   * reads every task. Optional: a store without it falls back to `load`.
   */
  head?(key: SwarmKey): Promise<SwarmRunRecord | undefined>;
  commit(change: SwarmCommit): Promise<SwarmRunRecord>;
  readEvents(key: SwarmKey, afterSequence: number, limit: number): Promise<SwarmEvent[]>;
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
}

export interface SwarmReducerContext extends SwarmKey {
  taskId: string;
  signal: AbortSignal;
  execution: NativeExecutionContext;
}

export interface SwarmReducerBinding {
  version?: string;
  policy?: ExecutionPolicy;
  budget?: BudgetLimits;
  execute(
    results: Readonly<Record<string, SwarmTaskResult>>,
    context: SwarmReducerContext,
  ): unknown | Promise<unknown>;
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
}

export type SwarmOutcome = SwarmSnapshot;

export interface SwarmHandle extends SwarmKey {
  /** Settles at terminal completion or when only suspended/reconciliation work remains. */
  result: Promise<SwarmOutcome>;
  events(options?: { afterSequence?: number; signal?: AbortSignal }): AsyncIterable<SwarmEvent>;
  cancel(): Promise<void>;
}

export interface Swarm {
  run(options: SwarmRunOptions): Promise<SwarmHandle>;
  resume(options: SwarmResumeOptions): Promise<SwarmHandle>;
  get(key: SwarmKey): Promise<SwarmSnapshot | undefined>;
  events(
    key: SwarmKey,
    options?: { afterSequence?: number; signal?: AbortSignal },
  ): AsyncIterable<SwarmEvent>;
}
