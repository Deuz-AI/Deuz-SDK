/**
 * `@deuz-sdk/core/acp/stdio` (2.5) — the Agent Client Protocol's stdio
 * transport for Node: serve a Deuz agent on the process's stdin/stdout (what an
 * editor launches), and spawn an ACP agent as a child process and connect to
 * it (what a Deuz program does to drive Claude Code, Codex CLI or Gemini CLI as
 * a sub-agent).
 *
 * ```ts
 * #!/usr/bin/env node
 * import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '@deuz-sdk/core/agent';
 * import { serveAcpAgentStdio } from '@deuz-sdk/core/acp/stdio';
 *
 * await serveAcpAgentStdio({
 *   agent: { streamAgent, resumeStreamAgent },
 *   store: createInMemoryAgentRunStore(),
 *   run: { model, tools, maxSteps: 20 },
 * });
 * ```
 *
 * Never write to stdout from a stdio agent: every byte there is protocol. Log
 * to stderr. Node-only (process streams, `node:child_process`), so it lives
 * under `src/node/`; the builtins are computed specifiers, loaded on use.
 */
import { AcpError } from '../acp/errors';
import { connectAcpAgent, type AcpClientConnection, type AcpClientOptions } from '../acp/client';
import { serveAcpAgent, type AcpAgentConnection, type AcpAgentOptions } from '../acp/agent';
import { createNdjsonTransport, type AcpTransport } from '../acp/transport';

export type {
  AcpAgentConnection,
  AcpAgentOptions,
  AcpClientConnection,
  AcpClientOptions,
} from '../acp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node's EventEmitter listener signature
type NodeListener = (...args: any[]) => void;

/** A Node `Readable` as this adapter uses it (a socket, a `PassThrough`, `process.stdin`). */
export interface AcpNodeReadable {
  on(event: string, listener: NodeListener): unknown;
  off?(event: string, listener: NodeListener): unknown;
  pause?(): unknown;
  resume?(): unknown;
  destroy?(): unknown;
}

/** A Node `Writable` as this adapter uses it (a socket, a `PassThrough`, `process.stdout`). */
export interface AcpNodeWritable {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end?(): unknown;
}

/**
 * Web streams over a Node readable/writable pair, framed as ACP's
 * newline-delimited JSON. `endOnClose` ends `output` when the transport
 * closes (true for a child's stdin, false for `process.stdout`).
 */
export function nodeStreamsToAcpTransport(
  input: AcpNodeReadable,
  output: AcpNodeWritable,
  options: { endOnClose?: boolean; maxMessageBytes?: number } = {},
): AcpTransport {
  let release = () => {};
  const readable = new ReadableStream<Uint8Array | string>({
    start(controller) {
      const onData = (chunk: Uint8Array | string) => {
        controller.enqueue(chunk);
        // Backpressure: stop reading while the consumer lags.
        if ((controller.desiredSize ?? 1) <= 0) input.pause?.();
      };
      const onEnd = () => {
        release();
        try {
          controller.close();
        } catch {
          // already closed or errored
        }
      };
      const onError = (error: Error) => {
        release();
        try {
          controller.error(error);
        } catch {
          // already closed
        }
      };
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('close', onEnd);
      input.on('error', onError);
      release = () => {
        input.off?.('data', onData);
        input.off?.('end', onEnd);
        input.off?.('close', onEnd);
        input.off?.('error', onError);
      };
      input.resume?.();
    },
    pull() {
      input.resume?.();
    },
    cancel() {
      release();
      input.pause?.();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        output.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    close: () => {
      if (options.endOnClose) output.end?.();
    },
  });
  return createNdjsonTransport({
    readable,
    writable,
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
  });
}

interface NodeProcessLike {
  stdin: AcpNodeReadable;
  stdout: AcpNodeWritable;
  env: Record<string, string | undefined>;
  platform?: string;
}

async function nodeProcess(): Promise<NodeProcessLike> {
  try {
    const spec: string = 'node:process';
    const mod = (await import(spec)) as { default?: NodeProcessLike } & NodeProcessLike;
    return mod.default ?? mod;
  } catch (error) {
    throw new AcpError({
      kind: 'closed',
      message: 'ACP over stdio needs a Node runtime (node:process).',
      cause: error,
    });
  }
}

/** Options of {@link serveAcpAgentStdio}: {@link AcpAgentOptions} without `transport`. */
export interface AcpStdioServeOptions extends Omit<AcpAgentOptions, 'transport'> {
  /** Read from here instead of `process.stdin`. */
  stdin?: AcpNodeReadable;
  /** Write here instead of `process.stdout`. */
  stdout?: AcpNodeWritable;
  /** See `NdjsonTransportOptions.maxMessageBytes`. */
  maxMessageBytes?: number;
}

/**
 * Serve a native agent over ACP on stdin/stdout, as an editor expects when it
 * launches the agent. Resolves once serving has started; the connection's
 * `closed` resolves when the editor closes stdin.
 */
export async function serveAcpAgentStdio(
  options: AcpStdioServeOptions,
): Promise<AcpAgentConnection> {
  const { stdin, stdout, maxMessageBytes, ...agentOptions } = options;
  const proc = stdin && stdout ? undefined : await nodeProcess();
  const transport = nodeStreamsToAcpTransport(
    stdin ?? (proc as NodeProcessLike).stdin,
    stdout ?? (proc as NodeProcessLike).stdout,
    {
      endOnClose: false,
      ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
    },
  );
  return serveAcpAgent({ ...agentOptions, transport });
}

interface ChildProcessLike {
  pid?: number;
  stdin:
    | (AcpNodeWritable & {
        end(): unknown;
        on?(event: 'error', listener: (error: Error) => void): unknown;
      })
    | null;
  stdout: AcpNodeReadable | null;
  stderr: AcpNodeReadable | null;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: string): boolean;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

interface ChildProcessModule {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdio: ['pipe', 'pipe', 'pipe' | 'inherit' | 'ignore'];
      shell?: boolean;
      windowsHide?: boolean;
    },
  ): ChildProcessLike;
}

/** Options of {@link spawnAcpAgent}: what to start, plus {@link AcpClientOptions} without `transport`. */
export interface AcpSpawnOptions extends Omit<AcpClientOptions, 'transport'> {
  /** The agent's executable, e.g. `'claude-agent-acp'`, or `'npx'` with `args`. */
  command: string;
  args?: readonly string[];
  /** Working directory of the child. Default: this process's. */
  cwd?: string;
  /** Added to this process's environment (a value of `undefined` removes a variable). */
  env?: Record<string, string | undefined>;
  /**
   * Run through the shell. Needed on Windows for `.cmd` launchers such as
   * `npx` (or pass `command: 'npx.cmd'`). Mind quoting: arguments are not escaped.
   */
  shell?: boolean;
  /**
   * The child's stderr (its log, never protocol): `'inherit'` (the default)
   * passes it through to this process's stderr, `'ignore'` drops it, a
   * function receives it line by line.
   */
  stderr?: 'inherit' | 'ignore' | ((line: string) => void);
  /** How long `close()` waits for the child to exit after closing its stdin before killing it. Default 2000 ms. */
  killTimeoutMs?: number;
  /** See `NdjsonTransportOptions.maxMessageBytes`. */
  maxMessageBytes?: number;
}

/** A connected ACP agent running as a child process. */
export interface AcpSpawnedAgent extends AcpClientConnection {
  readonly pid: number | undefined;
  /** Resolves when the child exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /**
   * Signal the child (default `SIGTERM`). With `shell` on Windows the child
   * is the shell, so the whole process tree is ended (`taskkill /T /F`)
   * instead and `signal` is ignored.
   */
  kill(signal?: string): boolean;
  /** Close the connection (the child's stdin), wait up to `killTimeoutMs` for it to exit, then kill it. */
  close(): Promise<void>;
}

/**
 * Start an ACP agent as a child process and connect to it over its stdio:
 * spawn, `initialize` (and `authenticate` with `authMethodId`), then return
 * the connection. Rejects, and kills the child, when it cannot be started or
 * does not complete `initialize`.
 *
 * ```ts
 * const harness = await spawnAcpAgent({
 *   command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], shell: process.platform === 'win32',
 *   onPermissionRequest: (request) => decide(request),
 * });
 * const session = await harness.newSession({ cwd: process.cwd() });
 * const { text, cost } = await session.prompt('Run the tests and fix what fails.').result;
 * await harness.close();
 * ```
 */
export async function spawnAcpAgent(options: AcpSpawnOptions): Promise<AcpSpawnedAgent> {
  const {
    command,
    args,
    cwd,
    env,
    shell,
    stderr,
    killTimeoutMs,
    maxMessageBytes,
    ...clientOptions
  } = options;
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('spawnAcpAgent: command must be a non-empty string.');
  }
  let childProcess: ChildProcessModule;
  try {
    const spec: string = 'node:child_process';
    childProcess = (await import(spec)) as ChildProcessModule;
  } catch (error) {
    throw new AcpError({
      kind: 'closed',
      message: 'spawnAcpAgent needs a Node runtime (node:child_process).',
      cause: error,
    });
  }
  const proc = await nodeProcess();
  const child = childProcess.spawn(command, [...(args ?? [])], {
    ...(cwd !== undefined ? { cwd } : {}),
    env: { ...proc.env, ...(env ?? {}) },
    stdio: [
      'pipe',
      'pipe',
      stderr === 'ignore' ? 'ignore' : typeof stderr === 'function' ? 'pipe' : 'inherit',
    ],
    ...(shell !== undefined ? { shell } : {}),
    windowsHide: true,
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (error) =>
      reject(
        new AcpError({
          kind: 'closed',
          message: `The ACP agent '${command}' could not be started: ${error.message}`,
          cause: error,
        }),
      ),
    );
    void exited.then(({ code, signal }) =>
      reject(
        new AcpError({
          kind: 'closed',
          message: `The ACP agent '${command}' exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}) before it was initialized.`,
        }),
      ),
    );
  });
  failed.catch(() => undefined);
  if (typeof stderr === 'function' && child.stderr) {
    let pending = '';
    const decoder = new TextDecoder();
    child.stderr.on('data', (chunk) => {
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) stderr(line.replace(/\r$/, ''));
    });
    child.stderr.on('end', () => {
      if (pending !== '') stderr(pending);
    });
  }
  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new AcpError({
      kind: 'closed',
      message: `The ACP agent '${command}' has no stdio pipes.`,
    });
  }
  // A write that races the child's exit fails with EPIPE as an 'error' event
  // on its stdin, which would crash this process without a listener. The
  // write's callback already rejects the send, and the exit closes the peer.
  child.stdin.on?.('error', () => undefined);
  // With `shell` on Windows the child is cmd.exe: killing it would orphan the
  // agent it started (npx, then node), which could go on spending. End the tree.
  const killChild = (signal?: string): boolean => {
    if (shell && proc.platform === 'win32' && child.pid !== undefined) {
      try {
        const killer = childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        killer.once('error', () => void child.kill(signal));
        killer.stdout?.resume?.();
        killer.stdin?.end();
        return true;
      } catch {
        // fall back to the shell alone
      }
    }
    return child.kill(signal);
  };
  const transport = nodeStreamsToAcpTransport(child.stdout, child.stdin, {
    endOnClose: true,
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
  });
  let connection: AcpClientConnection;
  try {
    connection = await Promise.race([connectAcpAgent({ ...clientOptions, transport }), failed]);
  } catch (error) {
    killChild();
    throw error;
  }
  const timeout = killTimeoutMs ?? 2000;
  return {
    agent: connection.agent,
    peer: connection.peer,
    authenticate: (methodId) => connection.authenticate(methodId),
    newSession: (params) => connection.newSession(params),
    loadSession: (params) => connection.loadSession(params),
    closed: connection.closed,
    pid: child.pid,
    exited,
    kill: (signal) => killChild(signal),
    async close() {
      await connection.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeout);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (!waited) {
        killChild();
        await exited;
      }
    },
  };
}
