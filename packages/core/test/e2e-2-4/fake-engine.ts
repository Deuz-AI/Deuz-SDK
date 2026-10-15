/**
 * The fake Docker engine of the composite flow: the fake CLI of
 * `../fixtures/fake-docker-cli.ts`, bundled by esbuild in a child process.
 *
 * `../fixtures/fake-docker.ts` bundles it in process, which loads esbuild into
 * the test's realm; esbuild refuses to load under jsdom (the React end-to-end
 * test), so this harness bundles in a plain Node child and keeps its own
 * small view of the fake daemon's state. Each flow gets a fresh daemon: no
 * containers, the pinned image present (by digest and by tag).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeContainer, FakeState } from '../fixtures/fake-docker-cli';

/** The pinned alpine 3.20 digest, as the fake daemon knows it. */
export const FAKE_ENGINE_IMAGE =
  'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
const FAKE_ENGINE_IMAGE_ID =
  'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

/** The bundled CLI, once per test file. */
export interface FakeEngineBundle {
  script: string;
  root: string;
  cleanup(): Promise<void>;
}

/** Bundles the fake CLI into a directory whose name needs quoting (spaces, non-ASCII). */
export async function buildFakeEngine(): Promise<FakeEngineBundle> {
  const root = await mkdtemp(join(tmpdir(), 'deuz-e1-engine-'));
  const binDir = join(root, 'fake dökçer ü');
  await mkdir(binDir, { recursive: true });
  const script = join(binDir, 'fake docker.mjs');
  // From the path, not `new URL(...)`: under jsdom that is the DOM's URL, which Node refuses.
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'fake-docker-cli.ts',
  );
  const esbuild = createRequire(import.meta.url).resolve('esbuild');
  const options = {
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: script,
    logLevel: 'silent',
  };
  const built = spawnSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(esbuild)}).buildSync(${JSON.stringify(options)})`],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  if (built.status !== 0)
    throw new Error(
      `Could not bundle the fake Docker CLI: ${built.stderr || built.error?.message}`,
    );
  return {
    script,
    root,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

let daemons = 0;

/** A fresh fake daemon: its CLI options and a read of its containers. */
export async function fakeEngine(bundle: FakeEngineBundle): Promise<{
  cli: { dockerPath: string; dockerArgs: string[] };
  containers(): FakeContainer[];
}> {
  const dir = join(bundle.root, `daemon-${process.pid}-${++daemons}`);
  await mkdir(dir, { recursive: true });
  const initial: FakeState = {
    images: {
      [FAKE_ENGINE_IMAGE]: FAKE_ENGINE_IMAGE_ID,
      'alpine:3.20': FAKE_ENGINE_IMAGE_ID,
      [FAKE_ENGINE_IMAGE_ID]: FAKE_ENGINE_IMAGE_ID,
    },
    containers: {},
    volumes: {},
    faults: [],
    nextId: 1,
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(initial));
  await writeFile(join(dir, 'calls.jsonl'), '');
  const statePath = join(dir, 'state.json');
  return {
    cli: { dockerPath: process.execPath, dockerArgs: [bundle.script, '--state', dir] },
    containers: () =>
      Object.values((JSON.parse(readFileSync(statePath, 'utf8')) as FakeState).containers),
  };
}
