import type { ToolSet, Tool } from '../types/tool';
import type { JSONSchema } from '../types/schema';

/** The minimal MCP client surface we depend on (the SDK's `Client`). */
export interface RawMcpClient {
  connect(transport: unknown): Promise<void>;
  callTool(req: { name: string; arguments: unknown }): Promise<McpCallResult>;
  listTools(): Promise<{ tools: McpToolDef[] }>;
  close(): Promise<void>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

/** Flatten an MCP tool result to a value our loop can feed back to the model. */
export function extractContent(result: McpCallResult): unknown {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  // Self-heal: an MCP error becomes a thrown error → the loop records an is_error
  // tool_result so the model can recover.
  if (result.isError) throw new Error(text || 'MCP tool returned an error.');
  return text !== '' ? text : blocks;
}

/**
 * Map MCP tool definitions into our `ToolSet`. Each tool's `execute` calls the
 * MCP server via `callTool`; the MCP `inputSchema` IS a JSON Schema, so it goes
 * straight onto `Tool.parameters`. Optional `namespace` prefixes names when
 * combining multiple servers.
 */
export function mcpToolsToToolSet(
  client: RawMcpClient,
  tools: McpToolDef[],
  namespace?: string,
): ToolSet {
  const set: ToolSet = {};
  for (const def of tools) {
    const key = namespace ? `${namespace}_${def.name}` : def.name;
    const tool: Tool = {
      ...(def.description ? { description: def.description } : {}),
      parameters: def.inputSchema ?? { type: 'object', properties: {} },
      execute: async (args) =>
        extractContent(await client.callTool({ name: def.name, arguments: args })),
    };
    set[key] = tool;
  }
  return set;
}

/** The transport-agnostic client we return to callers. */
export interface McpClient {
  /** MCP tools mapped to a `ToolSet` ready for `generateText({ tools })`. */
  listTools(namespace?: string): Promise<ToolSet>;
  /** Call a tool directly (rarely needed; the loop uses `execute`). */
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** Wrap a connected raw SDK client in our `McpClient`. */
export function wrapMcpClient(raw: RawMcpClient): McpClient {
  return {
    async listTools(namespace) {
      const { tools } = await raw.listTools();
      return mcpToolsToToolSet(raw, tools, namespace);
    },
    callTool: async (name, args) => extractContent(await raw.callTool({ name, arguments: args })),
    close: () => raw.close(),
  };
}
