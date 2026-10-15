/**
 * @internal How the goal supervisor drives goals (2.4, spec §3.1): a tick
 * finds the goals with work, and drives each under its `goal:` lease (one
 * active executor per goal) with at most `concurrency` drives at once.
 *
 * A drive takes one step at a time on freshly read state, each step one
 * checked write, in this order: apply a recorded cancel; close what a goal
 * that ended left open (and follow its maintenance); apply time (a passed
 * deadline, a due wakeup); reconcile a dependency wait; settle a due inbox
 * entry; close an intent its state no longer names; launch the intent the
 * state names (claimed with the lease token, which fences out every earlier
 * holder); record a due retry; resume a run the host made active again;
 * start an automatic run. Every intent is recorded with a runtime state
 * whose `activeRun` names it, so every crash between two steps leaves a
 * state the next drive continues from. Fencing is the store's revision CAS:
 * the lease is liveness only. A drive that loses its lease drains the run it
 * started and writes nothing more.
 *
 * Edge-safe.
 */
import type { AgentResult } from '../../types/agent-run';
import type { ResolvedDependencies } from '../../types/deps';
import type { Lease, LeaseProvider } from '../../types/lease';
import { DEUZ_SPAN, observeSpan, recordSpan } from '../../internal/telemetry';
import { transitionGoal } from '../transition';
import type { GoalCommand, GoalRecord, GoalWaitRequest } from '../types';
import { TERMINAL_STATUSES } from '../validate';
import { goalDeliveryDigest, goalDependencyEvents, settleGoalEvent } from './delivery';
import type {
  GoalInboxApplication,
  GoalRunIntent,
  GoalRunIntentInput,
  GoalRuntimeState,
  GoalRuntimeStore,
} from './store-types';
import type {
  GoalSupervisorEvent,
  GoalSupervisorTickResult,
  RunLaunchRequest,
  RunLaunchResult,
  RunLauncher,
} from './supervisor';
import {
  goalAttributes,
  goalLeaseKey,
  inheritedWorkingMemory,
  intentIdFor,
  quietly,
  reportGeneration,
  runIdFor,
  stampWorkingMemory,
  type EventHub,
} from './supervisor-shared';

/** Steps one drive takes at most (inbox entries included). */
const MAX_STEPS = 200;
/** Conflicting writes in a row after which a drive gives up until the next tick. */
const MAX_CONFLICTS = 5;
const OPEN_INTENTS: readonly GoalRunIntent['status'][] = ['pending', 'claimed', 'launched'];
const PAGE = 1000;

/** What the driver needs from the supervisor. */
export interface GoalDriverOptions {
  store: GoalRuntimeStore;
  launcher: RunLauncher;
  deps: ResolvedDependencies;
  hub: EventHub<GoalSupervisorEvent>;
  provider: LeaseProvider;
  owner: string;
  ttlMs: number;
  scopes: readonly string[] | undefined;
  concurrency: number;
  verify?: (context: {
    goal: GoalRecord;
    runId: string;
    result: AgentResult<unknown>;
  }) =>
    | GoalCommand
    | readonly GoalCommand[]
    | undefined
    | Promise<GoalCommand | readonly GoalCommand[] | undefined>;
  runFinished?: (runId: string) => boolean | Promise<boolean>;
}

/** The state one step decides on. */
interface View {
  goal: GoalRecord;
  runtime: GoalRuntimeState;
  /** The goal's open intents, oldest first. */
  open: GoalRunIntent[];
}

type Step = 'continue' | 'conflict' | 'stop';

/** A run a drive launched and waits on. */
interface Leg {
  scope: string;
  goalId: string;
  runId: string;
  drive: Drive;
  done: Promise<void>;
}

/** One drive's hold on a goal: its lease, kept alive on the clock, and what it was told. */
interface Drive {
  scope: string;
  goalId: string;
  readonly token: number;
  readonly lost: boolean;
  /** The run this drive waits on, if any. */
  running?: string;
  /** Stops renewing; gives the lease back unless it was lost. */
  end(): Promise<void>;
}

const isTerminal = (goal: GoalRecord): boolean => TERMINAL_STATUSES.includes(goal.status);

/** The goal's wait that events and time answer: a budget wait answers the one it interrupted. */
function answerable(goal: GoalRecord) {
  const wait = goal.status === 'waiting' ? goal.waiting : undefined;
  return wait?.reason === 'budget' ? wait.interrupted : wait;
}

/** The runtime state without its active run. */
function withoutRun(runtime: GoalRuntimeState): GoalRuntimeState {
  const { activeRun: _activeRun, retryAt: _retryAt, ...rest } = runtime;
  return rest;
}

/** The next runtime revision, stamped at `now`. */
function bump(runtime: GoalRuntimeState, now: number): GoalRuntimeState {
  return {
    ...runtime,
    revision: runtime.revision + 1,
    updatedAt: Math.max(runtime.updatedAt, now),
  };
}

/** The error a leg reports, for the intent's outcome. */
function errorOf(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

export function createGoalDriver(options: GoalDriverOptions): {
  tick(now: number, signal?: AbortSignal): Promise<GoalSupervisorTickResult>;
  drain(): Promise<void>;
  readonly draining: boolean;
} {
  const { store, launcher, deps, hub, provider } = options;
  const clock = deps.clock;
  let draining = false;
  const legs = new Set<Leg>();
  const drives = new Set<Promise<void>>();
  /** Limits already reported, so a parked goal reports its limit once. */
  const limits = new Set<string>();

  const emit = (event: GoalSupervisorEvent): void => hub.emit(event);

  function reportLimit(runtime: GoalRuntimeState, limit: 'runs' | 'retries'): void {
    const count = limit === 'runs' ? runtime.runs : runtime.retries;
    const max = limit === 'runs' ? runtime.policy.maxRuns : runtime.policy.maxRetries;
    const key = JSON.stringify([runtime.scope, runtime.goalId, limit, count, max]);
    if (limits.has(key)) return;
    limits.add(key);
    emit({ type: 'policy-limit', scope: runtime.scope, goalId: runtime.goalId, limit });
  }

  const limitReported = (runtime: GoalRuntimeState, limit: 'runs' | 'retries'): boolean => {
    const count = limit === 'runs' ? runtime.runs : runtime.retries;
    const max = limit === 'runs' ? runtime.policy.maxRuns : runtime.policy.maxRetries;
    return limits.has(JSON.stringify([runtime.scope, runtime.goalId, limit, count, max]));
  };

  // -----------------------------------------------------------------
  // Reading
  // -----------------------------------------------------------------

  async function openIntents(scope: string, goalId: string): Promise<GoalRunIntent[]> {
    const open: GoalRunIntent[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.intents.list({
        scope,
        goalId,
        statuses: OPEN_INTENTS,
        limit: PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      open.push(...page.intents);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return open;
  }

  async function read(scope: string, goalId: string): Promise<View | undefined> {
    const goal = await store.load(goalId, { scope });
    const runtime = goal ? await store.runtime.get(scope, goalId) : undefined;
    if (!goal || !runtime) return undefined;
    return { goal, runtime, open: await openIntents(scope, goalId) };
  }

  /** The goals a tick looks at: unfinished ones, and ones with open intents. */
  async function candidates(): Promise<{ scope: string; goalId: string }[]> {
    const found = new Map<string, { scope: string; goalId: string }>();
    for (const scope of options.scopes ?? [undefined]) {
      let cursor: string | undefined;
      do {
        const page = await store.list({
          statuses: ['active', 'waiting'],
          limit: PAGE,
          ...(scope !== undefined ? { scope } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const goal of page.goals)
          found.set(goal.goalId, { scope: goal.scope, goalId: goal.goalId });
        cursor = page.cursor;
      } while (cursor !== undefined);
      do {
        const page = await store.intents.list({
          statuses: OPEN_INTENTS,
          limit: PAGE,
          ...(scope !== undefined ? { scope } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const intent of page.intents)
          found.set(intent.goalId, { scope: intent.scope, goalId: intent.goalId });
        cursor = page.cursor;
      } while (cursor !== undefined);
    }
    return [...found.values()];
  }

  /** Whether a goal may have work, read without its lease (the drive decides again under it). */
  async function wanted(view: View, now: number): Promise<boolean> {
    const { goal, runtime, open } = view;
    if (runtime.cancel !== undefined && runtime.cancel.appliedAt === undefined) return true;
    if (isTerminal(goal)) return open.length > 0 || runtime.phase !== 'done';
    if (goal.deadline !== undefined && goal.deadline <= now) return true;
    const wait = answerable(goal);
    if (wait?.reason === 'wakeup' && wait.at <= now) return true;
    if (wait?.reason === 'dependency') return true;
    const due = await store.inbox.list({
      scope: goal.scope,
      goalId: goal.goalId,
      dueBy: now,
      limit: 1,
    });
    if (due.entries.length > 0) return true;
    if (open.length > 0) return true;
    if (runtime.phase === 'retrying')
      return runtime.retries < runtime.policy.maxRetries
        ? (runtime.retryAt ?? 0) <= now
        : !limitReported(runtime, 'retries');
    if (goal.status !== 'active') return false;
    if (runtime.activeRun !== undefined) return true;
    return runtime.runs < runtime.policy.maxRuns || !limitReported(runtime, 'runs');
  }

  // -----------------------------------------------------------------
  // Leases
  // -----------------------------------------------------------------

  /** Holds `lease` for a drive: renews it every ttl/3, hears its signals, notices its loss. */
  function hold(scope: string, goalId: string, first: Lease): Drive {
    let lease = first;
    let lost = false;
    let ended = false;
    let cancelTimer: (() => void) | undefined;
    const every = Math.max(1, Math.floor(options.ttlMs / 3));
    const drive: Drive = {
      scope,
      goalId,
      get token() {
        return first.token;
      },
      get lost() {
        return lost;
      },
      async end() {
        ended = true;
        cancelTimer?.();
        if (!lost)
          await quietly(deps.logger, 'goal supervisor: lease release failed', () =>
            provider.release(lease),
          );
      },
    };
    const schedule = (): void => {
      cancelTimer = clock.setTimeout(() => void renew(), every);
    };
    const renew = async (): Promise<void> => {
      if (ended) return;
      const renewal = await quietly(deps.logger, 'goal supervisor: lease renewal failed', () =>
        provider.renew(lease, options.ttlMs),
      );
      if (ended) return;
      if (renewal === undefined) return schedule();
      if (!renewal.held) return onLost(drive);
      lease = renewal.lease;
      for (const signal of renewal.signals) {
        if (signal === 'drain') void stopRunning(drive, 'drain');
        else void onCancelSignal(drive);
      }
      schedule();
    };
    const onLost = async (lostDrive: Drive): Promise<void> => {
      lost = true;
      emit({ type: 'lease-lost', scope, goalId });
      deps.logger.warn('goal supervisor: goal lease lost', { scope, goalId });
      await stopRunning(lostDrive, 'drain');
    };
    schedule();
    return drive;
  }

  /** Asks the run a drive waits on to drain (resumable) or stop for good. */
  async function stopRunning(drive: Drive, how: 'drain' | 'cancel'): Promise<void> {
    const runId = drive.running;
    if (runId === undefined) return;
    if (how === 'drain') {
      recordSpan(deps, DEUZ_SPAN.goalDrain, goalAttributes({ goalId: drive.goalId }, { runId }));
      await quietly(deps.logger, 'goal supervisor: run drain failed', () =>
        launcher.drain({ scope: drive.scope, runId }),
      );
    } else
      await quietly(deps.logger, 'goal supervisor: run cancel failed', () =>
        launcher.cancel({ scope: drive.scope, runId }),
      );
  }

  /** A `cancel` on the goal lease: the run stops when its goal wants it stopped. */
  async function onCancelSignal(drive: Drive): Promise<void> {
    if (drive.running === undefined) return;
    const view = await quietly(deps.logger, 'goal supervisor: read failed', () =>
      read(drive.scope, drive.goalId),
    );
    if (!view) return;
    if (
      (view.runtime.cancel !== undefined && view.runtime.cancel.appliedAt === undefined) ||
      isTerminal(view.goal)
    )
      await stopRunning(drive, 'cancel');
  }

  // -----------------------------------------------------------------
  // Steps
  // -----------------------------------------------------------------

  /** The intent, held by this drive: as it is when the drive holds it, else claimed with the lease token. */
  async function claim(drive: Drive, intent: GoalRunIntent): Promise<GoalRunIntent | undefined> {
    if (intent.status !== 'pending' && intent.claim?.token === drive.token) return intent;
    const claimed = await store.intents.claim(intent.scope, intent.intentId, {
      owner: options.owner,
      token: drive.token,
      expectedRevision: intent.revision,
    });
    return claimed.status === 'committed' ? claimed.intent : undefined;
  }

  /** Records an intent with the runtime state that names it (and the goal, when it changes). */
  async function record(
    intent: GoalRunIntentInput,
    runtime: GoalRuntimeState,
    goal?: GoalRecord,
  ): Promise<Step> {
    const written = await store.intents.record(intent, { runtime, ...(goal ? { goal } : {}) });
    return written.status === 'committed' ? 'continue' : 'conflict';
  }

  /** A recorded cancel takes effect: the goal ends cancelled and no run of it goes on. */
  async function applyCancel(
    drive: Drive,
    view: View,
    result: GoalSupervisorTickResult,
  ): Promise<Step> {
    const { goal, runtime, open } = view;
    const now = clock.now();
    const reason = runtime.cancel?.reason;
    const transition = isTerminal(goal)
      ? undefined
      : transitionGoal(
          goal,
          { type: 'cancel', ...(reason !== undefined ? { reason } : {}) },
          { now },
        );
    const next = transition?.changed ? transition.record : undefined;
    const state: GoalRuntimeState = {
      ...withoutRun(bump(runtime, now)),
      phase: 'done',
      cancel: { requestedAt: now, ...runtime.cancel, appliedAt: now },
    };
    const intent = open[0];
    if (intent !== undefined) {
      const held = await claim(drive, intent);
      if (!held) return 'conflict';
      const last = open.length === 1;
      const written = await store.intents.complete(held.scope, held.intentId, {
        token: drive.token,
        expectedRevision: held.revision,
        status: 'cancelled',
        outcome: { status: 'stopped', reason: 'cancelled' },
        ...(last ? { runtime: state, ...(next ? { goal: next } : {}) } : {}),
      });
      if (written.status === 'conflict') return 'conflict';
      if (!last) return 'continue';
    } else if ((await store.runtime.save(state, next)).status === 'conflict') return 'conflict';
    result.cancelled++;
    const runId = runtime.activeRun?.runId;
    recordSpan(
      deps,
      DEUZ_SPAN.goalCancelApplied,
      goalAttributes(next ?? goal, runId !== undefined ? { runId } : undefined),
    );
    emit({
      type: 'cancel-applied',
      scope: goal.scope,
      goalId: goal.goalId,
      ...(runId !== undefined ? { runId } : {}),
    });
    return 'stop';
  }

  /**
   * A goal that ended: its open intents close (a run that completed it stays
   * open while its maintenance is pending, and is followed: late charges are
   * added, the goal never reopens) and its phase becomes done.
   */
  async function settleEnded(drive: Drive, view: View): Promise<Step> {
    const { goal, runtime, open } = view;
    const now = clock.now();
    const maintenance = runtime.maintenance;
    const intent = open[0];
    if (intent === undefined) {
      if (runtime.phase === 'done') return 'stop';
      const state = { ...withoutRun(bump(runtime, now)), phase: 'done' as const };
      return (await store.runtime.save(state)).status === 'conflict' ? 'conflict' : 'stop';
    }
    const held = await claim(drive, intent);
    if (!held) return 'conflict';
    const following = maintenance?.status === 'pending' && maintenance.runId === held.runId;
    if (following) {
      const status = launcher.maintenance
        ? await quietly(deps.logger, 'goal supervisor: maintenance check failed', () =>
            launcher.maintenance!({ scope: goal.scope, runId: held.runId }),
          )
        : 'complete';
      await charge(drive, goal.scope, goal.goalId, held.runId);
      if (status === 'pending' || status === undefined) return 'stop';
      const fresh = await store.runtime.get(goal.scope, goal.goalId);
      if (!fresh) return 'stop';
      const latest = (await store.intents.get(held.scope, held.intentId)) ?? held;
      const written = await store.intents.complete(held.scope, held.intentId, {
        token: drive.token,
        expectedRevision: latest.revision,
        status: 'completed',
        outcome: { status: 'completed' },
        runtime: { ...bump(fresh, now), maintenance: { status, runId: held.runId } },
      });
      return written.status === 'conflict' ? 'conflict' : 'stop';
    }
    const last = open.length === 1;
    const written = await store.intents.complete(held.scope, held.intentId, {
      token: drive.token,
      expectedRevision: held.revision,
      status: 'cancelled',
      outcome: { status: 'stopped', reason: 'goal-ended' },
      ...(last ? { runtime: { ...withoutRun(bump(runtime, now)), phase: 'done' as const } } : {}),
    });
    if (written.status === 'conflict') return 'conflict';
    return last ? 'stop' : 'continue';
  }

  /** Time alone: a passed deadline fails the goal, a due wakeup ends its wait. */
  async function applyTime(view: View, now: number): Promise<Step | undefined> {
    const transition = transitionGoal(view.goal, { type: 'tick' }, { now });
    if (!transition.changed) return undefined;
    const ended = isTerminal(transition.record) && view.runtime.activeRun === undefined;
    const state = {
      ...bump(view.runtime, now),
      ...(ended ? { phase: 'done' as const } : {}),
    };
    return (await store.runtime.save(state, transition.record)).status === 'conflict'
      ? 'conflict'
      : 'continue';
  }

  /** Queues an event for each dependency of the goal's wait that already finished. */
  async function reconcileDependencies(view: View, now: number): Promise<void> {
    const events = await goalDependencyEvents(view.goal, {
      now,
      goals: store,
      ...(options.runFinished ? { runFinished: options.runFinished } : {}),
    });
    for (const event of events)
      await store.inbox.enqueue({
        scope: event.scope,
        goalId: event.goalId,
        namespace: 'dependency',
        deliveryId: event.key,
        event,
        digest: await goalDeliveryDigest({ scope: event.scope, goalId: event.goalId, event }),
      });
  }

  /** Whether the goal, as it stands, gets a new automatic run. */
  function startable(goal: GoalRecord, runtime: GoalRuntimeState): boolean {
    return (
      !draining &&
      goal.status === 'active' &&
      runtime.activeRun === undefined &&
      runtime.cancel === undefined &&
      runtime.runs < runtime.policy.maxRuns
    );
  }

  /** A new run's intent and the runtime state that names it. */
  function startOf(
    goal: GoalRecord,
    runtime: GoalRuntimeState,
    now: number,
    cause: GoalRunIntentInput['cause'],
  ): { intent: GoalRunIntentInput; runtime: GoalRuntimeState } {
    const run = runtime.runs + 1;
    const runId = runIdFor(goal.goalId, run);
    const next = bump(runtime, now);
    const intentId = intentIdFor(goal.goalId, next.revision);
    return {
      intent: {
        intentId,
        scope: goal.scope,
        goalId: goal.goalId,
        kind: 'start',
        runId,
        attempt: 1,
        ...(cause !== undefined ? { cause } : {}),
      },
      runtime: {
        ...withoutRun(next),
        phase: 'dispatching',
        runs: run,
        retries: 0,
        activeRun: { intentId, runId, attempt: 1, startedAt: now },
      },
    };
  }

  /** Settles the oldest due inbox entry, with the run intent it implies in the same write. */
  async function settleInbox(
    view: View,
    now: number,
    result: GoalSupervisorTickResult,
  ): Promise<Step | undefined> {
    const { goal, runtime } = view;
    const page = await store.inbox.list({
      scope: goal.scope,
      goalId: goal.goalId,
      dueBy: now,
      limit: 1,
    });
    const entry = page.entries[0];
    if (entry === undefined) return undefined;
    const settlement = settleGoalEvent(goal, entry, { now });
    if (settlement.disposition === 'pending') return undefined;
    const after = settlement.goal ?? goal;
    const application: GoalInboxApplication = { ...settlement.application };
    if (startable(after, runtime)) {
      const start = startOf(after, runtime, now, { inboxEntryId: entry.id });
      application.runtime = start.runtime;
      application.intent = start.intent;
    }
    const written = await store.inbox.apply(application);
    if (written.status === 'conflict') return 'conflict';
    result.applied++;
    reportGeneration(deps, hub, goal, after);
    emit({
      type: 'inbox-applied',
      scope: goal.scope,
      goalId: goal.goalId,
      entryId: entry.id,
      disposition: settlement.disposition,
    });
    return 'continue';
  }

  /** Records the retry a failed run waits for, once it is due and the policy allows it. */
  async function scheduleRetry(view: View, now: number): Promise<Step> {
    const { goal, runtime } = view;
    const active = runtime.activeRun;
    if (active === undefined) return 'stop';
    if (runtime.retries >= runtime.policy.maxRetries) {
      reportLimit(runtime, 'retries');
      return 'stop';
    }
    if ((runtime.retryAt ?? 0) > now || draining) return 'stop';
    const failed = await store.intents.get(goal.scope, active.intentId);
    const next = bump(runtime, now);
    const intentId = intentIdFor(goal.goalId, next.revision);
    const attempt = active.attempt + 1;
    return record(
      {
        intentId,
        scope: goal.scope,
        goalId: goal.goalId,
        kind: 'retry',
        runId: active.runId,
        attempt,
        ...(runtime.retryAt !== undefined ? { notBefore: runtime.retryAt } : {}),
        cause: { command: 'retry' },
        // The verdicts the failed attempt carried: an approval-gated call is
        // not gated again on the retry.
        ...(failed?.approvalResponses ? { approvalResponses: failed.approvalResponses } : {}),
        ...(failed?.clientToolResults ? { clientToolResults: failed.clientToolResults } : {}),
      },
      {
        ...withoutRun(next),
        phase: 'dispatching',
        retries: runtime.retries + 1,
        activeRun: { intentId, runId: active.runId, attempt, startedAt: now },
      },
    );
  }

  /** One step on fresh state. */
  async function step(
    drive: Drive,
    view: View,
    result: GoalSupervisorTickResult,
    state: { reconciled: boolean; floor: number },
  ): Promise<Step> {
    const { goal, runtime, open } = view;
    const now = Math.max(state.floor, clock.now());
    if (runtime.cancel !== undefined && runtime.cancel.appliedAt === undefined)
      return applyCancel(drive, view, result);
    if (isTerminal(goal)) return settleEnded(drive, view);
    const timed = await applyTime(view, now);
    if (timed !== undefined) return timed;
    if (!state.reconciled) {
      state.reconciled = true;
      if (answerable(goal)?.reason === 'dependency') await reconcileDependencies(view, now);
    }
    const settled = await settleInbox(view, now, result);
    if (settled !== undefined) return settled;

    const active = runtime.activeRun;
    // An open intent the state no longer names was overtaken (a crash between two writes).
    const stray = open.find((intent) => intent.intentId !== active?.intentId);
    if (stray !== undefined) {
      const held = await claim(drive, stray);
      if (!held) return 'conflict';
      const written = await store.intents.complete(held.scope, held.intentId, {
        token: drive.token,
        expectedRevision: held.revision,
        status: 'cancelled',
        outcome: { status: 'stopped', reason: 'superseded' },
      });
      return written.status === 'conflict' ? 'conflict' : 'continue';
    }
    const intent = open.find((candidate) => candidate.intentId === active?.intentId);
    if (intent !== undefined) {
      if (draining) return 'stop';
      if (intent.status === 'pending' && (intent.notBefore ?? 0) > now) return 'stop';
      if (goal.runId !== intent.runId) {
        const linked = transitionGoal(goal, { type: 'link-run', runId: intent.runId }, { now });
        if (linked.changed)
          return (await store.runtime.save(bump(runtime, now), linked.record)).status === 'conflict'
            ? 'conflict'
            : 'continue';
      }
      return launch(drive, view, intent, result);
    }
    if (runtime.phase === 'retrying') return scheduleRetry(view, now);
    if (goal.status !== 'active' || draining) return 'stop';
    if (active !== undefined) {
      // The host made the goal active again while its run waits: resume it.
      const next = bump(runtime, now);
      const intentId = intentIdFor(goal.goalId, next.revision);
      return record(
        {
          intentId,
          scope: goal.scope,
          goalId: goal.goalId,
          kind: 'resume',
          runId: active.runId,
          attempt: 1,
          cause: { command: 'resume' },
        },
        {
          ...withoutRun(next),
          phase: 'dispatching',
          retries: 0,
          activeRun: { intentId, runId: active.runId, attempt: 1, startedAt: now },
        },
      );
    }
    if (runtime.cancel !== undefined) return 'stop';
    if (runtime.runs >= runtime.policy.maxRuns) {
      reportLimit(runtime, 'runs');
      return 'stop';
    }
    const start = startOf(goal, runtime, now, { command: 'auto' });
    const linked = transitionGoal(goal, { type: 'link-run', runId: start.intent.runId }, { now });
    return record(start.intent, start.runtime, linked.changed ? linked.record : undefined);
  }

  // -----------------------------------------------------------------
  // Legs
  // -----------------------------------------------------------------

  /** Claims the intent, marks the goal running, launches the leg, settles it. */
  async function launch(
    drive: Drive,
    view: View,
    intent: GoalRunIntent,
    result: GoalSupervisorTickResult,
  ): Promise<Step> {
    const { goal, runtime } = view;
    const held = await claim(drive, intent);
    if (!held) return 'stop';
    const now = clock.now();
    if (drive.lost) return 'stop';
    const running: GoalRuntimeState = { ...bump(runtime, now), phase: 'running' };
    if ((await store.runtime.save(running)).status === 'conflict') return 'conflict';
    const workingMemory =
      held.kind === 'start' ? inheritedWorkingMemory(runtime.workingMemory, goal) : undefined;
    const request: RunLaunchRequest = {
      scope: goal.scope,
      goalId: goal.goalId,
      intentId: held.intentId,
      runId: held.runId,
      attempt: held.attempt,
      kind: held.kind,
      goal,
      ...(workingMemory !== undefined ? { workingMemory } : {}),
      ...(held.approvalResponses !== undefined
        ? { approvalResponses: held.approvalResponses }
        : {}),
      ...(held.clientToolResults !== undefined
        ? { clientToolResults: held.clientToolResults }
        : {}),
    };
    // A launched intent's run exists: it is resumed, never started again.
    const resume = held.kind !== 'start' || held.status === 'launched';
    result.dispatched++;
    emit({ type: 'dispatched', scope: goal.scope, goalId: goal.goalId, intent: held });
    const attributes = goalAttributes(goal, { runId: held.runId, attempt: held.attempt });
    let outcome: { ok: RunLaunchResult } | { error: unknown };
    drive.running = held.runId;
    let finish!: () => void;
    const leg: Leg = {
      scope: goal.scope,
      goalId: goal.goalId,
      runId: held.runId,
      drive,
      done: new Promise<void>((resolve) => (finish = resolve)),
    };
    legs.add(leg);
    try {
      outcome = await observeSpan(deps, DEUZ_SPAN.goalDispatch, attributes, async (annotate) => {
        annotate(attributes);
        try {
          const ok = await (resume ? launcher.resume(request) : launcher.launch(request));
          return { ok };
        } catch (error) {
          return { error };
        }
      });
    } finally {
      drive.running = undefined;
      legs.delete(leg);
    }
    try {
      if ('ok' in outcome)
        emit({
          type: 'run-ended',
          scope: goal.scope,
          goalId: goal.goalId,
          runId: held.runId,
          status: outcome.ok.result.status,
        });
      await settleLeg(drive, held, request, outcome, result);
    } finally {
      finish();
    }
    return 'stop';
  }

  /** The wait a goal enters when its run needs the host: it never starts another run by itself. */
  async function waitForHost(goal: GoalRecord, note: string, now: number): Promise<GoalRecord> {
    if (goal.status !== 'active') return goal;
    const wait: GoalWaitRequest = { reason: 'user', note };
    const transition = transitionGoal(goal, { type: 'wait', wait }, { now });
    return transition.changed ? transition.record : goal;
  }

  /** Applies the host's verification of a completed run, one checked write per changed command. */
  async function verified(
    drive: Drive,
    goal: GoalRecord,
    runId: string,
    result: AgentResult<unknown>,
  ): Promise<GoalRecord | undefined> {
    if (!options.verify) return goal;
    const answer = await options.verify({ goal, runId, result });
    const commands: readonly GoalCommand[] =
      answer === undefined
        ? []
        : Array.isArray(answer)
          ? (answer as readonly GoalCommand[])
          : [answer as GoalCommand];
    let current = goal;
    for (const command of commands) {
      if (drive.lost) return undefined;
      const transition = transitionGoal(current, command, { now: clock.now() });
      if (!transition.changed) continue;
      const runtime = await store.runtime.get(current.scope, current.goalId);
      if (!runtime) return undefined;
      const written = await store.runtime.save(bump(runtime, clock.now()), transition.record);
      if (written.status === 'conflict') return undefined;
      reportGeneration(deps, hub, current, transition.record);
      current = transition.record;
    }
    return current;
  }

  /**
   * Settles a leg: charges the run's ledger above its watermark, then
   * records what the leg's outcome means for the intent, the runtime state
   * and the goal in one write, re-deciding on fresh state after a conflict.
   * After a lost lease nothing is written: the next holder takes over.
   */
  async function settleLeg(
    drive: Drive,
    intent: GoalRunIntent,
    request: RunLaunchRequest,
    outcome: { ok: RunLaunchResult } | { error: unknown },
    result: GoalSupervisorTickResult,
  ): Promise<void> {
    const { scope, goalId, runId } = request;
    if (drive.lost) return;
    await charge(drive, scope, goalId, runId);
    let verifiedOnce = false;
    for (let conflicts = 0; conflicts < MAX_CONFLICTS && !drive.lost; conflicts++) {
      const goal0 = await store.load(goalId, { scope });
      const runtime0 = await store.runtime.get(scope, goalId);
      const held = await store.intents.get(scope, intent.intentId);
      if (!goal0 || !runtime0 || !held) return;
      // Fenced out: another holder claimed the intent since.
      if (held.claim?.token !== drive.token || !OPEN_INTENTS.includes(held.status)) return;
      const now = clock.now();
      const leg = 'ok' in outcome ? outcome.ok : undefined;
      const status = leg?.result.status;
      const memory = leg?.workingMemory
        ? stampWorkingMemory(leg.workingMemory, request.goal)
        : runtime0.workingMemory;
      const base: GoalRuntimeState = {
        ...bump(runtime0, now),
        ...(memory !== undefined ? { workingMemory: memory } : {}),
      };
      const complete = async (
        intentStatus: 'completed' | 'failed' | 'cancelled',
        intentOutcome: GoalRunIntent['outcome'],
        runtime: GoalRuntimeState,
        goal?: GoalRecord,
      ) =>
        store.intents.complete(scope, held.intentId, {
          token: drive.token,
          expectedRevision: held.revision,
          status: intentStatus,
          ...(intentOutcome !== undefined ? { outcome: intentOutcome } : {}),
          runtime,
          ...(goal !== undefined && goal !== goal0 ? { goal } : {}),
        });
      const outcomeOf = (): GoalRunIntent['outcome'] => {
        if (!leg)
          return { status: 'failed', error: errorOf((outcome as { error: unknown }).error) };
        const res = leg.result;
        if (res.status === 'failed') return { status: 'failed', error: res.error };
        if (res.status === 'stopped') return { status: 'stopped', reason: res.reason };
        return { status: res.status };
      };

      // A cancel wins over whatever the leg did, and so does a goal that ended.
      const cancelPending =
        runtime0.cancel !== undefined && runtime0.cancel.appliedAt === undefined;
      const stoppedCancelled =
        leg?.result.status === 'stopped' && leg.result.reason === 'cancelled';
      if (cancelPending || (stoppedCancelled && !isTerminal(goal0))) {
        const reason = runtime0.cancel?.reason;
        const transition = isTerminal(goal0)
          ? undefined
          : transitionGoal(
              goal0,
              { type: 'cancel', ...(reason !== undefined ? { reason } : {}) },
              { now },
            );
        const written = await complete(
          'cancelled',
          outcomeOf(),
          {
            ...withoutRun(base),
            phase: 'done',
            cancel: { requestedAt: now, ...runtime0.cancel, appliedAt: now },
          },
          transition?.changed ? transition.record : undefined,
        );
        if (written.status === 'conflict') continue;
        result.cancelled++;
        recordSpan(deps, DEUZ_SPAN.goalCancelApplied, goalAttributes(goal0, { runId }));
        emit({ type: 'cancel-applied', scope, goalId, runId });
        return;
      }
      if (isTerminal(goal0)) {
        const intentStatus =
          status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled';
        const written = await complete(intentStatus, outcomeOf(), {
          ...withoutRun(base),
          phase: 'done',
        });
        if (written.status === 'conflict') continue;
        return;
      }

      if (!leg || (leg.result.status === 'failed' && leg.retryable === true)) {
        // A failure the native layer may retry (or a leg that threw): the same
        // run is retried after the policy's wait, never started anew.
        const policy = runtime0.policy;
        const delays = policy.retryDelaysMs;
        const delay =
          delays.length === 0 ? 0 : delays[Math.min(runtime0.retries, delays.length - 1)]!;
        const retryAt = now + delay;
        const written = await complete('failed', outcomeOf(), {
          ...base,
          phase: 'retrying',
          retryAt,
        });
        if (written.status === 'conflict') continue;
        const attempt = (runtime0.activeRun?.attempt ?? intent.attempt) + 1;
        if (runtime0.retries < policy.maxRetries) {
          recordSpan(deps, DEUZ_SPAN.goalRetry, goalAttributes(goal0, { runId, attempt }));
          emit({ type: 'retry-scheduled', scope, goalId, attempt, at: retryAt });
        } else reportLimit({ ...base, phase: 'retrying' }, 'retries');
        return;
      }

      const res = leg.result;
      if (res.status === 'stopped' && res.reason === 'drained') {
        // Resumable: the intent stays open (launched), the next claim resumes the run.
        if (held.status === 'claimed') {
          const marked = await store.intents.launched(scope, held.intentId, {
            token: drive.token,
            expectedRevision: held.revision,
          });
          if (marked.status === 'conflict') continue;
        }
        const written = await store.runtime.save({ ...base, phase: 'dispatching' });
        if (written.status === 'conflict') continue;
        emit({ type: 'drained', scope, goalId, runId });
        return;
      }
      if (res.status === 'completed') {
        const goal = goal0;
        if (!verifiedOnce) {
          // Its writes are checked one by one: decide again on what they wrote.
          const after = await verified(drive, goal0, runId, res);
          if (after === undefined) continue;
          verifiedOnce = true;
          if (after !== goal0) continue;
        }
        const completion = transitionGoal(goal, { type: 'complete' }, { now });
        const finalGoal = completion.changed ? completion.record : goal;
        const ended = isTerminal(finalGoal);
        const maintenance = leg.maintenance;
        const state: GoalRuntimeState = {
          ...withoutRun(base),
          phase: ended ? 'done' : 'idle',
          ...(maintenance !== undefined ? { maintenance: { status: maintenance, runId } } : {}),
        };
        if (ended && maintenance === 'pending') {
          // The goal completes now; the run's maintenance is followed apart.
          if (held.status === 'claimed') {
            const marked = await store.intents.launched(scope, held.intentId, {
              token: drive.token,
              expectedRevision: held.revision,
            });
            if (marked.status === 'conflict') continue;
          }
          const written = await store.runtime.save(
            state,
            finalGoal !== goal ? finalGoal : undefined,
          );
          if (written.status === 'conflict') continue;
          return;
        }
        const written = await complete('completed', outcomeOf(), state, finalGoal);
        if (written.status === 'conflict') continue;
        return;
      }
      if (res.status === 'suspended') {
        const note = res.pendingApprovals.length > 0 ? 'approval' : 'client-tools';
        const goal = await waitForHost(goal0, note, now);
        const written = await complete(
          'completed',
          outcomeOf(),
          { ...base, phase: 'idle', retries: 0 },
          goal,
        );
        if (written.status === 'conflict') continue;
        return;
      }
      // Stopped for another reason, or failed for good: the host decides.
      const note =
        res.status === 'stopped'
          ? `run-stopped:${res.reason}`
          : `run-failed:${res.error.code ?? res.error.name}`;
      const goal = await waitForHost(goal0, note, now);
      const written = await complete(
        res.status === 'failed' ? 'failed' : 'completed',
        outcomeOf(),
        { ...withoutRun(base), phase: 'idle' },
        goal,
      );
      if (written.status === 'conflict') continue;
      return;
    }
  }

  /**
   * Charges a run's durable ledger above its watermark to the goal, exactly
   * once: the watermark and the charged goal are written together, at the
   * watermark's revision, so a repeat after a crash finds nothing to charge.
   * Reservations (uncertain amounts) are recorded, never charged.
   */
  async function charge(drive: Drive, scope: string, goalId: string, runId: string): Promise<void> {
    if (!launcher.accounting) return;
    const totals = await quietly(deps.logger, 'goal supervisor: accounting read failed', () =>
      launcher.accounting!({ scope, runId }),
    );
    if (!totals) return;
    for (let conflicts = 0; conflicts < MAX_CONFLICTS; conflicts++) {
      if (drive.lost) return;
      const mark = await store.watermarks.get(scope, goalId, runId);
      const tokens = Math.max(totals.spent.tokens, mark?.tokens ?? 0);
      const usd = Math.max(totals.spent.usd, mark?.usd ?? 0);
      const next = {
        tokens,
        usd,
        reservedTokens: totals.reserved.tokens,
        reservedUsd: totals.reserved.usd,
      };
      const charged = { tokens: tokens - (mark?.tokens ?? 0), usd: usd - (mark?.usd ?? 0) };
      const unchanged =
        charged.tokens === 0 &&
        charged.usd === 0 &&
        next.reservedTokens === (mark?.reservedTokens ?? 0) &&
        next.reservedUsd === (mark?.reservedUsd ?? 0);
      if (unchanged) return;
      const goal = await store.load(goalId, { scope });
      if (!goal) return;
      const revision = (mark?.revision ?? 0) + 1;
      const transition = transitionGoal(
        goal,
        {
          type: 'charge',
          ...(charged.tokens > 0 ? { tokens: charged.tokens } : {}),
          ...(charged.usd > 0 ? { usd: charged.usd } : {}),
          key: `ledger:${JSON.stringify([runId, revision])}`,
        },
        { now: clock.now() },
      );
      if (!transition.changed) return;
      const written = await store.watermarks.advance({
        scope,
        goalId,
        runId,
        expectedRevision: mark?.revision ?? 0,
        next,
        goal: transition.record,
      });
      if (written.status === 'committed') return;
    }
  }

  // -----------------------------------------------------------------
  // Drives and ticks
  // -----------------------------------------------------------------

  async function driveGoal(
    candidate: { scope: string; goalId: string },
    now: number,
    result: GoalSupervisorTickResult,
  ): Promise<void> {
    const first = await read(candidate.scope, candidate.goalId);
    if (!first || !(await wanted(first, now))) return;
    const lease = await provider.acquire({
      key: goalLeaseKey(candidate.scope, candidate.goalId),
      owner: options.owner,
      ttlMs: options.ttlMs,
    });
    if (!lease) {
      result.skipped++;
      return;
    }
    const drive = hold(candidate.scope, candidate.goalId, lease);
    try {
      recordSpan(deps, DEUZ_SPAN.goalClaim, goalAttributes(first.goal));
      emit({
        type: 'claimed',
        scope: candidate.scope,
        goalId: candidate.goalId,
        token: lease.token,
      });
      const state = { reconciled: false, floor: now };
      let conflicts = 0;
      for (let steps = 0; steps < MAX_STEPS && !drive.lost; steps++) {
        const view = await read(candidate.scope, candidate.goalId);
        if (!view) return;
        const next = await step(drive, view, result, state);
        if (next === 'stop') return;
        if (next === 'conflict' && ++conflicts >= MAX_CONFLICTS) return;
        if (next === 'continue') conflicts = 0;
      }
    } finally {
      await drive.end();
    }
  }

  return {
    get draining() {
      return draining;
    },

    async tick(now, signal) {
      const result: GoalSupervisorTickResult = {
        applied: 0,
        dispatched: 0,
        cancelled: 0,
        skipped: 0,
      };
      if (draining) return result;
      const queue = await candidates();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < queue.length && !draining && signal?.aborted !== true) {
          const candidate = queue[next++]!;
          const driven = driveGoal(candidate, now, result).catch((error: unknown) => {
            deps.logger.error('goal supervisor: drive failed', {
              scope: candidate.scope,
              goalId: candidate.goalId,
              error,
            });
          });
          drives.add(driven);
          try {
            await driven;
          } finally {
            drives.delete(driven);
          }
        }
      };
      const workers = Math.max(1, Math.min(options.concurrency, queue.length));
      await Promise.all(Array.from({ length: workers }, worker));
      return result;
    },

    async drain() {
      draining = true;
      for (const leg of [...legs]) {
        if (leg.drive.lost) continue;
        const runtime = await quietly(deps.logger, 'goal supervisor: read failed', () =>
          store.runtime.get(leg.scope, leg.goalId),
        );
        if (runtime && runtime.phase === 'running')
          await quietly(deps.logger, 'goal supervisor: drain write failed', () =>
            store.runtime.save({ ...bump(runtime, clock.now()), phase: 'draining' }),
          );
        await stopRunning(leg.drive, 'drain');
      }
      await Promise.all([...legs].map((leg) => leg.done));
      await Promise.all([...drives]);
    },
  };
}
