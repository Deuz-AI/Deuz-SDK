/**
 * `createDockerProcessRunner` (2.4, preview): a process that outlives its host
 * process. Every step is recorded in the `ProcessOperationStore` with a
 * compare-and-set, in a fixed order — operation record → container create →
 * staging → durable `start-dispatched` → one start command → inspect — so a
 * restarted host reconnects instead of starting twice:
 *
 * - the container's name is derived from (scope, operation id), so a create
 *   that crashed before it was recorded is found, never made twice;
 * - a running or exited container is never started again;
 * - a start whose outcome is unknown (`start-dispatched` with a container that
 *   never ran) becomes `needs-reconcile`; `reconcile` then marks it failed,
 *   never starts it;
 * - a container that vanished makes the operation `lost`, never recreated.
 *
 * Cancel is recorded first, then stop with a 2 s grace, kill if needed and a
 * state check (a container that never started is removed instead, so a start
 * another host already dispatched has nothing to run); while the daemon is
 * unreachable the operation stays
 * `cancel-requested` and the next poll, cancel or reconcile drives it on.
 * `durableTimeout` is false: a deadline is enforced by this runner's timer
 * while it lives, and a deadline that passed while the host was down cancels
 * at the first poll, start or reconcile after it.
 */
import {
  digestJson,
  sha256Digest,
  workspaceDigestEntry,
  type Sha256Digest,
} from '../../internal/digest';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan, recordSpan } from '../../internal/telemetry';
import { startAttachedWithStdin } from './cli';
import {
  assertEnv,
  collectStageFiles,
  createDockerEngine,
  DEUZ_LABEL,
  operationContainerName,
  type ContainerInfo,
  type ContainerSpec,
  type ResolvedDockerOptions,
  type StageFile,
} from './engine';
import { DockerSandboxError } from './errors';
import { assertRelativePath, isNormalizedRelativePath, posixBasename } from './paths';
import { TERMINAL_PROCESS_STATES, type ProcessOperationChanges } from './store-shared';
import type {
  ProcessArtifact,
  ProcessOperationRecord,
  ProcessOperationStore,
  ProcessOutput,
  ProcessReconcileReport,
  ProcessRunner,
  ProcessSession,
  ProcessStartRequest,
  ProcessState,
} from './types';

/** Seconds between stop's SIGTERM and its SIGKILL (spec §3.3). */
const CANCEL_GRACE_SECONDS = 2;
/**
 * How old a `start-dispatched` record must be before `reconcile` declares a
 * start that never happened failed: younger, another host may still be
 * issuing that start.
 */
export const START_SETTLE_MS = 30_000;
/**
 * How long a sandbox container or staging helper is left alone by
 * `reconcile` (2.4): after its create while it never ran, after its exit, and
 * past its run timeout while it runs. Those containers belong to a sandbox
 * run or a staging copy, here or on another host, that removes them itself;
 * the window is longer than every CLI timeout of a run's create and staging
 * steps put together, so only a container whose host is gone outlives it.
 */
export const TRANSIENT_CONTAINER_SETTLE_MS = 30 * 60_000;

/**
 * When a sandbox container or staging helper stops being in use (epoch ms,
 * daemon clock): a running one only past its labelled run timeout (never
 * without the label), any other once it has been created or exited for the
 * settle window.
 */
function transientLeaseEnd(info: ContainerInfo): number {
  if (info.running) {
    const label = info.labels[DEUZ_LABEL.runTimeoutMs];
    const runMs = label === undefined ? Number.NaN : Number(label);
    const since = info.startedAt ?? info.createdAt;
    if (since === undefined || !Number.isFinite(runMs) || runMs < 0)
      return Number.POSITIVE_INFINITY;
    return since + runMs + TRANSIENT_CONTAINER_SETTLE_MS;
  }
  const since = info.finishedAt ?? info.createdAt;
  return since === undefined ? Number.POSITIVE_INFINITY : since + TRANSIENT_CONTAINER_SETTLE_MS;
}

/** How long a start with stdin is watched for the container to come up. */
const STDIN_START_WAIT_MS = 30_000;

/** The states a container may still exist for, and `reconcile` checks. */
const ACTIVE_STATES: readonly ProcessState[] = [
  'created',
  'staged',
  'start-dispatched',
  'running',
  'cancel-requested',
  'needs-reconcile',
];

const encoder = new TextEncoder();
const EMPTY_OUTPUT: ProcessOutput = {
  stdout: '',
  stderr: '',
  truncated: { stdout: false, stderr: false },
};

function sessionOf(record: ProcessOperationRecord): ProcessSession {
  return {
    operationId: record.operationId,
    scope: record.scope,
    state: record.state,
    ...(record.containerId !== undefined ? { containerId: record.containerId } : {}),
    ...(record.imageId !== undefined ? { imageId: record.imageId } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.deadlineAt !== undefined ? { deadlineAt: record.deadlineAt } : {}),
    durableTimeout: false,
    requestDigest: record.requestDigest,
    ...(record.error !== undefined ? { error: { ...record.error } } : {}),
  };
}

function errorOf(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

const isUnavailable = (error: unknown): boolean =>
  error instanceof DockerSandboxError && error.code === 'docker_unavailable';

function validateRequest(request: ProcessStartRequest): void {
  if (!request || typeof request.operationId !== 'string' || request.operationId === '')
    throw new TypeError('A process start needs a non-empty operationId');
  if (typeof request.scope !== 'string' || request.scope === '')
    throw new TypeError('A process start needs a non-empty scope');
  if (
    !Array.isArray(request.command) ||
    request.command.length === 0 ||
    request.command.some((arg) => typeof arg !== 'string')
  )
    throw new TypeError('A process start needs a non-empty command argv of strings');
  for (const file of request.files ?? []) {
    assertRelativePath(file.path, 'A staged file path');
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array))
      throw new TypeError(`Staged file ${file.path} needs string or Uint8Array content`);
  }
  assertEnv(request.env);
  if (request.stdin !== undefined && typeof request.stdin !== 'string')
    throw new TypeError('stdin must be a string');
  if (request.deadlineAt !== undefined && !Number.isFinite(request.deadlineAt))
    throw new TypeError('deadlineAt must be epoch milliseconds');
}

/**
 * The canonical-JSON digest of a start request. File contents and stdin enter
 * as their own digests, env values as given (the record keeps only the
 * names). The runner's workspace is configuration, not part of the request.
 */
async function requestDigest(request: ProcessStartRequest): Promise<Sha256Digest> {
  const files = request.files
    ? await Promise.all(request.files.map((file) => workspaceDigestEntry(file.path, file.content)))
    : undefined;
  return digestJson({
    operationId: request.operationId,
    scope: request.scope,
    command: [...request.command],
    ...(request.env !== undefined ? { env: { ...request.env } } : {}),
    ...(files
      ? { files: files.map((file) => ({ path: file.path, size: file.size, digest: file.digest })) }
      : {}),
    ...(request.stdin !== undefined ? { stdin: await sha256Digest(request.stdin) } : {}),
    ...(request.deadlineAt !== undefined ? { deadlineAt: request.deadlineAt } : {}),
  });
}

const recordKey = (scope: string, operationId: string) => JSON.stringify([scope, operationId]);

export function createDockerRunnerFromOptions(
  options: ResolvedDockerOptions,
  store: ProcessOperationStore,
): ProcessRunner {
  const engine = createDockerEngine(options);
  const { deps } = options;
  const deadlineTimers = new Map<string, () => void>();

  /** A timer that never holds the host process open (unless the host gave a clock). */
  const schedule = (fn: () => void, ms: number): (() => void) => {
    if (options.customClock) return deps.clock.setTimeout(fn, ms);
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    handle.unref?.();
    return () => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  };

  const clearDeadline = (record: ProcessOperationRecord): void => {
    const key = recordKey(record.scope, record.operationId);
    deadlineTimers.get(key)?.();
    deadlineTimers.delete(key);
  };

  const armDeadline = (record: ProcessOperationRecord): void => {
    if (record.state !== 'running' || record.deadlineAt === undefined) return;
    const key = recordKey(record.scope, record.operationId);
    if (deadlineTimers.has(key)) return;
    const cancelTimer = schedule(
      () => {
        deadlineTimers.delete(key);
        runner.cancel(record.scope, record.operationId).catch((error: unknown) => {
          deps.logger.warn('Docker process runner: the deadline cancel failed', {
            operationId: record.operationId,
            error: errorOf(error).message,
          });
        });
      },
      Math.max(0, record.deadlineAt - deps.clock.now()),
    );
    deadlineTimers.set(key, cancelTimer);
  };

  async function load(scope: string, operationId: string): Promise<ProcessOperationRecord> {
    const record = await store.get(scope, operationId);
    if (!record)
      throw new DockerSandboxError(
        'operation_not_found',
        `No process operation '${operationId}' is recorded in scope '${scope}'.`,
      );
    return record;
  }

  /** CAS-commits `changes`; on a conflict, the current record (re-read when the store gave none). */
  async function commit(
    record: ProcessOperationRecord,
    changes: ProcessOperationChanges,
  ): Promise<{ ok: boolean; record: ProcessOperationRecord }> {
    const result = await store.update(record.scope, record.operationId, changes, {
      expectedRevision: record.revision,
    });
    if (result.status === 'committed') {
      if (result.record.state !== 'running') clearDeadline(result.record);
      return { ok: true, record: result.record };
    }
    return { ok: false, record: result.record ?? (await load(record.scope, record.operationId)) };
  }

  function specOf(
    record: ProcessOperationRecord,
    name: string,
    request?: ProcessStartRequest,
  ): ContainerSpec {
    return {
      name,
      kind: 'process',
      operationId: record.operationId,
      scope: record.scope,
      command: record.request.command,
      requestDigest: record.requestDigest,
      interactive: request?.stdin !== undefined,
      ...(request?.env !== undefined ? { env: request.env } : {}),
    };
  }

  /**
   * Whether a container found under a record's name is a create of that very
   * record a crash cut short: it never ran and carries the record's request
   * digest. Anything else an earlier operation under the same id left behind
   * (its record pruned before the container was disposed).
   */
  const adoptable = (record: ProcessOperationRecord, info: ContainerInfo): boolean =>
    info.startedAt === undefined && info.labels[DEUZ_LABEL.requestDigest] === record.requestDigest;

  /** Fails a fresh record whose name an earlier operation's container holds; never adopted, never removed. */
  async function refuseLeftover(
    record: ProcessOperationRecord,
    name: string,
  ): Promise<{ ok: boolean; record: ProcessOperationRecord }> {
    return commit(record, {
      state: 'failed',
      endedAt: deps.clock.now(),
      error: {
        name: 'DockerSandboxError',
        message: `The container ${name} was left by an earlier operation under this id; dispose this operation to remove it, then prune the record before reusing the id.`,
        code: 'container_conflict',
      },
    });
  }

  /** Records an exit (or a cancel's end) with the output tail, and reports it. */
  async function finish(
    record: ProcessOperationRecord,
    info: ContainerInfo,
    state: 'exited' | 'cancelled',
  ): Promise<ProcessOperationRecord> {
    let output: ProcessOutput | undefined;
    try {
      output = info.startedAt !== undefined ? await engine.logs(info.id) : undefined;
    } catch (error) {
      if (isUnavailable(error)) throw error;
      deps.logger.warn('Docker process runner: reading the logs failed', {
        operationId: record.operationId,
        error: errorOf(error).message,
      });
    }
    const started = info.startedAt !== undefined;
    const result = await commit(record, {
      state,
      exitCode: started ? info.exitCode : null,
      ...(info.startedAt !== undefined ? { startedAt: info.startedAt } : {}),
      endedAt: info.finishedAt ?? deps.clock.now(),
      ...(output ? { output } : {}),
      // An earlier, transient error (a daemon that was out of reach) is over.
      error: info.oomKilled
        ? {
            name: 'OutOfMemory',
            message: 'The container was killed for exceeding its memory limit.',
            code: 'oom_killed',
          }
        : undefined,
    });
    if (result.ok)
      recordSpan(deps, DEUZ_SPAN.processExit, {
        [DEUZ_ATTR.processOperationId]: record.operationId,
        ...(started ? { [DEUZ_ATTR.processExitCode]: info.exitCode } : {}),
        [DEUZ_ATTR.processTruncated]: output
          ? output.truncated.stdout || output.truncated.stderr
          : false,
        'deuz.process.state': state,
      });
    return result.record;
  }

  /** The record brought in line with an inspected container (or with its absence). */
  async function follow(
    record: ProcessOperationRecord,
    info: ContainerInfo | undefined,
  ): Promise<ProcessOperationRecord> {
    if (!info) return (await commit(record, { state: 'lost' })).record;
    if (info.startedAt === undefined) return record;
    if (!info.running) return finish(record, info, 'exited');
    let current = record;
    if (current.state !== 'running') {
      const result = await commit(current, {
        state: 'running',
        startedAt: info.startedAt,
        error: undefined,
      });
      current = result.record;
      if (!result.ok) return current;
    }
    if (current.deadlineAt !== undefined && deps.clock.now() >= current.deadlineAt)
      return cancelRecord(current);
    armDeadline(current);
    return current;
  }

  /** Refreshes a record from the daemon: exits, lost containers, cancels to finish, deadlines. */
  async function refresh(record: ProcessOperationRecord): Promise<ProcessOperationRecord> {
    switch (record.state) {
      case 'running':
      case 'start-dispatched':
      case 'needs-reconcile':
        return follow(record, await engine.inspect(record.containerId!));
      case 'cancel-requested':
        return driveCancel(record);
      default:
        return record;
    }
  }

  async function cancelRecord(record: ProcessOperationRecord): Promise<ProcessOperationRecord> {
    let current = record;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (TERMINAL_PROCESS_STATES.has(current.state)) return current;
      if (current.state === 'cancel-requested') return driveCancel(current);
      // Recorded first: from here on nothing starts it, and a restarted host
      // finishes the cancel.
      const result = await commit(current, { state: 'cancel-requested' });
      current = result.record;
      if (result.ok) return driveCancel(current);
    }
    return current;
  }

  /** Stop, a 2 s grace, kill if needed, verify; never `cancelled` while the daemon is out of reach. */
  async function driveCancel(record: ProcessOperationRecord): Promise<ProcessOperationRecord> {
    try {
      let containerId = record.containerId;
      if (containerId === undefined) {
        const found = await engine.inspect(
          await operationContainerName(record.scope, record.operationId),
        );
        containerId = found?.id;
      }
      const gone = async () =>
        (await commit(record, { state: 'cancelled', endedAt: deps.clock.now(), error: undefined }))
          .record;
      let info = containerId !== undefined ? await engine.inspect(containerId) : undefined;
      if (!info) return gone();
      if (info.running) {
        // Any other failure of stop or kill shows in the inspection after it.
        await engine.stop(info.id, CANCEL_GRACE_SECONDS).catch((error: unknown) => {
          if (isUnavailable(error)) throw error;
        });
        info = await engine.inspect(info.id);
        if (!info) return gone();
        if (info.running) {
          await engine.kill(info.id).catch((error: unknown) => {
            if (isUnavailable(error)) throw error;
          });
          info = await engine.inspect(info.id);
          if (!info) return gone();
        }
        if (info.running) {
          const result = await commit(record, {
            error: {
              name: 'DockerSandboxError',
              message: 'The container is still running after stop and kill.',
              code: 'cancel_unverified',
            },
          });
          return result.record;
        }
      }
      if (info.startedAt === undefined)
        // Never started: removed before the cancel is final, so a start another
        // host has already dispatched finds nothing to run (that host notices
        // the cancel only after its start). Its volume goes with dispose.
        await engine.remove(info.id);
      const withId =
        containerId !== record.containerId && containerId !== undefined
          ? (await commit(record, { containerId })).record
          : record;
      return finish(withId, info, 'cancelled');
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      // The cancel stays recorded; the next poll, cancel or reconcile drives it on.
      return (await commit(record, { error: errorOf(error) })).record;
    }
  }

  /** Issues the one start command and records what inspection says came of it. */
  async function dispatchStart(
    record: ProcessOperationRecord,
    request: ProcessStartRequest,
  ): Promise<ProcessOperationRecord> {
    const containerId = record.containerId!;
    let startError: unknown;
    let stdinStart: { exited: Promise<number | null> } | undefined;
    try {
      if (request.stdin !== undefined)
        stdinStart = await startAttachedWithStdin(
          engine.cli,
          containerId,
          encoder.encode(request.stdin),
        );
      else await engine.start(containerId);
    } catch (error) {
      startError = error;
    }
    let info: ContainerInfo | undefined;
    let inspectError: unknown;
    try {
      info = await engine.inspect(containerId);
      if (stdinStart && info && info.startedAt === undefined && !info.error) {
        // `start --attach` only exits with the container: watch for it to come up.
        let cliExited = false;
        void stdinStart.exited.then(() => {
          cliExited = true;
        });
        const until = Date.now() + STDIN_START_WAIT_MS;
        while (
          info &&
          info.startedAt === undefined &&
          !info.error &&
          !cliExited &&
          Date.now() < until
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          info = await engine.inspect(containerId);
        }
        if (info && info.startedAt === undefined && !info.error && cliExited)
          info = await engine.inspect(containerId);
      }
    } catch (error) {
      inspectError = error;
    }
    // A cancel recorded meanwhile wins: it is enforced on whatever did start.
    const latest = await load(record.scope, record.operationId);
    if (latest.revision !== record.revision) {
      if (latest.state === 'cancel-requested' || latest.state === 'cancelled')
        return driveCancel(latest);
      return latest;
    }
    if (info?.startedAt !== undefined) return follow(record, info);
    if (
      info &&
      !inspectError &&
      (info.error || (startError !== undefined && !isUnavailable(startError)))
    )
      // The daemon refused the start for good (an executable not found, ...).
      return (
        await commit(record, {
          state: 'failed',
          endedAt: deps.clock.now(),
          error: info.error
            ? { name: 'DockerSandboxError', message: info.error, code: 'start_failed' }
            : errorOf(startError),
        })
      ).record;
    if (!info && !inspectError) return (await commit(record, { state: 'lost' })).record;
    // Unknown: the start may or may not have reached the daemon.
    return (
      await commit(record, {
        state: 'needs-reconcile',
        error: errorOf(inspectError ?? startError ?? new Error('The start was not confirmed.')),
      })
    ).record;
  }

  /** Walks an operation forward from wherever it stands, at most to its first running state. */
  async function drive(
    initial: ProcessOperationRecord,
    request: ProcessStartRequest,
  ): Promise<ProcessOperationRecord> {
    let record = initial;
    let files: StageFile[] | undefined;
    let created = false;
    const name = await operationContainerName(record.scope, record.operationId);
    for (let step = 0; step < 20; step++) {
      switch (record.state) {
        case 'recorded': {
          // A create that crashed before it was recorded left the container
          // under this operation's name: adopt it, never make a second one.
          const info = await engine.inspect(name);
          if (
            info &&
            (info.labels[DEUZ_LABEL.operationId] !== record.operationId ||
              info.labels[DEUZ_LABEL.scope] !== record.scope)
          )
            throw new DockerSandboxError(
              'docker_failed',
              `The container name ${name} belongs to another operation.`,
            );
          if (info && !adoptable(record, info)) {
            const result = await refuseLeftover(record, name);
            record = result.record;
            if (result.ok) return record;
            continue;
          }
          let containerId = info?.id;
          if (containerId === undefined) {
            files ??= await collectStageFiles(options, request.files);
            try {
              containerId = await engine.create(
                record.imageId ?? (await engine.resolveImage()),
                specOf(record, name, request),
              );
              created = true;
            } catch (error) {
              // Another host created it meanwhile: the name says so.
              const raced = await engine.inspect(name).catch(() => undefined);
              if (!raced) throw error;
              containerId = raced.id;
            }
          }
          record = (await commit(record, { state: 'created', containerId })).record;
          continue;
        }
        case 'created': {
          // A container this call just made needs no second look.
          if (!created) {
            const info = await engine.inspect(record.containerId!);
            if (!info) {
              record = (await commit(record, { state: 'lost' })).record;
              continue;
            }
            if (info.startedAt !== undefined) return follow(record, info);
          }
          files ??= await collectStageFiles(options, request.files);
          try {
            await engine.stage(
              record.containerId!,
              specOf(record, name, request),
              record.imageId!,
              files,
            );
          } catch (error) {
            if (isUnavailable(error)) throw error;
            if (error instanceof DockerSandboxError && error.code === 'not_found') {
              record = (await commit(record, { state: 'lost' })).record;
              continue;
            }
            return (
              await commit(record, {
                state: 'failed',
                endedAt: deps.clock.now(),
                error: errorOf(error),
              })
            ).record;
          }
          record = (await commit(record, { state: 'staged' })).record;
          continue;
        }
        case 'staged': {
          // Durable before the single start command.
          const result = await commit(record, { state: 'start-dispatched' });
          record = result.record;
          if (!result.ok) continue;
          return dispatchStart(record, request);
        }
        case 'start-dispatched': {
          // Found on entry: the host stopped between the durable record and
          // the outcome. Started → follow it; never started → unknown.
          const info = await engine.inspect(record.containerId!);
          if (!info) return (await commit(record, { state: 'lost' })).record;
          if (info.startedAt !== undefined) return follow(record, info);
          return (
            await commit(record, {
              state: 'needs-reconcile',
              error: {
                name: 'DockerSandboxError',
                message:
                  'The start was dispatched before the host stopped; whether it ran is unknown.',
                code: 'start_unconfirmed',
              },
            })
          ).record;
        }
        default:
          return refresh(record);
      }
    }
    return record;
  }

  /** Reads one tar header of `path` and stops. */
  async function firstHeader(containerId: string, path: string) {
    let header: { type: string } | undefined;
    await engine.copyOut(
      containerId,
      path,
      {
        entry(found) {
          header = found;
          return 'stop';
        },
      },
      64 * 1024 * 1024,
    );
    return header;
  }

  const runner: ProcessRunner = {
    async start(request) {
      validateRequest(request);
      const digest = await requestDigest(request);
      return observeSpan(
        deps,
        DEUZ_SPAN.processStart,
        { [DEUZ_ATTR.processOperationId]: request.operationId },
        async (annotate) => {
          const existing = await store.get(request.scope, request.operationId);
          let imageId = existing?.imageId;
          if (!existing) {
            imageId = await engine.resolveImage();
            // The size limit is checked before anything is recorded.
            await collectStageFiles(options, request.files);
          }
          const files = request.files?.map((file) => ({
            path: file.path,
            size:
              typeof file.content === 'string'
                ? encoder.encode(file.content).byteLength
                : file.content.byteLength,
          }));
          const created = await store.create({
            operationId: request.operationId,
            scope: request.scope,
            state: 'recorded',
            durableTimeout: false,
            requestDigest: digest,
            ...(imageId !== undefined ? { imageId } : {}),
            ...(request.deadlineAt !== undefined ? { deadlineAt: request.deadlineAt } : {}),
            request: {
              command: [...request.command],
              ...(request.env !== undefined ? { envKeys: Object.keys(request.env).sort() } : {}),
              ...(files ? { files } : {}),
            },
          });
          const record = await drive(created.record, request);
          annotate({
            'deuz.process.state': record.state,
            'deuz.process.replayed': created.status === 'existing',
          });
          return sessionOf(record);
        },
      );
    },

    async poll(scope, operationId) {
      return observeSpan(
        deps,
        DEUZ_SPAN.processPoll,
        { [DEUZ_ATTR.processOperationId]: operationId },
        async (annotate) => {
          const record = await refresh(await load(scope, operationId));
          annotate({ 'deuz.process.state': record.state });
          return sessionOf(record);
        },
      );
    },

    async readOutput(scope, operationId) {
      const record = await load(scope, operationId);
      if (
        record.containerId !== undefined &&
        record.startedAt !== undefined &&
        record.state !== 'disposed' &&
        record.state !== 'lost'
      ) {
        try {
          return await engine.logs(record.containerId);
        } catch (error) {
          if (!(error instanceof DockerSandboxError && error.code === 'not_found')) throw error;
        }
      }
      return record.output ?? EMPTY_OUTPUT;
    },

    async readArtifact(scope, operationId, path) {
      if (!isNormalizedRelativePath(path))
        throw new DockerSandboxError(
          'artifact_rejected',
          `An artifact path must be a normalized relative path inside the workspace, got ${JSON.stringify(path)}.`,
        );
      const record = await load(scope, operationId);
      if (record.containerId === undefined)
        throw new DockerSandboxError('not_found', `Operation '${operationId}' has no container.`);
      const info = await engine.inspect(record.containerId);
      if (!info)
        throw new DockerSandboxError('not_found', `The container of '${operationId}' is gone.`);
      if (info.running)
        throw new DockerSandboxError(
          'process_running',
          'Artifacts are read only from a stopped container.',
        );
      const workdir = options.workdir;
      const segments = path.split('/');
      // Every directory on the way must be a directory, not a link out.
      for (let index = 1; index < segments.length; index++) {
        const prefix = segments.slice(0, index).join('/');
        const header = await firstHeader(info.id, `${workdir}/${prefix}`);
        if (!header) throw new DockerSandboxError('not_found', `${prefix} does not exist.`);
        if (header.type !== 'directory')
          throw new DockerSandboxError(
            'artifact_rejected',
            `${prefix} is a ${header.type}, not a directory.`,
          );
      }
      let header: { name: string; type: string; size: number } | undefined;
      const chunks: Uint8Array[] = [];
      await engine.copyOut(
        info.id,
        `${workdir}/${path}`,
        {
          entry(found) {
            if (header) return 'stop';
            header = found;
            return found.type === 'file' && found.size <= options.maxArtifactBytes
              ? 'read'
              : 'stop';
          },
          data(_header, chunk) {
            chunks.push(chunk.slice());
          },
        },
        options.maxArtifactBytes + 64 * 1024,
      );
      if (!header) throw new DockerSandboxError('not_found', `${path} does not exist.`);
      if (header.type !== 'file')
        throw new DockerSandboxError(
          'artifact_rejected',
          `${path} is a ${header.type}, not a regular file.`,
        );
      if (header.size > options.maxArtifactBytes)
        throw new DockerSandboxError(
          'artifact_too_large',
          `${path} is ${header.size} bytes, over maxArtifactBytes (${options.maxArtifactBytes}).`,
        );
      if (header.name !== posixBasename(`/${path}`))
        throw new DockerSandboxError(
          'artifact_rejected',
          `The copy of ${path} held an unexpected entry.`,
        );
      const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const entry = await workspaceDigestEntry(path, bytes);
      return { path, size: entry.size, digest: entry.digest, bytes } satisfies ProcessArtifact;
    },

    async cancel(scope, operationId) {
      return observeSpan(
        deps,
        DEUZ_SPAN.processCancel,
        { [DEUZ_ATTR.processOperationId]: operationId },
        async (annotate) => {
          const record = await cancelRecord(await load(scope, operationId));
          annotate({ 'deuz.process.state': record.state });
          return sessionOf(record);
        },
      );
    },

    async dispose(scope, operationId) {
      let record = await load(scope, operationId);
      if (record.state === 'disposed') return;
      const name = await operationContainerName(scope, operationId);
      let containerId = record.containerId;
      if (containerId === undefined) containerId = (await engine.inspect(name))?.id;
      let output = record.output;
      if (containerId !== undefined) {
        if (!output && record.startedAt !== undefined)
          output = await engine.logs(containerId).catch((error: unknown) => {
            if (isUnavailable(error)) throw error;
            return undefined;
          });
        await engine.remove(containerId, name);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await commit(record, { state: 'disposed', ...(output ? { output } : {}) });
        if (result.ok || result.record.state === 'disposed') break;
        record = result.record;
      }
      clearDeadline(record);
    },

    async reconcile(query = {}) {
      return observeSpan(deps, DEUZ_SPAN.processReconcile, undefined, async (annotate) => {
        const infos = await engine.inspectMany(await engine.listLabelled(query.scope));
        const report: ProcessReconcileReport = { matched: [], orphans: [], lost: [], removed: [] };
        const seen = new Set<string>();
        for (const info of infos) {
          const operationId = info.labels[DEUZ_LABEL.operationId];
          const scope = info.labels[DEUZ_LABEL.scope];
          const kind = info.labels[DEUZ_LABEL.kind];
          // A sandbox run's container or a staging helper has no record: it is
          // an orphan only once no run can still be using it.
          if (
            (kind === 'sandbox' || kind === 'staging') &&
            deps.clock.now() < transientLeaseEnd(info)
          )
            continue;
          let record =
            info.labels[DEUZ_LABEL.kind] === 'process' && operationId && scope
              ? await store.get(scope, operationId)
              : undefined;
          if (
            !record ||
            record.state === 'disposed' ||
            (record.containerId !== undefined && record.containerId !== info.id)
          ) {
            report.orphans.push({
              containerId: info.id,
              ...(operationId !== undefined ? { operationId } : {}),
              ...(scope !== undefined ? { scope } : {}),
            });
            continue;
          }
          seen.add(recordKey(record.scope, record.operationId));
          record = await reconcileRecord(record, info);
          report.matched.push(sessionOf(record));
        }
        let cursor: string | undefined;
        do {
          const page = await store.list({
            ...(query.scope !== undefined ? { scope: query.scope } : {}),
            states: ACTIVE_STATES,
            limit: 1000,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          for (const record of page.records) {
            if (record.containerId === undefined) continue;
            const key = recordKey(record.scope, record.operationId);
            if (seen.has(key)) continue;
            // The container snapshot came first: a container another host (or
            // this one) made since then is not lost. Only a daemon that has no
            // such container makes the record lost.
            const info = await engine.inspect(record.containerId);
            if (info) {
              seen.add(key);
              report.matched.push(sessionOf(await reconcileRecord(record, info)));
              continue;
            }
            const result = await commit(record, { state: 'lost' });
            if (result.ok) report.lost.push(sessionOf(result.record));
          }
          cursor = page.cursor;
        } while (cursor !== undefined);
        if (query.removeOrphans) {
          for (const orphan of report.orphans) {
            await engine.remove(orphan.containerId);
            report.removed.push(orphan.containerId);
          }
          // Only this reconcile's scope: another tenant's volumes are not ours to judge.
          for (const volume of await engine.listDanglingVolumes(query.scope)) {
            await engine.removeVolume(volume);
            report.removed.push(volume);
          }
        }
        annotate({
          'deuz.process.matched': report.matched.length,
          [DEUZ_ATTR.processOrphans]: report.orphans.length,
          'deuz.process.lost': report.lost.length,
          'deuz.process.removed': report.removed.length,
          [DEUZ_ATTR.processReconcileResult]:
            report.orphans.length - report.removed.length > 0 || report.lost.length > 0
              ? 'drift'
              : 'clean',
        });
        return report;
      });
    },
  };

  /** One labelled container's record brought up to date by `reconcile`. */
  async function reconcileRecord(
    record: ProcessOperationRecord,
    info: ContainerInfo,
  ): Promise<ProcessOperationRecord> {
    switch (record.state) {
      case 'recorded':
        // Created, but the host stopped before recording it; or left by an
        // earlier operation under this id, which is never adopted.
        if (!adoptable(record, info)) return (await refuseLeftover(record, info.name)).record;
        return (await commit(record, { state: 'created', containerId: info.id })).record;
      case 'start-dispatched':
      case 'needs-reconcile': {
        if (info.startedAt !== undefined) return follow(record, info);
        if (deps.clock.now() - record.updatedAt < START_SETTLE_MS) return record;
        // The start never happened, and is never retried under this id.
        return (
          await commit(record, {
            state: 'failed',
            endedAt: deps.clock.now(),
            error: {
              name: 'DockerSandboxError',
              message:
                'The start was dispatched but the container never ran; it is not started again.',
              code: 'start_unconfirmed',
            },
          })
        ).record;
      }
      case 'running':
        return follow(record, info);
      case 'cancel-requested':
        return driveCancel(record);
      default:
        return record;
    }
  }

  return runner;
}
