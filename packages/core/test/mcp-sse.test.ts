/**
 * `McpHttpTransport.type: 'sse'` (the legacy HTTP+SSE transport) on both SDK
 * lines (2.3). Some hosted servers still expose only this transport, and the
 * dual-stack client's default (`sdk: 'auto'`) now prefers the v2 SDK — so the
 * fallback has to keep working there too, negotiation included. Real sockets,
 * real SSE framing (`helpers/mcp-sse-server.ts`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMcpClient, type McpRootsClient, type McpSdkLine } from '../src/mcp/index';
import { startSseTestServer, type SseTestServerHandle } from './helpers/mcp-sse-server';

const servers: SseTestServerHandle[] = [];
const clients: McpRootsClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

describe.each(['v1', 'v2'] as McpSdkLine[])("McpHttpTransport type: 'sse' [%s SDK]", (sdk) => {
  it('connects, lists and calls tools over the legacy transport', async () => {
    const server = await startSseTestServer();
    servers.push(server);
    const client = await createMcpClient({ sdk, transport: { type: 'sse', url: server.url } });
    clients.push(client);

    expect(client.sdk?.()).toBe(sdk);
    expect(client.protocolVersion?.()).toBe('2025-11-25');
    expect(client.serverInfo?.()).toEqual({ name: 'sse-test-server', version: '1.0.0' });
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add']);
    expect(await client.callTool('echo', { value: 'sse' })).toBe('echo:sse');
    expect(await client.callTool('add', { a: 1, b: 2 })).toEqual({ sum: 3 });
  });
});
