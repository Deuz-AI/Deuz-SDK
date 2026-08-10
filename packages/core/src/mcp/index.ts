import { InvalidRequestError, McpAuthorizationRequiredError } from '../errors';
import { bindOAuthServer, isUnauthorizedError, toOAuthProvider } from './auth';
import type { McpOAuthOptions, DeuzOAuthProvider } from '../types/config';
import {
  createManagedConnection,
  wrapMcpClient,
  buildElicitationHandler,
  buildSamplingHandler,
  buildRootsHandler,
  createRootsBox,
  attachRoots,
  type RawMcpClient,
  type McpClientHooks,
  type McpElicitationHandler,
  type McpLifecycleOptions,
  type McpRootsBox,
  type McpRootsClient,
  type McpRootsOption,
  type McpSamplingOptions,
} from './shared';

export { createManagedConnection } from './shared';

export type {
  McpClient,
  McpClientHooks,
  McpConnectionStatus,
  McpElicitationHandler,
  McpElicitationRequest,
  McpElicitationResult,
  McpLifecycleOptions,
  McpReconnectPolicy,
  McpStatusInfo,
  ManagedMcp,
  ManagedConnectionOptions,
  McpResource,
  McpResourceContent,
  McpPrompt,
  McpPromptMessage,
  McpGetPromptResult,
  McpRootsClient,
  McpRootsOption,
  McpSamplingMessage,
  McpSamplingOptions,
  McpSamplingRequest,
  McpSamplingResult,
  McpStopReason,
} from './shared';

/**
 * MCP client over HTTP — edge-safe (fetch-only; no node builtins). `http` uses
 * the current Streamable HTTP transport; `sse` is the legacy fallback some
 * servers (e.g. Firecrawl `/v2/sse`) still expose. The Node-only stdio transport
 * lives in `./mcp/stdio`. `@modelcontextprotocol/sdk` is an optional peer,
 * imported lazily so the edge bundle never pulls it in unless used.
 */
export interface McpHttpTransport {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpClientOptions extends McpLifecycleOptions {
  transport: McpHttpTransport;
  name?: string;
  version?: string;
  /**
   * Handle server-initiated `elicitation/create` requests (MCP 2025-11-25).
   * Providing it declares the elicitation capability (form + url modes).
   * URL mode: `{ action: 'accept' }` = the user consented to open the URL —
   * NEVER auto-open or prefetch it; completion happens out-of-band.
   */
  onElicitationRequest?: McpElicitationHandler;
  /**
   * OAuth 2.0 (2.0). Pass {@link McpOAuthOptions} to have the client build a
   * provider, or a {@link DeuzOAuthProvider} you already created (and possibly
   * share across servers). Without stored tokens the first connect rejects with
   * `McpAuthorizationRequiredError` carrying the URL to send the user to.
   */
  auth?: McpOAuthOptions | DeuzOAuthProvider;
  /**
   * The `?code=` the authorization server redirected back with. Exchanged for
   * tokens BEFORE connecting — this is step two of the flow described on
   * `McpAuthorizationRequiredError`. Requires `auth`.
   */
  authorizationCode?: string;
  /**
   * Serve the server's `sampling/createMessage` requests with OUR model (2.0):
   * the server writes the prompt, we run it and pay for the tokens. Providing
   * this declares the sampling capability — gate a server you do not fully
   * trust with `approve`.
   */
  sampling?: McpSamplingOptions;
  /**
   * Directories/URIs the server may operate on (`roots/list`, 2.0). Providing
   * them declares the roots capability with `listChanged`; swap the list later
   * with `client.setRoots()`. A function form is re-read on every request. A
   * plain path is promoted to `file://`.
   */
  roots?: McpRootsOption;
}

/** The transport members we reach past the SDK's `Transport` interface for. */
interface AuthableTransport {
  finishAuth?(authorizationCode: string): Promise<void>;
}

async function loadSdk(): Promise<{ Client: new (info: object, opts: object) => RawMcpClient }> {
  try {
    const spec: string = '@modelcontextprotocol/sdk/client/index.js';
    const mod = await import(spec);
    return mod as { Client: new (info: object, opts: object) => RawMcpClient };
  } catch (err) {
    throw new InvalidRequestError({
      message:
        'MCP support needs the optional peer "@modelcontextprotocol/sdk". Install it: npm i @modelcontextprotocol/sdk',
      cause: err,
    });
  }
}

async function makeHttpTransport(t: McpHttpTransport, authProvider?: unknown): Promise<unknown> {
  const opts =
    t.headers || authProvider
      ? {
          ...(t.headers ? { requestInit: { headers: t.headers } } : {}),
          ...(authProvider ? { authProvider } : {}),
        }
      : undefined;
  if (t.type === 'sse') {
    const spec: string = '@modelcontextprotocol/sdk/client/sse.js';
    const { SSEClientTransport } = await import(spec);
    return new SSEClientTransport(new URL(t.url), opts);
  }
  const spec: string = '@modelcontextprotocol/sdk/client/streamableHttp.js';
  const { StreamableHTTPClientTransport } = await import(spec);
  return new StreamableHTTPClientTransport(new URL(t.url), opts);
}

/** Register the elicitation handler (capability is declared in the constructor; must run BEFORE connect). */
export async function registerElicitation(
  client: RawMcpClient,
  onElicitationRequest: McpElicitationHandler,
): Promise<void> {
  if (!client.setRequestHandler) {
    throw new InvalidRequestError({
      message:
        'Elicitation needs client.setRequestHandler() — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.',
    });
  }
  const spec: string = '@modelcontextprotocol/sdk/types.js';
  const { ElicitRequestSchema } = (await import(spec)) as { ElicitRequestSchema: unknown };
  client.setRequestHandler(ElicitRequestSchema, buildElicitationHandler(onElicitationRequest));
}

/**
 * Register the sampling and roots handlers (2.0). Same contract as
 * {@link registerElicitation}: the capabilities are declared in the
 * constructor, so this MUST run before connect. Returns the mutable roots box
 * `setRoots` swaps — `undefined` when no roots were configured, which is what
 * makes `setRoots` a hard error rather than a silent no-op.
 */
export async function registerSamplingAndRoots(
  client: RawMcpClient,
  options: { sampling?: McpSamplingOptions; roots?: McpRootsOption },
): Promise<McpRootsBox | undefined> {
  if (!options.sampling && !options.roots) return undefined;
  if (!client.setRequestHandler) {
    throw new InvalidRequestError({
      message:
        'Sampling/roots need client.setRequestHandler() — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.',
    });
  }
  const spec: string = '@modelcontextprotocol/sdk/types.js';
  const { CreateMessageRequestSchema, ListRootsRequestSchema } = (await import(spec)) as {
    CreateMessageRequestSchema: unknown;
    ListRootsRequestSchema: unknown;
  };
  if (options.sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, buildSamplingHandler(options.sampling));
  }
  if (!options.roots) return undefined;
  const box = createRootsBox(options.roots);
  client.setRequestHandler(ListRootsRequestSchema, buildRootsHandler(box));
  return box;
}

/**
 * Subscribe to `notifications/tools/list_changed` (must run BEFORE connect).
 * Unlike elicitation this degrades quietly on an SDK without
 * `setNotificationHandler`: nobody asked for it explicitly, and a tool cache
 * that only refreshes on reconnect is a far smaller problem than refusing to
 * connect at all.
 */
export async function registerToolListChanged(
  client: RawMcpClient,
  onChanged: () => void,
): Promise<void> {
  if (!client.setNotificationHandler) return;
  const spec: string = '@modelcontextprotocol/sdk/types.js';
  const { ToolListChangedNotificationSchema } = (await import(spec)) as {
    ToolListChangedNotificationSchema: unknown;
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged());
}

/** Read a roots box through its function form — see {@link makeHttpClient}. */
function readRootsBox(box: McpRootsBox): string[] | Promise<string[]> {
  return typeof box.value === 'function' ? box.value() : box.value;
}

/**
 * Build ONE fresh, unconnected `Client` with every handler already registered.
 *
 * This is THE handler-registration point. `createManagedConnection` calls it
 * again for each reconnect attempt, so whatever registers here is restored on
 * the new session automatically and nothing has to be replayed. Any further
 * server→client capability belongs HERE — never after `connect()` on the client
 * handed back to the caller, which a reconnect silently replaces.
 */
async function makeHttpClient(
  options: McpClientOptions,
  hooks: McpClientHooks,
  rootsBox: McpRootsBox | undefined,
): Promise<RawMcpClient> {
  const { Client } = await loadSdk();
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    // Declaring a capability without a handler would lie to servers — gate each on its option.
    {
      capabilities: {
        ...(options.onElicitationRequest ? { elicitation: { form: {}, url: {} } } : {}),
        ...(options.sampling ? { sampling: {} } : {}),
        ...(options.roots ? { roots: { listChanged: true } } : {}),
      },
    },
  );
  if (options.onElicitationRequest) await registerElicitation(client, options.onElicitationRequest);
  await registerSamplingAndRoots(client, {
    ...(options.sampling ? { sampling: options.sampling } : {}),
    // The roots box is created ONCE per client, outside this factory: a
    // `setRoots()` mutation has to survive a reconnect, so each attempt's
    // handler reads through to that one box instead of snapshotting it.
    ...(rootsBox ? { roots: () => readRootsBox(rootsBox) } : {}),
  });
  await registerToolListChanged(client, hooks.toolListChanged);
  return client;
}

export async function createMcpClient(options: McpClientOptions): Promise<McpRootsClient> {
  const auth = options.auth ? toOAuthProvider(options.auth) : undefined;
  // The SDK's provider callbacks carry no server URL — bind before the
  // transport starts so every stored key lands in this server's namespace.
  if (auth) await bindOAuthServer(auth, options.transport.url);
  const rootsBox = options.roots !== undefined ? createRootsBox(options.roots) : undefined;
  // An authorization code is single-use: spend it on the first attempt only. A
  // reconnect re-reads whatever tokens it bought from the provider's store.
  let pendingCode = options.authorizationCode;

  const makeTransport = async (): Promise<unknown> => {
    const transport = await makeHttpTransport(options.transport, auth?.provider);
    if (pendingCode) {
      const finishAuth = (transport as AuthableTransport).finishAuth;
      if (!finishAuth) {
        throw new InvalidRequestError({
          message:
            'This transport cannot finish an OAuth exchange — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.',
        });
      }
      await finishAuth.call(transport, pendingCode);
      pendingCode = undefined;
    }
    return transport;
  };

  let managed;
  try {
    managed = await createManagedConnection({
      makeClient: (hooks) => makeHttpClient(options, hooks, rootsBox),
      // A transport is single-use, so every attempt gets a brand-new one.
      makeTransport,
      lifecycle: options,
    });
  } catch (err) {
    // The SDK signals "this server wants OAuth" with a bare UnauthorizedError.
    // By then it has already run discovery/registration and handed us the
    // authorization URL, so re-throw the actionable, serializable error.
    if (await isUnauthorizedError(err)) {
      const url = auth?.authorizationUrl();
      throw new McpAuthorizationRequiredError({
        serverUrl: options.transport.url,
        ...(url ? { authorizationUrl: url.toString() } : {}),
        cause: err,
      });
    }
    throw err;
  }
  return attachRoots(wrapMcpClient(managed.raw(), managed), managed.raw(), rootsBox, managed);
}
