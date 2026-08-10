/**
 * mcp-http.test.ts — `createMcpClient({ transport: { type: 'http', … } })` end to
 * end against a REAL streamable-HTTP MCP server.
 *
 * Until 2.0 the only integration coverage MCP had was `mcp-stdio.test.ts`, i.e. a
 * spawned child process. The HTTP path — the one every hosted connector actually
 * uses — was exercised only through hand-written fakes in `mcp.test.ts`. This file
 * closes that gap with `test/helpers/mcp-http-server.ts`: a real `node:http`
 * listener on 127.0.0.1, the real SDK server transport, real SSE framing. The
 * first three describes are deliberately the STDIO SUITE'S ASSERTIONS REPLAYED
 * over HTTP (tool shape, execute round-trip, namespacing) so the two transports
 * are pinned to one canonical `ToolSet` contract.
 *
 * The lifecycle describes are the new surface: status transitions, idempotent
 * close, tool-list invalidation over the live SSE stream, and reconnect.
 *
 * Two things make the timing deterministic despite the real sockets:
 *
 * - Every lifecycle timer (backoff, keepalive) runs on an INJECTED clock, so
 *   `clock.fire()` runs one scheduled callback instead of sleeping. `jitter: 0`
 *   turns the backoff into exact, assertable numbers. No `vi.useFakeTimers()` —
 *   it would freeze the HTTP round-trips too.
 * - Everything the server pushes (`tools/list_changed`) or that a rejected
 *   promise triggers is awaited with `waitFor` polling, never a fixed sleep.
 *
 * Every listener and client is torn down in `afterEach`, in that order.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createMcpClient, type McpClientOptions, type McpConnectionStatus } from '../src/mcp/index';
import type { Clock } from '../src/types/deps';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
  type TestMcpServerOptions,
} from './helpers/mcp-http-server';

type HttpMcpClient = Awaited<ReturnType<typeof createMcpClient>>;

/** The tool-execute context shape; MCP tools ignore it, so one constant does. */
const TOOL_CTX = { toolCallId: 'call_1', messages: [] };

const servers: TestMcpServerHandle[] = [];
const clients: HttpMcpClient[] = [];

beforeAll(async () => {
  // Warm the optional peer's module graph once (express/hono/zod/ajv/…). Vitest
  // transforms it on first import, and that cost would otherwise be billed to
  // whichever test runs first and read as a timeout.
  await import('@modelcontextprotocol/sdk/client/index.js');
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await import('@modelcontextprotocol/sdk/server/index.js');
  await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
}, 60_000);

afterEach(async () => {
  // Clients first: closing one whose server is already gone still has to resolve.
  while (clients.length > 0) {
    await clients
      .pop()!
      .close()
      .catch(() => {
        /* the session may already be dead (restart/close tests) */
      });
  }
  while (servers.length > 0) await servers.pop()!.close();
});

async function startServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServerHandle> {
  const server = await startTestMcpServer(opts);
  servers.push(server);
  return server;
}

/** Connect over HTTP; the client is auto-closed in `afterEach`. */
async function connect(
  url: string,
  over: Omit<McpClientOptions, 'transport'> & {
    transport?: Partial<McpClientOptions['transport']>;
  } = {},
): Promise<HttpMcpClient> {
  const { transport, ...lifecycle } = over;
  const client = await createMcpClient({
    ...lifecycle,
    transport: { type: 'http', url, ...transport },
  });
  clients.push(client);
  return client;
}

/** Poll until `pred` holds — the server pushes over SSE, so there is nothing to await. */
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

interface FakeClock extends Clock {
  /** Every delay handed to `setTimeout`, in scheduling order — the backoff assertion. */
  delays: number[];
  pending(): number;
  /** Fire the earliest pending timer (synchronously; the work it starts is async). */
  fire(): void;
}

function makeFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  let timers: FakeTimer[] = [];
  const delays: number[] = [];
  return {
    delays,
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      delays.push(ms);
      timers.push({ id, at: now + ms, fn });
      return () => {
        timers = timers.filter((t) => t.id !== id);
      };
    },
    pending: () => timers.length,
    fire() {
      const next = timers.reduce<FakeTimer | undefined>(
        (earliest, t) => (!earliest || t.at < earliest.at ? t : earliest),
        undefined,
      );
      if (!next) return;
      timers = timers.filter((t) => t.id !== next.id);
      now = next.at;
      next.fn();
    },
  };
}

function trackStatus(): {
  seen: Array<[McpConnectionStatus, number | undefined]>;
  onStatusChange: NonNullable<McpClientOptions['onStatusChange']>;
} {
  const seen: Array<[McpConnectionStatus, number | undefined]> = [];
  return { seen, onStatusChange: (status, info) => seen.push([status, info?.attempt]) };
}

describe('createMcpClient over HTTP — the canonical ToolSet (parity with mcp-stdio)', () => {
  it('listTools() maps MCP tools to a ToolSet with inputSchema verbatim on parameters', async () => {
    const server = await startServer();
    const client = await connect(server.url);
    const tools = await client.listTools();

    expect(Object.keys(tools)).toEqual(['echo', 'add', 'boom']);
    expect(tools.echo!.description).toBe('Echo a value back.');
    // The MCP inputSchema IS JSON Schema — it travels to `parameters` byte for
    // byte, over HTTP exactly as over stdio (no re-derivation, no `$schema`).
    expect(tools.echo!.parameters).toEqual({
      type: 'object',
      properties: { value: { type: 'string', description: 'Text to echo.' } },
      required: ['value'],
      additionalProperties: false,
    });
    expect(tools.echo!.execute).toBeTypeOf('function');
    // A server that declares no outputSchema must not grow one in the mapping.
    expect('outputSchema' in tools.echo!).toBe(false);
    expect(client.status()).toBe('connected');
  });

  it('execute() round-trips over the wire: text, structuredContent priority, is_error self-heal', async () => {
    const server = await startServer();
    const client = await connect(server.url);
    const tools = await client.listTools();

    expect(await tools.echo!.execute!({ value: 'hi' }, TOOL_CTX)).toBe('echo:hi');
    // Per spec the text block is a redundant serialization of structuredContent —
    // the structured value wins and comes back verbatim, not as its JSON text.
    expect(await tools.add!.execute!({ a: 2, b: 3 }, TOOL_CTX)).toEqual({ sum: 5 });
    // An MCP `isError` result THROWS so the tool loop records an is_error
    // tool_result the model can recover from — never a silent empty string.
    await expect(tools.boom!.execute!({}, TOOL_CTX)).rejects.toThrow('tool exploded');

    // The arguments reached the server unmangled, in order.
    expect(server.calls).toEqual([
      { name: 'echo', args: { value: 'hi' } },
      { name: 'add', args: { a: 2, b: 3 } },
      { name: 'boom', args: {} },
    ]);
  });

  it('callTool() reaches the server directly and rejects on an unknown tool', async () => {
    const server = await startServer();
    const client = await connect(server.url);

    expect(await client.callTool('echo', { value: 'direct' })).toBe('echo:direct');
    expect(await client.callTool('add', { a: 1, b: 1 })).toEqual({ sum: 2 });
    // Unknown tool is a PROTOCOL error, not a recoverable `isError` result.
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);
  });

  it('namespaces tool names when combining servers', async () => {
    const server = await startServer();
    const client = await connect(server.url);

    const tools = await client.listTools('fixture');
    expect(Object.keys(tools)).toEqual(['fixture_echo', 'fixture_add', 'fixture_boom']);
    // The namespace is a local alias — the wire call still uses the bare name.
    expect(await tools.fixture_echo!.execute!({ value: 'x' }, TOOL_CTX)).toBe('echo:x');
    expect(server.calls).toEqual([{ name: 'echo', args: { value: 'x' } }]);
  });

  it('forwards transport.headers on every request (and surfaces a bare 401 unwrapped)', async () => {
    const server = await startServer({ requireBearer: 'tok-abc' });

    // Without OAuth configured the transport error passes through as-is: nothing
    // here can start a flow, so it must NOT be dressed up as the actionable
    // McpAuthorizationRequiredError (that upgrade belongs to the `auth` option).
    const failure = await createMcpClient({
      transport: { type: 'http', url: server.url },
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/invalid_token/);
    expect((failure as Error).name).not.toBe('McpAuthorizationRequiredError');

    const client = await connect(server.url, {
      transport: { headers: { Authorization: 'Bearer tok-abc' } },
    });
    // The header rides the initialize POST, the tools/list POST and the
    // tools/call POST alike — a header that only reached the handshake would
    // have failed one of these three.
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);
    expect(await client.callTool('echo', { value: 'authed' })).toBe('echo:authed');
  });
});

describe('createMcpClient over HTTP — status and close', () => {
  it('reports connecting → connected and settles there on a healthy session', async () => {
    const server = await startServer();
    const { seen, onStatusChange } = trackStatus();

    const client = await connect(server.url, { onStatusChange });
    // `connecting` is emitted even though it is the initial value, so a listener
    // sees the whole trace rather than only the transitions after the handshake.
    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
    ]);

    await client.listTools();
    await client.callTool('echo', { value: 'still healthy' });
    expect(seen).toHaveLength(2);
    expect(client.status()).toBe('connected');
  });

  it('close() is idempotent: the second call resolves and the session stays down', async () => {
    const server = await startServer();
    const { seen, onStatusChange } = trackStatus();
    const client = await connect(server.url, { onStatusChange });
    await client.listTools();

    await client.close();
    expect(client.status()).toBe('closed');

    // The SDK fires onclose as part of close(); that must not read as a drop, so
    // a second close is a no-op rather than a second `closed` transition.
    await expect(client.close()).resolves.toBeUndefined();
    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
      ['closed', undefined],
    ]);

    await expect(client.callTool('echo', { value: 'after close' })).rejects.toThrow();
  });
});

describe('createMcpClient over HTTP — tools/list_changed invalidation', () => {
  it('a pushed tools/list_changed fires subscribers and makes listTools refetch', async () => {
    const server = await startServer();
    const client = await connect(server.url);
    const changes: number[] = [];
    const off = client.onToolListChanged(() => changes.push(changes.length + 1));
    // Notifications ride the standalone GET SSE stream, which opens after connect().
    await server.waitForClientStream();

    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);

    server.addTool({ name: 'later', description: 'Added mid-run.', handler: () => 'ok' });
    await waitFor(() => changes.length >= 1, 'tools/list_changed after addTool');
    // The cache was dropped by the notification, so this refetches — and the new
    // tool is immediately callable through the mapped ToolSet.
    const grown = await client.listTools();
    expect(Object.keys(grown)).toEqual(['echo', 'add', 'boom', 'later']);
    expect(await grown.later!.execute!({}, TOOL_CTX)).toBe('ok');

    server.removeTool('later');
    await waitFor(() => changes.length >= 2, 'tools/list_changed after removeTool');
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);

    // Unsubscribing stops OUR callback; the wrapper keeps its own subscription,
    // so the cache still refreshes.
    off();
    server.addTool({ name: 'last', handler: () => 'ok' });
    await waitFor(
      async () => Object.keys(await client.listTools()).includes('last'),
      'the cache to refresh after unsubscribing',
    );
    expect(changes).toHaveLength(2);
  });
});

describe('createMcpClient over HTTP — reconnect', () => {
  it('a failed keepalive after a server restart drives reconnecting → connected', async () => {
    const clock = makeFakeClock();
    const { seen, onStatusChange } = trackStatus();
    const server = await startServer();
    const client = await connect(server.url, {
      clock,
      onStatusChange,
      keepAliveMs: 30_000,
      reconnect: { jitter: 0, initialDelayMs: 100 },
    });
    // Built against the session that is about to die — the McpToolCaller
    // indirection is what has to carry it onto the next one.
    const tools = await client.listTools();
    expect(clock.delays).toEqual([30_000]); // the keepalive is armed on connect

    await server.restart();

    // NOTE: the drop is discovered by the PING, not by an onclose. The SDK's
    // StreamableHTTPClientTransport answers a dead socket with `onerror` plus its
    // own GET-stream retries and never closes the client, so `keepAliveMs` is the
    // only session-level drop detector the HTTP transport has (see the
    // characterization test below).
    clock.fire();
    await waitFor(() => client.status() === 'reconnecting', 'the failed ping to report a drop');
    expect(clock.delays).toEqual([30_000, 100]);

    clock.fire();
    await waitFor(() => client.status() === 'connected', 'the reconnect to land');

    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
      ['reconnecting', 1],
      ['connected', undefined],
    ]);
    // A brand-new session on the restarted listener, and the keepalive is re-armed.
    expect(server.sessionCount()).toBe(1);
    expect(clock.delays).toEqual([30_000, 100, 30_000]);

    // The ToolSet mapped before the drop still lands — on the NEW session.
    expect(await tools.echo!.execute!({ value: 'after' }, TOOL_CTX)).toBe('echo:after');
    expect(await client.callTool('add', { a: 20, b: 22 })).toEqual({ sum: 42 });
    expect(server.calls.at(-1)).toEqual({ name: 'add', args: { a: 20, b: 22 } });
  }, 20_000);

  it('backs off on the injected clock (jitter: 0 ⇒ exact) and ends in error when attempts run out', async () => {
    const clock = makeFakeClock();
    const { seen, onStatusChange } = trackStatus();
    const server = await startServer();
    const client = await connect(server.url, {
      clock,
      onStatusChange,
      keepAliveMs: 5_000,
      reconnect: { jitter: 0, maxAttempts: 3, initialDelayMs: 100 },
    });
    await client.listTools();

    // Gone for good: the reconnect attempt now hits a closed port. (`close()` is
    // idempotent, so the afterEach sweep is still fine.)
    await server.close();

    clock.fire(); // the keepalive ping → rejects → drop
    await waitFor(() => client.status() === 'reconnecting', 'the drop to be noticed');
    // Every delay came off the INJECTED clock: 5_000 for the keepalive, then the
    // first backoff — exactly `initialDelayMs`, because jitter is 0.
    expect(clock.delays).toEqual([5_000, 100]);

    // Each fire releases one backoff sleep; the attempt behind it hits a closed
    // port, so the loop advances and arms the next, longer delay.
    clock.fire();
    await waitFor(() => clock.delays.length === 3, 'the second attempt to be scheduled');
    clock.fire();
    await waitFor(() => clock.delays.length === 4, 'the third attempt to be scheduled');
    clock.fire();
    await waitFor(() => client.status() === 'error', 'the attempts to run out');

    // `maxAttempts` bounds the recovery: exactly three tries, then we give up.
    // A failed handshake must not fork a second loop — the SDK closes its own
    // client when initialize fails, and an eagerly-armed `onclose` used to read
    // that as a fresh drop, restarting the counter and making this unbounded.
    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
      ['reconnecting', 1],
      ['reconnecting', 2],
      ['reconnecting', 3],
      ['error', undefined],
    ]);
    // 100 → 200 → 400: initialDelayMs * factor ** (attempt - 1), exact at jitter 0.
    expect(clock.delays).toEqual([5_000, 100, 200, 400]);
    // Giving up leaves nothing armed.
    expect(clock.pending()).toBe(0);
  }, 20_000);

  it('a healthy keepalive re-arms itself and never disturbs the status', async () => {
    const clock = makeFakeClock();
    const { seen, onStatusChange } = trackStatus();
    const server = await startServer();
    const client = await connect(server.url, {
      clock,
      onStatusChange,
      keepAliveMs: 1_000,
      reconnect: { jitter: 0 },
    });

    // Chained, not periodic: the next ping is scheduled only once the previous
    // one has answered, so a slow server can never stack pings.
    expect(clock.pending()).toBe(1);
    clock.fire();
    await waitFor(() => clock.delays.length === 2, 'the keepalive to re-arm');
    expect(clock.pending()).toBe(1);
    clock.fire();
    await waitFor(() => clock.delays.length === 3, 'the keepalive to re-arm again');

    expect(clock.delays).toEqual([1_000, 1_000, 1_000]);
    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
    ]);
    expect(await client.callTool('echo', { value: 'alive' })).toBe('echo:alive');
    expect(server.sessionCount()).toBe(1);
  }, 20_000);

  it('CHARACTERIZATION: without keepAliveMs a dead HTTP session still reports connected', async () => {
    const clock = makeFakeClock();
    const { seen, onStatusChange } = trackStatus();
    const server = await startServer();
    const client = await connect(server.url, {
      clock,
      onStatusChange,
      reconnect: { jitter: 0, initialDelayMs: 100 },
    });
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);

    await server.restart();

    // Nothing schedules and nothing transitions: the SDK's HTTP transport reports
    // a dropped socket through `onerror` only, and `createManagedConnection`
    // reconnects off `onclose`. So the session is dead, the status is a lie, and
    // the tool cache happily serves the list it captured before the restart …
    expect(clock.delays).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
    ]);
    expect(client.status()).toBe('connected');
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);
    // … while anything that actually touches the wire fails, because the session
    // id the transport still carries is 404 on the restarted listener.
    await expect(client.callTool('echo', { value: 'ghost' })).rejects.toThrow();
    expect(client.status()).toBe('connected');
    // Configure `keepAliveMs` and the same restart recovers — see the test above.
  }, 20_000);
});
