import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { codeActTool, shellTool, codeActSystemPrompt } from '../src/compute';
import { createNodeSandbox } from '../src/node/compute';
import type {
  ComputeSandbox,
  CodeExecutionResult,
  ShellExecutionRequest,
} from '../src/types/compute';
import type { ToolExecuteContext } from '../src/types/tool';
import type { HarnessReport } from './helpers/compute-stdin-harness';

const ctx: ToolExecuteContext = { toolCallId: 'call_1', messages: [] };

describe('codeActTool (edge wrapper over the seam)', () => {
  it('drives runCode, returns stdout/stderr/exitCode and strips artifact bytes', async () => {
    let seen: unknown;
    const sandbox: ComputeSandbox = {
      async runCode(req) {
        seen = req;
        return {
          stdout: 'hello',
          stderr: '',
          exitCode: 0,
          durationMs: 12,
          artifacts: [{ path: 'out.png', bytes: new Uint8Array([1, 2]), mime: 'image/png' }],
        } satisfies CodeExecutionResult;
      },
    };
    const tools = codeActTool(sandbox, { name: 'runCode', timeoutMs: 5000 });
    const out = (await tools.runCode!.execute!({ language: 'python', code: 'print(1)' }, ctx)) as {
      stdout: string;
      exitCode: number;
      artifacts: { path: string; mime: string }[];
    };
    expect(seen).toMatchObject({ language: 'python', code: 'print(1)', timeoutMs: 5000 });
    expect(out.stdout).toBe('hello');
    expect(out.exitCode).toBe(0);
    expect(out.artifacts).toEqual([{ path: 'out.png', mime: 'image/png' }]); // bytes stripped
  });

  it('caps stdout/stderr to maxOutputChars with a truncation marker', async () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: 'x'.repeat(50), stderr: '', exitCode: 0 };
      },
    };
    const tools = codeActTool(sandbox, { maxOutputChars: 10 });
    const out = (await tools.runCode!.execute!({ language: 'js', code: '1' }, ctx)) as {
      stdout: string;
    };
    expect(out.stdout.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out.stdout).toContain('truncated');
  });

  it('offers the language enum when restricted', () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const tools = codeActTool(sandbox, { languages: ['python', 'bash'] });
    const params = tools.runCode!.parameters as {
      properties: { language: { enum?: string[] } };
    };
    expect(params.properties.language.enum).toEqual(['python', 'bash']);
    expect(codeActSystemPrompt()).toContain('writing');
  });
});

describe('shellTool', () => {
  it('throws (self-heals in the loop) when the sandbox has no runShell', async () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const tools = shellTool(sandbox);
    await expect(tools.runShell!.execute!({ command: 'ls' }, ctx)).rejects.toThrow(
      /does not support/,
    );
  });

  it('drives runShell when present', async () => {
    const sandbox: ComputeSandbox = {
      async runCode() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async runShell(req) {
        return { stdout: `ran ${req.command}`, stderr: '', exitCode: 0 };
      },
    };
    const tools = shellTool(sandbox, { needsApproval: true });
    expect(tools.runShell!.needsApproval).toBe(true);
    const out = (await tools.runShell!.execute!({ command: 'echo hi' }, ctx)) as { stdout: string };
    expect(out.stdout).toBe('ran echo hi');
  });
});

describe('createNodeSandbox (reference; spawns real node)', () => {
  it('runs javascript and captures stdout + exit code', async () => {
    const sandbox = createNodeSandbox();
    const res = await sandbox.runCode({
      language: 'javascript',
      code: 'process.stdout.write("ok:" + (1 + 2))',
    });
    expect(res.stdout).toBe('ok:3');
    expect(res.exitCode).toBe(0);
  });

  it('rejects a disallowed language without spawning', async () => {
    const sandbox = createNodeSandbox({ allowedLanguages: ['javascript'] });
    const res = await sandbox.runCode({ language: 'python', code: 'print(1)' });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toContain('not allowed');
  });

  it('enforces the shell command allowlist', async () => {
    const sandbox = createNodeSandbox({ allowedCommands: ['echo'] });
    const res = await sandbox.runShell!({ command: 'rm -rf /' });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toContain('allowlist');
  });

  it('kills a run that exceeds the timeout', async () => {
    const sandbox = createNodeSandbox({ defaultTimeoutMs: 300 });
    const res = await sandbox.runCode({
      language: 'javascript',
      code: 'setTimeout(() => {}, 10000)',
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });
});

describe('createNodeSandbox — output cut at maxOutputBytes says so (H4)', () => {
  // Before 2.4 the bytes past maxOutputBytes were dropped silently: a caller
  // could not tell a 10-byte program from a 10 MB one.
  it('flags the stream that was cut and keeps the head of it', async () => {
    const res = await createNodeSandbox({ maxOutputBytes: 10 }).runCode({
      language: 'node',
      code: "process.stdout.write('x'.repeat(50)); process.stderr.write('short')",
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('x'.repeat(10));
    expect(res.stderr).toBe('short');
    expect(res.truncated).toEqual({ stdout: true, stderr: false });
  });

  it('flags stderr alone when only stderr overflows', async () => {
    const res = await createNodeSandbox({ maxOutputBytes: 4 }).runCode({
      language: 'node',
      code: "process.stdout.write('ok'); process.stderr.write('e'.repeat(9))",
      timeoutMs: 5_000,
    });
    expect(res.stderr).toBe('eeee');
    expect(res.truncated).toEqual({ stdout: false, stderr: true });
  });

  it('leaves the field off when nothing was cut, as in 2.3', async () => {
    const res = await createNodeSandbox({ maxOutputBytes: 10 }).runCode({
      language: 'node',
      code: "process.stdout.write('x'.repeat(10))",
      timeoutMs: 5_000,
    });
    expect(res.stdout).toBe('x'.repeat(10));
    expect(res).not.toHaveProperty('truncated');
  });
});

/** Reads stdin to EOF, then prints `eof <byteCount>`. */
const WAIT_FOR_EOF =
  "let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>process.stdout.write('eof '+n))";

/**
 * Scripts for `runShell`, run as `node <file>` from their own directory: a shell
 * command line with no quotes means the same thing to `cmd.exe /c` and `bash -c`.
 */
let scripts: string;
beforeAll(async () => {
  scripts = await mkdtemp(join(tmpdir(), 'deuz-compute-'));
  await writeFile(join(scripts, 'wait-eof.cjs'), WAIT_FOR_EOF);
  await writeFile(join(scripts, 'echo.cjs'), 'process.stdin.pipe(process.stdout)');
  // Holds stdout open well past any timeout below, writing so it dies of EPIPE
  // as soon as nobody reads the pipe any more, and exits on its own regardless.
  await writeFile(
    join(scripts, 'holder.cjs'),
    "process.stdout.write('holding');setInterval(()=>process.stdout.write('.'),100);setTimeout(()=>process.exit(0),8000)",
  );
});
afterAll(async () => {
  await rm(scripts, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('createNodeSandbox — stdin when none (or an empty one) is given (F10)', () => {
  // Before 2.3 the child got an open stdin pipe whenever `stdin` was undefined,
  // so anything that reads to EOF (`sort`, `cat`, `node` reading a script from
  // stdin) waited for the full timeout: 3 s here, 30 s by default.
  it.each([
    ['undefined (no stdin at all)', undefined, 'eof 0'],
    ["'' (an empty input)", '', 'eof 0'],
    ["'hello'", 'hello', 'eof 5'],
  ])('runCode, stdin %s: a program that reads to EOF finishes', async (_label, stdin, expected) => {
    const res = await createNodeSandbox().runCode({
      language: 'node',
      code: WAIT_FOR_EOF,
      timeoutMs: 3_000,
      ...(stdin !== undefined ? { stdin } : {}),
    });
    expect(res.timedOut).not.toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(expected);
  });

  it("keeps undefined and '' apart: no stdin is the null device, '' is an empty pipe", async () => {
    // The distinction a program can actually observe. Interactive input would be
    // a third, explicit mode; neither of these leaves stdin open.
    const code =
      "process.stdout.write(require('fs').fstatSync(0).isCharacterDevice()?'null-device':'pipe')";
    const sandbox = createNodeSandbox();
    expect((await sandbox.runCode({ language: 'node', code, timeoutMs: 3_000 })).stdout).toBe(
      'null-device',
    );
    expect(
      (await sandbox.runCode({ language: 'node', code, stdin: '', timeoutMs: 3_000 })).stdout,
    ).toBe('pipe');
  });

  it('runShell forwards stdin to the command', async () => {
    const request: ShellExecutionRequest = {
      command: 'node echo.cjs',
      cwd: scripts,
      stdin: 'b\na\nçğ 😀\n',
      timeoutMs: 3_000,
    };
    const res = await createNodeSandbox().runShell!(request);
    expect(res.timedOut).not.toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('b\na\nçğ 😀\n');
  });

  it('runShell without stdin: a command that reads to EOF finishes', async () => {
    const res = await createNodeSandbox().runShell!({
      command: 'node wait-eof.cjs',
      cwd: scripts,
      timeoutMs: 3_000,
    });
    expect(res.timedOut).not.toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('eof 0');
  });
});

describe('createNodeSandbox — timeout and abort stay bounded when a grandchild holds the pipes', () => {
  // `cmd.exe /c` always runs the program as ITS child, and `bash -c 'a && b'`
  // has to fork `a` to wait for it. Killing the shell then leaves `node
  // holder.cjs` holding stdout/stderr, so the child's 'close' did not come until
  // the holder exited on its own: the timeout bounded nothing (observed on
  // Windows: a 1 s timeout returned after 5.1 s, when `ping -n 6` finished).
  const command = 'node holder.cjs && echo done';

  it('a timeout settles promptly instead of waiting for the grandchild', async () => {
    const t0 = Date.now();
    const res = await createNodeSandbox().runShell!({ command, cwd: scripts, timeoutMs: 1_000 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 15_000);

  it('an abort settles promptly instead of waiting for the grandchild', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_000);
    const t0 = Date.now();
    const res = await createNodeSandbox().runShell!({
      command,
      cwd: scripts,
      timeoutMs: 20_000,
      signal: controller.signal,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 15_000);
});

/**
 * F03 runs in a SEPARATE node process (`test/helpers/compute-stdin-harness.ts`,
 * bundled here with esbuild): the failure mode is an uncaught exception that
 * kills the host, which inside this worker would take the whole file down.
 */
describe('createNodeSandbox — a child that stops reading stdin cannot take the host down (F03)', () => {
  /** Generous: a run settles in well under a second; a leaked 20 s timer cannot hide. */
  const HARNESS_DEADLINE_MS = 10_000;
  let harness: string;

  beforeAll(async () => {
    harness = join(scripts, 'compute-stdin-harness.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./helpers/compute-stdin-harness.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: harness,
      logLevel: 'silent',
    });
  });

  interface HarnessRun {
    code: number | null;
    killedByDeadline: boolean;
    report: HarnessReport | undefined;
    stderr: string;
  }

  /** Run one scenario in its own node process. Never rejects. */
  async function runHarness(scenario: string): Promise<HarnessRun> {
    const child = spawn(process.execPath, [harness, scenario], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    let killedByDeadline = false;
    const deadline = setTimeout(() => {
      killedByDeadline = true;
      child.kill('SIGKILL');
    }, HARNESS_DEADLINE_MS);
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', (exitCode) => resolve(exitCode));
    });
    clearTimeout(deadline);
    const last = stdout.trim().split(/\r?\n/).pop() ?? '';
    let report: HarnessReport | undefined;
    try {
      report = JSON.parse(last) as HarnessReport;
    } catch {
      report = undefined;
    }
    return { code, killedByDeadline, report, stderr };
  }

  it.each<[string, Partial<HarnessReport>]>([
    // The F03 trigger: a 2 MiB stdin and a child that exits without reading it.
    // On Windows the pending write failed with 'write EOF' (deterministic above
    // 64 KiB); on Linux the same write fails with EPIPE.
    ['early-exit', { exitCode: 0, timedOut: false }],
    ['nonzero-exit', { exitCode: 3, timedOut: false }],
    ['stdin-closed-early', { exitCode: 0, timedOut: false }],
    ['timeout', { exitCode: null, timedOut: true }],
    ['abort', { exitCode: null, timedOut: true }],
    ['spawn-failure', { exitCode: null, timedOut: false }],
    ['echo', { exitCode: 0, timedOut: false }],
  ])(
    '%s: the host survives, the run settles once and releases its timer and listener',
    async (scenario, expected) => {
      const run = await runHarness(scenario);
      expect(
        run.killedByDeadline,
        `the harness was still running after ${HARNESS_DEADLINE_MS} ms: a timer or handle leaked\n${run.stderr}`,
      ).toBe(false);
      expect(run.code, `the host process died:\n${run.stderr}`).toBe(0);
      expect(run.report, `no report on stdout:\n${run.stderr}`).toBeDefined();
      const report = run.report!;
      expect(report).toMatchObject({ scenario, outcome: 'resolved', hasDuration: true });
      expect(report).toMatchObject(expected);
      // The caller's signal outlives the run: its 'abort' listener must not.
      expect(report.abortListeners).toBe(0);
      if (scenario === 'spawn-failure') expect(report.stderr).toMatch(/ENOENT/);
      // Every byte arrived, in order: backpressure did not drop or split anything.
      if (scenario === 'echo') expect(report.stdout).toBe(report.expected);
    },
    20_000,
  );
});
