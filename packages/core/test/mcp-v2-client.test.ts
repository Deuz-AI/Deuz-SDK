/**
 * The v2 SDK line against a 2026-07-28 server — what the modern era CHANGES.
 *
 * `mcp-http.test.ts` and friends already prove the v2 line keeps every 2.2
 * behavior against the 2025-11-25 test server. This file covers the other half:
 * a v2 server (`helpers/mcp-v2-server.ts`, the SDK's own `createMcpHandler`),
 * where the client negotiates 2026-07-28 and three things work differently:
 *
 * - `notifications/tools/list_changed` only travels on a `subscriptions/listen`
 *   stream, which the client must open itself;
 * - `ping` is gone, so the keepalive and the onerror liveness probe ask
 *   `server/discover` instead;
 * - server→client requests are gone: elicitation, sampling and roots arrive as
 *   `input_required` results that the SDK fulfils through our handlers.
 *
 * Connections go through `McpHttpTransport.fetch` straight into the handler —
 * no socket, so timing is deterministic — except where a real one is the point.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { createMcpClient, type McpClientOptions, type McpRootsClient } from '../src/mcp/index';
import { createMockModel } from '../src/testing';
import { manualClock } from './fixtures/manual-clock';
import { startV2TestServer, type V2TestServerHandle } from './helpers/mcp-v2-server';
import { startTestMcpServer, type TestMcpServerHandle } from './helpers/mcp-http-server';

const servers: Array<V2TestServerHandle | TestMcpServerHandle> = [];
const clients: McpRootsClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

const TOOL_CTX = { toolCallId: 'call_1', messages: [] };

function v2Server(...args: Parameters<typeof startV2TestServer>): V2TestServerHandle {
  const server = startV2TestServer(...args);
  servers.push(server);
  return server;
}

/** A v2-line client wired straight into the in-process handler. */
async function connect(
  server: V2TestServerHandle,
  over: Omit<McpClientOptions, 'transport'> = {},
): Promise<McpRootsClient> {
  const client = await createMcpClient({
    sdk: 'v2',
    ...over,
    transport: { type: 'http', url: server.url, fetch: server.fetch },
  });
  clients.push(client);
  return client;
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

const ECHO = {
  name: 'echo',
  description: 'Echo a value back.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  handler: (args: Record<string, unknown>) => `echo:${String(args.value)}`,
};

describe('v2 line ↔ a 2026-07-28 server — negotiation', () => {
  it('negotiates 2026-07-28 by default and serves tools over it', async () => {
    const server = v2Server({ tools: [ECHO], name: 'modern-tools', version: '3.1.0' });
    const client = await connect(server);

    expect(client.protocolVersion?.()).toBe('2026-07-28');
    expect(client.serverInfo?.()).toEqual({ name: 'modern-tools', version: '3.1.0' });
    // The era was settled by the `server/discover` probe — no `initialize` at all.
    expect(server.methods[0]).toBe('server/discover');
    expect(server.methods).not.toContain('initialize');

    const tools = await client.listTools();
    expect(tools.echo!.parameters).toEqual(ECHO.inputSchema); // verbatim, as on 2025-11-25
    expect(await tools.echo!.execute!({ value: 'modern' }, TOOL_CTX)).toBe('echo:modern');
  });

  it("versionNegotiation: 'legacy' keeps the 2025-11-25 handshake against the same server", async () => {
    const server = v2Server({ tools: [ECHO] });
    const client = await connect(server, { versionNegotiation: 'legacy' });

    expect(client.protocolVersion?.()).toBe('2025-11-25');
    expect(server.methods[0]).toBe('initialize');
    expect(server.methods).not.toContain('server/discover');
    expect(await client.callTool('echo', { value: 'old' })).toBe('echo:old');
  });

  it('a pinned 2026-07-28 connects to a modern server and refuses a 2025-only one', async () => {
    const modern = v2Server({ tools: [ECHO] });
    const pinned = await connect(modern, { versionNegotiation: { pin: '2026-07-28' } });
    expect(pinned.protocolVersion?.()).toBe('2026-07-28');

    const legacyOnly = await startTestMcpServer();
    servers.push(legacyOnly);
    await expect(
      createMcpClient({
        sdk: 'v2',
        versionNegotiation: { pin: '2026-07-28' },
        transport: { type: 'http', url: legacyOnly.url },
      }),
    ).rejects.toThrow();
  });
});

describe('v2 line ↔ a 2026-07-28 server — tools/list_changed over subscriptions/listen', () => {
  it('a catalog change reaches onToolListChanged and the next listTools refetches', async () => {
    const server = v2Server({ tools: [ECHO] });
    const client = await connect(server);
    const changes: number[] = [];
    client.onToolListChanged(() => changes.push(1));

    expect(Object.keys(await client.listTools())).toEqual(['echo']);
    // The client opened the listen stream itself — the only road the
    // notification travels on this era.
    expect(server.methods).toContain('subscriptions/listen');

    server.addTool({ name: 'later', handler: () => 'added mid-run' });
    await waitFor(() => changes.length >= 1, 'tools/list_changed on the listen stream');

    const grown = await client.listTools();
    expect(Object.keys(grown)).toEqual(['echo', 'later']);
    expect(await grown.later!.execute!({}, TOOL_CTX)).toBe('added mid-run');
  });

  it('a listen stream cut under the client is reopened, and the tool cache is dropped', async () => {
    const server = v2Server({ tools: [ECHO] });
    const client = await connect(server);
    const changes: number[] = [];
    client.onToolListChanged(() => changes.push(1));
    await client.listTools();
    const listens = (): number => server.methods.filter((m) => m === 'subscriptions/listen').length;
    expect(listens()).toBe(1);

    // A change could have been published while the stream was down, so the cut
    // itself invalidates the cache — and the stream comes back for the next one.
    expect(server.endListenStreams()).toBe(1);
    await waitFor(() => listens() === 2, 'the listen stream to be reopened');
    expect(changes).toHaveLength(1);

    server.addTool({ name: 'after-cut', handler: () => 'ok' });
    await waitFor(() => changes.length >= 2, 'a change on the reopened stream');
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'after-cut']);
  });

  it('a stream cut on a schedule is re-opened every time, however many cuts', async () => {
    // A gateway's maximum response duration, a proxy cap or a rolling restart
    // ends the long-lived listen response every so often, with no catalog
    // change in between. Those cuts must not count as a crash loop: push
    // invalidation has to outlive any number of them.
    const { clock, advance } = manualClock();
    const server = v2Server({ tools: [ECHO] });
    const client = await connect(server, { clock });
    const changes: number[] = [];
    client.onToolListChanged(() => changes.push(1));
    await client.listTools();
    const listens = (): number => server.methods.filter((m) => m === 'subscriptions/listen').length;

    for (let cut = 1; cut <= 6; cut++) {
      await advance(60_000); // the stream stays open, and quiet, for a minute
      await waitFor(() => server.endListenStreams() === 1, `cut ${cut}`);
      await waitFor(() => listens() === cut + 1, `the re-listen after cut ${cut}`);
    }
    expect(client.status()).toBe('connected');

    // The catalog changes only now: the stream reopened after the sixth cut delivers it.
    server.addTool({ name: 'late', handler: () => 'late' });
    await waitFor(() => changes.length > 6, 'tools/list_changed on the reopened stream');
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'late']);
  }, 20_000);

  it('a stream that keeps ending as soon as it opens is given up after three re-opens', async () => {
    // The cap that remains: a server ending every subscription at once must not
    // spin a re-listen loop. Giving up is reported, and the liveness probe keeps
    // the session, which still serves its tools.
    const { clock } = manualClock();
    const server = v2Server({ tools: [ECHO] });
    const client = await connect(server, { clock });
    const listens = (): number => server.methods.filter((m) => m === 'subscriptions/listen').length;
    const discovers = (): number => server.methods.filter((m) => m === 'server/discover').length;

    for (let cut = 1; cut <= 3; cut++) {
      await waitFor(() => server.endListenStreams() === 1, `cut ${cut}`);
      await waitFor(() => listens() === cut + 1, `the re-listen after cut ${cut}`);
    }
    const probesBefore = discovers();
    await waitFor(() => server.endListenStreams() === 1, 'cut 4');
    await waitFor(() => discovers() > probesBefore, 'the liveness probe after giving up');

    expect(listens()).toBe(4);
    expect(client.status()).toBe('connected');
    expect(await client.callTool('echo', { value: 'still here' })).toBe('echo:still here');
  });
});

describe('v2 line ↔ a 2026-07-28 server — liveness without ping', () => {
  it('the keepalive probes with server/discover and the session stays connected', async () => {
    const { clock, advance } = manualClock();
    const server = v2Server({ tools: [ECHO] });
    const statuses: string[] = [];
    const client = await connect(server, {
      clock,
      keepAliveMs: 1_000,
      reconnect: { jitter: 0 },
      onStatusChange: (status) => statuses.push(status),
    });
    const discoversBefore = server.methods.filter((m) => m === 'server/discover').length;

    await advance(1_000);
    await advance(1_000);

    // `ping` is not on the 2026-07-28 wire: sending it fails locally, which used
    // to read as a dead session and tear a healthy one down every heartbeat.
    expect(server.methods).not.toContain('ping');
    expect(server.methods.filter((m) => m === 'server/discover').length).toBe(discoversBefore + 2);
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(await client.callTool('echo', { value: 'alive' })).toBe('echo:alive');
  });

  it('a server that goes away fails the discover probe and the client reconnects when it is back', async () => {
    const { clock, advance } = manualClock();
    const server = v2Server({ tools: [ECHO] });
    const statuses: string[] = [];
    const client = await connect(server, {
      clock,
      keepAliveMs: 1_000,
      reconnect: { jitter: 0, initialDelayMs: 100 },
      onStatusChange: (status) => statuses.push(status),
    });

    server.down = true;
    await advance(1_000); // heartbeat → discover rejects → drop
    expect(client.status()).toBe('reconnecting');

    server.down = false;
    await advance(100); // the backoff elapses, the attempt lands
    await waitFor(() => client.status() === 'connected', 'the reconnect');

    expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    expect(client.protocolVersion?.()).toBe('2026-07-28');
    expect(await client.callTool('echo', { value: 'back' })).toBe('echo:back');
  });
});

describe('v2 line ↔ a 2026-07-28 server — input_required replaces server→client requests', () => {
  it('elicitation: the server asks mid-call, onElicitationRequest answers, the tool completes', async () => {
    const asked: unknown[] = [];
    const server = v2Server({
      tools: [
        {
          name: 'deploy',
          handler: (_args, ctx: ServerContext) => {
            const answer = acceptedContent<{ env: string }>(ctx.mcpReq.inputResponses, 'target');
            if (!answer) {
              return inputRequired({
                inputRequests: {
                  target: inputRequired.elicit({
                    message: 'Deploy where?',
                    requestedSchema: {
                      type: 'object',
                      properties: { env: { type: 'string' } },
                      required: ['env'],
                    },
                  }),
                },
              });
            }
            return `deployed to ${answer.env}`;
          },
        },
      ],
    });
    const client = await connect(server, {
      onElicitationRequest: (request) => {
        asked.push(request);
        return { action: 'accept', content: { env: 'staging' } };
      },
    });

    expect(await client.callTool('deploy', {})).toBe('deployed to staging');
    expect(asked).toEqual([
      {
        mode: 'form',
        message: 'Deploy where?',
        requestedSchema: {
          type: 'object',
          properties: { env: { type: 'string' } },
          required: ['env'],
        },
      },
    ]);
    // Two rounds of the SAME tools/call — and no server→client request at all.
    expect(server.methods.filter((m) => m === 'tools/call')).toHaveLength(2);
    expect(server.methods).not.toContain('elicitation/create');
  });

  it('URL-mode elicitation reaches the same handler, with no elicitationId on this era', async () => {
    const asked: unknown[] = [];
    const server = v2Server({
      tools: [
        {
          name: 'login',
          handler: (_args, ctx: ServerContext) => {
            const reply = inputResponse(ctx.mcpReq.inputResponses, 'consent');
            if (reply.kind !== 'elicit') {
              return inputRequired({
                inputRequests: {
                  consent: inputRequired.elicitUrl({
                    message: 'Sign in to continue.',
                    url: 'https://auth.example.com/start',
                  }),
                },
              });
            }
            return `consent:${reply.action}`;
          },
        },
      ],
    });
    const client = await connect(server, {
      onElicitationRequest: (request) => {
        asked.push(request);
        return { action: 'accept' };
      },
    });

    expect(await client.callTool('login', {})).toBe('consent:accept');
    // The 2025-era `elicitationId` is not part of the 2026-07-28 URL-mode shape.
    expect(asked).toEqual([
      {
        mode: 'url',
        message: 'Sign in to continue.',
        url: 'https://auth.example.com/start',
        elicitationId: '',
      },
    ]);
  });

  it('sampling: the server asks for a completion, our model answers, the tool completes', async () => {
    const model = createMockModel({ responses: [{ text: 'a haiku about MCP' }] });
    const server = v2Server({
      tools: [
        {
          name: 'poet',
          handler: (_args, ctx: ServerContext) => {
            const reply = inputResponse(ctx.mcpReq.inputResponses, 'draft');
            if (reply.kind !== 'sampling') {
              return inputRequired({
                inputRequests: {
                  draft: inputRequired.createMessage({
                    messages: [{ role: 'user', content: { type: 'text', text: 'Write a haiku.' } }],
                    maxTokens: 64,
                  }),
                },
              });
            }
            const content = reply.result.content as { type: string; text?: string };
            return `poem: ${content.text ?? ''}`;
          },
        },
      ],
    });
    const client = await connect(server, { sampling: { model } });

    expect(await client.callTool('poet', {})).toBe('poem: a haiku about MCP');
  });

  it('roots: the server asks, the configured roots answer as file:// URIs', async () => {
    const server = v2Server({
      tools: [
        {
          name: 'where',
          handler: (_args, ctx: ServerContext) => {
            const reply = inputResponse(ctx.mcpReq.inputResponses, 'roots');
            if (reply.kind !== 'roots') {
              return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
            }
            return reply.roots.map((r) => r.uri).join(',');
          },
        },
      ],
    });
    const client = await connect(server, { roots: ['/srv/app'] });

    expect(await client.callTool('where', {})).toBe('file:///srv/app');
    // setRoots on this era: `notifications/roots/list_changed` is not on the
    // 2026-07-28 wire, so nothing is sent — and nothing is lost, because the
    // server asks again per request and reads the swapped list.
    await client.setRoots(['/srv/next']);
    expect(server.methods).not.toContain('notifications/roots/list_changed');
    expect(await client.callTool('where', {})).toBe('file:///srv/next');
  });
});
