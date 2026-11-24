/**
 * The CLI body, separate from the `bin` shim so a host (or a test) can run it
 * with its own argv, environment and output streams. stdout belongs to the MCP
 * protocol in stdio mode, so everything human-readable goes to stderr.
 */
import { homedir } from 'node:os';
import { serveMcpStdio } from '@deuz-sdk/core/mcp/server/stdio';
import { McpLedgerError } from './errors';
import { serveMcpLedgerHttp } from './http';
import { createMcpLedger, MCP_LEDGER_VERSION } from './ledger';
import { parseLedgerArgs } from './options';

/** The CLI help text. */
export const LEDGER_HELP = `deuz-mcp-ledger ${MCP_LEDGER_VERSION}
A local MCP server with durable memory, a spend budget and a receipt log.

Usage: npx -y @deuz-sdk/mcp-ledger [options]

Options:
  --data-dir <path>     Where the ledger's files live   (env DEUZ_LEDGER_DIR)
  --budget-usd <n>      Spend ceiling in US dollars     (env DEUZ_LEDGER_BUDGET_USD)
  --budget-tokens <n>   Token ceiling                   (env DEUZ_LEDGER_BUDGET_TOKENS)
  --window <spec>       Budget window: day, week, month (rolling 30d, default),
                        lifetime, or 12h / 7d / 2w      (env DEUZ_LEDGER_WINDOW)
  --namespace <name>    Separate memory space           (env DEUZ_LEDGER_NAMESPACE)
  --http [port]         Serve Streamable HTTP on 127.0.0.1 (default port 3741)
                        instead of stdio
  -h, --help            Show this help
  -v, --version         Show the version

The budget is a record the model reports to, not an enforced ceiling: the
model has to call the budget tools. For enforcement, put the deuz meter proxy
in front of the provider.
`;

/** What {@link runLedgerCli} reads from and writes to. */
export interface LedgerCliIo {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  homedir: string;
  /** Human-readable output (help, version, startup line, errors). */
  log(line: string): void;
  /**
   * Resolves when the server should stop (stdin closed, a signal). Default:
   * stdin `end`/`close`, `SIGINT` or `SIGTERM`.
   */
  untilStopped?: () => Promise<void>;
}

function processStop(stdio: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    if (stdio) {
      process.stdin.once('end', done);
      process.stdin.once('close', done);
    }
  });
}

/**
 * Run the CLI: print help or the version, or serve until stopped. Returns the
 * process exit code; it never calls `process.exit` itself.
 */
export async function runLedgerCli(
  argv: readonly string[],
  io?: Partial<LedgerCliIo>,
): Promise<number> {
  const env = io?.env ?? process.env;
  const log = io?.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let command;
  try {
    command = parseLedgerArgs(argv, {
      env,
      platform: io?.platform ?? process.platform,
      homedir: io?.homedir ?? homedir(),
    });
  } catch (error) {
    if (error instanceof McpLedgerError) {
      log(`deuz-mcp-ledger: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (command.kind === 'help') {
    log(LEDGER_HELP);
    return 0;
  }
  if (command.kind === 'version') {
    log(MCP_LEDGER_VERSION);
    return 0;
  }

  const ledger = createMcpLedger({
    dataDir: command.dataDir,
    budget: command.budget,
    ...(command.namespace !== undefined ? { namespace: command.namespace } : {}),
  });
  const ceiling = [
    command.budget.usd !== undefined ? `$${command.budget.usd}` : undefined,
    command.budget.tokens !== undefined ? `${command.budget.tokens} tokens` : undefined,
  ]
    .filter(Boolean)
    .join(' + ');
  const summary = `data in ${command.dataDir}; budget ${ceiling ? `${ceiling} per ${command.budget.window.label}` : 'not set'} (advisory)`;
  try {
    await ledger.server.ready();
    if (command.http) {
      const http = await serveMcpLedgerHttp(ledger.server, { port: command.http.port });
      log(`deuz-mcp-ledger ${MCP_LEDGER_VERSION}: Streamable HTTP on ${http.url}; ${summary}`);
      await (io?.untilStopped ?? (() => processStop(false)))();
      await http.close();
    } else {
      const stdio = await serveMcpStdio(ledger.server);
      log(`deuz-mcp-ledger ${MCP_LEDGER_VERSION}: stdio; ${summary}`);
      await (io?.untilStopped ?? (() => processStop(true)))();
      await stdio.close();
    }
    return 0;
  } catch (error) {
    log(`deuz-mcp-ledger: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await ledger.close().catch(() => {});
  }
}
