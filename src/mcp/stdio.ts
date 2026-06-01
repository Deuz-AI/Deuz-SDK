import { InvalidRequestError } from '../errors';
import { wrapMcpClient, type McpClient, type RawMcpClient } from './shared';

export type { McpClient } from './shared';

/**
 * Node-only stdio MCP transport (spawns a child process, e.g. `npx -y
 * firecrawl-mcp`). Exempt from the edge-safety lint; kept in its own subpath so
 * the edge core never pulls in node builtins. `@modelcontextprotocol/sdk` is an
 * optional peer, imported lazily.
 */
export interface McpStdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  name?: string;
  version?: string;
}

async function loadSdk(): Promise<{
  Client: new (info: object, opts: object) => RawMcpClient;
  StdioClientTransport: new (opts: object) => unknown;
}> {
  try {
    const clientSpec: string = '@modelcontextprotocol/sdk/client/index.js';
    const stdioSpec: string = '@modelcontextprotocol/sdk/client/stdio.js';
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import(clientSpec),
      import(stdioSpec),
    ]);
    return { Client, StdioClientTransport };
  } catch (err) {
    throw new InvalidRequestError({
      message:
        'MCP stdio support needs the optional peer "@modelcontextprotocol/sdk". Install it: npm i @modelcontextprotocol/sdk',
      cause: err,
    });
  }
}

export async function createStdioMcpClient(options: McpStdioOptions): Promise<McpClient> {
  const { Client, StdioClientTransport } = await loadSdk();
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args ?? [],
    ...(options.env ? { env: options.env } : {}),
  });
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return wrapMcpClient(client);
}
