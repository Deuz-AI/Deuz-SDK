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
 */
export function createDockerSandbox(options: DockerSandboxOptions): ComputeSandbox {
  return createDockerSandboxFromOptions(resolveDockerOptions(options, DEFAULT_DOCKER_SANDBOX));
}

/**
 * A reconnectable process runner on local Docker (2.4, preview): records,
 * creates, stages, writes `'start-dispatched'` durably, issues one start and
 * inspects, in that order; reconnects through `store` after a restart.
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
