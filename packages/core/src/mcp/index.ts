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
  type McpSdkSelection,
  type McpVersionNegotiation,
} from './shared';
import {
  NO_MCP_SDK_MESSAGE,
  assertLineSupports,
  recordV1NegotiatedVersion,
  selectMcpSdk,
} from './sdk-line';

export { createManagedConnection } from './shared';

// Tool fingerprinting (2.2): hash a server's catalog when you approve it, then
// detect a later description/schema rewrite before the model follows it.
export { fingerprintTools, detectToolDrift } from './shared';
export type { ToolFingerprints, ToolDrift } from './shared';

// OAuth 2.0 (2.0) — build a provider up front to share one token store across
// servers, or to hand the same provider to a `mcp: [{ url, auth }]` loop entry.
export { createOAuthProvider, inMemoryTokenStore } from './auth';
export type { TokenStore, McpOAuthOptions, DeuzOAuthProvider } from '../types/config';

/**
 * The cross-call connection pool behind `deps.mcpPool` (2.0). It ships from this
 * barrel because the dep is public: a server process builds one at startup, and
 * `ResolvedMcpRuntime` is what the loop holds for the life of a run.
 */
export { createMcpPool } from './resolve';
export type {
  McpConnectableConfig,
  McpConnectionPool,
  McpPoolOptions,
  ResolvedMcpRuntime,
} from './resolve';

export type {
  McpClient,
  McpClientHooks,
  McpConnectionStatus,
  McpSdkLine,
  McpSdkSelection,
  McpVersionNegotiation,
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
 * lives in `./mcp/stdio`. The MCP SDKs (`@modelcontextprotocol/client` for
 * 2026-07-28, `@modelcontextprotocol/sdk` for 2025-11-25) are optional peers,
 * imported lazily so the edge bundle never pulls them in unless used.
 */
export interface McpHttpTransport {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  /**
   * The `fetch` every request goes through (2.3) — a proxy, a Cloudflare
   * service binding (`env.MCP.fetch`), or an in-process server's own handler.
   * Default: the runtime's global `fetch`. Both SDK lines honor it.
   */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface McpClientOptions extends McpLifecycleOptions {
  transport: McpHttpTransport;
  name?: string;
  version?: string;
  /**
   * Which MCP SDK drives the client (2.3). `'auto'` (the default) uses the v2
   * SDK (`@modelcontextprotocol/client`, MCP 2026-07-28) when it can be imported
   * and the v1 SDK (`@modelcontextprotocol/sdk`, 2025-11-25) otherwise. Every
   * feature below works on both lines; `client.sdk()` reports the choice.
   */
  sdk?: McpSdkSelection;
  /**
   * Protocol negotiation on the v2 line (2.3) — see {@link McpVersionNegotiation}.
   * Default `'auto'`: 2026-07-28 with a server that offers it, the 2025-era
   * handshake otherwise. `client.protocolVersion()` reports the outcome.
   */
  versionNegotiation?: McpVersionNegotiation;
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
   * The `?iss=` from the same redirect (RFC 9207, 2.3), when it carries one —
   * pass it whenever it does. The v2 SDK checks it against the authorization
   * server's issuer before redeeming `authorizationCode` (the mix-up defense)
   * and refuses the exchange without it when the server advertises
   * `authorization_response_iss_parameter_supported`. The v1 SDK ignores it.
   */
  authorizationIss?: string;
  /**
   * Serve the server's `sampling/createMessage` requests with OUR model (2.0):
   * the server writes the prompt, we run it and pay for the tokens. Providing
   * this declares the sampling capability — gate a server you do not fully
   * trust with `approve`.
   */
  sampling?: McpSamplingOptions;
  /**
   * Directories the server may operate on (`roots/list`, 2.0). Providing them
   * declares the roots capability with `listChanged` — including for `[]`, which
   * is an explicit "no roots" rather than an absent option; swap the list later
   * with `client.setRoots()`. A function form is re-read on every request. A
   * plain path is promoted to `file://`; MCP accepts no other scheme, so
   * anything else is rejected here rather than by the server.
   */
  roots?: McpRootsOption;
}

/** The transport members we reach past the SDK's `Transport` interface for. */
interface AuthableTransport {
  /** v2 checks `iss` (RFC 9207); v1 1.29 takes the code only and ignores it. */
  finishAuth?(authorizationCode: string, iss?: string): Promise<void>;
}

/**
 * Import the v1 SDK client. `viaAuto` says the line was picked by `'auto'`
 * BECAUSE the v2 package is missing too, in which case the hint names both.
 */
async function loadSdk(
  viaAuto = false,
): Promise<{ Client: new (info: object, opts: object) => RawMcpClient }> {
  try {
    const spec: string = '@modelcontextprotocol/sdk/client/index.js';
    const mod = await import(spec);
    return mod as { Client: new (info: object, opts: object) => RawMcpClient };
  } catch (err) {
    throw new InvalidRequestError({
      message: viaAuto
        ? NO_MCP_SDK_MESSAGE
        : 'MCP support needs the optional peer "@modelcontextprotocol/sdk". Install it: npm i @modelcontextprotocol/sdk',
      cause: err,
    });
  }
}

async function makeHttpTransport(t: McpHttpTransport, authProvider?: unknown): Promise<unknown> {
  const opts =
    t.headers || authProvider || t.fetch
      ? {
          ...(t.headers ? { requestInit: { headers: t.headers } } : {}),
          ...(authProvider ? { authProvider } : {}),
          ...(t.fetch ? { fetch: t.fetch } : {}),
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
 *
 * Presence is tested with `!== undefined` here, in the capability block and at
 * every other gate: `roots: []` is a VALUE ("no roots"), and one predicate that
 * reads it as absence would declare a capability whose handler is missing.
 */
export async function registerSamplingAndRoots(
  client: RawMcpClient,
  options: { sampling?: McpSamplingOptions; roots?: McpRootsOption },
): Promise<McpRootsBox | undefined> {
  if (options.sampling === undefined && options.roots === undefined) return undefined;
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
  if (options.sampling !== undefined) {
    client.setRequestHandler(CreateMessageRequestSchema, buildSamplingHandler(options.sampling));
  }
  if (options.roots === undefined) return undefined;
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
  viaAuto: boolean,
): Promise<RawMcpClient> {
  const { Client } = await loadSdk(viaAuto);
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    // Declaring a capability without a handler would lie to servers — gate each
    // on its option, all three on `!== undefined` so an empty-but-present value
    // (`roots: []`) declares the capability its handler is registered for.
    {
      capabilities: {
        ...(options.onElicitationRequest !== undefined
          ? { elicitation: { form: {}, url: {} } }
          : {}),
        ...(options.sampling !== undefined ? { sampling: {} } : {}),
        ...(options.roots !== undefined ? { roots: { listChanged: true } } : {}),
      },
    },
  );
  if (options.onElicitationRequest !== undefined) {
    await registerElicitation(client, options.onElicitationRequest);
  }
  await registerSamplingAndRoots(client, {
    ...(options.sampling !== undefined ? { sampling: options.sampling } : {}),
    // The roots box is created ONCE per client, outside this factory: a
    // `setRoots()` mutation has to survive a reconnect, so each attempt's
    // handler reads through to that one box instead of snapshotting it.
    ...(rootsBox !== undefined ? { roots: () => readRootsBox(rootsBox) } : {}),
  });
  await registerToolListChanged(client, hooks.toolListChanged);
  return recordV1NegotiatedVersion(client);
}

export async function createMcpClient(options: McpClientOptions): Promise<McpRootsClient> {
  // Line first: an impossible combination must fail before any side effect
  // (an OAuth binding write, a socket).
  const line = await selectMcpSdk(options.sdk);
  assertLineSupports(line, options.versionNegotiation);
  // Literal specifier: the v2 adapter is its own chunk, fetched only when used.
  const v2 = line === 'v2' ? await import('./sdk-v2') : undefined;
  if (v2) await v2.loadV2Client(); // an explicit 'v2' without the package fails here
  const viaAuto = options.sdk === undefined || options.sdk === 'auto';

  const auth = options.auth ? toOAuthProvider(options.auth) : undefined;
  // The SDK's provider callbacks carry no server URL — bind before the
  // transport starts so every stored key lands in this server's namespace. The
  // line goes with it: a later `completeAuth` must run this line's exchange.
  if (auth) await bindOAuthServer(auth, options.transport.url, line);
  const rootsBox = options.roots !== undefined ? createRootsBox(options.roots) : undefined;
  // An authorization code is single-use: spend it on the first attempt only. A
  // reconnect re-reads whatever tokens it bought from the provider's store.
  let pendingCode = options.authorizationCode;
  let pendingIss = options.authorizationIss;

  const makeTransport = async (): Promise<unknown> => {
    const transport = v2
      ? await v2.makeV2HttpTransport(options.transport, auth?.provider)
      : await makeHttpTransport(options.transport, auth?.provider);
    if (pendingCode) {
      const finishAuth = (transport as AuthableTransport).finishAuth;
      if (!finishAuth) {
        throw new InvalidRequestError({
          message:
            'This transport cannot finish an OAuth exchange — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.',
        });
      }
      await finishAuth.call(transport, pendingCode, pendingIss);
      pendingCode = undefined;
      pendingIss = undefined;
    }
    return transport;
  };

  let managed;
  try {
    managed = await createManagedConnection({
      makeClient: (hooks) =>
        v2
          ? v2.makeV2Client(options, hooks, rootsBox)
          : makeHttpClient(options, hooks, rootsBox, viaAuto),
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
  return attachRoots(
    wrapMcpClient(managed.raw(), managed, { sdk: line }),
    managed.raw(),
    rootsBox,
    managed,
  );
}
