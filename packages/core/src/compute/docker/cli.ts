/**
 * Running the Docker CLI (2.4): always `shell: false` (an argument is never
 * parsed by a shell, so a path or a command with spaces, quotes or `&` is
 * passed as it is), `windowsHide`, the host's environment (DOCKER_HOST,
 * DOCKER_CONTEXT and the config stay in effect), bounded output, and a
 * timeout. A failure is classified once, here: a daemon that cannot be
 * reached is `docker_unavailable`, a missing container or file `not_found`.
 */
import { DockerSandboxError } from './errors';

interface ReadableLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  destroy(): void;
}
interface WritableLike {
  on(event: 'error', listener: (error: Error) => void): void;
  end(chunk?: Uint8Array): void;
  destroy(): void;
}
export interface ChildLike {
  pid?: number;
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  stdin: WritableLike | null;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: string): boolean;
  unref(): void;
}
export interface SpawnOptions {
  stdio: ('ignore' | 'pipe')[];
  shell: false;
  windowsHide: true;
  detached?: boolean;
  env?: Record<string, string | undefined>;
}
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;

let spawnPromise: Promise<Spawn> | undefined;

/** `node:child_process` spawn, imported on first use. */
export function loadSpawn(): Promise<Spawn> {
  spawnPromise ??= (import('node:child_process' as string) as Promise<{ spawn: Spawn }>).then(
    (module) => module.spawn,
    (error: unknown) => {
      spawnPromise = undefined;
      throw new Error('@deuz-sdk/core/compute/docker requires Node (node:child_process).', {
        cause: error,
      });
    },
  );
  return spawnPromise;
}

/** Where the CLI is and the global arguments that go before every subcommand. */
export interface DockerCli {
  dockerPath: string;
  dockerArgs: readonly string[];
}

export interface DockerRunOptions {
  /** Written to the CLI's stdin, then closed. Omitted, stdin is the null device. */
  stdin?: Uint8Array;
  /** Default 120 s; 0 waits for ever. Past it the CLI is killed: `docker_unavailable`. */
  timeoutMs?: number;
  /** stdout kept at most (default 16 MiB); past it the CLI is killed and `overflow` set. */
  maxStdoutBytes?: number;
  /** Takes stdout as it comes instead of keeping it; return false to stop (the CLI is killed). */
  onStdout?(chunk: Uint8Array): boolean | void;
  /** Takes stderr as it comes, besides the kept tail. */
  onStderr?(chunk: Uint8Array): void;
  /** Kills the CLI when it fires (the result has `stopped`). */
  signal?: AbortSignal;
}

export interface DockerRunResult {
  /** The exit code; null when the CLI was killed. */
  code: number | null;
  stdout: Uint8Array;
  /** The last 64 KiB of stderr. */
  stderr: string;
  /** `onStdout` or the signal ended the run. */
  stopped: boolean;
  overflow: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;

const UNREACHABLE = [
  /cannot connect to the docker daemon/i,
  /error during connect/i,
  /failed to connect to the docker api/i,
  /is the docker daemon running/i,
  /docker daemon is not running/i,
  /docker desktop is (?:not running|unable to start|starting)/i,
  /dial (?:unix|tcp)[^\n]*(?:connection refused|no such file)/i,
];
const NOT_FOUND = [/no such container/i, /no such object/i, /could not find the file/i];
const NO_IMAGE = [/no such image/i];

/** The subcommand of an argv (`container inspect` → `inspect`). */
export function subcommandOf(args: readonly string[]): string {
  return (
    args[0] === 'container' || args[0] === 'image' || args[0] === 'volume'
      ? `${args[0]} ${args[1] ?? ''}`
      : (args[0] ?? '')
  ).trim();
}

/** The classified error for a CLI run that exited non-zero. */
export function dockerFailure(
  args: readonly string[],
  result: DockerRunResult,
): DockerSandboxError {
  const command = subcommandOf(args);
  const stderr = result.stderr.trim();
  const options = { command, ...(result.code !== null ? { exitCode: result.code } : {}) };
  const detail = stderr || `exit code ${result.code}`;
  if (UNREACHABLE.some((pattern) => pattern.test(stderr)))
    return new DockerSandboxError(
      'docker_unavailable',
      `The Docker daemon is unreachable (docker ${command}): ${detail}`,
      options,
    );
  if (NO_IMAGE.some((pattern) => pattern.test(stderr)))
    return new DockerSandboxError('image_not_found', `docker ${command}: ${detail}`, options);
  if (NOT_FOUND.some((pattern) => pattern.test(stderr)))
    return new DockerSandboxError('not_found', `docker ${command}: ${detail}`, options);
  return new DockerSandboxError('docker_failed', `docker ${command} failed: ${detail}`, options);
}

/**
 * Runs `docker <dockerArgs> <args>` and resolves with what it did; a non-zero
 * exit is not an error here. Throws `docker_unavailable` when the CLI cannot
 * be started or the timeout passes.
 */
export async function execDocker(
  cli: DockerCli,
  args: readonly string[],
  options: DockerRunOptions = {},
): Promise<DockerRunResult> {
  const spawn = await loadSpawn();
  const command = subcommandOf(args);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  return await new Promise<DockerRunResult>((resolve, reject) => {
    let child: ChildLike;
    try {
      child = spawn(cli.dockerPath, [...cli.dockerArgs, ...args], {
        stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new DockerSandboxError(
          'docker_unavailable',
          `The Docker CLI (${cli.dockerPath}) could not be started: ${(error as Error).message}`,
          { command, cause: error },
        ),
      );
      return;
    }
    const stdout: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    const stderrDecoder = new TextDecoder();
    let stopped = false;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs)
        : undefined;
    const onAbort = (): void => stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) stop();

    child.stdout?.on('data', (chunk) => {
      if (stopped) return;
      if (options.onStdout) {
        if (options.onStdout(chunk) === false) stop();
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdout) {
        overflow = true;
        stop();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      options.onStderr?.(chunk);
      stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
    });
    if (child.stdin) {
      // The CLI may exit before reading all of stdin (a refused copy): EPIPE is
      // not this run's error, its exit code is.
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin);
    }

    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(
          new DockerSandboxError(
            'docker_unavailable',
            `The Docker CLI (${cli.dockerPath}) could not be started: ${error.message}`,
            { command, cause: error },
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new DockerSandboxError(
            'docker_unavailable',
            `docker ${command} did not answer within ${timeoutMs} ms`,
            { command },
          ),
        );
        return;
      }
      const total = stdout.reduce((n, part) => n + part.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of stdout) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      resolve({ code, stdout: merged, stderr, stopped, overflow });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

/** Runs the CLI and throws the classified error on a non-zero exit. */
export async function docker(
  cli: DockerCli,
  args: readonly string[],
  options: DockerRunOptions = {},
): Promise<DockerRunResult> {
  const result = await execDocker(cli, args, options);
  if (result.code !== 0 && !result.stopped) throw dockerFailure(args, result);
  return result;
}

const textDecoder = new TextDecoder();

/** stdout as trimmed text. */
export function stdoutText(result: DockerRunResult): string {
  return textDecoder.decode(result.stdout).trim();
}
