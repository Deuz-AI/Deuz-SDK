/**
 * Spec §5.1, area docker (lane L6): isolation settings, start recovery,
 * cancel, artifact checks, output with `truncated`, orphan reconcile. Each
 * scenario runs on the fake Docker CLI and, with DEUZ_TEST_DOCKER=1, again on
 * the real engine (the pinned alpine digest). The fault scenario builds its
 * daemon state, stores and runners inside every run.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  createDockerProcessRunner,
  createInMemoryProcessOperationStore,
  createSqliteProcessOperationStore,
  type ProcessOperationStore,
  type ProcessRunner,
  type ProcessState,
} from '../../src/compute/docker';
import { workspaceDigestEntry } from '../../src/internal/digest';
import {
  buildFakeDocker,
  FAKE_IMAGE,
  fakeDocker,
  type FakeDockerBundle,
} from '../fixtures/fake-docker';
import { dockerAvailable, dockerCommand } from '../fixtures/services';
import { scenario } from './registry';

const DOCKER = dockerAvailable();
const LIVE_IMAGE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
const TIMEOUT = 120_000;

let bundle: FakeDockerBundle;
beforeAll(async () => {
  bundle = await buildFakeDocker();
}, 60_000);
afterAll(async () => {
  await bundle.cleanup();
});

/** One engine to run a scenario on, with the commands that mean the same thing on it. */
interface Backend {
  name: string;
  scope: string;
  cli: { image: string; dockerPath: string; dockerArgs?: string[] };
  longRunning: string[];
  echoExit(text: string, code: number): string[];
  bigOutput(bytes: number): string[];
  artifactProgram: string[];
  /** The create settings the daemon holds for a container. */
  settings(containerId: string): Promise<Record<string, unknown>>;
  /** How often the container was started. */
  starts(containerId: string): Promise<number>;
  containerCount(): Promise<number>;
  dispose(): Promise<void>;
}

let runs = 0;

async function fakeBackend(): Promise<Backend> {
  const fake = await fakeDocker(bundle);
  return {
    name: 'fake',
    scope: 'tenant-a',
    cli: { image: FAKE_IMAGE, ...fake.cli },
    longRunning: ['sleep'],
    echoExit: (text, code) => ['echo', text, ';', 'exit', String(code)],
    bigOutput: (bytes) => ['emit', String(bytes), 'a', ';', 'echo', 'END'],
    artifactProgram: [
      'mkdir',
      'out',
      ';',
      'write',
      'out/r.txt',
      'result',
      ';',
      'symlink',
      'link',
      '/etc/passwd',
      ';',
      'mkdir',
      'd',
      ';',
      'symlink',
      'ld',
      '/etc',
      ';',
      'exit',
      '0',
    ],
    async settings(containerId) {
      const container = fake.container(containerId)!;
      const value = (flag: string) => container.createArgs[container.createArgs.indexOf(flag) + 1];
      return {
        user: container.user,
        network: value('--network'),
        cpus: Number(value('--cpus')),
        memory: Number(value('--memory')),
        memorySwap: Number(value('--memory-swap')),
        pids: Number(value('--pids-limit')),
        capDrop: [value('--cap-drop')],
        securityOpt: [value('--security-opt')],
        restart: value('--restart'),
        mounts: container.mounts.length,
        labels: container.labels,
        image: container.image,
      };
    },
    starts: async (containerId) => fake.container(containerId)?.startCount ?? 0,
    containerCount: async () => fake.containers().length,
    dispose: async () => {},
  };
}

function cli(args: string[]): string {
  return (
    spawnSync(dockerCommand(), args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    }).stdout ?? ''
  );
}

async function liveBackend(): Promise<Backend> {
  const scope = `scenario-${process.pid}-${++runs}-${Date.now().toString(36)}`;
  const ids = () =>
    cli(['ps', '-a', '-q', '--no-trunc', '--filter', `label=deuz.scope=${scope}`])
      .split('\n')
      .filter(Boolean);
  const inspect = (id: string) =>
    JSON.parse(cli(['container', 'inspect', '--format', '{{json .}}', id])) as {
      Image: string;
      RestartCount: number;
      State: { StartedAt: string };
      Config: { User: string; Labels: Record<string, string> };
      HostConfig: {
        NetworkMode: string;
        NanoCpus: number;
        Memory: number;
        MemorySwap: number;
        PidsLimit: number;
        CapDrop: string[];
        SecurityOpt: string[];
        RestartPolicy: { Name: string };
      };
      Mounts: unknown[];
    };
  return {
    name: 'docker',
    scope,
    cli: { image: LIVE_IMAGE, dockerPath: dockerCommand() },
    longRunning: ['sleep', '60'],
    echoExit: (text, code) => ['sh', '-c', `echo ${text}; exit ${code}`],
    bigOutput: (bytes) => ['sh', '-c', `head -c ${bytes} /dev/zero | tr '\\0' a; echo END`],
    artifactProgram: [
      'sh',
      '-c',
      'mkdir out; echo result > out/r.txt; ln -s /etc/passwd link; mkdir d; ln -s /etc ld',
    ],
    async settings(containerId) {
      const info = inspect(containerId);
      return {
        user: info.Config.User,
        network: info.HostConfig.NetworkMode,
        cpus: info.HostConfig.NanoCpus / 1e9,
        memory: info.HostConfig.Memory,
        memorySwap: info.HostConfig.MemorySwap,
        pids: info.HostConfig.PidsLimit,
        capDrop: info.HostConfig.CapDrop,
        securityOpt: info.HostConfig.SecurityOpt,
        restart: info.HostConfig.RestartPolicy.Name,
        mounts: info.Mounts.length,
        labels: info.Config.Labels,
        image: info.Image,
      };
    },
    async starts(containerId) {
      const info = inspect(containerId);
      return info.State.StartedAt.startsWith('0001-01-01') ? 0 : 1 + info.RestartCount;
    },
    containerCount: async () => ids().length,
    async dispose() {
      const left = ids();
      if (left.length) cli(['rm', '-f', '-v', ...left]);
    },
  };
}

/** Runs `fn` on the fake engine, then on the real one when it is available. */
async function onEachBackend(fn: (backend: Backend) => Promise<void>): Promise<void> {
  const makers = [fakeBackend, ...(DOCKER ? [liveBackend] : [])];
  for (const make of makers) {
    const backend = await make();
    try {
      await fn(backend);
    } finally {
      await backend.dispose();
    }
  }
}

function runnerOn(
  backend: Backend,
  store: ProcessOperationStore,
  extra: Record<string, unknown> = {},
) {
  return createDockerProcessRunner({ ...backend.cli, store, ...extra });
}

async function settle(runner: ProcessRunner, scope: string, id: string, states: ProcessState[]) {
  let state = (await runner.poll(scope, id)).state;
  for (let i = 0; i < 100 && !states.includes(state); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = (await runner.poll(scope, id)).state;
  }
  return state;
}

scenario(
  'docker',
  'isolation-settings',
  () =>
    onEachBackend(async (backend) => {
      const runner = runnerOn(backend, createInMemoryProcessOperationStore());
      const session = await runner.start({
        operationId: 'iso',
        scope: backend.scope,
        command: backend.longRunning,
      });
      expect(session.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await backend.settings(session.containerId!)).toMatchObject({
        user: '10001:10001',
        network: 'none',
        cpus: 1,
        memory: 512 * 1024 * 1024,
        memorySwap: 512 * 1024 * 1024,
        pids: 128,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges'],
        restart: 'no',
        mounts: 0,
        image: session.imageId,
        labels: {
          'deuz.operation-id': 'iso',
          'deuz.scope': backend.scope,
          'deuz.sdk-version': '2.4.0',
          'deuz.kind': 'process',
        },
      });
      await runner.cancel(backend.scope, 'iso');
      await runner.dispose(backend.scope, 'iso');
    }),
  { timeout: TIMEOUT },
);

scenario(
  'docker',
  'start-recovery',
  () =>
    onEachBackend(async (backend) => {
      const dir = await mkdtemp(join(tmpdir(), 'deuz-l6-recovery-'));
      try {
        // A host crashes at each step of the start order, on a durable store,
        // and a new host process (store reopened) reconnects.
        const crashes: {
          state: ProcessState;
          when: 'before' | 'after';
          expected: ProcessState;
          starts: number;
        }[] = [
          { state: 'created', when: 'before', expected: 'running', starts: 1 },
          { state: 'staged', when: 'before', expected: 'running', starts: 1 },
          { state: 'start-dispatched', when: 'after', expected: 'needs-reconcile', starts: 0 },
          { state: 'running', when: 'before', expected: 'running', starts: 1 },
        ];
        for (const [index, crash] of crashes.entries()) {
          const path = join(dir, `ops-${index}.db`);
          const operationId = `recover-${index}`;
          const request = { operationId, scope: backend.scope, command: backend.longRunning };
          const first = createSqliteProcessOperationStore({ path });
          let armed = true;
          const crashing: ProcessOperationStore = {
            create: (r) => first.create(r),
            get: (s, id) => first.get(s, id),
            list: (q) => first.list(q),
            prune: (o) => first.prune(o),
            async update(scope, id, changes, options) {
              if (armed && changes.state === crash.state) {
                armed = false;
                if (crash.when === 'after') await first.update(scope, id, changes, options);
                throw new Error(`host crash at ${crash.state}`);
              }
              return first.update(scope, id, changes, options);
            },
          };
          await expect(runnerOn(backend, crashing).start(request)).rejects.toThrow('host crash');
          await first.close();

          const reopened = createSqliteProcessOperationStore({ path });
          try {
            const runner = runnerOn(backend, reopened);
            const session = await runner.start(request);
            expect(session.state, `${crash.state}/${crash.when}`).toBe(crash.expected);
            expect(await backend.starts(session.containerId!)).toBe(crash.starts);
            // A second reconnect changes nothing.
            expect((await runner.start(request)).state).toBe(crash.expected);
            expect(await backend.starts(session.containerId!)).toBe(crash.starts);
            if (crash.expected === 'needs-reconcile') {
              // Containment: reconcile settles it as failed, never starts it.
              const late = createDockerProcessRunner({
                ...backend.cli,
                store: reopened,
                deps: { clock: { now: () => Date.now() + 120_000, setTimeout: () => () => {} } },
              });
              const report = await late.reconcile({ scope: backend.scope });
              expect(report.matched.find((s) => s.operationId === operationId)?.state).toBe(
                'failed',
              );
              expect(await backend.starts(session.containerId!)).toBe(0);
            } else {
              await runner.cancel(backend.scope, operationId);
            }
            await runner.dispose(backend.scope, operationId);
          } finally {
            await reopened.close();
          }
        }
        expect(await backend.containerCount()).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }),
  { fault: true, timeout: TIMEOUT * 2 },
);

scenario(
  'docker',
  'cancel',
  () =>
    onEachBackend(async (backend) => {
      const store = createInMemoryProcessOperationStore();
      const runner = runnerOn(backend, store);
      await runner.start({ operationId: 'c', scope: backend.scope, command: backend.longRunning });
      const session = await runner.cancel(backend.scope, 'c');
      expect(session.state).toBe('cancelled');
      expect([137, 143]).toContain(session.exitCode);
      // Recorded and idempotent: a second cancel, a poll and a start change nothing.
      expect((await runner.cancel(backend.scope, 'c')).state).toBe('cancelled');
      expect((await runner.poll(backend.scope, 'c')).state).toBe('cancelled');
      expect(
        (
          await runner.start({
            operationId: 'c',
            scope: backend.scope,
            command: backend.longRunning,
          })
        ).state,
      ).toBe('cancelled');
      expect(await backend.starts(session.containerId!)).toBe(1);
      await runner.dispose(backend.scope, 'c');
    }),
  { timeout: TIMEOUT },
);

scenario(
  'docker',
  'artifact-checks',
  () =>
    onEachBackend(async (backend) => {
      const runner = runnerOn(backend, createInMemoryProcessOperationStore());
      await runner.start({
        operationId: 'a',
        scope: backend.scope,
        command: backend.artifactProgram,
      });
      expect(await settle(runner, backend.scope, 'a', ['exited', 'failed'])).toBe('exited');
      const artifact = await runner.readArtifact(backend.scope, 'a', 'out/r.txt');
      const text = new TextDecoder().decode(artifact.bytes);
      expect(text.trim()).toBe('result');
      expect(artifact.digest).toBe(
        (await workspaceDigestEntry('out/r.txt', artifact.bytes)).digest,
      );
      for (const path of ['link', 'd', 'ld/passwd', '../etc/passwd', '/etc/passwd'])
        await expect(runner.readArtifact(backend.scope, 'a', path), path).rejects.toMatchObject({
          code: 'artifact_rejected',
        });
      // Size-limited: the same file over a 3-byte limit is refused.
      const tiny = runnerOn(backend, createInMemoryProcessOperationStore(), {
        maxArtifactBytes: 3,
      });
      await tiny.start({
        operationId: 'a-tiny',
        scope: backend.scope,
        command: backend.artifactProgram,
      });
      expect(await settle(tiny, backend.scope, 'a-tiny', ['exited', 'failed'])).toBe('exited');
      await expect(tiny.readArtifact(backend.scope, 'a-tiny', 'out/r.txt')).rejects.toMatchObject({
        code: 'artifact_too_large',
      });
      await runner.dispose(backend.scope, 'a');
      await tiny.dispose(backend.scope, 'a-tiny');
    }),
  { timeout: TIMEOUT },
);

scenario(
  'docker',
  'output-truncation',
  () =>
    onEachBackend(async (backend) => {
      const runner = runnerOn(backend, createInMemoryProcessOperationStore(), {
        maxOutputBytes: 64,
      });
      await runner.start({
        operationId: 'o',
        scope: backend.scope,
        command: backend.bigOutput(4096),
      });
      expect(await settle(runner, backend.scope, 'o', ['exited'])).toBe('exited');
      const output = await runner.readOutput(backend.scope, 'o');
      expect(output.stdout.endsWith('aaaEND\n')).toBe(true);
      expect(new TextEncoder().encode(output.stdout).byteLength).toBeLessThanOrEqual(64);
      expect(output.truncated).toEqual({ stdout: true, stderr: false });
      await runner.dispose(backend.scope, 'o');
      // The tail recorded at exit outlives the container.
      expect(await runner.readOutput(backend.scope, 'o')).toEqual(output);
      const small = runnerOn(backend, createInMemoryProcessOperationStore());
      await small.start({
        operationId: 's',
        scope: backend.scope,
        command: backend.echoExit('short', 0),
      });
      expect(await settle(small, backend.scope, 's', ['exited'])).toBe('exited');
      expect((await small.readOutput(backend.scope, 's')).truncated).toEqual({
        stdout: false,
        stderr: false,
      });
      await small.dispose(backend.scope, 's');
    }),
  { timeout: TIMEOUT },
);

scenario(
  'docker',
  'orphan-reconcile',
  () =>
    onEachBackend(async (backend) => {
      const store = createInMemoryProcessOperationStore();
      const runner = runnerOn(backend, store);
      const kept = await runner.start({
        operationId: 'kept',
        scope: backend.scope,
        command: backend.longRunning,
      });
      // A labelled container no record of this store knows: an orphan.
      const stranger = runnerOn(backend, createInMemoryProcessOperationStore());
      const orphan = await stranger.start({
        operationId: 'orphan',
        scope: backend.scope,
        command: backend.longRunning,
      });

      const report = await runner.reconcile({ scope: backend.scope });
      expect(report.matched.map((s) => s.operationId)).toEqual(['kept']);
      expect(report.orphans.map((o) => o.containerId)).toEqual([orphan.containerId]);
      expect(report.removed).toEqual([]);
      expect(await backend.containerCount()).toBe(2);

      const cleanup = await runner.reconcile({ scope: backend.scope, removeOrphans: true });
      expect(cleanup.removed).toEqual([orphan.containerId]);
      expect(await backend.containerCount()).toBe(1);
      expect((await runner.poll(backend.scope, 'kept')).state).toBe('running');
      expect(kept.containerId).toBeDefined();
      await runner.cancel(backend.scope, 'kept');
      await runner.dispose(backend.scope, 'kept');
      expect(await backend.containerCount()).toBe(0);
    }),
  { timeout: TIMEOUT },
);
