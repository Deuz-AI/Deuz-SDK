/**
 * acp/client.ts — `connectAcpAgent`: the client side of the Agent Client
 * Protocol (2.5). Connect to any ACP agent (a Deuz agent served with
 * `serveAcpAgent`, or an external harness such as Claude Code, Codex CLI or
 * Gemini CLI started with `spawnAcpAgent` from `@deuz-sdk/core/acp/stdio`),
 * open a session, send prompts and read the agent's updates as they stream,
 * answering its permission requests and file reads/writes through callbacks.
 *
 * Every prompt is an {@link AcpPromptTurn}: an async iterable of the turn's
 * `session/update`s and a `result` that folds them (the reply text, the tool
 * calls with their final status, the plan, the permission decisions and the
 * cost the agent declared). Cost is DECLARED: it is what the agent reports in
 * its `usage_update` notifications, not something this side measured.
 * Edge-safe.
 */
import { AcpError, acpInvalidParams } from './errors';
import { createAcpPeer, type AcpPeer, type AcpRequestHandler } from './peer';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_DEUZ_META,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
} from './protocol';
import type { AcpTransport } from './transport';
import type {
  AcpClientCapabilities,
  AcpContentBlock,
  AcpDeuzBudget,
  AcpDeuzReceipt,
  AcpImplementation,
  AcpInitializeResponse,
  AcpMcpServer,
  AcpMeta,
  AcpPermissionOptionKind,
  AcpPlanEntry,
  AcpPromptResponse,
  AcpReadTextFileRequest,
  AcpRequestPermissionOutcome,
  AcpRequestPermissionRequest,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
  AcpWriteTextFileRequest,
} from './types';

/** Answers the agent's `session/request_permission`. */
export type AcpPermissionHandler = (
  request: AcpRequestPermissionRequest,
  context: { signal: AbortSignal },
) => AcpRequestPermissionOutcome | Promise<AcpRequestPermissionOutcome>;

/** Serves the agent's `fs/*` requests. Advertised only for the methods given. */
export interface AcpClientFileSystem {
  /** Return the file's text (from `line`, at most `limit` lines). Throw `AcpError` with `-32002` for a missing file. */
  readTextFile?(
    request: AcpReadTextFileRequest,
    context: { signal: AbortSignal },
  ): string | Promise<string>;
  writeTextFile?(
    request: AcpWriteTextFileRequest,
    context: { signal: AbortSignal },
  ): void | Promise<void>;
}

/** Options of {@link connectAcpAgent}. */
export interface AcpClientOptions {
  /** The connection to the agent: an in-memory pair, `createNdjsonTransport`, or `spawnAcpAgent`. */
  transport: AcpTransport;
  /** `clientInfo` sent in `initialize`. Default `{ name: 'deuz-acp-client', version: '0.0.0' }`. */
  clientInfo?: AcpImplementation;
  /**
   * Answers permission requests. Default: the first `reject_once` option (else
   * `reject_always`), so nothing runs that nobody approved. A turn's cancel
   * answers a pending request `cancelled` without waiting for the handler,
   * as the spec requires; the handler's `signal` aborts then.
   */
  onPermissionRequest?: AcpPermissionHandler;
  /** `fs/read_text_file` and `fs/write_text_file`; omitted ones are neither advertised nor served. */
  fs?: AcpClientFileSystem;
  /** Every `session/update`, of every session, in arrival order (also those outside a turn). */
  onSessionUpdate?: (notification: AcpSessionNotification) => void | Promise<void>;
  /** More client capabilities to advertise (`fs` follows the `fs` option and cannot be set here). */
  capabilities?: Omit<AcpClientCapabilities, 'fs'>;
  /** Extension requests (`_vendor/...`) the agent may call on this client. */
  extMethods?: Record<string, AcpRequestHandler>;
  /** Call `authenticate` with this method right after `initialize`. */
  authMethodId?: string;
  /** Aborts the connect (`initialize`, `authenticate`). */
  signal?: AbortSignal;
  /** Errors this side could not report to the agent: handler crashes, malformed input. */
  onError?: (error: unknown) => void;
}

/** What the agent declared about context use and cost in its latest `usage_update`. */
export interface AcpDeclaredUsage {
  used: number;
  size: number;
  /** Cumulative session cost, as the agent declared it. */
  cost?: { amount: number; currency: string };
  /** The Deuz budget, when the agent is a Deuz agent. */
  budget?: AcpDeuzBudget;
}

/** A tool call of a turn: its `tool_call` with every `tool_call_update` folded in. */
export interface AcpToolCallState {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: AcpToolKind;
  status: AcpToolCallStatus;
  content: AcpToolCallContent[];
  locations: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** One permission request of a turn and how it was answered. */
export interface AcpPermissionDecision {
  toolCallId: string;
  title?: string;
  outcome: 'selected' | 'cancelled';
  optionId?: string;
  kind?: AcpPermissionOptionKind;
}

/** What a prompt turn came to. */
export interface AcpPromptResult {
  stopReason: AcpStopReason;
  /** The agent's reply: every `agent_message_chunk` text, in order. */
  text: string;
  /** The agent's visible reasoning: every `agent_thought_chunk` text. */
  thought: string;
  toolCalls: AcpToolCallState[];
  /** The last plan the agent sent in the turn. */
  plan?: AcpPlanEntry[];
  permissions: AcpPermissionDecision[];
  /**
   * The turn's cost as the agent DECLARED it: the growth of the cumulative
   * `usage_update.cost` over the turn, in its currency. Absent when the agent
   * sent no cost.
   */
  cost?: { amount: number; currency: string; sessionTotal: number; declared: true };
  /** The latest `usage_update` of the turn. */
  usage?: AcpDeclaredUsage;
  /** `_meta[ACP_DEUZ_META.budget]` of the response, when the agent is a Deuz agent. */
  budget?: AcpDeuzBudget;
  /** `_meta[ACP_DEUZ_META.receipts]` of the response, when the agent is a Deuz agent. */
  receipts?: AcpDeuzReceipt[];
  /** The response's `_meta`. */
  meta?: AcpMeta;
}

/** One prompt turn: iterate it for the updates, await `result` for the outcome. */
export interface AcpPromptTurn extends AsyncIterable<AcpSessionUpdate> {
  /** Resolves when the agent answered the prompt and every update before the answer was handled. Rejects with `AcpError`. */
  readonly result: Promise<AcpPromptResult>;
  /** Cancel the turn (`session/cancel`); `result` still resolves, with `stopReason: 'cancelled'`. */
  cancel(): Promise<void>;
}

export interface AcpPromptOptions {
  /** Aborting cancels the turn, like {@link AcpPromptTurn.cancel}. */
  signal?: AbortSignal;
  /** Called with each update of the turn, in order, before it is yielded. */
  onUpdate?: (update: AcpSessionUpdate) => void | Promise<void>;
  _meta?: AcpMeta;
}

/** An open session on the agent. */
export interface AcpClientSession {
  readonly sessionId: string;
  /** The agent's latest `usage_update` in this session. */
  readonly usage: AcpDeclaredUsage | undefined;
  /** The updates `session/load` replayed (empty for a new session). */
  readonly history: readonly AcpSessionUpdate[];
  /** Send a prompt. One turn at a time: a second prompt while one runs rejects. */
  prompt(input: string | AcpContentBlock[], options?: AcpPromptOptions): AcpPromptTurn;
  /** Cancel the running turn, if any. */
  cancel(): Promise<void>;
}

/** A connected, initialized ACP agent. */
export interface AcpClientConnection {
  /** What the agent answered to `initialize`: version, capabilities, auth methods, info. */
  readonly agent: AcpInitializeResponse;
  /** The JSON-RPC endpoint, for extension requests. */
  readonly peer: AcpPeer;
  authenticate(methodId: string): Promise<void>;
  newSession(params: {
    cwd: string;
    mcpServers?: AcpMcpServer[];
    _meta?: AcpMeta;
  }): Promise<AcpClientSession>;
  /**
   * Requires `agent.agentCapabilities.loadSession`. Loading a session already
   * open on this connection reuses it: earlier handles keep working, and
   * `history` holds the latest replay. Rejects while a turn runs in it.
   */
  loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: AcpMcpServer[];
  }): Promise<AcpClientSession>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface SessionState {
  sessionId: string;
  usage?: AcpDeclaredUsage;
  history: AcpSessionUpdate[];
  /** Updates go here while a turn runs. */
  sink?: (update: AcpSessionUpdate) => Promise<void>;
  /** Pending permission requests: aborting answers them `cancelled`. */
  permissions: Set<AbortController>;
  turn?: { cancel(): Promise<void> };
  /** The running turn was cancelled: a permission request that arrives now is answered `cancelled`. */
  cancelling?: boolean;
  /** Records the running turn's permission decisions. */
  turnRecord?: (request: AcpRequestPermissionRequest, outcome: AcpRequestPermissionOutcome) => void;
  replaying: boolean;
}

/** A buffered async queue: what the agent sent, for whoever iterates. */
function createQueue<T>() {
  const items: T[] = [];
  const waiters: ((result: IteratorResult<T>) => void)[] = [];
  let done = false;
  let failure: unknown;
  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else items.push(item);
    },
    end(error?: unknown) {
      done = true;
      failure = error;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    iterator(): AsyncIterator<T> {
      return {
        next: () => {
          if (items.length > 0) return Promise.resolve({ value: items.shift() as T, done: false });
          if (done)
            return failure !== undefined
              ? Promise.reject(failure)
              : Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

function defaultPermission(request: AcpRequestPermissionRequest): AcpRequestPermissionOutcome {
  const options = Array.isArray(request.options) ? request.options : [];
  const reject =
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}

function readUsage(update: Record<string, unknown>): AcpDeclaredUsage | undefined {
  if (typeof update.used !== 'number' || typeof update.size !== 'number') return undefined;
  const cost =
    isRecord(update.cost) &&
    typeof update.cost.amount === 'number' &&
    typeof update.cost.currency === 'string'
      ? { amount: update.cost.amount, currency: update.cost.currency }
      : undefined;
  const meta = isRecord(update._meta) ? update._meta : undefined;
  const budget =
    meta && isRecord(meta[ACP_DEUZ_META.budget])
      ? (meta[ACP_DEUZ_META.budget] as AcpDeuzBudget)
      : undefined;
  return {
    used: update.used,
    size: update.size,
    ...(cost ? { cost } : {}),
    ...(budget ? { budget } : {}),
  };
}

/**
 * Connect to an ACP agent over `transport`: `initialize` (and `authenticate`
 * with `authMethodId`), then return the connection. Rejects with an
 * `AcpError` of kind `protocol`, and closes the connection, when the agent
 * answers with a protocol version other than {@link ACP_PROTOCOL_VERSION}.
 *
 * ```ts
 * const agent = await connectAcpAgent({
 *   transport,
 *   onPermissionRequest: async (request) => ({ outcome: 'selected', optionId: pick(request.options) }),
 * });
 * const session = await agent.newSession({ cwd: '/work/repo' });
 * const turn = session.prompt('Fix the failing test.');
 * for await (const update of turn) render(update);
 * const { stopReason, text, cost } = await turn.result;
 * ```
 */
export async function connectAcpAgent(options: AcpClientOptions): Promise<AcpClientConnection> {
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // never let a reporting hook break the connection
    }
  };
  const sessions = new Map<string, SessionState>();
  const fs = options.fs;

  const requests: Record<string, AcpRequestHandler> = {
    ...(options.extMethods ?? {}),
    [ACP_CLIENT_METHODS.requestPermission]: async (params, context) => {
      if (
        !isRecord(params) ||
        typeof params.sessionId !== 'string' ||
        !isRecord(params.toolCall) ||
        !Array.isArray(params.options)
      ) {
        throw acpInvalidParams('session/request_permission needs sessionId, toolCall and options.');
      }
      const request = params as unknown as AcpRequestPermissionRequest;
      const session = sessions.get(request.sessionId);
      const controller = new AbortController();
      const stop = () => controller.abort(context.signal.reason);
      context.signal.addEventListener('abort', stop, { once: true });
      session?.permissions.add(controller);
      // A request that crosses the turn's cancel is answered as a pending one would be.
      if (session?.cancelling)
        controller.abort(new AcpError({ kind: 'cancelled', message: 'The turn was cancelled.' }));
      try {
        const cancelled = new Promise<AcpRequestPermissionOutcome>((resolve) => {
          if (controller.signal.aborted) resolve({ outcome: 'cancelled' });
          controller.signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), {
            once: true,
          });
        });
        const handler = options.onPermissionRequest ?? defaultPermission;
        const outcome = controller.signal.aborted
          ? await cancelled
          : await Promise.race([
              cancelled,
              Promise.resolve(handler(request, { signal: controller.signal })),
            ]);
        if (
          !isRecord(outcome) ||
          (outcome.outcome !== 'selected' && outcome.outcome !== 'cancelled')
        ) {
          throw new TypeError(
            'onPermissionRequest must return { outcome: "selected", optionId } or { outcome: "cancelled" }.',
          );
        }
        session?.turnRecord?.(request, outcome);
        return { outcome };
      } finally {
        context.signal.removeEventListener('abort', stop);
        session?.permissions.delete(controller);
      }
    },
  };
  if (fs?.readTextFile) {
    const read = fs.readTextFile.bind(fs);
    requests[ACP_CLIENT_METHODS.readTextFile] = async (params, context) => {
      if (
        !isRecord(params) ||
        typeof params.sessionId !== 'string' ||
        typeof params.path !== 'string'
      ) {
        throw acpInvalidParams('fs/read_text_file needs sessionId and path.');
      }
      return {
        content: await read(params as unknown as AcpReadTextFileRequest, {
          signal: context.signal,
        }),
      };
    };
  }
  if (fs?.writeTextFile) {
    const write = fs.writeTextFile.bind(fs);
    requests[ACP_CLIENT_METHODS.writeTextFile] = async (params, context) => {
      if (
        !isRecord(params) ||
        typeof params.sessionId !== 'string' ||
        typeof params.path !== 'string' ||
        typeof params.content !== 'string'
      ) {
        throw acpInvalidParams('fs/write_text_file needs sessionId, path and content.');
      }
      await write(params as unknown as AcpWriteTextFileRequest, { signal: context.signal });
      return {};
    };
  }

  const peer = createAcpPeer({
    transport: options.transport,
    requests,
    notifications: {
      [ACP_CLIENT_METHODS.sessionUpdate]: async (params) => {
        if (!isRecord(params) || typeof params.sessionId !== 'string' || !isRecord(params.update))
          return;
        const notification = params as unknown as AcpSessionNotification;
        const session = sessions.get(notification.sessionId);
        const update = notification.update;
        if (session && update.sessionUpdate === 'usage_update') {
          session.usage = readUsage(update as unknown as Record<string, unknown>) ?? session.usage;
        }
        if (session?.replaying) session.history.push(update);
        await options.onSessionUpdate?.(notification);
        if (session?.sink) await session.sink(update);
      },
    },
    onError: report,
  });

  const clientCapabilities: AcpClientCapabilities = {
    ...(options.capabilities ?? {}),
    fs: {
      readTextFile: fs?.readTextFile !== undefined,
      writeTextFile: fs?.writeTextFile !== undefined,
    },
    terminal: options.capabilities?.terminal ?? false,
  };

  let agent: AcpInitializeResponse;
  try {
    const answer = await peer.request<AcpInitializeResponse>(
      ACP_AGENT_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities,
        clientInfo: options.clientInfo ?? { name: 'deuz-acp-client', version: '0.0.0' },
      },
      options.signal ? { signal: options.signal } : {},
    );
    if (!isRecord(answer) || answer.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpError({
        kind: 'protocol',
        message: `The agent speaks ACP protocol version ${JSON.stringify(isRecord(answer) ? answer.protocolVersion : undefined)}; this client supports ${ACP_PROTOCOL_VERSION}.`,
      });
    }
    agent = answer;
    if (options.authMethodId !== undefined) {
      await peer.request(
        ACP_AGENT_METHODS.authenticate,
        { methodId: options.authMethodId },
        options.signal ? { signal: options.signal } : {},
      );
    }
  } catch (error) {
    await peer.close();
    throw error;
  }

  function open(sessionId: string, replaying: boolean): SessionState {
    const state: SessionState = { sessionId, history: [], permissions: new Set(), replaying };
    sessions.set(sessionId, state);
    return state;
  }

  function sessionHandle(state: SessionState): AcpClientSession {
    const cancel = async () => {
      if (state.turn) state.cancelling = true;
      // The spec: answer every pending permission request `cancelled` as the cancel goes out.
      for (const controller of state.permissions)
        controller.abort(new AcpError({ kind: 'cancelled', message: 'The turn was cancelled.' }));
      await peer.notify(ACP_AGENT_METHODS.sessionCancel, { sessionId: state.sessionId });
    };
    return {
      sessionId: state.sessionId,
      get usage() {
        return state.usage;
      },
      history: state.history,
      cancel,
      prompt(input, promptOptions = {}) {
        return startTurn(state, input, promptOptions, cancel);
      },
    };
  }

  function startTurn(
    state: SessionState,
    input: string | AcpContentBlock[],
    promptOptions: AcpPromptOptions,
    cancel: () => Promise<void>,
  ): AcpPromptTurn {
    const queue = createQueue<AcpSessionUpdate>();
    const turnCancel = async () => {
      if (state.turn === handle) await cancel();
    };
    const handle = { cancel: turnCancel };
    const result = (async (): Promise<AcpPromptResult> => {
      if (state.turn) {
        const busy = new AcpError({
          kind: 'protocol',
          message: 'A prompt turn is already running in this session.',
        });
        queue.end(busy);
        throw busy;
      }
      state.turn = handle;
      state.cancelling = false;
      const prompt: AcpContentBlock[] =
        typeof input === 'string' ? [{ type: 'text', text: input }] : input;
      const startCost = state.usage?.cost;
      let text = '';
      let thought = '';
      let plan: AcpPlanEntry[] | undefined;
      let usage: AcpDeclaredUsage | undefined;
      const toolCalls = new Map<string, AcpToolCallState>();
      const permissions: AcpPermissionDecision[] = [];
      state.turnRecord = (request, outcome) => {
        const option =
          outcome.outcome === 'selected'
            ? request.options.find((entry) => entry.optionId === outcome.optionId)
            : undefined;
        permissions.push({
          toolCallId: request.toolCall.toolCallId,
          ...(typeof request.toolCall.title === 'string' ? { title: request.toolCall.title } : {}),
          outcome: outcome.outcome,
          ...(outcome.outcome === 'selected' ? { optionId: outcome.optionId } : {}),
          ...(option ? { kind: option.kind } : {}),
        });
      };
      state.sink = async (update) => {
        switch (update.sessionUpdate) {
          case 'agent_message_chunk':
            if (update.content.type === 'text') text += update.content.text;
            break;
          case 'agent_thought_chunk':
            if (update.content.type === 'text') thought += update.content.text;
            break;
          case 'tool_call':
            toolCalls.set(update.toolCallId, {
              toolCallId: update.toolCallId,
              title: update.title,
              ...(update.name ? { name: update.name } : {}),
              ...(update.kind ? { kind: update.kind } : {}),
              status: update.status ?? 'pending',
              content: update.content ?? [],
              locations: update.locations ?? [],
              ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
              ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
            });
            break;
          case 'tool_call_update': {
            const call = toolCalls.get(update.toolCallId) ?? {
              toolCallId: update.toolCallId,
              title: update.title ?? update.toolCallId,
              status: 'pending' as AcpToolCallStatus,
              content: [],
              locations: [],
            };
            if (update.title) call.title = update.title;
            if (update.name) call.name = update.name;
            if (update.kind) call.kind = update.kind;
            if (update.status) call.status = update.status;
            if (update.content) call.content = update.content;
            if (update.locations) call.locations = update.locations;
            if (update.rawInput !== undefined) call.rawInput = update.rawInput;
            if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
            toolCalls.set(update.toolCallId, call);
            break;
          }
          case 'plan':
            plan = update.entries;
            break;
          case 'usage_update':
            usage = state.usage;
            break;
          default:
            break;
        }
        try {
          await promptOptions.onUpdate?.(update);
        } catch (error) {
          report(error);
        }
        queue.push(update);
      };
      const onAbort = () => void turnCancel().catch(report);
      promptOptions.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const pending = peer.request<AcpPromptResponse>(ACP_AGENT_METHODS.sessionPrompt, {
          sessionId: state.sessionId,
          prompt,
          ...(promptOptions._meta ? { _meta: promptOptions._meta } : {}),
        });
        // Already aborted: cancel after the prompt is sent, so the agent has a turn to cancel.
        if (promptOptions.signal?.aborted) onAbort();
        const response = await pending;
        // Every update the agent sent before its answer is handled first.
        await peer.drain();
        if (!isRecord(response) || typeof response.stopReason !== 'string') {
          throw new AcpError({
            kind: 'protocol',
            message: 'session/prompt answered without a stopReason.',
          });
        }
        const meta = isRecord(response._meta) ? response._meta : undefined;
        const budget =
          meta && isRecord(meta[ACP_DEUZ_META.budget])
            ? (meta[ACP_DEUZ_META.budget] as AcpDeuzBudget)
            : undefined;
        const receipts =
          meta && Array.isArray(meta[ACP_DEUZ_META.receipts])
            ? (meta[ACP_DEUZ_META.receipts] as AcpDeuzReceipt[])
            : undefined;
        const endCost = state.usage?.cost;
        const cost =
          endCost && (!startCost || startCost.currency === endCost.currency)
            ? {
                amount: endCost.amount - (startCost?.amount ?? 0),
                currency: endCost.currency,
                sessionTotal: endCost.amount,
                declared: true as const,
              }
            : undefined;
        const outcome: AcpPromptResult = {
          stopReason: response.stopReason,
          text,
          thought,
          toolCalls: [...toolCalls.values()],
          ...(plan ? { plan } : {}),
          permissions,
          ...(cost ? { cost } : {}),
          ...(usage ? { usage } : {}),
          ...(budget ? { budget } : {}),
          ...(receipts ? { receipts } : {}),
          ...(meta ? { meta } : {}),
        };
        queue.end();
        return outcome;
      } catch (error) {
        queue.end(error);
        throw error;
      } finally {
        promptOptions.signal?.removeEventListener('abort', onAbort);
        if (state.turn === handle) {
          state.turn = undefined;
          state.sink = undefined;
          state.turnRecord = undefined;
          state.cancelling = false;
        }
      }
    })();
    // The turn's failure is reported through `result` (and iteration), never as an unhandled rejection.
    result.catch(() => undefined);
    return {
      result,
      cancel: turnCancel,
      [Symbol.asyncIterator]: () => queue.iterator(),
    };
  }

  return {
    agent,
    peer,
    async authenticate(methodId) {
      await peer.request(ACP_AGENT_METHODS.authenticate, { methodId });
    },
    async newSession(params) {
      const answer = await peer.request<{ sessionId?: unknown }>(ACP_AGENT_METHODS.sessionNew, {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        ...(params._meta ? { _meta: params._meta } : {}),
      });
      if (!isRecord(answer) || typeof answer.sessionId !== 'string') {
        throw new AcpError({
          kind: 'protocol',
          message: 'session/new answered without a sessionId.',
        });
      }
      return sessionHandle(open(answer.sessionId, false));
    },
    async loadSession(params) {
      if (agent.agentCapabilities?.loadSession !== true) {
        throw new AcpError({
          message: 'The agent does not support session/load.',
          rpcCode: ACP_ERROR_CODES.methodNotFound,
        });
      }
      // A session already open here keeps its state, so its earlier handle still gets its updates.
      const existing = sessions.get(params.sessionId);
      if (existing?.turn) {
        throw new AcpError({
          kind: 'protocol',
          message: 'A prompt turn is running in this session.',
        });
      }
      const state = existing ?? open(params.sessionId, true);
      state.history.length = 0;
      state.replaying = true;
      try {
        await peer.request(ACP_AGENT_METHODS.sessionLoad, {
          sessionId: params.sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
        });
        await peer.drain();
      } catch (error) {
        if (!existing) sessions.delete(params.sessionId);
        throw error;
      } finally {
        state.replaying = false;
      }
      return sessionHandle(state);
    },
    closed: peer.closed,
    close: () => peer.close(),
  };
}
