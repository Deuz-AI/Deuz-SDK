/**
 * `@deuz-sdk/core/compute/docker` (2.4, preview): a local Docker sandbox that
 * fits the `ComputeSandbox` seam, a reconnectable `ProcessRunner`, and the
 * `ProcessOperationStore` it records into (in-memory and SQLite). Node-only:
 * the Docker CLI runs as a child process (`shell: false`). The Node sandbox
 * of `/compute/node` is not a security boundary; this one isolates with
 * Linux containers.
 */
import type { ComputeSandbox } from '../../types/compute';
import type { Dependencies } from '../../types/deps';
import type { DockerSandboxOptions, ProcessOperationStore, ProcessRunner } from './types';
import { createInMemoryProcessOperationStore as createMemoryStore } from './memory-store';
import { resolveDockerOptions } from './engine';
import { createDockerSandboxFromOptions } from './sandbox';
import { createDockerRunnerFromOptions } from './runner';

export type * from './types';
export { OperationConflictError } from '../../errors';
export { DockerSandboxError } from './errors';
export type { DockerErrorCode } from './errors';
export { createSqliteProcessOperationStore } from '../../node/process-ops-sqlite';
export type { SqliteProcessOperationStoreOptions } from '../../node/process-ops-sqlite';

/** The isolation and size defaults of spec §3.3. */
export const DEFAULT_DOCKER_SANDBOX = {
  dockerPath: 'docker',
  user: '10001:10001',
  network: 'none',
  cpus: 1,
  memoryBytes: 512 * 1024 * 1024,
  pids: 128,
  workdir: '/workspace',
  tmpfsBytes: 64 * 1024 * 1024,
  maxStagingBytes: 256 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  /** Between stop and kill on cancel. */
  cancelGraceMs: 2_000,
  /** A sandbox run's timeout when the request names none (2.4 addition). */
  runTimeoutMs: 30_000,
} as const;

/**
 * A `ComputeSandbox` on local Docker (2.4, preview): each `runCode` /
 * `runShell` runs in a fresh container with the default isolation (no
 * network, UID 10001, dropped capabilities, no-new-privileges, limits), the
 * workspace staged in through a bounded archive, `cwd` resolved inside the
 * workspace (outside it refused), output a bounded tail with `truncated`,
 * and the container removed afterwards.
 *
 * Details (2.4): the image resolves once per sandbox to its immutable id
 * (`image_not_found` when it is not local: never pulled); `runShell` runs
 * `/bin/sh -c`, `runCode` the `interpreters` argv prefix plus the code (an
 * image ENTRYPOINT is reset); env values travel in a private env file, never
 * on the command line; a run without `timeoutMs` stops after
 * `DEFAULT_DOCKER_SANDBOX.runTimeoutMs` (30 s), killed with `docker kill`;
 * what the run changes in its workspace stays in the container. Infrastructure
 * failures reject with `DockerSandboxError` (`docker_unavailable`,
 * `image_not_found`, `staging_too_large`, ...); what the program does is the
 * result. Option errors are TypeErrors at creation: `user` must be numeric
 * (`uid` or `uid:gid`), `workdir` absolute, and `deuz.*` labels are the SDK's.
 */
export function createDockerSandbox(options: DockerSandboxOptions): ComputeSandbox {
  return createDockerSandboxFromOptions(resolveDockerOptions(options, DEFAULT_DOCKER_SANDBOX));
}

/**
 * A reconnectable process runner on local Docker (2.4, preview): records,
 * creates, stages, writes `'start-dispatched'` durably, issues one start and
 * inspects, in that order; reconnects through `store` after a restart.
 *
 * Details (2.4): the container is named `deuz-<hash of scope and operation
 * id>`, so a create cut short by a crash is adopted, never repeated. `start`
 * with the same id and request continues the operation wherever it stopped;
 * an operation whose start outcome is unknown is `'needs-reconcile'`, and
 * `reconcile` (once the record is 30 s old) marks it `'failed'` with
 * `start_unconfirmed`, never starting it. A request with `stdin` is started
 * with `docker start --attach --interactive` (the stdin is delivered, then
 * closed). `poll`, `start` and `reconcile` finish a recorded cancel, notice
 * an exit (storing the output tail) or a vanished container (`'lost'`), and
 * cancel a process past its `deadlineAt`. Artifacts: only regular files
 * under the workspace of a stopped container; a link, a directory, a device,
 * a linked parent or a path that leaves the workspace is `artifact_rejected`.
 * A hard link is refused when the archive marks it as one; Docker archives a
 * single hard-linked file as a regular file. Nothing is ever deleted in the
 * background: containers go with `dispose`, orphans with
 * `reconcile({ removeOrphans: true })`, records with `store.prune`.
 */
export function createDockerProcessRunner(
  options: DockerSandboxOptions & { store: ProcessOperationStore },
): ProcessRunner {
  if (!options?.store)
    throw new TypeError('createDockerProcessRunner needs a ProcessOperationStore');
  return createDockerRunnerFromOptions(
    resolveDockerOptions(options, DEFAULT_DOCKER_SANDBOX),
    options.store,
  );
}

/** The in-memory `ProcessOperationStore` (2.4): for tests and one process. */
export function createInMemoryProcessOperationStore(options?: {
  deps?: Dependencies;
}): ProcessOperationStore {
  return createMemoryStore(options);
}
