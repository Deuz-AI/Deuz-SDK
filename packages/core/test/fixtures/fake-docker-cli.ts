/**
 * A fake Docker CLI for the runner's unit tests (2.4). The tests bundle this
 * file with esbuild and point `dockerPath` at node and `dockerArgs` at the
 * bundle: `node fake-docker.mjs --state <dir> <docker args...>`. It emulates
 * the slice of a daemon the runner uses, with its state in `<dir>/state.json`
 * (guarded by a lock directory, since commands run concurrently) and every
 * invocation's argv appended to `<dir>/calls.jsonl`.
 *
 * Containers do not run real programs. A container's command is a tiny op
 * script (see `run`), executed at start: `echo hi ; exit 3`, `sleep`, `write
 * out.txt data`, ... `sh -c "<script>"` and `<interpreter> -c|-e <script>`
 * run the script, so runCode and runShell drive it too.
 *
 * Faults (`state.faults`) make the next matching command fail in a chosen
 * way: unreachable daemon, failure before or after the action, a hang, or a
 * stop/kill that does nothing. Its own tar code is independent of the
 * runner's, on purpose.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

type FileType = 'file' | 'dir' | 'symlink' | 'hardlink';

interface FakeFile {
  type: FileType;
  /** base64 */
  content?: string;
  linkName?: string;
  uid: number;
  gid: number;
  mode: number;
}

interface FakeMount {
  type: 'volume' | 'tmpfs';
  source?: string;
  target: string;
}

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  command: string[];
  user: string;
  workdir: string;
  env: Record<string, string>;
  createArgs: string[];
  interactive: boolean;
  readOnly: boolean;
  mounts: FakeMount[];
  state: 'created' | 'running' | 'exited';
  exitCode: number;
  /** When `docker create` made it (inspect's `Created`). */
  created?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  startCount: number;
  stdin?: string;
  stdout: string;
  stderr: string;
  /** What a running container does on stop: 'term' exits 143, 'ignore' only dies to kill. */
  onTerm?: 'term' | 'ignore';
  files: Record<string, FakeFile>;
}

export interface FakeFault {
  /** The subcommand it hits: 'start', 'stop', 'image', 'cp', ... or '*'. */
  command: string;
  /** `trickle` writes a line to stdout every 20 ms for ever: a log too long to read in time. */
  mode: 'unreachable' | 'fail-before' | 'fail-after' | 'hang' | 'noop' | 'trickle';
  /** How many invocations it hits. Default 1. */
  times?: number;
  stderr?: string;
  code?: number;
}

export interface FakeState {
  images: Record<string, string>;
  containers: Record<string, FakeContainer>;
  volumes: Record<string, { labels: Record<string, string>; files: Record<string, FakeFile> }>;
  faults: FakeFault[];
  nextId: number;
  /** Every command answers like a stopped daemon. */
  unreachable?: boolean;
}

const UNREACHABLE =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

const argv = process.argv.slice(2);
if (argv[0] !== '--state') {
  process.stderr.write('fake docker: --state <dir> first\n');
  process.exit(2);
}
const dir = argv[1]!;
const args = argv.slice(2);
const statePath = join(dir, 'state.json');
const lockPath = join(dir, 'lock');

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the process that took the lock is gone (killed while holding it). */
function lockIsStale(): boolean {
  try {
    const pid = Number(readFileSync(join(lockPath, 'pid'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('no pid yet');
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    // No pid file yet: the holder is between mkdir and its write.
    try {
      return Date.now() - statSync(lockPath).mtimeMs > 10_000;
    } catch {
      return false;
    }
  }
}

function withLock<T>(fn: (state: FakeState) => T): T {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'pid'), String(process.pid));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('fake docker: lock timeout');
      if (lockIsStale()) rmSync(lockPath, { recursive: true, force: true });
      sleepSync(3);
    }
  }
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
    const result = fn(state);
    // Atomic: a command killed mid-write never leaves half a state behind.
    const temp = `${statePath}.${process.pid}`;
    writeFileSync(temp, JSON.stringify(state));
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, statePath);
        break;
      } catch (error) {
        // Windows refuses to replace a file a test is reading at that moment.
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 200 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
          throw error;
        sleepSync(5);
      }
    }
    return result;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function readState(): FakeState {
  return withLock((state) => state);
}

const out = (text: string | Uint8Array) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

/** Ends the command with an error; thrown, so a lock held around it is released. */
class FakeExit extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function fail(message: string, code = 1): never {
  throw new FakeExit(message, code);
}

function readStdin(): Uint8Array {
  try {
    return new Uint8Array(readFileSync(0));
  } catch {
    return new Uint8Array();
  }
}

// ---------------------------------------------------------------- tar (own)

function tarHeader(
  name: string,
  type: string,
  size: number,
  file: FakeFile,
  link = '',
): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, width: number, value: string) =>
    block.set(new TextEncoder().encode(value).subarray(0, width), offset);
  const oct = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
  put(0, 100, name);
  put(100, 8, oct(file.mode, 8));
  put(108, 8, oct(file.uid, 8));
  put(116, 8, oct(file.gid, 8));
  put(124, 12, oct(size, 12));
  put(136, 12, oct(0, 12));
  put(156, 1, type);
  put(157, 100, link);
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : block[index]!;
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return block;
}

function writeTar(entries: { name: string; file: FakeFile }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const { name, file } of entries) {
    const content =
      file.type === 'file' && file.content ? Buffer.from(file.content, 'base64') : Buffer.alloc(0);
    const type = { file: '0', dir: '5', symlink: '2', hardlink: '1' }[file.type];
    const encoded = new TextEncoder().encode(name);
    if (encoded.byteLength > 100) {
      const record = ` path=${name}\n`;
      let length = Buffer.byteLength(record) + 1;
      while (length !== Buffer.byteLength(record) + String(length).length)
        length = Buffer.byteLength(record) + String(length).length;
      const pax = Buffer.from(`${length}${record}`);
      parts.push(tarHeader('PaxHeader', 'x', pax.byteLength, file), pax);
      parts.push(new Uint8Array((512 - (pax.byteLength % 512)) % 512));
    }
    parts.push(tarHeader(name.slice(0, 100), type, content.byteLength, file, file.linkName ?? ''));
    parts.push(content, new Uint8Array((512 - (content.byteLength % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

function readTar(bytes: Uint8Array): { name: string; file: FakeFile }[] {
  const entries: { name: string; file: FakeFile }[] = [];
  const text = (from: number, width: number) => {
    const field = bytes.subarray(from, from + width);
    const end = field.indexOf(0);
    return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
  };
  let offset = 0;
  let paxPath: string | undefined;
  while (offset + 512 <= bytes.byteLength) {
    const headerAt = offset;
    const block = bytes.subarray(headerAt, headerAt + 512);
    if (block.every((b) => b === 0)) break;
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 32 : block[index]!;
    if (sum !== parseInt(text(headerAt + 148, 8).trim(), 8)) fail('fake docker: bad tar checksum');
    const size = parseInt(text(headerAt + 124, 12).trim() || '0', 8);
    const type = text(headerAt + 156, 1);
    const body = bytes.subarray(headerAt + 512, headerAt + 512 + size);
    offset = headerAt + 512 + size + ((512 - (size % 512)) % 512);
    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
      paxPath = match?.[1];
      continue;
    }
    const name = paxPath ?? text(headerAt, 100);
    paxPath = undefined;
    const kind: FileType =
      type === '5' ? 'dir' : type === '2' ? 'symlink' : type === '1' ? 'hardlink' : 'file';
    entries.push({
      name: name.replace(/\/$/, ''),
      file: {
        type: kind,
        ...(kind === 'file' ? { content: Buffer.from(body).toString('base64') } : {}),
        ...(kind === 'symlink' || kind === 'hardlink'
          ? { linkName: text(headerAt + 157, 100) }
          : {}),
        uid: parseInt(text(headerAt + 108, 8).trim() || '0', 8),
        gid: parseInt(text(headerAt + 116, 8).trim() || '0', 8),
        mode: parseInt(text(headerAt + 100, 8).trim() || '0', 8),
      },
    });
  }
  return entries;
}

// ------------------------------------------------------------ filesystem

function posixJoin(base: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${base}/${path}`).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return `/${stack.join('/')}`;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/** Where `path` lives: a volume mounted over it, else the container's rootfs. */
function store(
  state: FakeState,
  container: FakeContainer,
  path: string,
): { files: Record<string, FakeFile>; key: string; onVolume: boolean } {
  const mount = container.mounts
    .filter((m) => m.type === 'volume' && (path === m.target || path.startsWith(`${m.target}/`)))
    .sort((a, b) => b.target.length - a.target.length)[0];
  if (mount?.source) {
    const volume = (state.volumes[mount.source] ??= { labels: {}, files: {} });
    return { files: volume.files, key: path.slice(mount.target.length) || '/', onVolume: true };
  }
  return { files: container.files, key: path, onVolume: false };
}

function getFile(state: FakeState, container: FakeContainer, path: string): FakeFile | undefined {
  const located = store(state, container, path);
  return located.files[located.key];
}

function putFile(state: FakeState, container: FakeContainer, path: string, file: FakeFile): void {
  const located = store(state, container, path);
  located.files[located.key] = file;
}

/** Follows symlinks in every component but the last, inside the container. */
function resolveParents(state: FakeState, container: FakeContainer, path: string): string {
  const parts = path.split('/').filter(Boolean);
  let current = '/';
  for (let index = 0; index < parts.length - 1; index++) {
    current = posixJoin(current, parts[index]!);
    const file = getFile(state, container, current);
    if (file?.type === 'symlink') current = posixJoin(parentOf(current), file.linkName!);
  }
  return parts.length ? posixJoin(current, parts[parts.length - 1]!) : '/';
}

function userIds(container: FakeContainer): { uid: number; gid: number } {
  const [uid, gid] = container.user.split(':');
  return { uid: Number(uid ?? 0), gid: Number(gid ?? uid ?? 0) };
}

// ------------------------------------------------------------- programs

function scriptOf(command: string[]): string[] {
  if (command.length >= 3 && (command[1] === '-c' || command[1] === '-e'))
    return command[2]!.split(/\s+/).filter(Boolean);
  return command;
}

/** Runs the op script; `sleep` / `sleep-hard` leave the container running. */
function run(state: FakeState, container: FakeContainer): void {
  const tokens = scriptOf(container.command);
  const ops: string[][] = [[]];
  for (const token of tokens) {
    if (token === ';') ops.push([]);
    else ops[ops.length - 1]!.push(token);
  }
  const ids = userIds(container);
  const writable = (path: string) => {
    const parent = getFile(state, container, parentOf(path));
    const ro = container.readOnly && !store(state, container, path).onVolume;
    return !ro && (ids.uid === 0 || (parent !== undefined && parent.uid === ids.uid));
  };
  let exitCode = 0;
  for (const [op, ...rest] of ops) {
    if (op === undefined) continue;
    const at = (p: string) => posixJoin(container.workdir, p);
    switch (op) {
      case 'echo':
        container.stdout += `${rest.join(' ')}\n`;
        break;
      case 'stderr':
        container.stderr += `${rest.join(' ')}\n`;
        break;
      case 'emit':
        container.stdout += (rest[1] ?? 'x').repeat(Number(rest[0]));
        break;
      case 'emit-err':
        container.stderr += (rest[1] ?? 'e').repeat(Number(rest[0]));
        break;
      case 'cat':
        container.stdout += container.stdin ?? '';
        break;
      case 'pwd':
        container.stdout += `${container.workdir}\n`;
        break;
      case 'id':
        container.stdout += `${container.user}\n`;
        break;
      case 'env':
        container.stdout += `${container.env[rest[0]!] ?? ''}\n`;
        break;
      case 'ls': {
        const prefix = `${container.workdir}/`;
        const all = new Set<string>();
        for (const path of Object.keys(container.files)) if (path.startsWith(prefix)) all.add(path);
        for (const mount of container.mounts)
          if (mount.source && mount.target === container.workdir)
            for (const key of Object.keys(state.volumes[mount.source]?.files ?? {}))
              all.add(key === '/' ? mount.target : `${mount.target}${key}`);
        for (const path of [...all].sort()) {
          const file = getFile(state, container, path)!;
          if (path === container.workdir) continue;
          container.stdout += `${path.slice(prefix.length)} ${file.type} ${file.uid}\n`;
        }
        break;
      }
      case 'write':
      case 'mkdir':
      case 'symlink':
      case 'hardlink': {
        const path = at(rest[0]!);
        if (!writable(path)) {
          container.stderr += `${op}: ${path}: Permission denied\n`;
          exitCode = 1;
          break;
        }
        const base = { uid: ids.uid, gid: ids.gid };
        const file: FakeFile =
          op === 'write'
            ? {
                type: 'file',
                content: Buffer.from(rest.slice(1).join(' ')).toString('base64'),
                mode: 0o644,
                ...base,
              }
            : op === 'mkdir'
              ? { type: 'dir', mode: 0o755, ...base }
              : { type: op, linkName: rest[1]!, mode: 0o777, ...base };
        putFile(state, container, path, file);
        break;
      }
      case 'big': {
        const path = at(rest[0]!);
        putFile(state, container, path, {
          type: 'file',
          content: Buffer.alloc(Number(rest[1])).toString('base64'),
          mode: 0o644,
          ...ids,
        });
        break;
      }
      case 'exit':
        exitCode = Number(rest[0]);
        break;
      case 'sleep':
        container.onTerm = 'term';
        return;
      case 'sleep-hard':
        container.onTerm = 'ignore';
        return;
      default:
        container.stderr += `fake: ${op}: not found\n`;
        exitCode = 127;
    }
  }
  container.state = 'exited';
  container.exitCode = exitCode;
  container.finishedAt = new Date().toISOString();
}

// ------------------------------------------------------------- commands

function findContainer(state: FakeState, ref: string): FakeContainer | undefined {
  return (
    state.containers[ref] ??
    Object.values(state.containers).find(
      (c) => c.name === ref || c.name === ref.replace(/^\//, '') || c.id.startsWith(ref),
    )
  );
}

function needContainer(state: FakeState, ref: string): FakeContainer {
  const container = findContainer(state, ref);
  if (!container) fail(`Error response from daemon: No such container: ${ref}`);
  return container;
}

function inspectJson(container: FakeContainer): string {
  const value = (flag: string) => {
    const index = container.createArgs.indexOf(flag);
    return index === -1 ? undefined : container.createArgs[index + 1];
  };
  const all = (flag: string) =>
    container.createArgs.flatMap((arg, index, list) =>
      arg === flag && list[index + 1] !== undefined ? [list[index + 1]!] : [],
    );
  return JSON.stringify({
    Id: container.id,
    Created: container.created ?? '0001-01-01T00:00:00Z',
    Name: `/${container.name}`,
    Image: container.image,
    Config: {
      Labels: container.labels,
      User: container.user,
      WorkingDir: container.workdir,
      Image: container.image,
      Cmd: container.command,
      OpenStdin: container.interactive,
    },
    HostConfig: {
      NetworkMode: value('--network') ?? 'bridge',
      ReadonlyRootfs: container.readOnly,
      CapDrop: all('--cap-drop'),
      SecurityOpt: all('--security-opt'),
      PidsLimit: Number(value('--pids-limit') ?? 0),
      Memory: Number(value('--memory') ?? 0),
      MemorySwap: Number(value('--memory-swap') ?? 0),
      NanoCpus: Math.round(Number(value('--cpus') ?? 0) * 1e9),
      RestartPolicy: { Name: value('--restart') ?? 'no' },
      Tmpfs: Object.fromEntries(
        all('--tmpfs').map((spec) => [spec.split(':')[0], spec.split(':')[1] ?? '']),
      ),
      Binds: null,
    },
    Mounts: container.mounts.map((m) => ({
      Type: m.type,
      Name: m.source,
      Destination: m.target,
    })),
    State: {
      Status: container.state,
      Running: container.state === 'running',
      ExitCode: container.exitCode,
      StartedAt: container.startedAt ?? '0001-01-01T00:00:00Z',
      FinishedAt: container.finishedAt ?? '0001-01-01T00:00:00Z',
      Error: container.error ?? '',
      OOMKilled: false,
    },
  });
}

const VALUE_FLAGS = new Set([
  '--name',
  '--user',
  '-u',
  '--workdir',
  '-w',
  '--network',
  '--cpus',
  '--memory',
  '--memory-swap',
  '--pids-limit',
  '--cap-drop',
  '--security-opt',
  '--restart',
  '--label',
  '-l',
  '--env-file',
  '--env',
  '-e',
  '--tmpfs',
  '--mount',
  '--storage-opt',
  '--pull',
  '--stop-timeout',
  '--log-opt',
  '--entrypoint',
  '--hostname',
]);
const BOOLEAN_FLAGS = new Set(['--read-only', '-i', '--interactive', '--init']);

function create(state: FakeState, rest: string[]): string {
  let index = 0;
  const flags: string[] = [];
  const labels: Record<string, string> = {};
  const env: Record<string, string> = {};
  const mounts: FakeMount[] = [];
  let name = '';
  let user = '0:0';
  let workdir = '/';
  let readOnly = false;
  let interactive = false;
  while (index < rest.length && rest[index]!.startsWith('-')) {
    const token = rest[index]!;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    if (eq !== -1) rest.splice(index, 1, token.slice(0, eq), token.slice(eq + 1));
    const flag = rest[index]!;
    if (BOOLEAN_FLAGS.has(flag)) {
      flags.push(flag);
      if (flag === '--read-only') readOnly = true;
      if (flag === '-i' || flag === '--interactive') interactive = true;
      index++;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) fail(`unknown flag: ${flag}`, 125);
    const value = rest[index + 1];
    if (value === undefined) fail(`flag needs an argument: ${flag}`, 125);
    flags.push(flag, value);
    index += 2;
    switch (flag) {
      case '--name':
        name = value;
        break;
      case '--user':
      case '-u':
        user = value;
        break;
      case '--workdir':
      case '-w':
        workdir = value;
        break;
      case '--label':
      case '-l': {
        const eq = value.indexOf('=');
        labels[eq === -1 ? value : value.slice(0, eq)] = eq === -1 ? '' : value.slice(eq + 1);
        break;
      }
      case '--env-file':
        for (const line of readFileSync(value, 'utf8').split('\n')) {
          if (line === '') continue;
          const eq = line.indexOf('=');
          env[line.slice(0, eq)] = line.slice(eq + 1);
        }
        break;
      case '--env':
      case '-e': {
        const eq = value.indexOf('=');
        env[value.slice(0, eq)] = value.slice(eq + 1);
        break;
      }
      case '--mount': {
        const parts = Object.fromEntries(
          value.split(',').map((part) => part.split('=') as [string, string]),
        );
        const mount: FakeMount = {
          type: parts.type === 'tmpfs' ? 'tmpfs' : 'volume',
          target: parts.dst ?? parts.target ?? parts.destination ?? '',
          ...(parts.src || parts.source ? { source: parts.src ?? parts.source } : {}),
        };
        if (mount.type === 'volume' && !mount.source) mount.source = `anon-${state.nextId}`;
        if (mount.source) state.volumes[mount.source] ??= { labels: {}, files: {} };
        mounts.push(mount);
        break;
      }
      case '--tmpfs':
        mounts.push({ type: 'tmpfs', target: value.split(':')[0]! });
        break;
    }
  }
  const image = rest[index];
  if (image === undefined) fail('docker create requires at least 1 argument', 125);
  const command = rest.slice(index + 1);
  const imageId = state.images[image];
  if (!imageId) fail(`Error response from daemon: No such image: ${image}`, 125);
  if (name && Object.values(state.containers).some((c) => c.name === name)) {
    const other = Object.values(state.containers).find((c) => c.name === name)!;
    fail(
      `Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${other.id}". You have to remove (or rename) that container to be able to reuse that name.`,
      125,
    );
  }
  const id = (state.nextId++).toString(16).padStart(64, 'c');
  const container: FakeContainer = {
    id,
    name: name || `fake_${id.slice(-6)}`,
    image: imageId,
    labels,
    command,
    user,
    workdir,
    env,
    createArgs: flags,
    interactive,
    readOnly,
    mounts,
    state: 'created',
    exitCode: 0,
    created: new Date().toISOString(),
    startCount: 0,
    stdout: '',
    stderr: '',
    files: {},
  };
  // --workdir is created, root-owned, at create time (as the real daemon does).
  let path = '';
  for (const part of workdir.split('/').filter(Boolean)) {
    path += `/${part}`;
    if (!getFile(state, container, path))
      putFile(state, container, path, { type: 'dir', uid: 0, gid: 0, mode: 0o755 });
  }
  state.containers[id] = container;
  return id;
}

function copyIn(state: FakeState, target: string, tar: Uint8Array): void {
  const colon = target.indexOf(':');
  const container = needContainer(state, target.slice(0, colon));
  const destination = target.slice(colon + 1);
  if (container.readOnly && !store(state, container, destination).onVolume)
    fail('Error response from daemon: container rootfs is marked read-only');
  const existing = getFile(state, container, destination);
  if (destination !== '/' && existing?.type !== 'dir')
    fail(
      `Error response from daemon: Could not find the file ${destination} in container ${container.id}`,
    );
  for (const { name, file } of readTar(tar)) {
    if (name === '.' || name === '') continue; // a root entry never chowns the destination
    putFile(state, container, posixJoin(destination, name), file);
  }
}

function copyOut(state: FakeState, source: string): Uint8Array {
  const colon = source.indexOf(':');
  const container = needContainer(state, source.slice(0, colon));
  const path = resolveParents(state, container, posixJoin('/', source.slice(colon + 1)));
  const file = getFile(state, container, path);
  if (!file)
    fail(
      `Error response from daemon: Could not find the file ${source.slice(colon + 1)} in container ${container.id}`,
    );
  const base = path.slice(path.lastIndexOf('/') + 1);
  const entries = [{ name: file.type === 'dir' ? `${base}/` : base, file }];
  if (file.type === 'dir') {
    const located = store(state, container, path);
    const prefix = located.key === '/' ? '/' : `${located.key}/`;
    for (const key of Object.keys(located.files).sort())
      if (key.startsWith(prefix) && key !== located.key) {
        const child = located.files[key]!;
        entries.push({
          name: `${base}/${key.slice(prefix.length)}${child.type === 'dir' ? '/' : ''}`,
          file: child,
        });
      }
  }
  return writeTar(entries);
}

function filters(rest: string[]): ((labels: Record<string, string>) => boolean)[] {
  const checks: ((labels: Record<string, string>) => boolean)[] = [];
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] !== '--filter') continue;
    const filter = rest[index + 1]!;
    if (filter.startsWith('label=')) {
      const spec = filter.slice('label='.length);
      const eq = spec.indexOf('=');
      const key = eq === -1 ? spec : spec.slice(0, eq);
      const value = eq === -1 ? undefined : spec.slice(eq + 1);
      checks.push((labels) => key in labels && (value === undefined || labels[key] === value));
    }
  }
  return checks;
}

function applyFault(
  state: FakeState,
  command: string,
  phase: 'before' | 'after',
): FakeFault | undefined {
  const index = state.faults.findIndex(
    (f) =>
      (f.command === command || f.command === '*') &&
      (phase === 'after' ? f.mode === 'fail-after' : f.mode !== 'fail-after'),
  );
  if (index === -1) return undefined;
  const fault = state.faults[index]!;
  const times = (fault.times ?? 1) - 1;
  if (times <= 0) state.faults.splice(index, 1);
  else fault.times = times;
  return fault;
}

function main(): void {
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv: args })}\n`);
  const [command, ...rest] = args;
  const sub = command === 'container' ? rest.shift()! : command!;
  const before = withLock((state) => {
    if (state.unreachable) return { mode: 'unreachable' } as FakeFault;
    return applyFault(state, sub, 'before');
  });
  if (before) {
    switch (before.mode) {
      case 'unreachable':
        fail(before.stderr ?? UNREACHABLE, before.code ?? 1);
      case 'fail-before':
        fail(before.stderr ?? 'Error response from daemon: fake failure', before.code ?? 1);
      case 'hang':
        for (;;) sleepSync(1_000);
      case 'trickle':
        for (;;) {
          writeSync(1, 'trickle trickle trickle\n');
          sleepSync(20);
        }
      case 'noop':
        process.exit(0);
    }
  }
  const failAfter = () => {
    const fault = withLock((state) => applyFault(state, sub, 'after'));
    if (fault)
      fail(
        fault.stderr ??
          'error during connect: Post "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/containers/x/start": EOF',
        fault.code ?? 1,
      );
  };

  switch (sub) {
    case 'version':
      out('29.0.0-fake\n');
      return;
    case 'image': {
      const action = rest.shift();
      if (action !== 'inspect') fail(`fake docker: image ${action}`);
      const ref = rest[rest.length - 1]!;
      const id = readState().images[ref];
      if (!id) fail(`Error response from daemon: No such image: ${ref}`);
      out(`${id}\n`);
      return;
    }
    case 'create': {
      const id = withLock((state) => create(state, rest));
      failAfter();
      out(`${id}\n`);
      return;
    }
    case 'cp': {
      const positional = rest.filter((arg) => arg !== '-a' && arg !== '--archive');
      if (positional[0] === '-') {
        const tar = readStdin();
        withLock((state) => copyIn(state, positional[1]!, tar));
      } else {
        // Written last, with no lock held: the reader may stop us mid-way.
        const tar = withLock((state) => copyOut(state, positional[0]!));
        failAfter();
        out(tar);
        return;
      }
      failAfter();
      return;
    }
    case 'start': {
      const attach = rest.includes('-a') || rest.includes('--attach');
      const interactive = rest.includes('-i') || rest.includes('--interactive');
      const ref = rest[rest.length - 1]!;
      const stdin = interactive ? new TextDecoder().decode(readStdin()) : undefined;
      const id = withLock((state) => {
        const container = needContainer(state, ref);
        if (container.state === 'running') return container.id;
        const [op] = scriptOf(container.command);
        if (op === 'missing-binary') {
          // Saved with the state: the refusal is failed below, outside the lock.
          container.error = `exec: "${op}": executable file not found in $PATH`;
          container.exitCode = 127;
          return undefined;
        }
        container.state = 'running';
        container.startCount++;
        container.startedAt = new Date().toISOString();
        container.finishedAt = undefined;
        container.stdout = '';
        container.stderr = '';
        if (stdin !== undefined) container.stdin = stdin;
        run(state, container);
        return container.id;
      });
      if (id === undefined)
        fail(
          'Error response from daemon: failed to create task for container: exec: "missing-binary": executable file not found in $PATH: unknown',
        );
      failAfter();
      if (!attach) {
        out(`${ref}\n`);
        return;
      }
      for (;;) {
        const container = readState().containers[id];
        if (!container || container.state !== 'running') {
          if (container) {
            out(container.stdout);
            err(container.stderr);
          }
          // Not process.exit: the output must drain first.
          process.exitCode = container?.exitCode ?? 1;
          return;
        }
        sleepSync(20);
      }
    }
    case 'inspect': {
      const refs = rest.filter(
        (arg, index) => arg !== '--format' && rest[index - 1] !== '--format',
      );
      const state = readState();
      let missing: string | undefined;
      for (const ref of refs) {
        const container = findContainer(state, ref);
        if (container) out(`${inspectJson(container)}\n`);
        else missing = ref;
      }
      if (missing) fail(`Error response from daemon: No such container: ${missing}`);
      return;
    }
    case 'logs': {
      const container = needContainer(readState(), rest[rest.length - 1]!);
      // `--tail N`: the real daemon counts the merged log; per stream is close enough here.
      const at = rest.indexOf('--tail');
      const keep = at === -1 ? undefined : Number(rest[at + 1]);
      const tail = (text: string) => {
        if (keep === undefined) return text;
        const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        return lines.slice(Math.max(0, lines.length - keep)).join('');
      };
      out(tail(container.stdout));
      err(tail(container.stderr));
      return;
    }
    case 'stop':
    case 'kill': {
      const ref = rest[rest.length - 1]!;
      withLock((state) => {
        const container = needContainer(state, ref);
        if (container.state !== 'running') {
          if (sub === 'kill')
            fail(
              `Error response from daemon: cannot kill container: ${ref}: container ${container.id} is not running`,
            );
          return;
        }
        container.state = 'exited';
        // The real stop sends SIGTERM, waits the grace, then SIGKILL.
        container.exitCode = sub === 'stop' && container.onTerm === 'term' ? 143 : 137;
        container.finishedAt = new Date().toISOString();
      });
      out(`${ref}\n`);
      return;
    }
    case 'rm': {
      const force = rest.includes('-f') || rest.includes('--force');
      const volumes = rest.includes('-v') || rest.includes('--volumes');
      const refs = rest.filter((arg) => !arg.startsWith('-'));
      withLock((state) => {
        for (const ref of refs) {
          const container = findContainer(state, ref);
          if (!container) {
            if (!force) fail(`Error response from daemon: No such container: ${ref}`);
            continue;
          }
          if (container.state === 'running' && !force)
            fail(
              `Error response from daemon: cannot remove container "${ref}": container is running`,
            );
          if (volumes)
            for (const mount of container.mounts)
              if (mount.source?.startsWith('anon-')) delete state.volumes[mount.source];
          delete state.containers[container.id];
          out(`${ref}\n`);
        }
      });
      return;
    }
    case 'ps': {
      const checks = filters(rest);
      const state = readState();
      for (const container of Object.values(state.containers))
        if (checks.every((check) => check(container.labels))) out(`${container.id}\n`);
      return;
    }
    case 'volume': {
      const action = rest.shift();
      if (action === 'create') {
        const labels: Record<string, string> = {};
        const name = rest[rest.length - 1]!;
        for (let index = 0; index < rest.length - 1; index++)
          if (rest[index] === '--label') {
            const [key, ...value] = rest[index + 1]!.split('=');
            labels[key!] = value.join('=');
          }
        withLock((state) => {
          state.volumes[name] = { labels, files: state.volumes[name]?.files ?? {} };
        });
        out(`${name}\n`);
        return;
      }
      if (action === 'rm') {
        const names = rest.filter((arg) => !arg.startsWith('-'));
        withLock((state) => {
          for (const name of names) {
            const inUse = Object.values(state.containers).some((c) =>
              c.mounts.some((m) => m.source === name),
            );
            if (inUse) fail(`Error response from daemon: remove ${name}: volume is in use`);
            delete state.volumes[name];
            out(`${name}\n`);
          }
        });
        return;
      }
      if (action === 'ls') {
        const checks = filters(rest);
        const dangling = rest.includes('dangling=true');
        const state = readState();
        for (const [name, volume] of Object.entries(state.volumes)) {
          const used = Object.values(state.containers).some((c) =>
            c.mounts.some((m) => m.source === name),
          );
          if (checks.every((check) => check(volume.labels)) && (!dangling || !used))
            out(`${name}\n`);
        }
        return;
      }
      fail(`fake docker: volume ${action}`);
    }
    default:
      fail(`fake docker: unknown command ${sub}`, 125);
  }
}

try {
  if (!existsSync(statePath) || !statSync(statePath).isFile()) fail('fake docker: no state.json');
  main();
} catch (error) {
  if (!(error instanceof FakeExit)) throw error;
  process.stderr.write(error.message.endsWith('\n') ? error.message : `${error.message}\n`, () =>
    process.exit(error.code),
  );
}
