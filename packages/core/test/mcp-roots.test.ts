/**
 * `roots/list` END TO END — the second direction where the SERVER calls US.
 *
 * `test/mcp-sampling-unit.test.ts` pins `normalizeRootUri` / `buildRootsHandler`
 * / `attachRoots` as pure functions; this file runs the same contract through a
 * real `node:http` listener, the real `@modelcontextprotocol/sdk` server
 * transport and our real `createMcpClient`, so what it asserts is what a hosted
 * MCP server would actually observe.
 *
 * Two things only a live session can show:
 *
 * - The `initialize` params. `recordHttp()` swaps `globalThis.fetch` — what the
 *   SDK's `StreamableHTTPClientTransport` reaches for — so the declared
 *   capabilities are read off the wire rather than inferred.
 * - `notifications/roots/list_changed`. `setRoots()` resolving already proves
 *   the POST was accepted by the real server, and the recorded body proves it
 *   was the right notification; the follow-up `roots/list` proves the REGISTERED
 *   handler (installed once, before connect) now reads the new list.
 *
 * Note for anyone extending this: MCP's `RootSchema` requires every `uri` to
 * start with `file://`, and `roots/list` is validated as a WHOLE array — so one
 * `https://` root would make a live server discard all of them. That is why
 * `createMcpClient`/`setRoots` refuse a non-file scheme up front, which the last
 * describe pins against the real server (nothing is sent, nothing is lost).
 *
 * Every server and client is torn down in `afterEach`; the fetch swap too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMcpClient, type McpRootsClient } from '../src/mcp';
import { InvalidRequestError } from '../src/errors';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
  type TestMcpServerOptions,
} from './helpers/mcp-http-server';

// ===================================================================
// Harness plumbing
// ===================================================================

const servers: TestMcpServerHandle[] = [];
const clients: McpRootsClient[] = [];
let realFetch: typeof fetch | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      // A test may have closed it already, or killed the server under it.
    }
  }
  for (const server of servers.splice(0)) await server.close();
  if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = undefined;
  }
});

/** Roots need no tool catalog — an empty one is one less variable. */
async function startServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServerHandle> {
  const server = await startTestMcpServer({ tools: [], ...opts });
  servers.push(server);
  return server;
}

/**
 * Connect and wait for the standalone GET SSE stream: `roots/list` is a
 * server→client request and only exists once that stream is live.
 */
async function connect(
  server: TestMcpServerHandle,
  options: Omit<Parameters<typeof createMcpClient>[0], 'transport'> = {},
): Promise<McpRootsClient> {
  const client = await createMcpClient({
    transport: { type: 'http', url: server.url },
    ...options,
  });
  clients.push(client);
  await server.waitForClientStream();
  return client;
}

/** Record every JSON-RPC body the MCP transport POSTs (see the file header). */
function recordHttp(): string[] {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  realFetch = original;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    return original(input, init);
  }) as typeof fetch;
  return bodies;
}

/** `capabilities` from every `initialize` request, in connection order. */
function declaredCapabilities(bodies: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of bodies) {
    const msg = JSON.parse(raw) as {
      method?: string;
      params?: { capabilities?: Record<string, unknown> };
    };
    if (msg.method === 'initialize') out.push(msg.params?.capabilities ?? {});
  }
  return out;
}

/** Every client→server method name seen on the wire, in order (responses have none). */
function sentMethods(bodies: string[]): string[] {
  const out: string[] = [];
  for (const raw of bodies) {
    const msg = JSON.parse(raw) as { method?: string };
    if (typeof msg.method === 'string') out.push(msg.method);
  }
  return out;
}

// ===================================================================
// Capability declaration — read off the real `initialize` params
// ===================================================================

describe('roots capability declaration', () => {
  it('declares `roots: { listChanged: true }` only when roots are configured', async () => {
    const bodies = recordHttp();
    const plain = await startServer();
    const rooted = await startServer();

    await connect(plain, {});
    await connect(rooted, { roots: ['/srv/app'] });

    // `listChanged` is advertised because `setRoots()` really does notify —
    // declaring it without that would lie to the server.
    expect(declaredCapabilities(bodies)).toEqual([{}, { roots: { listChanged: true } }]);
  });

  it('declares the capability for an EMPTY roots list (an explicit "none")', async () => {
    const bodies = recordHttp();
    const server = await startServer();

    await connect(server, { roots: [] });

    expect(declaredCapabilities(bodies)).toEqual([{ roots: { listChanged: true } }]);
    expect(await server.listClientRoots()).toEqual({ roots: [] });
  });

  it('refuses roots/list on a client that declared nothing', async () => {
    const server = await startServer();
    await connect(server, {});

    // No capability AND no registered handler: JSON-RPC -32601, not a silent [].
    await expect(server.listClientRoots()).rejects.toThrow(/MCP error -32601: Method not found/);
  });
});

// ===================================================================
// roots/list
// ===================================================================

describe('roots/list over a real MCP server', () => {
  it('answers with normalized file:// URIs', async () => {
    const server = await startServer();
    await connect(server, {
      roots: ['/srv/app', 'C:\\Users\\umut\\project', 'file:///already/a/uri'],
    });

    expect(await server.listClientRoots()).toEqual({
      roots: [
        // A plain POSIX path is promoted…
        { uri: 'file:///srv/app' },
        // …a Windows path is promoted AND its separators flipped (a backslash
        // path is not a URI at all)…
        { uri: 'file://C:/Users/umut/project' },
        // …and something already carrying a scheme travels verbatim.
        { uri: 'file:///already/a/uri' },
      ],
    });
  });

  it('re-reads a function form on every request (async)', async () => {
    const server = await startServer();
    let n = 0;
    await connect(server, { roots: async () => [`/run/${++n}`] });

    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///run/1' }] });
    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///run/2' }] });
    expect(n).toBe(2);
  });

  it('re-reads a function form on every request (sync)', async () => {
    const server = await startServer();
    const live = ['/first'];
    await connect(server, { roots: () => [...live] });

    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///first' }] });
    live.push('/second');
    expect(await server.listClientRoots()).toEqual({
      roots: [{ uri: 'file:///first' }, { uri: 'file:///second' }],
    });
  });
});

// ===================================================================
// setRoots
// ===================================================================

describe('setRoots over a real MCP server', () => {
  it('notifies the server, which then sees the new list', async () => {
    const bodies = recordHttp();
    const server = await startServer();
    const client = await connect(server, { roots: ['/one'] });

    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///one' }] });

    // Resolving means the real server accepted the POST (the transport rejects
    // on any non-2xx), and the recorded body names the notification.
    await client.setRoots(['/two', 'C:\\three']);
    expect(sentMethods(bodies)).toContain('notifications/roots/list_changed');

    // The handler was registered ONCE, before connect — it reads through to the
    // swapped box rather than being re-registered.
    expect(await server.listClientRoots()).toEqual({
      roots: [{ uri: 'file:///two' }, { uri: 'file://C:/three' }],
    });
  });

  it('sends the notification once per call, in order', async () => {
    const bodies = recordHttp();
    const server = await startServer();
    const client = await connect(server, { roots: ['/one'] });

    await client.setRoots(['/two']);
    await client.setRoots(['/three']);

    expect(
      sentMethods(bodies).filter((m) => m === 'notifications/roots/list_changed'),
    ).toHaveLength(2);
    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///three' }] });
  });

  it('replaces a function form with the fixed list it was given', async () => {
    const server = await startServer();
    let reads = 0;
    const client = await connect(server, {
      roots: () => {
        reads += 1;
        return ['/dynamic'];
      },
    });

    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///dynamic' }] });
    await client.setRoots(['/fixed']);

    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///fixed' }] });
    // The function is gone, not merely shadowed.
    expect(reads).toBe(1);
  });

  it('rejects with InvalidRequestError on a client created without `roots`', async () => {
    const server = await startServer();
    const client = await connect(server, {});

    // The capability is declared at construction; announcing a change to
    // something we never advertised would lie to the server.
    await expect(client.setRoots(['/x'])).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(client.setRoots(['/x'])).rejects.toThrow(/needs a `roots` option/);
  });

  it('does not send the notification when setRoots refuses', async () => {
    const bodies = recordHttp();
    const server = await startServer();
    const client = await connect(server, {});

    await expect(client.setRoots(['/x'])).rejects.toThrow(InvalidRequestError);

    expect(sentMethods(bodies)).not.toContain('notifications/roots/list_changed');
  });
});

// ===================================================================
// Non-file schemes — refused HERE, because the server refuses ALL of them
// ===================================================================

describe('non-file roots are refused at the call, not on the wire', () => {
  it('createMcpClient rejects a non-file scheme with an actionable error', async () => {
    const server = await startServer();

    const failure = await createMcpClient({
      transport: { type: 'http', url: server.url },
      roots: ['/srv/app', 'https://example.com/repo'],
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(InvalidRequestError);
    // Which value, why, and what to pass instead.
    expect((failure as Error).message).toMatch(/https:\/\/example\.com\/repo/);
    expect((failure as Error).message).toMatch(/file:\/\/ roots only/);
    expect((failure as Error).message).toMatch(/pass a filesystem path/);
  });

  it('is what a live server would have done to the WHOLE list anyway', async () => {
    const server = await startServer();
    // Prove the premise rather than assert it: a handler that answers with an
    // https root fails MCP's result validation, and the good root beside it dies
    // with it. That total loss is what the eager rejection replaces.
    await connect(server, { roots: () => ['/srv/app', 'https://example.com/repo'] });

    await expect(server.listClientRoots()).rejects.toThrow();
    // The reachable roots are still reachable once the bad one is gone.
    const clean = await startServer();
    await connect(clean, { roots: ['/srv/app'] });
    expect(await clean.listClientRoots()).toEqual({ roots: [{ uri: 'file:///srv/app' }] });
  });

  it('setRoots rejects, sends nothing, and leaves the server on the old list', async () => {
    const bodies = recordHttp();
    const server = await startServer();
    const client = await connect(server, { roots: ['/one'] });

    await expect(client.setRoots(['/two', 'https://example.com/repo'])).rejects.toThrow(
      InvalidRequestError,
    );

    expect(sentMethods(bodies)).not.toContain('notifications/roots/list_changed');
    // Refused BEFORE the swap — `/two` never became visible either.
    expect(await server.listClientRoots()).toEqual({ roots: [{ uri: 'file:///one' }] });
  });
});
