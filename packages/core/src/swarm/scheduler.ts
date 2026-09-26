import { runAgent, resumeAgent } from '../agent-run';
import {
  assertExecutionPolicy,
  childScopeId,
  createExecutionContext,
  intersectExecutionPolicies,
} from '../execution-policy';
import { intersectBudgetLimits } from '../budget-ledger';
import { resolveDependencies } from '../internal/resolve-deps';
import type { DeuzAgent } from '../agent';
import type { AgentRunOptions, AgentRunStore, AgentToolSet } from '../types/agent-run';
import type { NativeExecutionContext } from '../types/execution';
import type { Lease, LeaseSignal } from '../types/lease';
import type {
  Swarm,
  SwarmCancelRequest,
  SwarmAgentBinding,
  SwarmCommit,
  SwarmEvent,
  SwarmEventInput,
  SwarmHandle,
  SwarmKey,
  SwarmOptions,
  SwarmRecovery,
  SwarmResumeOptions,
  SwarmRunQuery,
  SwarmSnapshot,
  SwarmSpawnContext,
  SwarmSpawnRequest,
  SwarmStore,
  SwarmTask,
  SwarmTaskRecord,
  SwarmTaskResult,
  SwarmTaskStatus,
} from '../types/swarm';
import {
  cloneSwarm,
  SwarmConflictError,
  SwarmLeaseError,
  swarmKey,
  validateEventCursor,
  validateSwarmSnapshot,
} from './store';
import { resolveDynamicLimits, spawnRecords, tightenLimits } from './spawn';
import { blackboardTools, readableChannels, SWARM_GROUP } from './blackboard';

const executors = new WeakMap<SwarmStore, Set<string>>();
// recover (2.2): the most running runs one call examines, and its listing page.
const RECOVER_SCAN = 10_000;
const RECOVER_PAGE = 1_000;
// recover (2.2): consecutive failures, other than a run's own, that end a scan.
const RECOVER_FAILURES = 3;
// Why a resume failed, for recover (2.2): 'lease' when the lease provider threw
// on acquire, 'run' when a check on the run's own content refused it.
const failureKinds = new WeakMap<object, 'lease' | 'run'>();
function tagFailure(error: unknown, kind: 'lease' | 'run'): unknown {
  if (typeof error === 'object' && error !== null) failureKinds.set(error, kind);
  return error;
}
// Terminal tasks never run again, so their accounting can fold (2.2).
const TERMINAL: ReadonlySet<SwarmTaskStatus> = new Set<SwarmTaskStatus>([
  'completed',
  'failed',
  'blocked',
  'cancelled',
]);

function binding(value: DeuzAgent | SwarmAgentBinding): SwarmAgentBinding {
  return 'def' in value ? { agent: value } : value;
}

function errorRecord(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

/** One task definition against the bindings (shared by root and spawned tasks). */
function defineTask(task: SwarmTask, options: SwarmOptions): void {
  if (!task.id) throw new Error('Swarm task ids must be nonempty and unique');
  if (task.agent !== undefined) {
    if (
      !Object.hasOwn(options.agents, task.agent) ||
      typeof task.prompt !== 'string' ||
      task.reducer !== undefined
    )
      throw new Error(`Unknown or invalid agent task: ${task.id}`);
    if (binding(options.agents[task.agent]!).agent.def.execution)
      throw new Error(
        'Swarm agents must use swarm or binding policy/budget instead of a pre-bound execution context',
      );
  } else if (!task.reducer || !Object.hasOwn(options.reducers ?? {}, task.reducer))
    throw new Error(`Unknown reducer: ${task.id}`);
  if (task.replay !== undefined && task.replay !== 'safe' && task.replay !== 'manual')
    throw new Error('Invalid task replay policy');
  if (task.timeoutMs !== undefined && (!Number.isSafeInteger(task.timeoutMs) || task.timeoutMs < 1))
    throw new Error(`Invalid task timeoutMs: ${task.id}`);
  if (task.group !== undefined && (typeof task.group !== 'string' || !SWARM_GROUP.test(task.group)))
    throw new Error(`Invalid task group: ${task.id}`);
}

function validateTasks(tasks: readonly SwarmTask[], options: SwarmOptions): void {
  const nodes = new Map<string, SwarmTask>();
  for (const task of tasks) {
    defineTask(task, options);
    if (nodes.has(task.id)) throw new Error('Swarm task ids must be nonempty and unique');
    nodes.set(task.id, task);
  }
  const counts = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    // Hard and soft dependencies share one graph: both order the work (2.2).
    const deps = [...(task.dependsOn ?? []), ...(task.after ?? [])];
    if (new Set(deps).size !== deps.length) throw new Error(`Duplicate dependency: ${task.id}`);
    counts.set(task.id, deps.length);
    for (const dep of deps) {
      if (!nodes.has(dep)) throw new Error(`Missing dependency: ${dep}`);
      const list = children.get(dep) ?? [];
      list.push(task.id);
      children.set(dep, list);
    }
  }
  const queue = tasks.filter((task) => counts.get(task.id) === 0).map((task) => task.id);
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]!) ?? []) {
      const remaining = counts.get(child)! - 1;
      counts.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  if (queue.length !== tasks.length) throw new Error('Swarm dependency cycle');
}

/** Fixed DAG, single executor, bounded live work. Events are durable cursor reads. */
export function createSwarm(options: SwarmOptions): Swarm {
  const concurrency = options.concurrency ?? 5;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Swarm concurrency must be a positive integer');
  const deps = resolveDependencies(options.deps);
  const definitionVersion = options.definitionVersion ?? '1';
  const active = new Map<string, SwarmHandle>();
  const owned = executors.get(options.store) ?? new Set<string>();
  executors.set(options.store, owned);
  const version = (task: SwarmTask): string =>
    task.agent !== undefined
      ? (binding(options.agents[task.agent]!).version ?? '1')
      : (options.reducers![task.reducer]!.version ?? '1');
  const dynamic = options.dynamic ? resolveDynamicLimits(options.dynamic) : undefined;
  const canSpawn = options.store.capabilities?.includes('spawn') ?? false;
  const blackboards = Object.values(options.agents)
    .map((value) => binding(value).blackboard)
    .filter((config) => config !== undefined);
  for (const config of blackboards) readableChannels(config);
  if (blackboards.length && !options.store.capabilities?.includes('channels'))
    throw new Error(
      'This swarm store cannot keep blackboard channels: it lacks the "channels" capability',
    );
  if (dynamic && !canSpawn)
    throw new Error(
      'This swarm store cannot persist spawned tasks: it lacks the "spawn" capability',
    );
  // Cross-process liveness (2.2): one lease per run, renewed every ttl / 3.
  const leasing = options.lease;
  const leaseTtl = leasing?.ttlMs ?? 30_000;
  if (leasing && (!Number.isSafeInteger(leaseTtl) || leaseTtl < 3))
    throw new Error('Swarm lease ttlMs must be an integer of at least 3');
  const leaseOwner = leasing ? (leasing.owner ?? deps.generateId()) : '';
  const leaseKey = (key: SwarmKey): string => `swarm:${swarmKey(key)}`;
  const claim = async (key: SwarmKey): Promise<Lease | undefined> => {
    if (!leasing) return undefined;
    let lease: Lease | undefined;
    try {
      lease = await leasing.provider.acquire({
        key: leaseKey(key),
        owner: leaseOwner,
        ttlMs: leaseTtl,
      });
    } catch (error) {
      throw tagFailure(error, 'lease');
    }
    if (!lease) throw new SwarmLeaseError('held');
    return lease;
  };
  const unclaim = async (lease: Lease | undefined): Promise<void> => {
    if (lease) await leasing!.provider.release(lease).catch(() => {});
  };
  /**
   * Take the signals queued under a fresh claim (2.2). A 'cancel' outlives the
   * holder it was sent to, so it may predate this claim.
   */
  const collect = async (
    lease: Lease | undefined,
  ): Promise<{ lease: Lease | undefined; signals: readonly LeaseSignal[] }> => {
    if (!lease) return { lease, signals: [] };
    const renewal = await leasing!.provider.renew(lease, leaseTtl);
    if (!renewal.held) throw new SwarmLeaseError('held');
    return { lease: renewal.lease, signals: renewal.signals };
  };
  /** A claim that fails after collecting queues its cancel again before letting go. */
  const restore = async (key: SwarmKey, signals: readonly LeaseSignal[]): Promise<void> => {
    if (signals.includes('cancel'))
      await leasing!.provider.signal(leaseKey(key), 'cancel').catch(() => false);
  };

  const events = (
    key: SwarmKey,
    settings: { afterSequence?: number; signal?: AbortSignal } = {},
    failure?: () => Promise<unknown> | undefined,
  ): AsyncIterable<SwarmEvent> => ({
    async *[Symbol.asyncIterator]() {
      let cursor = settings.afterSequence ?? 0;
      validateEventCursor(cursor, 256);
      while (!settings.signal?.aborted) {
        const failed = failure?.();
        if (failed) throw await failed;
        const page = await options.store.readEvents(key, cursor, 256);
        for (const event of page) {
          cursor = event.sequence;
          yield event;
        }
        if (page.length === 256) continue;
        const run = options.store.head
          ? await options.store.head(key)
          : (await options.store.load(key))?.run;
        if (!run) throw new Error('Swarm run not found');
        if (cursor < run.lastSequence) continue;
        if (run.status !== 'running') return;
        await new Promise<void>((resolve) => {
          let cancelTimer: () => void = () => {};
          const done = () => {
            cancelTimer();
            settings.signal?.removeEventListener('abort', done);
            resolve();
          };
          settings.signal?.addEventListener('abort', done, { once: true });
          cancelTimer = deps.clock.setTimeout(done, 25);
          if (settings.signal?.aborted) done();
        });
      }
    },
  });

  async function start(
    initial: SwarmSnapshot,
    resume: SwarmResumeOptions | undefined,
    lease: Lease | undefined,
    drainSignalled = false,
  ): Promise<SwarmHandle> {
    const key: SwarmKey = { scope: initial.run.scope, runId: initial.run.runId };
    const id = swarmKey(key);
    if (owned.has(id)) {
      await unclaim(lease);
      throw new Error('Swarm run already has an executor');
    }
    owned.add(id);
    let snapshot = initial;
    const records = new Map(snapshot.tasks.map((task) => [task.task.id, task]));
    const controller = new AbortController();
    const signal = resume?.signal;
    let queue: Promise<unknown> = Promise.resolve();
    let writeFailure: unknown;
    const mutate = (
      make: () => Omit<SwarmCommit, keyof SwarmKey | 'expectedRevision'>,
    ): Promise<void> => {
      const pending = queue.then(async () => {
        if (writeFailure) throw writeFailure;
        const change = make();
        const run = await options.store.commit({
          ...key,
          ...change,
          expectedRevision: snapshot.run.revision,
        });
        for (const task of [...(change.tasks ?? []), ...(change.spawn ?? [])])
          records.set(task.task.id, cloneSwarm(task));
        snapshot = { run, tasks: [] };
      });
      queue = pending.catch((error) => {
        writeFailure = error;
        controller.abort(error);
      });
      return pending;
    };
    const event = (
      type: SwarmEventInput['type'],
      taskId?: string,
      detail?: string,
    ): SwarmEventInput => ({ type, taskId, detail, timestamp: deps.clock.now() });
    let execution!: NativeExecutionContext;
    const persist = async (ledger: ReturnType<NativeExecutionContext['snapshot']>['ledger']) => {
      await mutate(() => ({
        run: { executionState: { ...execution.snapshot(), ledger }, updatedAt: deps.clock.now() },
      }));
    };
    let contextReady = false;
    try {
      execution = initial.run.executionState
        ? createExecutionContext({
            snapshot: initial.run.executionState,
            policy: options.policy,
            budget: options.budget,
            persist,
            admission: options.admission,
          })
        : createExecutionContext({
            scopeId: id,
            policy: options.policy,
            budget: options.budget,
            persist,
            admission: options.admission,
          });
      contextReady = true;
      // Policy/scope state is durable before the first dispatch or reservation.
      await mutate(() => ({ run: { executionState: execution.snapshot() } }));
    } catch (error) {
      owned.delete(id);
      await unclaim(lease);
      // Saved execution state this process cannot restore is the run's own failure.
      throw contextReady ? error : tagFailure(error, 'run');
    }

    const cancel = async () => {
      if (!owned.has(id)) return;
      await mutate(() =>
        snapshot.run.cancelRequested
          ? {}
          : {
              run: { cancelRequested: true, updatedAt: deps.clock.now() },
              events: [event('run.cancelled')],
            },
      );
      controller.abort(new Error('Swarm cancelled'));
    };
    const abort = () => {
      void cancel().catch(() => {});
    };
    // The heartbeat (2.2). Losing the lease stops every further write: task
    // records stay as they are and the next executor reconciles them.
    let held = lease;
    let stopped = false;
    let lost: SwarmLeaseError | undefined;
    // Drain (2.2): no new dispatch; in-flight tasks finish and the run settles.
    let draining = drainSignalled;
    // The durable commit of the last cancel a renewal delivered.
    let cancelling: Promise<void> | undefined;
    // A renewal delivered a cancel (2.2). One no commit made durable is queued
    // again before the lease is let go, so the next executor still applies it.
    let delivered = false;
    let stopBeat: (() => void) | undefined;
    const lose = () => {
      lost ??= new SwarmLeaseError('lost');
      writeFailure ??= lost;
      controller.abort(writeFailure);
    };
    // One renewal at a time: the heartbeat and the check before the settle
    // share this chain, so each queued signal reaches exactly one of them.
    let renewals: Promise<void> = Promise.resolve();
    const renewLease = (): Promise<void> =>
      (renewals = renewals.then(async () => {
        if (stopped || !held || lost) return;
        try {
          const renewal = await leasing!.provider.renew(held, leaseTtl);
          // Noted even after this executor stopped: the release queues it again.
          if (renewal.held && renewal.signals.includes('cancel')) delivered = true;
          if (stopped) return;
          if (!renewal.held) return lose();
          held = renewal.lease;
          if (renewal.signals.includes('drain')) draining = true;
          if (renewal.signals.includes('cancel')) cancelling = cancel().catch(() => {});
        } catch {
          // A provider outage is survivable until the lease could have lapsed.
          if (!stopped && deps.clock.now() >= held.expiresAt) lose();
        }
      }));
    const beat = () => {
      if (!stopped && held && !lost)
        stopBeat = deps.clock.setTimeout(
          () => void renewLease().then(beat),
          Math.max(1, Math.floor(leaseTtl / 3)),
        );
    };
    beat();
    // Every task runs under the same child scope ID its execution context uses.
    const compactTask = async (taskId: string): Promise<void> => {
      await execution.ledger.compact(
        childScopeId(execution.scopeId, JSON.stringify([key.scope, key.runId, taskId])),
      );
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || snapshot.run.cancelRequested) await cancel();

    // A v2 run's persisted limits, tightened by this process's options (2.2).
    const limits = initial.run.dynamic ? tightenLimits(initial.run.dynamic, dynamic) : undefined;

    /** Spawned tasks commit with the parent's terminal state: a crash never duplicates them. */
    // Slots taken by spawns validated but not yet committed: two parents finishing
    // together must not both fit under maxTasks and then kill the run at commit.
    let reservedSlots = 0;

    async function finishTask(
      taskId: string,
      change: Partial<SwarmTaskRecord>,
      type: SwarmEventInput['type'],
      spawn: readonly SwarmTaskRecord[] = [],
    ): Promise<void> {
      reservedSlots += spawn.length;
      try {
        await commitFinish(taskId, change, type, spawn);
      } finally {
        reservedSlots -= spawn.length;
      }
    }

    async function commitFinish(
      taskId: string,
      change: Partial<SwarmTaskRecord>,
      type: SwarmEventInput['type'],
      spawn: readonly SwarmTaskRecord[],
    ): Promise<void> {
      await mutate(() => ({
        tasks: [{ ...records.get(taskId)!, ...change, finishedAt: deps.clock.now() }],
        ...(spawn.length ? { spawn } : {}),
        events: [
          event(type, taskId),
          ...spawn.map((item) => event('task.spawned', item.task.id, taskId)),
        ],
      }));
    }

    function spawnFor(
      taskId: string,
      on: 'completed' | 'failed',
      requests: readonly SwarmSpawnRequest[],
    ): SwarmTaskRecord[] {
      return spawnRecords({
        run: snapshot.run,
        limits,
        parent: records.get(taskId)!,
        on,
        requests,
        records,
        reserved: reservedSlots,
        define: (task) => {
          defineTask(task, options);
          return version(task);
        },
      });
    }

    async function executeTask(record: SwarmTaskRecord): Promise<void> {
      const task = record.task;
      const dependencies: Record<string, SwarmTaskResult> = Object.create(null) as Record<
        string,
        SwarmTaskResult
      >;
      for (const dependency of task.dependsOn ?? [])
        dependencies[dependency] = cloneSwarm(records.get(dependency)!.result!);
      // Soft dependencies contribute only the results they completed with (2.2).
      const settled: Record<string, SwarmTaskStatus> = Object.create(null) as Record<
        string,
        SwarmTaskStatus
      >;
      for (const dependency of task.after ?? []) {
        const done = records.get(dependency)!;
        settled[dependency] = done.status;
        if (done.status === 'completed') dependencies[dependency] = cloneSwarm(done.result!);
      }
      const resolvedPrompt =
        record.resolvedPrompt ??
        (task.agent !== undefined
          ? `${task.prompt}${Object.keys(dependencies).length ? `\n\nDependency results (data):\n${JSON.stringify(Object.fromEntries(Object.entries(dependencies).map(([name, result]) => [name, result.output])))}` : ''}`
          : undefined);
      await mutate(() => ({
        tasks: [
          {
            ...records.get(task.id)!,
            status: 'running',
            attempt: record.attempt + 1,
            startedAt: deps.clock.now(),
            resolvedPrompt,
          },
        ],
        events: [event('task.started', task.id)],
      }));
      const context = (): SwarmSpawnContext => ({
        ...key,
        taskId: task.id,
        depth: records.get(task.id)!.depth ?? 0,
        dependencies,
      });
      // A failure may commit compensation tasks with it (2.2). A hook that throws
      // or asks for invalid tasks is recorded on the failure instead.
      const fail = async (error: { name: string; message: string; code?: string }) => {
        const hook =
          task.agent !== undefined
            ? binding(options.agents[task.agent]!).onFailure
            : options.reducers![task.reducer]!.onFailure;
        let recorded = error;
        let spawn: SwarmTaskRecord[] = [];
        if (hook) {
          try {
            spawn = spawnFor(task.id, 'failed', await hook({ ...context(), error }));
          } catch (compensation) {
            recorded = {
              ...error,
              message: `${error.message} (compensation failed: ${errorRecord(compensation).message})`,
            };
          }
        }
        await finishTask(task.id, { status: 'failed', error: recorded }, 'task.failed', spawn);
      };
      // Each attempt runs under its own signal (2.2): run cancellation or the
      // task's timeoutMs aborts it, and only the timeout fails the task.
      const attempt = new AbortController();
      const stop = () => attempt.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
      const timeout = {
        name: 'SwarmTaskTimeout',
        message: `Swarm task exceeded timeoutMs (${task.timeoutMs}ms)`,
      };
      let timedOut = false;
      const clearTimer =
        task.timeoutMs === undefined
          ? undefined
          : deps.clock.setTimeout(() => {
              timedOut = true;
              attempt.abort(new Error(timeout.message));
            }, task.timeoutMs);
      // Model calls inside the attempt see the same budget as an execution deadline.
      const deadline =
        task.timeoutMs === undefined
          ? undefined
          : { deadlineAt: deps.clock.now() + task.timeoutMs };
      try {
        if (task.agent === undefined) {
          const reducer = options.reducers![task.reducer]!;
          const child = execution.child({
            scopeId: JSON.stringify([key.scope, key.runId, task.id]),
            policy: deadline
              ? intersectExecutionPolicies(reducer.policy, deadline)
              : reducer.policy,
            budget: reducer.budget,
          });
          assertExecutionPolicy(child, { now: deps.clock.now() });
          const queued: SwarmSpawnRequest[] = [];
          const output = await reducer.execute(dependencies, {
            ...key,
            taskId: task.id,
            signal: attempt.signal,
            execution: child,
            spawn(requests) {
              if (!Array.isArray(requests))
                throw new TypeError('spawn() takes an array of requests');
              queued.push(...requests);
            },
            settled,
            async readChannel(channel, afterSequence = 0, limit = 100) {
              if (!options.store.readChannel)
                throw new Error('This swarm store has no blackboard channels');
              return options.store.readChannel(key, channel, afterSequence, limit);
            },
          });
          if (output === undefined)
            throw new Error('Swarm reducer must return a serializable output');
          if (timedOut) await fail(timeout);
          else if (controller.signal.aborted)
            await finishTask(task.id, { status: 'cancelled' }, 'task.cancelled');
          else
            await finishTask(
              task.id,
              { status: 'completed', result: cloneSwarm({ output }) },
              'task.completed',
              spawnFor(task.id, 'completed', queued),
            );
          return;
        }
        const agent = binding(options.agents[task.agent]!);
        const nativeId = JSON.stringify([key.scope, key.runId, task.id]);
        const store: AgentRunStore = {
          load: async (runId) => {
            if (runId !== nativeId) throw new Error('Swarm agent run scope mismatch');
            const state = records.get(task.id)!.agentState;
            return state ? cloneSwarm(state) : undefined;
          },
          save: async (envelope) => {
            if (envelope.runId !== nativeId || envelope.scope !== key.scope)
              throw new Error('Swarm agent run scope mismatch');
            await mutate(() => ({
              tasks: [{ ...records.get(task.id)!, agentState: cloneSwarm(envelope) }],
            }));
          },
        };
        const baseTools = agent.tools ?? (agent.agent.def.tools as AgentToolSet | undefined);
        const boardTools = agent.blackboard
          ? blackboardTools({
              key,
              task,
              config: agent.blackboard,
              store: options.store,
              attempt: () => records.get(task.id)!.attempt,
              now: () => deps.clock.now(),
              post: (post) => mutate(() => ({ posts: [post] })),
            })
          : {};
        for (const name of Object.keys(boardTools))
          if (baseTools && Object.hasOwn(baseTools, name))
            throw new Error(`Tool name ${name} is reserved for the swarm blackboard`);
        const tools = agent.blackboard ? { ...baseTools, ...boardTools } : baseTools;
        const nativeOptions = {
          ...agent.agent.def,
          prompt: resolvedPrompt,
          session: { store, runId: nativeId, scope: key.scope },
          output: agent.output,
          ...(tools !== undefined ? { tools } : {}),
          toolsContext: agent.toolsContext,
          verify: agent.verify,
          maxOutputAttempts: agent.maxOutputAttempts,
          maxVerifyAttempts: agent.maxVerifyAttempts ?? agent.agent.def.maxVerifyAttempts,
          signal: attempt.signal,
          execution: execution.child({
            scopeId: nativeId,
            // No per-attempt deadline here: the native run saves its policy and a
            // later attempt's deadline would read as a changed constraint on resume.
            // The attempt signal enforces timeoutMs for agents.
            policy: agent.policy,
            budget: intersectBudgetLimits(agent.agent.def.budget, agent.budget),
          }),
          bindingId: record.bindingVersion,
          retryToolCallIds: resume?.retryToolCallIds?.[task.id],
          clientToolResults: resume?.clientToolResults?.[task.id],
          deps: { ...agent.agent.def.deps, ...options.deps },
          approvalResponses: resume?.approvals?.[task.id]
            ? [...resume.approvals[task.id]!]
            : undefined,
        } as AgentRunOptions<unknown>;
        const result = records.get(task.id)!.agentState
          ? await resumeAgent(
              nativeOptions as AgentRunOptions<unknown> & {
                session: NonNullable<AgentRunOptions['session']>;
              },
            )
          : await runAgent(nativeOptions);
        if (timedOut) await fail(timeout);
        else if (controller.signal.aborted) {
          await finishTask(task.id, { status: 'cancelled' }, 'task.cancelled');
        } else if (result.status === 'completed') {
          if (result.output === undefined)
            throw new Error('Swarm agents must return a serializable output');
          const spawn = spawnFor(
            task.id,
            'completed',
            agent.spawn ? await agent.spawn(result.output, context()) : [],
          );
          await finishTask(
            task.id,
            {
              status: 'completed',
              result: { output: result.output, text: result.text, agentResult: result },
            },
            'task.completed',
            spawn,
          );
        } else if (result.status === 'suspended') {
          await finishTask(
            task.id,
            {
              status: 'suspended',
              result: { output: null, text: result.text, agentResult: result },
            },
            'task.suspended',
          );
        } else if (
          result.status === 'stopped' &&
          result.reason === 'tool-reconciliation-required'
        ) {
          await finishTask(
            task.id,
            {
              status: 'needs_reconciliation',
              error: { name: 'ToolReconciliationRequired', message: result.reason },
            },
            'task.reconciliation',
          );
        } else {
          await fail(
            result.status === 'failed'
              ? result.error
              : { name: 'AgentStopped', message: result.reason },
          );
        }
      } catch (error) {
        if (writeFailure) throw error;
        if (timedOut) await fail(timeout);
        else if (controller.signal.aborted)
          await finishTask(
            task.id,
            { status: 'cancelled', error: errorRecord(error) },
            'task.cancelled',
          );
        else await fail(errorRecord(error));
      } finally {
        clearTimer?.();
        controller.signal.removeEventListener('abort', stop);
      }
    }

    async function drive(): Promise<SwarmSnapshot> {
      const running = new Set<Promise<void>>();
      try {
        // A crash between a terminal commit and its compaction, or a 2.1 run.
        for (const record of records.values())
          if (TERMINAL.has(record.status)) await compactTask(record.task.id);
        while (true) {
          if (writeFailure) throw writeFailure;
          const changed: SwarmTaskRecord[] = [];
          const controlEvents: SwarmEventInput[] = [];
          for (const record of records.values()) {
            if (record.status !== 'pending') continue;
            // Only hard dependencies block; a soft one just has to settle (2.2).
            const blocked = (record.task.dependsOn ?? []).some((dep) =>
              ['failed', 'blocked', 'cancelled'].includes(records.get(dep)!.status),
            );
            if (snapshot.run.cancelRequested || blocked) {
              const status = snapshot.run.cancelRequested ? 'cancelled' : 'blocked';
              changed.push({ ...record, status, finishedAt: deps.clock.now() });
              controlEvents.push(
                event(status === 'cancelled' ? 'task.cancelled' : 'task.blocked', record.task.id),
              );
            }
          }
          if (changed.length) {
            await mutate(() => ({ tasks: changed, events: controlEvents }));
            for (const record of changed) await compactTask(record.task.id);
            continue;
          }
          for (const record of records.values()) {
            if (running.size >= concurrency || snapshot.run.cancelRequested || draining) break;
            if (
              record.status !== 'pending' ||
              !(record.task.dependsOn ?? []).every(
                (dep) => records.get(dep)!.status === 'completed',
              ) ||
              !(record.task.after ?? []).every((dep) => TERMINAL.has(records.get(dep)!.status))
            )
              continue;
            // Reserve a slot synchronously; executeTask's first queued commit precedes its effect.
            // The slot frees only after the finished task's accounting has folded.
            const pending = executeTask(record).then(async () => {
              if (TERMINAL.has(records.get(record.task.id)!.status))
                await compactTask(record.task.id);
            });
            running.add(pending);
            void pending
              .finally(() => {
                running.delete(pending);
              })
              .catch(() => {});
          }
          if (running.size) {
            await Promise.race(running);
            continue;
          }
          const list = [...records.values()];
          const status = snapshot.run.cancelRequested
            ? 'cancelled'
            : list.some((task) =>
                  ['suspended', 'needs_reconciliation', 'pending'].includes(task.status),
                )
              ? 'suspended'
              : list.every((task) => task.status === 'completed')
                ? 'completed'
                : 'partial';
          if (held && status !== 'cancelled') {
            // Signals sent since the last beat apply before the run settles (2.2):
            // a cancel turns this settle into a cancellation.
            await renewLease();
            await cancelling;
            if (writeFailure) throw writeFailure;
            if (snapshot.run.cancelRequested) continue;
          }
          await mutate(() => ({
            run: { status, updatedAt: deps.clock.now() },
            events: [
              ...(draining ? [event('run.drained')] : []),
              event('run.settled', undefined, status),
            ],
          }));
          return cloneSwarm({ run: snapshot.run, tasks: list });
        }
      } catch (error) {
        controller.abort(error);
        // A replacement executor must not overlap still-running local effects.
        await Promise.allSettled(running);
        // A zombie's first write after a takeover can reach the revision check
        // before its heartbeat notices (2.2); one renewal tells a lost lease
        // from a conflict with a holder that still owns the run.
        if (error instanceof SwarmConflictError || writeFailure instanceof SwarmConflictError)
          await renewLease();
        throw lost ?? error;
      } finally {
        stopped = true;
        stopBeat?.();
        signal?.removeEventListener('abort', abort);
        // A delivered cancel that no commit made durable, including one a
        // renewal still in flight brings, goes back in the queue while this
        // executor holds the lease (2.2), unless the run settled past it.
        await renewals;
        await cancelling;
        if (
          delivered &&
          !snapshot.run.cancelRequested &&
          snapshot.run.status !== 'completed' &&
          snapshot.run.status !== 'partial'
        )
          await restore(key, ['cancel']);
        // A stale token is ignored, so this is safe after a takeover too.
        await unclaim(held);
        owned.delete(id);
        active.delete(id);
      }
    }
    const result = drive();
    void result.catch(() => {});
    const handle: SwarmHandle = {
      ...key,
      result,
      // A failed executor's reader throws what result rejects with (2.2): a
      // revision conflict can still turn out to be a lost lease.
      events: (settings) =>
        events(key, settings, () =>
          writeFailure === undefined
            ? undefined
            : result.then(
                () => writeFailure,
                (error: unknown) => error,
              ),
        ),
      cancel,
      drain: () => {
        draining = true;
        return result;
      },
    };
    active.set(id, handle);
    return handle;
  }

  /**
   * A resume's checks on the loaded run and the task changes its claim commits.
   * Every failure here is the run's own (2.2): recover reports it and goes on.
   */
  function prepareResume(
    input: SwarmResumeOptions,
    snapshot: SwarmSnapshot | undefined,
  ): {
    snapshot: SwarmSnapshot;
    changes: SwarmTaskRecord[];
    controlEvents: SwarmEventInput[];
  } {
    if (!snapshot) throw new Error('Swarm run not found');
    validateSwarmSnapshot(snapshot, input);
    if (
      (input.expectedRevision !== undefined && snapshot.run.revision !== input.expectedRevision) ||
      (input.expectedStatus !== undefined && snapshot.run.status !== input.expectedStatus)
    )
      throw new SwarmConflictError(
        `Swarm run is at revision ${snapshot.run.revision} with status ${snapshot.run.status}, not the expected one`,
      );
    if (snapshot.run.version === 2 && !canSpawn)
      throw new Error(
        'This swarm store cannot persist spawned tasks: it lacks the "spawn" capability',
      );
    validateTasks(
      snapshot.tasks.map((record) => record.task),
      options,
    );
    if (
      snapshot.run.definitionVersion !== definitionVersion ||
      snapshot.tasks.some((record) => record.bindingVersion !== version(record.task))
    )
      throw new Error('Swarm definition version mismatch');
    const retry = new Set(input.retryTaskIds ?? []);
    for (const taskId of [
      ...retry,
      ...Object.keys(input.approvals ?? {}),
      ...Object.keys(input.retryToolCallIds ?? {}),
      ...Object.keys(input.clientToolResults ?? {}),
    ]) {
      if (!snapshot.tasks.some((record) => record.task.id === taskId))
        throw new Error(`Unknown resume task: ${taskId}`);
    }
    if (Object.keys(input.retryToolCallIds ?? {}).some((taskId) => !retry.has(taskId)))
      throw new Error('Tool reconciliation requires explicit retryTaskIds authorization');
    const changes: SwarmTaskRecord[] = [];
    const controlEvents: SwarmEventInput[] = [];
    for (const record of snapshot.tasks) {
      if (record.status === 'running' || record.status === 'needs_reconciliation') {
        if (record.agentState?.result?.status === 'suspended') {
          record.result = {
            output: null,
            text: record.agentState.result.text,
            agentResult: record.agentState.result,
          };
          record.status =
            Object.hasOwn(input.approvals ?? {}, record.task.id) ||
            Object.hasOwn(input.clientToolResults ?? {}, record.task.id)
              ? 'pending'
              : 'suspended';
          changes.push(record);
          continue;
        }
        const safe =
          record.agentState?.phase === 'terminal' ||
          record.task.replay === 'safe' ||
          retry.has(record.task.id);
        record.status = safe ? 'pending' : 'needs_reconciliation';
        if (!safe)
          controlEvents.push({
            type: 'task.reconciliation',
            taskId: record.task.id,
            timestamp: deps.clock.now(),
          });
        changes.push(record);
      } else if (
        record.status === 'suspended' &&
        (Object.hasOwn(input.approvals ?? {}, record.task.id) ||
          Object.hasOwn(input.clientToolResults ?? {}, record.task.id))
      ) {
        record.status = 'pending';
        changes.push(record);
      }
    }
    return { snapshot, changes, controlEvents };
  }

  const swarm: Swarm = {
    async run(input) {
      if (!input.scope) throw new Error('Swarm scope is required');
      validateTasks(input.tasks, options);
      if (dynamic && input.tasks.length > dynamic.maxTasks)
        throw new Error(`Swarm task limit exceeded (${dynamic.maxTasks})`);
      const now = deps.clock.now();
      const key = { scope: input.scope, runId: input.runId ?? deps.generateId() };
      if (!key.runId) throw new Error('Swarm runId is required');
      const snapshot: SwarmSnapshot = {
        run: {
          ...key,
          kind: 'deuz-swarm',
          // A dynamic run is version 2 and carries its limits; 2.1 rejects it.
          ...(dynamic ? { version: 2 as const, dynamic } : { version: 1 as const }),
          definitionVersion,
          status: 'running',
          revision: 0,
          lastSequence: 0,
          createdAt: now,
          updatedAt: now,
          cancelRequested: false,
          executionState: createExecutionContext({
            scopeId: swarmKey(key),
            policy: options.policy,
            budget: options.budget,
            admission: options.admission,
          }).snapshot(),
        },
        tasks: cloneSwarm(
          input.tasks.map((task) => ({
            task,
            bindingVersion: version(task),
            status: 'pending' as const,
            attempt: 0,
          })),
        ),
      };
      let lease = await claim(key);
      let queued: readonly LeaseSignal[] = [];
      try {
        // A new run starts clean: whatever its key still queues predates it.
        ({ lease, signals: queued } = await collect(lease));
        snapshot.run = await options.store.create(snapshot, [
          { type: 'run.started', timestamp: now },
        ]);
      } catch (error) {
        // The key may belong to an existing run, whose queued cancel stays queued.
        await restore(key, queued);
        await unclaim(lease);
        throw error;
      }
      return start(snapshot, { ...key, signal: input.signal }, lease);
    },
    async resume(input) {
      if (owned.has(swarmKey(input))) throw new Error('Swarm run already has an executor');
      // The claim comes first (2.2): a run another executor holds is refused
      // before its snapshot is read, which keeps recover's scan cheap. The
      // resume commit's revision check then fences out any writer that was
      // still active a moment ago.
      let lease = await claim(input);
      let queued: readonly LeaseSignal[] = [];
      let snapshot: SwarmSnapshot;
      try {
        const loaded = await options.store.load(input);
        let prepared: ReturnType<typeof prepareResume>;
        try {
          prepared = prepareResume(input, loaded);
        } catch (error) {
          throw tagFailure(error, 'run');
        }
        snapshot = prepared.snapshot;
        const { changes, controlEvents } = prepared;
        ({ lease, signals: queued } = await collect(lease));
        // A cancel whose holder stopped before reading it applies here, before
        // any dispatch; one that lost the race to the run's end changes nothing.
        const cancelNow =
          queued.includes('cancel') &&
          !snapshot.run.cancelRequested &&
          snapshot.run.status !== 'completed' &&
          snapshot.run.status !== 'partial';
        const now = deps.clock.now();
        snapshot.run = await options.store.commit({
          scope: input.scope,
          runId: input.runId,
          expectedRevision: snapshot.run.revision,
          run: {
            status: 'running',
            updatedAt: now,
            ...(cancelNow ? { cancelRequested: true } : {}),
          },
          tasks: changes,
          events: [
            { type: 'run.resumed', timestamp: now },
            ...(cancelNow ? [{ type: 'run.cancelled' as const, timestamp: now }] : []),
            ...controlEvents,
          ],
        });
      } catch (error) {
        await restore(input, queued);
        await unclaim(lease);
        throw error;
      }
      return start(snapshot, input, lease, queued.includes('drain'));
    },
    async requestCancel(key): Promise<SwarmCancelRequest> {
      const id = swarmKey(key);
      for (let attempt = 0; ; attempt++) {
        const local = active.get(id);
        if (local) {
          await local.cancel();
          return 'signalled';
        }
        const run = options.store.head
          ? await options.store.head(key)
          : (await options.store.load(key))?.run;
        if (!run) throw new Error('Swarm run not found');
        if (run.status === 'completed' || run.status === 'partial' || run.status === 'cancelled')
          return 'settled';
        if (leasing && (await leasing.provider.signal(leaseKey(key), 'cancel'))) return 'signalled';
        if (run.cancelRequested) return 'recorded';
        // Nobody drives it: record the request for whichever executor comes next.
        try {
          const now = deps.clock.now();
          await options.store.commit({
            scope: key.scope,
            runId: key.runId,
            expectedRevision: run.revision,
            run: { cancelRequested: true, updatedAt: now },
            events: [{ type: 'run.cancelled', timestamp: now }],
          });
          return 'recorded';
        } catch (error) {
          // An executor may have claimed the run meanwhile; look again.
          if (!(error instanceof SwarmConflictError) || attempt >= 4) throw error;
        }
      }
    },
    async recover(input = {}) {
      if (!leasing) throw new Error('Swarm recover requires the lease option');
      if (!options.store.listRuns || !options.store.capabilities?.includes('list'))
        throw new Error('This swarm store cannot list runs: it lacks the "list" capability');
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('Swarm recover limit must be an integer from 1 to 1000');
      // Page through the running runs (2.2): heartbeats and most commits leave
      // updatedAt alone, so live runs can fill any one page. The listing comes
      // first, so a listing failure rejects before anything has started.
      const listed = new Map<string, { key: SwarmKey; revision: number }>();
      let after: SwarmRunQuery['after'];
      while (listed.size < RECOVER_SCAN) {
        const size = Math.min(RECOVER_PAGE, RECOVER_SCAN - listed.size);
        const page = await options.store.listRuns({
          status: 'running',
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          limit: size,
          ...(after ? { after } : {}),
        });
        const known = listed.size;
        // A store may return more rows than asked: the cursor follows the rows kept.
        const kept = page.slice(0, size);
        for (const run of kept)
          listed.set(swarmKey(run), {
            key: { scope: run.scope, runId: run.runId },
            revision: run.revision,
          });
        const last = kept.at(-1);
        // A short page ends the listing, and so does one that adds nothing.
        if (!last || kept.length < size || listed.size === known) break;
        after = { updatedAt: last.updatedAt, scope: last.scope, runId: last.runId };
      }
      const handles: SwarmHandle[] = [];
      const failed: SwarmRecovery['failed'] = [];
      let failing = 0;
      for (const [id, { key, revision }] of listed) {
        if (handles.length >= limit) break;
        if (owned.has(id)) continue;
        try {
          handles.push(
            await swarm.resume({ ...key, expectedRevision: revision, expectedStatus: 'running' }),
          );
          failing = 0;
        } catch (error) {
          // A live holder, a run that moved on since it was listed, or one this
          // process took up meanwhile.
          if (
            error instanceof SwarmLeaseError ||
            error instanceof SwarmConflictError ||
            owned.has(id)
          )
            continue;
          failed.push({ key, error });
          // A run's own failure (a definition this process lacks, say) must not
          // cost the others their recovery. An outage would fail every run
          // after it: a lease provider that throws on acquire ends the scan at
          // once, any other failure (a store's, say) once it repeats.
          const kind = typeof error === 'object' && error ? failureKinds.get(error) : undefined;
          if (kind === 'lease') break;
          failing = kind === 'run' ? 0 : failing + 1;
          if (failing >= RECOVER_FAILURES) break;
        }
      }
      return { handles, failed };
    },
    get: (key) => options.store.load(key),
    events,
  };
  return swarm;
}
