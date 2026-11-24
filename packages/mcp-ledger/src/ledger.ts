/**
 * `createMcpLedger`: the ledger as a value. It opens three SQLite files in one
 * data directory (lazily, on first use) and builds the Deuz MCP server that
 * serves the nine ledger tools. The CLI serves it over stdio or loopback HTTP;
 * a host can embed it and serve `ledger.server` however it likes.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, ToolSet } from '@deuz-sdk/core';
import { createMcpServer, type DeuzMcpServer } from '@deuz-sdk/core/mcp/server';
import { createMemorySession, type MemorySession } from '@deuz-sdk/core/memory/versioned';
import { createSqliteVersionedMemoryStore } from '@deuz-sdk/core/memory/versioned/sqlite';
import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';
import packageJson from '../package.json' with { type: 'json' };
import { createLedgerBudget, type LedgerBudget } from './budget';
import { McpLedgerError } from './errors';
import { parseLedgerWindow, type LedgerWindow } from './options';
import { createReceiptLog, type ReceiptLog } from './receipts';
import { createLedgerTools, LEDGER_INSTRUCTIONS, LEDGER_TOOL_ANNOTATIONS } from './tools';

/** This package's version, as served in the MCP handshake. */
export const MCP_LEDGER_VERSION: string = packageJson.version;

/** The three database files inside the data directory. */
export const LEDGER_FILES = {
  memory: 'memory.sqlite',
  budget: 'budget.sqlite',
  receipts: 'receipts.sqlite',
} as const;

/** Options of {@link createMcpLedger}. */
export interface McpLedgerOptions {
  /** Directory holding the ledger's SQLite files; created when missing. */
  dataDir: string;
  /** The spend ceiling. Without `usd` or `tokens`, status reports spend with no ceiling. */
  budget?: {
    usd?: number;
    tokens?: number;
    /** A parsed window or a spec (`'month'`, `'7d'`, `'lifetime'`). Default `'month'` (rolling 30 days). */
    window?: LedgerWindow | string;
    /** Status turns `warning` at this percent of a ceiling. Default 80. */
    warnAtPercent?: number;
  };
  /**
   * A separate memory space in the same files (one per project, say). Memory
   * lives under the scope `{ userId: namespace }`. Default `'default'`. Budget
   * and receipts are shared across namespaces.
   */
  namespace?: string;
  /** Server name in the MCP handshake. Default `'deuz-ledger'`. */
  name?: string;
  /** Time source for every store. Default: the host clock. */
  clock?: Clock;
  /** Ids for memories, spends and receipts given none. Default `crypto.randomUUID`. */
  generateId?: () => string;
}

/** A ledger: its stores, its tools and the MCP server serving them. */
export interface McpLedger {
  /** The Deuz MCP server: `fetch` for Streamable HTTP; pass it to `serveMcpStdio` for stdio. */
  readonly server: DeuzMcpServer;
  /** The served tools as a Deuz `ToolSet`, for a host's own agent loop. */
  readonly tools: ToolSet;
  /** The absolute-or-given data directory. */
  readonly dataDir: string;
  /** The memory session (scope `{ userId: namespace }`). A host write here may assert (`origin: 'asserted'`). */
  readonly memory: MemorySession;
  readonly budget: LedgerBudget;
  readonly receipts: ReceiptLog;
  /** Close the server and every database. Idempotent. */
  close(): Promise<void>;
}

const HOST_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function checkCeiling(value: unknown, label: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new McpLedgerError(
      'invalid_option',
      `budget.${label} must be a finite nonnegative ${integer ? 'integer' : 'number'}.`,
    );
  }
  return value;
}

/**
 * Build a ledger over `options.dataDir`. Synchronous: the directory is created
 * now, the databases open on first use (so a missing `node:sqlite` surfaces on
 * the first tool call, or at once through `ledger.server.ready()` plus a call).
 *
 * ```ts
 * import { createMcpLedger } from '@deuz-sdk/mcp-ledger';
 * import { serveMcpStdio } from '@deuz-sdk/core/mcp/server/stdio';
 *
 * const ledger = createMcpLedger({ dataDir: './.ledger', budget: { usd: 20, window: 'month' } });
 * await serveMcpStdio(ledger.server);
 * ```
 *
 * @throws McpLedgerError `invalid_option` for a bad ceiling, window or namespace.
 */
export function createMcpLedger(options: McpLedgerOptions): McpLedger {
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.dataDir !== 'string' ||
    !options.dataDir.trim()
  ) {
    throw new McpLedgerError('invalid_option', 'createMcpLedger needs a dataDir.');
  }
  const namespace = options.namespace ?? 'default';
  if (typeof namespace !== 'string' || !namespace.trim()) {
    throw new McpLedgerError('invalid_option', 'namespace must be a non-empty string.');
  }
  const usd = checkCeiling(options.budget?.usd, 'usd', false);
  const tokens = checkCeiling(options.budget?.tokens, 'tokens', true);
  const rawWindow = options.budget?.window ?? 'month';
  const window = typeof rawWindow === 'string' ? parseLedgerWindow(rawWindow) : rawWindow;
  const warnAtPercent = options.budget?.warnAtPercent;
  if (warnAtPercent !== undefined && (!Number.isFinite(warnAtPercent) || warnAtPercent < 0)) {
    throw new McpLedgerError(
      'invalid_option',
      'budget.warnAtPercent must be a nonnegative number.',
    );
  }

  const clock = options.clock ?? HOST_CLOCK;
  const generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
  const dataDir = options.dataDir;
  mkdirSync(dataDir, { recursive: true });

  const memoryStore = createSqliteVersionedMemoryStore({
    path: join(dataDir, LEDGER_FILES.memory),
    clock,
  });
  const budgetStore = createSqliteBudgetStore({ path: join(dataDir, LEDGER_FILES.budget), clock });
  const receipts = createReceiptLog({
    path: join(dataDir, LEDGER_FILES.receipts),
    now: () => clock.now(),
    generateId,
  });

  // No embedder and no LLM: recall is lexical (FTS5, LIKE where FTS5 is
  // missing) and remember always adds. No API key is ever needed.
  const memory = createMemorySession({
    store: memoryStore,
    scope: { userId: namespace },
    deps: { clock, generateId },
  });
  const budget = createLedgerBudget({
    store: budgetStore,
    config: {
      ...(usd !== undefined ? { usd } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      window,
      ...(warnAtPercent !== undefined ? { warnAtPercent } : {}),
    },
    now: () => clock.now(),
    generateId,
  });
  const tools = createLedgerTools({ memory, budget, receipts });
  const server = createMcpServer({
    name: options.name ?? 'deuz-ledger',
    version: MCP_LEDGER_VERSION,
    instructions: LEDGER_INSTRUCTIONS,
    tools,
    toolAnnotations: LEDGER_TOOL_ANNOTATIONS,
    clock,
  });

  let closing: Promise<void> | undefined;
  return {
    server,
    tools,
    dataDir,
    memory,
    budget,
    receipts,
    close() {
      closing ??= (async () => {
        const results = await Promise.allSettled([
          server.close(),
          memoryStore.close(),
          budgetStore.close(),
          receipts.close(),
        ]);
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
      })();
      return closing;
    },
  };
}
