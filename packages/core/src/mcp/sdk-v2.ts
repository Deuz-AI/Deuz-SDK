/**
 * mcp/sdk-v2.ts (2.3) — the v2 SDK line: MCP 2026-07-28 through
 * `@modelcontextprotocol/client`, behind the same `RawMcpClient` seam the v1
 * line uses, so `createManagedConnection`, `wrapMcpClient` and every
 * `ToolSet` they produce are shared by both lines unchanged.
 *
 * What differs from v1, and is absorbed HERE:
 *
 * - Handlers register by METHOD NAME (`'elicitation/create'`), not by the v1
 *   SDK's Zod request schemas — Deuz never imports Zod from the peer.
 * - `versionNegotiation` (default `'auto'`): the client probes `server/discover`
 *   and speaks 2026-07-28 to a modern server, falling back to the 2025-era
 *   `initialize` handshake otherwise.
 * - The 2026-07-28 era has no server→client request channel. Elicitation,
 *   sampling and roots arrive as `input_required` results that the SDK fulfils
 *   through the SAME registered handlers and retries for us, so they work on
 *   both eras with no extra code.
 * - The modern era removed `ping` and `notifications/roots/list_changed`, and it
 *   delivers `notifications/tools/list_changed` only on a `subscriptions/listen`
 *   stream. The adapter maps `ping()` (the keepalive and the onerror liveness
 *   probe) to `server/discover`, turns `sendRootsListChanged()` into a no-op —
 *   the server reads the CURRENT roots on its next `roots/list` input request —
 *   and opens the listen stream after connect.
 *
 * Reached only through a literal `import('./sdk-v2')`, so a v1 client never
 * downloads this chunk. Edge-safe: the peer is a computed specifier, never
 * bundled. The Node-only stdio transport lives in `./stdio`.
 */
import { InvalidRequestError } from '../errors';
import {
  buildElicitationHandler,
  buildRootsHandler,
  buildSamplingHandler,
  type McpCallResult,
  type McpClientHooks,
  type McpElicitationHandler,
  type McpGetPromptResult,
  type McpPrompt,
  type McpResource,
  type McpResourceContent,
  type McpRootsBox,
  type McpSamplingOptions,
  type McpToolDef,
  type McpVersionNegotiation,
  type RawMcpClient,
} from './shared';
import { NO_V2_SDK_MESSAGE, V2_CLIENT_PACKAGE } from './sdk-line';

/** A `subscriptions/listen` handle, mirrored from the v2 SDK's `McpSubscription`. */
interface V2Subscription {
  close(): Promise<void>;
  readonly closed: Promise<'local' | 'graceful' | 'remote'>;
}

/**
 * The slice of the v2 `Client` we drive, mirrored STRUCTURALLY: the optional
 * peer's types must never reach our public `.d.ts`.
 */
interface V2Client {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult>;
  listTools(params?: { cursor?: string }): Promise<{ tools: McpToolDef[]; nextCursor?: string }>;
  listResources(params?: {
    cursor?: string;
  }): Promise<{ resources: McpResource[]; nextCursor?: string }>;
  readResource(params: { uri: string }): Promise<{ contents: McpResourceContent[] }>;
  listPrompts(params?: { cursor?: string }): Promise<{ prompts: McpPrompt[]; nextCursor?: string }>;
  getPrompt(params: {
    name: string;
    arguments?: Record<string, string>;
  }): Promise<McpGetPromptResult>;
  ping(): Promise<unknown>;
  discover(): Promise<unknown>;
  listen(filter: { toolsListChanged?: boolean }): Promise<V2Subscription>;
  setRequestHandler(
    method: string,
    handler: (request: { params: Record<string, unknown> }) => unknown,
  ): void;
  setNotificationHandler(method: string, handler: () => void): void;
  sendRootsListChanged(): Promise<void>;
  getServerVersion(): { name?: string; version?: string } | undefined;
  getServerCapabilities(): { tools?: { listChanged?: boolean } } | undefined;
  getNegotiatedProtocolVersion(): string | undefined;
  getProtocolEra(): 'legacy' | 'modern' | undefined;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

type V2TransportCtor = new (url: URL, options?: Record<string, unknown>) => unknown;

interface V2ClientModule {
  Client: new (
    info: { name: string; version: string },
    options?: Record<string, unknown>,
  ) => V2Client;
  StreamableHTTPClientTransport: V2TransportCtor;
  SSEClientTransport: V2TransportCtor;
}

/** Import the v2 client package, or explain how to install it. */
export async function loadV2Client(): Promise<V2ClientModule> {
  try {
    const spec: string = V2_CLIENT_PACKAGE;
    return (await import(spec)) as V2ClientModule;
  } catch (err) {
    throw new InvalidRequestError({ message: NO_V2_SDK_MESSAGE, cause: err });
  }
}

/** What a v2 client is built from — the transport-independent half of the options. */
export interface V2ClientOptions {
  name?: string;
  version?: string;
  onElicitationRequest?: McpElicitationHandler;
  sampling?: McpSamplingOptions;
  versionNegotiation?: McpVersionNegotiation;
}

/** The HTTP half — `McpHttpTransport` in `./index`. */
export interface V2HttpTransportOptions {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** Build one v2 HTTP transport (single-use, like every transport). */
export async function makeV2HttpTransport(
  t: V2HttpTransportOptions,
  authProvider?: unknown,
): Promise<unknown> {
  const mod = await loadV2Client();
  const options = {
    ...(t.headers ? { requestInit: { headers: t.headers } } : {}),
    ...(authProvider ? { authProvider } : {}),
    ...(t.fetch ? { fetch: t.fetch } : {}),
  };
  const Transport = t.type === 'sse' ? mod.SSEClientTransport : mod.StreamableHTTPClientTransport;
  return new Transport(new URL(t.url), options);
}

/**
 * Unexpected ends of the listen stream tolerated in a row before the adapter
 * stops re-opening it and lets the liveness probe decide. A server that ends
 * every subscription immediately must not spin a re-listen loop forever.
 */
const MAX_LISTEN_REOPENS = 3;

/**
 * Build ONE fresh, unconnected v2 client with every handler registered — the
 * v2 twin of the v1 factories in `./index` and `./stdio`, called again for every
 * reconnect attempt so each new session gets every handler back.
 *
 * `rootsBox` is the client-lifetime box `setRoots()` swaps: the handler reads it
 * on every `roots/list`, so a swap survives a reconnect without re-registering.
 */
export async function makeV2Client(
  options: V2ClientOptions,
  hooks: McpClientHooks,
  rootsBox: McpRootsBox | undefined,
): Promise<RawMcpClient> {
  const { Client } = await loadV2Client();
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    {
      // Same gating as the v1 factories: never declare a capability whose
      // handler is missing, and `roots: []` is a value, not an absence.
      capabilities: {
        ...(options.onElicitationRequest !== undefined
          ? { elicitation: { form: {}, url: {} } }
          : {}),
        ...(options.sampling !== undefined ? { sampling: {} } : {}),
        ...(rootsBox !== undefined ? { roots: { listChanged: true } } : {}),
      },
      versionNegotiation: { mode: options.versionNegotiation ?? 'auto' },
    },
  );
  if (options.onElicitationRequest !== undefined) {
    client.setRequestHandler(
      'elicitation/create',
      buildElicitationHandler(options.onElicitationRequest),
    );
  }
  if (options.sampling !== undefined) {
    client.setRequestHandler('sampling/createMessage', buildSamplingHandler(options.sampling));
  }
  if (rootsBox !== undefined) client.setRequestHandler('roots/list', buildRootsHandler(rootsBox));

  let reopens = 0;
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    reopens = 0; // a stream that delivers is a healthy one
    hooks.toolListChanged();
  });

  const modern = (): boolean => client.getProtocolEra() === 'modern';
  let closing = false;
  const report = (error: unknown): void => {
    client.onerror?.(error instanceof Error ? error : new Error(String(error)));
  };

  /**
   * Open the modern era's `subscriptions/listen` stream for tool-list changes —
   * the only road `notifications/tools/list_changed` travels on 2026-07-28. A
   * legacy-era connection gets them unsolicited, and a server that does not
   * advertise `tools.listChanged` has nothing to send.
   */
  const listen = async (): Promise<void> => {
    if (!modern() || !client.getServerCapabilities()?.tools?.listChanged) return;
    const subscription = await client.listen({ toolsListChanged: true });
    void subscription.closed.then((how) => {
      if (closing || how === 'local') return;
      // A notification may have been lost while the stream was down: drop the
      // tool cache so the next listTools() refetches, then listen again.
      hooks.toolListChanged();
      if (++reopens > MAX_LISTEN_REOPENS) {
        report(new Error('The MCP subscriptions/listen stream keeps ending.'));
        return;
      }
      // A failed re-listen is reported, not thrown: the managed connection's
      // liveness probe then decides whether the whole session is gone.
      void listen().catch(report);
    });
  };

  const adapter: RawMcpClient = {
    async connect(transport) {
      await client.connect(transport);
      // A server that refuses the stream still serves tools; only the tool cache
      // loses its push invalidation, which a reconnect restores.
      await listen().catch(report);
    },
    callTool: (req) =>
      client.callTool({
        name: req.name,
        ...(req.arguments !== undefined
          ? { arguments: req.arguments as Record<string, unknown> }
          : {}),
      }),
    listTools: (params) => client.listTools(params),
    async close() {
      closing = true;
      await client.close();
    },
    // The 2026-07-28 era removed `ping`; `server/discover` is the cheapest
    // request every modern server must answer, so liveness checks keep working.
    ping: () => (modern() ? client.discover() : client.ping()),
    // Not on the 2026-07-28 wire. Nothing is lost: on that era the server asks
    // for roots per request, and the handler reads the box swapped just before.
    sendRootsListChanged: () => (modern() ? Promise.resolve() : client.sendRootsListChanged()),
    getServerVersion: () => client.getServerVersion(),
    getNegotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
    listResources: (params) => client.listResources(params),
    readResource: (params) => client.readResource(params),
    listPrompts: (params) => client.listPrompts(params),
    getPrompt: (params) => client.getPrompt(params),
    // The managed connection installs its drop detection through these two, so
    // they must land on the SDK client itself.
    get onclose() {
      return client.onclose;
    },
    set onclose(handler) {
      client.onclose = handler;
    },
    get onerror() {
      return client.onerror;
    },
    set onerror(handler) {
      client.onerror = handler;
    },
  };
  return adapter;
}
