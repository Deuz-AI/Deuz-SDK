import { InvalidRequestError } from '../errors';
import {
  createManagedConnection,
  createRootsBox,
  wrapMcpClient,
  attachRoots,
  type RawMcpClient,
} from './shared';
import { registerElicitation, registerSamplingAndRoots, registerToolListChanged } from './index';
import type {
  McpClientHooks,
  McpElicitationHandler,
  McpLifecycleOptions,
  McpRootsBox,
  McpRootsClient,
  McpRootsOption,
  McpSamplingOptions,
} from './shared';

export type {
  McpClient,
  McpConnectionStatus,
  McpLifecycleOptions,
  McpReconnectPolicy,
  McpRootsClient,
  McpRootsOption,
  McpSamplingOptions,
  McpStatusInfo,
} from './shared';

/**
 * Node-only stdio MCP transport (spawns a child process, e.g. `npx -y
 * firecrawl-mcp`). Exempt from the edge-safety lint; kept in its own subpath so
 * the edge core never pulls in node builtins. `@modelcontextprotocol/sdk` is an
 * optional peer, imported lazily.
 */
export interface McpStdioOptions extends McpLifecycleOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  name?: string;
  version?: string;
  /** See `McpClientOptions.onElicitationRequest` — same semantics over stdio. */
  onElicitationRequest?: McpElicitationHandler;
  /** See `McpClientOptions.sampling` — same semantics over stdio. */
  sampling?: McpSamplingOptions;
  /** See `McpClientOptions.roots` — same semantics over stdio (file:// only). */
  roots?: McpRootsOption;
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

/** Read a roots box through its function form — see {@link makeStdioClient}. */
function readRootsBox(box: McpRootsBox): string[] | Promise<string[]> {
  return typeof box.value === 'function' ? box.value() : box.value;
}

/**
 * Build ONE fresh, unconnected `Client` with every handler already registered —
 * the stdio twin of `mcp/index.ts`'s factory, and for the same reason: a
 * reconnect calls it again, so every handler comes back with the new session.
 */
async function makeStdioClient(
  options: McpStdioOptions,
  hooks: McpClientHooks,
  rootsBox: McpRootsBox | undefined,
): Promise<RawMcpClient> {
  const { Client } = await loadSdk();
  const client = new Client(
    { name: options.name ?? 'deuz', version: options.version ?? '0.0.0' },
    // `!== undefined` throughout, as in `mcp/index.ts`: `roots: []` is a value.
    {
      capabilities: {
        ...(options.onElicitationRequest !== undefined
          ? { elicitation: { form: {}, url: {} } }
          : {}),
        ...(options.sampling !== undefined ? { sampling: {} } : {}),
        ...(options.roots !== undefined ? { roots: { listChanged: true } } : {}),
      },
    },
  );
  if (options.onElicitationRequest !== undefined) {
    await registerElicitation(client, options.onElicitationRequest);
  }
  await registerSamplingAndRoots(client, {
    ...(options.sampling !== undefined ? { sampling: options.sampling } : {}),
    // One box for the life of the client so `setRoots()` survives a reconnect.
    ...(rootsBox !== undefined ? { roots: () => readRootsBox(rootsBox) } : {}),
  });
  await registerToolListChanged(client, hooks.toolListChanged);
  return client;
}

export async function createStdioMcpClient(options: McpStdioOptions): Promise<McpRootsClient> {
  const rootsBox = options.roots !== undefined ? createRootsBox(options.roots) : undefined;
  const managed = await createManagedConnection({
    makeClient: (hooks) => makeStdioClient(options, hooks, rootsBox),
    // A reconnect RESPAWNS the child process: the old one died with the pipe.
    makeTransport: async () => {
      const { StdioClientTransport } = await loadSdk();
      return new StdioClientTransport({
        command: options.command,
        args: options.args ?? [],
        ...(options.env ? { env: options.env } : {}),
      });
    },
    lifecycle: options,
  });
  return attachRoots(wrapMcpClient(managed.raw(), managed), managed.raw(), rootsBox, managed);
}
