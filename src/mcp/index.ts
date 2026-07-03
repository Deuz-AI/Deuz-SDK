import { InvalidRequestError } from '../errors';
import {
  wrapMcpClient,
  buildElicitationHandler,
  type McpClient,
  type RawMcpClient,
  type McpElicitationHandler,
} from './shared';

export type {
  McpClient,
  McpElicitationHandler,
  McpElicitationRequest,
  McpElicitationResult,
  McpResource,
  McpResourceContent,
  McpPrompt,
  McpPromptMessage,
  McpGetPromptResult,
} from './shared';

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
  /**
   * Handle server-initiated `elicitation/create` requests (MCP 2025-11-25).
   * Providing it declares the elicitation capability (form + url modes).
   * URL mode: `{ action: 'accept' }` = the user consented to open the URL —
   * NEVER auto-open or prefetch it; completion happens out-of-band.
   */
  onElicitationRequest?: McpElicitationHandler;
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

/** Register the elicitation handler (capability is declared in the constructor; must run BEFORE connect). */
export async function registerElicitation(
  client: RawMcpClient,
  onElicitationRequest: McpElicitationHandler,
): Promise<void> {
  if (!client.setRequestHandler) {
    throw new InvalidRequestError({
      message:
        'Elicitation needs client.setRequestHandler() — upgrade the optional peer to "@modelcontextprotocol/sdk" ^1.29.0.',
    });
  }
  const spec: string = '@modelcontextprotocol/sdk/types.js';
  const { ElicitRequestSchema } = (await import(spec)) as { ElicitRequestSchema: unknown };
  client.setRequestHandler(ElicitRequestSchema, buildElicitationHandler(onElicitationRequest));
}

export async function createMcpClient(options: McpClientOptions): Promise<McpClient> {
  const { Client } = await loadSdk();
  const transport = await makeHttpTransport(options.transport);
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    // Declaring the capability without a handler would lie to servers — gate on the callback.
    { capabilities: options.onElicitationRequest ? { elicitation: { form: {}, url: {} } } : {} },
  );
  if (options.onElicitationRequest) await registerElicitation(client, options.onElicitationRequest);
  await client.connect(transport);
  return wrapMcpClient(client);
}
