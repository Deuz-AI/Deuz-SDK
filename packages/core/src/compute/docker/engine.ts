/**
 * The Docker engine layer the sandbox and the process runner share (2.4):
 * resolved options with the spec §3.3 defaults, the `docker create` argv
 * that carries the isolation settings, image resolution (never a pull),
 * workspace staging through a bounded tar archive, inspection, the bounded
 * log tail, and stop/kill/remove. Every call goes through `cli.ts`
 * (`shell: false`).
 */
import { canonicalJson, sha256Hex } from '../../internal/digest';
import { resolveDependencies } from '../../internal/resolve-deps';
import type { ResolvedDependencies } from '../../types/deps';
import type { Workspace } from '../../types/workspace';
import { docker, dockerFailure, execDocker, stdoutText, type DockerCli } from './cli';
import { DockerSandboxError } from './errors';
import { ByteTail } from './output';
import { assertRelativePath, assertWorkdir, posixBasename, posixDirname } from './paths';
import {
  createTarParser,
  tarArchive,
  tarArchiveSize,
  type TarEntryInput,
  type TarParserHandlers,
} from './tar';
import type { DockerSandboxOptions, ProcessOutput } from './types';

/**
 * The value of the `deuz.sdk-version` label: the SDK release that created the
 * container. A test keeps it in step with the package version.
 */
export const DOCKER_LABEL_SDK_VERSION = '2.4.0';

/** The labels every container carries; a host cannot set or override them. */
export const DEUZ_LABEL = {
  operationId: 'deuz.operation-id',
  scope: 'deuz.scope',
  sdkVersion: 'deuz.sdk-version',
  /** `process` (a runner operation), `sandbox` (one sandbox run), `staging` (a read-only staging helper). */
  kind: 'deuz.kind',
  /**
   * A sandbox run's timeout in ms: how long after its start the run kills
   * it, so `reconcile` can tell a live run from one its host left behind.
   */
  runTimeoutMs: 'deuz.run-timeout-ms',
  /**
   * A runner operation's request digest: a create a crash cut short is
   * adopted only by the record whose request made it.
   */
  requestDigest: 'deuz.request-digest',
} as const;

export type ContainerKind = 'process' | 'sandbox' | 'staging';

/** `runCode` interpreters by language when the host gives none. */
export const DEFAULT_DOCKER_INTERPRETERS: Readonly<Record<string, readonly string[]>> = {
  python: ['python3', '-c'],
  python3: ['python3', '-c'],
  bash: ['bash', '-c'],
  sh: ['sh', '-c'],
  shell: ['sh', '-c'],
  javascript: ['node', '-e'],
  js: ['node', '-e'],
  node: ['node', '-e'],
};

export interface ResolvedDockerOptions {
  image: string;
  cli: DockerCli;
  user: string;
  uid: number;
  gid: number;
  cpus: number;
  memoryBytes: number;
  pids: number;
  storageBytes?: number;
  network: string;
  readOnlyRootFilesystem: boolean;
  tmpfsBytes: number;
  maxStagingBytes: number;
  maxArtifactBytes: number;
  maxOutputBytes: number;
  workdir: string;
  workspace?: Workspace;
  scope?: string;
  labels: Record<string, string>;
  interpreters: Readonly<Record<string, readonly string[]>>;
  deps: ResolvedDependencies;
  /** The host passed its own clock: timers go through it (else they never hold the process open). */
  customClock: boolean;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${name} must be a positive integer, got ${String(value)}`);
  return value as number;
}

/** Applies the spec §3.3 defaults and validates; a bad option is a TypeError at creation. */
export function resolveDockerOptions(
  options: DockerSandboxOptions,
  defaults: {
    dockerPath: string;
    user: string;
    network: string;
    cpus: number;
    memoryBytes: number;
    pids: number;
    workdir: string;
    tmpfsBytes: number;
    maxStagingBytes: number;
    maxArtifactBytes: number;
    maxOutputBytes: number;
  },
): ResolvedDockerOptions {
  if (!options || typeof options.image !== 'string' || options.image.trim() === '')
    throw new TypeError('The Docker sandbox needs an explicit image (it never pulls one).');
  const dockerPath = options.dockerPath ?? defaults.dockerPath;
  if (typeof dockerPath !== 'string' || dockerPath === '')
    throw new TypeError('dockerPath must be a non-empty string');
  const dockerArgs = options.dockerArgs ?? [];
  if (!Array.isArray(dockerArgs) || dockerArgs.some((arg) => typeof arg !== 'string'))
    throw new TypeError('dockerArgs must be an array of strings');
  const user = options.user ?? defaults.user;
  const match = /^(\d+)(?::(\d+))?$/.exec(user);
  if (!match)
    throw new TypeError(
      `user must be a numeric 'uid' or 'uid:gid' (staged files are owned by it), got ${JSON.stringify(user)}`,
    );
  const uid = Number(match[1]);
  const gid = Number(match[2] ?? match[1]);
  const limits = options.limits ?? {};
  const cpus = limits.cpus ?? defaults.cpus;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0)
    throw new TypeError(`limits.cpus must be a positive number, got ${String(cpus)}`);
  const workdir = options.workdir ?? defaults.workdir;
  assertWorkdir(workdir);
  const network = options.network ?? defaults.network;
  if (typeof network !== 'string' || network === '')
    throw new TypeError('network must be a non-empty string');
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.labels ?? {})) {
    if (key.startsWith('deuz.'))
      throw new TypeError(`The label ${key} is set by the SDK and cannot be overridden`);
    if (key === '' || typeof value !== 'string')
      throw new TypeError(`Label ${JSON.stringify(key)} needs a string value`);
    labels[key] = value;
  }
  const interpreters: Record<string, readonly string[]> = { ...DEFAULT_DOCKER_INTERPRETERS };
  for (const [language, prefix] of Object.entries(options.interpreters ?? {})) {
    if (!Array.isArray(prefix) || prefix.length === 0 || prefix.some((p) => typeof p !== 'string'))
      throw new TypeError(`interpreters.${language} must be a non-empty argv prefix`);
    interpreters[language] = [...prefix];
  }
  return {
    image: options.image,
    cli: { dockerPath, dockerArgs: [...dockerArgs] },
    user: `${uid}:${gid}`,
    uid,
    gid,
    cpus,
    memoryBytes: positiveInteger(limits.memoryBytes ?? defaults.memoryBytes, 'limits.memoryBytes'),
    pids: positiveInteger(limits.pids ?? defaults.pids, 'limits.pids'),
    ...(limits.storageBytes !== undefined
      ? { storageBytes: positiveInteger(limits.storageBytes, 'limits.storageBytes') }
      : {}),
    network,
    readOnlyRootFilesystem: options.readOnlyRootFilesystem ?? false,
    tmpfsBytes: positiveInteger(options.tmpfsBytes ?? defaults.tmpfsBytes, 'tmpfsBytes'),
    maxStagingBytes: positiveInteger(
      options.maxStagingBytes ?? defaults.maxStagingBytes,
      'maxStagingBytes',
    ),
    maxArtifactBytes: positiveInteger(
      options.maxArtifactBytes ?? defaults.maxArtifactBytes,
      'maxArtifactBytes',
    ),
    maxOutputBytes: positiveInteger(
      options.maxOutputBytes ?? defaults.maxOutputBytes,
      'maxOutputBytes',
    ),
    workdir,
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    labels,
    interpreters,
    deps: resolveDependencies(options.deps),
    customClock: options.deps?.clock !== undefined,
  };
}

/** The deterministic container name of an operation: a create can never make two. */
export async function operationContainerName(scope: string, operationId: string): Promise<string> {
  return `deuz-${(await sha256Hex(canonicalJson([scope, operationId]))).slice(0, 40)}`;
}

/** The workspace volume of a read-only container. */
export const workspaceVolumeName = (containerName: string): string => `${containerName}-ws`;

/** A Docker container name from any id: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. */
export function safeName(text: string): string {
  return text.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
}

/** What `docker create` makes. */
export interface ContainerSpec {
  name: string;
  kind: 'process' | 'sandbox';
  operationId: string;
  scope: string;
  command: readonly string[];
  /** Keep stdin open (`-i`): the start then attaches it. */
  interactive: boolean;
  env?: Readonly<Record<string, string>>;
  /** The working directory of the command; default the workspace. */
  cwd?: string;
  /** A sandbox run's timeout, written to the `deuz.run-timeout-ms` label. */
  runTimeoutMs?: number;
  /** A runner operation's request digest, written to the `deuz.request-digest` label. */
  requestDigest?: string;
}

/** What inspection reports of one container. */
export interface ContainerInfo {
  id: string;
  name: string;
  /** Epoch ms of `docker create`, by the daemon's clock. */
  createdAt?: number;
  imageId: string;
  labels: Record<string, string>;
  status: string;
  running: boolean;
  exitCode: number;
  /** Epoch ms; absent when the container never started. */
  startedAt?: number;
  finishedAt?: number;
  /** The daemon's error for a start that failed (an executable not found, ...). */
  error?: string;
  oomKilled: boolean;
  /** Settings read back, for tests and audits. */
  hostConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  mounts: unknown[];
}

function epoch(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.startsWith('0001-01-01')) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseInfo(line: string): ContainerInfo {
  const raw = JSON.parse(line) as {
    Id: string;
    Created?: string;
    Name?: string;
    Image?: string;
    Config?: { Labels?: Record<string, string> | null } & Record<string, unknown>;
    HostConfig?: Record<string, unknown>;
    Mounts?: unknown[];
    State?: {
      Status?: string;
      Running?: boolean;
      ExitCode?: number;
      StartedAt?: string;
      FinishedAt?: string;
      Error?: string;
      OOMKilled?: boolean;
    };
  };
  const state = raw.State ?? {};
  const startedAt = epoch(state.StartedAt);
  const finishedAt = epoch(state.FinishedAt);
  const createdAt = epoch(raw.Created);
  return {
    id: raw.Id,
    name: (raw.Name ?? '').replace(/^\//, ''),
    ...(createdAt !== undefined ? { createdAt } : {}),
    imageId: raw.Image ?? '',
    labels: raw.Config?.Labels ?? {},
    status: state.Status ?? 'unknown',
    running: state.Running === true,
    exitCode: state.ExitCode ?? 0,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(state.Error ? { error: state.Error } : {}),
    oomKilled: state.OOMKilled === true,
    hostConfig: raw.HostConfig ?? {},
    config: raw.Config ?? {},
    mounts: raw.Mounts ?? [],
  };
}

/** A file to stage: a normalized relative path and its bytes. */
export interface StageFile {
  path: string;
  content: Uint8Array;
}

const encoder = new TextEncoder();
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws a TypeError for an env name or value an env file cannot carry. */
export function assertEnv(env: Readonly<Record<string, string>> | undefined): void {
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(name))
      throw new TypeError(`Invalid environment variable name ${JSON.stringify(name)}`);
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new TypeError(`Environment variable ${name} must be a single-line string`);
  }
}

interface NodeFs {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}
interface NodeOs {
  tmpdir(): string;
}
interface NodePath {
  join(...parts: string[]): string;
}

/**
 * Runs `fn` with an env file holding `env` (mode 0600 in a private temporary
 * directory), removed afterwards: the values never appear in an argv another
 * local user could read in the process list.
 */
async function withEnvFile<T>(
  env: Readonly<Record<string, string>> | undefined,
  fn: (path: string | undefined) => Promise<T>,
): Promise<T> {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return fn(undefined);
  const [fs, os, path] = await Promise.all([
    import('node:fs/promises' as string) as Promise<NodeFs>,
    import('node:os' as string) as Promise<NodeOs>,
    import('node:path' as string) as Promise<NodePath>,
  ]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deuz-env-'));
  try {
    const file = path.join(dir, 'env');
    await fs.writeFile(file, entries.map(([name, value]) => `${name}=${value}\n`).join(''), {
      mode: 0o600,
    });
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface DockerEngine {
  readonly options: ResolvedDockerOptions;
  readonly cli: DockerCli;
  /** The image's immutable id, resolved once (never pulled); a failure is retried next call. */
  resolveImage(): Promise<string>;
  /** `docker create` with the isolation settings; resolves with the container id. */
  create(imageId: string, spec: ContainerSpec): Promise<string>;
  /** Copies `files` into the container's workspace, owned by the run user. */
  stage(
    containerId: string,
    spec: ContainerSpec,
    imageId: string,
    files: readonly StageFile[],
  ): Promise<void>;
  /** The container, or undefined when the daemon has no such container. */
  inspect(ref: string): Promise<ContainerInfo | undefined>;
  /** Every container among `ids` that still exists. */
  inspectMany(ids: readonly string[]): Promise<ContainerInfo[]>;
  /** The labelled containers (`deuz.operation-id`), optionally of one scope. */
  listLabelled(scope?: string): Promise<string[]>;
  /** The labelled volumes no container uses, optionally of one scope. */
  listDanglingVolumes(scope?: string): Promise<string[]>;
  /** The bounded stdout/stderr tails of `docker logs`. */
  logs(containerId: string): Promise<ProcessOutput>;
  /** The one detached start command (`docker start <id>`). */
  start(containerId: string): Promise<void>;
  stop(containerId: string, graceSeconds: number): Promise<void>;
  kill(containerId: string): Promise<void>;
  /** Removes the container and its workspace volume; a missing one is fine. */
  remove(containerId: string, containerName?: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** Streams `docker cp <id>:<path> -` into a tar parser. */
  copyOut(
    containerId: string,
    path: string,
    handlers: TarParserHandlers,
    maxBytes: number,
  ): Promise<void>;
}

export function createDockerEngine(options: ResolvedDockerOptions): DockerEngine {
  const { cli } = options;
  let image: Promise<string> | undefined;

  const labelArgs = (
    kind: ContainerKind,
    operationId: string,
    scope: string,
    extra: Record<string, string> = {},
  ): string[] => {
    const labels: Record<string, string> = {
      ...options.labels,
      ...extra,
      [DEUZ_LABEL.operationId]: operationId,
      [DEUZ_LABEL.scope]: scope,
      [DEUZ_LABEL.sdkVersion]: DOCKER_LABEL_SDK_VERSION,
      [DEUZ_LABEL.kind]: kind,
    };
    return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  };

  const engine: DockerEngine = {
    options,
    cli,

    resolveImage() {
      image ??= (async () => {
        const result = await docker(
          cli,
          ['image', 'inspect', '--format', '{{.Id}}', options.image],
          {
            timeoutMs: 30_000,
          },
        ).catch((error: unknown) => {
          if (error instanceof DockerSandboxError && error.code === 'image_not_found')
            throw new DockerSandboxError(
              'image_not_found',
              `The image ${options.image} is not present locally. The Docker sandbox never pulls: run \`docker pull ${options.image}\` first.`,
              { command: 'image inspect' },
            );
          throw error;
        });
        const id = stdoutText(result).split('\n')[0]?.trim() ?? '';
        if (!/^sha256:[0-9a-f]{64}$/.test(id))
          throw new DockerSandboxError(
            'docker_failed',
            `docker image inspect gave no image id for ${options.image}`,
          );
        return id;
      })();
      image.catch(() => {
        image = undefined;
      });
      return image;
    },

    async create(imageId, spec) {
      assertEnv(spec.env);
      const readOnly = options.readOnlyRootFilesystem;
      if (readOnly)
        await docker(cli, [
          'volume',
          'create',
          ...labelArgs(spec.kind, spec.operationId, spec.scope),
          workspaceVolumeName(spec.name),
        ]);
      const result = await withEnvFile(spec.env, (envFile) =>
        docker(cli, [
          'create',
          '--pull',
          'never',
          '--name',
          spec.name,
          '--user',
          options.user,
          '--workdir',
          spec.cwd ?? options.workdir,
          '--network',
          options.network,
          '--cpus',
          String(options.cpus),
          '--memory',
          String(options.memoryBytes),
          '--memory-swap',
          String(options.memoryBytes),
          '--pids-limit',
          String(options.pids),
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--restart',
          'no',
          ...(options.storageBytes !== undefined
            ? ['--storage-opt', `size=${options.storageBytes}`]
            : []),
          ...(readOnly
            ? [
                '--read-only',
                '--tmpfs',
                `/tmp:rw,nosuid,nodev,size=${options.tmpfsBytes},mode=1777`,
                '--mount',
                `type=volume,src=${workspaceVolumeName(spec.name)},dst=${options.workdir}`,
              ]
            : []),
          ...(spec.interactive ? ['--interactive'] : []),
          ...(envFile !== undefined ? ['--env-file', envFile] : []),
          ...labelArgs(spec.kind, spec.operationId, spec.scope, {
            ...(spec.runTimeoutMs !== undefined
              ? { [DEUZ_LABEL.runTimeoutMs]: String(spec.runTimeoutMs) }
              : {}),
            ...(spec.requestDigest !== undefined
              ? { [DEUZ_LABEL.requestDigest]: spec.requestDigest }
              : {}),
          }),
          // The argv runs as given: an image ENTRYPOINT would prefix it.
          '--entrypoint=',
          imageId,
          ...spec.command,
        ]),
      );
      const id = stdoutText(result).split('\n').pop()?.trim() ?? '';
      if (!/^[0-9a-f]{12,64}$/.test(id))
        throw new DockerSandboxError('docker_failed', 'docker create printed no container id', {
          command: 'create',
        });
      return id;
    },

    async stage(containerId, spec, imageId, files) {
      const base = posixBasename(options.workdir);
      const mtime = Math.floor(options.deps.clock.now() / 1000);
      const owner = { uid: options.uid, gid: options.gid, mtime };
      const directories = new Set<string>();
      for (const file of files) {
        assertRelativePath(file.path, 'A staged file path');
        const parts = file.path.split('/');
        for (let index = 1; index < parts.length; index++)
          directories.add(parts.slice(0, index).join('/'));
      }
      const entries: TarEntryInput[] = [
        { path: base, type: 'directory', ...owner },
        ...[...directories]
          .sort()
          .map((dir) => ({ path: `${base}/${dir}`, type: 'directory' as const, ...owner })),
        ...files.map((file) => ({
          path: `${base}/${file.path}`,
          type: 'file' as const,
          content: file.content,
          ...owner,
        })),
      ];
      const archive = tarArchive(entries);
      if (archive.byteLength > options.maxStagingBytes)
        throw new DockerSandboxError(
          'staging_too_large',
          `The staging archive is ${archive.byteLength} bytes, over maxStagingBytes (${options.maxStagingBytes}).`,
        );
      const destination = posixDirname(options.workdir);
      if (!options.readOnlyRootFilesystem) {
        await docker(cli, ['cp', '--archive', '-', `${containerId}:${destination}`], {
          stdin: archive,
          timeoutMs: 600_000,
        });
        return;
      }
      // A read-only root refuses `docker cp`: stage into the workspace volume
      // through a helper container that mounts it and is never started.
      const helper = `${spec.name}-stage`;
      await docker(cli, ['rm', '--force', helper]);
      await docker(cli, [
        'create',
        '--pull',
        'never',
        '--name',
        helper,
        '--network',
        'none',
        '--mount',
        `type=volume,src=${workspaceVolumeName(spec.name)},dst=${options.workdir}`,
        ...labelArgs('staging', spec.operationId, spec.scope),
        '--entrypoint=',
        imageId,
        'deuz-staging-helper',
      ]);
      try {
        await docker(cli, ['cp', '--archive', '-', `${helper}:${destination}`], {
          stdin: archive,
          timeoutMs: 600_000,
        });
      } finally {
        await docker(cli, ['rm', '--force', helper]);
      }
    },

    async inspect(ref) {
      const result = await execDocker(
        cli,
        ['container', 'inspect', '--format', '{{json .}}', ref],
        {
          timeoutMs: 30_000,
        },
      );
      if (result.code !== 0) {
        const error = dockerFailure(['container', 'inspect'], result);
        if (error.code === 'not_found') return undefined;
        throw error;
      }
      const line = stdoutText(result).split('\n')[0];
      return line ? parseInfo(line) : undefined;
    },

    async inspectMany(ids) {
      const found: ContainerInfo[] = [];
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        const result = await execDocker(
          cli,
          ['container', 'inspect', '--format', '{{json .}}', ...batch],
          {
            timeoutMs: 60_000,
          },
        );
        // A container removed meanwhile makes the command fail for the batch
        // but still prints the others.
        if (result.code !== 0) {
          const error = dockerFailure(['container', 'inspect'], result);
          if (error.code !== 'not_found') throw error;
        }
        for (const line of stdoutText(result).split('\n'))
          if (line.trim().startsWith('{')) found.push(parseInfo(line));
      }
      return found;
    },

    async listLabelled(scope) {
      const result = await docker(cli, [
        'ps',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        `label=${DEUZ_LABEL.operationId}`,
        ...(scope !== undefined ? ['--filter', `label=${DEUZ_LABEL.scope}=${scope}`] : []),
      ]);
      return stdoutText(result)
        .split('\n')
        .map((id) => id.trim())
        .filter(Boolean);
    },

    async listDanglingVolumes(scope) {
      const result = await docker(cli, [
        'volume',
        'ls',
        '--quiet',
        '--filter',
        `label=${DEUZ_LABEL.operationId}`,
        ...(scope !== undefined ? ['--filter', `label=${DEUZ_LABEL.scope}=${scope}`] : []),
        '--filter',
        'dangling=true',
      ]);
      return stdoutText(result)
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean);
    },

    async logs(containerId) {
      const stdout = new ByteTail(options.maxOutputBytes);
      const stderr = new ByteTail(options.maxOutputBytes);
      await docker(cli, ['logs', containerId], {
        timeoutMs: 120_000,
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      });
      return {
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
      };
    },

    async start(containerId) {
      await docker(cli, ['start', containerId], { timeoutMs: 120_000 });
    },

    async stop(containerId, graceSeconds) {
      // -t: `--time` on old CLIs, `--timeout` on new ones.
      await docker(cli, ['stop', '-t', String(graceSeconds), containerId], {
        timeoutMs: (graceSeconds + 30) * 1000,
      });
    },

    async kill(containerId) {
      await docker(cli, ['kill', containerId], { timeoutMs: 30_000 });
    },

    async remove(containerId, containerName) {
      await docker(cli, ['rm', '--force', '--volumes', containerId], { timeoutMs: 60_000 });
      if (containerName !== undefined && options.readOnlyRootFilesystem)
        await engine.removeVolume(workspaceVolumeName(containerName));
    },

    async removeVolume(name) {
      const result = await execDocker(cli, ['volume', 'rm', '--force', name], {
        timeoutMs: 60_000,
      });
      if (result.code !== 0) throw dockerFailure(['volume', 'rm'], result);
    },

    async copyOut(containerId, path, handlers, maxBytes) {
      const parser = createTarParser(handlers);
      let total = 0;
      let tooLarge = false;
      const result = await execDocker(cli, ['cp', `${containerId}:${path}`, '-'], {
        timeoutMs: 600_000,
        onStdout: (chunk) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            tooLarge = true;
            return false;
          }
          return parser.write(chunk);
        },
      });
      if (tooLarge)
        throw new DockerSandboxError(
          'artifact_too_large',
          `The copy of ${path} exceeds ${maxBytes} bytes.`,
          {
            command: 'cp',
          },
        );
      if (result.stopped) return;
      if (result.code !== 0) throw dockerFailure(['cp'], result);
      parser.finish();
    },
  };
  return engine;
}

/**
 * The files to stage: the workspace's (when the options have one) and the
 * request's, which win on a shared path. The archive's size is checked
 * against `maxStagingBytes` from the listed sizes before any content is read.
 */
export async function collectStageFiles(
  options: ResolvedDockerOptions,
  requestFiles: readonly { path: string; content: string | Uint8Array }[] = [],
): Promise<StageFile[]> {
  const fromRequest = new Map<string, Uint8Array>();
  for (const file of requestFiles) {
    assertRelativePath(file.path, 'A staged file path');
    fromRequest.set(
      file.path,
      typeof file.content === 'string' ? encoder.encode(file.content) : file.content,
    );
  }
  const listed = options.workspace ? await options.workspace.list() : [];
  const fromWorkspace = listed.filter((entry) => !fromRequest.has(entry.path));
  const estimate = tarArchiveSize([
    ...fromWorkspace.map((entry) => ({ path: `w/${entry.path}`, size: entry.size })),
    ...[...fromRequest].map(([path, content]) => ({ path: `w/${path}`, size: content.byteLength })),
  ]);
  if (estimate > options.maxStagingBytes)
    throw new DockerSandboxError(
      'staging_too_large',
      `The workspace and request files need about ${estimate} bytes of staging archive, over maxStagingBytes (${options.maxStagingBytes}).`,
    );
  const files: StageFile[] = [];
  const workspace = options.workspace;
  for (const entry of fromWorkspace) {
    assertRelativePath(entry.path, 'A workspace path');
    const content = workspace!.readBytes
      ? await workspace!.readBytes(entry.path)
      : encoder.encode(await workspace!.read(entry.path));
    files.push({ path: entry.path, content });
  }
  for (const [path, content] of fromRequest) files.push({ path, content });
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** The output collected so far as a `ProcessOutput`. */
export function tailOutput(stdout: ByteTail, stderr: ByteTail): ProcessOutput {
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
  };
}
