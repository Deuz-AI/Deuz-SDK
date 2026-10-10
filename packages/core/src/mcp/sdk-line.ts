/**
 * mcp/sdk-line.ts (2.3) — which MCP SDK line a client runs on.
 *
 * MCP 2026-07-28 is implemented only by the v2 TypeScript SDK
 * (`@modelcontextprotocol/client`, which brings Zod 4 and needs node >= 20); the
 * v1 package (`@modelcontextprotocol/sdk`) stays on 2025-11-25. Both are optional
 * peers and both sit behind the one `RawMcpClient` seam, so the transports only
 * have to agree on WHICH line builds the raw client — this module is that one
 * decision, shared by the HTTP (`./index`) and stdio (`./stdio`) transports.
 *
 * Internal: nothing here is re-exported from a public barrel. Edge-safe — the
 * peers are reached through computed specifiers, so no bundler resolves them.
 */
import { InvalidRequestError } from '../errors';
import type { McpSdkLine, McpSdkSelection, McpVersionNegotiation, RawMcpClient } from './shared';

/** The v2 client package — the only one that speaks 2026-07-28. */
export const V2_CLIENT_PACKAGE = '@modelcontextprotocol/client';

/**
 * The install hint when the peer `'auto'` would have fallen back to is missing
 * too: name BOTH, because either one would have worked.
 */
export const NO_MCP_SDK_MESSAGE =
  'MCP support needs an MCP SDK — install the MCP 2026-07-28 client (npm i @modelcontextprotocol/client) or the 2025-11-25 one (npm i @modelcontextprotocol/sdk).';

/** The install hint for an explicit `sdk: 'v2'` whose package is missing. */
export const NO_V2_SDK_MESSAGE =
  'MCP on the v2 SDK line needs the optional peer "@modelcontextprotocol/client" (MCP 2026-07-28). Install it: npm i @modelcontextprotocol/client';

/**
 * Probed once per module instance: an `'auto'` decision cannot change while the
 * process runs (Node caches a module that loaded, and one that failed to resolve
 * keeps failing), so every later client reuses the first answer.
 */
let v2Probe: Promise<boolean> | undefined;

function v2Importable(): Promise<boolean> {
  v2Probe ??= (async () => {
    try {
      const spec: string = V2_CLIENT_PACKAGE;
      await import(spec);
      return true;
    } catch {
      return false;
    }
  })();
  return v2Probe;
}

/**
 * Resolve a selection to the line that will build the client. `'auto'` (and an
 * absent value) prefers v2 when it can be imported; anything outside the
 * documented values is rejected rather than silently read as `'auto'`.
 */
export async function selectMcpSdk(selection: McpSdkSelection | undefined): Promise<McpSdkLine> {
  if (selection === 'v1' || selection === 'v2') return selection;
  if (selection !== undefined && selection !== 'auto') {
    throw new InvalidRequestError({
      message: `Unknown MCP sdk ${JSON.stringify(selection)} — use 'auto', 'v1' or 'v2'.`,
    });
  }
  return (await v2Importable()) ? 'v2' : 'v1';
}

/**
 * Reject option combinations a line cannot honor, BEFORE anything connects.
 * The v1 SDK negotiates 2025-era revisions only, so a pinned revision (always a
 * 2026-era one — a 2025 revision is negotiated, never pinned) is unreachable.
 */
export function assertLineSupports(
  line: McpSdkLine,
  negotiation: McpVersionNegotiation | undefined,
): void {
  if (line === 'v1' && typeof negotiation === 'object') {
    throw new InvalidRequestError({
      message: `Pinning MCP revision ${JSON.stringify(negotiation.pin)} needs the v2 SDK line: the v1 package speaks 2025-era revisions only. Install @modelcontextprotocol/client and pass sdk: 'v2' (or 'auto').`,
    });
  }
}

/**
 * Give a v1 SDK client `getNegotiatedProtocolVersion()`.
 *
 * The v1 `Client` never stores the revision its `initialize` settled on: it
 * hands it to `transport.setProtocolVersion()` — and only when the transport has
 * one, which the stdio transport does not. Wrapping `connect` to install a
 * recording `setProtocolVersion` (chaining to the transport's own, when present)
 * captures it on every transport without touching the SDK's code path. Applied
 * to the client the factory builds, so a reconnect records afresh.
 */
export function recordV1NegotiatedVersion(client: RawMcpClient): RawMcpClient {
  let negotiated: string | undefined;
  const connect = client.connect.bind(client);
  client.connect = async (transport) => {
    const target = transport as { setProtocolVersion?: (version: string) => void };
    const own = target.setProtocolVersion?.bind(target);
    target.setProtocolVersion = (version) => {
      negotiated = version;
      own?.(version);
    };
    await connect(transport);
  };
  client.getNegotiatedProtocolVersion = () => negotiated;
  return client;
}
