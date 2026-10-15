/**
 * `createDockerSandbox` (2.4, preview): the `ComputeSandbox` seam on local
 * Docker. Each `runCode` / `runShell` creates a fresh container with the
 * default isolation, stages the workspace into it, attaches, starts it once,
 * and removes it afterwards, whatever happened. Changes the run makes to its
 * workspace stay in the container: nothing is applied to the host workspace.
 */
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan, recordSpan } from '../../internal/telemetry';
import type {
  CodeExecutionRequest,
  CodeExecutionResult,
  ComputeSandbox,
  ShellExecutionRequest,
} from '../../types/compute';
import { execDocker } from './cli';
import {
  assertEnv,
  collectStageFiles,
  createDockerEngine,
  safeName,
  workspaceVolumeName,
  type ContainerSpec,
  type ResolvedDockerOptions,
} from './engine';
import { ByteTail } from './output';
import { isWithinPosix, posixResolve } from './paths';

/** How long a run may take when the request names no timeout. */
export const DEFAULT_DOCKER_RUN_TIMEOUT_MS = 30_000;
/** How long a killed run's attach may linger before the CLI itself is stopped. */
const ATTACH_GRACE_MS = 5_000;

const encoder = new TextEncoder();

/** The result of a run whose signal fired before its container started. */
const abortedBeforeStart = (): CodeExecutionResult => ({
  stdout: '',
  stderr: 'Aborted before start.',
  exitCode: null,
  timedOut: true,
});

interface RunInput {
  command: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  env?: Record<string, string>;
}

export function createDockerSandboxFromOptions(options: ResolvedDockerOptions): ComputeSandbox {
  const engine = createDockerEngine(options);
  const { deps } = options;
  const scope = options.scope ?? 'default';

  async function run(input: RunInput): Promise<CodeExecutionResult> {
    if (input.signal?.aborted) return abortedBeforeStart();
    assertEnv(input.env);
    const startedAt = deps.clock.now();
    const files = await collectStageFiles(options);
    const imageId = await engine.resolveImage();
    // An abort while the workspace was read or the image resolved: nothing is made.
    if (input.signal?.aborted) return abortedBeforeStart();
    const operationId = deps.generateId();
    const spec: ContainerSpec = {
      name: `deuz-sbx-${safeName(operationId)}`,
      kind: 'sandbox',
      operationId,
      scope,
      command: input.command,
      interactive: input.stdin !== undefined,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    };
    let containerId: string | undefined;
    try {
      containerId = await observeSpan(
        deps,
        DEUZ_SPAN.processStart,
        { [DEUZ_ATTR.processOperationId]: operationId },
        async () => {
          const id = await engine.create(imageId, spec);
          containerId = id;
          await engine.stage(id, spec, imageId, files);
          return id;
        },
      );
      const id = containerId;
      // An abort during create or staging: the container is removed (finally)
      // without ever starting. Checked right before the listener goes on, so
      // no abort falls between the two.
      if (input.signal?.aborted) return abortedBeforeStart();
      const stdout = new ByteTail(options.maxOutputBytes);
      const stderr = new ByteTail(options.maxOutputBytes);
      let timedOut = false;
      const attach = new AbortController();
      let graceTimer: (() => void) | undefined;
      const kill = (): void => {
        if (timedOut) return;
        timedOut = true;
        // The container dies, the attach then ends on its own; the grace
        // only covers a daemon that does not answer the kill.
        engine.kill(id).catch(() => {});
        graceTimer = deps.clock.setTimeout(() => attach.abort(), ATTACH_GRACE_MS);
      };
      const cancelTimeout = deps.clock.setTimeout(
        kill,
        input.timeoutMs ?? DEFAULT_DOCKER_RUN_TIMEOUT_MS,
      );
      input.signal?.addEventListener('abort', kill, { once: true });
      let result;
      try {
        result = await execDocker(
          engine.cli,
          ['start', '--attach', ...(input.stdin !== undefined ? ['--interactive'] : []), id],
          {
            timeoutMs: 0,
            signal: attach.signal,
            ...(input.stdin !== undefined ? { stdin: encoder.encode(input.stdin) } : {}),
            onStdout: (chunk) => stdout.push(chunk),
            onStderr: (chunk) => stderr.push(chunk),
          },
        );
      } finally {
        cancelTimeout();
        graceTimer?.();
        input.signal?.removeEventListener('abort', kill);
      }
      const info = await engine.inspect(id);
      let exitCode: number | null = null;
      if (!timedOut) {
        if (info && info.startedAt !== undefined && !info.running) exitCode = info.exitCode;
        // A start the daemon refused (an executable not found) never ran.
        if (info?.error) stderr.push(encoder.encode(`${info.error}\n`));
        else if (info?.startedAt === undefined && result.code !== 0)
          stderr.push(encoder.encode(`docker start failed (exit code ${result.code})\n`));
      }
      const truncated = { stdout: stdout.truncated, stderr: stderr.truncated };
      recordSpan(deps, DEUZ_SPAN.processExit, {
        [DEUZ_ATTR.processOperationId]: operationId,
        ...(exitCode !== null ? { [DEUZ_ATTR.processExitCode]: exitCode } : {}),
        [DEUZ_ATTR.processTruncated]: truncated.stdout || truncated.stderr,
      });
      return {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: deps.clock.now() - startedAt,
        ...(truncated.stdout || truncated.stderr ? { truncated } : {}),
      };
    } finally {
      if (containerId !== undefined)
        await engine.remove(containerId, spec.name).catch((error: unknown) => {
          deps.logger.warn('Docker sandbox: removing a container failed', {
            containerId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      else if (options.readOnlyRootFilesystem)
        // A create that failed after its volume was made.
        await engine.removeVolume(workspaceVolumeName(spec.name)).catch(() => {});
    }
  }

  return {
    async runCode(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
      const prefix = options.interpreters[request.language];
      if (!prefix)
        return {
          stdout: '',
          stderr: `No interpreter configured for language '${request.language}'. Known: ${Object.keys(options.interpreters).join(', ')}.`,
          exitCode: null,
        };
      return run({
        command: [...prefix, request.code],
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
      });
    },

    async runShell(request: ShellExecutionRequest): Promise<CodeExecutionResult> {
      let cwd: string | undefined;
      if (request.cwd !== undefined) {
        cwd = posixResolve(options.workdir, request.cwd);
        if (!isWithinPosix(options.workdir, cwd))
          return {
            stdout: '',
            stderr: `Working directory '${request.cwd}' is outside the sandbox root (${options.workdir}).`,
            exitCode: null,
          };
      }
      return run({
        command: ['/bin/sh', '-c', request.command],
        ...(cwd !== undefined ? { cwd } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
      });
    },
  };
}
