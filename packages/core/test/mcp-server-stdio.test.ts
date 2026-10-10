/**
 * `@deuz-sdk/core/mcp/server/stdio` (2.3) — the Node stdio face of a Deuz MCP
 * server: `serveMcpStdio` serves the SAME `createMcpServer` handle `fetch`
 * serves over HTTP, on the v2 SDK's `serveStdio` entry.
 *
 * The streams are in-process (`helpers/mcp-pipe-transport.ts`), so both SDK
 * lines' clients drive the real framing with no child process. What stdio adds
 * over HTTP, and what this file pins: a connection is pinned to ONE era by its
 * opening exchange, and a 2025-era session is STATEFUL — so, unlike stateless
 * HTTP, a `needsApproval` tool can ask a 2025-11-25 client's user (the SDK sends
 * a real `elicitation/create` and re-enters the handler with the answer).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client as V2Client } from '@modelcontextprotocol/client';
import { serveMcpStdio, type McpStdioServerHandle } from '../src/node/mcp-server';
import { createMcpServer, type McpServerOptions } from '../src/mcp/server';
import { InvalidRequestError } from '../src/errors';
import { stdioPipe } from './helpers/mcp-pipe-transport';

const handles: McpStdioServerHandle[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
});

function tools(): NonNullable<McpServerOptions['tools']> {
  return {
    echo: {
      description: 'Echo a value back.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute: (args) => `echo:${(args as { value: string }).value}`,
    },
    add: {
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: (args) => {
        const { a, b } = args as { a: number; b: number };
        return { sum: a + b };
      },
    },
  };
}

/** Serve on a fresh pipe; the caller connects whichever client it needs. */
async function servePipe(
  server: Parameters<typeof serveMcpStdio>[0],
  legacy?: 'serve' | 'reject',
): Promise<ReturnType<typeof stdioPipe>> {
  const pipe = stdioPipe();
  const handle = await serveMcpStdio(server, {
    stdin: pipe.stdin,
    stdout: pipe.stdout,
    ...(legacy ? { legacy } : {}),
  });
  handles.push(handle);
  return pipe;
}

describe('serveMcpStdio — both eras on one stdio entry', () => {
  it('a 2025-11-25 client (v1 SDK) lists and calls the served tools', async () => {
    const pipe = await servePipe(
      createMcpServer({ name: 'stdio-tools', version: '4.5.6', tools: tools() }),
    );
    const client = new V1Client({ name: 'v1', version: '1.0.0' });
    clients.push(client);
    await client.connect(pipe.transport() as never);

    expect(client.getServerVersion()).toMatchObject({ name: 'stdio-tools', version: '4.5.6' });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo', 'add']);
    const echoed = await client.callTool({ name: 'echo', arguments: { value: 'pipe' } });
    expect(echoed.content).toEqual([{ type: 'text', text: 'echo:pipe' }]);
    const added = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(added.structuredContent).toEqual({ sum: 5 });
  });

  it('a negotiating v2 client opens with server/discover and runs on 2026-07-28', async () => {
    const pipe = await servePipe({ name: 'stdio-tools', tools: tools() });
    const client = new V2Client(
      { name: 'v2', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(client);
    await client.connect(pipe.transport() as never);

    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const result = await client.callTool({ name: 'echo', arguments: { value: 'modern' } });
    expect(result.content).toEqual([{ type: 'text', text: 'echo:modern' }]);
    expect(
      pipe.written.some((m) => (m.result as { supportedVersions?: unknown })?.supportedVersions),
    ).toBe(true);
  });

  it("legacy: 'reject' refuses a 2025-era opening", async () => {
    const pipe = await servePipe({ name: 'modern-only', tools: tools() }, 'reject');
    const client = new V1Client({ name: 'v1', version: '1.0.0' });
    clients.push(client);

    await expect(client.connect(pipe.transport() as never)).rejects.toThrow();
  });
});

describe('serveMcpStdio — what a stateful 2025 session makes possible', () => {
  it('a needsApproval tool asks a 2025-11-25 client with a real elicitation/create', async () => {
    const execute = vi.fn(() => 'shipped');
    const seen: unknown[] = [];
    const pipe = await servePipe({
      name: 't',
      runtimeContext: (request) => ({ transport: request.transport, era: request.era }),
      tools: {
        ship: {
          parameters: { type: 'object', properties: { env: { type: 'string' } } },
          needsApproval: true,
          execute: (_args, ctx) => {
            seen.push(ctx.runtimeContext);
            return execute();
          },
        },
      },
    });
    const asked: string[] = [];
    const client = new V1Client(
      { name: 'v1', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(String(request.params.message));
      return asked.length === 1
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' };
    });
    clients.push(client);
    await client.connect(pipe.transport() as never);

    const approved = await client.callTool({ name: 'ship', arguments: { env: 'prod' } });
    expect(approved.content).toEqual([{ type: 'text', text: 'shipped' }]);
    const declined = await client.callTool({ name: 'ship', arguments: { env: 'prod' } });
    expect(declined.isError).toBe(true);
    expect(JSON.stringify(declined.content)).toContain('declined by the user');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('"env":"prod"');
    expect(seen).toEqual([{ transport: 'stdio', era: 'legacy' }]);
  });
});

describe('serveMcpStdio — startup', () => {
  it('fails before serving when a tool cannot be prepared', async () => {
    const pipe = stdioPipe();
    const broken = createMcpServer({
      name: 't',
      agentTools: {
        scoped: {
          parameters: { type: 'object' },
          contextSchema: { type: 'object' },
          validateContext: () => {
            throw new Error('tenant context is required');
          },
          execute: () => 'never',
        },
      },
    });

    await expect(serveMcpStdio(broken, { stdin: pipe.stdin, stdout: pipe.stdout })).rejects.toThrow(
      'tenant context is required',
    );
    // Nothing was written: a half-started server never answers anybody.
    expect(pipe.stdout.readableLength).toBe(0);
  });

  it('rejects a handle createMcpServer did not build', async () => {
    const fake = {
      fetch: async () => new Response(),
      ready: async () => {},
      close: async () => {},
    };
    await expect(serveMcpStdio(fake as never)).rejects.toThrow(InvalidRequestError);
  });

  it('close() stops serving: a later request is never answered', async () => {
    const pipe = stdioPipe();
    const handle = await serveMcpStdio(
      { name: 't', tools: tools() },
      { stdin: pipe.stdin, stdout: pipe.stdout },
    );
    const client = new V1Client({ name: 'v1', version: '1.0.0' });
    clients.push(client);
    await client.connect(pipe.transport() as never);
    expect((await client.callTool({ name: 'echo', arguments: { value: 'a' } })).content).toEqual([
      { type: 'text', text: 'echo:a' },
    ]);

    await handle.close();
    await expect(
      client.callTool({ name: 'echo', arguments: { value: 'b' } }, undefined, { timeout: 200 }),
    ).rejects.toThrow(/time/i);
  });
});
