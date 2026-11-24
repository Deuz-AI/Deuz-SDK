#!/usr/bin/env node
/**
 * The `deuz` binary. See `deuz --help`; the body is `runCli` in ./run.
 */
import { runCli } from './run';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Open handles (a SQLite WAL timer, a half-closed stdin) must not keep a finished command alive.
    setTimeout(() => process.exit(code), 250).unref();
  },
  (error: unknown) => {
    process.stderr.write(`deuz: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
