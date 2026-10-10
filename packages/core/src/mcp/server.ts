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
 * Edge-safe: Web APIs only, the peer is a computed specifier, and the heavy
 * native modules (`agent-run`, `inference/agent-tools`) load only when an
 * `agents`/`agentTools` entry is configured.
 */
import { InvalidRequestError } from '../errors';
import { isStandardSchema, toJSONSchema, validateOutput } from '../schema/bridge';
import { combineSignals } from '../core/timeout';
import { resolveDependencies } from '../internal/resolve-deps';
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

/** Where a served call came from — what `runtimeContext`, `toolsContext` and `approve` see. */
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
  /** MCP tool annotations by tool name. A name that is not served is rejected. */
  toolAnnotations?: Record<string, McpToolAnnotations>;
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
   * Out-of-band failures: a request the SDK rejected, a missing peer. Reporting
   * only — it never changes a response. A throwing callback is swallowed.
   */
  onError?: (error: Error) => void;
  /** Time source for `Tool.timeoutMs`. Default: the host clock. */
  clock?: Clock;
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

interface V2McpServer {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    callback: (args: unknown, ctx: V2ToolContext) => Promise<unknown>,
  ): unknown;
  readonly server: { getClientCapabilities?(): Record<string, unknown> | undefined };
}

interface V2HttpHandler {
  fetch(request: Request, options?: McpServerFetchOptions): Promise<Response>;
  close(): Promise<void>;
}

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
  const executable = (name: string, tool: { type?: string; execute?: unknown }): void => {
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
  };
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
  /** The canonical tool for this call (an `agentTools` entry may bind a per-call context). */
  resolve(request: McpServerRequest): Promise<Tool>;
}

interface Prepared {
  sdk: V2ServerModule;
  entries: ServedEntry[];
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

  let prepared: Promise<Prepared> | undefined;
  const prepare = (): Promise<Prepared> => (prepared ??= prepareAll());

  async function prepareAll(): Promise<Prepared> {
    const sdk = await loadV2Server();
    const entries: ServedEntry[] = [];
    const meta = (name: string, description: string | undefined): Record<string, unknown> => ({
      ...(description ? { description } : {}),
      ...(annotations[name] ? { annotations: annotations[name] } : {}),
    });

    for (const [name, tool] of Object.entries(options.tools ?? {})) {
      entries.push({
        name,
        config: {
          ...meta(name, tool.description),
          inputSchema: await inputSchemaFor(sdk, name, tool.parameters),
          ...(tool.outputSchema
            ? { outputSchema: sdk.fromJsonSchema(tool.outputSchema as Record<string, unknown>) }
            : {}),
        },
        hasOutputSchema: tool.outputSchema !== undefined,
        resolve: async () => tool,
      });
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
        entries.push({
          name,
          config: {
            ...meta(name, agentTool.description),
            inputSchema: await inputSchemaFor(sdk, name, agentTool.parameters),
            ...(advertised
              ? { outputSchema: sdk.fromJsonSchema(advertised as Record<string, unknown>) }
              : {}),
          },
          hasOutputSchema: advertised !== undefined,
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
      entries.push({
        name,
        config: {
          ...meta(name, def.description),
          inputSchema: sdk.fromJsonSchema(PROMPT_SCHEMA as Record<string, unknown>),
        },
        hasOutputSchema: false,
        resolve: async (request) => servedAgentTool(name, def, request),
      });
    }
    return { sdk, entries };
  }

  /** One served `tools/call` — the pipeline in the module header. */
  async function serveCall(
    sdk: V2ServerModule,
    entry: ServedEntry,
    args: unknown,
    ctx: V2ToolContext,
    instance: V2McpServer,
    unit: { transport: McpServerTransportKind; era: McpServerEra },
  ): Promise<unknown> {
    const request: McpServerRequest = {
      transport: unit.transport,
      era: unit.era,
      ...(ctx.http?.authInfo ? { authInfo: ctx.http.authInfo } : {}),
      ...(ctx.http?.req ? { request: ctx.http.req } : {}),
    };
    try {
      const base =
        options.runtimeContext !== undefined
          ? { runtimeContext: await options.runtimeContext(request) }
          : {};
      const tool = await entry.resolve(request);
      const execCtx: ToolExecuteContext = {
        toolCallId: `mcp-${String(ctx.mcpReq.id)}`,
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
      const needs = typeof gate === 'function' ? await gate(call.args, execCtx) : gate === true;
      if (needs) {
        const decision = await decide(sdk, call, request, ctx, instance);
        if (decision.kind === 'ask') return decision.result;
        if (decision.kind === 'denied') {
          return errorResult(
            decision.reason ? `${TOOL_DENIED} Reason: ${decision.reason}` : TOOL_DENIED,
          );
        }
      }

      const validation = await validateOutput(tool.parameters, call.args);
      if (!validation.ok) return errorResult(`Invalid arguments: ${validation.issues}`);

      let outcome: { result: unknown; isError: boolean };
      try {
        const ran = await runWithTimeout(
          clock,
          tool.timeoutMs,
          entry.name,
          async (signal) =>
            tool.execute!(validation.value, signal ? { ...execCtx, signal } : execCtx),
          ctx.mcpReq.signal,
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
    } catch (error) {
      // A failing runtimeContext/toolsContext/approve/guardrail is the call's
      // failure, answered like a throwing tool — never a dropped request.
      return errorResult(messageOf(error));
    }
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
      return (await approve({ toolName: call.toolName, args: call.args, request }))
        ? { kind: 'approved' }
        : { kind: 'denied' };
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

  const internals: McpServerInternals = {
    ready: async () => {
      await prepare();
    },
    factory:
      (transport) =>
      async ({ era }) => {
        const { sdk, entries } = await prepare();
        const instance = new sdk.McpServer(
          { name: options.name, version: options.version ?? '0.0.0' },
          {
            capabilities: { tools: {} },
            ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
          },
        );
        for (const entry of entries) {
          instance.registerTool(entry.name, entry.config, (args, ctx) =>
            serveCall(sdk, entry, args, ctx, instance, { transport, era }),
          );
        }
        return instance;
      },
    report,
  };

  let handler: Promise<V2HttpHandler> | undefined;
  const httpHandler = (): Promise<V2HttpHandler> =>
    (handler ??= prepare().then(({ sdk }) =>
      sdk.createMcpHandler(
        internals.factory('http') as (ctx: { era: McpServerEra }) => Promise<V2McpServer>,
        {
          legacy: options.legacy ?? 'stateless',
          onerror: report,
          ...(options.responseMode !== undefined ? { responseMode: options.responseMode } : {}),
          ...(options.maxRequestBodySize !== undefined
            ? { maxRequestBodySize: options.maxRequestBodySize }
            : {}),
        },
      ),
    ));

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
      const forwarded: McpServerFetchOptions = {
        ...(fetchOptions?.authInfo !== undefined ? { authInfo: fetchOptions.authInfo } : {}),
        ...(fetchOptions?.parsedBody !== undefined ? { parsedBody: fetchOptions.parsedBody } : {}),
      };
      return served.fetch(request, forwarded);
    },
    ready: internals.ready,
    async close() {
      if (closed) return;
      closed = true;
      const served = await handler?.catch(() => undefined);
      await served?.close();
    },
  };
  Object.defineProperty(server, MCP_SERVER_INTERNALS, { value: internals });
  return Object.freeze(server);
}
