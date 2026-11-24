#!/usr/bin/env node
/**
 * `deuz-mcp-ledger` / `npx @deuz-sdk/mcp-ledger`: serve the ledger over stdio
 * (or loopback HTTP with `--http`). See `--help`.
 */
import { runLedgerCli } from './run';

runLedgerCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Open handles (a WAL checkpoint timer, a half-closed stdin) must not keep a stopped server alive.
    if (code === 0) setTimeout(() => process.exit(0), 250).unref();
  },
  (error: unknown) => {
    process.stderr.write(
      `deuz-mcp-ledger: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
