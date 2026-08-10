import type { ToolSet, Tool } from '../types/tool';
import type { JSONSchema } from '../types/schema';
import type { Clock } from '../types/deps';
import type { ImagePart, Message, TextPart } from '../types/message';
import type { LanguageModel } from '../types/model';
import { resolveDependencies } from '../internal/resolve-deps';
import { unitFromId } from '../core/resilience';
import { InvalidRequestError } from '../errors';
// The ROOT call boundary, never `inference/*` — the `src/agent.ts` precedent. A
// server-driven sample is canonicalized byte-for-byte like a hand-written call.
import { generateText } from '../generate';

/**
 * The minimal MCP client surface we depend on (the SDK's `Client`). The
 * resource/prompt methods are OPTIONAL: they exist from SDK ~1.x but older
 * installations may lack them — we probe at call time and raise an actionable
 * error instead of requiring them structurally (which would also break test
 * fakes and downstream implementers).
 */
export interface RawMcpClient {
  connect(transport: unknown): Promise<void>;
  callTool(req: { name: string; arguments: unknown }): Promise<McpCallResult>;
  listTools(): Promise<{ tools: McpToolDef[] }>;
  close(): Promise<void>;
  /** SDK request-handler registration (used for elicitation/create). */
  setRequestHandler?(
    schema: unknown,
    handler: (req: { params: Record<string, unknown> }) => unknown,
  ): void;
  /** SDK notification-handler registration (inherited from `Protocol`; used for tools/list_changed). */
  setNotificationHandler?(
    schema: unknown,
    handler: (notification: { params?: Record<string, unknown> }) => void,
  ): void;
  /** Tell the server our roots list changed (declared only when roots are configured). */
  sendRootsListChanged?(): Promise<void>;
  /** MCP `ping` — the keepalive heartbeat probe. */
  ping?(): Promise<unknown>;
  /** Server `Implementation` block from the handshake (namespace derivation). */
  getServerVersion?(): { name?: string; version?: string } | undefined;
  /** Fired when the session ends — expected after `close()`, a DROP otherwise. */
  onclose?: (() => void) | undefined;
  /** Fired on a transport-level error; the SDK follows with `onclose` when fatal. */
  onerror?: ((error: Error) => void) | undefined;
  listResources?(params?: {
    cursor?: string;
  }): Promise<{ resources: McpResource[]; nextCursor?: string }>;
  readResource?(params: { uri: string }): Promise<{ contents: McpResourceContent[] }>;
  listPrompts?(params?: {
    cursor?: string;
  }): Promise<{ prompts: McpPrompt[]; nextCursor?: string }>;
  getPrompt?(params: {
    name: string;
    arguments?: Record<string, string>;
  }): Promise<McpGetPromptResult>;
}

// Structural mirrors of the SDK result shapes — the SDK is an optional peer,
// so its types must never leak into our public .d.ts.

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** One entry of a readResource result: text (`text`) or binary (`blob`, base64). */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  [key: string]: unknown;
}

/** Prompt messages come back in MCP's own shape (role + content block) — not our `Message`. */
export interface McpPromptMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
  [key: string]: unknown;
}

// --- Elicitation (MCP 2025-11-25: form + url modes) ---

/** In-band structured data collection; the client renders a form. */
export interface McpFormElicitationRequest {
  mode: 'form';
  message: string;
  /** Restricted JSON Schema: flat object, primitive properties only. */
  requestedSchema: JSONSchema;
}

/**
 * Out-of-band interaction via URL (auth/payment/sensitive data). Returning
 * `{ action: 'accept' }` means the USER CONSENTED to open the URL — the
 * interaction itself completes outside MCP. NEVER auto-open or prefetch the
 * URL; show it to the user first (spec requirement).
 */
export interface McpUrlElicitationRequest {
  mode: 'url';
  message: string;
  url: string;
  elicitationId: string;
}

export type McpElicitationRequest = McpFormElicitationRequest | McpUrlElicitationRequest;

export interface McpElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  /** Form mode, accept only: the submitted data matching requestedSchema. */
  content?: Record<string, unknown>;
}

export type McpElicitationHandler = (
  req: McpElicitationRequest,
) => McpElicitationResult | Promise<McpElicitationResult>;

/**
 * Adapt a user callback to the SDK's request-handler shape (shared by the
 * http and stdio transports). Requests without a `mode` are form mode
 * (spec back-compat).
 */
export function buildElicitationHandler(
  cb: McpElicitationHandler,
): (req: { params: Record<string, unknown> }) => Promise<McpElicitationResult> {
  return async (req) => {
    const p = req.params;
    const request: McpElicitationRequest =
      p.mode === 'url'
        ? {
            mode: 'url',
            message: String(p.message ?? ''),
            url: String(p.url ?? ''),
            elicitationId: String(p.elicitationId ?? ''),
          }
        : {
            mode: 'form',
            message: String(p.message ?? ''),
            requestedSchema: (p.requestedSchema ?? { type: 'object' }) as JSONSchema,
          };
    return cb(request);
  };
}

/** Safety cap for cursor auto-pagination (bounds hostile/looping servers). */
export const MAX_MCP_PAGES = 100;

function requireMethod<T>(method: T | undefined, name: string): T {
  if (!method) {
    throw new InvalidRequestError({
      message: `The connected MCP SDK lacks client.${name}() — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.`,
    });
  }
  return method;
}

async function paginate<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MCP_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
  return all; // cap reached — endless cursor
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  /** MCP output schema — carried onto `Tool.outputSchema` as metadata (the SDK validates server-side). */
  outputSchema?: JSONSchema;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  /** Structured tool output (MCP 2025-11-25); preferred over the text blocks when present. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Flatten an MCP tool result to a value our loop can feed back to the model. */
export function extractContent(result: McpCallResult): unknown {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  // Self-heal: an MCP error becomes a thrown error → the loop records an is_error
  // tool_result so the model can recover. isError wins over structuredContent.
  if (result.isError) {
    const structured = result.structuredContent && JSON.stringify(result.structuredContent);
    throw new Error(text || structured || 'MCP tool returned an error.');
  }
  // Per spec the text blocks are a redundant serialization — return the
  // structured value verbatim when the server provides one.
  if (result.structuredContent !== undefined) return result.structuredContent;
  return text !== '' ? text : blocks;
}

/**
 * The single method a mapped `ToolSet` needs. Narrower than `RawMcpClient` on
 * purpose: a managed connection hands over an indirection whose `callTool`
 * always targets the CURRENT client, so tools built before a reconnect keep
 * working after it.
 */
export interface McpToolCaller {
  callTool(req: { name: string; arguments: unknown }): Promise<McpCallResult>;
}

/**
 * Map MCP tool definitions into our `ToolSet`. Each tool's `execute` calls the
 * MCP server via `callTool`; the MCP `inputSchema` IS a JSON Schema, so it goes
 * straight onto `Tool.parameters`. Optional `namespace` prefixes names when
 * combining multiple servers.
 */
export function mcpToolsToToolSet(
  client: McpToolCaller,
  tools: McpToolDef[],
  namespace?: string,
): ToolSet {
  const set: ToolSet = {};
  for (const def of tools) {
    const key = namespace ? `${namespace}_${def.name}` : def.name;
    const tool: Tool = {
      ...(def.description ? { description: def.description } : {}),
      parameters: def.inputSchema ?? { type: 'object', properties: {} },
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
      execute: async (args) =>
        extractContent(await client.callTool({ name: def.name, arguments: args })),
    };
    set[key] = tool;
  }
  return set;
}

// --- Connection lifecycle (2.0) ---------------------------------------------

/**
 * Where a managed session is in its life. `connecting` is the first handshake,
 * `reconnecting` a backoff window after an unexpected drop, `error` a drop
 * whose attempts are exhausted, `closed` an explicit `close()` (or any drop
 * when reconnect is off — the 1.x behavior, where a dead client stays dead).
 */
export type McpConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

/** Exponential-backoff shape for {@link McpLifecycleOptions.reconnect}. */
export interface McpReconnectPolicy {
  /** Attempts before giving up and going `error`. Default 5. */
  maxAttempts?: number;
  /** Delay before attempt 1. Default 500. */
  initialDelayMs?: number;
  /** Ceiling on the exponential term. Default 30_000. */
  maxDelayMs?: number;
  /** Exponential base — attempt n waits `initialDelayMs * factor ** (n - 1)`. Default 2. */
  factor?: number;
  /** Relative spread applied as `delay * (1 ± jitter)`; `0` makes delays exact. Default 0.25. */
  jitter?: number;
}

/** Context for a status transition. */
export interface McpStatusInfo {
  /** 1-based reconnect attempt (`reconnecting` only). */
  attempt?: number;
  /** The drop or connect failure behind this transition, when there was one. */
  error?: unknown;
}

/**
 * Lifecycle knobs shared by every transport (`McpClientOptions`,
 * `McpStdioOptions`). All of it is additive and off by default: leaving this
 * empty reproduces the 1.x connect-once behavior exactly.
 */
export interface McpLifecycleOptions {
  /**
   * Recover from a dropped session: `true` for the default policy, an object to
   * tune it, absent/`false` for 1.x (a drop is terminal).
   *
   * This is SESSION-level recovery — every attempt builds a NEW transport AND a
   * NEW client through the same factory, so every handler is re-registered and
   * nothing is silently lost. It is distinct from, and composes with,
   * `StreamableHTTPClientTransport`'s own `reconnectionOptions`, which resumes
   * the GET event stream *inside* a session that is still alive; that never
   * fires our state machine because the session never actually died.
   */
  reconnect?: boolean | McpReconnectPolicy;
  /** Observe every transition. A throwing callback is swallowed — it must not kill the connection. */
  onStatusChange?: (status: McpConnectionStatus, info?: McpStatusInfo) => void;
  /** Chained `ping()` heartbeat, in ms. Off by default; a rejected ping counts as a drop. */
  keepAliveMs?: number;
  /** Time source for backoff + keepalive. Default: the host clock `resolveDependencies()` applies. */
  clock?: Clock;
}

/** Handles passed to the client factory so its handlers can talk back to the connection. */
export interface McpClientHooks {
  /** Call from a `notifications/tools/list_changed` handler. */
  toolListChanged(): void;
}

export interface ManagedConnectionOptions {
  /**
   * Build a FRESH, unconnected client with EVERY handler already registered.
   * This is the single registration point: a reconnect calls it again, so
   * whatever it registers survives into the new session with nothing to replay.
   */
  makeClient(hooks: McpClientHooks): Promise<RawMcpClient>;
  /** Build a FRESH transport for one attempt — transports are single-use. */
  makeTransport(): Promise<unknown>;
  lifecycle?: McpLifecycleOptions;
}

/** A live, self-healing MCP session. */
export interface ManagedMcp {
  /** The CURRENT raw client — its identity changes across a reconnect, so never cache it. */
  raw(): RawMcpClient;
  status(): McpConnectionStatus;
  /** Subscribe to tool-list invalidation; returns an unsubscribe. */
  onToolListChanged(cb: () => void): () => void;
  /** Idempotent: raises the closed flag first (silencing reconnect + keepalive), then closes. */
  close(): Promise<void>;
  /** Drop cached tool lists and notify subscribers — what `tools/list_changed` triggers. */
  markToolsDirty(): void;
}

const DEFAULT_RECONNECT: Required<McpReconnectPolicy> = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.25,
};

function resolveReconnect(
  opt: boolean | McpReconnectPolicy | undefined,
): Required<McpReconnectPolicy> | undefined {
  if (!opt) return undefined;
  const p = opt === true ? {} : opt;
  return {
    maxAttempts: p.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
    initialDelayMs: p.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
    maxDelayMs: p.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    factor: p.factor ?? DEFAULT_RECONNECT.factor,
    jitter: p.jitter ?? DEFAULT_RECONNECT.jitter,
  };
}

/**
 * `min(maxDelayMs, initialDelayMs * factor ** (attempt - 1))`, spread by
 * ±jitter. The spread is derived from the injected clock (FNV-1a, same trick
 * as the retry backoff) so core never reaches for `Math.random()` and a fake
 * clock keeps the delays reproducible; `jitter: 0` makes them exact.
 */
function reconnectDelayMs(
  policy: Required<McpReconnectPolicy>,
  attempt: number,
  seed: string,
): number {
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.factor ** (attempt - 1));
  if (policy.jitter <= 0) return Math.round(base);
  const spread = (unitFromId(seed) * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(base * (1 + spread)));
}

/**
 * Wrap a connect-once factory pair in a self-healing session.
 *
 * The initial connect is NOT retried — a server that is wrong or unreachable
 * right now should reject `createMcpClient()` the way it did in 1.x. Reconnect
 * covers the other half: a session that WAS healthy and died under us.
 */
export async function createManagedConnection(
  options: ManagedConnectionOptions,
): Promise<ManagedMcp> {
  const lifecycle = options.lifecycle ?? {};
  const clock = lifecycle.clock ?? resolveDependencies().clock;
  const policy = resolveReconnect(lifecycle.reconnect);
  const listeners = new Set<() => void>();
  /** Sleepers to wake early when `close()` lands mid-backoff. */
  const wakes = new Set<() => void>();

  let status: McpConnectionStatus = 'connecting';
  let client: RawMcpClient | undefined;
  /** Bumped per attempt; a callback from an older generation is stale and ignored. */
  let generation = 0;
  let closed = false;
  let cancelKeepAlive: (() => void) | undefined;

  const setStatus = (next: McpConnectionStatus, info?: McpStatusInfo): void => {
    status = next;
    try {
      lifecycle.onStatusChange?.(next, info);
    } catch {
      // An observer must never take the connection down with it.
    }
  };

  const markToolsDirty = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch {
        // Same contract as onStatusChange: subscribers cannot break the session.
      }
    }
  };

  const stopKeepAlive = (): void => {
    cancelKeepAlive?.();
    cancelKeepAlive = undefined;
  };

  /** Chained (not periodic) so a slow server can never stack pings. */
  const startKeepAlive = (): void => {
    stopKeepAlive();
    const ms = lifecycle.keepAliveMs;
    const target = client;
    const ping = target?.ping;
    if (!ms || ms <= 0 || !target || !ping) return;
    const gen = generation;
    const schedule = (): void => {
      cancelKeepAlive = clock.setTimeout(() => {
        cancelKeepAlive = undefined;
        if (closed || gen !== generation) return;
        void Promise.resolve()
          .then(() => ping.call(target))
          .then(
            () => {
              if (!closed && gen === generation) schedule();
            },
            // A dead heartbeat IS a drop — take the same path onclose takes.
            (error: unknown) => onDrop(gen, error),
          );
      }, ms);
    };
    schedule();
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const wake = (): void => {
        wakes.delete(wake);
        cancel();
        resolve();
      };
      const cancel = clock.setTimeout(() => {
        wakes.delete(wake);
        resolve();
      }, ms);
      wakes.add(wake);
    });

  async function connectOnce(): Promise<void> {
    const gen = ++generation;
    const next = await options.makeClient({ toolListChanged: markToolsDirty });
    const transport = await options.makeTransport();
    // Registered BEFORE connect so a handshake that dies immediately is still seen.
    const seen: { error?: unknown } = {};
    next.onerror = (error) => {
      seen.error = error;
    };
    next.onclose = () => onDrop(gen, seen.error);
    await next.connect(transport);
    client = next;
    // Raced with close(): the caller already gave up, so hang up the new session.
    if (closed) void safeClose(next);
  }

  async function safeClose(target: RawMcpClient): Promise<void> {
    try {
      await target.close();
    } catch {
      // Closing a transport that is already gone is not a failure worth surfacing.
    }
  }

  function onDrop(gen: number, error: unknown): void {
    if (closed || gen !== generation) return;
    stopKeepAlive();
    if (!policy) {
      // 1.x: no recovery. The client stays reachable via raw() and its calls reject.
      setStatus('closed', error === undefined ? undefined : { error });
      return;
    }
    void reconnectLoop(error);
  }

  async function reconnectLoop(initial: unknown): Promise<void> {
    if (!policy) return;
    let error = initial;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      if (closed) return;
      setStatus('reconnecting', { attempt, ...(error === undefined ? {} : { error }) });
      await sleep(reconnectDelayMs(policy, attempt, `${clock.now()}:${attempt}`));
      if (closed) return;
      try {
        await connectOnce();
        if (closed) return;
        setStatus('connected');
        startKeepAlive();
        // The server we came back to may not be the one we left — assume the
        // tool list moved and let subscribers refetch.
        markToolsDirty();
        return;
      } catch (err) {
        error = err;
      }
    }
    if (closed) return;
    setStatus('error', { error });
  }

  // Emitted even though it is the initial value, so a status listener sees the
  // whole trace and not just the transitions after the handshake.
  setStatus('connecting');
  try {
    await connectOnce();
  } catch (err) {
    setStatus('error', { error: err });
    throw err;
  }
  if (!closed) {
    setStatus('connected');
    startKeepAlive();
  }

  return {
    raw: () => client!,
    status: () => status,
    markToolsDirty,
    onToolListChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async close() {
      if (closed) return; // idempotent — a second call resolves at once
      closed = true; // FIRST: silences reconnect + keepalive before anything awaits
      stopKeepAlive();
      for (const wake of [...wakes]) wake();
      setStatus('closed');
      const target = client;
      if (target) await safeClose(target);
    },
  };
}

/** The transport-agnostic client we return to callers. */
export interface McpClient {
  /** MCP tools mapped to a `ToolSet` ready for `generateText({ tools })`. */
  listTools(namespace?: string): Promise<ToolSet>;
  /** Call a tool directly (rarely needed; the loop uses `execute`). */
  callTool(name: string, args: unknown): Promise<unknown>;
  /** All resources across pages (auto-paginated, capped at MAX_MCP_PAGES). */
  listResources(): Promise<McpResource[]>;
  /** Read one resource; returns its contents array (text and/or base64 blob entries). */
  readResource(uri: string): Promise<McpResourceContent[]>;
  /** All prompts across pages (auto-paginated, capped at MAX_MCP_PAGES). */
  listPrompts(): Promise<McpPrompt[]>;
  /** Render a prompt with arguments; returns MCP's own message shape verbatim. */
  getPrompt(name: string, args?: Record<string, string>): Promise<McpGetPromptResult>;
  /** Current connection state; always `'connected'` for an unmanaged client. */
  status(): McpConnectionStatus;
  /**
   * Fires when the server's tool list is invalidated (`tools/list_changed`, or a
   * reconnect landing on a possibly-different server). The next `listTools()`
   * refetches; returns an unsubscribe.
   */
  onToolListChanged(cb: () => void): () => void;
  close(): Promise<void>;
}

/**
 * Wrap a connected raw SDK client in our `McpClient`.
 *
 * With a `managed` connection every call routes through `managed.raw()`, so the
 * wrapper (and every `ToolSet` it produced) follows the session across
 * reconnects, and `listTools()` is served from a cache that only invalidation
 * clears. Without one the wrapper is the 1.x pass-through, plus inert
 * `status()`/`onToolListChanged()` stubs.
 */
export function wrapMcpClient(raw: RawMcpClient, managed?: ManagedMcp): McpClient {
  const current = (): RawMcpClient => managed?.raw() ?? raw;
  const caller: McpToolCaller = { callTool: (req) => current().callTool(req) };

  let cachedTools: McpToolDef[] | undefined;
  let cacheGeneration = 0;
  managed?.onToolListChanged(() => {
    cachedTools = undefined;
    cacheGeneration++;
  });

  return {
    async listTools(namespace) {
      if (!cachedTools) {
        const gen = cacheGeneration;
        const { tools } = await current().listTools();
        // Invalidated while in flight → serve this list but do not cache it.
        if (gen === cacheGeneration) cachedTools = tools;
        return mcpToolsToToolSet(caller, tools, namespace);
      }
      return mcpToolsToToolSet(caller, cachedTools, namespace);
    },
    callTool: async (name, args) =>
      extractContent(await current().callTool({ name, arguments: args })),
    async listResources() {
      const c = current();
      const fn = requireMethod(c.listResources, 'listResources').bind(c);
      return paginate(async (cursor) => {
        const page = await fn(cursor ? { cursor } : undefined);
        return {
          items: page.resources,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
    async readResource(uri) {
      const c = current();
      const fn = requireMethod(c.readResource, 'readResource').bind(c);
      const { contents } = await fn({ uri });
      return contents;
    },
    async listPrompts() {
      const c = current();
      const fn = requireMethod(c.listPrompts, 'listPrompts').bind(c);
      return paginate(async (cursor) => {
        const page = await fn(cursor ? { cursor } : undefined);
        return { items: page.prompts, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      });
    },
    async getPrompt(name, args) {
      const c = current();
      const fn = requireMethod(c.getPrompt, 'getPrompt').bind(c);
      return fn({ name, ...(args ? { arguments: args } : {}) });
    },
    status: () => managed?.status() ?? 'connected',
    onToolListChanged: (cb) => managed?.onToolListChanged(cb) ?? (() => {}),
    close: () => (managed ? managed.close() : raw.close()),
  };
}

// --- Sampling + roots (2.0) --------------------------------------------------
//
// The two places where the SERVER calls US. Everything below is PURE: shapes,
// mappers and handler factories. Registering them against the SDK's Zod schemas
// (and declaring the matching capabilities) belongs to the transports, exactly
// as `registerElicitation` already does — see `mcp/index.ts`.

/**
 * One `sampling/createMessage` message on the wire. MCP has no system role (the
 * system prompt is a sibling field) and the content is a SINGLE block, not an
 * array — so this is deliberately not our `Message`.
 */
export interface McpSamplingMessage {
  role: 'user' | 'assistant';
  content: { type: string; text?: string; data?: string; mimeType?: string };
}

/**
 * A sampling request in OUR shape. The messages are already canonical, so an
 * `approve` callback reviews exactly what the model would receive — an approval
 * gate that had to re-parse the MCP wire shape would be one more place to get
 * the mapping wrong.
 */
export interface McpSamplingRequest {
  messages: Message[];
  systemPrompt?: string;
  /** The cap that will ACTUALLY apply: the server's ask, clamped by {@link McpSamplingOptions.maxTokens}. */
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  /** MCP's model hints, forwarded unread — the configured model always wins. */
  modelPreferences?: Record<string, unknown>;
}

/**
 * Serve `sampling/createMessage` with our own model: the server writes the
 * prompt, WE pay for the tokens. Treat it as capability delegation, not a
 * callback — `approve` is the gate for a server you do not fully trust.
 */
export interface McpSamplingOptions {
  /** The model the server gets to drive. */
  model: LanguageModel;
  /** Ceiling over the server's `maxTokens`; a request can only lower it, never raise it. */
  maxTokens?: number;
  /**
   * HITL gate, awaited BEFORE the model is called. Returning `false` — or
   * throwing — refuses the request; the SDK turns either into a JSON-RPC error
   * back to the server, so a refusal costs nothing and is visible upstream.
   */
  approve?: (req: McpSamplingRequest) => boolean | Promise<boolean>;
}

/** The `sampling/createMessage` result, in MCP's shape (always one text block). */
export interface McpSamplingResult {
  role: 'assistant';
  content: { type: 'text'; text: string };
  model: string;
  stopReason: McpStopReason;
}

export type McpStopReason = 'endTurn' | 'maxTokens' | 'stopSequence';

/** Spec-required, but a sloppy server may omit it — never sample unbounded. */
const DEFAULT_SAMPLING_MAX_TOKENS = 1024;

/**
 * Canonical `FinishReason` → MCP `stopReason`. MCP names three outcomes, so
 * everything else (`tool_calls`, `content_filter`, `error`, `aborted`) reports
 * as `endTurn` — the honest floor, since MCP has no vocabulary for them and a
 * hard failure already surfaced as a thrown handler. `stop_sequence` is not one
 * of our finish reasons TODAY (Anthropic's maps to `stop`); it is mapped so a
 * future adapter that keeps the distinction does not silently lose it here.
 */
export function mcpStopReason(finishReason: string): McpStopReason {
  switch (finishReason) {
    case 'length':
      return 'maxTokens';
    case 'stop_sequence':
      return 'stopSequence';
    default:
      return 'endTurn';
  }
}

/** One MCP content block → one canonical part. Anything not an image degrades to its text. */
function samplingContentToPart(content: McpSamplingMessage['content']): TextPart | ImagePart {
  if (content.type === 'image' && typeof content.data === 'string') {
    return {
      type: 'image',
      // MCP ships base64 — the exact form `ImagePart.image` already accepts.
      image: content.data,
      ...(content.mimeType ? { mediaType: content.mimeType } : {}),
    };
  }
  return { type: 'text', text: typeof content.text === 'string' ? content.text : '' };
}

/** MCP sampling messages → canonical `Message[]` (one part per message). */
export function samplingMessagesToCanonical(messages: McpSamplingMessage[]): Message[] {
  return messages.map((m) => ({
    // MCP allows user/assistant only; anything else is a malformed request we
    // read as a user turn rather than reject (the model still sees the text).
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [samplingContentToPart(m.content)],
  }));
}

/**
 * Adapt {@link McpSamplingOptions} to the SDK's request-handler shape. Register
 * it with `CreateMessageRequestSchema`.
 */
export function buildSamplingHandler(
  opts: McpSamplingOptions,
): (req: { params: Record<string, unknown> }) => Promise<McpSamplingResult> {
  return async (req) => {
    const p = req.params as {
      messages?: McpSamplingMessage[];
      systemPrompt?: unknown;
      maxTokens?: unknown;
      temperature?: unknown;
      stopSequences?: unknown;
      modelPreferences?: unknown;
    };
    const asked =
      typeof p.maxTokens === 'number'
        ? p.maxTokens
        : (opts.maxTokens ?? DEFAULT_SAMPLING_MAX_TOKENS);
    const request: McpSamplingRequest = {
      messages: samplingMessagesToCanonical(p.messages ?? []),
      ...(typeof p.systemPrompt === 'string' ? { systemPrompt: p.systemPrompt } : {}),
      maxTokens: Math.min(asked, opts.maxTokens ?? asked),
      ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
      ...(Array.isArray(p.stopSequences) ? { stopSequences: p.stopSequences as string[] } : {}),
      ...(p.modelPreferences
        ? { modelPreferences: p.modelPreferences as Record<string, unknown> }
        : {}),
    };
    // The gate runs FIRST, so a refused request never reaches the provider. A
    // throwing `approve` propagates verbatim — its message is more useful to the
    // server than one we would invent for it.
    if (opts.approve && !(await opts.approve(request))) {
      throw new InvalidRequestError({
        message: 'The MCP sampling request was declined by the client.',
      });
    }
    const result = await generateText({
      model: opts.model,
      messages: request.messages,
      ...(request.systemPrompt ? { instructions: request.systemPrompt } : {}),
      maxOutputTokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
    });
    return {
      role: 'assistant',
      content: { type: 'text', text: result.text },
      model: opts.model.modelId,
      stopReason: mcpStopReason(result.finishReason),
    };
  };
}

/** Roots as configured: a fixed list, or a function re-read on every `roots/list`. */
export type McpRootsOption = string[] | (() => string[] | Promise<string[]>);

/**
 * Mutable holder for the configured roots. `setRoots` swaps the value the
 * REGISTERED handler reads, so the handler is installed once (before connect)
 * and a reconnect re-registers it unchanged.
 */
export interface McpRootsBox {
  value: McpRootsOption;
}

export function createRootsBox(roots: McpRootsOption): McpRootsBox {
  return { value: roots };
}

/**
 * A root as MCP wants it: a URI. Anything already carrying a scheme (`://`)
 * passes VERBATIM; a plain filesystem path is promoted to `file://` with its
 * backslashes normalized, because a Windows path is not a URI at all.
 */
export function normalizeRootUri(root: string): string {
  return root.includes('://') ? root : `file://${root.replace(/\\/g, '/')}`;
}

/**
 * Adapt a roots box to the SDK's request-handler shape. Register it with
 * `ListRootsRequestSchema`. The box is re-read on EVERY request, so both
 * `setRoots` and a function-form option take effect without re-registering.
 */
export function buildRootsHandler(
  box: McpRootsBox,
): () => Promise<{ roots: Array<{ uri: string }> }> {
  return async () => {
    const list = typeof box.value === 'function' ? await box.value() : box.value;
    return { roots: list.map((root) => ({ uri: normalizeRootUri(root) })) };
  };
}

/** {@link McpClient} plus roots control — what both transports return. */
export interface McpRootsClient extends McpClient {
  /**
   * Replace the roots and tell the server (`notifications/roots/list_changed`).
   * Available only on a client created WITH a `roots` option: the capability is
   * declared at construction, and announcing a change to something we never
   * advertised would lie to the server.
   */
  setRoots(roots: string[]): Promise<void>;
}

/**
 * Attach `setRoots` to a wrapped client. `box` is absent when no `roots` were
 * configured, which is what makes the call a hard error rather than a silent
 * no-op. With a `managed` connection the notification follows the CURRENT
 * session, so it survives a reconnect.
 */
export function attachRoots(
  client: McpClient,
  raw: RawMcpClient,
  box?: McpRootsBox,
  managed?: ManagedMcp,
): McpRootsClient {
  return {
    ...client,
    async setRoots(roots) {
      if (!box) {
        throw new InvalidRequestError({
          message:
            'setRoots() needs a `roots` option at client creation — the roots capability is declared only when one is configured.',
        });
      }
      box.value = roots;
      const c = managed?.raw() ?? raw;
      await requireMethod(c.sendRootsListChanged, 'sendRootsListChanged').call(c);
    },
  };
}
