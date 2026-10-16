/**
 * The Docker sandbox and process runner against a real engine (2.4, spec
 * §3.3). Gated: they run with DEUZ_TEST_DOCKER=1 (and fail, not skip, when
 * Docker is required and missing), on the pinned alpine digest, which must be
 * pulled already (the runner never pulls). Every container and volume they
 * create carries this file's own `deuz.scope` label and is removed at the end.
 */
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createDockerProcessRunner,
  createDockerSandbox,
  createInMemoryProcessOperationStore,
  type ProcessOperationStore,
  type ProcessRunner,
  type ProcessState,
} from '../src/compute/docker';
import { workspaceDigestEntry } from '../src/internal/digest';
import { createInMemoryWorkspace } from '../src/workspace';
import { dockerAvailable, dockerCommand } from './fixtures/services';

const DOCKER = dockerAvailable();
const IMAGE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
/** This run's scope: every container and volume of the file carries it. */
const SCOPE = `live-${process.pid}-${Date.now().toString(36)}`;

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(dockerCommand(), args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The parts of `docker container inspect` these tests read. */
interface Inspected {
  Image: string;
  RestartCount: number;
  Config: { User: string; Labels: Record<string, string> };
  HostConfig: Record<string, unknown> & {
    SecurityOpt?: string[];
    Binds?: string[] | null;
    Privileged?: boolean;
  };
  Mounts: unknown[];
  State: { Running: boolean; StartedAt: string };
}

function inspect(id: string): Inspected {
  return JSON.parse(cli(['container', 'inspect', '--format', '{{json .}}', id]).stdout);
}

function labelled(): string[] {
  return cli(['ps', '-a', '-q', '--no-trunc', '--filter', `label=deuz.scope=${SCOPE}`])
    .stdout.split('\n')
    .map((id) => id.trim())
    .filter(Boolean);
}

afterAll(() => {
  if (!DOCKER) return;
  const ids = labelled();
  if (ids.length) cli(['rm', '-f', '-v', ...ids]);
  const volumes = cli(['volume', 'ls', '-q', '--filter', `label=deuz.scope=${SCOPE}`])
    .stdout.split('\n')
    .filter(Boolean);
  if (volumes.length) cli(['volume', 'rm', '-f', ...volumes]);
});

const base = { image: IMAGE, dockerPath: dockerCommand(), scope: SCOPE };

async function waitFor(
  runner: ProcessRunner,
  operationId: string,
  states: ProcessState[],
): Promise<ProcessState> {
  let state: ProcessState = (await runner.poll(SCOPE, operationId)).state;
  for (let i = 0; i < 100 && !states.includes(state); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = (await runner.poll(SCOPE, operationId)).state;
  }
  return state;
}

function runner(store: ProcessOperationStore = createInMemoryProcessOperationStore(), extra = {}) {
  return createDockerProcessRunner({ ...base, store, ...extra });
}

describe.runIf(DOCKER)('Docker sandbox (live)', () => {
  it('runs as 10001 in a writable staged workspace with no network, and removes the container', async () => {
    const workspace = createInMemoryWorkspace();
    await workspace.write('in/data.txt', 'staged çğ');
    const sandbox = createDockerSandbox({ ...base, workspace });
    const res = await sandbox.runShell!({
      command:
        'id -u; id -g; pwd; cat in/data.txt; echo; stat -c "%u %n" . in in/data.txt; touch made && echo wrote; ' +
        '(wget -q -T 2 -O- http://1.1.1.1 >/dev/null 2>&1 && echo online) || echo offline',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.split('\n')).toEqual([
      '10001',
      '10001',
      '/workspace',
      'staged çğ',
      '10001 .',
      '10001 in',
      '10001 in/data.txt',
      'wrote',
      'offline',
      '',
    ]);
    expect(await workspace.exists('made')).toBe(false);
    expect(labelled()).toEqual([]);
  });

  it('passes stdin, env and an argv with spaces, quotes and non-ASCII exactly', async () => {
    const sandbox = createDockerSandbox(base);
    const res = await sandbox.runShell!({
      command: `printf '%s|' "a b" 'ç ğ 😀' "$TOKEN" "\\$HOME"; cat; echo done >&2`,
      stdin: 'from stdin',
      env: { TOKEN: 'v a l' },
    });
    expect(res).toMatchObject({
      stdout: 'a b|ç ğ 😀|v a l|$HOME|from stdin',
      stderr: 'done\n',
      exitCode: 0,
    });
  });

  it('keeps a bounded tail, times out by killing the container, and refuses a cwd outside', async () => {
    const sandbox = createDockerSandbox({ ...base, maxOutputBytes: 100 });
    const long = await sandbox.runShell!({
      command: "head -c 5000 /dev/zero | tr '\\0' a; echo END",
    });
    expect(long.stdout.endsWith('aaaEND\n')).toBe(true);
    expect(long.stdout.length).toBe(100);
    expect(long.truncated).toEqual({ stdout: true, stderr: false });

    const started = Date.now();
    const slow = await sandbox.runShell!({ command: 'sleep 60', timeoutMs: 1_500 });
    expect(slow).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(30_000);

    const outside = await sandbox.runShell!({ command: 'pwd', cwd: '../etc' });
    expect(outside.exitCode).toBeNull();
    expect((await sandbox.runShell!({ command: 'pwd', cwd: 'sub' })).stdout).toBe(
      '/workspace/sub\n',
    );
    expect(labelled()).toEqual([]);
  });

  it('readOnlyRootFilesystem: the root refuses writes, /tmp is a bounded tmpfs, the workspace is writable', async () => {
    const workspace = createInMemoryWorkspace();
    await workspace.write('seed.txt', 'seed');
    const sandbox = createDockerSandbox({ ...base, workspace, readOnlyRootFilesystem: true });
    const res = await sandbox.runShell!({
      command:
        '(touch /etc/x 2>/dev/null && echo root-writable) || echo root-read-only; ' +
        'touch /tmp/t && echo tmp-ok; touch made && echo ws-ok; cat seed.txt; echo; ' +
        "df -k /tmp | tail -1 | awk '{print $2}'",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.split('\n')).toEqual([
      'root-read-only',
      'tmp-ok',
      'ws-ok',
      'seed',
      '65536',
      '',
    ]);
    expect(labelled()).toEqual([]);
  });
});

describe.runIf(DOCKER)('Docker process runner (live)', () => {
  it('creates the container with every isolation setting of spec §3.3', async () => {
    const run = runner();
    const session = await run.start({
      operationId: 'isolation',
      scope: SCOPE,
      command: ['sleep', '30'],
    });
    expect(session.state).toBe('running');
    const info = inspect(session.containerId!);
    expect(info.Image).toBe(session.imageId);
    expect(info.Config.User).toBe('10001:10001');
    expect(info.Config.Labels).toMatchObject({
      'deuz.operation-id': 'isolation',
      'deuz.scope': SCOPE,
      'deuz.sdk-version': '2.4.0',
      'deuz.kind': 'process',
    });
    expect(info.HostConfig).toMatchObject({
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      PidsLimit: 128,
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: 'no' },
      ReadonlyRootfs: false,
    });
    expect(info.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Mounts).toEqual([]);
    expect(info.HostConfig.Privileged).toBe(false);
    await run.cancel(SCOPE, 'isolation');
    await run.dispose(SCOPE, 'isolation');
  });

  it('cancels with stop, a 2 s grace and kill, then verifies', async () => {
    const run = runner();
    await run.start({ operationId: 'cancel', scope: SCOPE, command: ['sleep', '60'] });
    const started = Date.now();
    const session = await run.cancel(SCOPE, 'cancel');
    expect(session.state).toBe('cancelled');
    // `sleep` as PID 1 ignores SIGTERM: the kill after the grace ends it.
    expect([137, 143]).toContain(session.exitCode);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(inspect(session.containerId!).State.Running).toBe(false);
    await run.dispose(SCOPE, 'cancel');
  });

  it('reconnects after a crash between the start and its record without starting again', async () => {
    const durable = createInMemoryProcessOperationStore();
    let armed = true;
    const crashing: ProcessOperationStore = {
      ...durable,
      create: (r) => durable.create(r),
      get: (s, id) => durable.get(s, id),
      list: (q) => durable.list(q),
      prune: (o) => durable.prune(o),
      async update(scope, id, changes, options) {
        if (armed && changes.state === 'running') {
          armed = false;
          throw new Error('host crash');
        }
        return durable.update(scope, id, changes, options);
      },
    };
    await expect(
      runner(crashing).start({ operationId: 'crash', scope: SCOPE, command: ['sleep', '30'] }),
    ).rejects.toThrow('host crash');
    const startedAt = inspect(
      labelled().find((id) => inspect(id).Config.Labels['deuz.operation-id'] === 'crash')!,
    ).State.StartedAt;
    const restarted = runner(durable);
    const session = await restarted.start({
      operationId: 'crash',
      scope: SCOPE,
      command: ['sleep', '30'],
    });
    expect(session.state).toBe('running');
    const info = inspect(session.containerId!);
    expect(info.State.StartedAt).toBe(startedAt);
    expect(info.RestartCount).toBe(0);
    await restarted.cancel(SCOPE, 'crash');
    await restarted.dispose(SCOPE, 'crash');
  });

  it('passes stdin through the one start, keeps a bounded output tail and reads artifacts safely', async () => {
    const run = runner(createInMemoryProcessOperationStore(), { maxOutputBytes: 100 });
    await run.start({
      operationId: 'artifacts',
      scope: SCOPE,
      command: [
        'sh',
        '-c',
        'cat > in.txt; mkdir out; cp in.txt out/r.txt; ln -s /etc/passwd link; mkdir d; ln -s /etc ld; ' +
          "head -c 3000 /dev/zero | tr '\\0' b; echo END",
      ],
      stdin: 'from stdin\n',
    });
    expect(await waitFor(run, 'artifacts', ['exited', 'failed'])).toBe('exited');
    const output = await run.readOutput(SCOPE, 'artifacts');
    expect(output.stdout.endsWith('bbbEND\n')).toBe(true);
    expect(output.truncated.stdout).toBe(true);

    const artifact = await run.readArtifact(SCOPE, 'artifacts', 'out/r.txt');
    expect(new TextDecoder().decode(artifact.bytes)).toBe('from stdin\n');
    expect(artifact.digest).toBe((await workspaceDigestEntry('out/r.txt', 'from stdin\n')).digest);
    for (const path of ['link', 'd', 'ld/passwd', '../etc/passwd'])
      await expect(run.readArtifact(SCOPE, 'artifacts', path), path).rejects.toMatchObject({
        code: 'artifact_rejected',
      });
    await run.dispose(SCOPE, 'artifacts');
    expect((await run.readOutput(SCOPE, 'artifacts')).truncated.stdout).toBe(true);
  });

  it('reconciles: orphans reported, removed only on request', async () => {
    const run = runner();
    const stranger = runner();
    const orphan = await stranger.start({
      operationId: 'orphan',
      scope: SCOPE,
      command: ['sleep', '30'],
    });
    const report = await run.reconcile({ scope: SCOPE });
    expect(report.orphans.map((o) => o.containerId)).toContain(orphan.containerId);
    expect(report.removed).toEqual([]);
    expect(inspect(orphan.containerId!).State.Running).toBe(true);
    const cleanup = await run.reconcile({ scope: SCOPE, removeOrphans: true });
    expect(cleanup.removed).toContain(orphan.containerId);
    expect(labelled()).not.toContain(orphan.containerId);
  });

  it('reconcile({ removeOrphans }) leaves a live sandbox run alone', async () => {
    const sandbox = createDockerSandbox(base);
    const pending = sandbox.runShell!({ command: 'sleep 4; echo done', timeoutMs: 60_000 });
    const running = () =>
      cli([
        'ps',
        '-q',
        '--no-trunc',
        '--filter',
        `label=deuz.scope=${SCOPE}`,
        '--filter',
        'label=deuz.kind=sandbox',
        '--filter',
        'status=running',
      ]).stdout.trim();
    let live = running();
    for (let i = 0; i < 100 && !live; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      live = running();
    }
    expect(live).not.toBe('');
    const report = await runner().reconcile({ scope: SCOPE, removeOrphans: true });
    expect(report.orphans.map((o) => o.containerId)).not.toContain(live);
    expect(report.removed).not.toContain(live);
    expect(await pending).toMatchObject({ stdout: 'done\n', exitCode: 0 });
    expect(labelled()).toEqual([]);
  });
});
