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
import type { Lease } from '../types/lease';
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
  SwarmResumeOptions,
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
    const lease = await leasing.provider.acquire({
      key: leaseKey(key),
      owner: leaseOwner,
      ttlMs: leaseTtl,
    });
    if (!lease) throw new SwarmLeaseError('held');
    return lease;
  };
  const unclaim = async (lease: Lease | undefined): Promise<void> => {
    if (lease) await leasing!.provider.release(lease).catch(() => {});
  };

  const events = (
    key: SwarmKey,
    settings: { afterSequence?: number; signal?: AbortSignal } = {},
    failure?: () => unknown,
  ): AsyncIterable<SwarmEvent> => ({
    async *[Symbol.asyncIterator]() {
      let cursor = settings.afterSequence ?? 0;
      validateEventCursor(cursor, 256);
      while (!settings.signal?.aborted) {
        const failed = failure?.();
        if (failed) throw failed;
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
    try {
      execution = initial.run.executionState
        ? createExecutionContext({
            snapshot: initial.run.executionState,
            policy: options.policy,
            budget: options.budget,
            persist,
          })
        : createExecutionContext({
            scopeId: id,
            policy: options.policy,
            budget: options.budget,
            persist,
          });
      // Policy/scope state is durable before the first dispatch or reservation.
      await mutate(() => ({ run: { executionState: execution.snapshot() } }));
    } catch (error) {
      owned.delete(id);
      await unclaim(lease);
      throw error;
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
    let stopBeat: (() => void) | undefined;
    const lose = () => {
      writeFailure ??= new SwarmLeaseError('lost');
      controller.abort(writeFailure);
    };
    const renewLease = async (): Promise<void> => {
      if (stopped || !held) return;
      try {
        const renewal = await leasing!.provider.renew(held, leaseTtl);
        if (stopped) return;
        if (!renewal.held) return lose();
        held = renewal.lease;
        for (const request of renewal.signals)
          if (request === 'cancel') void cancel().catch(() => {});
      } catch {
        // A provider outage is survivable until the lease could have lapsed.
        if (stopped) return;
        if (deps.clock.now() >= held.expiresAt) return lose();
      }
      beat();
    };
    const beat = () => {
      if (!stopped && held)
        stopBeat = deps.clock.setTimeout(
          () => void renewLease(),
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
    async function finishTask(
      taskId: string,
      change: Partial<SwarmTaskRecord>,
      type: SwarmEventInput['type'],
      spawn: readonly SwarmTaskRecord[] = [],
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
            policy: deadline ? intersectExecutionPolicies(agent.policy, deadline) : agent.policy,
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
            if (running.size >= concurrency || snapshot.run.cancelRequested) break;
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
          await mutate(() => ({
            run: { status, updatedAt: deps.clock.now() },
            events: [event('run.settled', undefined, status)],
          }));
          return cloneSwarm({ run: snapshot.run, tasks: list });
        }
      } catch (error) {
        controller.abort(error);
        // A replacement executor must not overlap still-running local effects.
        await Promise.allSettled(running);
        throw writeFailure instanceof SwarmLeaseError ? writeFailure : error;
      } finally {
        stopped = true;
        stopBeat?.();
        signal?.removeEventListener('abort', abort);
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
      events: (settings) => events(key, settings, () => writeFailure),
      cancel,
      drain: () => Promise.reject(new Error('Not implemented')),
    };
    active.set(id, handle);
    return handle;
  }

  return {
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
      const lease = await claim(key);
      try {
        snapshot.run = await options.store.create(snapshot, [
          { type: 'run.started', timestamp: now },
        ]);
      } catch (error) {
        await unclaim(lease);
        throw error;
      }
      return start(snapshot, { ...key, signal: input.signal }, lease);
    },
    async resume(input) {
      if (owned.has(swarmKey(input))) throw new Error('Swarm run already has an executor');
      const snapshot = await options.store.load(input);
      if (!snapshot) throw new Error('Swarm run not found');
      validateSwarmSnapshot(snapshot, input);
      if (
        (input.expectedRevision !== undefined &&
          snapshot.run.revision !== input.expectedRevision) ||
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
      // The claim precedes the resume commit (2.2); the commit's revision check
      // then fences out any writer that was still active a moment ago.
      const lease = await claim(input);
      try {
        snapshot.run = await options.store.commit({
          scope: input.scope,
          runId: input.runId,
          expectedRevision: snapshot.run.revision,
          run: { status: 'running', updatedAt: deps.clock.now() },
          tasks: changes,
          events: [{ type: 'run.resumed', timestamp: deps.clock.now() }, ...controlEvents],
        });
      } catch (error) {
        await unclaim(lease);
        throw error;
      }
      return start(snapshot, input, lease);
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
    async recover() {
      throw new Error('Not implemented');
    },
    get: (key) => options.store.load(key),
    events,
  };
}
