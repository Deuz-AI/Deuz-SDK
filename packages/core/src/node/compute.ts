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
}
interface Writable {
  write(chunk: string): void;
  end(): void;
}
interface ChildProcessLike {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
}
interface ChildProcessModule {
  spawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
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
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** Spawn one process, capture bounded stdout/stderr, honor timeout + abort. */
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

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: concat(outChunks),
        stderr: concat(errChunks),
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - start,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: concat(outChunks),
        stderr: `${concat(errChunks)}${err.message}`,
        exitCode: null,
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - start,
      });
    });
    child.on('close', (code) => finish(code));

    if (input.stdin !== undefined && child.stdin) {
      child.stdin.write(input.stdin);
      child.stdin.end();
    }
  });
}

/**
 * A `node:child_process`-backed reference sandbox. See the file header: this is
 * for local development and the seam contract, NOT production isolation.
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

    async runShell(request: ShellExecutionRequest): Promise<CodeExecutionResult> {
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
        timeoutMs: request.timeoutMs ?? timeoutMs,
        maxOutputBytes,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },
  };
}
