import { InvalidRequestError } from '../errors';
import { wrapMcpClient, type McpClient, type RawMcpClient } from './shared';

export type { McpClient } from './shared';

/**
 * MCP client over HTTP — edge-safe (fetch-only; no node builtins). `http` uses
 * the current Streamable HTTP transport; `sse` is the legacy fallback some
 * servers (e.g. Firecrawl `/v2/sse`) still expose. The Node-only stdio transport
 * lives in `./mcp/stdio`. `@modelcontextprotocol/sdk` is an optional peer,
 * imported lazily so the edge bundle never pulls it in unless used.
 */
export interface McpHttpTransport {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpClientOptions {
  transport: McpHttpTransport;
  name?: string;
  version?: string;
}

async function loadSdk(): Promise<{ Client: new (info: object, opts: object) => RawMcpClient }> {
  try {
    const spec: string = '@modelcontextprotocol/sdk/client/index.js';
    const mod = await import(spec);
    return mod as { Client: new (info: object, opts: object) => RawMcpClient };
  } catch (err) {
    throw new InvalidRequestError({
      message:
        'MCP support needs the optional peer "@modelcontextprotocol/sdk". Install it: npm i @modelcontextprotocol/sdk',
      cause: err,
    });
  }
}

async function makeHttpTransport(t: McpHttpTransport): Promise<unknown> {
  const opts = t.headers ? { requestInit: { headers: t.headers } } : undefined;
  if (t.type === 'sse') {
    const spec: string = '@modelcontextprotocol/sdk/client/sse.js';
    const { SSEClientTransport } = await import(spec);
    return new SSEClientTransport(new URL(t.url), opts);
  }
  const spec: string = '@modelcontextprotocol/sdk/client/streamableHttp.js';
  const { StreamableHTTPClientTransport } = await import(spec);
  return new StreamableHTTPClientTransport(new URL(t.url), opts);
}

export async function createMcpClient(options: McpClientOptions): Promise<McpClient> {
  const { Client } = await loadSdk();
  const transport = await makeHttpTransport(options.transport);
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return wrapMcpClient(client);
}
