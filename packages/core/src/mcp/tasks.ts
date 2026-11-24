/**
 * `@deuz-sdk/core/mcp/server` tasks (2.5) — long-running served tools and
 * agents as MCP tasks.
 *
 * A task-enabled served tool (an agent with `task: true`, or a name in
 * `tasks.tools`) can answer `tools/call` with a task handle instead of the
 * final result. The run continues in the background; the client polls for it,
 * fetches the result later, and can cancel it. Two wire formats exist, and the
 * server speaks the one the request's protocol era defines:
 *
 * - **MCP 2026-07-28** — the official Tasks extension
 *   (`io.modelcontextprotocol/tasks`, SEP-2663, specified in
 *   github.com/modelcontextprotocol/ext-tasks). Server-directed: when the
 *   request's envelope declares the extension, `tools/call` answers a
 *   `CreateTaskResult` (`resultType: "task"`). Methods: `tasks/get` (the task,
 *   with the inlined `result` or `error` once terminal), `tasks/update`
 *   (acknowledged; a Deuz task never asks for input, see below) and
 *   `tasks/cancel` (acknowledged, cooperative). There is no `tasks/list` and no
 *   `tasks/result` on this era. Every `tasks/*` call from a client that did not
 *   declare the extension is refused with `-32021`.
 * - **MCP 2025-11-25** — the experimental core tasks of that revision.
 *   Client-directed: the server advertises `capabilities.tasks` and
 *   `execution.taskSupport: "optional"` on each task-enabled tool, and a
 *   `tools/call` carrying `params.task` answers `{ task }`. Methods:
 *   `tasks/get`, `tasks/result` (blocks until the task is terminal, then
 *   returns exactly the `CallToolResult`), `tasks/list` (paginated, the
 *   caller's own tasks) and `tasks/cancel` (returns the cancelled task; a
 *   terminal task is refused with `-32602`).
 *
 * **What happens before the handle.** The served pipeline's first half runs
 * inside the `tools/call` request, exactly as for a plain call: the
 * `onToolCall` guardrails, then the approval gate (an `approve` callback, or
 * the elicitation round trip, which the Tasks extension says to resolve
 * synchronously before creating a task). A blocked or denied call answers
 * its plain `CallToolResult` and creates no task. Only an approved call
 * becomes a task; argument validation, `execute` (with `Tool.timeoutMs`), the
 * agent run with its own budgets and receipts, and the `onToolResult`
 * guardrails then run in the background. So a task never reaches
 * `input_required`, and `tasks/update` has nothing to answer.
 *
 * **Results.** A run always ends as a `CallToolResult`: a throwing tool is an
 * `isError` result, as in a plain call. On 2026-07-28 that is a `completed`
 * task (the extension keeps `failed` for JSON-RPC errors); on 2025-11-25 an
 * `isError` result shows as `failed` in `tasks/get`, and `tasks/result` still
 * returns the result itself. A task is `failed` with a JSON-RPC error only
 * when the server closes under it.
 *
 * **Cancellation** marks the task `cancelled` (it stays cancelled even if the
 * run finishes later) and aborts the run's signal: a served agent's `runAgent`
 * stops, a tool sees `ctx.signal` abort. The abort reaches the run only in the
 * process that runs it; with a shared durable store, a cancel served by another
 * process still marks the task and discards the late result.
 *
 * **Identity.** A task belongs to the caller that created it: by default the
 * verified `authInfo.clientId` over HTTP, and the connection over stdio (see
 * {@link McpServerTasksOptions.owner}). Every `tasks/*` call answers only the
 * caller's own tasks; another caller's task id is "not found". An anonymous
 * HTTP caller (no `authInfo`) gets bearer semantics: the unguessable task id is
 * the only key, and `tasks/list` answers an empty page.
 *
 * **Retention.** Each task lives `ttlMs` from creation (a 2025-11-25 client
 * may ask for less). An expired task is gone: `tasks/get` answers not-found and
 * the store drops it. Expiry does not abort a run still in progress; bound the
 * run itself (`Tool.timeoutMs`, an agent's budgets).
 *
 * **Where it works** (verified on `@modelcontextprotocol/server` 2.3.1; 2.4.0 behaves the same):
 *
 * | Transport / era            | tasks | status notifications |
 * | -------------------------- | ----- | -------------------- |
 * | HTTP, 2026-07-28           | yes   | no — see below       |
 * | stdio, 2026-07-28          | yes   | no — see below       |
 * | stdio, 2025-11-25          | yes   | `notifications/tasks/status`, pushed |
 * | HTTP, 2025-11-25 stateless | yes   | no: no session, no stream |
 *
 * 2026-07-28 status notifications (`notifications/tasks`) are delivered only
 * on a `subscriptions/listen` stream that names the task in
 * `notifications.taskIds`; the SDK's listen router knows no `taskIds` filter
 * and its notifier sends only the four core change kinds, so they cannot be
 * sent. Polling `tasks/get` is the extension's default and always works.
 *
 * Limits of the SDK this rests on: a task-enabled tool must not declare an
 * `outputSchema` (the SDK requires `structuredContent` on every non-error
 * `tools/call` result of such a tool, so it would turn the task handle into an
 * error); a `CreateTaskResult` carries an extra `content: []` (the SDK adds it
 * to every `tools/call` result; both specs allow extra result fields); and
 * `taskSupport: "required"` is not offered, because the SDK answers any throw
 * inside a tool call as an `isError` result, so the `-32601`/`-32021` refusal
 * the specs require for a non-task call cannot be produced.
 */
import { InvalidRequestError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import type { Clock } from '../types/deps';
import type { StandardSchemaV1 } from '../types/schema';
import type { McpServerRequest } from './server';

// --- Public types --------------------------------------------------------------------

/** The task states both wire formats share. Deuz never sets `input_required` today. */
export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** A JSON-RPC error, as a `failed` task carries it. */
export interface McpTaskError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * One task as a {@link McpTaskStore} keeps it: era-neutral and JSON-safe, so a
 * durable store can persist it as is. The server projects it onto each era's
 * wire shape.
 */
export interface McpTaskRecord {
  /** Server-generated, unguessable. */
  taskId: string;
  /** Who may see it — see {@link McpServerTasksOptions.owner}. Absent for an anonymous caller. */
  owner?: string;
  /** The served tool (or agent) the task runs. */
  toolName: string;
  status: McpTaskStatus;
  statusMessage?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  lastUpdatedAt: string;
  /** Lifetime from `createdAt` in milliseconds; `null` is unlimited. */
  ttlMs: number | null;
  pollIntervalMs?: number;
  /** A `completed` task's `CallToolResult` (`isError` included). */
  result?: Record<string, unknown>;
  /** A `failed` task's JSON-RPC error. */
  error?: McpTaskError;
}

/** The change {@link McpTaskStore.update} applies. */
export interface McpTaskUpdate {
  status: McpTaskStatus;
  lastUpdatedAt: string;
  statusMessage?: string;
  result?: Record<string, unknown>;
  error?: McpTaskError;
}

/** One page of {@link McpTaskStore.list}. */
export interface McpTaskPage {
  tasks: McpTaskRecord[];
  /** Opaque; present when more tasks follow. */
  nextCursor?: string;
}

/**
 * Where tasks live. The default is {@link createInMemoryMcpTaskStore} (one
 * process, lost on restart). A durable store (a database, Redis) implements the
 * same five calls; every `tasks/*` request reads through it, so several
 * processes behind one endpoint can share one.
 *
 * Contract:
 * - `create` resolves only once a `get` of the id would find the record (the
 *   extension requires a task to exist before its handle is returned).
 * - `update` is atomic and never leaves a terminal state: it applies the
 *   change and resolves the new record only when the stored status is
 *   `working` or `input_required`, and resolves `undefined` otherwise
 *   (missing, or already `completed`/`failed`/`cancelled`).
 * - `list` answers only `owner`'s records, oldest first, at most `limit`, and
 *   `null` for a cursor it did not issue.
 * - Expiry is the server's: it treats a record past `createdAt + ttlMs` as
 *   gone and calls `delete`. A store may also purge such records itself.
 */
export interface McpTaskStore {
  create(record: McpTaskRecord): Promise<void>;
  get(taskId: string): Promise<McpTaskRecord | undefined>;
  update(taskId: string, update: McpTaskUpdate): Promise<McpTaskRecord | undefined>;
  list(owner: string, page: { cursor?: string; limit: number }): Promise<McpTaskPage | null>;
  delete(taskId: string): Promise<void>;
}

/** Options of {@link createInMemoryMcpTaskStore}. */
export interface InMemoryMcpTaskStoreOptions {
  /**
   * Most records kept (default 1000). At capacity the oldest finished task is
   * evicted; when every kept task is still running, `create` rejects and the
   * call answers an error result.
   */
  maxTasks?: number;
  /** Time source for purging expired records. Default: the host clock. */
  clock?: Pick<Clock, 'now'>;
}

/** Opt-in task support for a served tool or agent — see the module header. */
export interface McpServerTasksOptions {
  /**
   * Served names (from `tools`, `agentTools` or `agents`) that run as tasks.
   * An agent may instead set `task: true` on its definition. A name that is not
   * served, or a tool with an `outputSchema`, is rejected.
   */
  tools?: string[];
  /** Where tasks live. Default: a new {@link createInMemoryMcpTaskStore}. */
  store?: McpTaskStore;
  /**
   * How long a task is kept from creation, in ms (default one hour). `null`
   * keeps it until the store evicts it. A 2025-11-25 client's requested `ttl`
   * is honoured when shorter.
   */
  ttlMs?: number | null;
  /** The polling interval suggested to clients, in ms (default 1000). */
  pollIntervalMs?: number;
  /**
   * The identity a task is bound to. Default: `client:<authInfo.clientId>` over
   * HTTP (no `authInfo` — anonymous, bearer semantics), and one key per
   * connection over stdio. Return a per-user key when one OAuth client serves
   * many users; `undefined` makes the caller anonymous.
   */
  owner?: (request: McpServerRequest) => string | undefined;
  /** Task id source. Default: `crypto.randomUUID()`. Ids must be unguessable. */
  generateTaskId?: () => string;
}

// --- The in-memory store -------------------------------------------------------------

const TERMINAL: ReadonlySet<McpTaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/** Whether a task can no longer change. */
export function isTerminalTask(status: McpTaskStatus): boolean {
  return TERMINAL.has(status);
}

/** Whether `record` is past its TTL at `now`. */
export function isExpiredTask(record: McpTaskRecord, now: number): boolean {
  if (record.ttlMs === null) return false;
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) && created + record.ttlMs <= now;
}

/**
 * The default {@link McpTaskStore}: a `Map` in this process. Records are
 * cloned in and out, so a caller cannot mutate stored state.
 */
export function createInMemoryMcpTaskStore(
  options: InMemoryMcpTaskStoreOptions = {},
): McpTaskStore {
  const maxTasks = options.maxTasks ?? 1000;
  if (!Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new InvalidRequestError({
      message: `createInMemoryMcpTaskStore: maxTasks must be a positive integer, got ${String(maxTasks)}.`,
    });
  }
  const clock = options.clock ?? resolveDependencies().clock;
  const now = (): number => clock.now();
  const records = new Map<string, McpTaskRecord>();
  const clone = (record: McpTaskRecord): McpTaskRecord => structuredClone(record);

  const purge = (): void => {
    const at = now();
    for (const [id, record] of records) if (isExpiredTask(record, at)) records.delete(id);
  };

  return {
    async create(record) {
      purge();
      if (records.size >= maxTasks) {
        const evictable = [...records.values()].find((kept) => isTerminalTask(kept.status));
        if (!evictable) {
          throw new InvalidRequestError({
            message: `The task store is full: ${maxTasks} tasks are still running.`,
            statusCode: 503,
            isRetryable: true,
          });
        }
        records.delete(evictable.taskId);
      }
      records.set(record.taskId, clone(record));
    },
    async get(taskId) {
      const record = records.get(taskId);
      return record ? clone(record) : undefined;
    },
    async update(taskId, update) {
      const record = records.get(taskId);
      if (!record || isTerminalTask(record.status)) return undefined;
      const next: McpTaskRecord = { ...record, ...structuredClone(update) };
      records.set(taskId, next);
      return clone(next);
    },
    async list(owner, page) {
      purge();
      const mine = [...records.values()].filter((record) => record.owner === owner);
      let start = 0;
      if (page.cursor !== undefined) {
        const index = mine.findIndex((record) => record.taskId === page.cursor);
        if (index < 0) return null;
        start = index + 1;
      }
      const tasks = mine.slice(start, start + page.limit);
      const more = start + page.limit < mine.length;
      return {
        tasks: tasks.map(clone),
        ...(more && tasks.length > 0 ? { nextCursor: tasks[tasks.length - 1]!.taskId } : {}),
      };
    },
    async delete(taskId) {
      records.delete(taskId);
    },
  };
}

// --- Wire constants and projections ----------------------------------------------------

/** The Tasks extension's identifier (MCP 2026-07-28). */
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** `_meta` key that ties a 2025-11-25 `tasks/result` to its task. */
const RELATED_TASK_KEY = 'io.modelcontextprotocol/related-task';

/**
 * Where a 2025-11-25 `tools/call`'s `params.task` is copied to (in
 * `params._meta`) before the SDK sees the request: the SDK hands a tool only
 * its arguments and `_meta`, never the rest of `params`. Internal.
 */
export const LIFTED_TASK_META_KEY = 'dev.deuz/task-request';

/** `-32021` Missing Required Client Capability (MCP 2026-07-28). */
const MISSING_CAPABILITY = -32021;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Longest `statusMessage` an `isError` result's text becomes. */
const MAX_STATUS_MESSAGE = 500;

/** `tasks/list` page size (2025-11-25). */
const LIST_PAGE_SIZE = 50;

function rpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

function taskFields(record: McpTaskRecord): Record<string, unknown> {
  return {
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
  };
}

/** The 2026-07-28 `DetailedTask` (`tasks/get`): inlines `result` or `error` once terminal. */
function modernTask(record: McpTaskRecord): Record<string, unknown> {
  return {
    ...taskFields(record),
    ttlMs: record.ttlMs,
    ...(record.pollIntervalMs !== undefined ? { pollIntervalMs: record.pollIntervalMs } : {}),
    ...(record.status === 'completed' && record.result ? { result: record.result } : {}),
    ...(record.status === 'failed' && record.error ? { error: record.error } : {}),
  };
}

/** 2025-11-25 counts a tool result with `isError` as a failed task. */
function legacyStatus(record: McpTaskRecord): McpTaskStatus {
  return record.status === 'completed' && record.result?.isError === true
    ? 'failed'
    : record.status;
}

/** The 2025-11-25 `Task`. */
function legacyTask(record: McpTaskRecord): Record<string, unknown> {
  return {
    ...taskFields(record),
    status: legacyStatus(record),
    ttl: record.ttlMs,
    ...(record.pollIntervalMs !== undefined ? { pollInterval: record.pollIntervalMs } : {}),
  };
}

/**
 * The `tools/call` answer that hands out a task, for the request's era. The
 * SDK requires `content` on a 2025-era `tools/call` result that carries
 * `task`, and adds `content: []` on 2026-07-28 itself.
 */
export function createTaskResult(
  record: McpTaskRecord,
  era: 'legacy' | 'modern',
): Record<string, unknown> {
  return era === 'modern'
    ? { resultType: 'task', ...modernTask(record) }
    : { content: [], task: legacyTask(record) };
}

/** Whether a 2026-07-28 request's envelope declares the Tasks extension. */
export function declaresTasksExtension(envelope: Record<string, unknown> | undefined): boolean {
  const capabilities = envelope?.['io.modelcontextprotocol/clientCapabilities'];
  if (typeof capabilities !== 'object' || capabilities === null) return false;
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  if (typeof extensions !== 'object' || extensions === null) return false;
  const declared = (extensions as Record<string, unknown>)[MCP_TASKS_EXTENSION];
  return typeof declared === 'object' && declared !== null;
}

/**
 * A 2025-11-25 task request lifted by {@link liftLegacyTaskParam}: `undefined`
 * when the call asked for no task, else the requested TTL (if a valid one).
 */
export function liftedTaskRequest(
  meta: Record<string, unknown> | undefined,
): { ttlMs?: number } | undefined {
  const lifted = meta?.[LIFTED_TASK_META_KEY];
  if (typeof lifted !== 'object' || lifted === null || Array.isArray(lifted)) return undefined;
  const ttl = (lifted as { ttl?: unknown }).ttl;
  return typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= 0 ? { ttlMs: ttl } : {};
}

/**
 * Copy a `tools/call`'s `params.task` into `params._meta` so the served tool
 * sees it (see {@link LIFTED_TASK_META_KEY}). Anything else, including a
 * message with no `params.task` object, comes back as the same object. Pure.
 */
export function liftLegacyTaskParam(message: unknown): unknown {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== 'tools/call' || typeof params !== 'object' || params === null) return message;
  const task = (params as { task?: unknown }).task;
  if (typeof task !== 'object' || task === null || Array.isArray(task)) return message;
  const meta = (params as { _meta?: unknown })._meta;
  return {
    ...message,
    params: {
      ...params,
      _meta: {
        ...(typeof meta === 'object' && meta !== null ? meta : {}),
        [LIFTED_TASK_META_KEY]: task,
      },
    },
  };
}

// --- The runtime ---------------------------------------------------------------------------

/** What the SDK hands a `tasks/*` handler — the part the runtime reads. */
export interface TaskHandlerContext {
  mcpReq: { signal: AbortSignal; envelope?: Record<string, unknown> };
}

/** The SDK server surface the runtime registers on (a structural mirror). */
export interface TaskHandlerHost {
  setRequestHandler(
    method: string,
    schemas: { params: StandardSchemaV1 },
    handler: (params: Record<string, unknown>, ctx: TaskHandlerContext) => unknown,
  ): void;
}

export interface TaskRuntimeOptions {
  store: McpTaskStore;
  clock: Clock;
  ttlMs: number | null;
  pollIntervalMs: number;
  generateTaskId: () => string;
  report: (error: unknown) => void;
}

/** What starting one task needs. `run` resolves the `CallToolResult`; a throw fails the task. */
export interface TaskStart {
  owner: string | undefined;
  toolName: string;
  /** A 2025-11-25 client's requested TTL; honoured when shorter than the server's. */
  requestedTtlMs?: number;
  /** Called with each later state of this task (2025-era stdio status notifications). */
  notify?: (record: McpTaskRecord, legacy: Record<string, unknown>) => void;
  run: (signal: AbortSignal) => Promise<Record<string, unknown>>;
}

export interface TaskRuntime {
  /** Create the task durably, start `run` in the background, resolve the record. */
  start(start: TaskStart): Promise<McpTaskRecord>;
  /** Register this era's `tasks/*` handlers; `ownerOf` names the caller of each request. */
  install(
    host: TaskHandlerHost,
    era: 'legacy' | 'modern',
    ownerOf: (ctx: TaskHandlerContext) => string | undefined,
  ): void;
  /** Abort every run in this process and mark its task failed. */
  close(): Promise<void>;
}

function resultText(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
    if (text) return text;
  }
  return 'The tool returned an error.';
}

function paramsSchema(fields: { taskId?: true; cursor?: true }): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'deuz',
      validate: (value: unknown) => {
        const params = (typeof value === 'object' && value !== null ? value : {}) as Record<
          string,
          unknown
        >;
        if (fields.taskId && typeof params.taskId !== 'string') {
          return { issues: [{ message: 'params.taskId must be a string', path: ['taskId'] }] };
        }
        if (fields.cursor && params.cursor !== undefined && typeof params.cursor !== 'string') {
          return { issues: [{ message: 'params.cursor must be a string', path: ['cursor'] }] };
        }
        return { value: params };
      },
    },
  } as StandardSchemaV1;
}

const TASK_ID = paramsSchema({ taskId: true });
const LIST = paramsSchema({ cursor: true });

/** The engine behind the module header: one per `createMcpServer`, shared by every serving unit. */
export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime {
  const { store, clock, report } = options;
  /** Runs in this process, by task id. */
  const running = new Map<string, AbortController>();
  /** `tasks/result` waiters, woken on every change this process makes. */
  const waiters = new Map<string, Set<() => void>>();
  const notifiers = new Map<string, NonNullable<TaskStart['notify']>>();

  const iso = (): string => new Date(clock.now()).toISOString();

  const changed = (record: McpTaskRecord): void => {
    for (const wake of waiters.get(record.taskId) ?? []) wake();
    const notify = notifiers.get(record.taskId);
    if (notify) {
      try {
        notify(record, legacyTask(record));
      } catch (error) {
        report(error);
      }
    }
    if (isTerminalTask(record.status)) notifiers.delete(record.taskId);
  };

  const finish = async (taskId: string, update: Omit<McpTaskUpdate, 'lastUpdatedAt'>) => {
    try {
      const updated = await store.update(taskId, { ...update, lastUpdatedAt: iso() });
      if (updated) changed(updated);
    } catch (error) {
      report(error);
    }
  };

  /** The caller's view of a task: missing, someone else's and expired all read as absent. */
  const find = async (
    owner: string | undefined,
    taskId: string,
  ): Promise<McpTaskRecord | undefined> => {
    const record = await store.get(taskId);
    if (!record || record.owner !== owner) return undefined;
    if (isExpiredTask(record, clock.now())) {
      await store.delete(taskId).catch(report);
      return undefined;
    }
    return record;
  };

  const notFound = (taskId: string): Error =>
    rpcError(INVALID_PARAMS, `Failed to retrieve task: Task '${taskId}' not found`);

  const findOrThrow = async (owner: string | undefined, taskId: string) => {
    const record = await find(owner, taskId);
    if (!record) throw notFound(taskId);
    return record;
  };

  /** Mark cancelled (if still running) and abort the run. */
  const cancel = async (record: McpTaskRecord): Promise<McpTaskRecord> => {
    const updated = await store.update(record.taskId, {
      status: 'cancelled',
      statusMessage: 'Cancelled by the client.',
      lastUpdatedAt: iso(),
    });
    running.get(record.taskId)?.abort(new Error(`Task '${record.taskId}' was cancelled.`));
    if (updated) {
      changed(updated);
      return updated;
    }
    return (await store.get(record.taskId)) ?? record;
  };

  /** Resolve once the task is terminal (or gone): this process's changes wake it, a poll catches others'. */
  const settled = async (
    owner: string | undefined,
    taskId: string,
    signal: AbortSignal,
  ): Promise<McpTaskRecord> => {
    for (;;) {
      const record = await findOrThrow(owner, taskId);
      if (isTerminalTask(record.status)) return record;
      if (signal.aborted) throw signal.reason ?? new Error('Request cancelled.');
      await new Promise<void>((resolve) => {
        let set = waiters.get(taskId);
        if (!set) waiters.set(taskId, (set = new Set()));
        const wake = (): void => {
          set!.delete(wake);
          if (set!.size === 0) waiters.delete(taskId);
          cancelTimer();
          signal.removeEventListener('abort', wake);
          resolve();
        };
        set.add(wake);
        const cancelTimer = clock.setTimeout(wake, record.pollIntervalMs ?? options.pollIntervalMs);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  };

  const requireExtension = (ctx: TaskHandlerContext): void => {
    if (!declaresTasksExtension(ctx.mcpReq.envelope)) {
      throw rpcError(MISSING_CAPABILITY, 'Missing required client capability', {
        requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
      });
    }
  };

  return {
    async start(start) {
      const requested = start.requestedTtlMs;
      const ttlMs =
        requested === undefined
          ? options.ttlMs
          : options.ttlMs === null
            ? requested
            : Math.min(requested, options.ttlMs);
      const now = iso();
      const record: McpTaskRecord = {
        taskId: options.generateTaskId(),
        ...(start.owner !== undefined ? { owner: start.owner } : {}),
        toolName: start.toolName,
        status: 'working',
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs,
        pollIntervalMs: options.pollIntervalMs,
      };
      await store.create(record);
      const controller = new AbortController();
      running.set(record.taskId, controller);
      if (start.notify) notifiers.set(record.taskId, start.notify);
      void Promise.resolve()
        .then(() => start.run(controller.signal))
        .then(
          (result) =>
            finish(record.taskId, {
              status: 'completed',
              result,
              ...(result.isError === true
                ? { statusMessage: resultText(result).slice(0, MAX_STATUS_MESSAGE) }
                : {}),
            }),
          (error: unknown) =>
            finish(record.taskId, {
              status: 'failed',
              statusMessage: 'The task failed.',
              error: {
                code: INTERNAL_ERROR,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        )
        .finally(() => {
          running.delete(record.taskId);
          notifiers.delete(record.taskId);
        });
      return record;
    },

    install(host, era, ownerOf) {
      if (era === 'modern') {
        host.setRequestHandler('tasks/get', { params: TASK_ID }, async (params, ctx) => {
          requireExtension(ctx);
          return modernTask(await findOrThrow(ownerOf(ctx), params.taskId as string));
        });
        // A Deuz task never surfaces inputRequests, so every response is for a
        // key that is not outstanding — which the extension says to ignore.
        host.setRequestHandler('tasks/update', { params: TASK_ID }, async (params, ctx) => {
          requireExtension(ctx);
          await findOrThrow(ownerOf(ctx), params.taskId as string);
          return {};
        });
        host.setRequestHandler('tasks/cancel', { params: TASK_ID }, async (params, ctx) => {
          requireExtension(ctx);
          const record = await findOrThrow(ownerOf(ctx), params.taskId as string);
          if (!isTerminalTask(record.status)) await cancel(record);
          return {};
        });
        return;
      }
      host.setRequestHandler('tasks/get', { params: TASK_ID }, async (params, ctx) =>
        legacyTask(await findOrThrow(ownerOf(ctx), params.taskId as string)),
      );
      host.setRequestHandler('tasks/result', { params: TASK_ID }, async (params, ctx) => {
        const taskId = params.taskId as string;
        const record = await settled(ownerOf(ctx), taskId, ctx.mcpReq.signal);
        if (record.status === 'completed' && record.result) {
          const meta = record.result._meta;
          return {
            ...record.result,
            _meta: {
              ...(typeof meta === 'object' && meta !== null ? meta : {}),
              [RELATED_TASK_KEY]: { taskId },
            },
          };
        }
        if (record.status === 'failed' && record.error) {
          throw rpcError(record.error.code, record.error.message, record.error.data);
        }
        throw rpcError(INVALID_PARAMS, `Task '${taskId}' was cancelled; it has no result.`);
      });
      host.setRequestHandler('tasks/list', { params: LIST }, async (params, ctx) => {
        const owner = ownerOf(ctx);
        // An anonymous caller cannot be told apart from any other: list nothing.
        if (owner === undefined) return { tasks: [] };
        const cursor = params.cursor as string | undefined;
        const page = await store.list(owner, {
          ...(cursor !== undefined ? { cursor } : {}),
          limit: LIST_PAGE_SIZE,
        });
        if (page === null) throw rpcError(INVALID_PARAMS, `Invalid cursor '${String(cursor)}'.`);
        const now = clock.now();
        return {
          tasks: page.tasks.filter((record) => !isExpiredTask(record, now)).map(legacyTask),
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        };
      });
      host.setRequestHandler('tasks/cancel', { params: TASK_ID }, async (params, ctx) => {
        const record = await findOrThrow(ownerOf(ctx), params.taskId as string);
        if (isTerminalTask(record.status)) {
          throw rpcError(
            INVALID_PARAMS,
            `Cannot cancel task: already in terminal status '${legacyStatus(record)}'`,
          );
        }
        return legacyTask(await cancel(record));
      });
    },

    async close() {
      const ids = [...running.keys()];
      for (const id of ids) running.get(id)?.abort(new Error('The MCP server closed.'));
      await Promise.all(
        ids.map((id) =>
          finish(id, {
            status: 'failed',
            statusMessage: 'The MCP server closed before the task finished.',
            error: {
              code: INTERNAL_ERROR,
              message: 'The MCP server closed before the task finished.',
            },
          }),
        ),
      );
    },
  };
}
