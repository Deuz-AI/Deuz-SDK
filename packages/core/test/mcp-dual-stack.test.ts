/**
 * The dual-stack MCP client (2.3) — WHICH SDK line drives a client.
 *
 * MCP 2026-07-28 ships only in the v2 TypeScript SDK (`@modelcontextprotocol/client`,
 * Zod 4, node >= 20); the v1 package (`@modelcontextprotocol/sdk`) stays on
 * 2025-11-25. Both sit behind the one `RawMcpClient` seam, and `sdk` picks:
 *
 * - `'auto'` (the default) prefers v2 when its package can be imported, else v1;
 * - `'v1'` / `'v2'` pin a line and fail loudly when it is not installed.
 *
 * Both peers are devDependencies here, so "not installed" is simulated by
 * mocking the computed dynamic imports and re-importing the module under test.
 * Every server and client is torn down in `afterEach`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMcpClient, type McpRootsClient } from '../src/mcp/index';
import { InvalidRequestError } from '../src/errors';
import { startTestMcpServer, type TestMcpServerHandle } from './helpers/mcp-http-server';

const servers: TestMcpServerHandle[] = [];
const clients: McpRootsClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

async function startServer(): Promise<TestMcpServerHandle> {
  const server = await startTestMcpServer();
  servers.push(server);
  return server;
}

describe('createMcpClient — SDK line selection', () => {
  it("sdk: 'v2' drives the v2 SDK; against a 2025-11-25 server it negotiates the legacy era", async () => {
    const server = await startServer();
    const client = await createMcpClient({
      transport: { type: 'http', url: server.url },
      sdk: 'v2',
    });
    clients.push(client);

    expect(client.sdk?.()).toBe('v2');
    // The v1 test server only speaks 2025-11-25: the `server/discover` probe is
    // refused, so the client falls back to the plain `initialize` handshake.
    expect(client.protocolVersion?.()).toBe('2025-11-25');
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add', 'boom']);
    expect(await client.callTool('add', { a: 2, b: 2 })).toEqual({ sum: 4 });
  });

  it("sdk: 'v1' keeps the 1.x SDK and reports the version it negotiated", async () => {
    const server = await startServer();
    const client = await createMcpClient({
      transport: { type: 'http', url: server.url },
      sdk: 'v1',
    });
    clients.push(client);

    expect(client.sdk?.()).toBe('v1');
    expect(client.protocolVersion?.()).toBe('2025-11-25');
    expect(await client.callTool('echo', { value: 'v1' })).toBe('echo:v1');
  });

  it('the default (auto) prefers v2 when @modelcontextprotocol/client is importable', async () => {
    const server = await startServer();
    const client = await createMcpClient({ transport: { type: 'http', url: server.url } });
    clients.push(client);
    expect(client.sdk?.()).toBe('v2');
  });

  it('rejects an unknown sdk value instead of guessing', async () => {
    await expect(
      createMcpClient({
        transport: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        sdk: 'v3' as never,
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('refuses to pin a 2026-07-28 revision on the v1 line, which cannot speak it', async () => {
    const promise = createMcpClient({
      transport: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      sdk: 'v1',
      versionNegotiation: { pin: '2026-07-28' },
    });
    await expect(promise).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(promise).rejects.toThrow(/@modelcontextprotocol\/client/);
  });
});

describe('createMcpClient — SDK line selection when a peer is missing', () => {
  const notInstalled = (name: string) => (): never => {
    throw new Error(`Cannot find module '${name}'`);
  };

  afterEach(() => {
    vi.doUnmock('@modelcontextprotocol/client');
    vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/client/streamableHttp.js');
    vi.resetModules();
  });

  it('auto falls back to v1 when the v2 package cannot be imported', async () => {
    vi.doMock('@modelcontextprotocol/client', notInstalled('@modelcontextprotocol/client'));
    vi.resetModules();
    const { createMcpClient: fresh } = await import('../src/mcp/index');
    const server = await startServer();

    const client = await fresh({ transport: { type: 'http', url: server.url } });
    clients.push(client);
    expect(client.sdk?.()).toBe('v1');
    expect(await client.callTool('echo', { value: 'fallback' })).toBe('echo:fallback');
  });

  it("sdk: 'v2' without the v2 package raises the actionable install error", async () => {
    vi.doMock('@modelcontextprotocol/client', notInstalled('@modelcontextprotocol/client'));
    vi.resetModules();
    const { createMcpClient: fresh } = await import('../src/mcp/index');

    const promise = fresh({
      transport: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      sdk: 'v2',
    });
    await expect(promise).rejects.toThrow(/npm i @modelcontextprotocol\/client/);
    await expect(promise).rejects.toMatchObject({ name: 'InvalidRequestError' });
  });

  it('with neither SDK installed the error names both packages', async () => {
    vi.doMock('@modelcontextprotocol/client', notInstalled('@modelcontextprotocol/client'));
    vi.doMock(
      '@modelcontextprotocol/sdk/client/index.js',
      notInstalled('@modelcontextprotocol/sdk'),
    );
    vi.doMock(
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
      notInstalled('@modelcontextprotocol/sdk'),
    );
    vi.resetModules();
    const { createMcpClient: fresh } = await import('../src/mcp/index');

    const promise = fresh({ transport: { type: 'http', url: 'http://127.0.0.1:1/mcp' } });
    await expect(promise).rejects.toThrow(/npm i @modelcontextprotocol\/client/);
    await expect(promise).rejects.toThrow(/npm i @modelcontextprotocol\/sdk/);
  });
});
