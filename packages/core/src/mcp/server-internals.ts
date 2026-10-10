/**
 * mcp/server-internals.ts (2.3) — the private contract between the two MCP
 * server entries: `./mcp/server` (edge-safe, `createMcpServer`) builds a handle,
 * and the Node-only stdio entry (`src/node/mcp-server.ts`) serves that SAME
 * handle over stdin/stdout.
 *
 * The handle carries its internals under a REGISTERED symbol
 * (`Symbol.for`), never a module-local `WeakMap`: the two entries are separate
 * bundles, and a host that `require`s one and `import`s the other gets two
 * copies of every module — a registered symbol is the one key both copies agree
 * on. Internal: nothing here is re-exported from a public barrel.
 */

/** Where a served instance runs — reported to the host as `McpServerRequest.transport`. */
export type McpServerTransportKind = 'http' | 'stdio';

/** The protocol era one SDK server instance is pinned to. */
export type McpServerEra = 'legacy' | 'modern';

export interface McpServerInternals {
  /** Load the SDK and prepare every tool (memoized; rejects on a broken definition or a missing peer). */
  ready(): Promise<void>;
  /**
   * The v2 SDK server factory for one transport: called with the era of each
   * serving unit (one HTTP request, one stdio connection or its discover probe),
   * it resolves with a fresh `McpServer` that has every tool registered.
   */
  factory(transport: McpServerTransportKind): (ctx: { era: McpServerEra }) => Promise<unknown>;
  /** The server's `onError` sink (never throws), shared by every transport. */
  report(error: unknown): void;
}

/** The registered key the internals live under on a `DeuzMcpServer` handle. */
export const MCP_SERVER_INTERNALS: unique symbol = Symbol.for('deuz.mcp.server.internals');

/** Read a handle's internals, or `undefined` for anything `createMcpServer` did not build. */
export function readServerInternals(handle: unknown): McpServerInternals | undefined {
  if (typeof handle !== 'object' || handle === null) return undefined;
  const internals = (handle as { [MCP_SERVER_INTERNALS]?: unknown })[MCP_SERVER_INTERNALS];
  return typeof internals === 'object' && internals !== null
    ? (internals as McpServerInternals)
    : undefined;
}
