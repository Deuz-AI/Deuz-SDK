/**
 * `@deuz-sdk/mcp-ledger`: a ready-made MCP server that gives any MCP client
 * (Claude Desktop, Cursor, Goose, ...) Deuz's versioned memory, a spend budget
 * ledger and a tamper-evident receipt log, stored in SQLite files in one local
 * directory. No API key, no embedding model: memory search is lexical.
 *
 * The CLI (`npx @deuz-sdk/mcp-ledger`) is the main way in; this entry is for
 * hosts that embed the server:
 *
 * ```ts
 * import { createMcpLedger } from '@deuz-sdk/mcp-ledger';
 * import { serveMcpStdio } from '@deuz-sdk/core/mcp/server/stdio';
 *
 * const ledger = createMcpLedger({ dataDir: '/var/lib/my-app/ledger', budget: { usd: 50 } });
 * await serveMcpStdio(ledger.server);    // or: export default { fetch: ledger.server.fetch }
 * ```
 *
 * The budget is advisory: an MCP server only learns what the model chooses to
 * report, so it is a record, not an enforced ceiling.
 */
export { createMcpLedger, LEDGER_FILES, MCP_LEDGER_VERSION } from './ledger';
export type { McpLedger, McpLedgerOptions } from './ledger';
export {
  createLedgerTools,
  LEDGER_INSTRUCTIONS,
  LEDGER_TOOL_ANNOTATIONS,
  LEDGER_TOOL_NAMES,
} from './tools';
export type { LedgerToolDeps, LedgerToolName } from './tools';
export { SPEND_KEY } from './budget';
export type {
  BudgetStatus,
  LedgerBudget,
  LedgerBudgetConfig,
  SpendAmounts,
  SpendInput,
} from './budget';
export { createReceiptLog, RECEIPT_STATUSES } from './receipts';
export type {
  Receipt,
  ReceiptChainCheck,
  ReceiptInput,
  ReceiptLog,
  ReceiptLogOptions,
  ReceiptPage,
  ReceiptQuery,
  ReceiptStatus,
} from './receipts';
export { serveMcpLedgerHttp } from './http';
export type { LedgerHttpHandle, LedgerHttpOptions } from './http';
export { DEFAULT_HTTP_PORT, defaultDataDir, parseLedgerArgs, parseLedgerWindow } from './options';
export type { DataDirHost, LedgerCommand, LedgerWindow } from './options';
export { LEDGER_HELP, runLedgerCli } from './run';
export type { LedgerCliIo } from './run';
export { McpLedgerError } from './errors';
export type { McpLedgerErrorCode } from './errors';
