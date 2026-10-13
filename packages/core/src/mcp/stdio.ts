import { InvalidRequestError } from '../errors';
import {
  createManagedConnection,
  createRootsBox,
  wrapMcpClient,
  attachRoots,
  type RawMcpClient,
} from './shared';
import { registerElicitation, registerSamplingAndRoots, registerToolListChanged } from './index';
import {
  NO_MCP_SDK_MESSAGE,
  NO_V2_SDK_MESSAGE,
  assertLineSupports,
  recordV1NegotiatedVersion,
  selectMcpSdk,
} from './sdk-line';
import type {
  McpClientHooks,
  McpElicitationHandler,
  McpLifecycleOptions,
  McpRootsBox,
  McpRootsClient,
  McpRootsOption,
  McpSamplingOptions,
  McpSdkSelection,
  McpVersionNegotiation,
} from './shared';

export type {
  McpClient,
  McpConnectionStatus,
  McpLifecycleOptions,
  McpReconnectPolicy,
  McpRootsClient,
  McpRootsOption,
  McpSamplingOptions,
  McpSdkLine,
  McpSdkSelection,
  McpStatusInfo,
  McpVersionNegotiation,
} from './shared';

/**
 * Node-only stdio MCP transport (spawns a child process, e.g. `npx -y
 * firecrawl-mcp`). Exempt from the edge-safety lint; kept in its own subpath so
 * the edge core never pulls in node builtins. The MCP SDKs are optional peers,
 * imported lazily.
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
  /** See `McpClientOptions.sdk` (2.3) — same selection over stdio. */
  sdk?: McpSdkSelection;
  /**
   * See `McpClientOptions.versionNegotiation` (2.3). Over stdio the v2 SDK's
   * `'auto'` probe runs on a short-lived SIBLING process spawned from the same
   * command, so the server starts twice per connect; pass `'legacy'` for a
   * server that must not (one with side effects at startup).
   */
  versionNegotiation?: McpVersionNegotiation;
}

/** The v1 line. `viaAuto`: picked because v2 is missing too — name both packages. */
async function loadSdk(viaAuto = false): Promise<{
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
      message: viaAuto
        ? NO_MCP_SDK_MESSAGE
        : 'MCP stdio support needs the optional peer "@modelcontextprotocol/sdk". Install it: npm i @modelcontextprotocol/sdk',
      cause: err,
    });
  }
}

/** The v2 line's stdio transport (`@modelcontextprotocol/client/stdio`, Node-only). */
async function loadV2Stdio(): Promise<{ StdioClientTransport: new (opts: object) => unknown }> {
  try {
    const spec: string = '@modelcontextprotocol/client/stdio';
    return (await import(spec)) as { StdioClientTransport: new (opts: object) => unknown };
  } catch (err) {
    throw new InvalidRequestError({ message: NO_V2_SDK_MESSAGE, cause: err });
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
  viaAuto: boolean,
): Promise<RawMcpClient> {
  const { Client } = await loadSdk(viaAuto);
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
  return recordV1NegotiatedVersion(client);
}

export async function createStdioMcpClient(options: McpStdioOptions): Promise<McpRootsClient> {
  const line = await selectMcpSdk(options.sdk);
  assertLineSupports(line, options.versionNegotiation);
  // Same lazy chunk the HTTP transport uses; resolved BEFORE anything spawns so
  // a missing peer is an install hint, not a half-started child.
  const v2 = line === 'v2' ? await import('./sdk-v2') : undefined;
  const v2Stdio = v2 ? await loadV2Stdio() : undefined;
  const viaAuto = options.sdk === undefined || options.sdk === 'auto';
  const rootsBox = options.roots !== undefined ? createRootsBox(options.roots) : undefined;
  const managed = await createManagedConnection({
    makeClient: (hooks) =>
      v2
        ? v2.makeV2Client(options, hooks, rootsBox)
        : makeStdioClient(options, hooks, rootsBox, viaAuto),
    // A reconnect RESPAWNS the child process: the old one died with the pipe.
    makeTransport: async () => {
      const { StdioClientTransport } = v2Stdio ?? (await loadSdk(viaAuto));
      return new StdioClientTransport({
        command: options.command,
        args: options.args ?? [],
        ...(options.env ? { env: options.env } : {}),
      });
    },
    lifecycle: options,
  });
  return attachRoots(
    wrapMcpClient(managed.raw(), managed, { sdk: line }),
    managed.raw(),
    rootsBox,
    managed,
  );
}
