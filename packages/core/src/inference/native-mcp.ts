/**
 * inference/native-mcp.ts (2.3, F01) — MCP servers inside a native run.
 *
 * A native run routes its MCP tools through the effect receipts its local tools
 * use, and pins the servers' tool catalog in its resume binding. Before 2.3 the
 * loop merged the raw MCP tools after the receipts were prepared: an interrupted
 * MCP call left no receipt, so a resume repeated its effect, and a catalog that
 * changed between checkpoint and resume went unnoticed.
 *
 * `agent-run.ts` reaches this module through a LITERAL dynamic import, and only
 * when a run has (or had) MCP servers. The MCP module graph stays out of the
 * native agent bundle for every run without MCP, exactly as `setupMcp` keeps it
 * out of the loop's.
 *
 * It must not import a VALUE from a module the core bundles load eagerly: a
 * bundler keeps every export a lazy chunk imports, even in a bundle that
 * tree-shakes `agent-run.ts` away (the edge entry), so such an import would
 * make all of native tool preparation eager there. The receipt wrapper is
 * therefore passed in (`prepare`).
 */
import type { ToolSet } from '../types/tool';
import type { McpLoopEntry } from '../types/config';
import type { ResolvedDependencies } from '../types/deps';
import type { CallWarning } from '../types/methods';
import type { AgentMcpEntry, AgentMcpReplay } from '../types/agent-run';
import { resolveMcpForLoop, type ResolvedMcpRuntime } from '../mcp/resolve';
import { detectToolDrift, fingerprintTools, type ToolFingerprints } from '../mcp/shared';

/** Puts MCP tools behind the run's receipts (`prepareMcpTools`, bound by the runner). */
export type PrepareMcpTools = (
  tools: ToolSet,
  replayOf: (name: string) => 'idempotent' | undefined,
) => Promise<ToolSet>;

export interface NativeMcp {
  /**
   * The run's MCP tools behind the run's receipts, a hot refresh included. The
   * loop uses it and never closes it; {@link close} does.
   */
  runtime: ResolvedMcpRuntime;
  /** `'idempotent'` when the tool's `mcp` entry declared it so. */
  replayOf(name: string): 'idempotent' | undefined;
  /** The servers' current catalog, serialized for `AgentRunEnvelope.binding.mcp`. */
  catalog(): Promise<string>;
  /** Close the connections this run opened. Never throws. */
  close(): Promise<void>;
}

const isLiveClient = (entry: AgentMcpEntry): boolean =>
  typeof (entry as { listTools?: unknown }).listTools === 'function';

function assertReplay(replay: unknown, index: number): asserts replay is AgentMcpReplay {
  const valid =
    replay === 'idempotent' ||
    (typeof replay === 'object' &&
      replay !== null &&
      !Array.isArray(replay) &&
      Object.values(replay).every((value) => value === 'idempotent'));
  if (!valid) {
    throw new TypeError(
      `mcp entry ${index}: replay must be 'idempotent' or a map of tool names to 'idempotent'.`,
    );
  }
}

/**
 * Split each entry into what the MCP resolver connects and the replay it
 * declares. `replay` is native bookkeeping: left on a config it would also enter
 * the connection pool's key and split one server's connections. A bare live
 * client is passed through untouched, never copied.
 */
function splitEntries(entries: readonly AgentMcpEntry[]): {
  connect: McpLoopEntry[];
  replays: (AgentMcpReplay | undefined)[];
} {
  const connect: McpLoopEntry[] = [];
  const replays: (AgentMcpReplay | undefined)[] = [];
  for (const [index, entry] of entries.entries()) {
    if (isLiveClient(entry)) {
      connect.push(entry as McpLoopEntry);
      replays.push(undefined);
      continue;
    }
    const { replay, ...rest } = entry as Exclude<AgentMcpEntry, { listTools: unknown }>;
    if (replay !== undefined) assertReplay(replay, index);
    connect.push(rest as McpLoopEntry);
    replays.push(replay);
  }
  return { connect, replays };
}

/** Close what the run opened. Never throws: teardown must not fail a finished run. */
async function closeQuietly(runtime: ResolvedMcpRuntime, deps: ResolvedDependencies) {
  try {
    await runtime.closeOwned();
  } catch (error) {
    deps.logger.error('mcp: closing run-owned connections failed', { error });
  }
}

/**
 * Connect the run's MCP servers and put their tools behind the run's receipts.
 * Rejects, with nothing left open, when a server cannot be reached.
 */
export async function resolveNativeMcp(
  entries: readonly AgentMcpEntry[],
  deps: ResolvedDependencies,
  prepare: PrepareMcpTools,
  /** Where a name collision between two servers is reported (2.3): the run's warnings. */
  warn?: (warning: CallWarning) => void,
): Promise<NativeMcp> {
  const { connect, replays } = splitEntries(entries);
  const inner = await resolveMcpForLoop(connect, {
    ...(warn ? { warn } : {}),
    logger: deps.logger,
    // Reconnect backoff and keepalive run on the INJECTED clock (edge-safety).
    clock: deps.clock,
    ...(deps.mcpPool ? { mcpPool: deps.mcpPool } : {}),
  });
  const replayOf = (name: string): 'idempotent' | undefined => {
    const origin = inner.origins?.[name];
    const declared = origin ? replays[origin.entry] : undefined;
    if (declared === undefined || origin === undefined) return undefined;
    if (declared === 'idempotent') return 'idempotent';
    return Object.hasOwn(declared, origin.name) ? declared[origin.name] : undefined;
  };
  try {
    const runtime: ResolvedMcpRuntime = {
      tools: await prepare(inner.tools, replayOf),
      get origins() {
        return inner.origins;
      },
      changed: () => inner.changed(),
      async refresh() {
        // A failed re-read keeps the previous, already prepared catalog.
        await inner.refresh();
        runtime.tools = await prepare(inner.tools, replayOf);
        return runtime.tools;
      },
      closeOwned: () => inner.closeOwned(),
      clients: inner.clients,
    };
    return {
      runtime,
      replayOf,
      catalog: async () => JSON.stringify(await fingerprintTools(inner.tools)),
      close: () => closeQuietly(inner, deps),
    };
  } catch (error) {
    await closeQuietly(inner, deps);
    throw error;
  }
}

/**
 * How the catalog the run recorded differs from the servers' current one, as
 * text for an error or warning; `undefined` when it does not. Nothing recorded
 * (a run checkpointed before 2.3, or one that had no MCP servers) is no drift:
 * the caller records the current catalog. No current catalog means every
 * recorded tool was removed.
 */
export function catalogDrift(
  recorded: string | undefined,
  current: string | undefined,
): string | undefined {
  if (recorded === undefined) return undefined;
  const parse = (text: string): ToolFingerprints => {
    const value = JSON.parse(text) as Partial<ToolFingerprints> | null;
    if (!value || typeof value.tools !== 'object' || value.tools === null)
      throw new TypeError('Invalid MCP tool catalog in the native binding.');
    return value as ToolFingerprints;
  };
  const before = parse(recorded);
  const after: ToolFingerprints =
    current === undefined ? { algorithm: 'sha-256', tools: {}, fingerprint: '' } : parse(current);
  const drift = detectToolDrift(before, after);
  const parts = (['added', 'removed', 'changed'] as const)
    .filter((kind) => drift[kind].length > 0)
    .map((kind) => `${kind}: ${drift[kind].join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}
