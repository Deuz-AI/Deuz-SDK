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

import { resolveDependencies } from '../../internal/resolve-deps';
import { DEUZ_SPAN, recordSpan } from '../../internal/telemetry';
import { GoalError } from '../errors';
import { createGoal, transitionGoal } from '../transition';
import type { CreateGoalInput } from '../transition';
import { TERMINAL_STATUSES, checkGoalEvent } from '../validate';
import { goalDeliveryDigest } from './delivery';
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
import { createGoalDriver } from './supervisor-drive';
import { createNativeRunLauncher as createNative } from './supervisor-native';
import {
  createEventHub,
  goalAttributes,
  goalLeaseKey,
  intentIdFor,
  mergePolicy,
  quietly,
  reportGeneration,
  runIdFor,
} from './supervisor-shared';

/** How often a write that lost a revision race is decided again on fresh state. */
const WRITE_ATTEMPTS = 5;

/** A positive integer option (at least `min`), or its default. Throws a TypeError. */
function positive(value: number | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min)
    throw new TypeError(`Goal supervisor ${name} must be an integer of at least ${min}`);
  return value;
}

/** The supervisor defaults (spec §3.1). */
export const DEFAULT_GOAL_SUPERVISOR = {
  /** Goals driven at once. */
  concurrency: 1,
  /** The goal lease. */
  leaseTtlMs: 30_000,
  /** `start()` ticks this often. */
  pollMs: 1_000,
} as const;

export { goalLeaseKey };

/** What the supervisor asks a launcher to start or resume. */
export interface RunLaunchRequest {
  scope: string;
  goalId: string;
  intentId: string;
  /** The V3 run: the same id on every attempt of an intent. */
  runId: string;
  attempt: number;
  /**
   * What the intent asks (2.4 refinement): `'start'` a new run, `'resume'` a
   * suspended one, or `'retry'` a run whose failure the native layer marked
   * retryable (the native launcher resumes it with `retryFailed`).
   */
  kind?: GoalRunIntent['kind'];
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
  /**
   * The run's optional work after its verdict (2.4 refinement): its memory
   * extraction. A verified goal completes without waiting for a `'pending'` one.
   */
  maintenance?: 'pending' | 'complete' | 'failed';
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
  /**
   * Where the run's optional after-verdict work (memory extraction) stands
   * now (2.4 refinement); undefined when it has none. The supervisor asks
   * while a completed goal's maintenance is pending.
   */
  maintenance?(request: {
    scope: string;
    runId: string;
  }): Promise<'pending' | 'complete' | 'failed' | undefined>;
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
  /**
   * The host's verification of a run that completed (2.4 refinement): the
   * commands to apply, usually the `evaluate` command `verifyGoalAcceptance`
   * returns. The supervisor applies them, then tries `complete`; a goal that
   * stays active gets another automatic run (within `policy.maxRuns`).
   * Without it a goal completes only on evidence and verdicts the host
   * records through `command`.
   */
  verify?: (context: {
    goal: GoalRecord;
    runId: string;
    result: AgentResult<unknown>;
  }) =>
    | GoalCommand
    | readonly GoalCommand[]
    | undefined
    | Promise<GoalCommand | readonly GoalCommand[] | undefined>;
  /**
   * Whether a native run that a dependency wait names has finished (2.4
   * refinement), for `goalDependencyEvents`. Without it only goal
   * dependencies are reconciled.
   */
  runFinished?: (runId: string) => boolean | Promise<boolean>;
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
export function createGoalSupervisor(options: GoalSupervisorOptions): GoalSupervisor {
  const { store, launcher } = options;
  const deps = resolveDependencies(options.deps);
  const defaults = mergePolicy(undefined, options.policy);
  const provider = options.lease.provider;
  const hub = createEventHub<GoalSupervisorEvent>();

  /** A supervised goal and its state, read in `scope`; otherwise `scope_mismatch`. */
  async function supervised(scope: string, goalId: string): Promise<GoalSupervision> {
    const goal = await store.load(goalId, { scope });
    const runtime = goal ? await store.runtime.get(scope, goalId) : undefined;
    if (!goal || !runtime)
      throw new GoalError('scope_mismatch', `No supervised goal ${goalId} in scope ${scope}.`);
    return { goal, runtime };
  }

  function stale(goal: GoalRecord, expected: number): GoalError {
    return new GoalError(
      'revision_conflict',
      `Goal ${goal.goalId} is at revision ${goal.revision}, not ${expected}.`,
    );
  }

  const driver = createGoalDriver({
    store,
    launcher,
    deps,
    hub,
    provider,
    owner: options.lease.owner ?? `goal-supervisor:${deps.generateId()}`,
    ttlMs: positive(options.lease.ttlMs, DEFAULT_GOAL_SUPERVISOR.leaseTtlMs, 'lease.ttlMs', 3),
    scopes: options.scopes,
    concurrency: positive(options.concurrency, DEFAULT_GOAL_SUPERVISOR.concurrency, 'concurrency'),
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.runFinished ? { runFinished: options.runFinished } : {}),
  });
  const pollMs = positive(options.pollMs, DEFAULT_GOAL_SUPERVISOR.pollMs, 'pollMs');
  let started = false;

  /** A host command other than a cancel, saved with the runtime state as its fence. */
  async function applyCommand(
    goal: GoalRecord,
    runtime: GoalRuntimeState,
    command: GoalCommand,
    now: number,
  ): Promise<GoalTransition | 'conflict'> {
    const transition = transitionGoal(goal, command, { now });
    if (!transition.changed) return transition;
    const next = transition.record;
    const ended = TERMINAL_STATUSES.includes(next.status) && runtime.activeRun === undefined;
    const state: GoalRuntimeState = {
      ...runtime,
      revision: runtime.revision + 1,
      updatedAt: Math.max(runtime.updatedAt, now),
      ...(ended ? { phase: 'done' as const } : {}),
      // A cancel still waiting is settled by the goal's end: no run is left to stop.
      ...(ended && runtime.cancel !== undefined && runtime.cancel.appliedAt === undefined
        ? { cancel: { ...runtime.cancel, appliedAt: now } }
        : {}),
    };
    if ((await store.runtime.save(state, next)).status === 'conflict') return 'conflict';
    reportGeneration(deps, hub, goal, next);
    // A goal that ended under a working run: the run stops, its holder settles it.
    if (TERMINAL_STATUSES.includes(next.status) && runtime.activeRun !== undefined)
      await stopRun(runtime, undefined);
    return transition;
  }

  /** Asks the active run, and whoever holds the goal, to stop. Best effort. */
  async function stopRun(runtime: GoalRuntimeState, reason: string | undefined): Promise<void> {
    const run = runtime.activeRun;
    if (run !== undefined)
      await quietly(deps.logger, 'goal supervisor: run cancel failed', () =>
        launcher.cancel({
          scope: runtime.scope,
          runId: run.runId,
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
    await quietly(deps.logger, 'goal supervisor: goal lease signal failed', () =>
      provider.signal(goalLeaseKey(runtime.scope, runtime.goalId), 'cancel'),
    );
  }

  /**
   * Records a cancel (spec §3.1): the request is durable before anything is
   * asked to stop, and it is applied at the run's next claim (or when the
   * working run stops), so a cancel for an idle run is never lost.
   */
  async function requestCancel(
    goal: GoalRecord,
    runtime: GoalRuntimeState,
    reason: string | undefined,
    now: number,
  ): Promise<GoalTransition | 'conflict'> {
    if (TERMINAL_STATUSES.includes(goal.status))
      return transitionGoal(
        goal,
        { type: 'cancel', ...(reason !== undefined ? { reason } : {}) },
        {
          now,
        },
      );
    if (runtime.cancel !== undefined)
      return { record: goal, changed: false, outcome: 'ignored', reason: 'unchanged' };
    const state: GoalRuntimeState = {
      ...runtime,
      revision: runtime.revision + 1,
      updatedAt: Math.max(runtime.updatedAt, now),
      cancel: { requestedAt: now, ...(reason !== undefined ? { reason } : {}) },
    };
    if ((await store.runtime.save(state)).status === 'conflict') return 'conflict';
    recordSpan(deps, DEUZ_SPAN.goalCancelRequested, goalAttributes(goal));
    hub.emit({ type: 'cancel-requested', scope: goal.scope, goalId: goal.goalId });
    await stopRun(runtime, reason);
    return { record: goal, changed: false, outcome: 'applied' };
  }

  return {
    async submit(input) {
      const { policy: goalPolicy, start = true, ...create } = input;
      const now = deps.clock.now();
      const policy = mergePolicy(defaults, goalPolicy);
      const runId = start ? runIdFor(create.goalId, 1) : undefined;
      const goal = createGoal(
        {
          ...create,
          specGeneration: create.specGeneration ?? 1,
          ...(runId !== undefined ? { runId } : {}),
        },
        { now },
      );
      const intentId = intentIdFor(goal.goalId, 1);
      const runtime: GoalRuntimeState = {
        goalId: goal.goalId,
        scope: goal.scope,
        revision: 1,
        policy,
        phase: runId !== undefined ? 'dispatching' : 'idle',
        ...(runId !== undefined
          ? { activeRun: { intentId, runId, attempt: 1, startedAt: now } }
          : {}),
        runs: runId !== undefined ? 1 : 0,
        retries: 0,
        createdAt: now,
        updatedAt: now,
      };
      const written =
        runId !== undefined
          ? await store.intents.record(
              {
                intentId,
                scope: goal.scope,
                goalId: goal.goalId,
                kind: 'start',
                runId,
                attempt: 1,
                cause: { command: 'submit' },
              },
              { runtime, goal },
            )
          : await store.runtime.save(runtime, goal);
      if (written.status === 'conflict')
        throw new GoalError('revision_conflict', `Goal ${goal.goalId} already exists.`);
      return { goal, runtime };
    },

    async get(scope, goalId) {
      const goal = await store.load(goalId, { scope });
      if (!goal) return undefined;
      const runtime = await store.runtime.get(scope, goalId);
      return runtime ? { goal, runtime } : undefined;
    },

    list: (query) => store.list(query),

    async dispatch(input, dispatchOptions = {}) {
      const event = checkGoalEvent(input);
      const { scope, goalId } = event;
      const namespace = dispatchOptions.namespace ?? 'host';
      const deliveryId = dispatchOptions.deliveryId ?? event.key;
      const payload = dispatchOptions.payload;
      const result = await store.inbox.enqueue({
        scope,
        goalId,
        namespace,
        deliveryId,
        event,
        ...(payload !== undefined ? { payload } : {}),
        digest: await goalDeliveryDigest({ scope, goalId, event, ...(payload ? { payload } : {}) }),
      });
      if (result.status === 'conflict')
        throw new GoalError(
          'delivery_conflict',
          `Delivery ${deliveryId} in namespace ${namespace} of scope ${scope} was queued before with other content.`,
        );
      return result;
    },

    async command(scope, goalId, command, commandOptions) {
      const expected = commandOptions?.expectedRevision;
      for (let attempt = 1; ; attempt++) {
        const { goal, runtime } = await supervised(scope, goalId);
        if (expected !== undefined && goal.revision !== expected) throw stale(goal, expected);
        const now = deps.clock.now();
        const outcome =
          command?.type === 'cancel'
            ? await requestCancel(goal, runtime, command.reason, now)
            : await applyCommand(goal, runtime, command, now);
        if (outcome !== 'conflict') return outcome;
        // Another writer moved the goal or its state: decide again on what it wrote.
        if (attempt >= WRITE_ATTEMPTS) throw stale(goal, expected ?? goal.revision);
      }
    },

    async resume(scope, goalId, input) {
      for (let attempt = 1; ; attempt++) {
        const { goal, runtime } = await supervised(scope, goalId);
        const run = runtime.activeRun;
        if (
          run === undefined ||
          runtime.phase !== 'idle' ||
          runtime.cancel !== undefined ||
          TERMINAL_STATUSES.includes(goal.status)
        )
          throw new GoalError('invalid_command', `Goal ${goalId} has no suspended run to resume.`);
        const now = deps.clock.now();
        const resumed =
          goal.status === 'waiting' ? transitionGoal(goal, { type: 'resume' }, { now }) : undefined;
        if (resumed?.outcome === 'rejected')
          throw new GoalError(
            'invalid_command',
            `Goal ${goalId} cannot resume: ${resumed.reason ?? 'rejected'}.`,
          );
        const { retryAt: _retryAt, ...rest } = runtime;
        const revision = runtime.revision + 1;
        const intentId = intentIdFor(goalId, revision);
        const written = await store.intents.record(
          {
            intentId,
            scope,
            goalId,
            kind: 'resume',
            runId: run.runId,
            attempt: 1,
            cause: { command: 'resume' },
            ...(input?.approvalResponses !== undefined
              ? { approvalResponses: input.approvalResponses }
              : {}),
            ...(input?.clientToolResults !== undefined
              ? { clientToolResults: input.clientToolResults }
              : {}),
          },
          {
            runtime: {
              ...rest,
              revision,
              updatedAt: Math.max(runtime.updatedAt, now),
              phase: 'dispatching',
              retries: 0,
              activeRun: { intentId, runId: run.runId, attempt: 1, startedAt: now },
            },
            ...(resumed?.changed ? { goal: resumed.record } : {}),
          },
        );
        if (written.status === 'committed') return;
        if (attempt >= WRITE_ATTEMPTS) throw stale(goal, goal.revision);
      }
    },

    async updatePolicy(scope, goalId, policy, policyOptions) {
      const { runtime } = await supervised(scope, goalId);
      if (runtime.revision !== policyOptions?.expectedRevision)
        throw new GoalError(
          'revision_conflict',
          `The runtime state of goal ${goalId} is at revision ${runtime.revision}, not ${String(policyOptions?.expectedRevision)}.`,
        );
      const state: GoalRuntimeState = {
        ...runtime,
        policy: mergePolicy(runtime.policy, policy),
        revision: runtime.revision + 1,
        updatedAt: Math.max(runtime.updatedAt, deps.clock.now()),
      };
      const written = await store.runtime.save(state);
      if (written.status === 'conflict')
        throw new GoalError(
          'revision_conflict',
          `The runtime state of goal ${goalId} moved past revision ${runtime.revision}.`,
        );
      return state;
    },

    events: (eventOptions) => hub.subscribe(eventOptions?.signal),
    tick: (tickOptions) => driver.tick(tickOptions?.now ?? deps.clock.now(), tickOptions?.signal),

    start(startOptions) {
      if (started) throw new Error('This goal supervisor is already started');
      started = true;
      const controller = new AbortController();
      const outer = startOptions?.signal;
      const forward = () => controller.abort();
      if (outer?.aborted) controller.abort();
      else outer?.addEventListener('abort', forward, { once: true });
      let wake: (() => void) | undefined;
      let cancelTimer: (() => void) | undefined;
      controller.signal.addEventListener(
        'abort',
        () => {
          cancelTimer?.();
          wake?.();
        },
        { once: true },
      );
      const loop = (async () => {
        while (!controller.signal.aborted && !driver.draining) {
          try {
            await driver.tick(deps.clock.now(), controller.signal);
          } catch (error) {
            deps.logger.error('goal supervisor tick failed', { error });
          }
          if (controller.signal.aborted || driver.draining) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            cancelTimer = deps.clock.setTimeout(resolve, pollMs);
          });
        }
      })().finally(() => {
        outer?.removeEventListener('abort', forward);
        started = false;
      });
      return {
        async stop() {
          controller.abort();
          await loop;
        },
      };
    },

    drain: () => driver.drain(),
  };
}

/**
 * The native `RunLauncher` (2.4): runs and resumes V3 runs with the existing
 * executor, loaded with a lazy `import()` so `/goal/runtime` never bundles
 * it statically. A run its V3 store does not hold is started, a stored one
 * resumed (`retryFailed` only for a `'retry'` of a transient failure); the
 * inherited working memory goes to a new run only. Cancel and drain go
 * through the native run's lease (false without `lease`, or while no
 * executor holds the run); `accounting` reads the ledger of the run's last
 * checkpoint and `maintenance` its memory extraction.
 */
export function createNativeRunLauncher(options: NativeRunLauncherOptions): RunLauncher {
  return createNative(options);
}
