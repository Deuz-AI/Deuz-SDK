import { NotImplementedError } from '../errors';

/**
 * Node-only stdio MCP transport. This module is exempt from the edge-safety
 * lint (it may use node:child_process in Faz 2). Kept in its own subpath export
 * so the edge-safe core never pulls in node builtins.
 */
export interface McpStdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function createStdioMcpClient(_options: McpStdioOptions): never {
  throw new NotImplementedError('mcp stdio client');
}
