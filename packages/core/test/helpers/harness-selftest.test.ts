/**
 * harness-selftest.test.ts — the harnesses under test, not the SDK.
 *
 * `mcp-http-server.ts` and `mcp-oauth-server.ts` are load-bearing fixtures: the
 * 2.0 MCP suites (lifecycle/reconnect, OAuth, sampling, roots, loop wiring) all
 * assert THROUGH them, so a harness bug reads as a product bug in nine files at
 * once. These tests are the seatbelt — each capability the harnesses advertise is
 * exercised once, in isolation, so a red here means "the fixture broke", never
 * "the client broke".
 *
 * The MCP side is driven by the SDK's own `Client` + `StreamableHTTPClientTransport`
 * ON PURPOSE, not by our `createMcpClient` wrapper: the wrapper is being rewritten
 * in parallel, and a fixture that can only be validated through the thing it is
 * meant to validate proves nothing.
 *
 * Real sockets are opened, all on 127.0.0.1, all torn down in `afterEach`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
  type TestMcpServerOptions,
} from './mcp-http-server';
import { startFakeAuthServer, type FakeAuthServerHandle } from './mcp-oauth-server';

/** Everything opened during a test, reaped in `afterEach` even on failure. */
const mcpServers: TestMcpServerHandle[] = [];
const authServers: FakeAuthServerHandle[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  // Warm the optional peer's module graph once (express/hono/zod/ajv/…). Vitest
  // transforms it on first import, and that cost would otherwise land on whichever
  // test happens to run first and read as a timeout.
  await import('@modelcontextprotocol/sdk/client/index.js');
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await import('@modelcontextprotocol/sdk/server/index.js');
  await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
}, 60_000);

afterEach(async () => {
  while (clients.length > 0) {
    await clients
      .pop()!
      .close()
      .catch(() => {
        /* the server may already be gone (restart tests) */
      });
  }
  while (mcpServers.length > 0) await mcpServers.pop()!.close();
  while (authServers.length > 0) await authServers.pop()!.close();
});

async function startServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServerHandle> {
  const server = await startTestMcpServer(opts);
  mcpServers.push(server);
  return server;
}

async function startAuth(
  ...args: Parameters<typeof startFakeAuthServer>
): Promise<FakeAuthServerHandle> {
  const server = await startFakeAuthServer(...args);
  authServers.push(server);
  return server;
}

interface ConnectOptions {
  headers?: Record<string, string>;
  roots?: Array<{ uri: string; name?: string }>;
  onSampling?: (text: string) => string;
}

/** A real MCP client, plus the `tools/list_changed` notifications it observed. */
async function connect(
  url: string,
  opts: ConnectOptions = {},
): Promise<{ client: Client; toolListChanges: number[] }> {
  const capabilities: Record<string, unknown> = {};
  if (opts.roots) capabilities.roots = {};
  if (opts.onSampling) capabilities.sampling = {};

  const client = new Client({ name: 'harness-selftest', version: '0.0.0' }, { capabilities });
  clients.push(client);

  // A transport error here is EXPECTED, not a failure: `restart()` kills the
  // listener under a live client, and the standalone GET stream it opened dies
  // with it (undici reports `UND_ERR_SOCKET`). Without a handler that rejection
  // is unhandled, and vitest charges it to whichever test happens to be running
  // — which is how this file went red on CI while passing locally, since the
  // timing of the dying stream decides whether it lands inside the test or after
  // it. Our own `createMcpClient` already registers one; only this raw SDK
  // client did not.
  client.onerror = () => {};

  const toolListChanges: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    toolListChanges.push(toolListChanges.length + 1);
  });
  if (opts.roots) {
    const roots = opts.roots;
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
  }
  if (opts.onSampling) {
    const reply = opts.onSampling;
    client.setRequestHandler(CreateMessageRequestSchema, (request) => {
      // MCP 2025-11-25 widened `content` to "one block OR an array of blocks".
      const content = request.params.messages[0]?.content;
      const block = Array.isArray(content) ? content[0] : content;
      const text = block?.type === 'text' ? block.text : '';
      return {
        model: 'selftest-model',
        role: 'assistant' as const,
        content: { type: 'text' as const, text: reply(text) },
        stopReason: 'endTurn',
      };
    });
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    opts.headers ? { requestInit: { headers: opts.headers } } : undefined,
  );
  await client.connect(transport);
  return { client, toolListChanges };
}

/** Poll until `pred` holds; fixtures push over SSE, so there is nothing to await. */
async function waitFor(pred: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

describe('startTestMcpServer — a real streamable-HTTP MCP server', () => {
  it('round-trips listTools/callTool and forwards inputSchema verbatim', async () => {
    const server = await startServer();
    const { client } = await connect(server.url);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['echo', 'add', 'boom']);
    // The whole reason this harness drives the low-level Server: the JSON Schema
    // the test wrote is the JSON Schema the client sees, byte for byte.
    expect(listed.tools[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { value: { type: 'string', description: 'Text to echo.' } },
      required: ['value'],
      additionalProperties: false,
    });
    expect(listed.tools[0]!.description).toBe('Echo a value back.');

    const echo = await client.callTool({ name: 'echo', arguments: { value: 'hi' } });
    expect(echo.content).toEqual([{ type: 'text', text: 'echo:hi' }]);

    // A plain object becomes structuredContent AND its JSON text twin.
    const add = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(add.structuredContent).toEqual({ sum: 5 });
    expect(add.content).toEqual([{ type: 'text', text: '{"sum":5}' }]);

    // A throwing handler is an `isError` RESULT (recoverable), …
    const boom = await client.callTool({ name: 'boom', arguments: {} });
    expect(boom.isError).toBe(true);
    expect(boom.content).toEqual([{ type: 'text', text: 'tool exploded' }]);
    // … while an unknown tool is a protocol ERROR (not recoverable).
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(
      /unknown tool nope/,
    );

    expect(server.calls).toEqual([
      { name: 'echo', args: { value: 'hi' } },
      { name: 'add', args: { a: 2, b: 3 } },
      { name: 'boom', args: {} },
    ]);
  });

  it('lets a handler return a raw CallToolResult for exact wire shapes', async () => {
    const server = await startServer({
      tools: [
        {
          name: 'raw',
          handler: () => ({
            content: [{ type: 'text', text: 'first' }],
            structuredContent: { ok: true },
          }),
        },
      ],
    });
    const { client } = await connect(server.url);

    const result = await client.callTool({ name: 'raw', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'first' }]);
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it('addTool/removeTool push tools/list_changed and change the catalog', async () => {
    const server = await startServer();
    const { client, toolListChanges } = await connect(server.url);
    // Notifications ride the standalone GET stream, which opens AFTER connect().
    await server.waitForClientStream();

    server.addTool({ name: 'later', description: 'Added mid-run.', handler: () => 'ok' });
    await waitFor(() => toolListChanges.length >= 1, 'tools/list_changed after addTool');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('later');
    expect(await client.callTool({ name: 'later', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });

    server.removeTool('later');
    await waitFor(() => toolListChanges.length >= 2, 'tools/list_changed after removeTool');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('later');

    // Removing something that was never there must not fake a notification.
    server.removeTool('never-existed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toolListChanges).toHaveLength(2);
  });

  it('restart() keeps the port, forgets sessions, and accepts a fresh client', async () => {
    const server = await startServer();
    const before = await connect(server.url);
    await before.client.listTools();
    expect(server.sessionCount()).toBe(1);

    const port = server.port;
    const url = server.url;
    await server.restart();

    expect(server.port).toBe(port);
    expect(server.url).toBe(url);
    expect(server.sessionCount()).toBe(0);
    // The old session id is gone: the server answers 404, which is the client's
    // cue to re-initialize rather than retry blindly.
    await expect(before.client.listTools()).rejects.toThrow();
    // Hang the corpse up here rather than in afterEach: its GET stream is
    // already broken, and leaving it open lets the socket error surface during
    // the NEXT test instead of this one.
    await before.client.close().catch(() => {});

    const after = await connect(server.url);
    expect((await after.client.listTools()).tools.map((t) => t.name)).toEqual([
      'echo',
      'add',
      'boom',
    ]);
    expect(server.sessionCount()).toBe(1);
  });

  it('requireBearer answers 401 with a resource_metadata challenge and serves that document', async () => {
    const server = await startServer({ requireBearer: 'tok-abc' });

    const denied = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(denied.status).toBe(401);
    const metadataUrl = `http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource`;
    expect(denied.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${metadataUrl}"`,
    );
    expect(await denied.json()).toMatchObject({ error: 'invalid_token' });

    // The document the challenge points at is public (a 401 there would deadlock
    // discovery) and RFC 9728 shaped.
    const metadata = await fetch(metadataUrl);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: server.url,
      bearer_methods_supported: ['header'],
    });

    const { client } = await connect(server.url, {
      headers: { Authorization: 'Bearer tok-abc' },
    });
    expect((await client.listTools()).tools).toHaveLength(3);
  });

  it('authorizeToken bridges the gate to a fake authorization server', async () => {
    const auth = await startAuth();
    const server = await startServer({
      authorizeToken: (token) => auth.isValidAccessToken(token),
      authorizationServers: [auth.url],
    });

    // A token nobody issued is rejected …
    const denied = await fetch(server.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer not-a-real-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();

    // … and the RFC 9728 document names where to go get a real one.
    const metadata = await (
      await fetch(`http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource`)
    ).json();
    expect(metadata).toMatchObject({ authorization_servers: [auth.url] });

    const code = auth.simulateUserAuthorization(`${auth.url}/authorize?client_id=static`);
    const token = await exchangeCode(auth.url, { code });
    const { client } = await connect(server.url, {
      headers: { Authorization: `Bearer ${String(token.access_token)}` },
    });
    expect((await client.listTools()).tools).toHaveLength(3);

    // expireAccessTokens() is the deterministic stand-in for the clock.
    auth.expireAccessTokens();
    expect(auth.isValidAccessToken(String(token.access_token))).toBe(false);
  });

  it('requestSampling drives sampling/createMessage on the connected client', async () => {
    const server = await startServer({ tools: [] });
    await connect(server.url, { onSampling: (text) => `sampled:${text}` });
    await server.waitForClientStream();

    const result = await server.requestSampling({
      messages: [{ role: 'user', content: { type: 'text', text: 'ping' } }],
      maxTokens: 16,
    });
    expect(result).toMatchObject({
      role: 'assistant',
      model: 'selftest-model',
      content: { type: 'text', text: 'sampled:ping' },
    });
  });

  it('listClientRoots drives roots/list on the connected client', async () => {
    const server = await startServer({ tools: [] });
    await connect(server.url, { roots: [{ uri: 'file:///work', name: 'work' }] });
    await server.waitForClientStream();

    expect(await server.listClientRoots()).toMatchObject({
      roots: [{ uri: 'file:///work', name: 'work' }],
    });
  });

  it('explains itself when a server→client request has no session', async () => {
    const server = await startServer({ tools: [] });
    await expect(server.requestSampling({ messages: [], maxTokens: 1 })).rejects.toThrow(
      /No MCP session is initialized/,
    );
  });

  it('close() is idempotent and frees the port', async () => {
    const server = await startTestMcpServer({ tools: [] });
    const port = server.port;
    await server.close();
    await server.close();
    await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();
  });
});

/** POST the token endpoint with a form body, the way the SDK does. */
async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
}

/** Authorize + redeem in one step; returns the parsed token response. */
async function exchangeCode(
  authUrl: string,
  opts: { code: string; verifier?: string; clientId?: string },
): Promise<Record<string, unknown>> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
  };
  if (opts.verifier) form.code_verifier = opts.verifier;
  if (opts.clientId) form.client_id = opts.clientId;
  const res = await postForm(`${authUrl}/token`, form);
  return (await res.json()) as Record<string, unknown>;
}

describe('startFakeAuthServer — discovery, registration, PKCE, refresh', () => {
  const VERIFIER = 'deuz-test-code-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
  const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');

  /** Walk `/authorize` the way the SDK's `startAuthorization` builds it. */
  function authorizeUrl(auth: FakeAuthServerHandle, over: Record<string, string> = {}): URL {
    const url = new URL(`${auth.url}/authorize`);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: 'client-1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      redirect_uri: 'http://127.0.0.1:9999/callback',
      state: 'state-xyz',
      ...over,
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  it('serves RFC 8414 and RFC 9728 discovery documents', async () => {
    const auth = await startAuth({ scopesSupported: ['mcp:tools'] });

    const as = (await (
      await fetch(`${auth.url}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: auth.url,
      authorization_endpoint: `${auth.url}/authorize`,
      token_endpoint: `${auth.url}/token`,
      registration_endpoint: `${auth.url}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools'],
    });

    const prm = (await (
      await fetch(`${auth.url}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({
      resource: `${auth.url}/`,
      authorization_servers: [auth.url],
      bearer_methods_supported: ['header'],
    });

    expect((await fetch(`${auth.url}/nope`)).status).toBe(404);
  });

  it('POST /register mints credentials, echoes the metadata, and records the request', async () => {
    const auth = await startAuth();

    const res = await fetch(`${auth.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'deuz-selftest',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // RFC 7591 §3.2.1 — the response is metadata + credentials, and the SDK's
    // OAuthClientInformationFullSchema REQUIRES redirect_uris to come back.
    expect(body.client_id).toBe('client-1');
    expect(body.client_secret).toBe('secret-1');
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:9999/callback']);
    expect(body.token_endpoint_auth_method).toBe('client_secret_post');

    expect(auth.registrations).toHaveLength(1);
    expect(auth.registrations[0]!.request).toMatchObject({ client_name: 'deuz-selftest' });
    expect(auth.registrations[0]!.clientId).toBe('client-1');
  });

  it('simulateUserAuthorization records the PKCE challenge, state and redirect_uri', async () => {
    const auth = await startAuth();

    const code = auth.simulateUserAuthorization(authorizeUrl(auth));

    expect(code).toBe('code-1');
    expect(auth.authorizations).toHaveLength(1);
    expect(auth.authorizations[0]).toMatchObject({
      code: 'code-1',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:9999/callback',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      state: 'state-xyz',
      redeemed: false,
    });
    // A URL instance works as well as a string.
    expect(auth.simulateUserAuthorization(new URL(authorizeUrl(auth).toString()))).toBe('code-2');
  });

  it('GET /authorize redirects back with the code and state (loopback flows)', async () => {
    const auth = await startAuth();

    const res = await fetch(authorizeUrl(auth), { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:9999/callback');
    expect(location.searchParams.get('code')).toBe('code-1');
    expect(location.searchParams.get('state')).toBe('state-xyz');
    await res.body?.cancel();
  });

  it('POST /token verifies the PKCE S256 challenge and rejects a wrong verifier', async () => {
    const auth = await startAuth({ accessTokenTtlSeconds: 60 });
    await fetch(`${auth.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/callback'] }),
    });

    const good = auth.simulateUserAuthorization(authorizeUrl(auth));
    const ok = await postForm(`${auth.url}/token`, {
      grant_type: 'authorization_code',
      code: good,
      code_verifier: VERIFIER,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      client_id: 'client-1',
      client_secret: 'secret-1',
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      access_token: 'at-1',
      token_type: 'Bearer',
      expires_in: 60,
      refresh_token: 'rt-1',
    });
    expect(auth.isValidAccessToken('at-1')).toBe(true);
    expect(auth.issued[0]).toMatchObject({ grantType: 'authorization_code', clientId: 'client-1' });

    // Same challenge, wrong verifier → invalid_grant, and nothing new is issued.
    const bad = auth.simulateUserAuthorization(authorizeUrl(auth));
    const rejected = await postForm(`${auth.url}/token`, {
      grant_type: 'authorization_code',
      code: bad,
      code_verifier: `${VERIFIER}-tampered`,
      client_id: 'client-1',
      client_secret: 'secret-1',
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'invalid_grant' });
    expect(auth.issued).toHaveLength(1);

    // Codes are single-use.
    const replayed = await postForm(`${auth.url}/token`, {
      grant_type: 'authorization_code',
      code: good,
      code_verifier: VERIFIER,
      client_id: 'client-1',
      client_secret: 'secret-1',
    });
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' });

    expect(auth.tokenRequests.map((r) => r.status)).toEqual([200, 400, 400]);
    expect(auth.tokenRequests[0]!.params).toMatchObject({ code_verifier: VERIFIER });
  });

  it('accepts client_secret_basic credentials and rejects a wrong secret', async () => {
    const auth = await startAuth();
    await fetch(`${auth.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/callback'] }),
    });
    const code = auth.simulateUserAuthorization(authorizeUrl(auth));

    const wrong = await fetch(`${auth.url}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('client-1:nope').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: VERIFIER,
      }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_client' });

    const right = await fetch(`${auth.url}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: VERIFIER,
      }),
    });
    expect(right.status).toBe(200);
    expect(auth.tokenRequests[0]!.authorizationHeader).toMatch(/^Basic /);
  });

  it('refresh_token grant issues a new access token and invalidates the old one', async () => {
    const auth = await startAuth({ accessTokenTtlSeconds: 30 });
    const code = auth.simulateUserAuthorization(authorizeUrl(auth));
    const first = await exchangeCode(auth.url, { code, verifier: VERIFIER });
    expect(first.access_token).toBe('at-1');

    const refreshed = await postForm(`${auth.url}/token`, {
      grant_type: 'refresh_token',
      refresh_token: String(first.refresh_token),
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Record<string, unknown>;
    expect(second.access_token).toBe('at-2');
    // Non-rotating by default: the SAME refresh token keeps working.
    expect(second.refresh_token).toBe('rt-1');
    expect(auth.isValidAccessToken('at-1')).toBe(false);
    expect(auth.isValidAccessToken('at-2')).toBe(true);

    const again = await postForm(`${auth.url}/token`, {
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
    });
    expect((await again.json()).access_token).toBe('at-3');

    const unknown = await postForm(`${auth.url}/token`, {
      grant_type: 'refresh_token',
      refresh_token: 'rt-does-not-exist',
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rotateRefreshTokens retires the presented refresh token', async () => {
    const auth = await startAuth({ rotateRefreshTokens: true });
    const code = auth.simulateUserAuthorization(authorizeUrl(auth));
    const first = await exchangeCode(auth.url, { code, verifier: VERIFIER });

    const rotated = (await (
      await postForm(`${auth.url}/token`, {
        grant_type: 'refresh_token',
        refresh_token: String(first.refresh_token),
      })
    ).json()) as Record<string, unknown>;
    expect(rotated.refresh_token).toBe('rt-2');

    const stale = await postForm(`${auth.url}/token`, {
      grant_type: 'refresh_token',
      refresh_token: String(first.refresh_token),
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects an unsupported grant and a failed registration', async () => {
    const auth = await startAuth({ registrationStatus: 400 });

    const bad = await postForm(`${auth.url}/token`, { grant_type: 'client_credentials' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'unsupported_grant_type' });
    expect(auth.tokenRequests[0]!.grantType).toBe('client_credentials');

    const register = await fetch(`${auth.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/callback'] }),
    });
    expect(register.status).toBe(400);
    expect(auth.registrations).toHaveLength(0);
  });

  it('close() is idempotent and frees the port', async () => {
    const auth = await startFakeAuthServer();
    const port = auth.port;
    await auth.close();
    await auth.close();
    await expect(
      fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`),
    ).rejects.toThrow();
  });
});
