/**
 * The goal supervisor (2.4, spec §3.1): a library loop in the host process
 * that drives goals to completion with the existing native executor. It claims
 * a goal through the existing `LeaseProvider` (`goal:` key), fences every
 * write with `GoalRuntimeStore` revisions, applies the inbox, records run
 * intents before launching, persists cancels so none is lost, drains on lease
 * loss, retries what the native run marks retryable, and charges ledger
 * differences above a watermark exactly once.
 *
 * This module never imports `agent-run.ts` statically: runs start through the
 * `RunLauncher` seam (testable without `runAgent`), and the native launcher
 * loads the executor lazily. Edge-safe.
 */
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../../types/agent-run-v3';
import type { AgentResult, AgentRunLeaseOptions } from '../../types/agent-run';
import type { BudgetTotals } from '../../types/execution';
import type { Dependencies } from '../../types/deps';
import type { LeaseProvider } from '../../types/lease';
import type { ToolApprovalResponse } from '../../types/tool';
import type { WorkingMemorySnapshot } from '../../context/working-memory/types';
import { notImplemented } from '../../internal/not-implemented';
import type { CreateGoalInput } from '../transition';
import type {
  GoalCommand,
  GoalEvent,
  GoalListPage,
  GoalListQuery,
  GoalRecord,
  GoalTransition,
} from '../types';
import type {
  GoalInboxEnqueueResult,
  GoalRunIntent,
  GoalRuntimePolicy,
  GoalRuntimeState,
  GoalRuntimeStore,
} from './store-types';

/** The supervisor defaults (spec §3.1). */
export const DEFAULT_GOAL_SUPERVISOR = {
  /** Goals driven at once. */
  concurrency: 1,
  /** The goal lease. */
  leaseTtlMs: 30_000,
  /** `start()` ticks this often. */
  pollMs: 1_000,
} as const;

/** The goal lease key (2.4): `goal:` and the JSON of `[scope, goalId]`. */
export function goalLeaseKey(scope: string, goalId: string): string {
  return `goal:${JSON.stringify([scope, goalId])}`;
}

/** What the supervisor asks a launcher to start or resume. */
export interface RunLaunchRequest {
  scope: string;
  goalId: string;
  intentId: string;
  /** The V3 run: the same id on every attempt of an intent. */
  runId: string;
  attempt: number;
  goal: GoalRecord;
  /** The inherited working memory (scope and `specGeneration` matched). */
  workingMemory?: WorkingMemorySnapshot;
  /** Stored verdicts for a retried call that waited on approval. */
  approvalResponses?: ToolApprovalResponse[];
  /** Results for parked client tool calls, on a resume. */
  clientToolResults?: readonly { toolCallId: string; output: unknown; isError?: boolean }[];
  signal?: AbortSignal;
}

/** How a launched run ended (for this leg). */
export interface RunLaunchResult {
  runId: string;
  result: AgentResult<unknown>;
  /** The native run marked the failure retryable (`AgentRunEnvelope.retry`). */
  retryable?: boolean;
  /** The run's working memory at the end of the leg. */
  workingMemory?: WorkingMemorySnapshot;
}

/**
 * The seam between the supervisor and the native executor (2.4): start,
 * resume, cancel or drain a V3 run for a goal. Implementations must be
 * idempotent per `runId` (a repeated launch of a stored run resumes it).
 */
export interface RunLauncher {
  launch(request: RunLaunchRequest): Promise<RunLaunchResult>;
  resume(request: RunLaunchRequest): Promise<RunLaunchResult>;
  /**
   * Asks the run to stop for good. False when no executor holds it: the
   * cancel then waits in the store and applies at the run's next claim.
   */
  cancel(request: { scope: string; runId: string; reason?: string }): Promise<boolean>;
  /** Asks the run to stop at its next safe checkpoint, resumable. */
  drain(request: { scope: string; runId: string }): Promise<boolean>;
  /** The run's durable ledger totals, for watermark accounting. */
  accounting?(request: { scope: string; runId: string }): Promise<BudgetTotals | undefined>;
}

/** Options of `createNativeRunLauncher`. */
export interface NativeRunLauncherOptions {
  store: AgentRunStoreV3;
  /** The run options for a request; the session, run id and approvals are filled in. */
  options: (
    request: RunLaunchRequest,
  ) =>
    | Omit<AgentRunOptionsV3<unknown>, 'session' | 'checkpointVersion'>
    | Promise<Omit<AgentRunOptionsV3<unknown>, 'session' | 'checkpointVersion'>>;
  /** The native run's own lease, apart from the goal lease. */
  lease?: AgentRunLeaseOptions;
}

/** A goal and its runtime state. */
export interface GoalSupervision {
  goal: GoalRecord;
  runtime: GoalRuntimeState;
}

/** What `submit` takes: a new goal and, optionally, its policy. */
export interface GoalSubmitInput extends CreateGoalInput {
  policy?: Partial<GoalRuntimePolicy>;
  /** Record a start intent right away. Default true. */
  start?: boolean;
}

/** What `resume` passes to a suspended goal run. */
export interface GoalResumeInput {
  approvalResponses?: ToolApprovalResponse[];
  clientToolResults?: readonly { toolCallId: string; output: unknown; isError?: boolean }[];
}

/** What the supervisor reports as it works. */
export type GoalSupervisorEvent =
  | { type: 'claimed'; scope: string; goalId: string; token: number }
  | { type: 'lease-lost'; scope: string; goalId: string }
  | {
      type: 'inbox-applied';
      scope: string;
      goalId: string;
      entryId: string;
      disposition: string;
    }
  | { type: 'dispatched'; scope: string; goalId: string; intent: GoalRunIntent }
  | { type: 'retry-scheduled'; scope: string; goalId: string; attempt: number; at: number }
  | { type: 'cancel-requested'; scope: string; goalId: string }
  | { type: 'cancel-applied'; scope: string; goalId: string; runId?: string }
  | { type: 'drained'; scope: string; goalId: string; runId?: string }
  | { type: 'generation-changed'; scope: string; goalId: string; specGeneration: number }
  | {
      type: 'run-ended';
      scope: string;
      goalId: string;
      runId: string;
      status: AgentResult['status'];
    }
  | { type: 'policy-limit'; scope: string; goalId: string; limit: 'runs' | 'retries' };

/** What one tick did. */
export interface GoalSupervisorTickResult {
  /** Inbox entries settled. */
  applied: number;
  /** Runs launched or resumed. */
  dispatched: number;
  /** Cancels applied. */
  cancelled: number;
  /** Goals whose lease another supervisor holds. */
  skipped: number;
}

/** Options of `createGoalSupervisor`. */
export interface GoalSupervisorOptions {
  store: GoalRuntimeStore;
  launcher: RunLauncher;
  /** The goal lease: key `goalLeaseKey(scope, goalId)`, 30 s by default. */
  lease: { provider: LeaseProvider; owner?: string; ttlMs?: number };
  /** Only goals of these scopes. Default: every scope. */
  scopes?: readonly string[];
  /** Default 1. */
  concurrency?: number;
  /** Default 1000. */
  pollMs?: number;
  /** Policy defaults for new goals (`DEFAULT_GOAL_RUNTIME_POLICY` otherwise). */
  policy?: Partial<GoalRuntimePolicy>;
  /** Clock, ids, logger, observer (`deuz.goal.*` spans). */
  deps?: Dependencies;
}

/**
 * The goal supervisor (2.4). `submit` creates a supervised goal; `get`/`list`
 * read; `dispatch` queues an event in a goal's inbox (deduplicated; a known
 * id with other content throws `GoalError('delivery_conflict')`); `command`
 * applies a host command at an expected revision (a cancel is recorded, then
 * applied); `resume` answers a suspended run; `updatePolicy` changes limits
 * at an expected runtime revision (the only way to raise them); `events`
 * streams what it does; `tick` runs one pass; `start` loops on the injected
 * clock; `drain` stops taking work and brings running runs to a safe
 * checkpoint.
 */
export interface GoalSupervisor {
  submit(input: GoalSubmitInput): Promise<GoalSupervision>;
  get(scope: string, goalId: string): Promise<GoalSupervision | undefined>;
  list(query: GoalListQuery & { scope: string }): Promise<GoalListPage>;
  dispatch(
    event: GoalEvent,
    options?: {
      namespace?: string;
      deliveryId?: string;
      payload?: { body: string; mediaType?: string };
    },
  ): Promise<GoalInboxEnqueueResult>;
  command(
    scope: string,
    goalId: string,
    command: GoalCommand,
    options?: { expectedRevision?: number },
  ): Promise<GoalTransition>;
  resume(scope: string, goalId: string, input: GoalResumeInput): Promise<void>;
  updatePolicy(
    scope: string,
    goalId: string,
    policy: Partial<GoalRuntimePolicy>,
    options: { expectedRevision: number },
  ): Promise<GoalRuntimeState>;
  events(options?: { signal?: AbortSignal }): AsyncIterable<GoalSupervisorEvent>;
  tick(options?: { now?: number; signal?: AbortSignal }): Promise<GoalSupervisorTickResult>;
  start(options?: { signal?: AbortSignal }): { stop(): Promise<void> };
  drain(): Promise<void>;
}

/**
 * A goal supervisor (2.4). Per goal: claims the `goal:` lease (one active
 * executor), applies due inbox entries with `transitionGoal` and
 * `store.inbox.apply`, records a run intent before every launch, launches at
 * most `policy.maxRuns` automatic runs and `policy.maxRetries` retries of a
 * retryable failure (1/5/30 s apart; `policy_limit` once spent), hands the
 * last working memory to the next run only when scope and `specGeneration`
 * match, retries an approval-gated call with its stored verdict, and charges
 * ledger differences above the run's watermark once (unknown amounts held as
 * reservations; a late charge never reopens a completed goal). On lease loss
 * it drains the native run it started and starts nothing new
 * (`lease_lost`). A cancel is recorded first and applied at the run's next
 * claim, so an idle run's cancel is never lost.
 */
export function createGoalSupervisor(_options: GoalSupervisorOptions): GoalSupervisor {
  return notImplemented('createGoalSupervisor');
}

/**
 * The native `RunLauncher` (2.4): runs, resumes and reconciles V3 runs with
 * the existing executor, loaded with a lazy `import()` so `/goal/runtime`
 * never bundles it statically. Cancel and drain go through the native run's
 * lease.
 */
export function createNativeRunLauncher(_options: NativeRunLauncherOptions): RunLauncher {
  return notImplemented('createNativeRunLauncher');
}
