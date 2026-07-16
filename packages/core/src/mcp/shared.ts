import type { ToolSet, Tool } from '../types/tool';
import type { JSONSchema } from '../types/schema';
import { InvalidRequestError } from '../errors';

/**
 * The minimal MCP client surface we depend on (the SDK's `Client`). The
 * resource/prompt methods are OPTIONAL: they exist from SDK ~1.x but older
 * installations may lack them — we probe at call time and raise an actionable
 * error instead of requiring them structurally (which would also break test
 * fakes and downstream implementers).
 */
export interface RawMcpClient {
  connect(transport: unknown): Promise<void>;
  callTool(req: { name: string; arguments: unknown }): Promise<McpCallResult>;
  listTools(): Promise<{ tools: McpToolDef[] }>;
  close(): Promise<void>;
  /** SDK request-handler registration (used for elicitation/create). */
  setRequestHandler?(
    schema: unknown,
    handler: (req: { params: Record<string, unknown> }) => unknown,
  ): void;
  listResources?(params?: {
    cursor?: string;
  }): Promise<{ resources: McpResource[]; nextCursor?: string }>;
  readResource?(params: { uri: string }): Promise<{ contents: McpResourceContent[] }>;
  listPrompts?(params?: {
    cursor?: string;
  }): Promise<{ prompts: McpPrompt[]; nextCursor?: string }>;
  getPrompt?(params: {
    name: string;
    arguments?: Record<string, string>;
  }): Promise<McpGetPromptResult>;
}

// Structural mirrors of the SDK result shapes — the SDK is an optional peer,
// so its types must never leak into our public .d.ts.

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** One entry of a readResource result: text (`text`) or binary (`blob`, base64). */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  [key: string]: unknown;
}

/** Prompt messages come back in MCP's own shape (role + content block) — not our `Message`. */
export interface McpPromptMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
  [key: string]: unknown;
}

// --- Elicitation (MCP 2025-11-25: form + url modes) ---

/** In-band structured data collection; the client renders a form. */
export interface McpFormElicitationRequest {
  mode: 'form';
  message: string;
  /** Restricted JSON Schema: flat object, primitive properties only. */
  requestedSchema: JSONSchema;
}

/**
 * Out-of-band interaction via URL (auth/payment/sensitive data). Returning
 * `{ action: 'accept' }` means the USER CONSENTED to open the URL — the
 * interaction itself completes outside MCP. NEVER auto-open or prefetch the
 * URL; show it to the user first (spec requirement).
 */
export interface McpUrlElicitationRequest {
  mode: 'url';
  message: string;
  url: string;
  elicitationId: string;
}

export type McpElicitationRequest = McpFormElicitationRequest | McpUrlElicitationRequest;

export interface McpElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  /** Form mode, accept only: the submitted data matching requestedSchema. */
  content?: Record<string, unknown>;
}

export type McpElicitationHandler = (
  req: McpElicitationRequest,
) => McpElicitationResult | Promise<McpElicitationResult>;

/**
 * Adapt a user callback to the SDK's request-handler shape (shared by the
 * http and stdio transports). Requests without a `mode` are form mode
 * (spec back-compat).
 */
export function buildElicitationHandler(
  cb: McpElicitationHandler,
): (req: { params: Record<string, unknown> }) => Promise<McpElicitationResult> {
  return async (req) => {
    const p = req.params;
    const request: McpElicitationRequest =
      p.mode === 'url'
        ? {
            mode: 'url',
            message: String(p.message ?? ''),
            url: String(p.url ?? ''),
            elicitationId: String(p.elicitationId ?? ''),
          }
        : {
            mode: 'form',
            message: String(p.message ?? ''),
            requestedSchema: (p.requestedSchema ?? { type: 'object' }) as JSONSchema,
          };
    return cb(request);
  };
}

/** Safety cap for cursor auto-pagination (bounds hostile/looping servers). */
export const MAX_MCP_PAGES = 100;

function requireMethod<T>(method: T | undefined, name: string): T {
  if (!method) {
    throw new InvalidRequestError({
      message: `The connected MCP SDK lacks client.${name}() — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.`,
    });
  }
  return method;
}

async function paginate<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MCP_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
  return all; // cap reached — endless cursor
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  /** MCP output schema — carried onto `Tool.outputSchema` as metadata (the SDK validates server-side). */
  outputSchema?: JSONSchema;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  /** Structured tool output (MCP 2025-11-25); preferred over the text blocks when present. */
  structuredContent?: Record<string, unknown>;
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
  // tool_result so the model can recover. isError wins over structuredContent.
  if (result.isError) {
    const structured = result.structuredContent && JSON.stringify(result.structuredContent);
    throw new Error(text || structured || 'MCP tool returned an error.');
  }
  // Per spec the text blocks are a redundant serialization — return the
  // structured value verbatim when the server provides one.
  if (result.structuredContent !== undefined) return result.structuredContent;
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
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
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
  /** All resources across pages (auto-paginated, capped at MAX_MCP_PAGES). */
  listResources(): Promise<McpResource[]>;
  /** Read one resource; returns its contents array (text and/or base64 blob entries). */
  readResource(uri: string): Promise<McpResourceContent[]>;
  /** All prompts across pages (auto-paginated, capped at MAX_MCP_PAGES). */
  listPrompts(): Promise<McpPrompt[]>;
  /** Render a prompt with arguments; returns MCP's own message shape verbatim. */
  getPrompt(name: string, args?: Record<string, string>): Promise<McpGetPromptResult>;
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
    async listResources() {
      const fn = requireMethod(raw.listResources, 'listResources').bind(raw);
      return paginate(async (cursor) => {
        const page = await fn(cursor ? { cursor } : undefined);
        return {
          items: page.resources,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
    async readResource(uri) {
      const fn = requireMethod(raw.readResource, 'readResource').bind(raw);
      const { contents } = await fn({ uri });
      return contents;
    },
    async listPrompts() {
      const fn = requireMethod(raw.listPrompts, 'listPrompts').bind(raw);
      return paginate(async (cursor) => {
        const page = await fn(cursor ? { cursor } : undefined);
        return { items: page.prompts, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      });
    },
    async getPrompt(name, args) {
      const fn = requireMethod(raw.getPrompt, 'getPrompt').bind(raw);
      return fn({ name, ...(args ? { arguments: args } : {}) });
    },
    close: () => raw.close(),
  };
}
