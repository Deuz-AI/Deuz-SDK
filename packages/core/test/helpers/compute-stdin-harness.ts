/**
 * compute-stdin-harness.ts — runs ONE `createNodeSandbox().runCode()` scenario
 * in a throwaway node process and prints a JSON report as its last stdout line.
 *
 * F03: when a child stops reading a large stdin (it exits early, crashes, closes
 * the pipe, or the timeout/abort kills it), the pending write fails ('write EOF'
 * on Windows, EPIPE on POSIX). With no 'error' listener on the stream that is an
 * UNCAUGHT exception: it kills the HOST, and the caller's try/catch never runs.
 * Inside a vitest worker a regression would take the whole test file down, so
 * `test/compute.test.ts` bundles this file with esbuild and spawns it once per
 * scenario. A regression then shows up as a non-zero exit code with the stack on
 * stderr — never as a dead worker.
 *
 * Deliberately NO uncaughtException / unhandledRejection handler and NO
 * `process.exit()`: Node's defaults turn either into exit code 1, and a timer or
 * handle the sandbox forgot to release keeps this process alive past the test's
 * deadline. Both are failures the test can see.
 */
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createNodeSandbox } from '../../src/node/compute';
import type { CodeExecutionRequest } from '../../src/types/compute';

/** Bigger than any OS pipe buffer (64 KiB on Linux and Windows): the write is still pending when the child stops reading. */
const BIG = 'x'.repeat(2 * 1024 * 1024);

/**
 * Multi-byte on purpose: `ğ` is 2 UTF-8 bytes, `😀` is 4 (a surrogate pair in a
 * JS string), so a writer that splits the input on the wrong boundary corrupts it.
 */
const ECHO_INPUT = 'ğ😀x'.repeat(300_000);

/** Reads stdin to EOF and prints `<byteCount> <sha256>`. */
const READ_ALL_AND_HASH =
  "const h=require('crypto').createHash('sha256');let n=0;" +
  "process.stdin.on('data',d=>{n+=d.length;h.update(d)});" +
  "process.stdin.on('end',()=>process.stdout.write(n+' '+h.digest('hex')))";

/** Never reads stdin and never exits on its own. */
const IDLE_FOREVER = 'setInterval(()=>{},1000)';

interface Scenario {
  request: Omit<CodeExecutionRequest, 'signal'>;
  /** Abort the run this many ms after it starts. */
  abortAfterMs?: number;
}

/**
 * Every scenario except `timeout` runs with a 20 s timeout: if the sandbox left
 * its timer armed after settling, this process would outlive the test deadline.
 */
const scenarios: Record<string, Scenario> = {
  // The F03 trigger: the child exits without reading a byte.
  'early-exit': {
    request: { language: 'node', code: 'process.exit(0)', stdin: BIG, timeoutMs: 20_000 },
  },
  'nonzero-exit': {
    request: { language: 'node', code: 'process.exit(3)', stdin: BIG, timeoutMs: 20_000 },
  },
  // The child closes its end of the pipe but keeps running for a while.
  'stdin-closed-early': {
    request: {
      language: 'node',
      code: 'process.stdin.destroy();setTimeout(()=>process.exit(0),200)',
      stdin: BIG,
      timeoutMs: 20_000,
    },
  },
  // The timeout kills the child while the write is still pending.
  timeout: { request: { language: 'node', code: IDLE_FOREVER, stdin: BIG, timeoutMs: 300 } },
  // A caller abort does the same.
  abort: {
    request: { language: 'node', code: IDLE_FOREVER, stdin: BIG, timeoutMs: 20_000 },
    abortAfterMs: 200,
  },
  // The interpreter does not exist: spawn fails and nothing reads the pipe.
  'spawn-failure': { request: { language: 'ghost', code: '', stdin: BIG, timeoutMs: 20_000 } },
  // Control: a child that reads everything receives every byte, in order.
  echo: {
    request: { language: 'node', code: READ_ALL_AND_HASH, stdin: ECHO_INPUT, timeoutMs: 20_000 },
  },
};

export interface HarnessReport {
  scenario: string;
  outcome: 'resolved' | 'rejected';
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  hasDuration?: boolean;
  error?: string;
  /** `'abort'` listeners still registered on the caller's signal after the run settled. */
  abortListeners: number;
  /** For `echo`: what the child must print if it received the input intact. */
  expected?: string;
  wallMs: number;
}

const name = process.argv[2] ?? '';
const scenario = scenarios[name];
if (!scenario)
  throw new Error(`Unknown scenario '${name}'. Known: ${Object.keys(scenarios).join(', ')}.`);

const sandbox = createNodeSandbox({
  interpreters: {
    ghost: { command: 'deuz-no-such-interpreter-f03', args: (code) => ['-e', code] },
  },
});
const controller = new AbortController();
if (scenario.abortAfterMs !== undefined) {
  setTimeout(() => controller.abort(), scenario.abortAfterMs);
}
const t0 = Date.now();
let report: HarnessReport;
try {
  const result = await sandbox.runCode({ ...scenario.request, signal: controller.signal });
  report = {
    scenario: name,
    outcome: 'resolved',
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    stdout: result.stdout.slice(0, 200),
    stderr: result.stderr.slice(0, 400),
    hasDuration: typeof result.durationMs === 'number',
    abortListeners: getEventListeners(controller.signal, 'abort').length,
    wallMs: Date.now() - t0,
  };
} catch (error) {
  report = {
    scenario: name,
    outcome: 'rejected',
    error: error instanceof Error ? error.message : String(error),
    abortListeners: getEventListeners(controller.signal, 'abort').length,
    wallMs: Date.now() - t0,
  };
}
if (name === 'echo') {
  const bytes = new TextEncoder().encode(ECHO_INPUT);
  report.expected = `${bytes.byteLength} ${createHash('sha256').update(bytes).digest('hex')}`;
}
process.stdout.write(`\n${JSON.stringify(report)}\n`);
