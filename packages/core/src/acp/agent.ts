/**
 * acp/agent.ts — `serveAcpAgent`: a native Deuz agent run served as an Agent
 * Client Protocol agent (2.5), so an editor that speaks ACP (Zed, JetBrains,
 * Neovim, …) drives it like any other agent.
 *
 * Each `session/prompt` is ONE native run (`streamAgent`), kept in the run
 * store under `<sessionId>:<turn>`, whose input is the session's conversation
 * so far plus the prompt. The served agent is an ordinary one: the run's
 * options are yours (`run`), and the run's stream parts become `session/update`
 * notifications as they happen. On top of the plain protocol it carries Deuz's
 * three guarantees into the editor:
 *
 * - **Signed permissions.** A tool whose `needsApproval` holds suspends the run
 *   (client-mode approval); each pending approval becomes a
 *   `session/request_permission` to the editor, and the verdict resumes the run
 *   (`resumeStreamAgent`) carrying the run's own HMAC-signed approval token
 *   (`approvalSigner`). The token never leaves this process and is verified
 *   here before the resume, which verifies it again: an editor can only pick
 *   one of the options offered for THIS request, and an answer cannot be
 *   replayed onto another call, run or session.
 * - **Persistent budget.** With `budget`, every turn runs under an execution
 *   context admitted against the `BudgetStore` scopes, so the session's cost is
 *   charged to the persistent budget and a spent budget stops the turn.
 * - **Cost and receipts in the editor.** After each turn a `usage_update` with
 *   the session's cumulative USD `cost`, and the `session/prompt` result,
 *   carry `_meta[ACP_DEUZ_META.budget]` (turn cost, session cost, remaining
 *   USD) and `_meta[ACP_DEUZ_META.receipts]` (the turn's effect receipts).
 *   `budgetFooter` also writes a one-line plain-text summary into the reply,
 *   for editors that show no custom field.
 *
 * The engine is passed in (`agent`), as for `createA2AAgentExecutor`, so this
 * module takes nothing of it but types; the execution context, the default
 * approval signer and the model registry are loaded lazily, only when used.
 * Edge-safe.
 */
import { InvalidRequestError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import type { ApprovalSigner } from '../durable';
import type {
  AgentMcpEntry,
  AgentResult,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
  AgentStream,
  AgentTool,
  AgentToolSet,
} from '../types/agent-run';
import type { BudgetStore, PersistentBudgetScope } from '../types/budget-store';
import type { Dependencies } from '../types/deps';
import type { BudgetLimits, BudgetWarning, NativeExecutionContext } from '../types/execution';
import type { Message, Part } from '../types/message';
import type { LanguageModel } from '../types/model';
import type { StreamPart } from '../types/stream';
import type { ToolApprovalRequest, ToolApprovalResponse } from '../types/tool';
import { AcpError, acpInvalidParams } from './errors';
import { createAcpPeer, type AcpPeer, type AcpRequestHandler } from './peer';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_DEUZ_BUDGET_METHOD,
  ACP_DEUZ_META,
  ACP_DEUZ_NAMESPACE,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
} from './protocol';
import type { AcpTransport } from './transport';
import type {
  AcpAuthMethod,
  AcpClientCapabilities,
  AcpDeuzBudget,
  AcpDeuzReceipt,
  AcpImplementation,
  AcpInitializeResponse,
  AcpMcpServer,
  AcpPermissionOption,
  AcpPlanEntry,
  AcpPromptResponse,
  AcpRequestPermissionResponse,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolKind,
} from './types';

// --- Sessions ---------------------------------------------------------------

/** One ACP session, as an {@link AcpSessionStore} keeps it. */
export interface AcpSessionRecord {
  sessionId: string;
  /** The absolute working directory the client opened the session in. */
  cwd: string;
  /**
   * The conversation so far: user, assistant and tool messages. System
   * messages are not kept: each turn's run rebuilds them from its options
   * (`instructions`, memory recall).
   */
  messages: Message[];
  /** Prompt turns run so far. */
  turns: number;
  /** USD the session's turns cost so far (see `AcpDeuzBudget.sessionUsd`). */
  costUsd: number;
  /** Tool names the user answered with "always allow" or "always reject". */
  permissions: Record<string, 'allow' | 'reject'>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Where sessions outlive a connection. With one, the agent advertises
 * `loadSession` and answers `session/load` by replaying the stored
 * conversation. A durable store also needs a durable run store (`store`).
 */
export interface AcpSessionStore {
  load(sessionId: string): AcpSessionRecord | undefined | Promise<AcpSessionRecord | undefined>;
  /** Must commit before resolving. */
  save(record: AcpSessionRecord): void | Promise<void>;
}

/** An in-memory {@link AcpSessionStore}: sessions survive a reconnect, not the process. */
export function createInMemoryAcpSessionStore(): AcpSessionStore {
  const records = new Map<string, AcpSessionRecord>();
  return {
    load: (sessionId) => {
      const record = records.get(sessionId);
      return record ? structuredClone(record) : undefined;
    },
    save: (record) => {
      records.set(record.sessionId, structuredClone(record));
    },
  };
}

// --- Options ----------------------------------------------------------------

/**
 * The native engine: `{ streamAgent, resumeStreamAgent }` from
 * `@deuz-sdk/core/agent` (the same shape `createA2AAgentExecutor` takes).
 */
export interface AcpAgentEngine {
  streamAgent<T>(options: AgentRunOptions<T>): AgentStream<T>;
  resumeStreamAgent<T>(options: AgentRunOptions<T> & { session: AgentRunSession }): AgentStream<T>;
}

/** The run options the server sets on every leg of a turn itself. */
type OwnRunOption =
  | 'session'
  | 'signal'
  | 'abortSignal'
  | 'messages'
  | 'prompt'
  | 'approvalResponses'
  | 'clientToolResults'
  | 'retryToolCallIds'
  | 'reconciledToolResults'
  | 'retryFailed';

const OWN_RUN_OPTIONS: readonly OwnRunOption[] = [
  'session',
  'signal',
  'abortSignal',
  'messages',
  'prompt',
  'approvalResponses',
  'clientToolResults',
  'retryToolCallIds',
  'reconciledToolResults',
  'retryFailed',
];

/**
 * A turn's native run: `AgentRunOptions` without what the server sets on every
 * leg (the input, the session, the signals and the answers).
 */
export type AcpAgentRunOptions = Omit<AgentRunOptions<string>, OwnRunOption>;

/** What `run` (and `budget.scopes`) are told about the turn. */
export interface AcpAgentTurnContext {
  sessionId: string;
  cwd: string;
  /** 1 for the session's first prompt. */
  turn: number;
  /** What the client advertised in `initialize`. */
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: AcpImplementation;
  /** The MCP servers the client asked the session to use (already merged into the run's `mcp` unless `mcpServers: 'ignore'`). */
  mcpServers: AcpMcpServer[];
  /** Aborted when the client cancels the turn. */
  signal: AbortSignal;
}

/** Persistent budget admission for every turn: the 2.2 `BudgetStore` scopes. */
export interface AcpAgentBudgetOptions {
  store: BudgetStore;
  /** The scopes a turn is admitted against, e.g. `[{ key: 'user:42', limits: { usd: 5 } }]`. */
  scopes:
    | readonly PersistentBudgetScope[]
    | ((context: {
        sessionId: string;
        cwd: string;
      }) => readonly PersistentBudgetScope[] | Promise<readonly PersistentBudgetScope[]>);
  /** A cap for one turn on top of the scopes (the execution context's own budget). */
  turn?: BudgetLimits;
  /** Warn when committed usage reaches this percentage of a scope limit. */
  warnAtPercent?: number;
  onWarning?: (warning: BudgetWarning) => void;
}

/** Options of {@link serveAcpAgent}. */
export interface AcpAgentOptions {
  /** The connection to the client: an in-memory pair, `createNdjsonTransport`, or `serveAcpAgentStdio`. */
  transport: AcpTransport;
  /** The native engine: `{ streamAgent, resumeStreamAgent }` from `@deuz-sdk/core/agent`. */
  agent: AcpAgentEngine;
  /** Where each turn's run lives (`createInMemoryAgentRunStore()`, or a durable store). */
  store: AgentRunStore;
  /**
   * The run of a turn: its options, or a function that returns them for the
   * turn. Throw an `AcpError` in it to refuse the prompt with that error.
   */
  run:
    | AcpAgentRunOptions
    | ((context: AcpAgentTurnContext) => AcpAgentRunOptions | Promise<AcpAgentRunOptions>);
  /** `agentInfo` sent in `initialize`. Default `{ name: 'deuz-agent', version: '0.0.0' }`. */
  info?: AcpImplementation;
  /** Keep sessions across connections and advertise `session/load`. Default: per connection, in memory. */
  sessions?: AcpSessionStore;
  /** Charge every turn to a persistent budget. */
  budget?: AcpAgentBudgetOptions;
  /**
   * Append a short plain-text line with the turn's cost, the session's cost
   * and the remaining USD to the agent's reply, for editors that show no
   * custom field. `true` uses the default wording; a function returns the
   * text. Default `false`.
   */
  budgetFooter?: boolean | ((budget: AcpDeuzBudget) => string);
  /**
   * Signs every approval a turn's run asks for. Default: the run's own
   * `approvalSigner`, else a signer with a random per-server secret (verdicts
   * then bind to this process). Pass one built by `createApprovalSigner` to
   * share the secret with other processes resuming the same runs.
   */
  approvalSigner?: ApprovalSigner;
  /** Tool kind per tool name, or a function, for the editor's icon. Default `'other'`. */
  toolKinds?: Record<string, AcpToolKind> | ((toolName: string, input: unknown) => AcpToolKind);
  /** Title of a tool call in the editor. Default: the tool name. */
  toolTitle?: (toolName: string, input: unknown) => string;
  /**
   * The MCP servers a client lists in `session/new` / `session/load`:
   * `'accept'` (the default) adds them to the run's `mcp` (stdio servers need
   * a Node runtime and the MCP SDK peer); `'ignore'` drops them and advertises
   * no HTTP/SSE MCP support.
   */
  mcpServers?: 'accept' | 'ignore';
  /**
   * Give the run `read_text_file` and `write_text_file` tools backed by the
   * client's `fs/*` methods (what the editor sees, unsaved buffers included),
   * when the client advertised them. `write_text_file` needs approval.
   * Default `false`.
   */
  clientFsTools?: boolean;
  /** Authentication methods; with them, sessions need a successful `authenticate` first. */
  auth?: {
    methods: AcpAuthMethod[];
    authenticate(methodId: string, context: { signal: AbortSignal }): void | Promise<void>;
  };
  /** The model's context window in tokens, for `usage_update.size`. Default: the model registry. */
  contextWindow?: number | ((model: LanguageModel) => number | undefined);
  /**
   * The text of a failed turn's error, from the run's error. Default: a fixed
   * text naming the error by its `code` or `name`; its message (which can
   * name a provider account or a host) stays on this side.
   */
  failureMessage?: (error: { name: string; message: string; code?: string }) => string;
  /** `generateId` (session ids) and `clock` (record times). */
  deps?: Pick<Dependencies, 'generateId' | 'clock'>;
  /** Errors the server could not report to the client: crashes, store failures, malformed input. */
  onError?: (error: unknown) => void;
}

/** A served ACP agent connection. */
export interface AcpAgentConnection {
  /** The JSON-RPC endpoint, for extension methods. */
  readonly peer: AcpPeer;
  /** Resolves when the client disconnects or `close` is called. */
  readonly closed: Promise<void>;
  /** Cancel every running turn and close the connection. */
  close(): Promise<void>;
}

// --- Helpers ----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_TOOL_TEXT = 8_000;
const MAX_LEGS = 64;

function ownOptionsIn(run: Record<string, unknown>): OwnRunOption[] {
  return OWN_RUN_OPTIONS.filter((key) => run[key] !== undefined);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function clip(text: string): string {
  return text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n… (${text.length - MAX_TOOL_TEXT} more characters)`
    : text;
}

/** USD for display: cents above a dollar, four decimals below. */
export function formatUsd(amount: number): string {
  return `$${Math.abs(amount) >= 1 ? amount.toFixed(2) : amount.toFixed(4)}`;
}

function defaultFooter(budget: AcpDeuzBudget): string {
  const parts = [`turn ${formatUsd(budget.turnUsd)}`, `session ${formatUsd(budget.sessionUsd)}`];
  if (budget.remainingUsd !== undefined) parts.push(`remaining ${formatUsd(budget.remainingUsd)}`);
  return `\n\n— budget: ${parts.join(' · ')}${budget.unpriced ? ' (some calls unpriced)' : ''}`;
}

/** An ACP prompt as the run's user message. */
function promptToMessage(prompt: unknown): Message {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw acpInvalidParams('prompt must be a non-empty list of content blocks.');
  }
  const content = prompt.map((block: unknown, index): Part => {
    if (!isRecord(block) || typeof block.type !== 'string') {
      throw acpInvalidParams(`prompt[${index}] is not a content block.`);
    }
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string')
          throw acpInvalidParams(`prompt[${index}].text must be a string.`);
        return { type: 'text', text: block.text };
      case 'image':
        if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') {
          throw acpInvalidParams(`prompt[${index}] needs base64 data and a mimeType.`);
        }
        return { type: 'image', image: block.data, mediaType: block.mimeType };
      case 'resource_link': {
        if (typeof block.uri !== 'string')
          throw acpInvalidParams(`prompt[${index}].uri must be a string.`);
        const name =
          typeof block.title === 'string'
            ? block.title
            : typeof block.name === 'string'
              ? block.name
              : block.uri;
        return { type: 'text', text: `[Resource: ${name}](${block.uri})` };
      }
      case 'resource': {
        const resource = block.resource;
        if (!isRecord(resource) || typeof resource.uri !== 'string') {
          throw acpInvalidParams(`prompt[${index}].resource needs a uri.`);
        }
        if (typeof resource.text === 'string') {
          return {
            type: 'text',
            text: `<resource uri="${resource.uri}">\n${resource.text}\n</resource>`,
          };
        }
        const mime = typeof resource.mimeType === 'string' ? resource.mimeType : '';
        if (typeof resource.blob === 'string' && mime.toLowerCase().startsWith('image/')) {
          return { type: 'image', image: resource.blob, mediaType: mime };
        }
        throw acpInvalidParams(`prompt[${index}]: only text and image resources are supported.`);
      }
      default:
        throw acpInvalidParams(
          `prompt[${index}]: '${block.type}' content is not supported by this agent.`,
        );
    }
  });
  return { role: 'user', content };
}

/** The conversation kept for the next turn: no system messages, no unanswered tool call. */
function historyOf(messages: readonly Message[]): Message[] {
  const kept = messages.filter((message) => message.role !== 'system');
  const last = kept[kept.length - 1];
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const open = last.content.filter((part) => part.type === 'tool_use');
    if (open.length > 0) {
      kept.push({
        role: 'tool',
        content: open.map(
          (part): Part => ({
            type: 'tool_result',
            toolUseId: part.type === 'tool_use' ? part.id : '',
            result: 'The tool call was cancelled.',
            isError: true,
          }),
        ),
      });
    }
  }
  return kept;
}

function planEntries(tasks: { title: string; status: string }[]): AcpPlanEntry[] {
  return tasks.map((task) => ({
    content: task.title,
    priority: 'medium',
    status:
      task.status === 'done' || task.status === 'failed'
        ? 'completed'
        : task.status === 'in_progress'
          ? 'in_progress'
          : 'pending',
    ...(task.status === 'failed' ? { _meta: { [`${ACP_DEUZ_NAMESPACE}/status`]: 'failed' } } : {}),
  }));
}

function locationsOf(input: unknown): AcpToolCallLocation[] | undefined {
  if (!isRecord(input) || typeof input.path !== 'string' || input.path === '') return undefined;
  const line =
    typeof input.line === 'number' && Number.isInteger(input.line) && input.line > 0
      ? input.line
      : undefined;
  return [{ path: input.path, ...(line !== undefined ? { line } : {}) }];
}

function textContent(text: string): AcpToolCallContent[] {
  return text === '' ? [] : [{ type: 'content', content: { type: 'text', text: clip(text) } }];
}

/** Map a run's `stopped` reason onto ACP. `undefined`: end the turn and tell the user why. */
function stopReasonOf(reason: string): AcpStopReason | undefined {
  if (reason === 'aborted' || reason === 'cancelled') return 'cancelled';
  if (reason === 'max-steps') return 'max_turn_requests';
  if (reason === 'refusal') return 'refusal';
  if (reason === 'length') return 'max_tokens';
  return undefined;
}

// --- The server -------------------------------------------------------------

/** How a turn's permission request for one call was answered. */
interface Asked {
  toolName: string;
  approval: NonNullable<AcpDeuzReceipt['approval']>;
}

interface LiveSession {
  record: AcpSessionRecord;
  mcpServers: AcpMcpServer[];
  /** The running turn's controller. */
  active?: AbortController;
  /** ACP tool call ids already used in this session. */
  toolIds: Set<string>;
  lastBudget?: AcpDeuzBudget;
}

/**
 * Serve a native Deuz agent over ACP on `transport`: answers `initialize`,
 * `authenticate`, `session/new`, `session/load` (with `sessions`),
 * `session/prompt` and `session/cancel`, and Deuz's `_io.github.deuz-ai/budget`
 * extension request. See the module header for what a turn does.
 *
 * ```ts
 * import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '@deuz-sdk/core/agent';
 * import { createApprovalSigner } from '@deuz-sdk/core/durable';
 * import { serveAcpAgentStdio } from '@deuz-sdk/core/acp/stdio';
 *
 * serveAcpAgentStdio({
 *   agent: { streamAgent, resumeStreamAgent },
 *   store: createInMemoryAgentRunStore(),
 *   run: { model, instructions: 'You are a careful coding agent.', tools, maxSteps: 20 },
 *   approvalSigner: createApprovalSigner({ secret: process.env.APPROVAL_SECRET! }),
 *   budget: { store: budgetStore, scopes: [{ key: 'user:me', limits: { usd: 5 } }] },
 *   budgetFooter: true,
 * });
 * ```
 *
 * Stop reasons: a completed run ends `end_turn` (`max_tokens` when the last
 * step was cut off); a run stopped by `session/cancel` `cancelled`, by
 * `maxSteps` `max_turn_requests`, by a refusal `refusal`. Any other stop
 * (a budget, a guardrail, an unknown tool effect) ends `end_turn` with a line
 * in the reply that names the reason. A failed run answers the prompt with a
 * `-32603` error whose message is safe to show (see `failureMessage`), except
 * a spent persistent budget, which ends `end_turn` with a reply that says so.
 */
export function serveAcpAgent(options: AcpAgentOptions): AcpAgentConnection {
  const engine = options?.agent;
  if (typeof engine?.streamAgent !== 'function' || typeof engine.resumeStreamAgent !== 'function') {
    throw new InvalidRequestError({
      message:
        'serveAcpAgent needs the native engine: agent: { streamAgent, resumeStreamAgent } from @deuz-sdk/core/agent.',
    });
  }
  const store = options.store;
  if (typeof store?.load !== 'function' || typeof store.save !== 'function') {
    throw new InvalidRequestError({
      message: 'serveAcpAgent needs a run store: an AgentRunStore with load and save.',
    });
  }
  const run = options.run;
  if (!isRecord(run) && typeof run !== 'function') {
    throw new InvalidRequestError({
      message: 'serveAcpAgent needs run: the run options, or a function that returns them.',
    });
  }
  if (isRecord(run)) {
    const own = ownOptionsIn(run);
    if (own.length > 0) {
      throw new InvalidRequestError({
        message: `run must not set ${own.join(', ')}: the server sets them on every turn.`,
      });
    }
    if (options.budget && run.execution !== undefined) {
      throw new InvalidRequestError({
        message:
          "run must not set execution together with budget: the server builds each turn's execution context.",
      });
    }
  }
  const budget = options.budget;
  if (
    budget !== undefined &&
    (typeof budget.store?.reserve !== 'function' || budget.scopes === undefined)
  ) {
    throw new InvalidRequestError({
      message: 'serveAcpAgent: budget needs a BudgetStore (store) and scopes.',
    });
  }
  const deps = resolveDependencies(options.deps);
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // never let a reporting hook break the connection
    }
  };
  const sessionStore = options.sessions;
  const acceptMcp = (options.mcpServers ?? 'accept') === 'accept';
  const info: AcpImplementation = options.info ?? { name: 'deuz-agent', version: '0.0.0' };
  const failureText = (error: { name: string; message: string; code?: string }) =>
    options.failureMessage?.(error) ?? `The agent run failed (${error.code ?? error.name}).`;

  let initialized = false;
  let authenticated = options.auth === undefined;
  let clientCapabilities: AcpClientCapabilities = {};
  let clientInfo: AcpImplementation | undefined;
  const live = new Map<string, LiveSession>();

  let defaultSigner: Promise<ApprovalSigner> | undefined;
  const signerFor = (leg: AcpAgentRunOptions): Promise<ApprovalSigner> => {
    const own = leg.approvalSigner ?? options.approvalSigner;
    if (own) return Promise.resolve(own);
    defaultSigner ??= import('../durable').then((durable) =>
      durable.createApprovalSigner({
        secret: `${deps.generateId()}${deps.generateId()}`,
        clock: deps.clock,
      }),
    );
    return defaultSigner;
  };

  const contextWindowOf = async (model: LanguageModel): Promise<number | undefined> => {
    const option = options.contextWindow;
    if (typeof option === 'number') return option;
    const chosen = typeof option === 'function' ? option(model) : undefined;
    if (chosen !== undefined) return chosen;
    try {
      const registry = await import('../core/registry');
      return registry.getModelCapabilities(model).contextWindow;
    } catch {
      return undefined;
    }
  };

  // eslint-disable-next-line prefer-const -- assigned once the handler table exists
  let peer: AcpPeer;
  const update = (sessionId: string, value: AcpSessionUpdate) =>
    peer.notify(ACP_CLIENT_METHODS.sessionUpdate, { sessionId, update: value });

  async function saveRecord(record: AcpSessionRecord): Promise<void> {
    record.updatedAt = deps.clock.now();
    if (sessionStore) await sessionStore.save(record);
  }

  function readCwd(params: Record<string, unknown>): string {
    if (typeof params.cwd !== 'string' || params.cwd === '')
      throw acpInvalidParams('cwd must be an absolute path.');
    return params.cwd;
  }

  function readMcpServers(params: Record<string, unknown>): AcpMcpServer[] {
    const list = params.mcpServers ?? [];
    if (!Array.isArray(list)) throw acpInvalidParams('mcpServers must be a list.');
    return list.map((entry: unknown, index) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') {
        throw acpInvalidParams(`mcpServers[${index}] needs a name.`);
      }
      const remote = entry.type === 'http' || entry.type === 'sse';
      if (remote ? typeof entry.url !== 'string' : typeof entry.command !== 'string') {
        throw acpInvalidParams(`mcpServers[${index}] needs ${remote ? 'a url' : 'a command'}.`);
      }
      return entry as unknown as AcpMcpServer;
    });
  }

  function mcpEntries(servers: readonly AcpMcpServer[]): AgentMcpEntry[] {
    if (!acceptMcp) return [];
    const pairs = (list: unknown) =>
      Object.fromEntries(
        (Array.isArray(list) ? list : [])
          .filter(isRecord)
          .map((pair) => [String(pair.name), String(pair.value)]),
      );
    return servers.map((server): AgentMcpEntry => {
      if (server.type === 'http' || server.type === 'sse') {
        return {
          url: server.url,
          type: server.type,
          headers: pairs(server.headers),
          namespace: server.name,
        };
      }
      const stdio = server as Extract<AcpMcpServer, { command: string }>;
      return {
        command: stdio.command,
        args: Array.isArray(stdio.args) ? stdio.args.map(String) : [],
        env: pairs(stdio.env),
        namespace: stdio.name,
      };
    });
  }

  function liveSession(params: unknown): { session: LiveSession; params: Record<string, unknown> } {
    if (!isRecord(params) || typeof params.sessionId !== 'string')
      throw acpInvalidParams('sessionId must be a string.');
    const session = live.get(params.sessionId);
    if (!session) {
      throw new AcpError({
        message: `Session not found: ${params.sessionId}`,
        rpcCode: ACP_ERROR_CODES.resourceNotFound,
        data: { sessionId: params.sessionId },
      });
    }
    return { session, params };
  }

  async function remainingOf(
    scopes: readonly PersistentBudgetScope[],
  ): Promise<Pick<AcpDeuzBudget, 'remainingUsd' | 'scopes'>> {
    if (!budget) return {};
    const rows: NonNullable<AcpDeuzBudget['scopes']> = [];
    for (const scope of scopes) {
      const limit = scope.limits.usd;
      if (limit === undefined) continue;
      try {
        const used = (await budget.store.usage(scope.key)).usd;
        rows.push({
          key: scope.key,
          limitUsd: limit,
          usedUsd: used,
          remainingUsd: Math.max(0, limit - used),
        });
      } catch (error) {
        report(error);
      }
    }
    if (rows.length === 0) return {};
    return { remainingUsd: Math.min(...rows.map((row) => row.remainingUsd)), scopes: rows };
  }

  async function scopesFor(record: AcpSessionRecord): Promise<readonly PersistentBudgetScope[]> {
    if (!budget) return [];
    const scopes =
      typeof budget.scopes === 'function'
        ? await budget.scopes({ sessionId: record.sessionId, cwd: record.cwd })
        : budget.scopes;
    if (!Array.isArray(scopes))
      throw new TypeError('budget.scopes must give a list of persistent budget scopes.');
    return scopes;
  }

  // --- History replay (session/load) ---

  async function replay(session: LiveSession): Promise<void> {
    const { sessionId, messages } = session.record;
    const results = new Map<string, { result: unknown; isError: boolean }>();
    for (const message of messages) {
      if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === 'tool_result')
          results.set(part.toolUseId, { result: part.result, isError: part.isError === true });
      }
    }
    for (const [index, message] of messages.entries()) {
      const messageId = `${sessionId}:replay:${index}`;
      if (message.role === 'user') {
        const parts =
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content } as Part]
            : message.content;
        for (const part of parts) {
          if (part.type === 'text')
            await update(sessionId, {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: part.text },
              messageId,
            });
          else if (
            part.type === 'image' &&
            typeof part.image === 'string' &&
            part.mediaType &&
            !/^(data:|https?:)/.test(part.image)
          ) {
            await update(sessionId, {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'image', data: part.image, mimeType: part.mediaType },
              messageId,
            });
          }
        }
      } else if (message.role === 'assistant') {
        const parts =
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content } as Part]
            : message.content;
        for (const part of parts) {
          if (part.type === 'text' && part.text !== '') {
            await update(sessionId, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: part.text },
              messageId,
            });
          } else if (
            part.type === 'reasoning' &&
            !part.encrypted &&
            !part.redacted &&
            part.text !== ''
          ) {
            await update(sessionId, {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: part.text },
              messageId,
            });
          } else if (part.type === 'tool_use') {
            const outcome = results.get(part.id);
            const toolCallId = acpToolId(session, part.id, session.record.turns);
            await update(sessionId, {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: titleOf(part.name, part.input),
              name: part.name,
              kind: kindOf(part.name, part.input),
              status: outcome ? (outcome.isError ? 'failed' : 'completed') : 'failed',
              rawInput: part.input,
              ...(outcome
                ? { content: textContent(textOf(outcome.result)), rawOutput: outcome.result }
                : {}),
              ...(locationsOf(part.input) ? { locations: locationsOf(part.input) } : {}),
            });
          }
        }
      }
    }
  }

  function kindOf(toolName: string, input: unknown): AcpToolKind {
    if (toolName === 'read_text_file' && options.clientFsTools) return 'read';
    if (toolName === 'write_text_file' && options.clientFsTools) return 'edit';
    const kinds = options.toolKinds;
    if (typeof kinds === 'function') return kinds(toolName, input);
    return kinds?.[toolName] ?? 'other';
  }

  function titleOf(toolName: string, input: unknown): string {
    return options.toolTitle?.(toolName, input) ?? toolName;
  }

  /** A session-unique ACP id for a run's tool call (providers reuse ids such as `tool_0`). */
  function acpToolId(session: LiveSession, toolCallId: string, turn: number): string {
    let id = toolCallId;
    let n = 1;
    while (session.toolIds.has(id)) {
      id = `${toolCallId}#${turn}.${n}`;
      n += 1;
    }
    session.toolIds.add(id);
    return id;
  }

  // --- Client fs tools ---

  function fsTools(sessionId: string): AgentToolSet {
    if (!options.clientFsTools) return {};
    const fs = clientCapabilities.fs ?? {};
    const tools: AgentToolSet = {};
    if (fs.readTextFile) {
      const read: AgentTool<{ path: string; line?: number; limit?: number }, string> = {
        description:
          'Read a text file as the editor has it (unsaved changes included). path must be absolute.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the file.' },
            line: { type: 'integer', minimum: 1, description: '1-based line to start reading at.' },
            limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to read.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          const result = await peer.request<{ content?: unknown }>(
            ACP_CLIENT_METHODS.readTextFile,
            {
              sessionId,
              path: args.path,
              ...(args.line ? { line: args.line } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            },
            context.signal ? { signal: context.signal } : {},
          );
          if (!isRecord(result) || typeof result.content !== 'string') {
            throw new AcpError({
              kind: 'protocol',
              message: 'fs/read_text_file answered without content.',
            });
          }
          return result.content;
        },
      };
      tools.read_text_file = read;
    }
    if (fs.writeTextFile) {
      const write: AgentTool<{ path: string; content: string }, string> = {
        description:
          'Write a text file through the editor (it may show the change). path must be absolute; the whole file is replaced.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the file.' },
            content: { type: 'string', description: 'The complete new content of the file.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        needsApproval: true,
        execute: async (args, context) => {
          await peer.request(
            ACP_CLIENT_METHODS.writeTextFile,
            { sessionId, path: args.path, content: args.content },
            context.signal ? { signal: context.signal } : {},
          );
          return `Wrote ${args.path}.`;
        },
      };
      tools.write_text_file = write;
    }
    return tools;
  }

  // --- A prompt turn ---

  async function runOptionsFor(context: AcpAgentTurnContext): Promise<AcpAgentRunOptions> {
    const value: unknown = typeof run === 'function' ? await run(context) : run;
    if (!isRecord(value))
      throw new TypeError('run must give the run options: an object with a model.');
    const own = ownOptionsIn(value);
    if (own.length > 0)
      throw new TypeError(
        `run must not set ${own.join(', ')}: the server sets them on every turn.`,
      );
    if (budget && value.execution !== undefined) {
      throw new TypeError('run must not set execution together with budget.');
    }
    return value as AcpAgentRunOptions;
  }

  async function prompt(params: unknown, rpcSignal: AbortSignal): Promise<AcpPromptResponse> {
    const { session, params: request } = liveSession(params);
    if (session.active) {
      throw new AcpError({
        message: 'A prompt turn is already running in this session.',
        rpcCode: ACP_ERROR_CODES.invalidRequest,
      });
    }
    const userMessage = promptToMessage(request.prompt);
    const controller = new AbortController();
    session.active = controller;
    const stopOnRpcCancel = () => controller.abort(rpcSignal.reason);
    rpcSignal.addEventListener('abort', stopOnRpcCancel, { once: true });
    try {
      return await turn(session, userMessage, controller);
    } finally {
      rpcSignal.removeEventListener('abort', stopOnRpcCancel);
      if (session.active === controller) session.active = undefined;
    }
  }

  async function turn(
    session: LiveSession,
    userMessage: Message,
    controller: AbortController,
  ): Promise<AcpPromptResponse> {
    const record = session.record;
    const sessionId = record.sessionId;
    const turnNumber = record.turns + 1;
    const runId = `${sessionId}:${turnNumber}`;
    const signal = controller.signal;
    const leg = await runOptionsFor({
      sessionId,
      cwd: record.cwd,
      turn: turnNumber,
      clientCapabilities,
      ...(clientInfo ? { clientInfo } : {}),
      mcpServers: session.mcpServers,
      signal,
    });
    const signer = await signerFor(leg);
    const scopes = await scopesFor(record);
    let execution: NativeExecutionContext | undefined = leg.execution;
    if (budget) {
      const policy = await import('../execution-policy');
      execution = policy.createExecutionContext({
        scopeId: runId,
        ...(budget.turn ? { budget: budget.turn } : {}),
        admission: {
          store: budget.store,
          scopes,
          ...(budget.warnAtPercent !== undefined ? { warnAtPercent: budget.warnAtPercent } : {}),
          ...(budget.onWarning ? { onWarning: budget.onWarning } : {}),
        },
      });
    }
    const tools: AgentToolSet = { ...fsTools(sessionId), ...(leg.tools ?? {}) };
    const mcp = [...(leg.mcp ?? []), ...mcpEntries(session.mcpServers)];
    const runSession: AgentRunSession = { store, runId, scope: JSON.stringify(['acp', sessionId]) };
    const base: AgentRunOptions<string> = {
      ...leg,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      ...(mcp.length > 0 ? { mcp } : {}),
      approvalSigner: signer,
      ...(execution ? { execution } : {}),
      session: runSession,
      signal,
    } as AgentRunOptions<string>;

    // Turn state, across the legs of the run.
    const toolIds = new Map<string, string>();
    const settled = new Set<string>();
    const approvals = new Map<string, Asked>();
    let messageId = `${runId}:0`;
    let lastText: string | undefined;
    let lastCost: number | undefined;
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    let exhausted: string | undefined;
    let writeFailed = false;

    const send = async (value: AcpSessionUpdate) => {
      if (writeFailed) return;
      try {
        await update(sessionId, value);
      } catch {
        // The client is gone: stop the run, nothing is left to tell.
        writeFailed = true;
        controller.abort(new AcpError({ kind: 'closed', message: 'The ACP client disconnected.' }));
      }
    };

    const onPart = async (part: StreamPart) => {
      switch (part.type) {
        case 'step-start':
          messageId = `${runId}:${part.stepIndex}`;
          return;
        case 'text-delta':
          if (part.text === '') return;
          lastText = messageId;
          await send({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: part.text },
            messageId,
          });
          return;
        case 'reasoning-delta':
          if (part.encrypted || part.redacted || part.text === '') return;
          await send({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: part.text },
            messageId,
          });
          return;
        case 'tool-call': {
          const id = acpToolId(session, part.toolCallId, turnNumber);
          toolIds.set(part.toolCallId, id);
          settled.delete(id);
          const locations = locationsOf(part.input);
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: titleOf(part.toolName, part.input),
            name: part.toolName,
            kind: kindOf(part.toolName, part.input),
            status: 'pending',
            rawInput: part.input,
            ...(locations ? { locations } : {}),
          });
          return;
        }
        case 'tool-state': {
          const id = toolIds.get(part.toolCallId);
          if (!id || settled.has(id)) return;
          if (part.state === 'executing') {
            await send({
              sessionUpdate: 'tool_call_update',
              toolCallId: id,
              status: 'in_progress',
            });
          } else if (part.state === 'error') {
            settled.add(id);
            const why = part.denied
              ? `Denied${part.deniedReason ? `: ${part.deniedReason}` : '.'}`
              : `The tool call failed (${part.outcome ?? 'error'}).`;
            await send({
              sessionUpdate: 'tool_call_update',
              toolCallId: id,
              status: 'failed',
              content: textContent(why),
            });
          }
          return;
        }
        case 'tool-result': {
          const id = toolIds.get(part.toolCallId);
          if (!id || settled.has(id)) return;
          settled.add(id);
          await send({
            sessionUpdate: 'tool_call_update',
            toolCallId: id,
            status: part.isError ? 'failed' : 'completed',
            content: textContent(textOf(part.output)),
            rawOutput: part.output,
          });
          return;
        }
        case 'plan-update':
          await send({ sessionUpdate: 'plan', entries: planEntries(part.tasks) });
          return;
        case 'cost':
          lastCost = part.costUsd;
          return;
        case 'step-finish':
          lastUsage = {
            inputTokens: part.usage.inputTokens,
            outputTokens: part.usage.outputTokens,
          };
          return;
        case 'budget-exceeded':
          exhausted = `budget.${part.kind}`;
          return;
        default:
          return;
      }
    };

    async function drive(stream: AgentStream<string>): Promise<AgentResult<string>> {
      try {
        for await (const event of stream.events) {
          if (event.type === 'part') await onPart(event.part);
        }
      } catch (error) {
        controller.abort(error);
      }
      return stream.result;
    }

    /** Ask the client about one pending approval; `undefined` when the turn was cancelled. */
    async function ask(request: ToolApprovalRequest): Promise<ToolApprovalResponse | undefined> {
      // Own keys only: a tool named `constructor` or `toString` was never answered "always".
      const remembered = Object.prototype.hasOwnProperty.call(record.permissions, request.toolName)
        ? record.permissions[request.toolName]
        : undefined;
      const id =
        toolIds.get(request.toolCallId) ?? acpToolId(session, request.toolCallId, turnNumber);
      toolIds.set(request.toolCallId, id);
      if (remembered) {
        approvals.set(request.toolCallId, {
          toolName: request.toolName,
          approval: remembered === 'allow' ? 'remembered-allow' : 'remembered-reject',
        });
        return verdict(request, remembered === 'allow', 'The user always rejects this tool.');
      }
      const nonce = deps.generateId();
      const offered: AcpPermissionOption[] = [
        { optionId: `allow_once:${nonce}`, name: 'Allow', kind: 'allow_once' },
        {
          optionId: `allow_always:${nonce}`,
          name: `Always allow ${request.toolName}`,
          kind: 'allow_always',
        },
        { optionId: `reject_once:${nonce}`, name: 'Reject', kind: 'reject_once' },
        {
          optionId: `reject_always:${nonce}`,
          name: `Always reject ${request.toolName}`,
          kind: 'reject_always',
        },
      ];
      const locations = locationsOf(request.input);
      let answer: AcpRequestPermissionResponse;
      try {
        answer = await peer.request<AcpRequestPermissionResponse>(
          ACP_CLIENT_METHODS.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId: id,
              title: titleOf(request.toolName, request.input),
              kind: kindOf(request.toolName, request.input),
              status: 'pending',
              rawInput: request.input,
              ...(locations ? { locations } : {}),
            },
            options: offered,
            _meta: { [ACP_DEUZ_META.signedApprovals]: true },
          },
          { signal },
        );
      } catch (error) {
        if (signal.aborted) {
          // Cancelled while the request was pending: the call never ran.
          approvals.set(request.toolCallId, { toolName: request.toolName, approval: 'cancelled' });
          return undefined;
        }
        // A client that cannot answer has not approved anything.
        report(error);
        approvals.set(request.toolCallId, { toolName: request.toolName, approval: 'rejected' });
        return verdict(request, false, 'The permission request failed.');
      }
      const outcome = isRecord(answer) && isRecord(answer.outcome) ? answer.outcome : undefined;
      if (outcome?.outcome === 'cancelled') {
        approvals.set(request.toolCallId, { toolName: request.toolName, approval: 'cancelled' });
        controller.abort(
          new AcpError({ kind: 'cancelled', message: 'The permission request was cancelled.' }),
        );
        return undefined;
      }
      const chosen =
        outcome?.outcome === 'selected'
          ? offered.find((option) => option.optionId === outcome.optionId)
          : undefined;
      if (!chosen) {
        report(
          new AcpError({
            kind: 'protocol',
            message: `session/request_permission answered with an option that was not offered (${JSON.stringify(outcome)}); the call is rejected.`,
          }),
        );
        approvals.set(request.toolCallId, { toolName: request.toolName, approval: 'rejected' });
        return verdict(request, false, 'The permission answer was not one of the offered options.');
      }
      const allowed = chosen.kind === 'allow_once' || chosen.kind === 'allow_always';
      if (chosen.kind === 'allow_always') record.permissions[request.toolName] = 'allow';
      if (chosen.kind === 'reject_always') record.permissions[request.toolName] = 'reject';
      approvals.set(request.toolCallId, {
        toolName: request.toolName,
        approval: allowed ? 'allowed' : 'rejected',
      });
      return verdict(request, allowed, 'The user rejected the tool call.');
    }

    /**
     * The verdict the run resumes with. An approval carries the run's own
     * signed token, verified here first: it must be this signer's, for this
     * approval and this run. A token that does not verify turns the approval
     * into a denial (the run would deny it too).
     */
    async function verdict(
      request: ToolApprovalRequest,
      approved: boolean,
      reason: string,
    ): Promise<ToolApprovalResponse> {
      if (!approved) return { approvalId: request.approvalId, approved: false, reason };
      const token = request.token;
      const payload = token === undefined ? null : await signer.verify(token);
      if (
        !payload ||
        payload.approvalId !== request.approvalId ||
        payload.runId !== runId ||
        token === undefined
      ) {
        report(
          new AcpError({
            kind: 'protocol',
            message: `The approval of ${request.toolName} (${request.toolCallId}) carries no token this server signed; it is denied.`,
          }),
        );
        approvals.set(request.toolCallId, { toolName: request.toolName, approval: 'rejected' });
        return {
          approvalId: request.approvalId,
          approved: false,
          reason: 'The approval could not be verified.',
        };
      }
      return { approvalId: request.approvalId, approved: true, token };
    }

    let result = await drive(
      engine.streamAgent({ ...base, messages: [...record.messages, userMessage] }),
    );
    for (let legs = 1; result.status === 'suspended' && !signal.aborted; legs += 1) {
      if (legs >= MAX_LEGS)
        throw new AcpError({ message: 'The run suspended too many times in one turn.' });
      const responses: ToolApprovalResponse[] = [];
      for (const request of result.pendingApprovals) {
        const answer = signal.aborted ? undefined : await ask(request);
        if (answer) {
          responses.push(answer);
        } else if (!approvals.has(request.toolCallId)) {
          // The turn was cancelled before this call was asked about: it never runs.
          approvals.set(request.toolCallId, { toolName: request.toolName, approval: 'cancelled' });
        }
      }
      if (signal.aborted) break;
      // ACP has no client-side tools: a call the run expects a client to answer fails.
      const clientToolResults = result.pendingClientCalls.map((call) => ({
        toolCallId: call.toolCallId,
        output: `${call.toolName} is a client-side tool, which an ACP client cannot run.`,
        isError: true,
      }));
      await saveRecord(record).catch(report);
      result = await drive(
        engine.resumeStreamAgent({
          ...base,
          session: runSession,
          ...(responses.length > 0 ? { approvalResponses: responses } : {}),
          ...(clientToolResults.length > 0 ? { clientToolResults } : {}),
        }),
      );
    }

    // Every tool call still open in the editor ends now.
    for (const id of toolIds.values()) {
      if (settled.has(id)) continue;
      settled.add(id);
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'failed',
        content: textContent(signal.aborted ? 'Cancelled.' : 'Not run.'),
      });
    }

    // The conversation the next turn continues from.
    const cancelled = signal.aborted;
    if (result.status !== 'failed')
      record.messages = historyOf(
        result.messages.length > 0 ? result.messages : [...record.messages, userMessage],
      );
    record.turns = turnNumber;

    // Cost and budget.
    const accounting = result.accounting;
    const turnUsd = accounting ? accounting.spent.usd : (lastCost ?? 0);
    record.costUsd += turnUsd;
    await saveRecord(record).catch(report);
    if (result.status === 'stopped' && result.reason.startsWith('budget.'))
      exhausted = result.reason;
    if (result.status === 'failed' && result.error.code === 'budget_exceeded')
      exhausted = 'budget_exceeded';
    const budgetInfo: AcpDeuzBudget = {
      turnUsd,
      sessionUsd: record.costUsd,
      ...(await remainingOf(scopes)),
      ...(accounting?.unpriced ? { unpriced: accounting.unpriced } : {}),
      ...(exhausted ? { exhausted } : {}),
    };
    session.lastBudget = budgetInfo;
    const receipts = await receiptsOf(runId, approvals);

    if (!cancelled) {
      const size = await contextWindowOf(leg.model);
      if (size !== undefined) {
        await send({
          sessionUpdate: 'usage_update',
          used: lastUsage ? lastUsage.inputTokens + lastUsage.outputTokens : 0,
          size,
          cost: { amount: record.costUsd, currency: 'USD' },
          _meta: { [ACP_DEUZ_META.budget]: budgetInfo },
        });
      }
    }

    let stopReason: AcpStopReason = 'end_turn';
    let notice: string | undefined;
    if (cancelled) {
      stopReason = 'cancelled';
    } else if (result.status === 'stopped') {
      const mapped = stopReasonOf(result.reason);
      if (mapped) stopReason = mapped;
      else notice = `The turn stopped (${result.reason}).`;
    } else if (result.status === 'failed') {
      if (result.error.code === 'budget_exceeded')
        notice = 'The budget is exhausted: the turn was not run.';
      else {
        throw new AcpError({
          message: failureText(result.error),
          data: {
            name: result.error.name,
            ...(result.error.code !== undefined ? { code: result.error.code } : {}),
          },
        });
      }
    }
    if (!cancelled) {
      const footer = options.budgetFooter;
      const footerText =
        footer === true
          ? defaultFooter(budgetInfo)
          : typeof footer === 'function'
            ? footer(budgetInfo)
            : '';
      const text = `${notice ? `${lastText ? '\n\n' : ''}${notice}` : ''}${footerText}`;
      if (text !== '') {
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
          messageId: lastText ?? messageId,
        });
      }
    }
    return {
      stopReason,
      _meta: { [ACP_DEUZ_META.budget]: budgetInfo, [ACP_DEUZ_META.receipts]: receipts },
    };
  }

  async function receiptsOf(
    runId: string,
    approvals: ReadonlyMap<string, Asked>,
  ): Promise<AcpDeuzReceipt[]> {
    try {
      const envelope = await store.load(runId);
      const recorded = Object.values(envelope?.toolResults ?? {});
      const receipts = recorded.map((receipt): AcpDeuzReceipt => {
        const approval = approvals.get(receipt.toolCallId)?.approval;
        return {
          toolCallId: receipt.toolCallId,
          toolName: receipt.toolName,
          stage: receipt.stage,
          ...(approval ? { approval } : {}),
          ...(receipt.error !== undefined ? { error: receipt.error } : {}),
        };
      });
      // A call the user rejected never ran, so the run recorded no receipt for it.
      const seen = new Set(recorded.map((receipt) => receipt.toolCallId));
      for (const [toolCallId, asked] of approvals) {
        if (!seen.has(toolCallId))
          receipts.push({
            toolCallId,
            toolName: asked.toolName,
            stage: 'not-run',
            approval: asked.approval,
          });
      }
      return receipts;
    } catch (error) {
      report(error);
      return [];
    }
  }

  // --- Handlers ---

  const requests: Record<string, AcpRequestHandler> = {
    [ACP_AGENT_METHODS.initialize]: (params): AcpInitializeResponse => {
      if (!isRecord(params) || !Number.isInteger(params.protocolVersion)) {
        throw acpInvalidParams('initialize needs a protocolVersion (an integer).');
      }
      clientCapabilities = isRecord(params.clientCapabilities)
        ? (params.clientCapabilities as AcpClientCapabilities)
        : {};
      clientInfo = isRecord(params.clientInfo)
        ? (params.clientInfo as unknown as AcpImplementation)
        : undefined;
      initialized = true;
      return {
        // Version negotiation: the client's version when supported, else ours.
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: sessionStore !== undefined,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: acceptMcp, sse: acceptMcp },
          sessionCapabilities: {},
          _meta: {
            [ACP_DEUZ_META.budget]: true,
            [ACP_DEUZ_META.receipts]: true,
            [ACP_DEUZ_META.signedApprovals]: true,
          },
        },
        authMethods: options.auth?.methods ?? [],
        agentInfo: info,
      };
    },
    [ACP_AGENT_METHODS.authenticate]: async (params, context) => {
      const auth = options.auth;
      if (!auth)
        throw new AcpError({
          message: 'This agent needs no authentication.',
          rpcCode: ACP_ERROR_CODES.methodNotFound,
        });
      if (
        !isRecord(params) ||
        typeof params.methodId !== 'string' ||
        !auth.methods.some((method) => method.id === params.methodId)
      ) {
        throw acpInvalidParams('methodId must name one of the advertised authMethods.');
      }
      await auth.authenticate(params.methodId, { signal: context.signal });
      authenticated = true;
      return {};
    },
    [ACP_AGENT_METHODS.sessionNew]: async (params) => {
      if (!isRecord(params))
        throw acpInvalidParams('session/new needs params { cwd, mcpServers }.');
      const cwd = readCwd(params);
      const mcpServers = readMcpServers(params);
      const now = deps.clock.now();
      const record: AcpSessionRecord = {
        sessionId: deps.generateId(),
        cwd,
        messages: [],
        turns: 0,
        costUsd: 0,
        permissions: {},
        createdAt: now,
        updatedAt: now,
      };
      if (sessionStore) await sessionStore.save(record);
      live.set(record.sessionId, { record, mcpServers, toolIds: new Set() });
      return { sessionId: record.sessionId };
    },
    [ACP_AGENT_METHODS.sessionLoad]: async (params) => {
      if (!sessionStore)
        throw new AcpError({
          message: 'Method not found',
          rpcCode: ACP_ERROR_CODES.methodNotFound,
        });
      if (!isRecord(params) || typeof params.sessionId !== 'string')
        throw acpInvalidParams('sessionId must be a string.');
      const cwd = readCwd(params);
      const mcpServers = readMcpServers(params);
      if (live.get(params.sessionId)?.active) {
        throw new AcpError({
          message: 'The session has a prompt turn running.',
          rpcCode: ACP_ERROR_CODES.invalidRequest,
        });
      }
      const record = await sessionStore.load(params.sessionId);
      if (!record) {
        throw new AcpError({
          message: `Session not found: ${params.sessionId}`,
          rpcCode: ACP_ERROR_CODES.resourceNotFound,
          data: { sessionId: params.sessionId },
        });
      }
      record.cwd = cwd;
      const session: LiveSession = { record, mcpServers, toolIds: new Set() };
      live.set(record.sessionId, session);
      await replay(session);
      return {};
    },
    [ACP_AGENT_METHODS.sessionPrompt]: (params, context) => prompt(params, context.signal),
    [ACP_DEUZ_BUDGET_METHOD]: async (params) => {
      const { session } = liveSession(params);
      return (
        session.lastBudget ?? {
          turnUsd: 0,
          sessionUsd: session.record.costUsd,
          ...(await remainingOf(await scopesFor(session.record))),
        }
      );
    },
  };

  const SESSION_METHODS = new Set<string>([
    ACP_AGENT_METHODS.sessionNew,
    ACP_AGENT_METHODS.sessionLoad,
    ACP_AGENT_METHODS.sessionPrompt,
    ACP_DEUZ_BUDGET_METHOD,
  ]);

  peer = createAcpPeer({
    transport: options.transport,
    requests,
    notifications: {
      [ACP_AGENT_METHODS.sessionCancel]: (params) => {
        if (!isRecord(params) || typeof params.sessionId !== 'string') return;
        live
          .get(params.sessionId)
          ?.active?.abort(
            new AcpError({ kind: 'cancelled', message: 'The client cancelled the turn.' }),
          );
      },
    },
    guard: (method) => {
      if (method === ACP_AGENT_METHODS.initialize) return;
      if (!initialized) {
        throw new AcpError({
          message: 'The connection is not initialized: send initialize first.',
          rpcCode: ACP_ERROR_CODES.invalidRequest,
        });
      }
      if (!authenticated && SESSION_METHODS.has(method)) {
        throw new AcpError({
          message: 'Authentication required',
          rpcCode: ACP_ERROR_CODES.authRequired,
        });
      }
    },
    onError: report,
  });

  void peer.closed.then(() => {
    for (const session of live.values())
      session.active?.abort(
        new AcpError({ kind: 'closed', message: 'The ACP client disconnected.' }),
      );
  });

  return {
    peer,
    closed: peer.closed,
    close: async () => {
      for (const session of live.values())
        session.active?.abort(
          new AcpError({ kind: 'closed', message: 'The agent closed the connection.' }),
        );
      await peer.close();
    },
  };
}
