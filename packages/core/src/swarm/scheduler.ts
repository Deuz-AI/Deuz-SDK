import { runAgent, resumeAgent } from '../agent-run';
import { assertExecutionPolicy, createExecutionContext } from '../execution-policy';
import { intersectBudgetLimits } from '../budget-ledger';
import { resolveDependencies } from '../internal/resolve-deps';
import type { DeuzAgent } from '../agent';
import type { AgentRunOptions, AgentRunStore } from '../types/agent-run';
import type { NativeExecutionContext } from '../types/execution';
import type {
  Swarm,
  SwarmAgentBinding,
  SwarmCommit,
  SwarmEvent,
  SwarmEventInput,
  SwarmHandle,
  SwarmKey,
  SwarmOptions,
  SwarmResumeOptions,
  SwarmSnapshot,
  SwarmStore,
  SwarmTask,
  SwarmTaskRecord,
  SwarmTaskResult,
} from '../types/swarm';
import { cloneSwarm, swarmKey, validateEventCursor, validateSwarmSnapshot } from './store';

const executors = new WeakMap<SwarmStore, Set<string>>();

function binding(value: DeuzAgent | SwarmAgentBinding): SwarmAgentBinding {
  return 'def' in value ? { agent: value } : value;
}

function errorRecord(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function validateTasks(tasks: readonly SwarmTask[], options: SwarmOptions): void {
  const nodes = new Map<string, SwarmTask>();
  for (const task of tasks) {
    if (!task.id || nodes.has(task.id))
      throw new Error('Swarm task ids must be nonempty and unique');
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
    nodes.set(task.id, task);
  }
  const counts = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    const deps = task.dependsOn ?? [];
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
        const snapshot = await options.store.load(key);
        if (!snapshot) throw new Error('Swarm run not found');
        if (cursor < snapshot.run.lastSequence) continue;
        if (snapshot.run.status !== 'running') return;
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

  async function start(initial: SwarmSnapshot, resume?: SwarmResumeOptions): Promise<SwarmHandle> {
    const key: SwarmKey = { scope: initial.run.scope, runId: initial.run.runId };
    const id = swarmKey(key);
    if (owned.has(id)) throw new Error('Swarm run already has an executor');
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
        for (const task of change.tasks ?? []) records.set(task.task.id, cloneSwarm(task));
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
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || snapshot.run.cancelRequested) await cancel();

    async function finishTask(
      taskId: string,
      change: Partial<SwarmTaskRecord>,
      type: SwarmEventInput['type'],
    ): Promise<void> {
      await mutate(() => ({
        tasks: [{ ...records.get(taskId)!, ...change, finishedAt: deps.clock.now() }],
        events: [event(type, taskId)],
      }));
    }

    async function executeTask(record: SwarmTaskRecord): Promise<void> {
      const task = record.task;
      const dependencies: Record<string, SwarmTaskResult> = Object.create(null) as Record<
        string,
        SwarmTaskResult
      >;
      for (const dependency of task.dependsOn ?? [])
        dependencies[dependency] = cloneSwarm(records.get(dependency)!.result!);
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
      try {
        if (task.agent === undefined) {
          const reducer = options.reducers![task.reducer]!;
          const child = execution.child({
            scopeId: JSON.stringify([key.scope, key.runId, task.id]),
            policy: reducer.policy,
            budget: reducer.budget,
          });
          assertExecutionPolicy(child, { now: deps.clock.now() });
          const output = await reducer.execute(dependencies, {
            ...key,
            taskId: task.id,
            signal: controller.signal,
            execution: child,
          });
          if (output === undefined)
            throw new Error('Swarm reducer must return a serializable output');
          if (controller.signal.aborted)
            await finishTask(task.id, { status: 'cancelled' }, 'task.cancelled');
          else
            await finishTask(
              task.id,
              { status: 'completed', result: cloneSwarm({ output }) },
              'task.completed',
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
        const nativeOptions = {
          ...agent.agent.def,
          prompt: resolvedPrompt,
          session: { store, runId: nativeId, scope: key.scope },
          output: agent.output,
          ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
          toolsContext: agent.toolsContext,
          verify: agent.verify,
          maxOutputAttempts: agent.maxOutputAttempts,
          maxVerifyAttempts: agent.maxVerifyAttempts ?? agent.agent.def.maxVerifyAttempts,
          signal: controller.signal,
          execution: execution.child({
            scopeId: nativeId,
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
        if (controller.signal.aborted) {
          await finishTask(task.id, { status: 'cancelled' }, 'task.cancelled');
        } else if (result.status === 'completed') {
          if (result.output === undefined)
            throw new Error('Swarm agents must return a serializable output');
          await finishTask(
            task.id,
            {
              status: 'completed',
              result: { output: result.output, text: result.text, agentResult: result },
            },
            'task.completed',
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
          await finishTask(
            task.id,
            {
              status: 'failed',
              error:
                result.status === 'failed'
                  ? result.error
                  : { name: 'AgentStopped', message: result.reason },
            },
            'task.failed',
          );
        }
      } catch (error) {
        if (writeFailure) throw error;
        await finishTask(
          task.id,
          { status: controller.signal.aborted ? 'cancelled' : 'failed', error: errorRecord(error) },
          controller.signal.aborted ? 'task.cancelled' : 'task.failed',
        );
      }
    }

    async function drive(): Promise<SwarmSnapshot> {
      const running = new Set<Promise<void>>();
      try {
        while (true) {
          if (writeFailure) throw writeFailure;
          const changed: SwarmTaskRecord[] = [];
          const controlEvents: SwarmEventInput[] = [];
          for (const record of records.values()) {
            if (record.status !== 'pending') continue;
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
            continue;
          }
          for (const record of records.values()) {
            if (running.size >= concurrency || snapshot.run.cancelRequested) break;
            if (
              record.status !== 'pending' ||
              !(record.task.dependsOn ?? []).every(
                (dep) => records.get(dep)!.status === 'completed',
              )
            )
              continue;
            // Reserve a slot synchronously; executeTask's first queued commit precedes its effect.
            const pending = executeTask(record);
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
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
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
    };
    active.set(id, handle);
    return handle;
  }

  return {
    async run(input) {
      if (!input.scope) throw new Error('Swarm scope is required');
      validateTasks(input.tasks, options);
      const now = deps.clock.now();
      const key = { scope: input.scope, runId: input.runId ?? deps.generateId() };
      if (!key.runId) throw new Error('Swarm runId is required');
      const snapshot: SwarmSnapshot = {
        run: {
          ...key,
          kind: 'deuz-swarm',
          version: 1,
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
      snapshot.run = await options.store.create(snapshot, [
        { type: 'run.started', timestamp: now },
      ]);
      return start(snapshot, { ...key, signal: input.signal });
    },
    async resume(input) {
      if (owned.has(swarmKey(input))) throw new Error('Swarm run already has an executor');
      const snapshot = await options.store.load(input);
      if (!snapshot) throw new Error('Swarm run not found');
      validateSwarmSnapshot(snapshot, input);
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
      snapshot.run = await options.store.commit({
        ...input,
        expectedRevision: snapshot.run.revision,
        run: { status: 'running', updatedAt: deps.clock.now() },
        tasks: changes,
        events: [{ type: 'run.resumed', timestamp: deps.clock.now() }, ...controlEvents],
      });
      return start(snapshot, input);
    },
    get: (key) => options.store.load(key),
    events,
  };
}
