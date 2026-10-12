/**
 * a2a/runtime.ts — the task lifecycle behind `createA2AHandler` (2.3).
 *
 * Every incoming message starts a turn: the executor runs once and drives the
 * task through its execution context. Each change is applied to the stored
 * task under a per-task lock (load, change, save, then announce), so updates,
 * cancellations and follow-up messages of one task never interleave in this
 * process. The task is reloaded before every change, so a task finished by
 * another instance sharing the store is noticed at the next update.
 */
import { AbortError, InvalidRequestError } from '../errors';
import type { ResolvedDependencies } from '../types/deps';
import { A2AError, isOwnProtocolError } from './errors';
import { isTerminalState, toMessage, type A2AErrorReason } from './protocol';
import type {
  A2AArtifact,
  A2AArtifactInput,
  A2AArtifactOptions,
  A2ACancelTaskRequest,
  A2AExecutionContext,
  A2AExecutor,
  A2AMessage,
  A2AMessageInput,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2AStatusOptions,
  A2AStreamResponse,
  A2ATask,
  A2ATaskScope,
  A2ATaskState,
  A2ATaskStore,
} from './types';

export function protocolError(reason: A2AErrorReason, message: string): A2AError {
  return new A2AError({ reason, message });
}

/** A task with at most the `historyLength` most recent history messages. */
export function withHistory(task: A2ATask, historyLength: number | undefined): A2ATask {
  if (historyLength === undefined) return task;
  return { ...task, history: historyLength <= 0 ? [] : (task.history ?? []).slice(-historyLength) };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // Nobody may be waiting (a client that went away): never an unhandled rejection.
  promise.catch(() => {});
  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    },
  };
}

/** Where a stream's events go: the response of a streaming request. */
export interface TurnSink {
  event(event: A2AStreamResponse): void;
  /** No more events. */
  end(): void;
  /** The turn failed after events may have been sent; no more events. */
  error(error: A2AError): void;
  /** The client went away: skip it from now on. */
  readonly closed: boolean;
}

/** What a request needs to know about the turn it started. */
export interface Turn {
  readonly key: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly scope: A2ATaskScope;
  /** The message that started the turn, with its ids. */
  readonly message: A2AMessage;
  /** The task a follow-up turn continues; `undefined` for a new interaction. */
  readonly started: A2ATask | undefined;
  readonly controller: AbortController;
  /** Resolves at the turn's first event: the task snapshot or the reply. */
  readonly first: Deferred<A2ASendMessageResponse>;
  /** Resolves when the turn ends or the task is interrupted. */
  readonly outcome: Deferred<A2ASendMessageResponse>;
  /** The streams following this turn. */
  readonly sinks: Set<TurnSink>;
  task: A2ATask | undefined;
  replied: A2AMessage | undefined;
  /** This turn changed the task. */
  changed: boolean;
  ended: boolean;
}

/** The parts of a request a turn needs. */
export interface TurnInfo {
  scope: A2ATaskScope;
  extensions: readonly string[];
  httpRequest: Request;
}

const KNOWN_STATES: ReadonlySet<A2ATaskState> = new Set([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text === '' ? 'The agent failed.' : text;
}

export interface TaskRuntimeOptions {
  store: A2ATaskStore;
  executor: A2AExecutor;
  deps: ResolvedDependencies;
  report: (error: unknown) => void;
}

export function createTaskRuntime(options: TaskRuntimeOptions) {
  const { store, executor, deps, report } = options;
  /** Running turns, by task key. */
  const live = new Map<string, Turn>();
  const locks = new Map<string, Promise<void>>();

  const now = () => new Date(deps.clock.now()).toISOString();
  const keyOf = (taskId: string, scope: A2ATaskScope) =>
    JSON.stringify([scope.tenant ?? null, scope.owner ?? null, taskId]);

  function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => {},
      () => {},
    );
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  function createTurn(fields: {
    key: string;
    taskId: string;
    contextId: string;
    scope: A2ATaskScope;
    message: A2AMessage;
    started: A2ATask | undefined;
    sink: TurnSink | undefined;
  }): Turn {
    const { sink, ...rest } = fields;
    return {
      ...rest,
      controller: new AbortController(),
      first: deferred(),
      outcome: deferred(),
      sinks: new Set(sink ? [sink] : []),
      task: fields.started,
      replied: undefined,
      changed: false,
      ended: false,
    };
  }

  function result(turn: Turn): A2ASendMessageResponse {
    return turn.replied
      ? { message: structuredClone(turn.replied) }
      : { task: structuredClone(turn.task as A2ATask) };
  }

  /** Sends an event to the streams following the turn. */
  function announce(turn: Turn, event: A2AStreamResponse): void {
    for (const sink of turn.sinks) {
      if (sink.closed) turn.sinks.delete(sink);
      else sink.event(structuredClone(event));
    }
  }

  /** An update of the turn: it answers a non-blocking request, then goes to the streams. */
  function publish(turn: Turn, event: A2AStreamResponse): void {
    turn.first.resolve(result(turn));
    announce(turn, event);
  }

  function detach(turn: Turn): void {
    turn.ended = true;
    if (live.get(turn.key) === turn) live.delete(turn.key);
  }

  /** The turn is over: whatever waits for it gets the task or the reply. */
  function end(turn: Turn): void {
    if (turn.ended) return;
    detach(turn);
    const value = result(turn);
    turn.first.resolve(value);
    turn.outcome.resolve(value);
    for (const sink of turn.sinks) sink.end();
    turn.sinks.clear();
  }

  /** The turn is over and the request is answered with `error`. */
  function fail(turn: Turn, error: A2AError): void {
    if (turn.ended) return;
    detach(turn);
    turn.first.reject(error);
    turn.outcome.reject(error);
    for (const sink of turn.sinks) sink.error(error);
    turn.sinks.clear();
  }

  function turnOver(turn: Turn): A2AError {
    return protocolError(
      'UNSUPPORTED_OPERATION',
      `The turn of task ${turn.taskId} has ended; it takes no more updates.`,
    );
  }

  function agentMessage(turn: Turn, input: A2AMessageInput, withTask: boolean): A2AMessage {
    const {
      taskId: _taskId,
      contextId: _contextId,
      ...message
    } = toMessage(input, { role: 'ROLE_AGENT', generateId: deps.generateId });
    if (!Array.isArray(message.parts)) {
      throw new InvalidRequestError({ message: 'An agent message needs a list of parts.' });
    }
    return {
      ...message,
      contextId: turn.contextId,
      ...(withTask ? { taskId: turn.taskId } : {}),
    };
  }

  /**
   * Applies one change to the task: creates it first (SUBMITTED) when this is
   * the interaction's first update, then saves and announces both. Only a
   * status update ends or interrupts the turn, as in the official SDK: a
   * follow-up turn's task shows the previous turn's `INPUT_REQUIRED` until
   * this turn changes its status.
   */
  function mutate(turn: Turn, change: (task: A2ATask) => A2AStreamResponse): Promise<void> {
    return withLock(turn.key, async () => {
      if (turn.ended) throw turnOver(turn);
      const events: A2AStreamResponse[] = [];
      let task: A2ATask;
      if (turn.task === undefined) {
        task = {
          id: turn.taskId,
          contextId: turn.contextId,
          status: { state: 'TASK_STATE_SUBMITTED', timestamp: now() },
          artifacts: [],
          history: [structuredClone(turn.message)],
        };
        events.push({ task: structuredClone(task) });
      } else {
        const stored = (await store.load(turn.taskId, turn.scope)) ?? turn.task;
        if (isTerminalState(stored.status.state)) {
          turn.task = stored;
          end(turn);
          turn.controller.abort(turnOver(turn));
          throw protocolError(
            'UNSUPPORTED_OPERATION',
            `Task ${turn.taskId} is ${stored.status.state}; the update was dropped.`,
          );
        }
        task = structuredClone(stored);
      }
      const update = change(task);
      events.push(update);
      await store.save(task, turn.scope);
      turn.task = task;
      turn.changed = true;
      for (const event of events) publish(turn, event);
      if (update.statusUpdate === undefined) return;
      const state = task.status.state;
      if (isTerminalState(state) || state === 'TASK_STATE_INPUT_REQUIRED') end(turn);
      else if (state === 'TASK_STATE_AUTH_REQUIRED') turn.outcome.resolve(result(turn));
    });
  }

  function statusChange(
    turn: Turn,
    state: A2ATaskState,
    message: A2AMessageInput | undefined,
    statusOptions: A2AStatusOptions | undefined,
  ): (task: A2ATask) => A2AStreamResponse {
    return (task) => {
      const statusMessage = message === undefined ? undefined : agentMessage(turn, message, true);
      task.status = {
        state,
        ...(statusMessage ? { message: statusMessage } : {}),
        timestamp: now(),
      };
      if (statusMessage) task.history = [...(task.history ?? []), structuredClone(statusMessage)];
      const metadata = statusOptions?.metadata;
      if (metadata) task.metadata = { ...(task.metadata ?? {}), ...structuredClone(metadata) };
      return {
        statusUpdate: {
          taskId: turn.taskId,
          contextId: turn.contextId,
          status: structuredClone(task.status),
          ...(metadata ? { metadata: structuredClone(metadata) } : {}),
        },
      };
    };
  }

  function setStatus(
    turn: Turn,
    state: A2ATaskState,
    message?: A2AMessageInput,
    statusOptions?: A2AStatusOptions,
  ): Promise<void> {
    if (!KNOWN_STATES.has(state)) {
      return Promise.reject(new InvalidRequestError({ message: `Not a task state: '${state}'.` }));
    }
    return mutate(turn, statusChange(turn, state, message, statusOptions));
  }

  function addArtifact(
    turn: Turn,
    input: A2AArtifactInput,
    artifactOptions: A2AArtifactOptions = {},
  ): Promise<string> {
    if (!Array.isArray(input?.parts) || input.parts.length === 0) {
      return Promise.reject(
        new InvalidRequestError({ message: 'An artifact needs at least one part.' }),
      );
    }
    const artifactId = input.artifactId ?? deps.generateId();
    const change = (task: A2ATask): A2AStreamResponse => {
      const artifact: A2AArtifact = structuredClone({ ...input, artifactId });
      const artifacts = task.artifacts ?? [];
      const index = artifacts.findIndex((existing) => existing.artifactId === artifactId);
      const existing = artifacts[index];
      if (!existing) artifacts.push(structuredClone(artifact));
      else if (artifactOptions.append) {
        existing.parts = [...existing.parts, ...structuredClone(artifact.parts)];
        if (artifact.name) existing.name = artifact.name;
        if (artifact.description) existing.description = artifact.description;
        if (artifact.metadata)
          existing.metadata = { ...(existing.metadata ?? {}), ...artifact.metadata };
      } else artifacts[index] = structuredClone(artifact);
      task.artifacts = artifacts;
      const metadata = artifactOptions.metadata;
      if (metadata) task.metadata = { ...(task.metadata ?? {}), ...structuredClone(metadata) };
      return {
        artifactUpdate: {
          taskId: turn.taskId,
          contextId: turn.contextId,
          artifact,
          ...(artifactOptions.append ? { append: true } : {}),
          ...(artifactOptions.lastChunk ? { lastChunk: true } : {}),
          ...(metadata ? { metadata: structuredClone(metadata) } : {}),
        },
      };
    };
    return mutate(turn, change).then(() => artifactId);
  }

  /**
   * An artifact update for the streams following the turn alone: never
   * stored, so it neither answers a request nor shows in the task.
   */
  function draft(
    turn: Turn,
    input: A2AArtifactInput,
    draftOptions: { append?: boolean } = {},
  ): Promise<string> {
    if (!Array.isArray(input?.parts) || input.parts.length === 0) {
      return Promise.reject(
        new InvalidRequestError({ message: 'A draft needs at least one part.' }),
      );
    }
    const artifactId = input.artifactId ?? deps.generateId();
    return withLock(turn.key, async () => {
      if (turn.ended) throw turnOver(turn);
      if (turn.task === undefined) {
        throw new InvalidRequestError({
          message: 'A draft needs the task: make a status or artifact update first.',
        });
      }
      announce(turn, {
        artifactUpdate: {
          taskId: turn.taskId,
          contextId: turn.contextId,
          artifact: structuredClone({ ...input, artifactId }),
          ...(draftOptions.append ? { append: true } : {}),
        },
      });
      return artifactId;
    });
  }

  function reply(turn: Turn, input: A2AMessageInput): Promise<void> {
    return withLock(turn.key, async () => {
      if (turn.ended) throw turnOver(turn);
      if (turn.task !== undefined) {
        throw protocolError(
          'UNSUPPORTED_OPERATION',
          `reply answers a new interaction before any task update; task ${turn.taskId} exists.`,
        );
      }
      const message = agentMessage(turn, input, false);
      turn.replied = message;
      publish(turn, { message: structuredClone(message) });
      end(turn);
    });
  }

  function contextOf(
    turn: Turn,
    request: A2ASendMessageRequest,
    info: TurnInfo,
  ): A2AExecutionContext {
    const status =
      (state: A2ATaskState) => (message?: A2AMessageInput, statusOptions?: A2AStatusOptions) =>
        setStatus(turn, state, message, statusOptions);
    return {
      message: structuredClone(turn.message),
      task: turn.started === undefined ? undefined : structuredClone(turn.started),
      taskId: turn.taskId,
      contextId: turn.contextId,
      tenant: turn.scope.tenant,
      owner: turn.scope.owner,
      request: structuredClone(request),
      extensions: info.extensions,
      signal: turn.controller.signal,
      httpRequest: info.httpRequest,
      reply: (message) => reply(turn, message),
      working: status('TASK_STATE_WORKING'),
      artifact: (artifact, artifactOptions) => addArtifact(turn, artifact, artifactOptions),
      draft: (artifact, draftOptions) => draft(turn, artifact, draftOptions),
      requireInput: status('TASK_STATE_INPUT_REQUIRED'),
      requireAuth: status('TASK_STATE_AUTH_REQUIRED'),
      complete: status('TASK_STATE_COMPLETED'),
      fail: status('TASK_STATE_FAILED'),
      reject: status('TASK_STATE_REJECTED'),
      setStatus: (state, message, statusOptions) => setStatus(turn, state, message, statusOptions),
    };
  }

  /** The executor resolved: complete a task it left in progress. */
  async function settle(turn: Turn): Promise<void> {
    if (turn.ended) return;
    if (turn.task === undefined) {
      fail(
        turn,
        protocolError(
          'INVALID_AGENT_RESPONSE',
          'The agent finished without answering: no reply and no task update.',
        ),
      );
      return;
    }
    const state = turn.task.status.state;
    if (state === 'TASK_STATE_SUBMITTED' || state === 'TASK_STATE_WORKING') {
      await mutate(turn, statusChange(turn, 'TASK_STATE_COMPLETED', undefined, undefined));
      return;
    }
    end(turn);
  }

  /**
   * A follow-up message the executor refused before any update was never
   * taken: it comes back out of the history `start` recorded it in.
   */
  function takeBack(turn: Turn): Promise<void> {
    return withLock(turn.key, async () => {
      if (turn.ended || turn.changed) return;
      const stored = await store.load(turn.taskId, turn.scope);
      const history = stored?.history ?? [];
      const index = history.map((message) => message.messageId).lastIndexOf(turn.message.messageId);
      if (!stored || index === -1) return;
      const kept = history.filter((_message, position) => position !== index);
      await store.save({ ...stored, history: kept }, turn.scope);
    });
  }

  /**
   * The executor threw: an A2AError of its own before any change answers the
   * request, anything else (another agent's error included) fails the task.
   */
  async function settleFailure(turn: Turn, error: unknown): Promise<void> {
    if (turn.ended) {
      if (!turn.controller.signal.aborted) report(error);
      return;
    }
    if (isOwnProtocolError(error) && !turn.changed) {
      if (turn.started !== undefined) await takeBack(turn);
      fail(turn, error);
      return;
    }
    await mutate(
      turn,
      statusChange(turn, 'TASK_STATE_FAILED', [{ text: describe(error) }], undefined),
    );
  }

  function launch(turn: Turn, request: A2ASendMessageRequest, info: TurnInfo): void {
    let execution: Promise<void>;
    try {
      execution = Promise.resolve(executor.execute(contextOf(turn, request, info)));
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution
      .then(
        () => settle(turn),
        (error: unknown) => settleFailure(turn, error),
      )
      .catch((error: unknown) => {
        // A turn a cancel ended meanwhile needs no completing or failing.
        if (turn.ended) return;
        report(error);
        fail(turn, protocolError('INTERNAL_ERROR', 'The agent could not finish the task.'));
      });
  }

  /**
   * Starts the turn a SendMessage asks for; `sink` (a streaming request) gets
   * every event of the turn. Refused messages throw an `A2AError`.
   */
  async function start(
    request: A2ASendMessageRequest,
    info: TurnInfo,
    sink?: TurnSink,
  ): Promise<Turn> {
    const incoming = request.message;
    const scope = info.scope;
    let turn: Turn;
    if (incoming.taskId) {
      const taskId = incoming.taskId;
      const key = keyOf(taskId, scope);
      turn = await withLock(key, async () => {
        const task = await store.load(taskId, scope);
        if (!task) throw protocolError('TASK_NOT_FOUND', `Task not found: ${taskId}`);
        const state = task.status.state;
        if (isTerminalState(state)) {
          throw protocolError(
            'UNSUPPORTED_OPERATION',
            `Task ${taskId} is ${state} and takes no more messages.`,
          );
        }
        if (incoming.contextId && incoming.contextId !== task.contextId) {
          throw protocolError(
            'INVALID_PARAMS',
            `contextId '${incoming.contextId}' is not the context of task ${taskId}.`,
          );
        }
        if (
          live.has(key) ||
          (state !== 'TASK_STATE_INPUT_REQUIRED' && state !== 'TASK_STATE_AUTH_REQUIRED')
        ) {
          throw protocolError(
            'UNSUPPORTED_OPERATION',
            `Task ${taskId} is still being worked on (${state}); send the next message when it asks for input, or subscribe to it.`,
          );
        }
        const message: A2AMessage = { ...incoming, taskId, contextId: task.contextId };
        // Taken back out (takeBack) if the executor refuses the message before any update.
        const next: A2ATask = { ...task, history: [...(task.history ?? []), message] };
        await store.save(next, scope);
        const continued = createTurn({
          key,
          taskId,
          contextId: task.contextId,
          scope,
          message,
          started: structuredClone(next),
          sink,
        });
        live.set(key, continued);
        // Streams open with the snapshot. A non-blocking request is answered at
        // the executor's first update instead, as a new interaction is, so a
        // refusal of the message reaches its client as an error.
        announce(continued, { task: structuredClone(next) });
        return continued;
      });
    } else {
      const taskId = deps.generateId();
      const contextId = incoming.contextId || deps.generateId();
      turn = createTurn({
        key: keyOf(taskId, scope),
        taskId,
        contextId,
        scope,
        message: { ...incoming, taskId, contextId },
        started: undefined,
        sink,
      });
      live.set(turn.key, turn);
    }
    launch(turn, request, info);
    return turn;
  }

  async function getTask(
    taskId: string,
    scope: A2ATaskScope,
    historyLength: number | undefined,
  ): Promise<A2ATask> {
    const task = await store.load(taskId, scope);
    if (!task) throw protocolError('TASK_NOT_FOUND', `Task not found: ${taskId}`);
    return withHistory(task, historyLength);
  }

  /**
   * `SubscribeToTask`: the task's snapshot, then the events of its running
   * turn until that turn ends (no running turn: the snapshot alone).
   */
  async function subscribe(taskId: string, scope: A2ATaskScope, sink: TurnSink): Promise<void> {
    const key = keyOf(taskId, scope);
    await withLock(key, async () => {
      const task = await store.load(taskId, scope);
      if (!task) throw protocolError('TASK_NOT_FOUND', `Task not found: ${taskId}`);
      if (isTerminalState(task.status.state)) {
        throw protocolError(
          'UNSUPPORTED_OPERATION',
          `Task ${taskId} is ${task.status.state}; there is nothing left to subscribe to.`,
        );
      }
      sink.event({ task: structuredClone(task) });
      const turn = live.get(key);
      if (turn) turn.sinks.add(sink);
      else sink.end();
    });
  }

  /**
   * `CancelTask`: asks `executor.cancel`, cancels the task, then ends and
   * aborts its running turn. A task that is already canceled is returned as is.
   */
  async function cancel(
    request: A2ACancelTaskRequest,
    scope: A2ATaskScope,
    httpRequest: Request,
  ): Promise<A2ATask> {
    const taskId = request.id;
    const key = keyOf(taskId, scope);
    return withLock(key, async () => {
      const task = await store.load(taskId, scope);
      if (!task) throw protocolError('TASK_NOT_FOUND', `Task not found: ${taskId}`);
      const state = task.status.state;
      if (state === 'TASK_STATE_CANCELED') return task;
      if (isTerminalState(state)) {
        throw protocolError(
          'TASK_NOT_CANCELABLE',
          `Task ${taskId} is ${state} and cannot be canceled.`,
        );
      }
      const turn = live.get(key);
      await executor.cancel?.({
        task: structuredClone(task),
        tenant: scope.tenant,
        owner: scope.owner,
        request: structuredClone(request),
        running: turn !== undefined,
        httpRequest,
      });
      const canceled: A2ATask = {
        ...task,
        status: { state: 'TASK_STATE_CANCELED', timestamp: now() },
      };
      await store.save(canceled, scope);
      if (turn) {
        turn.task = canceled;
        turn.changed = true;
        publish(turn, {
          statusUpdate: {
            taskId,
            contextId: canceled.contextId,
            status: structuredClone(canceled.status),
          },
        });
        end(turn);
        turn.controller.abort(new AbortError('The task was canceled.'));
      }
      return canceled;
    });
  }

  return { start, getTask, subscribe, cancel };
}
