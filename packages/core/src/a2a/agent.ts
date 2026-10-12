/**
 * a2a/agent.ts — `createA2AAgentExecutor`: a native agent run served as an
 * A2A agent (2.3).
 *
 * One native run per task: the task id is the run id, the task's tenant and
 * owner name the run's scope, and every turn of the task is a leg of the run
 * (`streamAgent` first, `resumeStreamAgent` after). A suspended run is an
 * `INPUT_REQUIRED` task whose status message lists the pending actions in a
 * data part, and the client's next message answers them. The engine is
 * passed in (`agent`), so this module takes nothing of it but types, and
 * `@deuz-sdk/core/a2a` stays small for an app that only calls agents.
 * Edge-safe.
 */
import { InvalidRequestError } from '../errors';
import { agentRunLeaseKey } from '../internal/agent-run-lease';
import { redactString } from '../internal/redact';
import type {
  AgentResult,
  AgentRunEnvelope,
  AgentRunLeaseOptions,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
  AgentStream,
} from '../types/agent-run';
import type { Message, Part } from '../types/message';
import type { StopDetails } from '../types/methods';
import type { ToolApprovalResponse } from '../types/tool';
import { A2AError } from './errors';
import { isRecord } from './protocol';
import type { A2AExecutionContext, A2AExecutor, A2AMessage, A2APart, A2ATaskScope } from './types';

/**
 * The native agent engine: `{ streamAgent, resumeStreamAgent }` from
 * `@deuz-sdk/core/agent`. It is passed in, so `@deuz-sdk/core/a2a` never
 * bundles the engine for an app that only calls agents.
 */
export interface A2AAgentEngine {
  streamAgent<T>(options: AgentRunOptions<T>): AgentStream<T>;
  resumeStreamAgent<T>(options: AgentRunOptions<T> & { session: AgentRunSession }): AgentStream<T>;
}

/** The run options the executor sets on every leg of a run itself. */
type OwnRunOption =
  | 'session'
  | 'lease'
  | 'signal'
  | 'abortSignal'
  | 'approvalResponses'
  | 'clientToolResults'
  | 'retryToolCallIds'
  | 'reconciledToolResults'
  | 'retryFailed';

const OWN_RUN_OPTIONS: readonly OwnRunOption[] = [
  'session',
  'lease',
  'signal',
  'abortSignal',
  'approvalResponses',
  'clientToolResults',
  'retryToolCallIds',
  'reconciledToolResults',
  'retryFailed',
];

/**
 * A task's native run: `AgentRunOptions` without what the executor sets on
 * every leg (`session`, `lease`, `signal`, `abortSignal`, the answers and the
 * reconciliation options). Without `prompt` or `messages`, a new task's run
 * gets the A2A message as its one user message.
 */
export type A2AAgentRunOptions<T = string> = Omit<AgentRunOptions<T>, OwnRunOption>;

/** What `run` is told about the turn: its execution context, without the update methods. */
export type A2AAgentRunContext = Pick<
  A2AExecutionContext,
  | 'message'
  | 'task'
  | 'taskId'
  | 'contextId'
  | 'tenant'
  | 'owner'
  | 'request'
  | 'extensions'
  | 'signal'
  | 'httpRequest'
>;

/** Options of `createA2AAgentExecutor`. `T` is the run's output type (`string` without `output`). */
export interface A2AAgentExecutorOptions<T = string> {
  /** The native engine: `{ streamAgent, resumeStreamAgent }` from `@deuz-sdk/core/agent`. */
  agent: A2AAgentEngine;
  /**
   * Where the runs live; a task's run id is its task id. Every instance that
   * serves the tasks needs the same store, and a durable one when tasks must
   * outlive the process.
   */
  store: AgentRunStore;
  /**
   * The run of a turn: its options, or a function that returns them for the
   * turn. It is called on every turn of a task, and the later turns must get
   * the definition the run started with: the run's resume binding checks the
   * model, tools and output, `bindingId` the rest. Throw an `A2AError` in it
   * to refuse a message.
   */
  run:
    | A2AAgentRunOptions<T>
    | ((context: A2AAgentRunContext) => A2AAgentRunOptions<T> | Promise<A2AAgentRunOptions<T>>);
  /**
   * Claim every run through a `LeaseProvider` (`AgentRunOptions.lease`), so
   * two instances never drive a run at once. A `CancelTask` for a task whose
   * turn runs on another instance then signals the run's lease, which stops
   * the run there; a lease cancel from outside A2A (an operator) cancels the
   * task.
   */
  lease?: AgentRunLeaseOptions;
  /**
   * The native scope of a task's run, from the task's tenant and owner.
   * Default: the JSON of `['a2a', tenant, owner]`.
   */
  scope?: (scope: A2ATaskScope) => string;
  /** The output artifact's `name` (default `'output'`) and `description`. */
  artifact?: { name?: string; description?: string };
  /**
   * The text of a failed task's status message, and of a refused resume.
   * Default: the run's error message, secret-redacted. Return only what the
   * client may read.
   */
  failureMessage?: (error: { name: string; message: string; code?: string }) => string;
}

/** One action a suspended run waits for, as the `pending-actions` data part lists it. */
export type A2AAgentAction =
  | {
      /** Answered in `approvalResponses`, by `approvalId`, with `approved`. */
      kind: 'approval';
      approvalId: string;
      toolCallId: string;
      toolName: string;
      /** The call's arguments, for display. */
      input: unknown;
      /** The signed approval token (`approvalSigner`): echo it on the verdict. */
      token?: string;
      /** The sub-agent the call belongs to. */
      agentPath?: string[];
    }
  | {
      /** Answered in `clientToolResults`, by `toolCallId`, with the tool's `output`. */
      kind: 'client-tool';
      toolCallId: string;
      toolName: string;
      /** The call's arguments: what the client runs the tool with. */
      input: unknown;
    };

/** The data part of an `INPUT_REQUIRED` status whose run waits for answers. */
export interface A2AAgentPendingActions {
  type: 'pending-actions';
  actions: A2AAgentAction[];
}

/** The data part of an `INPUT_REQUIRED` status whose run stopped: a person must look at it. */
export interface A2AAgentStopped {
  type: 'stopped';
  /** The run's stop reason: `'max-steps'`, `'budget.usd'`, `'refusal'`, `'tool-reconciliation-required'`, … */
  reason: string;
  /** The provider's explanation of the stop, its `explanation` secret-redacted. */
  stopDetails?: StopDetails;
  /** With `'tool-reconciliation-required'`: the calls whose effect is unknown. */
  unknownEffects?: { toolCallId: string; toolName: string; modelStep?: number }[];
}

/** The data part of a `FAILED` status. */
export interface A2AAgentFailed {
  type: 'failed';
  error: { name: string; code?: string };
}

/**
 * The answers to a suspended run's pending actions, as a client sends them:
 * the `data` of a data part, with the names `resumeAgent` takes. One message
 * answers every action, in one data part or several.
 */
export interface A2AAgentAnswers {
  approvalResponses?: ToolApprovalResponse[];
  clientToolResults?: { toolCallId: string; output: unknown; isError?: boolean }[];
}

/** The id of the artifact a task's output goes in, the same for its drafts. */
const ARTIFACT_ID = 'output';

const ANSWER_FIELDS: ReadonlySet<string> = new Set(['approvalResponses', 'clientToolResults']);

const HOW_TO_ANSWER =
  'Answer every action in one message, with a data part { approvalResponses, clientToolResults }.';

type Suspended = Extract<AgentResult<unknown>, { status: 'suspended' }>;
type Stopped = Extract<AgentResult<unknown>, { status: 'stopped' }>;
type RunError = Extract<AgentResult<unknown>, { status: 'failed' }>['error'];
type ClientToolResult = NonNullable<A2AAgentAnswers['clientToolResults']>[number];

function invalidParams(message: string): A2AError {
  return new A2AError({ reason: 'INVALID_PARAMS', message });
}

/** The executor's own run options that `run` sets, by name. */
function ownOptionsIn(run: Record<string, unknown>): OwnRunOption[] {
  return OWN_RUN_OPTIONS.filter((key) => run[key] !== undefined);
}

function ownOptionsMessage(own: readonly OwnRunOption[]): string {
  return `run must not set ${own.join(', ')}: the executor sets ${
    own.length === 1 ? 'it' : 'them'
  } on every leg of the run.`;
}

/** The run stopped for a reason a cancellation gives: through its signal or its lease. */
function isCancellation(reason: string): boolean {
  return reason === 'aborted' || reason === 'cancelled';
}

function defaultScope(scope: A2ATaskScope): string {
  return JSON.stringify(['a2a', scope.tenant ?? null, scope.owner ?? null]);
}

/** The A2A message as a run's one user message: its text, its data as JSON, its images. */
function userMessage(message: A2AMessage): Message {
  if (message.parts.length === 0) throw invalidParams('The message has no parts.');
  const content = message.parts.map((part): Part => {
    if (typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.data !== undefined) return { type: 'text', text: JSON.stringify(part.data) };
    const image = part.raw ?? part.url;
    if (typeof image === 'string' && part.mediaType?.toLowerCase().startsWith('image/')) {
      return { type: 'image', image, mediaType: part.mediaType };
    }
    throw new A2AError({
      reason: 'CONTENT_TYPE_NOT_SUPPORTED',
      message: `The agent reads text, data and images; a ${
        part.mediaType ? `'${part.mediaType}'` : 'file without a media type'
      } part is not supported.`,
    });
  });
  return { role: 'user', content };
}

function describeAction(action: A2AAgentAction): string {
  return action.kind === 'approval'
    ? `approval of ${action.toolName} (${action.toolCallId})`
    : `a result of ${action.toolName} (${action.toolCallId})`;
}

function waitsFor(actions: readonly A2AAgentAction[]): string {
  return actions.length === 1
    ? `waits for ${describeAction(actions[0] as A2AAgentAction)}`
    : `waits for ${actions.length} actions: ${actions.map(describeAction).join('; ')}`;
}

/** What a suspended run waits for: its approvals, then its client tool calls. */
function pendingActions(result: Suspended): A2AAgentAction[] {
  return [
    ...result.pendingApprovals.map(
      (request): A2AAgentAction => ({
        kind: 'approval',
        approvalId: request.approvalId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.input,
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.agentPath?.length ? { agentPath: [...request.agentPath] } : {}),
      }),
    ),
    ...result.pendingClientCalls.map(
      (call): A2AAgentAction => ({
        kind: 'client-tool',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.args,
      }),
    ),
  ];
}

function listOf(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidParams(`${field} must be a list.`);
  return value;
}

function readApproval(value: unknown, index: number): ToolApprovalResponse {
  if (
    !isRecord(value) ||
    typeof value.approvalId !== 'string' ||
    value.approvalId === '' ||
    typeof value.approved !== 'boolean' ||
    (value.reason !== undefined && typeof value.reason !== 'string') ||
    (value.token !== undefined && typeof value.token !== 'string')
  ) {
    throw invalidParams(
      `approvalResponses[${index}] needs an approvalId (a string) and approved (a boolean); reason and token are strings.`,
    );
  }
  return {
    approvalId: value.approvalId,
    approved: value.approved,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.token !== undefined ? { token: value.token } : {}),
  };
}

function readResult(value: unknown, index: number): ClientToolResult {
  if (
    !isRecord(value) ||
    typeof value.toolCallId !== 'string' ||
    value.toolCallId === '' ||
    !('output' in value) ||
    (value.isError !== undefined && typeof value.isError !== 'boolean')
  ) {
    throw invalidParams(
      `clientToolResults[${index}] needs a toolCallId (a string) and an output; isError is a boolean.`,
    );
  }
  return {
    toolCallId: value.toolCallId,
    output: value.output,
    ...(value.isError !== undefined ? { isError: value.isError } : {}),
  };
}

/** The answers in a follow-up message's data parts; its text parts are not read. */
function readAnswers(message: A2AMessage): {
  approvals: ToolApprovalResponse[];
  results: ClientToolResult[];
} {
  const approvals: ToolApprovalResponse[] = [];
  const results: ClientToolResult[] = [];
  for (const part of message.parts) {
    if (typeof part.text === 'string') continue;
    if (part.data === undefined)
      throw invalidParams('Answers travel in data parts; a file part is not read.');
    const data = part.data;
    if (!isRecord(data)) {
      throw invalidParams(
        'An answer is a data part with approvalResponses and/or clientToolResults.',
      );
    }
    for (const field of Object.keys(data)) {
      if (!ANSWER_FIELDS.has(field)) {
        throw invalidParams(
          `Unknown field '${field}' in an answer: use approvalResponses and clientToolResults.`,
        );
      }
    }
    approvals.push(...listOf(data.approvalResponses, 'approvalResponses').map(readApproval));
    results.push(...listOf(data.clientToolResults, 'clientToolResults').map(readResult));
  }
  return { approvals, results };
}

/**
 * Answers fit a suspended run when they answer each of its pending actions
 * once, each with the kind of answer it waits for, and nothing else: the
 * run's resume keeps no partial answer.
 */
function checkAnswers(
  taskId: string,
  answers: { approvals: ToolApprovalResponse[]; results: ClientToolResult[] },
  result: Suspended,
): void {
  const actions = pendingActions(result);
  if (answers.approvals.length === 0 && answers.results.length === 0) {
    throw invalidParams(`Task ${taskId} ${waitsFor(actions)}. ${HOW_TO_ANSWER}`);
  }
  const approvals = new Map(
    result.pendingApprovals.map((request) => [request.approvalId, request]),
  );
  const calls = new Map(result.pendingClientCalls.map((call) => [call.toolCallId, call]));
  const approved = new Set<string>();
  const returned = new Set<string>();
  for (const { approvalId } of answers.approvals) {
    if (approved.has(approvalId))
      throw invalidParams(`approvalResponses answers '${approvalId}' twice.`);
    if (!approvals.has(approvalId)) {
      const call = calls.get(approvalId);
      if (call) {
        throw invalidParams(
          `'${approvalId}' waits for a result of ${call.toolName}, not an approval: answer it in clientToolResults.`,
        );
      }
      const byCall = result.pendingApprovals.find((request) => request.toolCallId === approvalId);
      if (byCall) {
        throw invalidParams(
          `Name the approval of ${byCall.toolName} by its approvalId '${byCall.approvalId}', not by its tool call id.`,
        );
      }
      throw invalidParams(`'${approvalId}' is not an approval task ${taskId} waits for.`);
    }
    approved.add(approvalId);
  }
  for (const { toolCallId } of answers.results) {
    if (returned.has(toolCallId))
      throw invalidParams(`clientToolResults answers '${toolCallId}' twice.`);
    if (!calls.has(toolCallId)) {
      const approval = result.pendingApprovals.find(
        (request) => request.toolCallId === toolCallId || request.approvalId === toolCallId,
      );
      if (approval) {
        throw invalidParams(
          `'${toolCallId}' waits for an approval of ${approval.toolName}, not a result: answer it in approvalResponses.`,
        );
      }
      throw invalidParams(`'${toolCallId}' is not a client tool call task ${taskId} waits for.`);
    }
    returned.add(toolCallId);
  }
  const open = actions.filter((action) =>
    action.kind === 'approval'
      ? !approved.has(action.approvalId)
      : !returned.has(action.toolCallId),
  );
  if (open.length > 0) {
    throw invalidParams(
      `Answer every action in one message; still open: ${open.map(describeAction).join('; ')}.`,
    );
  }
}

function pendingMessage(actions: A2AAgentAction[]): A2APart[] {
  const data: A2AAgentPendingActions = { type: 'pending-actions', actions };
  return [
    { text: `The agent ${waitsFor(actions)}. ${HOW_TO_ANSWER}` },
    { data, mediaType: 'application/json' },
  ];
}

function stoppedMessage(result: Stopped): A2APart[] {
  const details = result.stopDetails;
  const data: A2AAgentStopped = {
    type: 'stopped',
    reason: result.reason,
    ...(details
      ? {
          stopDetails:
            typeof details.explanation === 'string'
              ? { ...details, explanation: redactString(details.explanation) }
              : details,
        }
      : {}),
    // Which calls to reconcile, never what they were given or returned.
    ...(result.unknownEffects
      ? {
          unknownEffects: result.unknownEffects.map((receipt) => ({
            toolCallId: receipt.toolCallId,
            toolName: receipt.toolName,
            ...(receipt.modelStep !== undefined ? { modelStep: receipt.modelStep } : {}),
          })),
        }
      : {}),
  };
  const unknown = data.unknownEffects ?? [];
  // Only a reconciliation stop leaves the run resumable; any other stop is final.
  const text =
    result.reason === 'tool-reconciliation-required'
      ? `The run stopped (${result.reason}): the outcome of ${
          unknown.length === 1
            ? `${unknown[0]?.toolName} (${unknown[0]?.toolCallId})`
            : unknown.length > 1
              ? `${unknown.length} tool calls`
              : 'a tool call'
        } is unknown. A person must settle ${unknown.length > 1 ? 'them' : 'it'} before the run can go on; send a message once that is done.`
      : `The run stopped (${result.reason}): a person must look at it. The run cannot go on; cancel the task or start a new one.`;
  return [{ text }, { data, mediaType: 'application/json' }];
}

/** The output as an artifact part: a string output as text, a typed one as data. */
function outputPart(output: unknown, typed: boolean): A2APart {
  if (!typed && typeof output === 'string') return { text: output };
  return { data: output === undefined ? null : output, mediaType: 'application/json' };
}

/**
 * Serve a native agent through `createA2AHandler`: each task is one run of
 * it, kept in `store` under the task's id.
 *
 * ```ts
 * import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '@deuz-sdk/core/agent';
 * import { createA2AAgentExecutor, createA2AHandler } from '@deuz-sdk/core/a2a';
 *
 * const handler = createA2AHandler({
 *   card,
 *   executor: createA2AAgentExecutor({
 *     agent: { streamAgent, resumeStreamAgent },
 *     store: createInMemoryAgentRunStore(),
 *     run: { model, tools, bindingId: 'publisher-v1' },
 *   }),
 * });
 * ```
 *
 * - A new message starts a run on it (`streamAgent`); a message to a task
 *   whose run waits resumes it (`resumeStreamAgent`). The task goes
 *   `WORKING` once the run's leg runs, and the text of a string output
 *   streams as unstored `draft` updates of the output artifact.
 * - `completed`: the output artifact (`'output'`), the run's validated
 *   output only, as a text part (a string output) or a data part (a typed
 *   one); then `COMPLETED`.
 * - `suspended`: `INPUT_REQUIRED`, with a data part `{ type:
 *   'pending-actions', actions }`. The next message answers every action in
 *   data parts `{ approvalResponses, clientToolResults }`; answers that do
 *   not fit are refused with `INVALID_PARAMS` before anything is written.
 * - `stopped`: `INPUT_REQUIRED` with a data part `{ type: 'stopped', reason
 *   }`: a person must look at the run. A run stopped for reconciliation goes
 *   on at the next message once a person settled its unknown effects; a
 *   message to any other stopped run is refused with
 *   `UNSUPPORTED_OPERATION`. A stop a cancellation caused (`'aborted'`,
 *   `'cancelled'`) cancels the task.
 * - `failed`: `FAILED`, with a safe message (see `failureMessage`). A resume
 *   refused before it began (another executor holds the run, its definition
 *   changed) refuses the message instead, and the task keeps waiting.
 * - `CancelTask` aborts the run of a turn running here; with `lease`, the
 *   cancel of a task whose turn runs elsewhere signals the run's lease.
 */
export function createA2AAgentExecutor<T = string>(
  options: A2AAgentExecutorOptions<T>,
): A2AExecutor {
  const agent = options?.agent;
  const store = options?.store;
  const run = options?.run;
  if (typeof agent?.streamAgent !== 'function' || typeof agent.resumeStreamAgent !== 'function') {
    throw new InvalidRequestError({
      message:
        'createA2AAgentExecutor needs the native engine: agent: { streamAgent, resumeStreamAgent } from @deuz-sdk/core/agent.',
    });
  }
  if (typeof store?.load !== 'function' || typeof store.save !== 'function') {
    throw new InvalidRequestError({
      message: 'createA2AAgentExecutor needs a run store: an AgentRunStore with load and save.',
    });
  }
  if (!isRecord(run) && typeof run !== 'function') {
    throw new InvalidRequestError({
      message:
        'createA2AAgentExecutor needs run: the run options, or a function that returns them.',
    });
  }
  if (isRecord(run)) {
    const own = ownOptionsIn(run);
    if (own.length > 0) throw new InvalidRequestError({ message: ownOptionsMessage(own) });
  }
  const lease = options.lease;
  if (lease !== undefined && typeof lease?.provider?.signal !== 'function') {
    throw new InvalidRequestError({
      message: 'createA2AAgentExecutor: lease needs lease.provider, a LeaseProvider.',
    });
  }
  const scopeOf = options.scope ?? defaultScope;
  const name = options.artifact?.name ?? 'output';
  const description = options.artifact?.description;
  const about = { name, ...(description !== undefined ? { description } : {}) };
  const errorText = (error: RunError, fallback: string) =>
    options.failureMessage?.(error) ?? `${fallback}: ${redactString(error.message)}`;

  async function runOptions(ctx: A2AExecutionContext): Promise<A2AAgentRunOptions<T>> {
    const value: unknown =
      typeof run === 'function'
        ? await run({
            message: ctx.message,
            task: ctx.task,
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            tenant: ctx.tenant,
            owner: ctx.owner,
            request: ctx.request,
            extensions: ctx.extensions,
            signal: ctx.signal,
            httpRequest: ctx.httpRequest,
          })
        : run;
    if (!isRecord(value))
      throw new TypeError('run must give the run options: an object with a model.');
    const own = ownOptionsIn(value);
    if (own.length > 0) throw new TypeError(ownOptionsMessage(own));
    return value as A2AAgentRunOptions<T>;
  }

  /** The run's failure is in the store: not a leg that was refused before it began. */
  async function failureRecorded(runId: string): Promise<boolean> {
    const stored = await Promise.resolve(store.load(runId)).catch(() => undefined);
    return stored?.phase === 'terminal' && stored.result?.status === 'failed';
  }

  /** Map the run's outcome onto the task. `changed`: this turn has updated the task. */
  async function settle(
    ctx: A2AExecutionContext,
    result: AgentResult<unknown>,
    typed: boolean,
    resuming: boolean,
    changed: boolean,
  ): Promise<void> {
    switch (result.status) {
      case 'completed':
        // A leg that only reported a stored outcome takes the message up first.
        if (!changed) await ctx.working();
        await ctx.artifact(
          { artifactId: ARTIFACT_ID, ...about, parts: [outputPart(result.output, typed)] },
          { lastChunk: true },
        );
        await ctx.complete();
        return;
      case 'suspended':
        await ctx.requireInput(pendingMessage(pendingActions(result)));
        return;
      case 'stopped':
        // Cancelled through the run's lease (another instance's CancelTask, an operator).
        if (isCancellation(result.reason)) {
          await ctx.setStatus('TASK_STATE_CANCELED', `The run was ${result.reason}.`);
          return;
        }
        await ctx.requireInput(stoppedMessage(result));
        return;
      case 'failed': {
        // A leg refused before it began (another executor holds the run, its
        // definition changed) wrote nothing: the message is refused, and the
        // task keeps waiting for the next one.
        if (resuming && !changed && !(await failureRecorded(ctx.taskId))) {
          throw new A2AError({
            reason: result.error.code === 'lease_held' ? 'UNSUPPORTED_OPERATION' : 'INTERNAL_ERROR',
            message: errorText(result.error, `The run of task ${ctx.taskId} could not be resumed`),
          });
        }
        const data: A2AAgentFailed = {
          type: 'failed',
          error: {
            name: result.error.name,
            ...(result.error.code !== undefined ? { code: result.error.code } : {}),
          },
        };
        await ctx.fail([
          { text: errorText(result.error, 'The agent run failed') },
          { data, mediaType: 'application/json' },
        ]);
        return;
      }
    }
  }

  /** Runs one leg of the task's run and maps it onto the task. */
  async function drive(
    ctx: A2AExecutionContext,
    open: (signal: AbortSignal) => AgentStream<unknown>,
    leg: A2AAgentRunOptions<T>,
    resuming: boolean,
  ): Promise<void> {
    // The leg stops when the task is canceled, and when this turn fails.
    const controller = new AbortController();
    const stop = () => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) stop();
    else ctx.signal.addEventListener('abort', stop, { once: true });
    const typed = leg.output !== undefined;
    const stream = open(controller.signal);
    let changed = false;
    try {
      // Each model step, and the finalization, previews its text afresh.
      let fresh = true;
      for await (const event of stream.events) {
        if (ctx.signal.aborted) continue;
        // WORKING once the leg runs: a leg refused before it began, or one
        // that only reports a stored outcome, changes the task only at its end.
        if (event.type === 'phase') {
          fresh = true;
          if (!changed) {
            changed = true;
            await ctx.working();
          }
          continue;
        }
        // Only a string output streams, as drafts of the output artifact: a
        // typed one is shown once validated, never in part.
        if (event.type !== 'part' || !changed || typed) continue;
        if (event.part.type === 'step-start') fresh = true;
        else if (event.part.type === 'text-delta' && event.part.text !== '') {
          await ctx.draft(
            {
              artifactId: ARTIFACT_ID,
              ...(fresh ? about : {}),
              parts: [{ text: event.part.text }],
            },
            { append: !fresh },
          );
          fresh = false;
        }
      }
    } catch (error) {
      // The task was canceled meanwhile: the leg is stopping, nothing is left to tell.
      if (!ctx.signal.aborted) {
        controller.abort(error);
        await stream.result;
        throw error;
      }
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
    const result = await stream.result;
    if (ctx.signal.aborted) return;
    try {
      await settle(ctx, result, typed, resuming, changed);
    } catch (error) {
      if (!ctx.signal.aborted) throw error;
    }
  }

  async function execute(ctx: A2AExecutionContext): Promise<void> {
    const session: AgentRunSession = {
      store,
      runId: ctx.taskId,
      scope: scopeOf({
        ...(ctx.tenant !== undefined ? { tenant: ctx.tenant } : {}),
        ...(ctx.owner !== undefined ? { owner: ctx.owner } : {}),
      }),
    };
    const claim = lease ? { lease } : {};
    if (ctx.task === undefined) {
      const leg = await runOptions(ctx);
      const input =
        leg.prompt === undefined && leg.messages === undefined
          ? { messages: [userMessage(ctx.message)] }
          : {};
      await drive(
        ctx,
        (signal) =>
          agent.streamAgent({ ...leg, ...input, session, signal, ...claim } as AgentRunOptions<T>),
        leg,
        false,
      );
      return;
    }
    // A follow-up: everything that can be checked is, before the task or the run changes.
    let saved: AgentRunEnvelope | undefined;
    try {
      saved = await store.load(session.runId);
    } catch (error) {
      throw new A2AError({
        reason: 'INTERNAL_ERROR',
        message: `The run of task ${ctx.taskId} could not be read.`,
        cause: error,
      });
    }
    // A run kept under another scope is another caller's: as good as none.
    if (!saved || saved.scope !== session.scope) {
      throw new A2AError({ reason: 'TASK_NOT_FOUND', message: `Task not found: ${ctx.taskId}` });
    }
    const answers = readAnswers(ctx.message);
    const result = saved.result;
    if (saved.phase !== 'terminal' && result?.status === 'suspended') {
      checkAnswers(ctx.taskId, answers, result);
    } else if (answers.approvals.length > 0 || answers.results.length > 0) {
      throw invalidParams(`Task ${ctx.taskId} is not waiting for answers.`);
    } else if (
      saved.phase === 'terminal' &&
      result?.status === 'stopped' &&
      !isCancellation(result.reason)
    ) {
      throw new A2AError({
        reason: 'UNSUPPORTED_OPERATION',
        message: `The run of task ${ctx.taskId} stopped (${result.reason}) and cannot go on: a person must look at it. Cancel the task or start a new one.`,
      });
    }
    const leg = await runOptions(ctx);
    const answered = {
      ...(answers.approvals.length > 0 ? { approvalResponses: answers.approvals } : {}),
      ...(answers.results.length > 0 ? { clientToolResults: answers.results } : {}),
    };
    await drive(
      ctx,
      (signal) =>
        agent.resumeStreamAgent({
          ...leg,
          ...answered,
          session,
          signal,
          ...claim,
        } as AgentRunOptions<T> & { session: AgentRunSession }),
      leg,
      true,
    );
  }

  const executor: A2AExecutor = { execute };
  if (lease) {
    // A turn running here stops through its signal, which the handler aborts
    // next; a run another instance drives is reached through its lease.
    executor.cancel = async (context) => {
      if (context.running) return;
      const scope = scopeOf({
        ...(context.tenant !== undefined ? { tenant: context.tenant } : {}),
        ...(context.owner !== undefined ? { owner: context.owner } : {}),
      });
      await lease.provider.signal(agentRunLeaseKey({ scope, runId: context.task.id }), 'cancel');
    };
  }
  return executor;
}
