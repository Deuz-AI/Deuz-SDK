/**
 * MCP OAuth 2.0 (2.0) — a THIN adaptor over the MCP SDK's own OAuth machinery.
 *
 * The SDK already implements the whole protocol: RFC 8414 metadata discovery,
 * RFC 7591 dynamic client registration, PKCE (S256) and refresh. All of it is
 * driven through one seam, `OAuthClientProvider`, whose only job is to say where
 * the user is sent back to and to PERSIST four things (client information,
 * the PKCE verifier, the tokens, and — ours — which server they belong to).
 * So this module writes a provider, never a flow: there is no token endpoint
 * call, no code-challenge derivation and no refresh timer in this file.
 *
 * Edge-safe: no `node:` imports, no ambient clock, no randomness (the PKCE
 * verifier is minted BY the SDK; we only store the string it hands us). The SDK
 * itself is an optional peer, loaded lazily through a variable specifier so the
 * edge bundle never pulls it in — same pattern as `./index`.
 *
 * The seam types (`TokenStore`, `McpOAuthOptions`, `DeuzOAuthProvider`) live in
 * `types/config.ts` so `McpHttpLoopConfig.auth` can reference them without
 * importing this module; the dependency stays one-directional.
 */
import { InvalidRequestError } from '../errors';
import type { TokenStore, McpOAuthOptions, DeuzOAuthProvider } from '../types/config';
import type { McpSdkLine } from './shared';

export type { TokenStore, McpOAuthOptions, DeuzOAuthProvider } from '../types/config';

/**
 * What the SDK asks us to forget, mirrored from `OAuthClientProvider`. The SDK
 * derives the scope from the error the authorization server returned:
 * `invalid_grant` (a dead code or refresh token) → `'tokens'`, `invalid_client`
 * / `unauthorized_client` (a dead registration) → `'all'`.
 */
type SdkInvalidationScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';

/**
 * The SDK's `OAuthClientProvider`, mirrored STRUCTURALLY (the optional peer's
 * types must never leak into our public `.d.ts`). Only the members the SDK
 * actually calls are declared; the optional hooks we do not implement
 * (`state`, `addClientAuthentication`, `validateResourceURL`, …) are simply
 * absent, which is exactly how the SDK reads "use the default behaviour".
 */
interface SdkOAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: Record<string, unknown>;
  /** v2 passes the resolved authorization server's `issuer` (SEP-2352); v1 passes nothing. */
  clientInformation(ctx?: { issuer?: string }): Promise<Record<string, unknown> | undefined>;
  saveClientInformation(info: Record<string, unknown>): Promise<void>;
  tokens(): Promise<Record<string, unknown> | undefined>;
  saveTokens(tokens: Record<string, unknown>): Promise<void>;
  redirectToAuthorization(authorizationUrl: URL): Promise<void>;
  saveCodeVerifier(codeVerifier: string): Promise<void>;
  codeVerifier(): Promise<string>;
  invalidateCredentials(scope: SdkInvalidationScope): Promise<void>;
}

/**
 * The slice of the SDK's auth module we drive — `@modelcontextprotocol/client`
 * (v2) and `@modelcontextprotocol/sdk/client/auth.js` (v1) export the same two
 * names with the same shape.
 */
interface SdkAuthModule {
  auth(
    provider: SdkOAuthClientProvider,
    options: {
      serverUrl: string | URL;
      authorizationCode?: string;
      /** The redirect's `iss` (RFC 9207). v2 checks it; v1 has no such option. */
      iss?: string;
      scope?: string;
    },
  ): Promise<'AUTHORIZED' | 'REDIRECT'>;
  UnauthorizedError: new (message?: string) => Error;
}

/** Where each SDK line keeps its OAuth machinery — v2 first, as `sdk: 'auto'` prefers. */
const AUTH_MODULES: ReadonlyArray<{ line: McpSdkLine; spec: string }> = [
  { line: 'v2', spec: '@modelcontextprotocol/client' },
  { line: 'v1', spec: '@modelcontextprotocol/sdk/client/auth.js' },
];

/** Every installed line's auth module, in preference order (2.3). */
async function loadAuthModules(): Promise<{
  modules: Array<{ line: McpSdkLine; module: SdkAuthModule }>;
  cause?: unknown;
}> {
  const modules: Array<{ line: McpSdkLine; module: SdkAuthModule }> = [];
  let cause: unknown;
  for (const candidate of AUTH_MODULES) {
    try {
      const spec: string = candidate.spec;
      const mod = (await import(spec)) as Partial<SdkAuthModule>;
      if (typeof mod.auth === 'function' && typeof mod.UnauthorizedError === 'function') {
        modules.push({ line: candidate.line, module: mod as SdkAuthModule });
      }
    } catch (err) {
      cause ??= err;
    }
  }
  return { modules, cause };
}

/**
 * The OAuth machinery (2.3): the line the provider was bound through when there
 * is one — its transport started this flow, so its exchange finishes it, and
 * `sdk: 'v1'` keeps the 2.2 exchange — else whichever line is installed, v2
 * first. The provider below is the same object for both: the v2
 * `OAuthClientProvider` only ADDED optional members (an `issuer` context
 * argument, DPoP, discovery-state caching) that this provider leaves unset.
 */
async function loadAuthModule(line: McpSdkLine | undefined): Promise<SdkAuthModule> {
  const { modules, cause } = await loadAuthModules();
  const preferred = modules.find((candidate) => candidate.line === line) ?? modules[0];
  if (preferred) return preferred.module;
  throw new InvalidRequestError({
    message:
      'MCP OAuth needs an MCP SDK — install the MCP 2026-07-28 client (npm i @modelcontextprotocol/client) or the 2025-11-25 one (npm i @modelcontextprotocol/sdk).',
    cause,
  });
}

/**
 * Recognize the SDK's `UnauthorizedError` — the signal that a server wants
 * OAuth. `instanceof` against EVERY installed line's class (2.3: the client may
 * run on either, and the v1 class sets no distinctive `name`), falling back to
 * the name because the thrown instance may come from a DIFFERENT copy of the
 * SDK than the one we just imported (transports carry their own).
 */
export async function isUnauthorizedError(value: unknown): Promise<boolean> {
  if (!value || typeof value !== 'object') return false;
  const { modules } = await loadAuthModules();
  for (const { module } of modules) {
    if (value instanceof module.UnauthorizedError) return true;
  }
  return (value as Error).name === 'UnauthorizedError';
}

/** Tokens die with the process — the default when no `store` is configured. */
export function inMemoryTokenStore(): TokenStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
}

/**
 * Store namespace for a provider that was never bound to a server (created and
 * used by hand rather than handed to `createMcpClient`). Such a provider cannot
 * complete an exchange anyway — `completeAuth` needs a real server URL — so the
 * shared bucket only ever holds what a caller poked in deliberately.
 */
const UNBOUND_SERVER = 'default';

/** Persisted under this key so `completeAuth` survives a process restart. */
const SERVER_URL_KEY = 'server-url';

/** Same server, one namespace: `…/mcp` and `…/mcp/` must not split the tokens. */
function normalizeServerUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Bookkeeping a bound provider needs; `bindOAuthServer` is the only writer. */
interface ProviderBinding {
  bind(serverUrl: string, line: McpSdkLine | undefined): Promise<void>;
}

const bindings = new WeakMap<DeuzOAuthProvider, ProviderBinding>();

/**
 * Tell a provider WHICH MCP server it is authorizing against. The SDK's
 * provider callbacks carry no server URL, so the caller that knows it — normally
 * `createMcpClient` — has to say so before the transport starts; every store key
 * is namespaced by it, and `completeAuth` needs it to pick the right exchange.
 * Binding is idempotent and re-binding is allowed (one provider, many servers).
 * `line` (2.3) is the SDK line that transport runs on: `completeAuth` on this
 * provider object finishes the exchange on the same line.
 *
 * Awaited rather than fire-and-forget because the `server-url` record is what
 * lets a SECOND process (the CLI run that carries the `?code=` back) know which
 * exchange it is finishing.
 */
export async function bindOAuthServer(
  provider: DeuzOAuthProvider,
  serverUrl: string,
  line?: McpSdkLine,
): Promise<void> {
  await bindings.get(provider)?.bind(serverUrl, line);
}

/** Accept either shape of `McpHttpLoopConfig.auth`, always yielding a provider. */
export function toOAuthProvider(auth: McpOAuthOptions | DeuzOAuthProvider): DeuzOAuthProvider {
  return 'provider' in auth ? auth : createOAuthProvider(auth);
}

/**
 * Build the OAuth provider the MCP transports consume.
 *
 * Persistence layout — four namespaced keys per server, so one `TokenStore` can
 * back many servers without collisions:
 *
 * ```
 * tokens:<serverUrl>         the access/refresh token pair (SECRET)
 * client-info:<serverUrl>    what dynamic registration minted (skipped if `clientId` is set)
 * code-verifier:<serverUrl>  the in-flight PKCE verifier (short-lived)
 * server-url                 the server the last authorization was started for
 * ```
 *
 * `redirectToAuthorization` NEVER opens a browser: it records the URL and calls
 * `onRedirect`. Deciding how a user sees that URL — a CLI printing it, a web app
 * 302-ing to it, a desktop shell launching one — is the host's call, and a
 * library that spawns a browser on a server is a bug.
 */
export function createOAuthProvider(options: McpOAuthOptions): DeuzOAuthProvider {
  const store = options.store ?? inMemoryTokenStore();
  let serverUrl: string | undefined;
  /** The SDK line of the last binding — in memory only, like `serverUrl` itself. */
  let boundLine: McpSdkLine | undefined;
  let authorizationUrl: URL | undefined;

  const key = (namespace: string): string => `${namespace}:${serverUrl ?? UNBOUND_SERVER}`;

  const readJson = async (namespace: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await store.get(key(namespace));
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      // A corrupt entry is treated as absent: re-authorizing is recoverable,
      // throwing out of an SDK callback is not.
      return undefined;
    }
  };

  /** The server for `completeAuth`: the in-memory binding, else the stored one. */
  const requireServerUrl = async (): Promise<string> => {
    const resolved = serverUrl ?? (await store.get(SERVER_URL_KEY));
    if (!resolved) {
      throw new InvalidRequestError({
        message:
          'This OAuth provider is not bound to an MCP server yet, so there is no exchange to complete. Connect once with `createMcpClient({ transport, auth })` — that binds the provider and produces the authorization URL — before calling `completeAuth`.',
      });
    }
    return resolved;
  };

  const provider: SdkOAuthClientProvider = {
    redirectUrl: options.redirectUri,

    // Only consulted when the client is NOT pre-registered — this is the RFC
    // 7591 registration body. Caller-supplied fields win over the defaults.
    get clientMetadata() {
      return {
        client_name: 'Deuz SDK',
        redirect_uris: [options.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: options.clientSecret ? 'client_secret_post' : 'none',
        ...(options.scope ? { scope: options.scope } : {}),
        ...options.clientMetadata,
      };
    },

    async clientInformation(ctx) {
      // A configured `clientId` short-circuits dynamic registration entirely:
      // the SDK skips the registration request when this resolves.
      if (options.clientId) {
        return {
          client_id: options.clientId,
          ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
          // The v2 SDK (SEP-2352) binds client info to an authorization server
          // by an `issuer` stamp and WRITES BACK an unstamped value to stamp it —
          // which would copy a configured secret into the token store, and warn
          // on every call. A configured client is meant for whichever server
          // this provider was bound to, so it carries the issuer being asked about.
          ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
        };
      }
      return readJson('client-info');
    },

    async saveClientInformation(info) {
      // Configuration, not state: a configured client is never persisted.
      if (options.clientId) return;
      await store.set(key('client-info'), JSON.stringify(info));
    },

    tokens: () => readJson('tokens'),

    async saveTokens(tokens) {
      await store.set(key('tokens'), JSON.stringify(tokens));
    },

    async redirectToAuthorization(url) {
      authorizationUrl = url;
      await options.onRedirect?.(url);
    },

    async saveCodeVerifier(codeVerifier) {
      await store.set(key('code-verifier'), codeVerifier);
    },

    async codeVerifier() {
      const verifier = await store.get(key('code-verifier'));
      if (!verifier) {
        throw new InvalidRequestError({
          message:
            'No PKCE code verifier is stored for this MCP server, so the authorization code cannot be exchanged. The verifier is written when the authorization URL is produced — start the flow again (a non-persistent `TokenStore` loses it across processes).',
        });
      }
      return verifier;
    },

    /**
     * Drop what the authorization server just rejected. The SDK's `auth()`
     * wrapper calls this and then re-runs the WHOLE flow, so a provider that
     * no-ops here replays the identical dead credential — the second attempt
     * fails the same way, the SDK's raw `InvalidGrantError` escapes instead of
     * our `McpAuthorizationRequiredError`, and the dead pair stays in the store:
     * a permanent lockout until someone calls `invalidate()` by hand. Deleting
     * lets the re-run fall through to a fresh authorization instead.
     *
     * `server-url` survives every scope: it is a binding, not a credential, and
     * the process that carries the `?code=` back needs it to know which
     * exchange it is completing.
     */
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') await store.delete(key('tokens'));
      if (scope === 'all' || scope === 'verifier') await store.delete(key('code-verifier'));
      if (scope === 'all' || scope === 'client') await store.delete(key('client-info'));
      // 'discovery' has nothing to drop: we implement no `saveDiscoveryState`,
      // so the SDK re-discovers on every `auth()` and caches none of it here.
    },
  };

  const deuzProvider: DeuzOAuthProvider = {
    provider,
    authorizationUrl: () => authorizationUrl,

    async completeAuth(code, iss) {
      const target = await requireServerUrl();
      // A fresh provider (a second process, a callback route) was never bound,
      // so it takes the installed line — v2 first, which wants the `iss`.
      const { auth } = await loadAuthModule(boundLine);
      await auth(provider, {
        serverUrl: target,
        authorizationCode: code,
        ...(iss !== undefined ? { iss } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
      });
    },

    tokens: () => provider.tokens(),

    async invalidate() {
      // Client registration deliberately SURVIVES: it is not a credential the
      // server rejected, and re-registering on every expiry would litter the
      // authorization server with dead clients. Same two scopes the SDK asks
      // for on `invalid_grant`, so the manual and automatic paths cannot drift.
      await provider.invalidateCredentials('tokens');
      await provider.invalidateCredentials('verifier');
    },
  };

  bindings.set(deuzProvider, {
    async bind(url, line) {
      serverUrl = normalizeServerUrl(url);
      boundLine = line;
      await store.set(SERVER_URL_KEY, serverUrl);
    },
  });

  return deuzProvider;
}
