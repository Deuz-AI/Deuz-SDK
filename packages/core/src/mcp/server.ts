/**
 * `@deuz-sdk/core/mcp/server` (2.3) — serve Deuz tools over MCP.
 *
 * ```ts
 * import { createMcpServer } from '@deuz-sdk/core/mcp/server';
 *
 * const server = createMcpServer({ name: 'weather', version: '1.0.0', tools: { forecast } });
 * export default { fetch: server.fetch }; // Workers, Deno, Bun, a Next.js route handler
 * ```
 *
 * One definition publishes a `ToolSet`, a native `AgentToolSet` (`agentTools`)
 * and whole agents (`agents`: `runAgent` behind a tool). It is built on the v2
 * MCP SDK (`@modelcontextprotocol/server`, an optional peer imported lazily),
 * so the same endpoint speaks MCP 2026-07-28 to a negotiating client and, by
 * default, serves 2025-era clients through the SDK's stateless fallback.
 * `fetch` is the fetch-native Streamable HTTP face; the Node-only stdio entry is
 * `@deuz-sdk/core/mcp/server/stdio`, which serves the very same handle.
 *
 * A served call runs the pipeline a loop call runs, in the loop's order:
 *
 * 1. the SDK checks the arguments against the advertised schema (a Standard
 *    Schema is listed as its JSON Schema and checked by itself);
 * 2. `guardrails.onToolCall` — `block` answers the loop's denial, `rewrite`
 *    swaps the arguments;
 * 3. the approval gate for a tool whose `needsApproval` holds — a server-side
 *    `approve` callback, or by default an elicitation the client's user answers;
 *    a call nobody can approve is DENIED, never run;
 * 4. argument validation exactly as the loop does it (a Standard Schema's
 *    transform applies once, here);
 * 5. `execute` — a throw becomes an `isError` result carrying its message, the
 *    loop's self-heal;
 * 6. `guardrails.onToolResult`, for results `execute` produced;
 * 7. the value becomes a `CallToolResult`: a string is a text block, a plain
 *    object is `structuredContent` plus its JSON text (so a Deuz client gets the
 *    object back), anything else is JSON text.
 *
 * **The served `toolCallId`** (2.5) names one call, because tools key
 * idempotent writes on it (the versioned memory tools derive their operation
 * id from it). A JSON-RPC id alone cannot: every connection restarts its ids,
 * so a second client's request 1 would replay the first client's. The id is
 * `mcp-<unit>-<request id>`, where `<unit>` is a fresh `generateId()` per
 * serving unit:
 *
 * - over HTTP (2026-07-28, and the stateless fallback for 2025-era clients)
 *   the unit is ONE HTTP request: each request stands alone, nothing on the
 *   wire ties a retried POST to the first one, so every request is a new call;
 * - over stdio the unit is the connection: MCP forbids reusing a request id
 *   within a session, so a request id resent on the same connection is the
 *   same request and keeps its `toolCallId` (an idempotent tool replays it),
 *   while a new connection is a new unit.
 *
 * Unrelated calls therefore never share an id; before 2.5 it was
 * `mcp-<request id>`. A 2026-07-28 approval round trip is two requests, but
 * the tool runs only in the second, so its effects are keyed once.
 *
 * Since 2.5 the server also publishes **resources** (`resources`, plus URI
 * templates in `resourceTemplates`) and **prompts** (`prompts`), and its
 * catalog is mutable: `server.catalog` adds, replaces and removes tools,
 * resources and prompts at runtime and announces the change with the matching
 * `notifications/{tools,resources,prompts}/list_changed`; `resourceUpdated(uri)`
 * sends `notifications/resources/updated` to subscribers. A resource read, a
 * template listing and a prompt `get` see the same per-request identity a tool
 * call sees (`request.authInfo`, `runtimeContext`), so a host can scope them to
 * a tenant, and a `resources/updated` notification reaches a subscriber only
 * when `read` would answer that subscriber (see `resourceUpdated`). Template
 * variables reach `read` percent-decoded and checked against their RFC 6570
 * operator (see `rawVariables`). Where a change notification can reach a client:
 *
 * - MCP 2026-07-28 over HTTP: through a `subscriptions/listen` stream the
 *   client opens (the SDK's handler bus — `eventBus` shares it across
 *   processes);
 * - MCP 2026-07-28 over stdio: through `subscriptions/listen` on the pinned
 *   connection;
 * - a 2025-era stdio session: pushed as unsolicited notifications, and
 *   `resources/subscribe` / `resources/unsubscribe` are served;
 * - a 2025-era client over **stateless HTTP: never** — each request is served
 *   by a fresh instance with no session and no stream to push on (GET is 405).
 *   Such a client sees a change the next time it lists, and is not offered
 *   `resources.subscribe`.
 *
 * **Tasks** (2.5, opt-in): a served agent with `task: true`, or a name in
 * `tasks.tools`, may answer `tools/call` with an MCP task handle and keep
 * running in the background; the client polls `tasks/get`, fetches the result
 * and can cancel, which aborts the run. Guardrails and the approval gate run
 * inside the call before the task exists, so a task behaves like a plain call.
 * MCP 2026-07-28 speaks the Tasks extension (`io.modelcontextprotocol/tasks`),
 * a 2025-era client the 2025-11-25 core tasks; the wire formats, identity
 * rules, retention, notifications per transport and the SDK's limits are in
 * `./tasks.ts` (see {@link McpServerTasksOptions}). A server without `tasks`
 * and without a task-enabled agent advertises and serves exactly what it did
 * before.
 *
 * Edge-safe: Web APIs only, the peer is a computed specifier, and the heavy
 * native modules (`agent-run`, `inference/agent-tools`) load only when an
 * `agents`/`agentTools` entry is configured.
 */
import { InvalidRequestError } from '../errors';
import { isStandardSchema, toJSONSchema, validateOutput } from '../schema/bridge';
import { combineSignals } from '../core/timeout';
import { resolveDependencies } from '../internal/resolve-deps';
import { uint8ToBase64 } from '../internal/image';
import type { Clock } from '../types/deps';
import type { JSONSchema, StandardSchemaV1 } from '../types/schema';
import type { Tool, ToolCall, ToolExecuteContext, ToolSet } from '../types/tool';
import type { AgentResult, AgentRunOptions, AgentToolSet } from '../types/agent-run';
import type {
  Guardrails,
  ToolCallGuardrail,
  ToolCallGuardrailResult,
  ToolResultGuardrail,
  ToolResultGuardrailResult,
} from '../types/guardrails';
import {
  MCP_SERVER_INTERNALS,
  type McpServerEra,
  type McpServerInternals,
  type McpServerTransportKind,
} from './server-internals';
import {
  createInMemoryMcpTaskStore,
  createTaskResult,
  createTaskRuntime,
  declaresTasksExtension,
  liftedTaskRequest,
  liftLegacyTaskParam,
  MCP_TASKS_EXTENSION,
  type McpServerTasksOptions,
  type TaskHandlerContext,
  type TaskHandlerHost,
  type TaskRuntime,
} from './tasks';

export {
  createInMemoryMcpTaskStore,
  MCP_TASKS_EXTENSION,
  type InMemoryMcpTaskStoreOptions,
  type McpServerTasksOptions,
  type McpTaskError,
  type McpTaskPage,
  type McpTaskRecord,
  type McpTaskStatus,
  type McpTaskStore,
  type McpTaskUpdate,
} from './tasks';

// --- Public types --------------------------------------------------------------

/**
 * A caller's verified identity — a structural mirror of the SDK's `AuthInfo`.
 * Deuz never derives it from request headers: the host verifies the token (for
 * example with the SDK's `requireBearerAuth`) and passes the result to
 * `fetch(request, { authInfo })`.
 */
export interface McpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  /** Expiry in seconds since the epoch. */
  expiresAt?: number;
  /** The RFC 8707 resource the token was issued for. */
  resource?: URL;
  resourceMetadataUrl?: string;
  extra?: Record<string, unknown>;
}

/**
 * Where a served call came from — what `runtimeContext`, `toolsContext`,
 * `approve`, and (2.5) every resource read, template listing and prompt `get` see.
 */
export interface McpServerRequest {
  /** `'http'` for `fetch`, `'stdio'` for the stdio entry. */
  transport: McpServerTransportKind;
  /** `'modern'` for MCP 2026-07-28 traffic, `'legacy'` for a 2025-era client. */
  era: McpServerEra;
  /** Whatever the host passed to `fetch(request, { authInfo })`. HTTP only. */
  authInfo?: McpAuthInfo;
  /** The HTTP request being served. HTTP only. */
  request?: Request;
}

/** One call waiting for a server-side verdict — see {@link McpServerOptions.approve}. */
export interface McpToolApprovalRequest {
  toolName: string;
  /** The arguments that will run — after any `onToolCall` rewrite. */
  args: unknown;
  request: McpServerRequest;
}

/** MCP tool annotations: hints a client may use to decide how to present or gate a tool. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** `runAgent` options minus the conversation: the caller's `prompt` becomes the user turn. */
export type McpAgentRunOptions = Omit<AgentRunOptions<unknown>, 'messages' | 'prompt'>;

/**
 * An agent published as a tool taking `{ prompt }`. Each call is one
 * `runAgent`; a completed run answers with its output (a structured output
 * comes back as the value), anything else is an error result naming why.
 */
export interface McpServedAgent {
  /** What the agent does — the tool description the client's model reads. */
  description: string;
  /**
   * The run options. The function form builds them per call — a fresh durable
   * `session` per call (a fixed `runId` would make concurrent calls collide), a
   * per-tenant model.
   */
  agent:
    | McpAgentRunOptions
    | ((
        input: { prompt: string },
        request: McpServerRequest,
      ) => McpAgentRunOptions | Promise<McpAgentRunOptions>);
  /** Gate the agent call itself, like a tool's `needsApproval`. */
  needsApproval?: boolean;
  /**
   * Run calls as MCP tasks (2.5) when the client supports them: the call
   * answers a task handle once approved, and the run continues in the
   * background — see {@link McpServerOptions.tasks}. Default `false`.
   */
  task?: boolean;
}

// --- Resources and prompts (2.5) ----------------------------------------------------

/**
 * What a resource read, a template listing or a prompt `get` runs with: the
 * same per-request identity a served tool call gets.
 */
export interface McpServedContext {
  /** Where the request came from — `request.authInfo` is the host-verified caller. */
  request: McpServerRequest;
  /** {@link McpServerOptions.runtimeContext}, evaluated for this request. Absent when not configured. */
  runtimeContext?: unknown;
  /** Aborts when the client cancels or the transport goes away. */
  signal: AbortSignal;
}

/** The context of one `resources/read`. */
export interface McpResourceReadContext extends McpServedContext {
  /** The URI being read, parsed. */
  uri: URL;
  /**
   * The URI template's variables for a template read (a `{+path*}`-style
   * explode yields an array). `{}` for a static resource. Percent-decoded and
   * checked against the variable's RFC 6570 operator before `read` runs (see
   * {@link McpServedResourceTemplate.rawVariables}); as matched, unchecked,
   * when the template sets `rawVariables`.
   */
  variables: Record<string, string | string[]>;
}

/** One block of resource contents: text, or binary as bytes (or a base64 string). */
export type McpResourceContent =
  | {
      text: string;
      /** Default: the URI being read. A directory-like read may name each entry. */
      uri?: string;
      /** Default: the resource's declared `mimeType`. */
      mimeType?: string;
    }
  | {
      /** Bytes, or a string that is ALREADY base64 — it is sent as is. */
      blob: Uint8Array | string;
      uri?: string;
      /** Default: the resource's declared `mimeType`, else `application/octet-stream`. */
      mimeType?: string;
    };

/**
 * What a `read` returns. A string is one text block; a `Uint8Array` one binary
 * block; an array several blocks (a directory, a multi-part document).
 * `null`/`undefined` answers the SDK's resource-not-found error (`InvalidParams`
 * with `data.uri`, "Resource not found: …") — the right answer when a template matched
 * but the entity does not exist, or is not this tenant's to see.
 */
export type McpResourceReadResult =
  | string
  | Uint8Array
  | McpResourceContent
  | McpResourceContent[]
  | null
  | undefined;

/** Metadata shared by a static resource and a URI template. */
export interface McpResourceMetadata {
  /** Display name. */
  title?: string;
  /** What the resource holds — the client's model may read this. */
  description?: string;
  /** The contents' media type; the default `mimeType` of every block a read returns. */
  mimeType?: string;
  /** MCP resource annotations: who the resource is for, how important, when it last changed. */
  annotations?: {
    audience?: Array<'user' | 'assistant'>;
    priority?: number;
    lastModified?: string;
  };
  /**
   * MCP 2026-07-28 result caching for `resources/read` (`ttlMs`,
   * `cacheScope`). The SDK default is `{ ttlMs: 0, cacheScope: 'private' }` —
   * keep `'private'` for anything scoped to a caller. Ignored by 2025-era clients.
   */
  cacheHint?: { ttlMs?: number; cacheScope?: 'public' | 'private' };
}

/** A resource at one fixed URI — see {@link McpServerOptions.resources}. */
export interface McpServedResource extends McpResourceMetadata {
  /** The resource's URI (any scheme: `file:`, `https:`, `config://app`). Normalized with `new URL`. */
  uri: string;
  /** Size in bytes, when known — clients use it to show sizes and budget context. */
  size?: number;
  /** Read it. Throw to fail the read with your message; return `null` for not-found. */
  read(context: McpResourceReadContext): McpResourceReadResult | Promise<McpResourceReadResult>;
}

/** One concrete resource a template enumerates in `resources/list`. */
export interface McpListedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** A family of resources behind an RFC 6570 URI template — see {@link McpServerOptions.resourceTemplates}. */
export interface McpServedResourceTemplate extends McpResourceMetadata {
  /** An RFC 6570 URI template, e.g. `notes://{tenant}/{id}`. Checked by `ready()`. */
  uriTemplate: string;
  /** Read the URI the client asked for; `context.variables` holds the matched variables. */
  read(context: McpResourceReadContext): McpResourceReadResult | Promise<McpResourceReadResult>;
  /**
   * Hand `read` the variables exactly as the SDK's `UriTemplate` matched them:
   * percent-encoded and unchecked. Default `false`: each variable is
   * percent-decoded and must stay inside what its RFC 6570 operator expands
   * to, else the read answers resource-not-found and `read` never runs:
   *
   * - `{x}`, `{.x}`, `{/x}` expand to ONE segment: no `/`, `\`, `?` or `#`
   *   (literal or percent-encoded), and not `.` or `..`;
   * - `{+x}` (reserved) may span `/` but not the URI's query or fragment (no
   *   literal `?` or `#`);
   * - `{#x}` (fragment) may hold `/` and `?`, not a second `#`;
   * - `{?x}`, `{&x}` (query) hold one value: no literal `?` or `#`.
   *
   * Every operator also refuses a `.`/`..` path segment, a control character
   * (C0, DEL, C1) and invalid percent-encoding (a stray `%`, bytes that are
   * not UTF-8). Set `true` only to validate the raw values yourself.
   */
  rawVariables?: boolean;
  /**
   * Enumerate concrete resources for `resources/list` — per request, so a
   * tenant lists only its own. Omitted: the template is listed only in
   * `resources/templates/list`.
   */
  list?(context: McpServedContext): McpListedResource[] | Promise<McpListedResource[]>;
  /**
   * Autocomplete for template variables (`completion/complete`). The SDK does
   * not hand completion callbacks the request, so these see no identity —
   * never complete from tenant-private data here.
   */
  complete?: Record<
    string,
    (value: string, context: { arguments: Record<string, string> }) => string[] | Promise<string[]>
  >;
}

/** One declared prompt argument. MCP prompt arguments are strings. */
export interface McpPromptArgument {
  description?: string;
  /** Default `false`. A `get` missing a required argument is rejected before `get` runs. */
  required?: boolean;
}

/** A content block of a prompt message. A string is shorthand for a text block. */
export type McpPromptContent =
  | string
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: Uint8Array | string; mimeType: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType?: string } & (
        | { text: string }
        | { blob: Uint8Array | string }
      );
    };

/** One message of a prompt. */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpPromptContent;
}

/**
 * What a prompt's `get` returns: a string (one user text message), the
 * messages, or the messages with a description.
 */
export type McpPromptResult =
  | string
  | McpPromptMessage[]
  | { description?: string; messages: McpPromptMessage[] };

/** A prompt template — see {@link McpServerOptions.prompts}. */
export interface McpServedPrompt {
  title?: string;
  description?: string;
  /**
   * The declared arguments, listed in `prompts/list`. A `prompts/get` is
   * rejected with `InvalidParams` (and `get` never runs) when it names an
   * argument not declared here, passes a non-string value, or misses a
   * required one.
   */
  arguments?: Record<string, McpPromptArgument>;
  /**
   * Optional further validation of the arguments record (an enum, a pattern)
   * with any Standard Schema. Validation only: its issues reject the `get`;
   * `get` still receives the strings as sent.
   */
  schema?: StandardSchemaV1;
  /** Build the prompt. Throw to fail the `get` with your message. */
  get(
    args: Record<string, string>,
    context: McpServedContext,
  ): McpPromptResult | Promise<McpPromptResult>;
}

/** A change event on the server's notification bus (the SDK's `ServerEvent`, mirrored). */
export type McpServerEvent =
  | { kind: 'tools_list_changed' }
  | { kind: 'prompts_list_changed' }
  | { kind: 'resources_list_changed' }
  | { kind: 'resource_updated'; uri: string };

/**
 * The bus `subscriptions/listen` streams over HTTP subscribe to (the SDK's
 * `ServerEventBus`, mirrored structurally). The default is in-process; a
 * multi-process deployment implements it over its own pub/sub so a
 * `resourceUpdated` in one process reaches listeners connected to another.
 */
export interface McpServerEventBus {
  publish(event: McpServerEvent): void;
  /** Register a listener; returns an idempotent unsubscribe. */
  subscribe(listener: (event: McpServerEvent) => void): () => void;
}

/**
 * The server's mutable catalog (2.5) — `server.catalog`. Every change is
 * applied in call order, prepared like a construction-time entry (a broken
 * definition rejects and changes nothing), served to every request from then
 * on, and announced with the matching `list_changed` notification wherever the
 * client can receive one (see the module header — never to a 2025-era client
 * over stateless HTTP).
 *
 * A live stdio session only learns of resources or prompts when the server
 * advertised that capability at its handshake: a server built with neither
 * `resources`/`resourceTemplates` nor `prompts` does not advertise them, so to
 * add them later pass an empty record (`resources: {}`, `prompts: {}`) at
 * construction. HTTP requests always see the current catalog.
 */
export interface McpServerCatalog {
  /**
   * Publish (or replace) a tool. Replaces any served tool of that name — a
   * `tools`, `agentTools` or `agents` entry alike. `annotations` default to
   * `toolAnnotations[name]`.
   */
  setTool(name: string, tool: Tool, annotations?: McpToolAnnotations): Promise<void>;
  /** Publish (or replace) an agent as a `{ prompt }` tool — see {@link McpServedAgent}. */
  setAgent(name: string, agent: McpServedAgent, annotations?: McpToolAnnotations): Promise<void>;
  /** Stop serving a tool of any kind. Resolves `false` when none was served under `name`. */
  removeTool(name: string): Promise<boolean>;
  /** Publish (or replace) a static resource. Rejects when another resource already serves its URI. */
  setResource(name: string, resource: McpServedResource): Promise<void>;
  removeResource(name: string): Promise<boolean>;
  /** Publish (or replace) a URI template. */
  setResourceTemplate(name: string, template: McpServedResourceTemplate): Promise<void>;
  removeResourceTemplate(name: string): Promise<boolean>;
  /** Publish (or replace) a prompt. */
  setPrompt(name: string, prompt: McpServedPrompt): Promise<void>;
  removePrompt(name: string): Promise<boolean>;
  /**
   * Tell subscribers the resource at `uri` changed
   * (`notifications/resources/updated`): 2026-07-28 listeners whose filter
   * names the URI, and 2025-era stdio sessions that `resources/subscribe`d to
   * it. Nothing else is notified; no subscriber is not an error. A `uri` that
   * normalizes differently (`https://example.com` is listed as
   * `https://example.com/`) is announced in both forms. A 2025-era stdio
   * session holds at most 10 000 subscriptions; one more is refused.
   *
   * Delivery follows the `resources/read` rule: before a subscriber gets the
   * notification, the resource's `read` runs with that subscriber's identity
   * (`request.authInfo`, `runtimeContext`), and a `null`, a throw or a URI no
   * resource serves drops it for that subscriber. Over HTTP the check runs on
   * each listen stream that would carry the update; over stdio, once per
   * connection and update. Keep `read` cheap or cached when updates are
   * frequent. Resolves once every stdio delivery is decided.
   */
  resourceUpdated(uri: string): Promise<void>;
}

export interface McpServerOptions {
  /** The server's name in the handshake (`serverInfo.name`). */
  name: string;
  /** Default `'0.0.0'`. */
  version?: string;
  /** How to use this server — MCP `instructions`, shown to the client's model. */
  instructions?: string;
  /**
   * Tools to publish. Every entry needs an `execute`: a client tool (none) or a
   * provider-executed tool has nothing to run here and is rejected.
   */
  tools?: ToolSet;
  /**
   * A native `AgentToolSet` (2.1), served with native semantics: the tool
   * context is validated, the result is validated against `outputSchema` /
   * `validateResult`, and the client receives the `toModelOutput` projection.
   */
  agentTools?: AgentToolSet;
  /**
   * Per-tool context for `agentTools` (`runAgent`'s `toolsContext`). The function
   * form is evaluated per call — derive a tenant from `request.authInfo`.
   */
  toolsContext?:
    | Record<string, unknown>
    | ((request: McpServerRequest) => Record<string, unknown> | Promise<Record<string, unknown>>);
  /** Agents to publish as tools — see {@link McpServedAgent}. */
  agents?: Record<string, McpServedAgent>;
  /**
   * Static resources to publish (2.5), keyed by name. Every URI must be
   * unique. Passing the option at all — even `{}` — advertises the `resources`
   * capability, so resources can be added later through `catalog`.
   */
  resources?: Record<string, McpServedResource>;
  /** URI-template resources to publish (2.5), keyed by name. Advertises `resources` like {@link resources}. */
  resourceTemplates?: Record<string, McpServedResourceTemplate>;
  /**
   * Prompts to publish (2.5), keyed by name. Passing the option at all — even
   * `{}` — advertises the `prompts` capability.
   */
  prompts?: Record<string, McpServedPrompt>;
  /**
   * The change-event bus behind HTTP `subscriptions/listen` streams (2.5).
   * Default: in-process. Share one across processes so `catalog` changes and
   * `resourceUpdated` reach listeners connected to another process. stdio
   * sessions are per-process and do not use it.
   */
  eventBus?: McpServerEventBus;
  /** Most `subscriptions/listen` streams open at once on the HTTP face (SDK default 1024). */
  maxSubscriptions?: number;
  /** MCP tool annotations by tool name. A name that is not served is rejected. */
  toolAnnotations?: Record<string, McpToolAnnotations>;
  /**
   * MCP tasks (2.5): which served tools run as tasks, and where tasks live.
   * Passing it at all — even `{}` — advertises task support (2026-07-28: the
   * `io.modelcontextprotocol/tasks` extension; 2025-11-25: `capabilities.tasks`),
   * as does an agent with `task: true`. Opt-in per tool: a tool not named in
   * `tasks.tools` (and an agent without `task: true`) always answers plainly.
   * The protocol details and limits are in the `McpServerTasksOptions` docs and
   * the `tasks` module header.
   */
  tasks?: McpServerTasksOptions;
  /**
   * Who approves a call whose `needsApproval` holds:
   *
   * - a function — a server-side verdict, the counterpart of the loop's
   *   `approveToolCall`. `false` (or a throw) denies.
   * - `'elicit'` (the default) — the client's user, through an MCP elicitation
   *   (a yes/no form). The verdict is the CLIENT's: use a function when the
   *   server must not take a client's word for it. A client that declared no
   *   form elicitation — and every 2025-era request over stateless HTTP, which
   *   has no session to ask on — is denied.
   */
  approve?: 'elicit' | ((request: McpToolApprovalRequest) => boolean | Promise<boolean>);
  /** The loop's tool guardrails, applied to every served call (same types, same verdicts). */
  guardrails?: Pick<Guardrails, 'onToolCall' | 'onToolResult'>;
  /**
   * Build the call's `runtimeContext` (2.0) — handed to `execute`, the
   * guardrails and every agent run. Evaluated per call.
   */
  runtimeContext?: (request: McpServerRequest) => unknown;
  /**
   * 2025-era HTTP traffic: `'stateless'` (the default) serves it through the
   * SDK's stateless fallback; `'reject'` makes a 2026-07-28-only endpoint.
   */
  legacy?: 'stateless' | 'reject';
  /**
   * Response shaping for 2026-07-28 exchanges: `'auto'` (default) answers JSON
   * and upgrades to SSE when a call streams; `'sse'` always streams; `'json'`
   * never does.
   */
  responseMode?: 'auto' | 'sse' | 'json';
  /** Largest POST body the handler reads, in bytes. SDK default 4 MiB. */
  maxRequestBodySize?: number;
  /**
   * Out-of-band failures: a request the SDK rejected, a missing peer, an
   * `approve` callback that threw (the call is denied). Reporting only — it
   * never changes a response. A throwing callback is swallowed.
   */
  onError?: (error: Error) => void;
  /** Time source for `Tool.timeoutMs`. Default: the host clock. */
  clock?: Clock;
  /**
   * Randomness seam (2.5): names each serving unit (one HTTP request, one
   * stdio connection), which qualifies the `toolCallId` a served call carries
   * (the rule is in the module header). It must return a new, unique id every
   * call. Default: `crypto.randomUUID()`.
   */
  generateId?: () => string;
}

/** The per-request inputs of {@link DeuzMcpServer.fetch}. */
export interface McpServerFetchOptions {
  /** The caller's VERIFIED identity — passed through to `runtimeContext`, `toolsContext` and `approve`. */
  authInfo?: McpAuthInfo;
  /** A body a framework already parsed (Express `req.body`), so the handler does not read it again. */
  parsedBody?: unknown;
}

/** A Deuz MCP server: one definition, served over HTTP here and over stdio by `./mcp/server/stdio`. */
export interface DeuzMcpServer {
  /**
   * Serve one Streamable HTTP request — the `fetch(request)` shape Workers, Deno,
   * Bun and route handlers expect. Bound: it can be detached. Put Origin/Host
   * validation and authentication in front of it; the handler does neither.
   */
  readonly fetch: (request: Request, options?: McpServerFetchOptions) => Promise<Response>;
  /**
   * Load the SDK and prepare every tool now, so a missing peer or a schema that
   * cannot be listed fails at startup instead of on the first request.
   */
  ready(): Promise<void>;
  /** Abort in-flight 2026-07-28 exchanges and release them. Idempotent. */
  close(): Promise<void>;
  /**
   * The mutable catalog (2.5): add, replace and remove tools, resources and
   * prompts at runtime, with `list_changed` notifications — see {@link McpServerCatalog}.
   */
  readonly catalog: McpServerCatalog;
}

// --- The v2 SDK, mirrored structurally (its types must never reach our .d.ts) --

const V2_SERVER_PACKAGE = '@modelcontextprotocol/server';

const NO_V2_SERVER_MESSAGE =
  'The Deuz MCP server needs the optional peer "@modelcontextprotocol/server" (MCP 2026-07-28). Install it: npm i @modelcontextprotocol/server';

/** `ctx.mcpReq.envelope` key carrying a 2026-07-28 request's client capabilities. */
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

interface V2ToolContext {
  mcpReq: {
    id: string | number;
    signal: AbortSignal;
    _meta?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
  };
  http?: { authInfo?: McpAuthInfo; req?: Request };
}

interface V2CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** What every `register*` returns: removing it sends the matching `list_changed` when connected. */
interface V2Registered {
  remove(): void;
}

interface V2McpServer {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    callback: (args: unknown, ctx: V2ToolContext) => Promise<unknown>,
  ): V2Registered;
  /** A string URI registers a static resource; a `ResourceTemplate` a template. */
  registerResource(
    name: string,
    uriOrTemplate: unknown,
    config: Record<string, unknown>,
    callback: (...args: never[]) => Promise<unknown>,
  ): V2Registered;
  registerPrompt(
    name: string,
    config: Record<string, unknown>,
    callback: (args: unknown, ctx: V2ToolContext) => Promise<unknown>,
  ): V2Registered;
  readonly server: {
    getClientCapabilities?(): Record<string, unknown> | undefined;
    getCapabilities(): Record<string, unknown>;
    setRequestHandler(
      method: string,
      handler: (request: { params?: Record<string, unknown> }) => unknown,
    ): void;
    sendResourceUpdated(params: { uri: string }): Promise<void>;
    notification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
    onclose?: () => void;
  };
}

interface V2HttpHandler {
  fetch(request: Request, options?: McpServerFetchOptions): Promise<Response>;
  close(): Promise<void>;
  notify: {
    toolsChanged(): void;
    promptsChanged(): void;
    resourcesChanged(): void;
    resourceUpdated(uri: string): void;
  };
}

type V2CompleteCallback = (
  value: string,
  context?: { arguments?: Record<string, string> },
) => Promise<string[]>;

interface V2InputResponseView {
  kind: string;
  action?: string;
  content?: Record<string, unknown>;
}

interface V2ServerModule {
  McpServer: new (
    info: { name: string; version: string },
    options?: Record<string, unknown>,
  ) => V2McpServer;
  createMcpHandler(
    factory: (ctx: { era: McpServerEra }) => Promise<V2McpServer>,
    options?: Record<string, unknown>,
  ): V2HttpHandler;
  fromJsonSchema(schema: Record<string, unknown>): unknown;
  inputRequired: ((spec: { inputRequests: Record<string, unknown> }) => unknown) & {
    elicit(params: { message: string; requestedSchema: Record<string, unknown> }): unknown;
  };
  inputResponse(responses: Record<string, unknown> | undefined, key: string): V2InputResponseView;
  ResourceTemplate: new (
    uriTemplate: string,
    callbacks: {
      list: ((ctx: V2ToolContext) => Promise<unknown>) | undefined;
      complete?: Record<string, V2CompleteCallback>;
    },
  ) => unknown;
  ResourceNotFoundError: new (uri: string) => Error;
  /** The matcher `resources/read` resolves a template with — the same class, so a check agrees with a read. */
  UriTemplate: new (uriTemplate: string) => V2UriTemplate;
}

interface V2UriTemplate {
  match(uri: string): Record<string, string | string[]> | null;
}

async function loadV2Server(): Promise<V2ServerModule> {
  try {
    const spec: string = V2_SERVER_PACKAGE;
    return (await import(spec)) as V2ServerModule;
  } catch (err) {
    throw new InvalidRequestError({ message: NO_V2_SERVER_MESSAGE, cause: err });
  }
}

// --- Construction-time checks ------------------------------------------------------

function assertExecutable(name: string, tool: { type?: string; execute?: unknown }): void {
  if (tool.type === 'provider') {
    throw new InvalidRequestError({
      message: `MCP server tool '${name}' is provider-executed: the model provider runs it, so there is nothing for an MCP server to execute. Leave it out of the served tools.`,
    });
  }
  if (typeof tool.execute !== 'function') {
    throw new InvalidRequestError({
      message: `MCP server tool '${name}' has no execute — a client tool runs in the caller's UI, not on a server. Give it an execute or leave it out of the served tools.`,
    });
  }
}

/**
 * A static resource's URI as the SDK looks it up: `resources/read` parses the
 * requested URI and keys on `new URL(uri).toString()`, so registering the raw
 * string would make `https://Example.com` unreadable.
 */
function checkResource(name: string, def: McpServedResource): string {
  if (typeof def?.read !== 'function') {
    throw new InvalidRequestError({
      message: `MCP server resource '${name}' has no read function.`,
    });
  }
  try {
    return new URL(def.uri).href;
  } catch (err) {
    throw new InvalidRequestError({
      message: `MCP server resource '${name}' has an invalid uri '${String(def.uri)}': a resource URI must be an absolute URI (scheme:...).`,
      cause: err,
    });
  }
}

function checkTemplate(name: string, def: McpServedResourceTemplate): void {
  if (typeof def?.read !== 'function' || typeof def.uriTemplate !== 'string') {
    throw new InvalidRequestError({
      message: `MCP server resource template '${name}' needs a uriTemplate string and a read function.`,
    });
  }
}

function checkPrompt(name: string, def: McpServedPrompt): void {
  if (typeof def?.get !== 'function') {
    throw new InvalidRequestError({ message: `MCP server prompt '${name}' has no get function.` });
  }
}

/** Reject what can never be served, while the stack still points at the definition. */
function assertServable(options: McpServerOptions): void {
  const seen = new Set<string>();
  const claim = (name: string): void => {
    if (seen.has(name)) {
      throw new InvalidRequestError({
        message: `MCP server tool '${name}' is defined more than once across tools, agentTools and agents — every served name must be unique.`,
      });
    }
    seen.add(name);
  };
  const executable = assertExecutable;
  const uris = new Map<string, string>();
  for (const [name, resource] of Object.entries(options.resources ?? {})) {
    const uri = checkResource(name, resource);
    const other = uris.get(uri);
    if (other !== undefined) {
      throw new InvalidRequestError({
        message: `MCP server resources '${other}' and '${name}' both serve '${uri}' — every resource URI must be unique.`,
      });
    }
    uris.set(uri, name);
  }
  for (const [name, template] of Object.entries(options.resourceTemplates ?? {})) {
    checkTemplate(name, template);
  }
  for (const [name, prompt] of Object.entries(options.prompts ?? {})) checkPrompt(name, prompt);
  for (const [name, tool] of Object.entries(options.tools ?? {})) {
    claim(name);
    executable(name, tool);
  }
  for (const [name, tool] of Object.entries(options.agentTools ?? {})) {
    claim(name);
    executable(name, tool);
  }
  for (const name of Object.keys(options.agents ?? {})) claim(name);
  for (const name of Object.keys(options.toolAnnotations ?? {})) {
    if (!seen.has(name)) {
      throw new InvalidRequestError({
        message: `toolAnnotations names '${name}', which this server does not serve.`,
      });
    }
  }
  const tasks = options.tasks;
  if (tasks === undefined) return;
  for (const name of tasks.tools ?? []) {
    if (!seen.has(name)) {
      throw new InvalidRequestError({
        message: `tasks.tools names '${name}', which this server does not serve.`,
      });
    }
  }
  const { ttlMs, pollIntervalMs } = tasks;
  if (ttlMs !== undefined && ttlMs !== null && !(Number.isInteger(ttlMs) && ttlMs > 0)) {
    throw new InvalidRequestError({
      message: `tasks.ttlMs must be a positive integer or null, got ${String(ttlMs)}.`,
    });
  }
  if (pollIntervalMs !== undefined && !(Number.isInteger(pollIntervalMs) && pollIntervalMs > 0)) {
    throw new InvalidRequestError({
      message: `tasks.pollIntervalMs must be a positive integer, got ${String(pollIntervalMs)}.`,
    });
  }
}

/** A task-enabled tool cannot declare an `outputSchema` — the SDK limit in `./tasks.ts`. */
function assertTaskable(name: string, hasOutputSchema: boolean): void {
  if (hasOutputSchema) {
    throw new InvalidRequestError({
      message: `MCP server tool '${name}' runs as a task and declares an outputSchema: the MCP SDK requires structuredContent on every successful tools/call result of such a tool, so it cannot hand out a task. Drop the outputSchema or serve the tool without tasks.`,
    });
  }
}

// --- Schemas ---------------------------------------------------------------------

/**
 * The JSON Schema a Standard Schema advertises in `tools/list`: its own
 * `~standard.jsonSchema` when the library implements it (zod 4.2+, ArkType,
 * valibot), else the optional `@standard-community/standard-json` peer.
 */
async function standardToJsonSchema(
  name: string,
  schema: StandardSchemaV1,
): Promise<Record<string, unknown>> {
  const converter = (
    schema['~standard'] as {
      jsonSchema?: { input?: (options: { target: string }) => Record<string, unknown> };
    }
  ).jsonSchema;
  if (typeof converter?.input === 'function') return converter.input({ target: 'draft-2020-12' });
  try {
    return (await toJSONSchema(schema)) as Record<string, unknown>;
  } catch (err) {
    throw new InvalidRequestError({
      message: `MCP server tool '${name}' has a Standard Schema, and tools/list advertises schemas as JSON Schema: install the optional peer "@standard-community/standard-json", use a schema library that implements ~standard.jsonSchema, or pass a raw JSON Schema.`,
      cause: err,
    });
  }
}

/**
 * The `inputSchema` handed to `registerTool`. A raw JSON Schema goes through the
 * SDK's own validator (AJV on Node, `@cfworker/json-schema` on workerd and
 * browsers). A Standard Schema is wrapped so the SDK only CHECKS it and passes
 * the arguments through untouched: its transform runs once, later, in the served
 * pipeline — where the loop runs it, after the guardrails.
 */
async function inputSchemaFor(
  sdk: V2ServerModule,
  name: string,
  parameters: StandardSchemaV1 | JSONSchema,
): Promise<unknown> {
  if (!isStandardSchema(parameters)) {
    return sdk.fromJsonSchema(parameters as Record<string, unknown>);
  }
  const json = await standardToJsonSchema(name, parameters);
  return {
    '~standard': {
      version: 1,
      vendor: 'deuz',
      validate: async (value: unknown) => {
        const result = await parameters['~standard'].validate(value);
        return result.issues ? result : { value };
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

// --- Results -----------------------------------------------------------------------

const TOOL_DENIED = 'Tool call denied.';

/**
 * The `toolCallId` of a served call: its JSON-RPC id qualified by its serving
 * unit, so two connections' (or two HTTP requests') equal ids never meet. A
 * string id is JSON-quoted so it never reads as the number of the same digits,
 * which JSON-RPC counts as a different id.
 */
function servedToolCallId(unit: { id: string }, requestId: string | number): string {
  return `mcp-${unit.id}-${typeof requestId === 'string' ? JSON.stringify(requestId) : String(requestId)}`;
}

function errorResult(text: string): V2CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * A tool's return value as a `CallToolResult` — the inverse of the client's
 * `extractContent`, so a Deuz client calling a Deuz server gets the value back.
 * With an advertised `outputSchema` the value is always `structuredContent`
 * (the SDK validates it, and wraps a non-object for 2025-era clients).
 */
function toCallToolResult(value: unknown, hasOutputSchema: boolean): V2CallToolResult {
  if (value === undefined) return { content: [] };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const structured = hasOutputSchema || isPlainObject(value);
  return {
    content: text === undefined ? [] : [{ type: 'text', text }],
    ...(structured ? { structuredContent: value } : {}),
  };
}

function resultText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

// --- Resource and prompt results (2.5) ------------------------------------------------

const OCTET_STREAM = 'application/octet-stream';

function base64Of(data: Uint8Array | string): string {
  return typeof data === 'string' ? data : uint8ToBase64(data);
}

/** One `McpResourceContent` (or shorthand) as a wire `TextResourceContents` / `BlobResourceContents`. */
function toResourceContents(
  item: unknown,
  uri: string,
  mimeType: string | undefined,
  what: string,
): Record<string, unknown> {
  if (typeof item === 'string') return { uri, text: item, ...(mimeType ? { mimeType } : {}) };
  if (item instanceof Uint8Array) {
    return { uri, blob: uint8ToBase64(item), mimeType: mimeType ?? OCTET_STREAM };
  }
  if (typeof item === 'object' && item !== null) {
    const block = item as { text?: unknown; blob?: unknown; uri?: unknown; mimeType?: unknown };
    const at = typeof block.uri === 'string' ? block.uri : uri;
    const type = typeof block.mimeType === 'string' ? block.mimeType : mimeType;
    if (typeof block.text === 'string') {
      return { uri: at, text: block.text, ...(type ? { mimeType: type } : {}) };
    }
    if (typeof block.blob === 'string' || block.blob instanceof Uint8Array) {
      return { uri: at, blob: base64Of(block.blob), mimeType: type ?? OCTET_STREAM };
    }
  }
  throw new Error(
    `${what} returned an unsupported value: return a string, a Uint8Array, { text } / { blob } contents, an array of them, or null for not-found.`,
  );
}

function toPromptContent(content: McpPromptContent, what: string): Record<string, unknown> {
  if (typeof content === 'string') return { type: 'text', text: content };
  switch (content?.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'image':
    case 'audio':
      return { type: content.type, data: base64Of(content.data), mimeType: content.mimeType };
    case 'resource':
      return {
        type: 'resource',
        resource: toResourceContents(
          content.resource,
          content.resource.uri,
          content.resource.mimeType,
          what,
        ),
      };
    default:
      throw new Error(
        `${what} returned a message with unsupported content: use a string or a text, image, audio or resource block.`,
      );
  }
}

/** A prompt's `get` result as a wire `GetPromptResult`. */
function toPromptResult(value: McpPromptResult, what: string): Record<string, unknown> {
  const toMessage = (message: McpPromptMessage): Record<string, unknown> => {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      throw new Error(`${what} returned a message whose role is not 'user' or 'assistant'.`);
    }
    return { role: message.role, content: toPromptContent(message.content, what) };
  };
  if (typeof value === 'string') {
    return { messages: [{ role: 'user', content: { type: 'text', text: value } }] };
  }
  if (Array.isArray(value)) return { messages: value.map(toMessage) };
  if (typeof value === 'object' && value !== null && Array.isArray(value.messages)) {
    return {
      ...(value.description !== undefined ? { description: value.description } : {}),
      messages: value.messages.map(toMessage),
    };
  }
  throw new Error(
    `${what} returned an unsupported value: return a string, an array of messages, or { description?, messages }.`,
  );
}

/**
 * The `argsSchema` a prompt registers: a Standard Schema the SDK both LISTS
 * (`prompts/list` reads its JSON Schema's properties into `arguments`) and
 * CHECKS before the callback runs, so a bad `prompts/get` is the SDK's
 * `InvalidParams` and `get` never sees it. Strict: undeclared names,
 * non-strings and missing required arguments are rejected, then the optional
 * user schema refines.
 */
function promptArgsSchema(def: McpServedPrompt): unknown {
  const declared = def.arguments ?? {};
  const json: Record<string, unknown> = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(declared).map(([name, arg]) => [
        name,
        { type: 'string', ...(arg.description ? { description: arg.description } : {}) },
      ]),
    ),
    required: Object.entries(declared)
      .filter(([, arg]) => arg.required === true)
      .map(([name]) => name),
    additionalProperties: false,
  };
  return {
    '~standard': {
      version: 1,
      vendor: 'deuz',
      validate: async (value: unknown) => {
        const issues: Array<{ message: string; path?: PropertyKey[] }> = [];
        if (!isPlainObject(value)) return { issues: [{ message: 'arguments must be an object' }] };
        for (const [key, arg] of Object.entries(value)) {
          if (!Object.hasOwn(declared, key)) {
            issues.push({ message: `unknown argument '${key}'`, path: [key] });
          } else if (typeof arg !== 'string') {
            issues.push({ message: `argument '${key}' must be a string`, path: [key] });
          }
        }
        for (const [key, arg] of Object.entries(declared)) {
          // Own keys only: a required argument named like an Object.prototype
          // member ('constructor') must not pass as present when omitted.
          if (arg.required === true && (!Object.hasOwn(value, key) || value[key] === undefined)) {
            issues.push({ message: `missing required argument '${key}'`, path: [key] });
          }
        }
        if (issues.length > 0) return { issues };
        if (def.schema) {
          const refined = await def.schema['~standard'].validate(value);
          if (refined.issues) return { issues: refined.issues };
        }
        return { value };
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

// --- Guardrails (the loop's verdict rules: rewrites chain, the first block wins) ---

function list<T>(entry: T | T[] | undefined): T[] {
  if (entry === undefined) return [];
  return Array.isArray(entry) ? entry : [entry];
}

/** Same wording as the loop's `guardrailDenialReason`, so a model reads one vocabulary. */
function guardrailDenial(guard: { name?: string }, reason: string | undefined): string {
  const who = guard.name ? ` '${guard.name}'` : '';
  return reason ? `Blocked by guardrail${who}: ${reason}` : `Blocked by guardrail${who}.`;
}

async function guardToolCall(
  guards: ToolCallGuardrail[],
  call: ToolCall,
  base: { runtimeContext?: unknown },
): Promise<{ call: ToolCall } | { blocked: string }> {
  let current = call;
  for (const guard of guards) {
    const verdict: ToolCallGuardrailResult | undefined = await guard({
      toolCall: current,
      messages: [],
      ...base,
    });
    if (!verdict || verdict.action === 'pass') continue;
    if (verdict.action === 'block') return { blocked: guardrailDenial(guard, verdict.reason) };
    current = { ...current, args: verdict.args };
  }
  return { call: current };
}

async function guardToolResult(
  guards: ToolResultGuardrail[],
  call: ToolCall,
  outcome: { result: unknown; isError: boolean },
  base: { runtimeContext?: unknown },
): Promise<{ result: unknown; isError: boolean }> {
  let current = outcome;
  for (const guard of guards) {
    const verdict: ToolResultGuardrailResult | undefined = await guard({
      toolCall: call,
      result: current.result,
      isError: current.isError,
      messages: [],
      ...base,
    });
    if (!verdict || verdict.action === 'pass') continue;
    if (verdict.action === 'block') {
      return { result: guardrailDenial(guard, verdict.reason), isError: true };
    }
    current = { ...current, result: verdict.result };
  }
  return current;
}

// --- Approval ------------------------------------------------------------------------

/** The `inputRequests` key of the approval elicitation (server-assigned, echoed back on retry). */
const APPROVAL_KEY = 'deuz-approval';

/** Longest argument preview an approval prompt shows. */
const MAX_APPROVAL_PREVIEW = 2_000;

type ApprovalDecision =
  | { kind: 'approved' }
  | { kind: 'denied'; reason?: string }
  | { kind: 'ask'; result: unknown };

/**
 * Whether this request's client can answer a FORM elicitation. A 2026-07-28
 * request declares its capabilities in its envelope; a 2025-era stdio session
 * declared them at `initialize`. A stateless 2025-era HTTP request has neither,
 * so nobody can be asked. An empty `elicitation` object means form mode.
 */
function canElicitForm(ctx: V2ToolContext, instance: V2McpServer): boolean {
  const fromEnvelope = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_KEY] as
    | Record<string, unknown>
    | undefined;
  const capabilities = fromEnvelope ?? instance.server.getClientCapabilities?.();
  const elicitation = capabilities?.elicitation;
  if (typeof elicitation !== 'object' || elicitation === null) return false;
  return Object.keys(elicitation).length === 0 || 'form' in elicitation;
}

function approvalPrompt(toolName: string, args: unknown): string {
  let preview = JSON.stringify(args) ?? 'no arguments';
  if (preview.length > MAX_APPROVAL_PREVIEW) preview = `${preview.slice(0, MAX_APPROVAL_PREVIEW)}…`;
  return `Allow the tool "${toolName}" to run with ${preview}?`;
}

// --- The server ------------------------------------------------------------------------

/** The function form of {@link McpServerOptions.toolsContext}. */
type PerCallContexts = (
  request: McpServerRequest,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** A served tool, prepared once and registered on every per-unit SDK instance. */
interface ServedEntry {
  name: string;
  config: Record<string, unknown>;
  hasOutputSchema: boolean;
  /** Runs as an MCP task when the request allows (2.5). */
  task: boolean;
  /** The canonical tool for this call (an `agentTools` entry may bind a per-call context). */
  resolve(request: McpServerRequest): Promise<Tool>;
}

/** A static resource, checked once and registered on every per-unit SDK instance. */
interface PreparedResource {
  name: string;
  /** Normalized — see `checkResource`. */
  uri: string;
  config: Record<string, unknown>;
  def: McpServedResource;
}

interface PreparedTemplate {
  name: string;
  config: Record<string, unknown>;
  def: McpServedResourceTemplate;
  /** The SDK's own matcher, for checks made outside a `resources/read`. */
  matcher: V2UriTemplate;
  /** Each variable's RFC 6570 operator — see `templateOperators`. */
  operators: Map<string, string>;
}

interface PreparedPrompt {
  name: string;
  config: Record<string, unknown>;
  def: McpServedPrompt;
}

/**
 * The live catalog. Maps, not arrays: `catalog` replaces an entry in place
 * (keeping its listing position) and removes by name. Insertion order is the
 * listing order.
 */
interface Prepared {
  sdk: V2ServerModule;
  tools: Map<string, ServedEntry>;
  resources: Map<string, PreparedResource>;
  templates: Map<string, PreparedTemplate>;
  prompts: Map<string, PreparedPrompt>;
}

/** The three list-change notifications; coalesced per tick so a replace (remove + register) sends one. */
const LIST_CHANGED_METHODS = [
  'notifications/tools/list_changed',
  'notifications/resources/list_changed',
  'notifications/prompts/list_changed',
];

/** Most URIs one 2025-era stdio session may `resources/subscribe` to at once. */
const MAX_LEGACY_SUBSCRIPTIONS = 10_000;

/**
 * The forms of a URI a subscriber may have named: as given, and as a listing
 * shows a static resource (`new URL(uri).href`, see `checkResource`), so
 * `resourceUpdated('https://example.com')` reaches a client subscribed to the
 * listed `https://example.com/`.
 */
function uriForms(uri: string): string[] {
  try {
    const href = new URL(uri).href;
    return href === uri ? [uri] : [uri, href];
  } catch {
    return [uri];
  }
}

// --- URI template variables (RFC 6570) -------------------------------------------------

/** The operators the SDK's `UriTemplate` knows; anything else is a simple `{x}`. */
const TEMPLATE_OPERATORS = ['+', '#', '.', '/', '?', '&'];

/** Operators that expand to one segment: their value never holds a separator. */
const SINGLE_SEGMENT_OPERATORS = new Set(['', '.', '/']);

/** C0 controls, DEL and C1 controls. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** A `.` or `..` segment, with `/` or `\` as the separator. */
const DOT_SEGMENT = /(?:^|[/\\])\.\.?(?:[/\\]|$)/;

/**
 * Each variable's operator, keyed by the name the SDK's `match` reports it
 * under (its own parse: `{op name*,other}`, the first `*` dropped).
 */
function templateOperators(uriTemplate: string): Map<string, string> {
  const operators = new Map<string, string>();
  for (const [, expression = ''] of uriTemplate.matchAll(/\{([^}]*)\}/g)) {
    const operator = TEMPLATE_OPERATORS.find((op) => expression.startsWith(op)) ?? '';
    for (const part of expression.slice(operator.length).split(',')) {
      const name = part.replace('*', '').trim();
      if (name.length > 0) operators.set(name, operator);
    }
  }
  return operators;
}

/**
 * One matched value, decoded, or `undefined` when it leaves what its operator
 * expands to — the rules are on {@link McpServedResourceTemplate.rawVariables}.
 * The SDK matches against `new URL(uri).href`, which has already split off
 * the query and fragment, so a literal `?`/`#` in a value means the match ran
 * past the variable's own component.
 */
function decodeTemplateValue(matched: string, operator: string): string | undefined {
  // The SDK's `{#x}` pattern captures the operator's own `#` prefix.
  const raw = operator === '#' && matched.startsWith('#') ? matched.slice(1) : matched;
  if (raw.includes('#') || (operator !== '#' && raw.includes('?'))) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined; // a stray '%', or bytes that are not UTF-8
  }
  if (CONTROL_CHARACTER.test(value) || DOT_SEGMENT.test(value)) return undefined;
  if (SINGLE_SEGMENT_OPERATORS.has(operator) && /[/\\?#]/.test(value)) return undefined;
  return value;
}

/** Every matched variable decoded, or `undefined` when any one is refused. */
function decodeTemplateVariables(
  matched: Record<string, string | string[]>,
  operators: ReadonlyMap<string, string>,
): Record<string, string | string[]> | undefined {
  const decoded: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(matched)) {
    const operator = operators.get(name) ?? '';
    if (Array.isArray(value)) {
      const items = value.map((item) => decodeTemplateValue(item, operator));
      if (items.some((item) => item === undefined)) return undefined;
      decoded[name] = items as string[];
    } else {
      const item = decodeTemplateValue(value, operator);
      if (item === undefined) return undefined;
      decoded[name] = item;
    }
  }
  return decoded;
}

/** The method header every 2026-07-28 HTTP request carries; the SDK refuses one that disagrees with the body. */
const LISTEN_METHOD = 'subscriptions/listen';

/**
 * A listen stream's SSE frames with every `notifications/resources/updated`
 * the subscriber may not see removed. Frames are judged in order, one at a
 * time, so the stream keeps its order; anything else passes untouched.
 */
function filterListenStream(
  response: Response,
  allow: (uri: string) => Promise<boolean>,
): Response {
  if (response.body === null) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const keep = async (frame: string): Promise<boolean> => {
    const data = frame.split('\n').find((line) => line.startsWith('data:'));
    if (data === undefined) return true;
    let message: { method?: unknown; params?: { uri?: unknown } };
    try {
      message = JSON.parse(data.slice('data:'.length)) as typeof message;
    } catch {
      return true;
    }
    if (message?.method !== 'notifications/resources/updated') return true;
    const uri = message.params?.uri;
    return typeof uri === 'string' && (await allow(uri));
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end + 2);
          pending = pending.slice(end + 2);
          if (await keep(frame)) controller.enqueue(encoder.encode(frame));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.length > 0) controller.enqueue(encoder.encode(pending));
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** A request body as text, or `undefined` when it is unreadable or longer than `limit` bytes. */
async function readBounded(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit || request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Names of the throwaway registrations that make an empty kind answer its list request with `[]`. */
const PLACEHOLDER = 'deuz-placeholder';

/** One serving unit: an SDK instance and where it serves. */
interface ServingUnit {
  transport: McpServerTransportKind;
  era: McpServerEra;
  instance: V2McpServer;
  /** Unique per unit (one HTTP request, one stdio connection): qualifies served `toolCallId`s. */
  id: string;
}

/**
 * A long-lived (stdio) instance `catalog` keeps in sync. An HTTP instance
 * serves ONE request and is built from the current catalog, so it is never
 * tracked.
 */
interface LiveSession {
  unit: ServingUnit;
  tools: Map<string, V2Registered>;
  resources: Map<string, V2Registered>;
  templates: Map<string, V2Registered>;
  prompts: Map<string, V2Registered>;
  /** URIs a 2025-era session `resources/subscribe`d to. */
  subscriptions: Set<string>;
  /** Capabilities fixed at its handshake: a kind it did not advertise cannot be added. */
  resourcesOn: boolean;
  promptsOn: boolean;
  completionsOn: boolean;
}

function resourceConfig(def: McpResourceMetadata & { size?: number }): Record<string, unknown> {
  return {
    ...(def.title !== undefined ? { title: def.title } : {}),
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.mimeType !== undefined ? { mimeType: def.mimeType } : {}),
    ...(def.size !== undefined ? { size: def.size } : {}),
    ...(def.annotations !== undefined ? { annotations: def.annotations } : {}),
    ...(def.cacheHint !== undefined ? { cacheHint: def.cacheHint } : {}),
  };
}

/** `agentTool`'s input contract, so a delegating client sees the familiar shape. */
const PROMPT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { prompt: { type: 'string', description: 'The task for the agent.' } },
  required: ['prompt'],
  additionalProperties: false,
};

/** A completed run's output, or the reason it did not complete as a thrown error. */
function agentOutcome(name: string, result: AgentResult<unknown>): unknown {
  switch (result.status) {
    case 'completed':
      return result.output;
    case 'suspended':
      throw new Error(
        `Agent '${name}' suspended with ${result.pendingApprovals.length} pending approval(s) and ${result.pendingClientCalls.length} client tool call(s); an MCP call cannot resume it. Give the agent a server-side approveToolCall.`,
      );
    case 'stopped':
      throw new Error(
        `Agent '${name}' stopped before completing (${result.reason}).${result.text ? ` Partial answer: ${result.text}` : ''}`,
      );
    case 'failed':
      throw new Error(`Agent '${name}' failed: ${result.error.message}`);
  }
}

function servedAgentTool(name: string, def: McpServedAgent, request: McpServerRequest): Tool {
  return {
    description: def.description,
    parameters: PROMPT_SCHEMA,
    ...(def.needsApproval !== undefined ? { needsApproval: def.needsApproval } : {}),
    execute: async (args, ctx) => {
      const { prompt } = args as { prompt: string };
      const built =
        typeof def.agent === 'function' ? await def.agent({ prompt }, request) : def.agent;
      // The conversation is this call's; a stray `prompt` would trip runAgent's
      // prompt-XOR-messages guard.
      const { prompt: _ignored, ...run } = built as McpAgentRunOptions & { prompt?: unknown };
      const { runAgent } = await import('../agent-run');
      const signal = combineSignals([run.signal, ctx.signal]);
      const result = await runAgent({
        ...(ctx.runtimeContext !== undefined ? { runtimeContext: ctx.runtimeContext } : {}),
        ...run,
        messages: [{ role: 'user', content: prompt }],
        ...(signal ? { signal } : {}),
      } as AgentRunOptions<unknown>);
      return agentOutcome(name, result);
    },
  };
}

/** `Tool.timeoutMs` for a served call: on expiry the tool's signal aborts and the call is abandoned. */
async function runWithTimeout(
  clock: Clock,
  timeoutMs: number | undefined,
  toolName: string,
  run: (signal: AbortSignal | undefined) => Promise<unknown>,
  signal: AbortSignal,
): Promise<{ timedOut: true; message: string } | { timedOut: false; value: unknown }> {
  // Infinity means no cap, as in the loop: a host setTimeout clamps it to 1ms.
  if (timeoutMs === undefined || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return { timedOut: false, value: await run(signal) };
  }
  const expiry = new AbortController();
  let cancel: (() => void) | undefined;
  const timeout = new Promise<{ timedOut: true; message: string }>((resolve) => {
    cancel = clock.setTimeout(() => {
      const message = `Tool '${toolName}' timed out after ${timeoutMs}ms and was abandoned.`;
      expiry.abort(new Error(message));
      resolve({ timedOut: true, message });
    }, timeoutMs);
  });
  try {
    const work = run(combineSignals([signal, expiry.signal])).then((value) => ({
      timedOut: false as const,
      value,
    }));
    // An abandoned call's late rejection must not surface as unhandled.
    work.catch(() => {});
    return await Promise.race([work, timeout]);
  } finally {
    cancel?.();
  }
}

export function createMcpServer(options: McpServerOptions): DeuzMcpServer {
  assertServable(options);
  const clock = options.clock ?? resolveDependencies().clock;
  const generateId = options.generateId ?? resolveDependencies().generateId;
  const onToolCall = list(options.guardrails?.onToolCall);
  const onToolResult = list(options.guardrails?.onToolResult);
  const annotations = options.toolAnnotations ?? {};

  const report = (error: unknown): void => {
    try {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Reporting must never change what is served.
    }
  };

  // Tasks (2.5): on when asked for, or when an agent opts in. Fixed for the
  // server's lifetime, so capabilities never change between handshakes.
  const taskNames = new Set(options.tasks?.tools ?? []);
  const taskRuntime: TaskRuntime | undefined =
    options.tasks !== undefined || Object.values(options.agents ?? {}).some((a) => a.task === true)
      ? createTaskRuntime({
          store: options.tasks?.store ?? createInMemoryMcpTaskStore({ clock }),
          clock,
          ttlMs: options.tasks?.ttlMs === undefined ? 3_600_000 : options.tasks.ttlMs,
          pollIntervalMs: options.tasks?.pollIntervalMs ?? 1_000,
          generateTaskId: options.tasks?.generateTaskId ?? resolveDependencies().generateId,
          report,
        })
      : undefined;

  /** Who a task belongs to — see `McpServerTasksOptions.owner`. */
  const taskOwner = (request: McpServerRequest, unit: ServingUnit): string | undefined => {
    if (options.tasks?.owner) return options.tasks.owner(request);
    if (unit.transport === 'stdio') return `stdio:${unit.id}`;
    return request.authInfo ? `client:${request.authInfo.clientId}` : undefined;
  };

  let prepared: Promise<Prepared> | undefined;
  const prepare = (): Promise<Prepared> => (prepared ??= prepareAll());

  const meta = (
    name: string,
    description: string | undefined,
    override?: McpToolAnnotations,
  ): Record<string, unknown> => {
    const annotated = override ?? annotations[name];
    return {
      ...(description ? { description } : {}),
      ...(annotated ? { annotations: annotated } : {}),
    };
  };

  async function prepareTool(
    sdk: V2ServerModule,
    name: string,
    tool: Tool,
    override?: McpToolAnnotations,
  ): Promise<ServedEntry> {
    const task = taskNames.has(name);
    if (task) assertTaskable(name, tool.outputSchema !== undefined);
    return {
      name,
      config: {
        ...meta(name, tool.description, override),
        inputSchema: await inputSchemaFor(sdk, name, tool.parameters),
        ...(tool.outputSchema
          ? { outputSchema: sdk.fromJsonSchema(tool.outputSchema as Record<string, unknown>) }
          : {}),
      },
      hasOutputSchema: tool.outputSchema !== undefined,
      task,
      resolve: async () => tool,
    };
  }

  function prepareAgent(
    sdk: V2ServerModule,
    name: string,
    def: McpServedAgent,
    override?: McpToolAnnotations,
  ): ServedEntry {
    return {
      name,
      config: {
        ...meta(name, def.description, override),
        inputSchema: sdk.fromJsonSchema(PROMPT_SCHEMA as Record<string, unknown>),
      },
      hasOutputSchema: false,
      task: def.task === true || taskNames.has(name),
      resolve: async (request) => servedAgentTool(name, def, request),
    };
  }

  function prepareResource(name: string, def: McpServedResource): PreparedResource {
    return { name, uri: checkResource(name, def), config: resourceConfig(def), def };
  }

  function prepareTemplate(
    sdk: V2ServerModule,
    name: string,
    def: McpServedResourceTemplate,
  ): PreparedTemplate {
    checkTemplate(name, def);
    let matcher: V2UriTemplate;
    try {
      // Parsed here so a malformed template fails ready() / setResourceTemplate.
      new sdk.ResourceTemplate(def.uriTemplate, { list: undefined });
      matcher = new sdk.UriTemplate(def.uriTemplate);
    } catch (err) {
      throw new InvalidRequestError({
        message: `MCP server resource template '${name}' has an invalid uriTemplate '${def.uriTemplate}': ${messageOf(err)}`,
        cause: err,
      });
    }
    return {
      name,
      config: resourceConfig(def),
      def,
      matcher,
      operators: templateOperators(def.uriTemplate),
    };
  }

  function preparePrompt(name: string, def: McpServedPrompt): PreparedPrompt {
    checkPrompt(name, def);
    return {
      name,
      config: {
        ...(def.title !== undefined ? { title: def.title } : {}),
        ...(def.description !== undefined ? { description: def.description } : {}),
        argsSchema: promptArgsSchema(def),
      },
      def,
    };
  }

  async function prepareAll(): Promise<Prepared> {
    const sdk = await loadV2Server();
    const tools = new Map<string, ServedEntry>();

    for (const [name, tool] of Object.entries(options.tools ?? {})) {
      tools.set(name, await prepareTool(sdk, name, tool));
    }

    const agentTools = options.agentTools ?? {};
    if (Object.keys(agentTools).length > 0) {
      const { prepareAgentTools } = await import('../inference/agent-tools');
      const perCall =
        typeof options.toolsContext === 'function'
          ? (options.toolsContext as PerCallContexts)
          : undefined;
      let fixed: ToolSet | undefined;
      for (const [name, agentTool] of Object.entries(agentTools)) {
        // Converted even when unused, so a schema that cannot be listed fails
        // ready() with this server's error rather than inside native preparation.
        const output = agentTool.outputSchema;
        const converted =
          output !== undefined && isStandardSchema(output)
            ? await standardToJsonSchema(name, output)
            : output;
        // A `toModelOutput` projection is what the client receives, so the raw
        // result's schema would describe the wrong value.
        const advertised = agentTool.toModelOutput === undefined ? converted : undefined;
        if (taskNames.has(name)) assertTaskable(name, advertised !== undefined);
        tools.set(name, {
          name,
          config: {
            ...meta(name, agentTool.description),
            inputSchema: await inputSchemaFor(sdk, name, agentTool.parameters),
            ...(advertised
              ? { outputSchema: sdk.fromJsonSchema(advertised as Record<string, unknown>) }
              : {}),
          },
          hasOutputSchema: advertised !== undefined,
          task: taskNames.has(name),
          resolve: perCall
            ? async (request) =>
                (await prepareAgentTools({ [name]: agentTool }, await perCall(request)))[name]!
            : async () => fixed![name]!,
        });
      }
      // A static context is validated ONCE, here, so a broken one fails ready();
      // the function form can only be checked per call.
      if (!perCall) {
        fixed = await prepareAgentTools(
          agentTools,
          options.toolsContext as Record<string, unknown> | undefined,
        );
      }
    }

    for (const [name, def] of Object.entries(options.agents ?? {})) {
      tools.set(name, prepareAgent(sdk, name, def));
    }

    const resources = new Map<string, PreparedResource>();
    for (const [name, def] of Object.entries(options.resources ?? {})) {
      resources.set(name, prepareResource(name, def));
    }
    const templates = new Map<string, PreparedTemplate>();
    for (const [name, def] of Object.entries(options.resourceTemplates ?? {})) {
      templates.set(name, prepareTemplate(sdk, name, def));
    }
    const prompts = new Map<string, PreparedPrompt>();
    for (const [name, def] of Object.entries(options.prompts ?? {})) {
      prompts.set(name, preparePrompt(name, def));
    }
    return { sdk, tools, resources, templates, prompts };
  }

  /** The identity every served request carries — tools, reads and prompts alike. */
  function requestOf(
    ctx: V2ToolContext,
    unit: { transport: McpServerTransportKind; era: McpServerEra },
  ): McpServerRequest {
    return {
      transport: unit.transport,
      era: unit.era,
      ...(ctx.http?.authInfo ? { authInfo: ctx.http.authInfo } : {}),
      ...(ctx.http?.req ? { request: ctx.http.req } : {}),
    };
  }

  async function servedContext(ctx: V2ToolContext, unit: ServingUnit): Promise<McpServedContext> {
    const request = requestOf(ctx, unit);
    const runtimeContext =
      options.runtimeContext !== undefined ? await options.runtimeContext(request) : undefined;
    return {
      request,
      signal: ctx.mcpReq.signal,
      ...(runtimeContext !== undefined ? { runtimeContext } : {}),
    };
  }

  /**
   * One `resources/read`. A throw (the read's, or `runtimeContext`'s) becomes
   * the request's JSON-RPC error carrying its message; `null` is not-found.
   */
  async function serveRead(
    sdk: V2ServerModule,
    what: string,
    def: McpServedResource | McpServedResourceTemplate,
    uri: URL,
    variables: Record<string, string | string[]>,
    ctx: V2ToolContext,
    unit: ServingUnit,
  ): Promise<unknown> {
    const base = await servedContext(ctx, unit);
    const value = await def.read({ ...base, uri, variables });
    if (value === null || value === undefined) throw new sdk.ResourceNotFoundError(uri.href);
    const items: unknown[] = Array.isArray(value) ? value : [value];
    return {
      contents: items.map((item) => toResourceContents(item, uri.href, def.mimeType, what)),
    };
  }

  function registerTool(unit: ServingUnit, sdk: V2ServerModule, entry: ServedEntry): V2Registered {
    const registered = unit.instance.registerTool(entry.name, entry.config, (args, ctx) =>
      serveCall(sdk, entry, args, ctx, unit.instance, unit),
    );
    // 2025-11-25 tool-level negotiation. `registerTool` takes no `execution`,
    // but `tools/list` reads it off the registered tool (2026-07-28 strips it).
    if (taskRuntime && entry.task) {
      (registered as V2Registered & { execution?: unknown }).execution = {
        taskSupport: 'optional',
      };
    }
    return registered;
  }

  function registerResource(
    unit: ServingUnit,
    sdk: V2ServerModule,
    resource: PreparedResource,
  ): V2Registered {
    const what = `Resource '${resource.name}'`;
    return unit.instance.registerResource(
      resource.name,
      resource.uri,
      resource.config,
      (uri: URL, ctx: V2ToolContext) => serveRead(sdk, what, resource.def, uri, {}, ctx, unit),
    );
  }

  function registerTemplate(
    unit: ServingUnit,
    sdk: V2ServerModule,
    template: PreparedTemplate,
    withCompletions: boolean,
  ): V2Registered {
    const { def } = template;
    const what = `Resource template '${template.name}'`;
    const complete =
      withCompletions && def.complete
        ? Object.fromEntries(
            Object.entries(def.complete).map(([variable, fn]): [string, V2CompleteCallback] => [
              variable,
              async (value, context) => fn(value, { arguments: context?.arguments ?? {} }),
            ]),
          )
        : undefined;
    const resourceTemplate = new sdk.ResourceTemplate(def.uriTemplate, {
      list: def.list
        ? async (ctx) => ({ resources: await def.list!(await servedContext(ctx, unit)) })
        : undefined,
      ...(complete ? { complete } : {}),
    });
    return unit.instance.registerResource(
      template.name,
      resourceTemplate,
      template.config,
      async (uri: URL, matched: Record<string, string | string[]>, ctx: V2ToolContext) => {
        const variables = templateVariables(template, matched);
        // A value that escapes its operator names no resource of this template.
        if (variables === undefined) throw new sdk.ResourceNotFoundError(uri.href);
        return serveRead(sdk, what, def, uri, variables, ctx, unit);
      },
    );
  }

  /** What `read` receives for a template match: decoded and checked, unless `rawVariables`. */
  function templateVariables(
    template: PreparedTemplate,
    matched: Record<string, string | string[]>,
  ): Record<string, string | string[]> | undefined {
    return template.def.rawVariables === true
      ? matched
      : decodeTemplateVariables(matched, template.operators);
  }

  /**
   * Whether `read` answers `uri` for this caller — the rule `resources/read`
   * applies, resolved the way the SDK resolves a read (a static resource by
   * its normalized URI, else the first template that matches). A URI nothing
   * serves, a refused variable, a `null` and a throw are all "no".
   */
  async function readableBy(
    current: Prepared,
    uri: string,
    request: McpServerRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const url = new URL(uri);
      let target:
        | {
            def: McpServedResource | McpServedResourceTemplate;
            variables: Record<string, string | string[]>;
          }
        | undefined;
      for (const resource of current.resources.values()) {
        if (resource.uri === url.href) target = { def: resource.def, variables: {} };
      }
      if (target === undefined) {
        for (const template of current.templates.values()) {
          const matched = template.matcher.match(url.href);
          if (matched === null) continue;
          const variables = templateVariables(template, matched);
          if (variables === undefined) return false;
          target = { def: template.def, variables };
          break;
        }
      }
      if (target === undefined) return false;
      const runtimeContext =
        options.runtimeContext !== undefined ? await options.runtimeContext(request) : undefined;
      const value = await target.def.read({
        request,
        signal,
        ...(runtimeContext !== undefined ? { runtimeContext } : {}),
        uri: url,
        variables: target.variables,
      });
      return value !== null && value !== undefined;
    } catch {
      return false;
    }
  }

  function registerPrompt(unit: ServingUnit, prompt: PreparedPrompt): V2Registered {
    const what = `Prompt '${prompt.name}'`;
    return unit.instance.registerPrompt(prompt.name, prompt.config, async (args, ctx) => {
      const base = await servedContext(ctx, unit);
      const value = await prompt.def.get(args as Record<string, string>, base);
      return toPromptResult(value, what);
    });
  }

  /** One served `tools/call` — the pipeline in the module header. */
  async function serveCall(
    sdk: V2ServerModule,
    entry: ServedEntry,
    args: unknown,
    ctx: V2ToolContext,
    instance: V2McpServer,
    unit: ServingUnit,
  ): Promise<unknown> {
    const request = requestOf(ctx, unit);
    try {
      const base =
        options.runtimeContext !== undefined
          ? { runtimeContext: await options.runtimeContext(request) }
          : {};
      const tool = await entry.resolve(request);
      const execCtx: ToolExecuteContext = {
        toolCallId: servedToolCallId(unit, ctx.mcpReq.id),
        messages: [],
        signal: ctx.mcpReq.signal,
        ...base,
      };

      const guarded = await guardToolCall(
        onToolCall,
        { toolCallId: execCtx.toolCallId, toolName: entry.name, args },
        base,
      );
      if ('blocked' in guarded) return errorResult(guarded.blocked);
      const call = guarded.call;

      const gate = tool.needsApproval;
      // Fail closed like the loop: a truthy non-function (a 'true' from a JSON
      // config) gates the call there too, because calling it throws.
      const needs = typeof gate === 'function' ? await gate(call.args, execCtx) : Boolean(gate);
      if (needs) {
        const decision = await decide(sdk, call, request, ctx, instance);
        if (decision.kind === 'ask') return decision.result;
        if (decision.kind === 'denied') {
          return errorResult(
            decision.reason ? `${TOOL_DENIED} Reason: ${decision.reason}` : TOOL_DENIED,
          );
        }
      }

      /** The pipeline's second half: on the request's signal, or a task's. */
      const finish = async (callSignal: AbortSignal): Promise<V2CallToolResult> => {
        const validation = await validateOutput(tool.parameters, call.args);
        if (!validation.ok) return errorResult(`Invalid arguments: ${validation.issues}`);
        const callCtx: ToolExecuteContext = { ...execCtx, signal: callSignal };

        let outcome: { result: unknown; isError: boolean };
        try {
          const ran = await runWithTimeout(
            clock,
            tool.timeoutMs,
            entry.name,
            async (signal) =>
              tool.execute!(validation.value, signal ? { ...callCtx, signal } : callCtx),
            callSignal,
          );
          outcome = ran.timedOut
            ? { result: ran.message, isError: true }
            : { result: ran.value, isError: false };
        } catch (error) {
          outcome = { result: messageOf(error), isError: true };
        }
        outcome = await guardToolResult(onToolResult, call, outcome, base);
        if (outcome.isError) return errorResult(resultText(outcome.result));
        return toCallToolResult(outcome.result, entry.hasOutputSchema);
      };

      const asTask = taskRequestOf(entry, ctx, unit);
      if (taskRuntime && asTask) {
        const notifying = unit.transport === 'stdio' && unit.era === 'legacy';
        const record = await taskRuntime.start({
          owner: taskOwner(request, unit),
          toolName: entry.name,
          ...(asTask.ttlMs !== undefined ? { requestedTtlMs: asTask.ttlMs } : {}),
          ...(notifying
            ? {
                notify: (_record, task) => {
                  if (![...live].some((session) => session.unit === unit)) return;
                  instance.server
                    .notification({ method: 'notifications/tasks/status', params: task })
                    .catch(report);
                },
              }
            : {}),
          // A failing onToolResult guardrail is the call's failure, as below.
          run: async (signal) =>
            (await finish(signal).catch((error: unknown) =>
              errorResult(messageOf(error)),
            )) as unknown as Record<string, unknown>,
        });
        return createTaskResult(record, unit.era);
      }
      return await finish(ctx.mcpReq.signal);
    } catch (error) {
      // A failing runtimeContext/toolsContext/guardrail is the call's failure,
      // answered like a throwing tool — never a dropped request.
      return errorResult(messageOf(error));
    }
  }

  /**
   * Whether this call runs as a task, and the TTL a 2025-era client asked for:
   * a task-enabled tool, on a server with tasks, whose request opted in (the
   * 2026-07-28 envelope declares the extension; a 2025-era call carries
   * `params.task`, lifted into `_meta` before the SDK saw it).
   */
  function taskRequestOf(
    entry: ServedEntry,
    ctx: V2ToolContext,
    unit: ServingUnit,
  ): { ttlMs?: number } | undefined {
    if (!taskRuntime || !entry.task) return undefined;
    if (unit.era === 'modern') return declaresTasksExtension(ctx.mcpReq.envelope) ? {} : undefined;
    return liftedTaskRequest(ctx.mcpReq._meta);
  }

  async function decide(
    sdk: V2ServerModule,
    call: ToolCall,
    request: McpServerRequest,
    ctx: V2ToolContext,
    instance: V2McpServer,
  ): Promise<ApprovalDecision> {
    const approve = options.approve ?? 'elicit';
    if (typeof approve === 'function') {
      let approved = false;
      try {
        approved = Boolean(await approve({ toolName: call.toolName, args: call.args, request }));
      } catch (error) {
        // A throw denies, as a throwing approveToolCall does in the loop. Its
        // message is the operator's business: onError gets it, the client does not.
        report(error);
      }
      return approved ? { kind: 'approved' } : { kind: 'denied' };
    }
    const answer = sdk.inputResponse(ctx.mcpReq.inputResponses, APPROVAL_KEY);
    if (answer.kind === 'elicit') {
      if (answer.action === 'accept' && answer.content?.approve === true)
        return { kind: 'approved' };
      return {
        kind: 'denied',
        reason:
          answer.action === 'decline'
            ? 'declined by the user'
            : answer.action === 'cancel'
              ? 'cancelled by the user'
              : 'not approved by the user',
      };
    }
    if (!canElicitForm(ctx, instance)) {
      return {
        kind: 'denied',
        reason:
          'this tool needs approval and the client cannot be asked: no form elicitation on this connection',
      };
    }
    return {
      kind: 'ask',
      result: sdk.inputRequired({
        inputRequests: {
          [APPROVAL_KEY]: sdk.inputRequired.elicit({
            message: approvalPrompt(call.toolName, call.args),
            requestedSchema: {
              type: 'object',
              properties: {
                approve: {
                  type: 'boolean',
                  title: 'Approve',
                  description: `Run ${call.toolName} with these arguments.`,
                },
              },
              required: ['approve'],
            },
          }),
        },
      }),
    };
  }

  // --- Serving instances --------------------------------------------------------------

  /** Long-lived stdio instances, kept in sync by `catalog`. */
  const live = new Set<LiveSession>();

  /**
   * Whether a kind is advertised: the option was passed (even `{}`), or the
   * catalog holds entries of it now.
   */
  const resourcesOn = (p: Prepared): boolean =>
    options.resources !== undefined ||
    options.resourceTemplates !== undefined ||
    p.resources.size > 0 ||
    p.templates.size > 0;
  const promptsOn = (p: Prepared): boolean => options.prompts !== undefined || p.prompts.size > 0;

  /** A fresh instance for one serving unit, with the current catalog registered. */
  async function buildInstance(
    transport: McpServerTransportKind,
    era: McpServerEra,
  ): Promise<V2McpServer> {
    const current = await prepare();
    const { sdk } = current;
    const withResources = resourcesOn(current);
    const withPrompts = promptsOn(current);
    // `resources.subscribe` only where an update can be delivered: never to a
    // 2025-era client over stateless HTTP (no session, no stream).
    const subscribable = withResources && !(transport === 'http' && era === 'legacy');
    const instance = new sdk.McpServer(
      { name: options.name, version: options.version ?? '0.0.0' },
      {
        capabilities: {
          tools: {},
          ...(withResources
            ? { resources: { listChanged: true, ...(subscribable ? { subscribe: true } : {}) } }
            : {}),
          ...(withPrompts ? { prompts: { listChanged: true } } : {}),
          ...(taskRuntime
            ? era === 'modern'
              ? { extensions: { [MCP_TASKS_EXTENSION]: {} } }
              : { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }
            : {}),
        },
        debouncedNotificationMethods: LIST_CHANGED_METHODS,
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      },
    );
    const unit: ServingUnit = { transport, era, instance, id: generateId() };
    const session: LiveSession = {
      unit,
      tools: new Map(),
      resources: new Map(),
      templates: new Map(),
      prompts: new Map(),
      subscriptions: new Set(),
      resourcesOn: withResources,
      promptsOn: withPrompts,
      completionsOn: false,
    };

    // The SDK installs a kind's list handler on its first registration, so
    // an advertised kind with nothing in it yet gets a throwaway one: it lists
    // `[]` instead of answering method-not-found, and `catalog` can add to it
    // later. Nothing is sent — the instance is not connected yet.
    for (const entry of current.tools.values()) {
      session.tools.set(entry.name, registerTool(unit, sdk, entry));
    }
    if (current.tools.size === 0) {
      instance.registerTool(PLACEHOLDER, {}, async () => errorResult('Not served.')).remove();
    }
    if (withResources) {
      for (const resource of current.resources.values()) {
        session.resources.set(resource.name, registerResource(unit, sdk, resource));
      }
      for (const template of current.templates.values()) {
        session.templates.set(template.name, registerTemplate(unit, sdk, template, true));
      }
      if (current.resources.size === 0 && current.templates.size === 0) {
        instance
          .registerResource(PLACEHOLDER, `${PLACEHOLDER}:none`, {}, async () => ({ contents: [] }))
          .remove();
      }
      if (subscribable && era === 'legacy') {
        // A 2025-era stdio session subscribes per URI; `resourceUpdated` sends
        // to the sessions that asked. (2026-07-28 subscribes through
        // `subscriptions/listen`, which the SDK's entries serve themselves.)
        instance.server.setRequestHandler('resources/subscribe', (request) => {
          const uri = request.params?.uri;
          if (typeof uri === 'string' && !session.subscriptions.has(uri)) {
            if (session.subscriptions.size >= MAX_LEGACY_SUBSCRIPTIONS) {
              throw new Error(
                `Too many resource subscriptions (at most ${MAX_LEGACY_SUBSCRIPTIONS}); unsubscribe first.`,
              );
            }
            session.subscriptions.add(uri);
          }
          return {};
        });
        instance.server.setRequestHandler('resources/unsubscribe', (request) => {
          const uri = request.params?.uri;
          if (typeof uri === 'string') session.subscriptions.delete(uri);
          return {};
        });
      }
    }
    if (withPrompts) {
      for (const prompt of current.prompts.values()) {
        session.prompts.set(prompt.name, registerPrompt(unit, prompt));
      }
      if (current.prompts.size === 0) {
        instance.registerPrompt(PLACEHOLDER, {}, async () => ({ messages: [] })).remove();
      }
    }
    session.completionsOn = instance.server.getCapabilities().completions !== undefined;
    taskRuntime?.install(instance.server as unknown as TaskHandlerHost, era, (ctx) =>
      taskOwner(requestOf(ctx as TaskHandlerContext & V2ToolContext, unit), unit),
    );

    if (transport === 'stdio') {
      live.add(session);
      const previous = instance.server.onclose;
      instance.server.onclose = () => {
        live.delete(session);
        previous?.();
      };
    }
    return instance;
  }

  const internals: McpServerInternals = {
    ready: async () => {
      await prepare();
    },
    factory:
      (transport) =>
      ({ era }) =>
        buildInstance(transport, era),
    report,
  };

  let handler: Promise<V2HttpHandler> | undefined;
  /** The handler once built — `catalog` notifies through it synchronously. */
  let builtHandler: V2HttpHandler | undefined;
  const httpHandler = (): Promise<V2HttpHandler> =>
    (handler ??= prepare().then(({ sdk }) => {
      builtHandler = sdk.createMcpHandler(
        internals.factory('http') as (ctx: { era: McpServerEra }) => Promise<V2McpServer>,
        {
          legacy: options.legacy ?? 'stateless',
          onerror: report,
          ...(options.responseMode !== undefined ? { responseMode: options.responseMode } : {}),
          ...(options.maxRequestBodySize !== undefined
            ? { maxRequestBodySize: options.maxRequestBodySize }
            : {}),
          ...(options.eventBus !== undefined ? { bus: options.eventBus } : {}),
          ...(options.maxSubscriptions !== undefined
            ? { maxSubscriptions: options.maxSubscriptions }
            : {}),
        },
      );
      return builtHandler;
    }));

  // --- The mutable catalog ------------------------------------------------------------

  /** HTTP listeners: the handler's bus, or a shared bus before the handler exists. */
  function publish(event: McpServerEvent): void {
    try {
      if (builtHandler) {
        const { notify } = builtHandler;
        switch (event.kind) {
          case 'tools_list_changed':
            notify.toolsChanged();
            return;
          case 'prompts_list_changed':
            notify.promptsChanged();
            return;
          case 'resources_list_changed':
            notify.resourcesChanged();
            return;
          case 'resource_updated':
            notify.resourceUpdated(event.uri);
            return;
        }
      }
      options.eventBus?.publish(event);
    } catch (error) {
      report(error);
    }
  }

  /**
   * Swap one entry on every live session: remove the old registration,
   * register the new one. Each SDK call sends its `list_changed` (coalesced
   * per tick), and a session that did not advertise the kind is skipped.
   */
  function syncLive(
    pick: (session: LiveSession) => Map<string, V2Registered> | undefined,
    name: string,
    register: ((session: LiveSession) => V2Registered) | undefined,
  ): void {
    for (const session of live) {
      const registered = pick(session);
      if (!registered) continue;
      try {
        registered.get(name)?.remove();
        registered.delete(name);
        if (register) registered.set(name, register(session));
      } catch (error) {
        report(error);
      }
    }
  }

  /** Changes apply in call order; a failed one rejects its own promise only. */
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(change: (current: Prepared) => T | Promise<T>): Promise<T> {
    const run = queue.then(async () => change(await prepare()));
    queue = run.catch(() => undefined);
    return run;
  }

  function commitTool(current: Prepared, entry: ServedEntry): void {
    current.tools.set(entry.name, entry);
    syncLive(
      (session) => session.tools,
      entry.name,
      (session) => registerTool(session.unit, current.sdk, entry),
    );
    publish({ kind: 'tools_list_changed' });
  }

  const catalog: McpServerCatalog = {
    setTool: (name, tool, toolAnnotations) =>
      enqueue(async (current) => {
        assertExecutable(name, tool);
        commitTool(current, await prepareTool(current.sdk, name, tool, toolAnnotations));
      }),
    setAgent: (name, agent, toolAnnotations) =>
      enqueue((current) => {
        commitTool(current, prepareAgent(current.sdk, name, agent, toolAnnotations));
      }),
    removeTool: (name) =>
      enqueue((current) => {
        if (!current.tools.delete(name)) return false;
        syncLive((session) => session.tools, name, undefined);
        publish({ kind: 'tools_list_changed' });
        return true;
      }),
    setResource: (name, resource) =>
      enqueue((current) => {
        const prepared = prepareResource(name, resource);
        for (const other of current.resources.values()) {
          if (other.name !== name && other.uri === prepared.uri) {
            throw new InvalidRequestError({
              message: `MCP server resource '${other.name}' already serves '${prepared.uri}' — remove it first, or set '${other.name}' instead.`,
            });
          }
        }
        current.resources.set(name, prepared);
        syncLive(
          (session) => (session.resourcesOn ? session.resources : undefined),
          name,
          (session) => registerResource(session.unit, current.sdk, prepared),
        );
        publish({ kind: 'resources_list_changed' });
      }),
    removeResource: (name) =>
      enqueue((current) => {
        if (!current.resources.delete(name)) return false;
        syncLive((session) => session.resources, name, undefined);
        publish({ kind: 'resources_list_changed' });
        return true;
      }),
    setResourceTemplate: (name, template) =>
      enqueue((current) => {
        const prepared = prepareTemplate(current.sdk, name, template);
        current.templates.set(name, prepared);
        syncLive(
          (session) => (session.resourcesOn ? session.templates : undefined),
          name,
          // A connected instance cannot add the completions capability, so a
          // session that did not start with it gets the template without them.
          (session) => registerTemplate(session.unit, current.sdk, prepared, session.completionsOn),
        );
        publish({ kind: 'resources_list_changed' });
      }),
    removeResourceTemplate: (name) =>
      enqueue((current) => {
        if (!current.templates.delete(name)) return false;
        syncLive((session) => session.templates, name, undefined);
        publish({ kind: 'resources_list_changed' });
        return true;
      }),
    setPrompt: (name, prompt) =>
      enqueue((current) => {
        const prepared = preparePrompt(name, prompt);
        current.prompts.set(name, prepared);
        syncLive(
          (session) => (session.promptsOn ? session.prompts : undefined),
          name,
          (session) => registerPrompt(session.unit, prepared),
        );
        publish({ kind: 'prompts_list_changed' });
      }),
    removePrompt: (name) =>
      enqueue((current) => {
        if (!current.prompts.delete(name)) return false;
        syncLive((session) => session.prompts, name, undefined);
        publish({ kind: 'prompts_list_changed' });
        return true;
      }),
    resourceUpdated: async (uri) => {
      const { current, due } = await enqueue((current) => {
        const forms = uriForms(uri);
        const due: Array<{ session: LiveSession; form: string }> = [];
        for (const session of live) {
          if (!session.resourcesOn) continue;
          for (const form of forms) {
            // A 2026-07-28 stdio session routes the notification onto its
            // listen subscriptions (dropping it when none names the URI); a
            // 2025-era session gets it only for a URI it subscribed to.
            if (session.unit.era === 'legacy' && !session.subscriptions.has(form)) continue;
            due.push({ session, form });
          }
        }
        // HTTP listen streams check each update themselves (see `fetch`).
        for (const form of forms) publish({ kind: 'resource_updated', uri: form });
        return { current, due };
      });
      // Outside the queue: a slow `read` must not hold up catalog changes.
      // A stdio connection has one identity, so one check per connection.
      const signal = new AbortController().signal;
      await Promise.all(
        due.map(async ({ session, form }) => {
          const request: McpServerRequest = {
            transport: session.unit.transport,
            era: session.unit.era,
          };
          if (!(await readableBy(current, form, request, signal)) || !live.has(session)) return;
          session.unit.instance.server.sendResourceUpdated({ uri: form }).catch(report);
        }),
      );
    },
  };
  Object.freeze(catalog);

  /**
   * A 2025-era `tools/call` body with `params.task`, lifted for the SDK —
   * `undefined` for anything else. A 2026-07-28 request (it must send
   * `Mcp-Method`) is never read here. The body is read from a clone, at most
   * `maxRequestBodySize` bytes, so the SDK's own limits still hold.
   */
  async function liftHttpTaskRequest(
    request: Request,
    fetchOptions: McpServerFetchOptions | undefined,
  ): Promise<{ parsedBody: unknown } | undefined> {
    if (fetchOptions?.parsedBody !== undefined) {
      const lifted = liftLegacyTaskParam(fetchOptions.parsedBody);
      return lifted === fetchOptions.parsedBody ? undefined : { parsedBody: lifted };
    }
    if (request.method.toUpperCase() !== 'POST' || request.headers.has('mcp-method')) {
      return undefined;
    }
    if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
      return undefined;
    }
    const text = await readBounded(request.clone(), options.maxRequestBodySize ?? 4 * 1024 * 1024);
    if (text === undefined || !text.includes('"task"')) return undefined;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return undefined; // the SDK answers the parse error
    }
    const lifted = liftLegacyTaskParam(body);
    return lifted === body ? undefined : { parsedBody: lifted };
  }

  let closed = false;
  const server: DeuzMcpServer = {
    fetch: async (request, fetchOptions) => {
      let served: V2HttpHandler;
      try {
        served = await httpHandler();
      } catch (error) {
        report(error);
        return Response.json(
          { jsonrpc: '2.0', id: null, error: { code: -32603, message: messageOf(error) } },
          { status: 500 },
        );
      }
      // A 2025-era task request's `params.task` must reach the tool (see `./tasks.ts`).
      const lifted = taskRuntime ? await liftHttpTaskRequest(request, fetchOptions) : undefined;
      const parsedBody = lifted !== undefined ? lifted.parsedBody : fetchOptions?.parsedBody;
      const forwarded: McpServerFetchOptions = {
        ...(fetchOptions?.authInfo !== undefined ? { authInfo: fetchOptions.authInfo } : {}),
        ...(parsedBody !== undefined ? { parsedBody } : {}),
      };
      const response = await served.fetch(request, forwarded);
      // A 2026-07-28 listen stream: the SDK's router matches each update to
      // the filter by URI only, so every `resources/updated` it would carry is
      // checked against this caller's read first. A modern request must send
      // `Mcp-Method` equal to its body's method, so the header identifies it.
      const listening =
        request.method.toUpperCase() === 'POST' &&
        request.headers.get('mcp-method')?.trim() === LISTEN_METHOD &&
        (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
      if (!listening) return response;
      const caller: McpServerRequest = {
        transport: 'http',
        era: 'modern',
        ...(fetchOptions?.authInfo !== undefined ? { authInfo: fetchOptions.authInfo } : {}),
        request,
      };
      return filterListenStream(response, async (uri) =>
        readableBy(await prepare(), uri, caller, request.signal),
      );
    },
    ready: internals.ready,
    async close() {
      if (closed) return;
      closed = true;
      await taskRuntime?.close();
      const served = await handler?.catch(() => undefined);
      await served?.close();
    },
    catalog,
  };
  Object.defineProperty(server, MCP_SERVER_INTERNALS, { value: internals });
  return Object.freeze(server);
}
