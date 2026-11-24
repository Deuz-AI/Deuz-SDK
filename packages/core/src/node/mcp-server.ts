/**
 * `@deuz-sdk/core/mcp/server/stdio` (2.3) — serve a Deuz MCP server over stdio,
 * the transport a desktop client uses when it launches the server as a child
 * process.
 *
 * ```ts
 * #!/usr/bin/env node
 * import { createMcpServer } from '@deuz-sdk/core/mcp/server';
 * import { serveMcpStdio } from '@deuz-sdk/core/mcp/server/stdio';
 *
 * const server = createMcpServer({ name: 'notes', tools: { search, append } });
 * await serveMcpStdio(server); // the same handle `server.fetch` serves over HTTP
 * ```
 *
 * Built on the v2 SDK's `serveStdio` (`@modelcontextprotocol/server/stdio`):
 * the opening exchange pins the connection to ONE era — `server/discover` for
 * an MCP 2026-07-28 client, `initialize` for a 2025-era one — and a 2025-era
 * session is stateful, so a `needsApproval` tool CAN ask a 2025-11-25 client's
 * user here (the SDK sends a real `elicitation/create`), which stateless HTTP
 * cannot.
 *
 * Resources, URI templates and prompts (2.5) are served here exactly as over
 * HTTP, and a stdio connection is long-lived, so `server.catalog` changes reach
 * it: a 2025-era session gets the `list_changed` notifications pushed and may
 * `resources/subscribe`; a 2026-07-28 session receives them on the
 * `subscriptions/listen` streams it opens. A `resources/updated` goes out only
 * when the resource's `read` answers this connection's identity (its
 * `runtimeContext`): a `null` or a throw keeps the update from the client.
 *
 * MCP tasks (2.5, `tasks` / an agent's `task: true`) work on both eras here.
 * A 2025-11-25 session also gets `notifications/tasks/status` pushed as its
 * tasks change; a 2026-07-28 session polls `tasks/get` (its listen streams
 * cannot carry task notifications — see the `tasks` module of
 * `@deuz-sdk/core/mcp/server`). Tasks belong to the connection that created
 * them unless `tasks.owner` says otherwise, so a new connection cannot see an
 * earlier one's tasks.
 *
 * Never write to stdout from a stdio server: every byte there is protocol. Log
 * to stderr. Node-only (process streams), so it lives under `src/node/` and is
 * exempt from the edge-safety lint; the peer is a computed specifier.
 */
import { InvalidRequestError } from '../errors';
import { createMcpServer, type DeuzMcpServer, type McpServerOptions } from '../mcp/server';
import { readServerInternals } from '../mcp/server-internals';
import { liftLegacyTaskParam } from '../mcp/tasks';

export type {
  DeuzMcpServer,
  McpAgentRunOptions,
  McpAuthInfo,
  McpListedResource,
  McpPromptArgument,
  McpPromptContent,
  McpPromptMessage,
  McpPromptResult,
  McpResourceContent,
  McpResourceMetadata,
  McpResourceReadContext,
  McpResourceReadResult,
  McpServedAgent,
  McpServedContext,
  McpServedPrompt,
  McpServedResource,
  McpServedResourceTemplate,
  McpServerCatalog,
  McpServerEvent,
  McpServerEventBus,
  McpServerOptions,
  McpServerRequest,
  McpToolAnnotations,
  McpToolApprovalRequest,
  McpServerTasksOptions,
  McpTaskError,
  McpTaskPage,
  McpTaskRecord,
  McpTaskStatus,
  McpTaskStore,
  McpTaskUpdate,
} from '../mcp/server';

/**
 * What the stdio transport reads requests from: a Node `Readable` (a socket, a
 * `PassThrough`). Every member below is one the SDK's transport calls — a
 * look-alike missing any of them cannot be served on.
 */
export interface McpStdioReadable {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  pause(): unknown;
  readonly readableEnded: boolean;
  readonly destroyed: boolean;
}

/** What the stdio transport writes responses to: a Node `Writable` — see {@link McpStdioReadable}. */
export interface McpStdioWritable {
  write(chunk: string): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  listeners(event: string): unknown[];
}

export interface McpStdioServeOptions {
  /**
   * A 2025-era opening (`initialize`): `'serve'` (the default) pins the
   * connection to the 2025 era; `'reject'` answers it with the
   * unsupported-protocol-version error, for a 2026-07-28-only server.
   */
  legacy?: 'serve' | 'reject';
  /** Read requests from here instead of `process.stdin` — a socket, or a stream in tests. */
  stdin?: McpStdioReadable;
  /** Write responses here instead of `process.stdout`. */
  stdout?: McpStdioWritable;
  /**
   * Most `subscriptions/listen` streams a 2026-07-28 connection may hold open
   * at once (2.5). SDK default 1024.
   */
  maxSubscriptions?: number;
}

/** A running stdio server. */
export interface McpStdioServerHandle {
  /** Stop serving: close the pinned session and the transport. The streams stay open. */
  close(): Promise<void>;
}

const STDIO_PACKAGE = '@modelcontextprotocol/server/stdio';

interface V2StdioTransport {
  start(): Promise<void>;
}

interface V2StdioModule {
  serveStdio(
    factory: (ctx: { era: 'legacy' | 'modern' }) => Promise<unknown>,
    options?: Record<string, unknown>,
  ): { close(): Promise<void> };
  StdioServerTransport: new (
    stdin?: McpStdioReadable,
    stdout?: McpStdioWritable,
  ) => V2StdioTransport;
}

async function loadStdio(): Promise<V2StdioModule> {
  try {
    const spec: string = STDIO_PACKAGE;
    return (await import(spec)) as V2StdioModule;
  } catch (err) {
    throw new InvalidRequestError({
      message:
        'Serving MCP over stdio needs the optional peer "@modelcontextprotocol/server" (MCP 2026-07-28). Install it: npm i @modelcontextprotocol/server',
      cause: err,
    });
  }
}

/**
 * Serve `server` — a `createMcpServer` handle, or the options to build one — on
 * stdin/stdout. Every tool is prepared BEFORE the first byte is read, so a
 * broken definition rejects here instead of half-starting a server the client
 * then waits on. Resolves once serving has started.
 */
export async function serveMcpStdio(
  server: DeuzMcpServer | McpServerOptions,
  options: McpStdioServeOptions = {},
): Promise<McpStdioServerHandle> {
  const handle = readServerInternals(server) ? server : buildFromOptions(server);
  const internals = readServerInternals(handle);
  if (!internals) {
    throw new InvalidRequestError({
      message:
        'serveMcpStdio needs a server built by createMcpServer (from @deuz-sdk/core/mcp/server), or the options to build one.',
    });
  }
  await internals.ready();
  const stdio = await loadStdio();
  // Built here (an absent stream defaults to the process's own, as inside
  // serveStdio) so its start can be awaited: serveStdio starts the transport
  // before it returns but only REPORTS a failed start, which would resolve a
  // handle to a server that never reads a byte.
  const transport = new stdio.StdioServerTransport(options.stdin, options.stdout);
  liftTaskParams(transport);
  let starting: Promise<void> | undefined;
  const start = transport.start.bind(transport);
  transport.start = () => (starting = start());
  const served = stdio.serveStdio(internals.factory('stdio'), {
    legacy: options.legacy ?? 'serve',
    onerror: internals.report,
    transport,
    ...(options.maxSubscriptions !== undefined
      ? { maxSubscriptions: options.maxSubscriptions }
      : {}),
  });
  try {
    await starting;
  } catch (error) {
    await served.close().catch(() => {});
    const custom = options.stdin !== undefined || options.stdout !== undefined;
    throw new InvalidRequestError({
      message: custom
        ? 'serveMcpStdio could not start on the given stdin/stdout. Pass Node streams (a Readable and a Writable, such as a socket or a PassThrough): the stdio transport uses their whole stream API.'
        : 'serveMcpStdio could not start on process.stdin/process.stdout.',
      cause: error,
    });
  }
  return { close: () => served.close() };
}

type MessageHandler = (message: unknown, extra?: unknown) => void;

/**
 * Hand a 2025-era `tools/call`'s `params.task` to the served tool: the SDK
 * passes a tool only its arguments and `_meta`, so every inbound message goes
 * through `liftLegacyTaskParam` (a copy into `_meta`; anything else unchanged)
 * on its way to whatever `serveStdio` installs as the transport's `onmessage`.
 */
function liftTaskParams(transport: V2StdioTransport): void {
  let inner: MessageHandler | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: (): MessageHandler | undefined =>
      inner && ((message, extra) => inner!(liftLegacyTaskParam(message), extra)),
    set: (handler: MessageHandler | undefined) => {
      inner = handler;
    },
  });
}

/** Options build a server; anything else (a foreign handle) is refused by the caller. */
function buildFromOptions(value: DeuzMcpServer | McpServerOptions): DeuzMcpServer | undefined {
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? createMcpServer(value as McpServerOptions) : undefined;
}
