/**
 * The host facts and streams the CLI reads and writes. Every command takes
 * them as an argument, so a test (or a host embedding the CLI) can run it
 * in-process with its own argv, environment and streams.
 */

/** Process signals the CLI listens to. */
export type CliSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK';

/** Where the CLI subscribes to process signals. Default: `process`. */
export interface CliSignals {
  on(signal: CliSignal, listener: () => void): unknown;
  off(signal: CliSignal, listener: () => void): unknown;
}

/** What {@link runCli} reads from and writes to. Every field has a process default. */
export interface CliIo {
  /** Default `process.stdin`. `deuz acp` reads the protocol from it. */
  stdin: NodeJS.ReadableStream;
  /**
   * Default `process.stdout`. Help, version and `deuz meter`'s setup lines go
   * here; under `deuz acp` it is the protocol channel and nothing else is written to it.
   */
  stdout: NodeJS.WritableStream;
  /** Default `process.stderr`. Logs, errors and summaries. */
  stderr: NodeJS.WritableStream;
  /** Default `process.env`. */
  env: Readonly<Record<string, string | undefined>>;
  /** Default `process.cwd()`. Relative paths in flags resolve against it. */
  cwd: string;
  /** Default `process.platform`. */
  platform: NodeJS.Platform;
  /** Default `process`. */
  signals: CliSignals;
  /**
   * Resolves when a long-running command (`deuz meter` without a command,
   * `deuz acp`) should stop. It is called once the command is ready, after its
   * setup lines are written. Default: the first SIGINT, SIGTERM or SIGHUP
   * (and, for `deuz acp`, the client closing stdin).
   */
  untilStopped?: () => Promise<void>;
}

/** Fill in the process defaults for the fields a caller left out. */
export function resolveIo(io: Partial<CliIo> | undefined): CliIo {
  return {
    stdin: io?.stdin ?? process.stdin,
    stdout: io?.stdout ?? process.stdout,
    stderr: io?.stderr ?? process.stderr,
    env: io?.env ?? process.env,
    cwd: io?.cwd ?? process.cwd(),
    platform: io?.platform ?? process.platform,
    signals: io?.signals ?? (process as unknown as CliSignals),
    ...(io?.untilStopped ? { untilStopped: io.untilStopped } : {}),
  };
}

/** Resolves on the first of `signals`; the listeners are removed afterwards. */
export function onFirstSignal(
  signals: CliSignals,
  names: readonly CliSignal[],
  platform: NodeJS.Platform,
): { promise: Promise<CliSignal>; dispose(): void } {
  const usable = names.filter((name) => name !== 'SIGBREAK' || platform === 'win32');
  const listeners = new Map<CliSignal, () => void>();
  const dispose = (): void => {
    for (const [name, listener] of listeners) signals.off(name, listener);
    listeners.clear();
  };
  const promise = new Promise<CliSignal>((resolve) => {
    for (const name of usable) {
      const listener = (): void => {
        dispose();
        resolve(name);
      };
      listeners.set(name, listener);
      signals.on(name, listener);
    }
  });
  return { promise, dispose };
}

/** Write one line to a stream. */
export function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}
