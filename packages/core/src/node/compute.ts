/**
 * Node-only reference `ComputeSandbox` (1.8) — spawns model-authored code with
 * `node:child_process`. Ships as `@deuz-sdk/core/compute/node`.
 *
 * ⚠️  THIS IS NOT A SECURITY SANDBOX. It runs code as a child process of the
 * host with the host's own permissions. It exists so you can build and test a
 * CodeAct agent locally and so the seam has a working reference. For anything
 * that touches untrusted input or runs in production, back `ComputeSandbox`
 * with real isolation — Docker, E2B, Daytona, Fly Machines, gVisor, a microVM,
 * or a remote runner — which implement the SAME `runCode`/`runShell` contract.
 * Mitigations here (env allow-listing, output caps, timeouts, a command
 * allowlist) reduce blast radius; they are not isolation.
 */
import type {
  ComputeSandbox,
  CodeExecutionRequest,
  CodeExecutionResult,
  ShellExecutionRequest,
} from '../types/compute';

// Minimal node child_process shapes; `as string` specifiers keep tsup's dts
// builder from statically resolving node: (matches node/chat-store.ts).
interface Readable {
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  destroy(): void;
}
interface Writable {
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  once(event: 'drain', listener: () => void): void;
}
interface ChildProcessLike {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  on(event: 'exit' | 'close', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
}
interface ChildProcessModule {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
    },
  ): ChildProcessLike;
}

/** Minimal `node:process` shape (avoids referencing the ambient global in dts). */
interface NodeProcess {
  env: Record<string, string | undefined>;
  platform: string;
}

async function loadSpawn(): Promise<ChildProcessModule['spawn']> {
  try {
    const cp = (await import('node:child_process' as string)) as unknown as ChildProcessModule;
    return cp.spawn;
  } catch (err) {
    throw new Error(
      'createNodeSandbox requires a Node runtime (node:child_process). It is unavailable on the edge.',
      { cause: err },
    );
  }
}

let cachedProcess: NodeProcess | undefined;
async function loadProcess(): Promise<NodeProcess> {
  if (cachedProcess) return cachedProcess;
  cachedProcess = (await import('node:process' as string)) as unknown as NodeProcess;
  return cachedProcess;
}

/** language id → how to invoke an interpreter with an inline program. */
export interface Interpreter {
  command: string;
  /** Build argv from the code string (default backends use `-c` / `-e`). */
  args: (code: string) => string[];
}

const DEFAULT_INTERPRETERS: Record<string, Interpreter> = {
  python: { command: 'python3', args: (code) => ['-c', code] },
  python3: { command: 'python3', args: (code) => ['-c', code] },
  bash: { command: 'bash', args: (code) => ['-c', code] },
  sh: { command: 'sh', args: (code) => ['-c', code] },
  shell: { command: 'bash', args: (code) => ['-c', code] },
  javascript: { command: 'node', args: (code) => ['-e', code] },
  js: { command: 'node', args: (code) => ['-e', code] },
  node: { command: 'node', args: (code) => ['-e', code] },
};

export interface NodeSandboxOptions {
  /** Working directory for spawned processes. Default: the host process cwd. */
  cwd?: string;
  /** Default wall-clock timeout in ms (per run). Default 30_000. */
  defaultTimeoutMs?: number;
  /** Max captured bytes per stream before truncation. Default 1_000_000. */
  maxOutputBytes?: number;
  /** Language → interpreter overrides (merged over the built-ins). */
  interpreters?: Record<string, Interpreter>;
  /** Restrict `runCode` to these language ids (others error). Default: all built-ins. */
  allowedLanguages?: string[];
  /** Restrict `runShell` first-token to these commands. Omit = allow shell freely (DEV ONLY). */
  allowedCommands?: string[];
  /** Pass the host `process.env` through to children. Default false (leak-safe). */
  inheritEnv?: boolean;
}

/** Assemble the child env: a minimal PATH (unless `inheritEnv`) plus request env. */
function buildEnv(
  hostEnv: Record<string, string | undefined>,
  inheritEnv: boolean,
  requestEnv: Record<string, string> | undefined,
): Record<string, string | undefined> {
  if (inheritEnv) return { ...hostEnv, ...requestEnv };
  const base: Record<string, string | undefined> = {
    PATH: hostEnv.PATH,
    PATHEXT: hostEnv.PATHEXT,
    SystemRoot: hostEnv.SystemRoot,
    HOME: hostEnv.HOME,
    USERPROFILE: hostEnv.USERPROFILE,
    TEMP: hostEnv.TEMP,
    TMP: hostEnv.TMP,
  };
  return { ...base, ...requestEnv };
}

interface ExecInput {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  /**
   * The child's stdin. `undefined` means none at all: the null device, so a read
   * sees EOF at once. A string, `''` included, is a pipe that receives exactly
   * these UTF-8 bytes and is then closed. Neither keeps stdin open; interactive
   * or streamed input would be a separate, explicit mode, not a value of this.
   */
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** Bytes per stdin write: one OS pipe buffer (64 KiB on Linux and Windows). */
const STDIN_CHUNK_BYTES = 64 * 1024;

/**
 * How long a killed run (timeout or abort) waits for its output pipes to close
 * before it stops waiting. The process we spawned dies at once, but a program IT
 * started inherits stdout/stderr and can hold them open: every external command
 * under `cmd.exe /c`, or `a` in `bash -c 'a && b'`. 'close' then waited for that
 * program to exit on its own, so the timeout bounded nothing.
 */
const KILL_GRACE_MS = 500;

/**
 * Feed `text` to the child's stdin as UTF-8, then close it (EOF).
 *
 * The child may stop reading at any moment: it exits without reading, crashes,
 * closes its stdin, or the timeout/abort kills it. Its end of the pipe closes
 * and the pending write fails asynchronously, with EPIPE on POSIX and 'write
 * EOF' on Windows. With no 'error' listener that failure is an UNCAUGHT
 * exception: once the input outgrew the 64 KiB pipe buffer it took the HOST
 * process down and the caller's try/catch never ran (F03). It is not an
 * execution error (the exit code and output already say what happened), so it
 * is absorbed here and writing stops. The listener stays for the stream's whole
 * life: a late error with nobody listening would crash the host just the same.
 *
 * Bytes go out one pipe buffer at a time, waiting for 'drain', so a large input
 * is not queued into the stream at once and nothing more is written after the
 * child has stopped reading.
 */
function writeStdin(stdin: Writable, text: string): void {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  stdin.on('error', stop);
  stdin.on('close', stop);
  const pump = (): void => {
    while (!stopped && offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, offset + STDIN_CHUNK_BYTES);
      offset += chunk.byteLength;
      if (!stdin.write(chunk)) {
        stdin.once('drain', pump);
        return;
      }
    }
    if (!stopped) stdin.end();
  };
  pump();
}

/**
 * Spawn one process, capture bounded stdout/stderr, honor timeout + abort.
 *
 * Settles exactly once, on whichever comes first: the child's 'close' (all
 * output read), a spawn 'error', or the kill grace after a timeout/abort. That
 * releases both timers and the caller's 'abort' listener and closes our ends of
 * the pipes, so nothing of the run keeps the host alive afterwards.
 */
async function execProcess(
  spawn: ChildProcessModule['spawn'],
  input: ExecInput,
): Promise<CodeExecutionResult> {
  if (input.signal?.aborted) {
    return { stdout: '', stderr: 'Aborted before start.', exitCode: null, timedOut: true };
  }
  const start = Date.now();
  return await new Promise<CodeExecutionResult>((resolve) => {
    let child: ChildProcessLike;
    try {
      child = spawn(input.command, input.args, {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        env: input.env,
        // No stdin given: the null device, not a pipe nobody ever closes (a
        // program reading to EOF used to wait out the whole timeout, F10).
        stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
      });
      return;
    }

    const outChunks: Uint8Array[] = [];
    const errChunks: Uint8Array[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    /** From 'exit', for a killed run that settles before 'close' comes. */
    let exitCode: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const collect = (chunks: Uint8Array[], countRef: 'out' | 'err') => (chunk: Uint8Array) => {
      const current = countRef === 'out' ? outBytes : errBytes;
      if (current >= input.maxOutputBytes) return;
      const room = input.maxOutputBytes - current;
      const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      if (countRef === 'out') outBytes += slice.byteLength;
      else errBytes += slice.byteLength;
    };
    child.stdout?.on('data', collect(outChunks, 'out'));
    child.stderr?.on('data', collect(errChunks, 'err'));

    const decoder = new TextDecoder();
    const concat = (chunks: Uint8Array[]): string => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return decoder.decode(merged);
    };

    // Timeout and abort both kill the child and report `timedOut: true`.
    const kill = (): void => {
      if (settled || timedOut) return;
      timedOut = true;
      child.kill('SIGKILL');
      graceTimer = setTimeout(() => finish(exitCode), KILL_GRACE_MS);
    };
    const timer = setTimeout(kill, input.timeoutMs);
    input.signal?.addEventListener('abort', kill, { once: true });

    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      input.signal?.removeEventListener('abort', kill);
      // Close our ends of the pipes. After 'close' they are closed already; after
      // a spawn error or the kill grace the far side may still hold them open,
      // and an open pipe keeps the host's event loop alive.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        stdout: concat(outChunks),
        stderr: error ? `${concat(errChunks)}${error.message}` : concat(errChunks),
        exitCode: code,
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - start,
      });
    };

    child.on('error', (err) => finish(null, err));
    child.on('exit', (code) => {
      exitCode = code;
    });
    child.on('close', (code) => finish(code));

    if (input.stdin !== undefined && child.stdin) writeStdin(child.stdin, input.stdin);
  });
}

/**
 * A `runShell` request as this backend reads it: `stdin` works exactly as on
 * `runCode`, whether or not the seam's `ShellExecutionRequest` declares it.
 */
type ShellRequest = ShellExecutionRequest & { stdin?: string };

/**
 * A `node:child_process`-backed reference sandbox. See the file header: this is
 * for local development and the seam contract, NOT production isolation.
 *
 * `runCode` and `runShell` take the same `stdin`: omitted, the child's stdin is
 * the null device (a read sees EOF at once); a string, `''` included, is piped
 * as UTF-8 and then closed. Neither offers interactive input. A timeout or abort
 * kills the spawned process and settles within a short grace period even when a
 * program it started still holds the output pipes; that program is NOT killed
 * (one more reason this is not an isolation boundary).
 */
export function createNodeSandbox(options: NodeSandboxOptions = {}): ComputeSandbox {
  const interpreters = { ...DEFAULT_INTERPRETERS, ...options.interpreters };
  const timeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  const inheritEnv = options.inheritEnv ?? false;

  return {
    async runCode(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
      if (options.allowedLanguages && !options.allowedLanguages.includes(request.language)) {
        return {
          stdout: '',
          stderr: `Language '${request.language}' is not allowed by this sandbox.`,
          exitCode: null,
        };
      }
      const interpreter = interpreters[request.language];
      if (!interpreter) {
        return {
          stdout: '',
          stderr: `No interpreter configured for language '${request.language}'. Known: ${Object.keys(interpreters).join(', ')}.`,
          exitCode: null,
        };
      }
      const [spawn, proc] = await Promise.all([loadSpawn(), loadProcess()]);
      return execProcess(spawn, {
        command: interpreter.command,
        args: interpreter.args(request.code),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: buildEnv(proc.env, inheritEnv, request.env),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        timeoutMs: request.timeoutMs ?? timeoutMs,
        maxOutputBytes,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },

    async runShell(request: ShellRequest): Promise<CodeExecutionResult> {
      if (options.allowedCommands) {
        const firstToken = request.command.trim().split(/\s+/)[0] ?? '';
        if (!options.allowedCommands.includes(firstToken)) {
          return {
            stdout: '',
            stderr: `Command '${firstToken}' is not in the sandbox allowlist.`,
            exitCode: null,
          };
        }
      }
      const [spawn, proc] = await Promise.all([loadSpawn(), loadProcess()]);
      const isWindows = proc.platform === 'win32';
      const shellCommand = isWindows ? 'cmd.exe' : 'bash';
      const shellArgs = isWindows ? ['/c', request.command] : ['-c', request.command];
      const cwd = request.cwd ?? options.cwd;
      return execProcess(spawn, {
        command: shellCommand,
        args: shellArgs,
        ...(cwd !== undefined ? { cwd } : {}),
        env: buildEnv(proc.env, inheritEnv, request.env),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        timeoutMs: request.timeoutMs ?? timeoutMs,
        maxOutputBytes,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },
  };
}
