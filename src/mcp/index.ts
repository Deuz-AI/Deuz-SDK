import { NotImplementedError } from '../errors';

/**
 * MCP client — transport-agnostic, edge-safe surface (HTTP / SSE). The
 * Node-only stdio transport lives in the separate `./mcp/stdio` export so this
 * entry stays free of node: builtins. Real client lands in Faz 2.
 */
export interface McpClientOptions {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export function createMcpClient(_options: McpClientOptions): never {
  throw new NotImplementedError('mcp client');
}
