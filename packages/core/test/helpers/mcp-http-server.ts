/**
 * mcp-http-server.ts — an in-process, streamable-HTTP MCP server for tests.
 *
 * `test/mcp-stdio.test.ts` proved the stdio client against a REAL child process;
 * this is the same bargain for the HTTP transport: a real `node:http` listener on
 * 127.0.0.1, the real `@modelcontextprotocol/sdk` server transport, real SSE
 * framing. Nothing about the wire is faked, so a test that passes here would pass
 * against a hosted MCP server. The only shortcut is the listener address.
 *
 * It deliberately drives the LOW-LEVEL `Server` rather than the high-level
 * `McpServer`: `McpServer.registerTool` only accepts Zod schemas and re-derives
 * JSON Schema from them (adding `$schema` and friends), whereas MCP `inputSchema`
 * IS raw JSON Schema and our `listTools()` hands it straight to `Tool.parameters`.
 * Tests need to pin that byte-for-byte, so `TestToolSpec.inputSchema` travels to
 * the client untouched.
 *
 * What it gives the 2.0 MCP tests beyond a plain connect:
 *
 * - `addTool` / `removeTool` — mutate the catalog mid-run and push
 *   `notifications/tools/list_changed`, the trigger the lifecycle layer's
 *   hot-refresh depends on.
 * - `restart()` — drop every socket and listen AGAIN ON THE SAME PORT, so a
 *   reconnect test observes exactly what a server redeploy looks like from the
 *   client side (old session ids gone, the URL still valid).
 * - `requestSampling` / `listClientRoots` — server→client requests, i.e. the two
 *   directions of traffic that only exist once the client has opened its
 *   standalone GET SSE stream.
 * - `requireBearer` — a 401 carrying `WWW-Authenticate: Bearer resource_metadata=…`
 *   plus (with `authorizationServers`) a valid RFC 9728 document at that URL, which
 *   is the entire discovery half of the OAuth flow.
 *
 * Every handle owns exactly one listener; `close()` is idempotent and MUST run in
 * an `afterEach`/`afterAll` or the vitest worker keeps the port.
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type CreateMessageRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool arguments as they come off the wire — always a JSON object, never typed
 * more precisely. (`any` would be friendlier to write against, but this package
 * has zero `any` in `src/` or `test/` and lint keeps it that way; a handler that
 * wants a string writes `String(args.value)`.)
 */
export type TestToolArgs = Record<string, unknown>;

/** One tool the fixture server exposes. */
export interface TestToolSpec {
  name: string;
  description?: string;
  /**
   * Raw JSON Schema, forwarded to `tools/list` VERBATIM. MCP requires a root
   * `{ type: 'object' }`; omitting it yields `{ type: 'object', properties: {} }`.
   */
  inputSchema?: unknown;
  /**
   * Runs on `tools/call`. The return value is mapped to a `CallToolResult`:
   * a string becomes one text block; a plain object becomes `structuredContent`
   * plus its JSON serialization as text; `undefined` becomes empty content.
   * A value that already looks like a `CallToolResult` (an object with an array
   * `content` field) is sent as-is — that is the escape hatch for pinning exact
   * wire shapes. THROWING yields `{ isError: true }` with the message as text,
   * which is what the tool loop's self-heal path consumes.
   */
  handler: (args: TestToolArgs) => unknown | Promise<unknown>;
}

/** A recorded `tools/call`, in arrival order. */
export interface TestToolCall {
  name: string;
  args: TestToolArgs;
}

export interface TestMcpServerOptions {
  /** Defaults to {@link DEFAULT_TEST_TOOLS}. Pass `[]` for a catalog-less server. */
  tools?: TestToolSpec[];
  /** Reject any request whose `Authorization` is not exactly `Bearer <this>` with a 401. */
  requireBearer?: string;
  /**
   * Custom bearer predicate; wins over `requireBearer`. Use it to hand the gate to
   * a fake authorization server: `authorizeToken: (t) => as.isValidAccessToken(t)`.
   */
  authorizeToken?: (token: string | undefined) => boolean;
  /**
   * Advertised as `resource_metadata="…"` on the 401. Defaults to this server's own
   * `/.well-known/oauth-protected-resource`, which it also serves.
   */
  resourceMetadataUrl?: string;
  /** `authorization_servers` in the RFC 9728 document (i.e. where the fake AS lives). */
  authorizationServers?: string[];
  /** `scopes_supported` in the RFC 9728 document; drives the SDK's scope selection. */
  scopesSupported?: string[];
  /** `serverInfo.name` — the namespace fallback `resolveMcpForLoop` derives prefixes from. */
  name?: string;
  /** `serverInfo.version`. */
  version?: string;
}

export interface TestMcpServerHandle {
  /** The MCP endpoint, e.g. `http://127.0.0.1:53124/mcp`. Stable across `restart()`. */
  url: string;
  port: number;
  /** Every `tools/call` this server has served, in order. */
  calls: TestToolCall[];
  /** Add (or replace) a tool and push `notifications/tools/list_changed`. */
  addTool(spec: TestToolSpec): void;
  /** Drop a tool and push `notifications/tools/list_changed`. No-op if absent. */
  removeTool(name: string): void;
  /** Drive `sampling/createMessage` on the most recently initialized session. */
  requestSampling(params: unknown): Promise<unknown>;
  /** Drive `roots/list` on the most recently initialized session. */
  listClientRoots(): Promise<unknown>;
  /** Number of MCP sessions currently initialized. */
  sessionCount(): number;
  /**
   * Resolve once a client has opened its standalone GET SSE stream — the channel
   * server→client notifications and requests travel on. `connect()` returns before
   * that stream exists, so anything pushed immediately after would be dropped.
   */
  waitForClientStream(timeoutMs?: number): Promise<void>;
  /** Kill every socket and session, then listen again ON THE SAME PORT. */
  restart(): Promise<void>;
  /** Idempotent teardown. Always call it. */
  close(): Promise<void>;
}

/** Root JSON Schema used when a spec omits `inputSchema`. */
const EMPTY_INPUT_SCHEMA = { type: 'object', properties: {} };

/**
 * The default catalog: one string round-trip, one structured result, one thrower.
 * Exported so a test can extend it instead of restating it.
 */
export const DEFAULT_TEST_TOOLS: TestToolSpec[] = [
  {
    name: 'echo',
    description: 'Echo a value back.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'Text to echo.' } },
      required: ['value'],
      additionalProperties: false,
    },
    handler: (args) => `echo:${String(args.value)}`,
  },
  {
    name: 'add',
    description: 'Add two numbers, structured.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    handler: (args) => ({ sum: Number(args.a) + Number(args.b) }),
  },
  {
    name: 'boom',
    description: 'Always fails.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      throw new Error('tool exploded');
    },
  },
];

/** Session ids are a counter, not a UUID: deterministic, and a stale id never collides. */
let sessionSeq = 0;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does the handler's return value already spell out a full `CallToolResult`? */
function isRawCallToolResult(value: unknown): value is CallToolResult {
  return isPlainObject(value) && Array.isArray(value.content);
}

function toCallToolResult(value: unknown): CallToolResult {
  if (isRawCallToolResult(value)) return value;
  if (value === undefined) return { content: [] };
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (isPlainObject(value)) {
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** One live MCP session: its transport and the `Server` bound to it. */
interface Session {
  id: string;
  server: McpProtocolServer;
  transport: StreamableHTTPServerTransport;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Start an MCP server on an ephemeral 127.0.0.1 port and resolve once it is
 * accepting connections. The returned handle owns the listener; `close()` it.
 */
export async function startTestMcpServer(
  opts: TestMcpServerOptions = {},
): Promise<TestMcpServerHandle> {
  const tools = new Map<string, TestToolSpec>();
  for (const spec of opts.tools ?? DEFAULT_TEST_TOOLS) tools.set(spec.name, spec);

  const calls: TestToolCall[] = [];
  const sessions = new Map<string, Session>();
  const sockets = new Set<Socket>();
  let latest: Session | undefined;
  let closed = false;

  /** Set once a standalone GET SSE stream is live (see {@link noteClientStream}). */
  let clientStreamReady = false;
  let streamWaiters: Array<() => void> = [];
  let streamSettle: ReturnType<typeof setTimeout> | undefined;

  let httpServer: HttpServer;
  let port = 0;

  const origin = (): string => `http://127.0.0.1:${port}`;
  const resourceMetadataUrl = (): string =>
    opts.resourceMetadataUrl ?? `${origin()}/.well-known/oauth-protected-resource`;

  function protectedResourceMetadata(): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      resource: `${origin()}/mcp`,
      bearer_methods_supported: ['header'],
    };
    if (opts.authorizationServers) doc.authorization_servers = opts.authorizationServers;
    if (opts.scopesSupported) doc.scopes_supported = opts.scopesSupported;
    return doc;
  }

  /** `true` when the request may proceed; `false` means a 401 was already written. */
  function authorized(req: IncomingMessage, res: ServerResponse): boolean {
    const gate = opts.authorizeToken;
    if (!gate && opts.requireBearer === undefined) return true;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const ok = gate ? gate(token) : token === opts.requireBearer;
    if (ok) return true;
    json(
      res,
      401,
      { error: 'invalid_token', error_description: 'Missing or invalid bearer token.' },
      { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}"` },
    );
    return false;
  }

  /**
   * A GET landed on our listener, but the SDK registers the standalone stream a
   * few ticks later (hono's Node→Web request conversion, then `handleGetRequest`).
   * A message sent in that window is dropped silently, so the "ready" edge is
   * deliberately delayed past it rather than fired on arrival.
   */
  function noteClientStream(): void {
    if (clientStreamReady || streamSettle) return;
    streamSettle = setTimeout(() => {
      streamSettle = undefined;
      clientStreamReady = true;
      const waiters = streamWaiters;
      streamWaiters = [];
      for (const resolve of waiters) resolve();
    }, 25);
  }

  function createSession(): Session {
    const server = new McpProtocolServer(
      { name: opts.name ?? 'deuz-test-mcp', version: opts.version ?? '0.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...tools.values()].map((spec) => {
        const tool: Tool = {
          name: spec.name,
          inputSchema: (spec.inputSchema ?? EMPTY_INPUT_SCHEMA) as Tool['inputSchema'],
        };
        if (spec.description !== undefined) tool.description = spec.description;
        return tool;
      }),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const spec = tools.get(name);
      // Not-found is a PROTOCOL error, not an `isError` result — the MCP spec
      // reserves `isError` for failures the model should try to recover from.
      if (!spec) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${name}`);
      const parsed: TestToolArgs = isPlainObject(args) ? args : {};
      calls.push({ name, args: parsed });
      try {
        return toCallToolResult(await spec.handler(parsed));
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
        };
      }
    });

    const id = `sess-${++sessionSeq}`;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: () => {
        const session = { id, server, transport };
        sessions.set(id, session);
        latest = session;
      },
    });
    transport.onclose = () => {
      sessions.delete(id);
      if (latest?.id === id) latest = [...sessions.values()].pop();
    };
    return { id, server, transport };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    // Discovery is public by definition — it is what a 401 points AT.
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, protectedResourceMetadata());
      return;
    }
    if (path !== '/mcp') {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (!authorized(req, res)) return;

    const header = req.headers['mcp-session-id'];
    const sid = typeof header === 'string' ? header : undefined;
    const known = sid ? sessions.get(sid) : undefined;
    if (known) {
      if (req.method === 'GET') noteClientStream();
      await known.transport.handleRequest(req, res);
      return;
    }
    if (sid) {
      // A session id we have never heard of (typical after `restart()`): 404 is the
      // spec'd signal that the client must re-initialize.
      json(res, 404, { error: 'session_not_found' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 400, { error: 'bad_request', error_description: 'Missing mcp-session-id.' });
      return;
    }

    // No session id + POST: an initialize attempt. The transport itself rejects
    // anything else, so a session only lands in the map when it really initialized.
    const session = createSession();
    await session.server.connect(session.transport);
    await session.transport.handleRequest(req, res);
    if (!session.transport.sessionId || !sessions.has(session.id)) {
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
    }
  }

  function listener(req: IncomingMessage, res: ServerResponse): void {
    // A GET SSE stream never "finishes" until the socket dies, and a `restart()`
    // kills sockets under an in-flight handler — both surface as rejections here
    // and neither is a test failure.
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"harness_failure"}');
    });
  }

  async function listen(desiredPort: number): Promise<void> {
    httpServer = createServer(listener);
    httpServer.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(desiredPort, '127.0.0.1', () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });
    port = (httpServer.address() as AddressInfo).port;
  }

  async function stopSessions(): Promise<void> {
    const live = [...sessions.values()];
    sessions.clear();
    latest = undefined;
    for (const session of live) {
      await session.server.close().catch(() => {});
      await session.transport.close().catch(() => {});
    }
  }

  async function stopListener(): Promise<void> {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  function notifyToolListChanged(): void {
    for (const session of sessions.values()) {
      // No client attached yet (or the stream just died) — the notification is
      // best-effort by design; the tool cache is re-read on the next list anyway.
      void session.server.sendToolListChanged().catch(() => {});
    }
  }

  function currentSession(): Session {
    if (!latest) {
      throw new Error(
        'No MCP session is initialized — connect a client (and await waitForClientStream()) first.',
      );
    }
    return latest;
  }

  await listen(0);

  return {
    get url() {
      return `${origin()}/mcp`;
    },
    get port() {
      return port;
    },
    calls,
    addTool(spec: TestToolSpec) {
      tools.set(spec.name, spec);
      notifyToolListChanged();
    },
    removeTool(name: string) {
      if (!tools.delete(name)) return;
      notifyToolListChanged();
    },
    async requestSampling(params: unknown) {
      return currentSession().server.createMessage(params as CreateMessageRequest['params']);
    },
    async listClientRoots() {
      return currentSession().server.listRoots();
    },
    sessionCount() {
      return sessions.size;
    },
    waitForClientStream(timeoutMs = 5_000) {
      if (clientStreamReady) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          streamWaiters = streamWaiters.filter((w) => w !== onStream);
          reject(new Error(`No client opened a GET SSE stream within ${timeoutMs}ms.`));
        }, timeoutMs);
        const onStream = (): void => {
          clearTimeout(timer);
          resolve();
        };
        streamWaiters.push(onStream);
      });
    },
    async restart() {
      if (closed) throw new Error('Cannot restart a closed test MCP server.');
      const same = port;
      await stopSessions();
      await stopListener();
      if (streamSettle) clearTimeout(streamSettle);
      streamSettle = undefined;
      clientStreamReady = false;
      streamWaiters = [];
      await listen(same);
    },
    async close() {
      if (closed) return;
      closed = true;
      await stopSessions();
      await stopListener();
      if (streamSettle) clearTimeout(streamSettle);
      streamSettle = undefined;
      streamWaiters = [];
    },
  };
}
