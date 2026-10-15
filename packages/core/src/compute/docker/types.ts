/**
 * Local Docker sandbox and reconnectable processes (2.4, preview, spec §3.3).
 * Node-only: the Docker CLI is called with `shell: false` (its path
 * configurable, only Docker is tested), Linux containers are the target, and
 * a process outlives its host process: `ProcessOperationStore` records every
 * step, so a restarted host reconnects instead of starting twice.
 *
 * Defaults (`DEFAULT_DOCKER_SANDBOX`): the image is given explicitly, never
 * pulled, and resolved to its immutable id; UID/GID 10001, no network, 1 CPU,
 * 512 MiB, 128 PIDs; every capability dropped, `no-new-privileges`,
 * `restart=no`; no host workspace or Docker socket mounted; labels
 * `deuz.operation-id`, `deuz.scope` and `deuz.sdk-version` on every
 * container; 256 MiB staging and 64 MiB artifact limits.
 *
 * Names are prefixed to stay apart from the A2A artifact, `ComputeArtifact`
 * and the stream cursor: `ProcessArtifact`, `ProcessSession`.
 */
import type { Sha256Digest } from '../../internal/digest';
import type { Dependencies } from '../../types/deps';
import type { Workspace } from '../../types/workspace';

/** Container resource limits. */
export interface DockerLimits {
  /** CPUs. Default 1. */
  cpus?: number;
  /** Memory in bytes. Default 512 MiB. */
  memoryBytes?: number;
  /** Processes. Default 128. */
  pids?: number;
  /**
   * The writable layer's size (`--storage-opt size`), only on storage
   * drivers that support it. Unset by default: a container can fill the
   * host's disk through its writable layer otherwise (documented).
   */
  storageBytes?: number;
}

/** Options shared by the Docker sandbox and the process runner. */
export interface DockerSandboxOptions {
  /** The image, required; never pulled automatically; resolved to its immutable id. */
  image: string;
  /** The Docker CLI, run with `shell: false`. Default `'docker'`. */
  dockerPath?: string;
  /**
   * Global CLI arguments placed before every subcommand, e.g.
   * `['--context', 'build-box']` or `['--host', 'ssh://runner']` (2.4).
   * Default none: the CLI's environment and config decide.
   */
  dockerArgs?: readonly string[];
  /**
   * `uid:gid` (or `uid`), numeric: staged files are owned by it. Default
   * `'10001:10001'`.
   */
  user?: string;
  limits?: DockerLimits;
  /** The container network. Default `'none'`. */
  network?: string;
  /**
   * `--read-only` root with a size-bounded tmpfs `/tmp` and a writable
   * workspace. Default false: some images write to their root.
   */
  readOnlyRootFilesystem?: boolean;
  /** The tmpfs `/tmp` size with `readOnlyRootFilesystem`. Default 64 MiB. */
  tmpfsBytes?: number;
  /** The staging archive at most. Default 256 MiB. */
  maxStagingBytes?: number;
  /** One artifact read at most. Default 64 MiB. */
  maxArtifactBytes?: number;
  /** The output tail kept per stream. Default 1 MiB; beyond it `truncated` is set. */
  maxOutputBytes?: number;
  /**
   * The workspace path inside the container, absolute. Default
   * `'/workspace'`. Its parent must exist in the image (`docker create`
   * makes the workspace itself).
   */
  workdir?: string;
  /** Files copied into the container workspace through a controlled staging archive. */
  workspace?: Workspace;
  /** The tenancy scope, written to the `deuz.scope` label. */
  scope?: string;
  /** Extra labels; the `deuz.*` ones are always set and cannot be overridden. */
  labels?: Record<string, string>;
  /** `runCode` interpreters by language, as argv prefixes, e.g. `{ python: ['python3', '-c'] }`. */
  interpreters?: Record<string, readonly string[]>;
  /** Clock, ids, logger, observer (`deuz.process.*` spans). */
  deps?: Dependencies;
}

/** What to start. */
export interface ProcessStartRequest {
  /** The idempotency key: the same id with another request throws `OperationConflictError`. */
  operationId: string;
  scope: string;
  /** The argv run in the container, without a shell. */
  command: readonly string[];
  /** Files staged into the workspace before the start. */
  files?: readonly { path: string; content: string | Uint8Array }[];
  env?: Record<string, string>;
  stdin?: string;
  /**
   * Epoch ms after which the process is cancelled. Not durable: nothing ends
   * it while the host is down; a reconnect past it cancels it.
   */
  deadlineAt?: number;
}

/**
 * Where a process operation stands. The start order is fixed: `'recorded'` →
 * `'created'` (container) → `'staged'` → `'start-dispatched'` (durable before
 * the single start command) → `'running'` → `'exited'`.
 */
export type ProcessState =
  | 'recorded'
  | 'created'
  | 'staged'
  | 'start-dispatched'
  | 'running'
  | 'exited'
  /** A cancel was recorded; stop, 2 s grace, kill, verify follow. */
  | 'cancel-requested'
  | 'cancelled'
  /** The start's outcome is unknown: only `reconcile` resolves it. */
  | 'needs-reconcile'
  /** The container vanished; never recreated under the same operation id. */
  | 'lost'
  | 'failed'
  | 'disposed';

/** A process operation as the runner reports it. */
export interface ProcessSession {
  operationId: string;
  scope: string;
  state: ProcessState;
  containerId?: string;
  /** The immutable image id the container runs. */
  imageId?: string;
  exitCode?: number | null;
  startedAt?: number;
  endedAt?: number;
  deadlineAt?: number;
  /** Always false: see `ProcessStartRequest.deadlineAt`. */
  durableTimeout: false;
  /** Canonical-JSON `sha256:<hex>` of the start request. */
  requestDigest: Sha256Digest;
  error?: { name: string; message: string; code?: string };
}

/** A bounded output tail; `truncated` says what was dropped. */
export interface ProcessOutput {
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
}

/**
 * A file read from a stopped container (2.4): only a regular file under the
 * workspace, size-checked; symlinks, hard links and path traversal are
 * refused. Never applied to the host workspace automatically.
 */
export interface ProcessArtifact {
  /** A normalized relative workspace path. */
  path: string;
  size: number;
  /** `sha256:<hex>` of the content: the workspace-entry digest's per-file part. */
  digest: Sha256Digest;
  bytes: Uint8Array;
  mime?: string;
}

/** What `reconcile` found. */
export interface ProcessReconcileReport {
  /** Labelled containers matched to their records, states refreshed. */
  matched: ProcessSession[];
  /**
   * Labelled containers with no record: reported, removed only with
   * `removeOrphans`. A sandbox run's container or a staging helper never has
   * a record; it is reported only once no run can still be using it: 30 min
   * after its create (never started) or its exit; while it runs, 30 min past
   * its start plus its `deuz.run-timeout-ms` label (never without the label).
   */
  orphans: { containerId: string; operationId?: string; scope?: string }[];
  /** Records whose container is gone: marked `'lost'`, never recreated. */
  lost: ProcessSession[];
  /** Orphan containers, and dangling labelled volumes of the scope, removed by this call. */
  removed: string[];
}

/**
 * A reconnectable process runner (2.4, preview). A running or exited
 * container is never started again; a start whose outcome is unknown needs
 * `reconcile`. A cancel is recorded first, then stop, a 2 s grace, kill if
 * needed and a state check; it is not complete while the daemon is
 * unreachable.
 */
export interface ProcessRunner {
  start(request: ProcessStartRequest): Promise<ProcessSession>;
  poll(scope: string, operationId: string): Promise<ProcessSession>;
  readOutput(scope: string, operationId: string): Promise<ProcessOutput>;
  /** Only from a stopped container. */
  readArtifact(scope: string, operationId: string, path: string): Promise<ProcessArtifact>;
  cancel(scope: string, operationId: string): Promise<ProcessSession>;
  /** Removes the container; the record stays (`'disposed'`) until pruned. */
  dispose(scope: string, operationId: string): Promise<void>;
  /** Matches labelled containers to the store. Orphans are removed only on request. */
  reconcile(options?: { scope?: string; removeOrphans?: boolean }): Promise<ProcessReconcileReport>;
}

/** A stored process operation. */
export interface ProcessOperationRecord extends ProcessSession {
  /** 1 when recorded, plus one on every update: the compare-and-set fence. */
  revision: number;
  /** The start request without its file contents and env values. */
  request: { command: string[]; envKeys?: string[]; files?: { path: string; size: number }[] };
  /** The output tail kept at exit. */
  output?: ProcessOutput;
  createdAt: number;
  updatedAt: number;
}

/** Which records to list. */
export interface ProcessOperationQuery {
  scope?: string;
  states?: readonly ProcessState[];
  /** 1..1000. Default 100. */
  limit?: number;
  cursor?: string;
}

/**
 * Where process operations are recorded (2.4): in-memory and SQLite only
 * (a container lives on one host's daemon, so no PostgreSQL store). New
 * tables with their own schema version table.
 */
export interface ProcessOperationStore {
  /**
   * Records a new operation at revision 1, or returns the stored one for the
   * same id and digest; another digest throws `OperationConflictError`
   * (subsystem `'process'`).
   */
  create(
    record: Omit<ProcessOperationRecord, 'revision' | 'createdAt' | 'updatedAt'>,
  ): Promise<{ status: 'created' | 'existing'; record: ProcessOperationRecord }>;
  get(scope: string, operationId: string): Promise<ProcessOperationRecord | undefined>;
  /**
   * Applies `changes` only at `expectedRevision`. A key set to `undefined`
   * removes that field; `createdAt` never changes and `updatedAt` is the
   * store's clock.
   */
  update(
    scope: string,
    operationId: string,
    changes: Partial<Omit<ProcessOperationRecord, 'operationId' | 'scope' | 'revision'>>,
    options: { expectedRevision: number },
  ): Promise<
    | { status: 'committed'; record: ProcessOperationRecord }
    | { status: 'conflict'; record?: ProcessOperationRecord }
  >;
  list(
    query?: ProcessOperationQuery,
  ): Promise<{ records: ProcessOperationRecord[]; cursor?: string }>;
  /**
   * Retention: deletes terminal records (exited, cancelled, lost, failed,
   * disposed) last updated before `terminalBefore` (epoch ms on the store
   * clock; a record updated exactly then stays) and returns how many. A
   * malformed cutoff throws a TypeError. Containers are removed by
   * `dispose`, not here; nothing is deleted in the background.
   */
  prune(options: { terminalBefore: number }): Promise<number>;
  close?(): Promise<void>;
}
