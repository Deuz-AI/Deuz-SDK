/**
 * The harness around the fake Docker CLI (`fake-docker-cli.ts`): bundles it
 * once per test file into a directory whose name has spaces and non-ASCII
 * characters (so every call also proves the argv survives `shell: false` on
 * Windows), gives each test its own daemon state, and reads back what the
 * runner asked the "daemon" to do.
 */
import { copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { FakeContainer, FakeFault, FakeState } from './fake-docker-cli';

export type { FakeContainer, FakeFault, FakeState };

/** The pinned test image: the alpine 3.20 digest the real-Docker tests use too. */
export const FAKE_IMAGE =
  'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
export const FAKE_IMAGE_ID =
  'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

/** A directory name that needs quoting on every platform. */
const AWKWARD = 'deuz fake dökçer ü 😀';

export interface FakeDockerBundle {
  /** The bundled CLI script. */
  script: string;
  /** Where test states live. */
  root: string;
  cleanup(): Promise<void>;
}

/** Bundles the fake CLI into a fresh awkward directory. Call once per file (beforeAll). */
export async function buildFakeDocker(): Promise<FakeDockerBundle> {
  const root = await mkdtemp(join(tmpdir(), 'deuz-fake-docker-'));
  const binDir = join(root, AWKWARD);
  await mkdir(binDir, { recursive: true });
  const script = join(binDir, 'fake docker.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./fake-docker-cli.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: script,
    logLevel: 'silent',
  });
  return {
    script,
    root,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/**
 * A copy (a hard link where the filesystem allows) of the node binary inside
 * the awkward directory, for tests that need `dockerPath` itself to have
 * spaces and non-ASCII characters.
 */
export async function awkwardNodeBinary(bundle: FakeDockerBundle): Promise<string> {
  const target = join(bundle.root, AWKWARD, process.platform === 'win32' ? 'döcker.exe' : 'döcker');
  try {
    await link(process.execPath, target);
  } catch {
    try {
      await symlink(process.execPath, target);
    } catch {
      await copyFile(process.execPath, target);
    }
  }
  return target;
}

export interface FakeDocker {
  /** Spread into the sandbox/runner options. */
  readonly cli: { dockerPath: string; dockerArgs: string[] };
  readonly dir: string;
  state(): FakeState;
  update(fn: (state: FakeState) => void): void;
  fault(fault: FakeFault): void;
  /** Every invocation's argv (after the fake's own `--state <dir>`). */
  calls(): string[][];
  /** The subcommand of every invocation, e.g. ['image', 'create', 'cp', 'start', 'inspect']. */
  subcommands(): string[];
  containers(): FakeContainer[];
  container(idOrName: string): FakeContainer | undefined;
}

let counter = 0;

/** A fresh daemon: no containers, the pinned image present (by digest and by tag). */
export async function fakeDocker(
  bundle: FakeDockerBundle,
  options: { dockerPath?: string; images?: Record<string, string> } = {},
): Promise<FakeDocker> {
  const dir = join(bundle.root, `state-${process.pid}-${++counter}`);
  await mkdir(dir, { recursive: true });
  const initial: FakeState = {
    images: {
      [FAKE_IMAGE]: FAKE_IMAGE_ID,
      'alpine:3.20': FAKE_IMAGE_ID,
      [FAKE_IMAGE_ID]: FAKE_IMAGE_ID,
      ...options.images,
    },
    containers: {},
    volumes: {},
    faults: [],
    nextId: 1,
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(initial));
  await writeFile(join(dir, 'calls.jsonl'), '');
  const statePath = join(dir, 'state.json');
  const state = () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
  const update = (fn: (current: FakeState) => void) => {
    const current = state();
    fn(current);
    writeFileSync(statePath, JSON.stringify(current));
  };
  const calls = () =>
    readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
  return {
    cli: {
      dockerPath: options.dockerPath ?? process.execPath,
      dockerArgs: [bundle.script, '--state', dir],
    },
    dir,
    state,
    update,
    fault: (fault) => update((current) => void current.faults.push(fault)),
    calls,
    subcommands: () => calls().map((argv) => (argv[0] === 'container' ? argv[1]! : argv[0]!)),
    containers: () => Object.values(state().containers),
    container: (ref) =>
      Object.values(state().containers).find((c) => c.id === ref || c.name === ref),
  };
}

/** Reads a file the fake container holds, as text. */
export function fakeFileText(container: FakeContainer, path: string): string | undefined {
  const file = container.files[path];
  return file?.content === undefined ? undefined : Buffer.from(file.content, 'base64').toString();
}
