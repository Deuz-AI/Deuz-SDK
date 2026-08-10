/**
 * MCP OAuth 2.0 — the WHOLE flow, end to end, over real sockets.
 *
 * `mcp-oauth-unit.test.ts` pins the seam in isolation (which key holds which
 * secret, what the registration body says). This file proves the seam actually
 * drives the protocol: two `node:http` listeners on 127.0.0.1 — the fake
 * authorization server (`startFakeAuthServer`) and a bearer-gated MCP server
 * (`startTestMcpServer`) — with the REAL `@modelcontextprotocol/sdk` transport
 * between them. Nothing about the wire is stubbed, so RFC 9728 discovery, RFC
 * 7591 dynamic registration, RFC 7636 PKCE (S256, verified by hashing) and the
 * refresh grant are all exercised for real.
 *
 * The two-step shape under test:
 *
 * 1. `createMcpClient({ transport, auth })` on a server with no stored tokens
 *    rejects with `McpAuthorizationRequiredError` — a REDIRECT, not a dead end.
 * 2. `createMcpClient({ transport, auth, authorizationCode })` (or the
 *    imperative `provider.completeAuth(code)`) spends the code and connects.
 *
 * `simulateUserAuthorization` stands in for the browser: it parses the
 * authorization URL the SDK produced, records its PKCE/`resource` parameters and
 * hands back the code the redirect would have carried.
 *
 * Every listener is closed in `afterEach`; ports are ephemeral, so files running
 * in parallel never collide.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createMcpClient, type McpClientOptions } from '../src/mcp/index';
import { createOAuthProvider } from '../src/mcp/auth';
import { McpAuthorizationRequiredError } from '../src/errors';
import type { TokenStore } from '../src/types/config';
import { startFakeAuthServer, type FakeAuthServerHandle } from './helpers/mcp-oauth-server';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
  type TestMcpServerOptions,
} from './helpers/mcp-http-server';

/** Never listened on: the browser leg is simulated, so nothing is redirected here. */
const REDIRECT_URI = 'http://127.0.0.1:8976/callback';

type ConnectedMcpClient = Awaited<ReturnType<typeof createMcpClient>>;

/** RFC 7636 §4.2 — recomputed here so the challenge/verifier pair is really checked. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A `TokenStore` whose contents are visible, so key namespacing is assertable. */
interface RecordingStore extends TokenStore {
  entries: Map<string, string>;
}

function recordingStore(): RecordingStore {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
}

/** The namespace `createOAuthProvider` files a server's secrets under. */
function keyFor(namespace: string, serverUrl: string): string {
  return `${namespace}:${new URL(serverUrl).href}`;
}

const authServers: FakeAuthServerHandle[] = [];
const mcpServers: TestMcpServerHandle[] = [];
const clients: ConnectedMcpClient[] = [];

afterEach(async () => {
  while (clients.length > 0)
    await clients
      .pop()
      ?.close()
      .catch(() => {});
  while (mcpServers.length > 0) await mcpServers.pop()?.close();
  while (authServers.length > 0) await authServers.pop()?.close();
});

interface Fixture {
  as: FakeAuthServerHandle;
  mcp: TestMcpServerHandle;
  /** `createMcpClient` options for this pair, before any auth is added. */
  transport: McpClientOptions['transport'];
}

/**
 * An authorization server plus an MCP server that only trusts tokens THAT
 * server issued, and whose 401 points at its own RFC 9728 document naming it.
 * That indirection is the entire discovery half of the flow.
 */
async function startFixture(mcpOptions: TestMcpServerOptions = {}): Promise<Fixture> {
  const as = await startFakeAuthServer();
  authServers.push(as);
  // A test that pins its own gate (e.g. `requireBearer`) keeps it; otherwise the
  // resource server defers to the AS, which is what makes a refreshed token work.
  const gate: TestMcpServerOptions =
    mcpOptions.authorizeToken || mcpOptions.requireBearer !== undefined
      ? {}
      : { authorizeToken: (token) => as.isValidAccessToken(token) };
  const mcp = await startTestMcpServer({
    ...gate,
    authorizationServers: [as.url],
    ...mcpOptions,
  });
  mcpServers.push(mcp);
  return { as, mcp, transport: { type: 'http', url: mcp.url } };
}

async function connect(options: McpClientOptions): Promise<ConnectedMcpClient> {
  const client = await createMcpClient(options);
  clients.push(client);
  return client;
}

/** Run step one of the flow and hand back the error it is supposed to reject with. */
async function expectAuthorizationRequired(
  options: McpClientOptions,
): Promise<McpAuthorizationRequiredError> {
  try {
    clients.push(await createMcpClient(options));
  } catch (err) {
    if (err instanceof McpAuthorizationRequiredError) return err;
    throw err;
  }
  throw new Error('Expected createMcpClient to reject with McpAuthorizationRequiredError.');
}

describe('step 1 — an unauthorized server produces an authorization URL', () => {
  it('rejects with McpAuthorizationRequiredError carrying a PKCE + DCR authorization URL', async () => {
    // `requireBearer` with a token this AS will never mint: no bearer can pass,
    // so the 401 → discovery path is the only thing under test here.
    const { as, mcp, transport } = await startFixture({ requireBearer: 'never-issued' });
    const store = recordingStore();
    const redirects: URL[] = [];
    const provider = createOAuthProvider({
      redirectUri: REDIRECT_URI,
      scope: 'mcp:tools',
      store,
      onRedirect: (url) => {
        redirects.push(url);
      },
    });

    const err = await expectAuthorizationRequired({ transport, auth: provider });

    expect(err.serverUrl).toBe(mcp.url);
    expect(err.code).toBe('mcp_authorization_required');
    expect(err.message).toMatch(/authorizationUrl/);
    expect(err.authorizationUrl).toBeDefined();
    // The library NEVER opens a browser — it hands the URL to the host, and the
    // string on the error is the same one `onRedirect` saw.
    expect(redirects.map(String)).toEqual([err.authorizationUrl]);

    const url = new URL(err.authorizationUrl!);
    expect(url.origin).toBe(as.url);
    expect(url.pathname).toBe('/authorize');
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(q.get('scope')).toBe('mcp:tools');
    // RFC 8707: the audience comes from the resource server's own metadata.
    expect(q.get('resource')).toBe(mcp.url);
    // The client id was minted by dynamic registration moments ago.
    expect(q.get('client_id')).toBe('client-1');

    expect(as.registrations).toHaveLength(1);
    expect(as.registrations[0]!.request).toMatchObject({
      client_name: 'Deuz SDK',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools',
    });

    // Nothing was exchanged: this is a redirect, not a failed login.
    expect(as.tokenRequests).toEqual([]);
    expect(await provider.tokens()).toBeUndefined();
  }, 20_000);

  it('persists exactly the client info and the PKCE verifier the next step needs', async () => {
    const { as, mcp, transport } = await startFixture({ requireBearer: 'never-issued' });
    const store = recordingStore();
    const provider = createOAuthProvider({ redirectUri: REDIRECT_URI, store });

    const err = await expectAuthorizationRequired({ transport, auth: provider });

    // No token key yet, and every secret is namespaced by the server it belongs to.
    expect([...store.entries.keys()].sort()).toEqual([
      keyFor('client-info', mcp.url),
      keyFor('code-verifier', mcp.url),
      'server-url',
    ]);
    expect(store.entries.get('server-url')).toBe(new URL(mcp.url).href);
    expect(JSON.parse(store.entries.get(keyFor('client-info', mcp.url))!)).toMatchObject({
      client_id: 'client-1',
      client_secret: 'secret-1',
    });

    // The stored verifier is the pre-image of the challenge that just went out:
    // a provider that saved the wrong string would still "work" until /token.
    const verifier = store.entries.get(keyFor('code-verifier', mcp.url))!;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(s256(verifier)).toBe(new URL(err.authorizationUrl!).searchParams.get('code_challenge'));
    expect(as.registrations).toHaveLength(1);
  }, 20_000);
});

describe('step 2 — spending the authorization code', () => {
  it('connects with `authorizationCode` and the MCP tools work over the bearer token', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    const provider = createOAuthProvider({ redirectUri: REDIRECT_URI, store });

    const err = await expectAuthorizationRequired({ transport, auth: provider });
    const verifier = store.entries.get(keyFor('code-verifier', mcp.url))!;

    const code = as.simulateUserAuthorization(err.authorizationUrl!);
    expect(code).toBe('code-1');
    expect(as.authorizations[0]!.codeChallenge).toBe(s256(verifier));

    const client = await connect({ transport, auth: provider, authorizationCode: code });

    const exchange = as.tokenRequests.find((r) => r.grantType === 'authorization_code');
    expect(exchange).toBeDefined();
    expect(exchange!.status).toBe(200);
    expect(exchange!.params.code).toBe('code-1');
    // The verifier that reaches /token is the one that was stored — the AS
    // hashes it and rejects a mismatch with `invalid_grant`.
    expect(exchange!.params.code_verifier).toBe(verifier);
    expect(exchange!.params.redirect_uri).toBe(REDIRECT_URI);
    expect(exchange!.params.client_id).toBe('client-1');
    expect(exchange!.params.client_secret).toBe('secret-1');
    expect(exchange!.params.resource).toBe(mcp.url);

    expect(as.issued.map((t) => t.accessToken)).toEqual(['at-1']);
    expect(await provider.tokens()).toMatchObject({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      token_type: 'Bearer',
    });
    expect(JSON.parse(store.entries.get(keyFor('tokens', mcp.url))!)).toMatchObject({
      access_token: 'at-1',
    });

    // The point of all of the above: a real tool call over the authorized session.
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);
    expect(await client.callTool('echo', { value: 'hi' })).toBe('echo:hi');
    expect(mcp.calls).toEqual([{ name: 'echo', args: { value: 'hi' } }]);
  }, 20_000);

  it('completeAuth(code) is the imperative twin — the next connect needs no code', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    const provider = createOAuthProvider({ redirectUri: REDIRECT_URI, store });

    const err = await expectAuthorizationRequired({ transport, auth: provider });
    const code = as.simulateUserAuthorization(err.authorizationUrl!);

    // Exchanged out of band (a CLI that caught the loopback redirect), against
    // the server URL the first attempt bound and persisted.
    await provider.completeAuth(code);
    expect(await provider.tokens()).toMatchObject({ access_token: 'at-1' });
    expect(store.entries.get('server-url')).toBe(new URL(mcp.url).href);

    const client = await connect({ transport, auth: provider });
    expect(await client.callTool('echo', { value: 'imperative' })).toBe('echo:imperative');

    // One exchange total: the connect reused the stored tokens instead of
    // starting a second authorization.
    expect(as.tokenRequests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(1);
    expect(as.authorizations).toHaveLength(1);
  }, 20_000);

  it('accepts the options form too — the STORE carries the flow, not the provider instance', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    // Same options object twice: `createMcpClient` builds a fresh provider each
    // time, exactly like a second process would. Only the store is shared.
    const auth = { redirectUri: REDIRECT_URI, store };

    const err = await expectAuthorizationRequired({ transport, auth });
    const code = as.simulateUserAuthorization(err.authorizationUrl!);

    const client = await connect({ transport, auth, authorizationCode: code });

    expect(as.tokenRequests.find((r) => r.grantType === 'authorization_code')!.params.code).toBe(
      code,
    );
    expect(await client.callTool('add', { a: 2, b: 3 })).toEqual({ sum: 5 });
    expect(JSON.parse(store.entries.get(keyFor('tokens', mcp.url))!)).toMatchObject({
      access_token: 'at-1',
    });
  }, 20_000);
});

describe('refresh', () => {
  it('a stale access token is refreshed in place — no second trip through consent', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    const provider = createOAuthProvider({ redirectUri: REDIRECT_URI, store });

    const err = await expectAuthorizationRequired({ transport, auth: provider });
    const first = await connect({
      transport,
      auth: provider,
      authorizationCode: as.simulateUserAuthorization(err.authorizationUrl!),
    });
    await first.close();

    // Seed the state a restarted process reads off disk: an access token the
    // resource server no longer honours, next to a refresh token that is still
    // good. (The AS only ever issued `rt-1`, so the grant has to be genuine.)
    store.entries.set(
      keyFor('tokens', mcp.url),
      JSON.stringify({
        access_token: 'at-stale',
        token_type: 'Bearer',
        expires_in: 1,
        refresh_token: 'rt-1',
      }),
    );

    const client = await connect({ transport, auth: provider });

    const refreshes = as.tokenRequests.filter((r) => r.grantType === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.params.refresh_token).toBe('rt-1');
    expect(refreshes[0]!.status).toBe(200);
    expect(refreshes[0]!.params.client_id).toBe('client-1');

    expect(await provider.tokens()).toMatchObject({
      access_token: 'at-2',
      // The AS did not rotate it, and the SDK preserves the one it presented.
      refresh_token: 'rt-1',
    });
    expect(await client.callTool('echo', { value: 'refreshed' })).toBe('echo:refreshed');

    // The user was never sent anywhere a second time, and no new client was registered.
    expect(as.authorizations).toHaveLength(1);
    expect(as.registrations).toHaveLength(1);
  }, 20_000);

  it('a rejected refresh token falls back to a fresh authorization', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    const provider = createOAuthProvider({ redirectUri: REDIRECT_URI, store });

    // Authorize once for real, so the store holds the registration and the
    // server binding that a later process would read back off disk.
    const first = await expectAuthorizationRequired({ transport, auth: provider });
    const before = await connect({
      transport,
      auth: provider,
      authorizationCode: as.simulateUserAuthorization(first.authorizationUrl!),
    });
    await before.close();

    // What a revoked session leaves behind: an access token the resource server
    // rejects, next to a refresh token the AS has never heard of. `/token`
    // answers `400 invalid_grant`, which is the ONLY thing the SDK retries.
    store.entries.set(
      keyFor('tokens', mcp.url),
      JSON.stringify({
        access_token: 'at-revoked',
        token_type: 'Bearer',
        expires_in: 1,
        refresh_token: 'rt-dead',
      }),
    );

    const err = await expectAuthorizationRequired({ transport, auth: provider });

    // The dead grant is presented ONCE. Without `invalidateCredentials` the
    // SDK's invalid_grant retry re-reads the same stored pair and sends it a
    // second time, which can only fail again — and the raw `InvalidGrantError`
    // escapes instead of the actionable error above.
    const refreshes = as.tokenRequests.filter((r) => r.grantType === 'refresh_token');
    expect(refreshes.map((r) => r.params.refresh_token)).toEqual(['rt-dead']);
    expect(refreshes[0]!.status).toBe(400);
    expect(refreshes[0]!.error).toBe('invalid_grant');

    // A REDIRECT, not a dead end: the retry reached a fresh authorization.
    expect(err.authorizationUrl).toBeDefined();
    expect(err.authorizationUrl).not.toBe(first.authorizationUrl);
    expect(new URL(err.authorizationUrl!).searchParams.get('client_id')).toBe('client-1');

    // The dead pair is gone from the store, so nothing has to be cleared by
    // hand before the next attempt. The registration is not what the server
    // rejected, so it survives and no second client was minted.
    expect(await provider.tokens()).toBeUndefined();
    expect(store.entries.has(keyFor('tokens', mcp.url))).toBe(false);
    expect(store.entries.has(keyFor('client-info', mcp.url))).toBe(true);
    expect(as.registrations).toHaveLength(1);

    // And the offered URL really works — the lockout is over, not just quieter.
    const after = await connect({
      transport,
      auth: provider,
      authorizationCode: as.simulateUserAuthorization(err.authorizationUrl!),
    });
    expect(await after.callTool('echo', { value: 'recovered' })).toBe('echo:recovered');
    expect(await provider.tokens()).toMatchObject({ access_token: 'at-2' });
  }, 20_000);
});

describe('pre-provisioned clients', () => {
  it('a configured clientId skips /register entirely and authenticates as a public client', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    const provider = createOAuthProvider({
      redirectUri: REDIRECT_URI,
      clientId: 'preprovisioned-1',
      store,
    });

    const err = await expectAuthorizationRequired({ transport, auth: provider });

    expect(as.registrations).toEqual([]);
    expect(store.entries.has(keyFor('client-info', mcp.url))).toBe(false);
    expect(new URL(err.authorizationUrl!).searchParams.get('client_id')).toBe('preprovisioned-1');

    const client = await connect({
      transport,
      auth: provider,
      authorizationCode: as.simulateUserAuthorization(err.authorizationUrl!),
    });

    const exchange = as.tokenRequests.find((r) => r.grantType === 'authorization_code')!;
    expect(exchange.status).toBe(200);
    expect(exchange.params.client_id).toBe('preprovisioned-1');
    // No secret was configured, so this stays a public PKCE client.
    expect(exchange.params.client_secret).toBeUndefined();
    expect(exchange.authorizationHeader).toBeUndefined();
    expect(as.registrations).toEqual([]);

    expect(await client.callTool('echo', { value: 'static' })).toBe('echo:static');
  }, 20_000);
});

describe('invalidate()', () => {
  it('drops the tokens and restarts the flow, keeping the dynamic registration', async () => {
    const { as, mcp, transport } = await startFixture();
    const store = recordingStore();
    const provider = createOAuthProvider({ redirectUri: REDIRECT_URI, store });

    const first = await expectAuthorizationRequired({ transport, auth: provider });
    const before = await connect({
      transport,
      auth: provider,
      authorizationCode: as.simulateUserAuthorization(first.authorizationUrl!),
    });
    expect(await before.callTool('echo', { value: 'before' })).toBe('echo:before');
    await before.close();

    await provider.invalidate();
    expect(await provider.tokens()).toBeUndefined();
    expect(store.entries.has(keyFor('tokens', mcp.url))).toBe(false);
    expect(store.entries.has(keyFor('code-verifier', mcp.url))).toBe(false);
    // The registration is not a credential the server rejected — it survives.
    expect(store.entries.has(keyFor('client-info', mcp.url))).toBe(true);

    const second = await expectAuthorizationRequired({ transport, auth: provider });
    expect(second.authorizationUrl).toBeDefined();
    // A fresh PKCE pair, so the URL cannot be the old one.
    expect(second.authorizationUrl).not.toBe(first.authorizationUrl);
    expect(new URL(second.authorizationUrl!).searchParams.get('client_id')).toBe('client-1');
    expect(as.registrations).toHaveLength(1);

    const secondCode = as.simulateUserAuthorization(second.authorizationUrl!);
    expect(secondCode).toBe('code-2');
    const after = await connect({ transport, auth: provider, authorizationCode: secondCode });

    expect(await after.callTool('echo', { value: 'after' })).toBe('echo:after');
    expect(as.issued.map((t) => t.accessToken)).toEqual(['at-1', 'at-2']);
    expect(as.tokenRequests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(2);
  }, 20_000);
});
