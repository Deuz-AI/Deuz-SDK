/**
 * The `toolCallId` a served call carries (2.5). Tools key idempotent writes on
 * it (the versioned memory tools derive their operation id from it), so it must
 * name ONE call: two unrelated calls never share it, and a call the protocol
 * can recognise as a retry keeps it.
 *
 * JSON-RPC ids restart with every connection, so the id alone cannot be the
 * key: a second client's `tools/call` id 1 would replay the first client's (a
 * false `replayed`, or an `OperationConflictError` when the content differs).
 * The rule pinned here: the id is qualified by its serving unit, which is one
 * HTTP request (2026-07-28, and the stateless 2025-era fallback) or one stdio
 * connection. Within a stdio session MCP forbids reusing a request id, so a
 * resent id there is the same request and replays.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1HttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as V2Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpServer, type DeuzMcpServer } from '../src/mcp/server';
import { serveMcpStdio } from '../src/node/mcp-server';
import {
  createInMemoryVersionedMemoryStore,
  createMemorySession,
  createVersionedMemoryTools,
  type VersionedMemoryStore,
} from '../src/memory/versioned';
import type { MemoryScope } from '../src/memory';
import type { ToolExecuteContext } from '../src/types/tool';
import { stdioPipe } from './helpers/mcp-pipe-transport';

const ENDPOINT = 'http://deuz-mcp.test/mcp';
const USER: MemoryScope = { userId: 'u1' };
const closers: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close().catch(() => {});
});

interface Remembered {
  written: { id: string; revision: number }[];
  replayed: boolean;
}

function memoryServer(): { server: DeuzMcpServer; store: VersionedMemoryStore } {
  const store = createInMemoryVersionedMemoryStore();
  const session = createMemorySession({ store, scope: USER });
  const server = createMcpServer({
    name: 'memory',
    agentTools: createVersionedMemoryTools(session, { include: ['remember'] }),
  });
  closers.push(server);
  return { server, store };
}

const fetchInto = (server: DeuzMcpServer) => (input: string | URL, init?: RequestInit) =>
  server.fetch(new Request(input, init));

async function modernHttp(server: DeuzMcpServer): Promise<V2Client> {
  const client = new V2Client(
    { name: 'v2', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: fetchInto(server) }),
  );
  closers.push(client);
  return client;
}

async function legacyHttp(server: DeuzMcpServer): Promise<V1Client> {
  const client = new V1Client({ name: 'v1', version: '1.0.0' });
  await client.connect(new V1HttpTransport(new URL(ENDPOINT), { fetch: fetchInto(server) }));
  closers.push(client);
  return client;
}

async function legacyStdio(server: DeuzMcpServer): Promise<V1Client> {
  const pipe = stdioPipe();
  closers.push(await serveMcpStdio(server, { stdin: pipe.stdin, stdout: pipe.stdout }));
  const client = new V1Client({ name: 'v1', version: '1.0.0' });
  await client.connect(pipe.transport() as never);
  closers.push(client);
  return client;
}

type CallingClient = Pick<V1Client, 'callTool'> | Pick<V2Client, 'callTool'>;

async function remember(client: CallingClient, text: string): Promise<Remembered> {
  const result = (await client.callTool({ name: 'memory_remember', arguments: { text } })) as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent?: unknown;
  };
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return result.structuredContent as Remembered;
}

describe('served toolCallId: one id per call, across connections', () => {
  it.each([
    ['2026-07-28 HTTP', modernHttp],
    ['2025-era stateless HTTP', legacyHttp],
    ['2025-era stdio', legacyStdio],
  ] as const)(
    'over %s, a second connection with the same JSON-RPC ids writes its own record',
    async (_transport, open) => {
      const { server, store } = memoryServer();
      const first = await open(server);
      const second = await open(server);

      const a = await remember(first, 'prefers window seats');
      // The same request ids on a fresh connection: neither a conflict nor a false replay.
      const b = await remember(second, 'is allergic to peanuts');
      const c = await remember(second, 'prefers window seats');
      expect([a.replayed, b.replayed, c.replayed]).toEqual([false, false, false]);
      const ids = [a, b, c].map((r) => r.written[0]!.id);
      expect(new Set(ids).size).toBe(3);
      const texts = await Promise.all(ids.map(async (id) => (await store.get(USER, id))?.text));
      expect(texts).toEqual([
        'prefers window seats',
        'is allergic to peanuts',
        'prefers window seats',
      ]);
    },
  );

  it('within one stdio session, a resent request id is the same call and replays', async () => {
    const { server, store } = memoryServer();
    const pipe = stdioPipe();
    closers.push(await serveMcpStdio(server, { stdin: pipe.stdin, stdout: pipe.stdout }));
    const transport = pipe.transport();
    closers.push(transport);
    const answers = new Map<unknown, (message: Record<string, unknown>) => void>();
    transport.onmessage = (message) => answers.get(message.id)?.(message);
    await transport.start();
    const request = (id: number, method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        answers.set(id, resolve);
        void transport.send({ jsonrpc: '2.0', id, method, params });
      });

    await request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw', version: '1.0.0' },
    });
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = { name: 'memory_remember', arguments: { text: 'prefers aisle seats' } };
    const sent = (await request(2, 'tools/call', call)).result as { structuredContent: Remembered };
    const resent = (await request(2, 'tools/call', call)).result as {
      structuredContent: Remembered;
    };

    expect(sent.structuredContent.replayed).toBe(false);
    expect(resent.structuredContent).toEqual({ ...sent.structuredContent, replayed: true });
    const id = sent.structuredContent.written[0]!.id;
    expect(await store.history(USER, id)).toHaveLength(1);
  });

  it('the id names its serving unit and the JSON-RPC id, and stays an mcp- id', async () => {
    const seen: string[] = [];
    let n = 0;
    const server = createMcpServer({
      name: 'ids',
      generateId: () => `unit${++n}`,
      tools: {
        probe: {
          parameters: { type: 'object' },
          execute: (_args, ctx: ToolExecuteContext) => {
            seen.push(ctx.toolCallId);
            return 'ok';
          },
        },
      },
    });
    closers.push(server);
    const client = await legacyStdio(server);
    await client.callTool({ name: 'probe', arguments: {} });
    await client.callTool({ name: 'probe', arguments: {} });
    expect(seen).toHaveLength(2);
    const [first, second] = seen.map((id) => /^mcp-(unit\d+)-(\d+)$/.exec(id));
    expect(first?.[1]).toBeDefined();
    // One stdio connection: one unit, two request ids.
    expect(second?.[1]).toBe(first?.[1]);
    expect(second?.[2]).not.toBe(first?.[2]);
  });
});
