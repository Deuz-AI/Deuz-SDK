/**
 * mcp/resolve.ts (2.0) — zero-config MCP for the agentic loop.
 *
 * This is what turns `generateText({ mcp: [{ url }] })` into a run whose tool set
 * already contains the server's tools. Everything the loop needs from MCP is
 * behind ONE object ({@link ResolvedMcpRuntime}) so the two loops stay symmetric:
 * build the tools, ask `changed()` at each step boundary, `refresh()` when the
 * answer is yes, `closeOwned()` at every exit.
 *
 * ## Ownership is the whole design
 *
 * A CONFIG (`{ url }` / `{ command }`) describes a connection the run opens, so
 * the run closes it. A LIVE `McpClient` — bare or wrapped in `{ client }` — is
 * BORROWED: the caller opened it, the caller closes it, and `closeOwned()` must
 * never touch it (closing a long-lived connector because one request finished is
 * the bug this rule exists to prevent). A pooled client (see
 * {@link createMcpPool}) sits in the same "borrowed" bucket for the same reason:
 * the pool outlives the run.
 *
 * ## Why it is reached through a dynamic import
 *
 * `inference/loop-shared.ts` loads this module with a LITERAL
 * `import('../mcp/resolve')` and only when `options.mcp` is present. MCP drags in
 * the SDK wrapper, the OAuth adaptor and the sampling bridge; a call that never
 * asks for MCP must not pay a byte of that in the measured core/edge bundle.
 * Keep the specifier literal — a computed one defeats the code split.
 *
 * Edge-safe: no node builtins, no ambient clock/randomness/logging. The stdio
 * transport (the one Node-only branch) is itself reached through a dynamic
 * import, so an edge runtime that only ever passes `{ url }` never resolves it.
 */
import type { Clock, Logger } from '../types/deps';
import type { ToolSet } from '../types/tool';
import type {
  McpClientLoopEntry,
  McpHttpLoopConfig,
  McpLoopEntry,
  McpStdioLoopConfig,
} from '../types/config';
import type { McpClient } from './shared';
import { InvalidRequestError } from '../errors';
import { createMcpClient } from './index';

/** A `CommonCallOptions.mcp` entry the run can CONNECT (as opposed to borrow). */
export type McpConnectableConfig = McpHttpLoopConfig | McpStdioLoopConfig;

/**
 * A cross-call connection cache (`deps.mcpPool`). Server processes hold one of
 * these so a per-request `mcp: [{ url }]` reuses the handshake instead of paying
 * it again on every call; `close()` belongs to whoever created the pool
 * (typically a process-shutdown hook), never to a run.
 */
export interface McpConnectionPool {
  /** The client for this config — connected on first use, reused afterwards. */
  acquire(config: McpConnectableConfig): Promise<McpClient>;
  /** Close every pooled connection and empty the pool. */
  close(): Promise<void>;
}

/** What the loop holds onto for the life of one run. */
export interface ResolvedMcpRuntime {
  /**
   * The merged, namespaced MCP tool set, in entry order. REPLACED (not mutated)
   * by {@link refresh}, so a wire list built from a previous value is never
   * silently rewritten under the model.
   */
  tools: ToolSet;
  /** True once any connected server invalidated its tool list (`tools/list_changed`). */
  changed(): boolean;
  /** Re-read every catalog, rebuild {@link tools}, clear the dirty flag. */
  refresh(): Promise<ToolSet>;
  /** Close ONLY what this run opened. Borrowed and pooled clients survive. Never rejects. */
  closeOwned(): Promise<void>;
  /** Every client backing the merged set, in entry order (borrowed ones included). */
  clients: McpClient[];
}

/** The seam `resolveMcpForLoop` needs from the call's resolved dependencies. */
export interface McpResolveDeps {
  logger: Logger;
  /** Backoff/keepalive timers for run-opened connections (edge-safety: never ambient). */
  clock?: Clock;
  mcpPool?: McpConnectionPool;
}

// --- entry classification ---------------------------------------------------

function isMcpClient(entry: McpLoopEntry): entry is McpClient {
  return typeof (entry as Partial<McpClient>).listTools === 'function';
}

function isClientEntry(entry: McpLoopEntry): entry is McpClientLoopEntry {
  const client = (entry as Partial<McpClientLoopEntry>).client;
  return typeof client === 'object' && client !== null;
}

function isHttpConfig(entry: McpLoopEntry): entry is McpHttpLoopConfig {
  return typeof (entry as Partial<McpHttpLoopConfig>).url === 'string';
}

function isStdioConfig(entry: McpLoopEntry): entry is McpStdioLoopConfig {
  return typeof (entry as Partial<McpStdioLoopConfig>).command === 'string';
}

/** How an entry is named in an error message — the caller has to recognize it. */
function describeEntry(entry: McpLoopEntry): string {
  if (isHttpConfig(entry)) return entry.url;
  if (isStdioConfig(entry)) return [entry.command, ...(entry.args ?? [])].join(' ');
  return 'the provided MCP client';
}

// --- namespaces -------------------------------------------------------------

/**
 * Tool names travel to providers that accept `[A-Za-z0-9_-]` only (OpenAI pins
 * exactly that), so a server called "GitHub MCP (beta)" cannot be a prefix
 * verbatim. Runs of anything else collapse to one `_`; a name that sanitizes to
 * nothing is treated as absent so the caller gets the positional fallback.
 */
export function sanitizeNamespace(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Prefix for one entry: an explicit `namespace` always wins; a SINGLE entry gets
 * no prefix at all (the zero-config case — `mcp: [{ url }]` should read like
 * `tools: {…}`); otherwise the server's own handshake name, sanitized; and
 * `mcp{index}` when the server did not send one.
 */
function resolveNamespace(
  explicit: string | undefined,
  client: McpClient,
  index: number,
  total: number,
): string | undefined {
  if (explicit !== undefined) return explicit;
  if (total === 1) return undefined;
  const name = client.serverInfo?.()?.name;
  const sanitized = name ? sanitizeNamespace(name) : '';
  return sanitized.length > 0 ? sanitized : `mcp${index}`;
}

// --- merging ----------------------------------------------------------------

interface ResolvedEntry {
  client: McpClient;
  namespace?: string;
  /** Did THIS run open the connection? Only owned clients are closed at the end. */
  owned: boolean;
}

/**
 * Merge the per-server tool sets in entry order. A duplicate key means two
 * servers export the same (namespaced) name: the LATER entry wins, and the
 * collision is logged — the same warn-but-continue discipline `filterWireTools`
 * uses, because failing a run over a name clash would be worse than an
 * over-specific tool.
 */
function mergeToolSets(sets: ToolSet[], logger: Logger): ToolSet {
  const merged: ToolSet = {};
  for (const set of sets) {
    for (const [name, tool] of Object.entries(set)) {
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        logger.warn(
          `mcp: duplicate tool name '${name}' — the later server wins; set a \`namespace\` to keep both`,
        );
      }
      merged[name] = tool;
    }
  }
  return merged;
}

async function listEntryTools(entry: ResolvedEntry): Promise<ToolSet> {
  return entry.namespace === undefined
    ? entry.client.listTools()
    : entry.client.listTools(entry.namespace);
}

// --- connecting -------------------------------------------------------------

/**
 * Open one config-described connection. `reconnect: true` is the loop default on
 * purpose: an agentic run outlives a single request, and a dropped session in the
 * middle of step 4 would otherwise fail every remaining tool call. It is only the
 * DEFAULT for connections the run opens — a client the caller built keeps
 * whatever lifecycle the caller chose.
 */
async function connectConfig(config: McpConnectableConfig, clock?: Clock): Promise<McpClient> {
  if (isHttpConfig(config)) {
    return createMcpClient({
      transport: {
        type: config.type ?? 'http',
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
      },
      ...(config.auth ? { auth: config.auth } : {}),
      ...(config.onElicitationRequest ? { onElicitationRequest: config.onElicitationRequest } : {}),
      reconnect: true,
      ...(clock ? { clock } : {}),
    });
  }
  // The stdio transport is NODE-ONLY, and the specifier is deliberately a
  // `string`-typed variable rather than a literal — the same idiom `mcp/index.ts`
  // uses for the optional peer, and for the same reason. A literal makes
  // `mcp/stdio` part of the statically analyzable graph of every bundler that
  // follows `import()` (esbuild's `bundle: true` INLINES it), and
  // `tooling/check-runtime-compat.mjs` fails a browser/edge consumer that can
  // reach a Node-only module — correctly, because that is the whole point of the
  // node-only subpaths. Resolving by PACKAGE SELF-REFERENCE keeps it right at
  // runtime: `./mcp/stdio` is a published export, so Node loads the real module
  // the moment — and only the moment — a `{ command }` entry is actually used.
  const spec: string = '@deuz-sdk/core/mcp/stdio';
  const { createStdioMcpClient } = (await import(spec)) as typeof import('./stdio');
  return createStdioMcpClient({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    reconnect: true,
    ...(clock ? { clock } : {}),
  });
}

/** Wrap a connect failure in an error that names the entry the caller wrote. */
function connectFailure(entry: McpLoopEntry, cause: unknown): InvalidRequestError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new InvalidRequestError({
    message: `mcp: could not connect to ${describeEntry(entry)}: ${detail}`,
    cause,
  });
}

/**
 * Connect (or borrow) every entry, read the catalogs, and hand the loop a runtime.
 *
 * FAIL FAST: a server that cannot be reached rejects the whole call rather than
 * quietly running with a smaller tool set — a half-connected agent produces
 * confidently wrong answers, which is worse than an actionable error. Whatever
 * this call already opened is closed before the rejection propagates, so a
 * failure leaks no connections.
 *
 * The buffered loop lets that rejection surface as the call's rejection; the
 * streaming loop resolves it INSIDE the pump, so it becomes an `error` part and
 * G2 (never throw synchronously) is preserved.
 */
export async function resolveMcpForLoop(
  entries: McpLoopEntry[],
  deps: McpResolveDeps,
): Promise<ResolvedMcpRuntime> {
  const resolved: ResolvedEntry[] = [];
  const unsubscribes: Array<() => void> = [];
  let dirty = false;

  const closeOpened = async (): Promise<void> => {
    for (const unsubscribe of unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // an exploding unsubscribe must not mask the failure being handled
      }
    }
    await Promise.all(
      resolved
        .filter((e) => e.owned)
        .map(async (e) => {
          try {
            await e.client.close();
          } catch (error) {
            deps.logger.error('mcp: closing a run-owned connection failed', { error });
          }
        }),
    );
  };

  try {
    for (const [index, entry] of entries.entries()) {
      if (isMcpClient(entry)) {
        resolved.push({ client: entry, owned: false });
        continue;
      }
      if (isClientEntry(entry)) {
        resolved.push({
          client: entry.client,
          ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
          owned: false,
        });
        continue;
      }
      if (!isHttpConfig(entry) && !isStdioConfig(entry)) {
        throw new InvalidRequestError({
          message: `mcp: entry ${index} is neither a live client nor a { url } / { command } config.`,
        });
      }
      const config: McpConnectableConfig = entry;
      try {
        // With a pool the CONNECTION belongs to the pool, so the run borrows it
        // exactly like a caller-supplied client and must not close it.
        const client = deps.mcpPool
          ? await deps.mcpPool.acquire(config)
          : await connectConfig(config, deps.clock);
        resolved.push({
          client,
          ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
          owned: deps.mcpPool === undefined,
        });
      } catch (cause) {
        if (cause instanceof InvalidRequestError && cause.message.startsWith('mcp: ')) throw cause;
        throw connectFailure(entry, cause);
      }
    }

    // Namespaces need the handshake, so they resolve only once everything is up.
    for (const [index, entry] of resolved.entries()) {
      const namespace = resolveNamespace(entry.namespace, entry.client, index, resolved.length);
      if (namespace === undefined) delete entry.namespace;
      else entry.namespace = namespace;
    }

    // Invalidation is wired for EVERY client, borrowed ones included: a caller's
    // long-lived connector can gain a tool mid-run just as easily as ours can.
    // Each subscription is released by closeOwned(), so nothing leaks onto a
    // client that outlives the run.
    for (const entry of resolved) {
      unsubscribes.push(
        entry.client.onToolListChanged(() => {
          dirty = true;
        }),
      );
    }

    const build = async (): Promise<ToolSet> => {
      const sets: ToolSet[] = [];
      for (const entry of resolved) sets.push(await listEntryTools(entry));
      return mergeToolSets(sets, deps.logger);
    };

    const runtime: ResolvedMcpRuntime = {
      tools: await build(),
      changed: () => dirty,
      async refresh() {
        // Cleared FIRST: a notification that lands while the catalogs are being
        // re-read must survive as a pending refresh, not be erased by this one.
        dirty = false;
        try {
          runtime.tools = await build();
        } catch (error) {
          // Still stale: re-arm so the NEXT step boundary tries again. The caller
          // keeps the previous catalog (see `refreshMcpTools` in loop-shared) —
          // one failed `tools/list` must not end a healthy run.
          dirty = true;
          throw error;
        }
        return runtime.tools;
      },
      closeOwned: closeOpened,
      clients: resolved.map((e) => e.client),
    };
    return runtime;
  } catch (error) {
    await closeOpened();
    throw error;
  }
}

// --- the cross-call pool ----------------------------------------------------

/**
 * Stable identity for values a config can hold. Plain objects/arrays serialize
 * structurally with sorted keys (so key ORDER never splits the cache), while
 * functions and class instances — an elicitation handler, a `DeuzOAuthProvider`,
 * a token store — get a per-value id from a WeakMap. That distinction matters:
 * two configs identical except for their elicitation handler are NOT the same
 * connection, and JSON would have erased the difference by dropping functions.
 */
let identitySeq = 0;
const identities = new WeakMap<object, string>();

/**
 * Raised whenever a key falls back to identity. Read (and reset) around the
 * SYNCHRONOUS `mcpConnectionKey` call in `acquire`, which is what makes a single
 * module-level flag safe here: nothing can interleave between the two.
 */
let usedIdentity = false;

function identityOf(value: object): string {
  usedIdentity = true;
  let id = identities.get(value);
  if (id === undefined) {
    identitySeq += 1;
    id = `#${identitySeq}`;
    identities.set(value, id);
  }
  return id;
}

function stableKey(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'function':
      return `fn${identityOf(value)}`;
    case 'object': {
      const object = value as Record<string, unknown>;
      const proto: unknown = Object.getPrototypeOf(object);
      // A class instance has behavior we cannot see — identity, not structure.
      if (proto !== Object.prototype && proto !== null) return `obj${identityOf(object)}`;
      const keys = Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(object[key])}`).join(',')}}`;
    }
    default:
      return String(value);
  }
}

/**
 * The pool key.
 *
 * `namespace` is deliberately EXCLUDED: it is a presentation choice about tool
 * names, not a property of the connection, so two calls that prefix the same
 * server differently still share one session. Everything else is IN, by
 * EXCLUSION rather than by an allowlist of `url`/`type`/`headers`/`command`/
 * `args`/`env`: a field this function does not know about is far more likely to
 * be a new way of reaching the server than a new label for it, and the two
 * mistakes do not cost the same — an unknown field that splits the cache costs a
 * handshake, one dropped from the key hands request B the connection request A
 * authenticated.
 *
 * That is also why `auth` and `onElicitationRequest` stay in the key even though
 * they can only be compared by IDENTITY: an OAuth provider is per-user and an
 * elicitation handler answers back to one request's UI, so merging two of them
 * into one session would be a credential/consent leak, not an optimization. The
 * cost is that such a config, rebuilt per request, never hits — which the pool
 * reports through {@link McpPoolOptions.logger} and bounds with `maxSize`.
 */
export function mcpConnectionKey(config: McpConnectableConfig): string {
  const connection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== 'namespace') connection[key] = value;
  }
  return stableKey(connection);
}

/**
 * Live connections one pool holds before it starts evicting. High enough that a
 * server process talking to a handful of MCP servers never reaches it, low
 * enough that a config the key cannot merge (see {@link mcpConnectionKey})
 * cannot exhaust the host's sockets or child processes.
 */
const DEFAULT_MCP_POOL_SIZE = 32;

export interface McpPoolOptions {
  /** Backoff/keepalive timers for pooled connections. Default: the host clock. */
  clock?: Clock;
  /**
   * Ceiling on live pooled connections. Default 32; values below 1 are clamped.
   *
   * Reaching it EVICTS the least-recently-acquired entry and CLOSES it. That is
   * a deliberate choice over refusing the acquire: the pool is a cache, and a
   * cache that fails a legitimate request to protect its own bookkeeping is
   * worse than one that forgets. The trade is real, though — the pool cannot see
   * which clients a run is still using, so a session evicted mid-run takes that
   * run's remaining MCP tool calls down with it. Keep the limit comfortably
   * above the number of DISTINCT servers you have in flight.
   */
  maxSize?: number;
  /**
   * Where the pool reports a config it cannot pool — one whose `auth` provider or
   * `onElicitationRequest` handler forces an IDENTITY key (see
   * {@link mcpConnectionKey}), so a per-request copy of it opens a connection
   * per request instead of reusing one. Hoisting that value to module scope, or
   * keeping it off the pooled config, is what turns the misses back into hits.
   * Default: silent.
   */
  logger?: Logger;
}

/**
 * A process-lifetime MCP connection cache for `deps.mcpPool`.
 *
 * Keyed by the config's structure (see {@link mcpConnectionKey}), so the same
 * `{ url }` handed to a hundred requests handshakes once. The in-flight PROMISE
 * is what is cached, so concurrent requests for a cold server share one connect
 * instead of racing several. A connect that fails is evicted (the next call
 * retries rather than replaying a dead rejection), and so is an entry whose
 * session has since gone `closed`/`error` — a pool that hands back a corpse is
 * worse than no pool, and a dead entry is CLOSED on its way out rather than just
 * forgotten.
 *
 * It is BOUNDED: {@link McpPoolOptions.maxSize} connections, least-recently-
 * acquired evicted (and closed) beyond that. A process-lifetime cache with no
 * ceiling is a leak with extra steps — one config the key cannot merge (see
 * {@link mcpConnectionKey}) would otherwise add a connection per request forever.
 */
export function createMcpPool(options: McpPoolOptions = {}): McpConnectionPool {
  // Clamped: at 0 the ceiling would evict the entry the current acquire just
  // added, i.e. close the connection it is about to hand back.
  const maxSize = Math.max(1, options.maxSize ?? DEFAULT_MCP_POOL_SIZE);
  /** Insertion order IS the LRU order: a hit re-inserts, eviction takes the front. */
  const entries = new Map<string, Promise<McpClient>>();
  /** The identity warning is worth saying once per pool, not once per request. */
  let warned = false;

  /** Close one entry whatever state it is in. Never rejects, never blocks a caller. */
  const closeEntry = async (pending: Promise<McpClient>): Promise<void> => {
    try {
      await (await pending).close();
    } catch {
      // A connect that failed has nothing to close, and one wedged server must
      // not block the rest of the teardown.
    }
  };

  return {
    async acquire(config) {
      usedIdentity = false;
      const key = mcpConnectionKey(config);
      if (usedIdentity && !warned) {
        warned = true;
        options.logger?.warn(
          'mcp pool: identity-keyed (function/instance) config — a per-request copy opens its own connection.',
        );
      }
      // Every round either returns, throws, or consumes an entry that was in the
      // map when the round began — a caller that finds the entry replaced under
      // it re-reads instead of opening a second connection nobody would close.
      for (;;) {
        const existing = entries.get(key);
        if (existing === undefined) {
          // The in-flight PROMISE is what is cached, so concurrent acquires of a
          // cold server share one connect. Both statements are synchronous, so
          // no second caller can slip between them.
          const pending = connectConfig(config, options.clock);
          entries.set(key, pending);
          // At most one entry can be over the line, since this is the only place
          // one is added. The victim is CLOSED — forgetting it would leak exactly
          // the connection the ceiling exists to stop — and silently, because the
          // eviction is the documented contract of `maxSize`, not a surprise: an
          // evicted client reports `status() === 'closed'` to anyone still holding
          // it, which is a better signal than a log line nobody reads.
          if (entries.size > maxSize) {
            for (const [oldest, victim] of entries) {
              entries.delete(oldest);
              void closeEntry(victim);
              break;
            }
          }
          try {
            return await pending;
          } catch (error) {
            if (entries.get(key) === pending) entries.delete(key);
            throw error;
          }
        }
        const client = await existing;
        if (entries.get(key) !== existing) continue; // replaced while we waited
        const status = client.status();
        if (status !== 'closed' && status !== 'error') {
          entries.delete(key);
          entries.set(key, existing); // most-recently-used
          return client;
        }
        // A dead session is dropped AND closed — an `error` one exhausted its
        // reconnects with the transport still open, so evicting alone would leak
        // it. The next round connects, exactly once, for everyone waiting here.
        entries.delete(key);
        void closeEntry(existing);
      }
    },
    async close() {
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(pending.map(closeEntry));
    },
  };
}
