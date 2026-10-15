/**
 * createDockerProcessRunner (2.4, spec §3.3) on the fake Docker CLI. The
 * start order is fixed — operation record → container create → staging →
 * durable `start-dispatched` → one start command → inspect — so a host that
 * crashes at any step reconnects instead of starting twice: a running or
 * exited container is never started again, an ambiguous start needs
 * `reconcile`, and a lost container is never recreated under the same id.
 * Cancel is recorded first, then stop with a 2 s grace, kill if needed and a
 * state check; an unreachable daemon never counts as cancelled. Output is a
 * bounded tail; artifacts come only from a stopped container, only as regular
 * files under the workspace.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDockerProcessRunner,
  createDockerSandbox,
  createInMemoryProcessOperationStore,
  DEFAULT_DOCKER_SANDBOX,
  DockerSandboxError,
  OperationConflictError,
  type ProcessOperationStore,
  type ProcessStartRequest,
  type ProcessState,
} from '../src/compute/docker';
import { resolveDockerOptions } from '../src/compute/docker/engine';
import { createDockerRunnerFromOptions } from '../src/compute/docker/runner';
import { workspaceDigestEntry } from '../src/internal/digest';
import { createInMemoryWorkspace } from '../src/workspace';
import { createMemoryObserver } from '../src/observe';
import type { Clock } from '../src/types/deps';
import {
  buildFakeDocker,
  FAKE_IMAGE,
  FAKE_IMAGE_ID,
  fakeDocker,
  type FakeContainer,
  type FakeDocker,
  type FakeDockerBundle,
} from './fixtures/fake-docker';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';
import { manualClock } from './fixtures/manual-clock';

// Every docker call here starts a node process (the fake CLI): seconds, not milliseconds.
vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS });

let bundle: FakeDockerBundle;
beforeAll(async () => {
  bundle = await buildFakeDocker();
});
afterAll(async () => {
  await bundle.cleanup();
});

class HostCrash extends Error {}

/** A store whose next update to `state` crashes the "host" before or after it commits. */
function crashingStore(
  inner: ProcessOperationStore,
  crash: { state: ProcessState; when: 'before' | 'after' },
): ProcessOperationStore {
  let armed = true;
  return {
    ...inner,
    create: (record) => inner.create(record),
    get: (scope, id) => inner.get(scope, id),
    list: (query) => inner.list(query),
    prune: (options) => inner.prune(options),
    async update(scope, id, changes, options) {
      if (armed && changes.state === crash.state) {
        armed = false;
        if (crash.when === 'before') throw new HostCrash(`crash before ${crash.state}`);
        await inner.update(scope, id, changes, options);
        throw new HostCrash(`crash after ${crash.state}`);
      }
      return inner.update(scope, id, changes, options);
    },
  };
}

/** A store whose host crashes right after it records a new operation, before anything else. */
function recordThenCrash(inner: ProcessOperationStore): ProcessOperationStore {
  return {
    ...inner,
    async create(record) {
      await inner.create(record);
      throw new HostCrash('crash after recorded');
    },
    get: (scope, id) => inner.get(scope, id),
    list: (query) => inner.list(query),
    update: (scope, id, changes, options) => inner.update(scope, id, changes, options),
    prune: (options) => inner.prune(options),
  };
}

/** A store that notes its writes in `timeline`, after the docker calls that came before each. */
function timelineStore(inner: ProcessOperationStore, fake: FakeDocker, timeline: string[]) {
  let seen = 0;
  const flush = () => {
    const subs = fake.subcommands();
    for (const sub of subs.slice(seen)) timeline.push(`docker:${sub}`);
    seen = subs.length;
  };
  return {
    ...inner,
    create: async (record: Parameters<ProcessOperationStore['create']>[0]) => {
      flush();
      timeline.push(`store:${record.state}`);
      return inner.create(record);
    },
    get: inner.get.bind(inner),
    list: inner.list.bind(inner),
    prune: inner.prune.bind(inner),
    update: async (...args: Parameters<ProcessOperationStore['update']>) => {
      flush();
      if (args[2].state) timeline.push(`store:${args[2].state}`);
      return inner.update(...args);
    },
    flush,
  } satisfies ProcessOperationStore & { flush(): void };
}

function request(overrides: Partial<ProcessStartRequest> = {}): ProcessStartRequest {
  return { operationId: 'op-1', scope: 'tenant-a', command: ['sleep'], ...overrides };
}

function setup(
  fake: FakeDocker,
  options: {
    store?: ProcessOperationStore;
    clock?: Clock;
    maxOutputBytes?: number;
    observer?: ReturnType<typeof createMemoryObserver>;
    maxArtifactBytes?: number;
    workspace?: ReturnType<typeof createInMemoryWorkspace>;
  } = {},
) {
  const store =
    options.store ??
    createInMemoryProcessOperationStore(options.clock ? { deps: { clock: options.clock } } : {});
  const runner = createDockerProcessRunner({
    image: FAKE_IMAGE,
    store,
    ...fake.cli,
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.maxArtifactBytes !== undefined
      ? { maxArtifactBytes: options.maxArtifactBytes }
      : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    deps: {
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
    },
  });
  return { store, runner };
}

/** Puts a container straight into the fake daemon, as another host would have left it. */
function seedContainer(
  fake: FakeDocker,
  id: string,
  overrides: Partial<FakeContainer> & { labels: Record<string, string> },
): void {
  fake.update((state) => {
    state.containers[id] = {
      id,
      name: `seed-${id.slice(0, 8)}`,
      image: FAKE_IMAGE_ID,
      command: ['sleep'],
      user: '10001:10001',
      workdir: '/workspace',
      env: {},
      createArgs: [],
      interactive: false,
      readOnly: false,
      mounts: [],
      state: 'created',
      exitCode: 0,
      startCount: 0,
      stdout: '',
      stderr: '',
      files: {},
      created: new Date().toISOString(),
      ...overrides,
    };
  });
}

const count = (fake: FakeDocker, sub: string) => fake.subcommands().filter((s) => s === sub).length;
const startCount = (fake: FakeDocker) => fake.containers().reduce((n, c) => n + c.startCount, 0);

describe('createDockerProcessRunner: start', () => {
  it('records, creates, stages, durably dispatches one start, then inspects', async () => {
    const fake = await fakeDocker(bundle);
    const timeline: string[] = [];
    const inner = createInMemoryProcessOperationStore();
    const { runner } = setup(fake, { store: timelineStore(inner, fake, timeline) });
    const session = await runner.start(request({ files: [{ path: 'in.txt', content: 'data' }] }));

    expect(session).toMatchObject({
      operationId: 'op-1',
      scope: 'tenant-a',
      state: 'running',
      imageId: FAKE_IMAGE_ID,
      durableTimeout: false,
      requestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(timeline).toEqual([
      'docker:image', // the image resolves to its id before anything is recorded
      'store:recorded',
      'docker:inspect', // is a container already there under this operation's name?
      'docker:create',
      'store:created',
      'docker:cp',
      'store:staged',
      'store:start-dispatched',
      'docker:start',
      'docker:inspect',
      'store:running',
    ]);
    const [container] = fake.containers();
    expect(container!.id).toBe(session.containerId);
    expect(container!.name).toMatch(/^deuz-[0-9a-f]{40}$/);
    expect(container!.labels).toMatchObject({
      'deuz.operation-id': 'op-1',
      'deuz.scope': 'tenant-a',
      'deuz.sdk-version': '2.4.0',
      'deuz.kind': 'process',
    });
    expect(container!.startCount).toBe(1);
    const record = await inner.get('tenant-a', 'op-1');
    expect(record!.request).toEqual({ command: ['sleep'], files: [{ path: 'in.txt', size: 4 }] });
  });

  it('the same id with another request is an OperationConflictError; the same request starts nothing new', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    const first = await runner.start(request());
    const again = await runner.start(request());
    expect(again).toMatchObject({ state: 'running', containerId: first.containerId });
    expect(count(fake, 'create')).toBe(1);
    expect(count(fake, 'start')).toBe(1);
    const error = await runner
      .start(request({ command: ['echo', 'other'] }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationConflictError);
    expect(error).toMatchObject({ subsystem: 'process', operationId: 'op-1' });
    // Env values are part of the request digest, but never stored.
    const withEnv = await runner
      .start(request({ operationId: 'op-env', env: { TOKEN: 'secret-1' } }))
      .then(() => runner.start(request({ operationId: 'op-env', env: { TOKEN: 'secret-2' } })))
      .catch((e: unknown) => e);
    expect(withEnv).toBeInstanceOf(OperationConflictError);
  });

  it('never starts an exited container again', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    expect((await runner.start(request({ command: ['echo', 'done'] }))).state).toBe('exited');
    expect((await runner.start(request({ command: ['echo', 'done'] }))).state).toBe('exited');
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('exited');
    expect(startCount(fake)).toBe(1);
  });

  it('a start the daemon refuses (no such executable) fails for good', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    const session = await runner.start(request({ command: ['missing-binary'] }));
    expect(session.state).toBe('failed');
    expect(session.error?.message).toMatch(/executable file not found/);
    expect((await runner.start(request({ command: ['missing-binary'] }))).state).toBe('failed');
  });

  it('an error reported after the container did start is resolved by inspection', async () => {
    const fake = await fakeDocker(bundle);
    fake.fault({ command: 'start', mode: 'fail-after' });
    const { runner } = setup(fake);
    expect((await runner.start(request())).state).toBe('running');
    expect(startCount(fake)).toBe(1);
  });

  it('an unknown start outcome needs reconciliation, which never starts it again', async () => {
    const fake = await fakeDocker(bundle);
    const time = manualClock(10_000);
    const { runner } = setup(fake, { clock: time.clock });
    // The start command meets a daemon gone away: did it start or not?
    fake.fault({ command: 'start', mode: 'unreachable' });
    const session = await runner.start(request());
    expect(session.state).toBe('needs-reconcile');
    expect(session.error?.code).toBe('docker_unavailable');
    expect(startCount(fake)).toBe(0);
    // Too fresh: another host may still be issuing that start.
    let report = await runner.reconcile();
    expect(report.matched.map((s) => s.state)).toEqual(['needs-reconcile']);
    await time.advance(60_000);
    report = await runner.reconcile();
    expect(report.matched).toMatchObject([
      { state: 'failed', error: { code: 'start_unconfirmed' } },
    ]);
    expect(startCount(fake)).toBe(0);
    expect((await runner.start(request())).state).toBe('failed');
    expect(startCount(fake)).toBe(0);
  });

  it('a new record never adopts a container an earlier operation under the same id left (R4-4)', async () => {
    const fake = await fakeDocker(bundle);
    const { runner, store } = setup(fake);
    const old = await runner.start(request({ command: ['echo', 'old', ';', 'exit', '7'] }));
    expect(old.state).toBe('exited');
    // Retention drops the record, but nothing removed the container.
    expect(await store.prune({ terminalBefore: Date.now() + 1_000 })).toBe(1);
    const reused = await runner.start(request({ command: ['echo', 'new', ';', 'exit', '0'] }));
    expect(reused).toMatchObject({ state: 'failed', error: { code: 'container_conflict' } });
    expect(reused.exitCode).not.toBe(7);
    expect(reused.containerId).toBeUndefined();
    expect(startCount(fake)).toBe(1);
    expect(fake.containers()).toHaveLength(1);
    expect((await runner.readOutput('tenant-a', 'op-1')).stdout).toBe('');
    // Disposing the refused operation removes the leftover; the id is then free again.
    await runner.dispose('tenant-a', 'op-1');
    expect(fake.containers()).toEqual([]);
    expect(await store.prune({ terminalBefore: Date.now() + 1_000 })).toBe(1);
    const fresh = await runner.start(request({ command: ['echo', 'new', ';', 'exit', '0'] }));
    expect(fresh).toMatchObject({ state: 'exited', exitCode: 0 });
    expect((await runner.readOutput('tenant-a', 'op-1')).stdout).toBe('new\n');
  });

  it('a never-started leftover with another request is not adopted either, by start or reconcile (R4-4)', async () => {
    const fake = await fakeDocker(bundle);
    const time = manualClock(Date.now());
    const store = createInMemoryProcessOperationStore({ deps: { clock: time.clock } });
    const { runner } = setup(fake, { store, clock: time.clock });
    fake.fault({ command: 'start', mode: 'unreachable' });
    expect((await runner.start(request({ command: ['echo', 'old'] }))).state).toBe(
      'needs-reconcile',
    );
    await time.advance(60_000);
    expect((await runner.reconcile()).matched.map((s) => s.state)).toEqual(['failed']);
    expect(await store.prune({ terminalBefore: time.clock.now() + 1_000 })).toBe(1);
    // A host that crashed right after recording the new request: reconcile sees it first.
    const crashOnCreate = recordThenCrash(store);
    const crashed = setup(fake, { store: crashOnCreate, clock: time.clock });
    await expect(crashed.runner.start(request({ command: ['echo', 'new'] }))).rejects.toThrow(
      HostCrash,
    );
    const report = await runner.reconcile();
    expect(report.matched).toMatchObject([
      { operationId: 'op-1', state: 'failed', error: { code: 'container_conflict' } },
    ]);
    expect(startCount(fake)).toBe(0);
    expect((await runner.start(request({ command: ['echo', 'new'] }))).state).toBe('failed');
    expect(startCount(fake)).toBe(0);
  });

  it('refuses a malformed request before recording anything', async () => {
    const fake = await fakeDocker(bundle);
    const { runner, store } = setup(fake);
    await expect(runner.start(request({ command: [] }))).rejects.toThrow(TypeError);
    await expect(runner.start(request({ operationId: '' }))).rejects.toThrow(TypeError);
    await expect(
      runner.start(request({ files: [{ path: '../escape', content: 'x' }] })),
    ).rejects.toThrow(TypeError);
    await expect(runner.start(request({ env: { 'A B': 'x' } }))).rejects.toThrow(TypeError);
    expect((await store.list()).records).toEqual([]);
  });
});

describe('createDockerProcessRunner: crash recovery', () => {
  const cases: {
    name: string;
    state: ProcessState;
    when: 'before' | 'after';
    expected: ProcessState;
    starts: number;
  }[] = [
    {
      name: 'after create, before it was recorded',
      state: 'created',
      when: 'before',
      expected: 'running',
      starts: 1,
    },
    {
      name: 'after created was recorded, before staging was',
      state: 'staged',
      when: 'before',
      expected: 'running',
      starts: 1,
    },
    {
      name: 'after start-dispatched, before the start command',
      state: 'start-dispatched',
      when: 'after',
      expected: 'needs-reconcile',
      starts: 0,
    },
    {
      name: 'after the start command, before running was recorded',
      state: 'running',
      when: 'before',
      expected: 'running',
      starts: 1,
    },
  ];
  for (const c of cases)
    it(`a host that crashed ${c.name} reconnects without a second container or start`, async () => {
      const fake = await fakeDocker(bundle);
      const durable = createInMemoryProcessOperationStore();
      const crashed = setup(fake, {
        store: crashingStore(durable, { state: c.state, when: c.when }),
      });
      await expect(crashed.runner.start(request())).rejects.toThrow(HostCrash);

      const restarted = setup(fake, { store: durable });
      const session = await restarted.runner.start(request());
      expect(session.state).toBe(c.expected);
      expect(fake.containers()).toHaveLength(1);
      expect(startCount(fake)).toBe(c.starts);
      expect(count(fake, 'start')).toBe(c.starts);
    });
});

describe('createDockerProcessRunner: poll, output and exit', () => {
  it('records the exit with a bounded output tail that survives dispose', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    const session = await runner.start(
      request({ command: ['echo', 'out', ';', 'stderr', 'err', ';', 'exit', '4'] }),
    );
    expect(session).toMatchObject({ state: 'exited', exitCode: 4 });
    expect(session.startedAt).toEqual(expect.any(Number));
    expect(session.endedAt).toEqual(expect.any(Number));
    const output = {
      stdout: 'out\n',
      stderr: 'err\n',
      truncated: { stdout: false, stderr: false },
    };
    expect(await runner.readOutput('tenant-a', 'op-1')).toEqual(output);
    await runner.dispose('tenant-a', 'op-1');
    expect(fake.containers()).toEqual([]);
    expect(await runner.readOutput('tenant-a', 'op-1')).toEqual(output);
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('disposed');
    expect(
      (
        await runner.start(
          request({ command: ['echo', 'out', ';', 'stderr', 'err', ';', 'exit', '4'] }),
        )
      ).state,
    ).toBe('disposed');
    await runner.dispose('tenant-a', 'op-1');
    expect(startCount(fake)).toBe(0);
  });

  it('keeps only the tail and says it was cut', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake, { maxOutputBytes: 10 });
    await runner.start(request({ command: ['emit', '25', 'z', ';', 'echo', 'END'] }));
    expect(await runner.readOutput('tenant-a', 'op-1')).toEqual({
      stdout: 'zzzzzzEND\n',
      stderr: '',
      truncated: { stdout: true, stderr: false },
    });
  });

  it('a poll notices the exit of a running process', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request());
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('running');
    fake.update((state) => {
      const container = Object.values(state.containers)[0]!;
      container.state = 'exited';
      container.exitCode = 0;
      container.stdout = 'finished\n';
      container.finishedAt = new Date().toISOString();
    });
    expect(await runner.poll('tenant-a', 'op-1')).toMatchObject({ state: 'exited', exitCode: 0 });
    expect((await runner.readOutput('tenant-a', 'op-1')).stdout).toBe('finished\n');
  });

  it('a container that vanished is lost, and never recreated', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request());
    fake.update((state) => {
      state.containers = {};
    });
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('lost');
    expect((await runner.start(request())).state).toBe('lost');
    expect(count(fake, 'create')).toBe(1);
  });

  it('writes stdin through the one start command and passes env by file', async () => {
    const fake = await fakeDocker(bundle);
    const { runner, store } = setup(fake);
    await runner.start(
      request({
        command: ['cat', ';', 'env', 'TOKEN'],
        stdin: 'piped in\n',
        env: { TOKEN: 'tok-value' },
      }),
    );
    let session = await runner.poll('tenant-a', 'op-1');
    for (let i = 0; i < 50 && session.state !== 'exited'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      session = await runner.poll('tenant-a', 'op-1');
    }
    expect(session.state).toBe('exited');
    expect((await runner.readOutput('tenant-a', 'op-1')).stdout).toBe('piped in\ntok-value\n');
    expect(fake.calls().find((argv) => argv[0] === 'create')).toContain('--interactive');
    expect(fake.calls().find((argv) => argv[0] === 'start')).toEqual(
      expect.arrayContaining(['--attach', '--interactive']),
    );
    expect(JSON.stringify(fake.calls())).not.toContain('tok-value');
    expect(JSON.stringify((await store.get('tenant-a', 'op-1'))!.request)).not.toContain(
      'tok-value',
    );
    expect((await store.get('tenant-a', 'op-1'))!.request.envKeys).toEqual(['TOKEN']);
  });

  it('a deadline that passed while the host was down cancels on reconnect', async () => {
    const fake = await fakeDocker(bundle);
    const time = manualClock(100_000);
    const store = createInMemoryProcessOperationStore({ deps: { clock: time.clock } });
    const first = setup(fake, {
      store,
      clock: { now: time.clock.now, setTimeout: () => () => {} },
    });
    const session = await first.runner.start(request({ deadlineAt: 101_000 }));
    expect(session).toMatchObject({ state: 'running', deadlineAt: 101_000, durableTimeout: false });
    await time.advance(5_000);
    const second = setup(fake, { store, clock: time.clock });
    expect((await second.runner.poll('tenant-a', 'op-1')).state).toBe('cancelled');
    expect(count(fake, 'stop')).toBe(1);
  });

  it('a start past its deadline never starts the container (R4-6)', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    const session = await runner.start(
      request({ command: ['echo', 'ran', ';', 'exit', '0'], deadlineAt: Date.now() - 60_000 }),
    );
    expect(session.state).toBe('cancelled');
    expect(startCount(fake)).toBe(0);
    expect(count(fake, 'start')).toBe(0);
    expect(fake.containers()).toEqual([]);
  });

  it('a pre-start operation past its deadline is cancelled at the next poll or reconcile (R4-6)', async () => {
    const fake = await fakeDocker(bundle);
    const time = manualClock(100_000);
    const durable = createInMemoryProcessOperationStore({ deps: { clock: time.clock } });
    const hostDown = { now: time.clock.now, setTimeout: () => () => {} };
    // Each host crashes just before its start-dispatched record: 'staged'.
    for (const operationId of ['polled', 'reconciled']) {
      const crashed = setup(fake, {
        store: crashingStore(durable, { state: 'start-dispatched', when: 'before' }),
        clock: hostDown,
      });
      await expect(
        crashed.runner.start(request({ operationId, deadlineAt: 101_000 })),
      ).rejects.toThrow(HostCrash);
    }
    // A host that recorded the request and stopped before creating anything.
    const recordOnly = recordThenCrash(durable);
    await expect(
      setup(fake, { store: recordOnly, clock: hostDown }).runner.start(
        request({ operationId: 'recorded', deadlineAt: 101_000 }),
      ),
    ).rejects.toThrow(HostCrash);
    await time.advance(5_000);
    const restarted = setup(fake, { store: durable, clock: time.clock });
    expect((await restarted.runner.poll('tenant-a', 'polled')).state).toBe('cancelled');
    expect((await restarted.runner.poll('tenant-a', 'recorded')).state).toBe('cancelled');
    const report = await restarted.runner.reconcile();
    expect(report.matched.map((s) => [s.operationId, s.state])).toEqual([
      ['reconciled', 'cancelled'],
    ]);
    expect(startCount(fake)).toBe(0);
    expect(fake.containers()).toEqual([]);
  });

  it('a cancel of a fresh record never touches an earlier operation left under its name (R4-6)', async () => {
    const fake = await fakeDocker(bundle);
    const { runner, store } = setup(fake);
    await runner.start(request({ command: ['echo', 'old', ';', 'exit', '7'] }));
    expect(await store.prune({ terminalBefore: Date.now() + 1_000 })).toBe(1);
    const late = await runner.start(
      request({ command: ['echo', 'new'], deadlineAt: Date.now() - 1_000 }),
    );
    expect(late).toMatchObject({ state: 'cancelled' });
    expect(late.exitCode ?? null).toBeNull();
    expect(late.containerId).toBeUndefined();
    expect((await runner.readOutput('tenant-a', 'op-1')).stdout).toBe('');
    expect(fake.containers().map((c) => c.state)).toEqual(['exited']);
    // The same for a plain cancel of a record whose host stopped before create.
    expect(await store.prune({ terminalBefore: Date.now() + 1_000 })).toBe(1);
    const recordOnly = recordThenCrash(store);
    await expect(
      setup(fake, { store: recordOnly }).runner.start(request({ command: ['echo', 'other'] })),
    ).rejects.toThrow(HostCrash);
    const cancelled = await runner.cancel('tenant-a', 'op-1');
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect(cancelled.exitCode ?? null).toBeNull();
    expect(cancelled.containerId).toBeUndefined();
    expect(fake.containers().map((c) => c.state)).toEqual(['exited']);
  });

  it('while the host is up, the deadline cancels by itself', async () => {
    const fake = await fakeDocker(bundle);
    const time = manualClock(100_000);
    const { runner } = setup(fake, { clock: time.clock });
    await runner.start(request({ deadlineAt: 101_000 }));
    await time.advance(1_500);
    for (let i = 0; i < 50 && count(fake, 'stop') === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    let state = (await runner.poll('tenant-a', 'op-1')).state;
    for (let i = 0; i < 50 && state !== 'cancelled'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = (await runner.poll('tenant-a', 'op-1')).state;
    }
    expect(state).toBe('cancelled');
  });

  it('an unknown operation is operation_not_found', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await expect(runner.poll('tenant-a', 'nope')).rejects.toMatchObject({
      code: 'operation_not_found',
    });
    await expect(runner.cancel('tenant-a', 'nope')).rejects.toBeInstanceOf(DockerSandboxError);
  });
});

describe('createDockerProcessRunner: a log too large to read (R4-9)', () => {
  /** A runner whose log reads give up after `logsTimeoutMs` (120 s by default). */
  function withLogsTimeout(fake: FakeDocker, logsTimeoutMs: number, maxOutputBytes?: number) {
    const store = createInMemoryProcessOperationStore();
    const resolved = resolveDockerOptions(
      {
        image: FAKE_IMAGE,
        ...fake.cli,
        ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      },
      DEFAULT_DOCKER_SANDBOX,
    );
    return { store, runner: createDockerRunnerFromOptions({ ...resolved, logsTimeoutMs }, store) };
  }

  it('reads only a bounded tail of the log', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake, { maxOutputBytes: 16 });
    await runner.start(request({ command: ['echo', 'out', ';', 'emit-err', '64', 'e'] }));
    const logs = fake.calls().filter((argv) => argv[0] === 'logs');
    expect(logs.length).toBeGreaterThan(0);
    for (const argv of logs) expect(argv.slice(0, 3)).toEqual(['logs', '--tail', '16']);
  });

  it('a full line window says either stream may have lost earlier output', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake, { maxOutputBytes: 8 });
    const flood = Array.from({ length: 12 }, () => ['stderr', 'e', ';']).flat();
    await runner.start(request({ command: ['echo', 'out', ';', ...flood, 'exit', '0'] }));
    const output = await runner.readOutput('tenant-a', 'op-1');
    expect(output.stdout).toBe('out\n');
    expect(output.truncated).toEqual({ stdout: true, stderr: true });
    // Fewer lines than the window: exact, nothing flagged.
    const small = await fakeDocker(bundle);
    const exact = setup(small, { maxOutputBytes: 8 });
    await exact.runner.start(request({ command: ['echo', 'out', ';', 'stderr', 'e'] }));
    expect(await exact.runner.readOutput('tenant-a', 'op-1')).toEqual({
      stdout: 'out\n',
      stderr: 'e\n',
      truncated: { stdout: false, stderr: false },
    });
  });

  it('a log that streams past the timeout neither blocks the exit nor the dispose', async () => {
    const fake = await fakeDocker(bundle);
    const { runner, store } = withLogsTimeout(fake, 1_500);
    await runner.start(request());
    fake.update((state) => {
      const container = Object.values(state.containers)[0]!;
      container.state = 'exited';
      container.exitCode = 0;
      container.finishedAt = new Date().toISOString();
    });
    // `docker logs` keeps streaming: the daemon answers, the log is just too long.
    fake.fault({ command: 'logs', mode: 'trickle', times: 3 });
    expect(await runner.poll('tenant-a', 'op-1')).toMatchObject({ state: 'exited', exitCode: 0 });
    expect((await store.get('tenant-a', 'op-1'))!.output).toBeUndefined();
    await expect(runner.readOutput('tenant-a', 'op-1')).rejects.toMatchObject({
      code: 'docker_failed',
    });
    await runner.dispose('tenant-a', 'op-1');
    expect(fake.containers()).toEqual([]);
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('disposed');
  });

  it('a daemon that sends nothing at all is still unavailable', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = withLogsTimeout(fake, 1_500);
    await runner.start(request());
    fake.update((state) => {
      const container = Object.values(state.containers)[0]!;
      container.state = 'exited';
      container.finishedAt = new Date().toISOString();
    });
    fake.fault({ command: 'logs', mode: 'hang' });
    await expect(runner.poll('tenant-a', 'op-1')).rejects.toMatchObject({
      code: 'docker_unavailable',
    });
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('exited');
  });
});

describe('createDockerProcessRunner: cancel', () => {
  it('records the cancel first, then stops with a 2 s grace and verifies', async () => {
    const fake = await fakeDocker(bundle);
    const timeline: string[] = [];
    const store = timelineStore(createInMemoryProcessOperationStore(), fake, timeline);
    const { runner } = setup(fake, { store });
    await runner.start(request());
    timeline.length = 0;
    const before = fake.subcommands().length;
    const session = await runner.cancel('tenant-a', 'op-1');
    expect(session).toMatchObject({ state: 'cancelled', exitCode: 143 });
    expect(timeline[0]).toBe('store:cancel-requested');
    const calls = fake.calls().slice(before);
    expect(calls.map((argv) => (argv[0] === 'container' ? argv[1] : argv[0]))).toEqual(
      expect.arrayContaining(['stop', 'inspect']),
    );
    expect(calls.find((argv) => argv[0] === 'stop')).toEqual([
      'stop',
      '-t',
      '2',
      session.containerId,
    ]);
    expect(calls.findIndex((argv) => argv[0] === 'stop')).toBeGreaterThanOrEqual(0);
    // Idempotent.
    expect((await runner.cancel('tenant-a', 'op-1')).state).toBe('cancelled');
  });

  it('kills when the stop did not stop it', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request({ command: ['sleep-hard'] }));
    fake.fault({ command: 'stop', mode: 'noop' });
    expect(await runner.cancel('tenant-a', 'op-1')).toMatchObject({
      state: 'cancelled',
      exitCode: 137,
    });
    expect(count(fake, 'kill')).toBe(1);
  });

  it('an unreachable daemon never counts as cancelled; the next poll finishes the cancel', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request());
    fake.update((state) => {
      state.unreachable = true;
    });
    const session = await runner.cancel('tenant-a', 'op-1');
    expect(session.state).toBe('cancel-requested');
    expect(session.error?.code).toBe('docker_unavailable');
    expect(fake.containers()[0]!.state).toBe('running');
    fake.update((state) => {
      state.unreachable = false;
    });
    expect((await runner.poll('tenant-a', 'op-1')).state).toBe('cancelled');
    expect(fake.containers()[0]!.state).toBe('exited');
  });

  it('cancelling an exited process leaves it exited', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request({ command: ['exit', '0'] }));
    expect((await runner.cancel('tenant-a', 'op-1')).state).toBe('exited');
    expect(count(fake, 'stop')).toBe(0);
  });

  it('a cancel before the start keeps it from ever starting', async () => {
    const fake = await fakeDocker(bundle);
    const durable = createInMemoryProcessOperationStore();
    const crashed = setup(fake, {
      store: crashingStore(durable, { state: 'staged', when: 'before' }),
    });
    await expect(crashed.runner.start(request())).rejects.toThrow(HostCrash);
    const { runner } = setup(fake, { store: durable });
    expect((await runner.cancel('tenant-a', 'op-1')).state).toBe('cancelled');
    expect((await runner.start(request())).state).toBe('cancelled');
    expect(startCount(fake)).toBe(0);
  });

  it('a cancel between start-dispatched and the docker start leaves nothing a late start can run (R4-10)', async () => {
    const fake = await fakeDocker(bundle);
    const durable = createInMemoryProcessOperationStore();
    const hostB = setup(fake, { store: durable });
    let dispatched = false;
    let crashed = false;
    // Host A records start-dispatched; host B cancels before A's docker start
    // lands; A then crashes before it reads the record again.
    const storeA: ProcessOperationStore = {
      ...durable,
      create: (r) => durable.create(r),
      list: (q) => durable.list(q),
      prune: (o) => durable.prune(o),
      async get(s, id) {
        if (dispatched && !crashed) {
          crashed = true;
          throw new HostCrash('crash after docker start');
        }
        return durable.get(s, id);
      },
      async update(s, id, changes, o) {
        const result = await durable.update(s, id, changes, o);
        if (changes.state === 'start-dispatched' && result.status === 'committed') {
          expect((await hostB.runner.cancel(s, id)).state).toBe('cancelled');
          dispatched = true;
        }
        return result;
      },
    };
    const hostA = setup(fake, { store: storeA });
    await expect(hostA.runner.start(request())).rejects.toThrow(HostCrash);
    const hostC = setup(fake, { store: durable });
    expect((await hostC.runner.poll('tenant-a', 'op-1')).state).toBe('cancelled');
    expect(fake.containers().filter((c) => c.state === 'running')).toEqual([]);
    expect(startCount(fake)).toBe(0);
    expect((await hostC.runner.reconcile()).orphans).toEqual([]);
    // Dispose of the cancelled operation is still clean.
    await hostC.runner.dispose('tenant-a', 'op-1');
    expect((await hostC.runner.poll('tenant-a', 'op-1')).state).toBe('disposed');
  });
});

describe('createDockerProcessRunner: artifacts', () => {
  const program = [
    'mkdir',
    'out',
    ';',
    'write',
    'out/result.txt',
    'hello',
    ';',
    'symlink',
    'link.txt',
    '/etc/passwd',
    ';',
    'hardlink',
    'hard.txt',
    'out/result.txt',
    ';',
    'mkdir',
    'realdir',
    ';',
    'symlink',
    'linkdir',
    '/etc',
    ';',
    'big',
    'big.bin',
    '2000',
    ';',
    'exit',
    '0',
  ];

  it('reads a regular file from a stopped container, with the workspace-entry digest', async () => {
    const fake = await fakeDocker(bundle);
    const workspace = createInMemoryWorkspace();
    const { runner } = setup(fake, { workspace });
    await runner.start(request({ command: program }));
    const artifact = await runner.readArtifact('tenant-a', 'op-1', 'out/result.txt');
    const expected = await workspaceDigestEntry('out/result.txt', 'hello');
    expect(artifact).toMatchObject({ path: 'out/result.txt', size: 5, digest: expected.digest });
    expect(new TextDecoder().decode(artifact.bytes)).toBe('hello');
    // Never applied to the host workspace.
    expect(await workspace.list()).toEqual([]);
  });

  it('refuses links, directories, a linked parent and paths that leave the workspace', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request({ command: program }));
    for (const path of ['link.txt', 'hard.txt', 'realdir', 'linkdir/passwd'])
      await expect(runner.readArtifact('tenant-a', 'op-1', path), path).rejects.toMatchObject({
        code: 'artifact_rejected',
      });
    const before = fake.calls().length;
    for (const path of ['../etc/passwd', '/etc/passwd', 'a\\b', 'out/../../x', ''])
      await expect(runner.readArtifact('tenant-a', 'op-1', path), path).rejects.toMatchObject({
        code: 'artifact_rejected',
      });
    expect(fake.calls().length).toBe(before);
    await expect(runner.readArtifact('tenant-a', 'op-1', 'missing.txt')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses an artifact over maxArtifactBytes', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake, { maxArtifactBytes: 1_000 });
    await runner.start(request({ command: program }));
    await expect(runner.readArtifact('tenant-a', 'op-1', 'big.bin')).rejects.toMatchObject({
      code: 'artifact_too_large',
    });
  });

  it('reads nothing from a running container', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    await runner.start(request({ command: ['write', 'a.txt', 'x', ';', 'sleep'] }));
    await expect(runner.readArtifact('tenant-a', 'op-1', 'a.txt')).rejects.toMatchObject({
      code: 'process_running',
    });
  });
});

describe('createDockerProcessRunner: reconcile', () => {
  it('matches labelled containers, marks lost records and removes orphans only on request', async () => {
    const fake = await fakeDocker(bundle);
    const { runner, store } = setup(fake);
    const alive = await runner.start(request({ operationId: 'alive' }));
    const gone = await runner.start(request({ operationId: 'gone' }));
    // An orphan: a labelled container whose record another store holds.
    const other = setup(fake);
    const orphan = await other.runner.start(request({ operationId: 'orphan' }));
    fake.update((state) => {
      delete state.containers[gone.containerId!];
    });

    const report = await runner.reconcile();
    expect(report.matched.map((s) => [s.operationId, s.state])).toEqual([['alive', 'running']]);
    expect(report.lost.map((s) => [s.operationId, s.state])).toEqual([['gone', 'lost']]);
    expect(report.orphans).toEqual([
      { containerId: orphan.containerId, operationId: 'orphan', scope: 'tenant-a' },
    ]);
    expect(report.removed).toEqual([]);
    expect(fake.container(orphan.containerId!)).toBeDefined();
    expect((await store.get('tenant-a', 'gone'))!.state).toBe('lost');

    const cleanup = await runner.reconcile({ removeOrphans: true });
    expect(cleanup.removed).toEqual([orphan.containerId]);
    expect(fake.container(orphan.containerId!)).toBeUndefined();
    expect(fake.container(alive.containerId!)).toBeDefined();
    expect((await runner.reconcile({ scope: 'tenant-b' })).matched).toEqual([]);
  });

  it('leaves a live sandbox run alone: reconcile({ removeOrphans }) never kills it (R4-2)', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const { runner } = setup(fake);
    // The run ends by its own timeout: the test never writes the fake's state meanwhile.
    const pending = sandbox.runShell!({ command: 'echo started ; sleep', timeoutMs: 6_000 });
    let live: FakeContainer | undefined;
    for (let i = 0; i < 200 && !live; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      live = fake.containers().find((c) => c.state === 'running');
    }
    expect(live?.labels['deuz.kind']).toBe('sandbox');
    const report = await runner.reconcile({ removeOrphans: true });
    const res = await pending;
    expect(report.orphans).toEqual([]);
    expect(report.removed).toEqual([]);
    // Killed by its own timeout, not removed under it.
    expect(res).toMatchObject({ stdout: 'started\n', exitCode: null, timedOut: true });
    expect(res.stderr).not.toContain('docker start failed');
    expect(fake.containers()).toEqual([]);
  });

  it('reports sandbox containers and staging helpers only once no run can still be using them (R4-2)', async () => {
    const fake = await fakeDocker(bundle);
    const { runner } = setup(fake);
    const hour = 60 * 60_000;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const labels = (kind: string, extra: Record<string, string> = {}) => ({
      'deuz.operation-id': `op-${kind}`,
      'deuz.scope': 'tenant-a',
      'deuz.kind': kind,
      ...extra,
    });
    // In use: a staging helper mid-copy, a sandbox container being staged, a
    // long run still inside its timeout, an exit the run is about to remove.
    seedContainer(fake, 'a'.repeat(64), { labels: labels('staging') });
    seedContainer(fake, 'b'.repeat(64), { labels: labels('sandbox') });
    seedContainer(fake, 'c'.repeat(64), {
      labels: labels('sandbox', { 'deuz.run-timeout-ms': String(24 * hour) }),
      state: 'running',
      created: ago(2 * hour),
      startedAt: ago(2 * hour),
    });
    seedContainer(fake, 'd'.repeat(64), {
      labels: labels('sandbox', { 'deuz.run-timeout-ms': '30000' }),
      state: 'exited',
      created: ago(2 * hour),
      startedAt: ago(2 * hour),
      finishedAt: ago(1_000),
    });
    // Left behind: an old helper, an old exited run, a run long past its timeout.
    seedContainer(fake, 'e'.repeat(64), { labels: labels('staging'), created: ago(2 * hour) });
    seedContainer(fake, 'f'.repeat(64), {
      labels: labels('sandbox', { 'deuz.run-timeout-ms': '30000' }),
      state: 'exited',
      created: ago(2 * hour),
      startedAt: ago(2 * hour),
      finishedAt: ago(2 * hour),
    });
    seedContainer(fake, '9'.repeat(64), {
      labels: labels('sandbox', { 'deuz.run-timeout-ms': '30000' }),
      state: 'running',
      created: ago(2 * hour),
      startedAt: ago(2 * hour),
    });
    const report = await runner.reconcile({ removeOrphans: true });
    const leftovers = ['e'.repeat(64), 'f'.repeat(64), '9'.repeat(64)];
    expect(report.orphans.map((o) => o.containerId).sort()).toEqual(leftovers.sort());
    expect([...report.removed].sort()).toEqual(leftovers.sort());
    expect(
      fake
        .containers()
        .map((c) => c.id[0])
        .sort(),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a start that lands between the container snapshot and the record listing is not lost (R4-3)', async () => {
    const fake = await fakeDocker(bundle);
    const inner = createInMemoryProcessOperationStore();
    const other = setup(fake, { store: inner });
    let fired = false;
    const store: ProcessOperationStore = {
      ...inner,
      create: (r) => inner.create(r),
      get: (s, id) => inner.get(s, id),
      update: (s, id, c, o) => inner.update(s, id, c, o),
      prune: (o) => inner.prune(o),
      async list(query) {
        if (!fired) {
          fired = true;
          // Another host starts an operation after `docker ps` ran.
          await other.runner.start(request({ operationId: 'fresh' }));
        }
        return inner.list(query);
      },
    };
    const { runner } = setup(fake, { store });
    const report = await runner.reconcile();
    const record = await inner.get('tenant-a', 'fresh');
    expect(report.lost).toEqual([]);
    expect(report.matched.map((s) => [s.operationId, s.state])).toEqual([['fresh', 'running']]);
    expect(record!.state).toBe('running');
    expect(fake.container(record!.containerId!)?.state).toBe('running');
    expect((await other.runner.poll('tenant-a', 'fresh')).state).toBe('running');
    // A record whose container really is gone is still lost.
    fake.update((state) => {
      delete state.containers[record!.containerId!];
    });
    expect((await runner.reconcile()).lost.map((s) => s.operationId)).toEqual(['fresh']);
  });

  it("removes only the reconciled scope's dangling volumes (R4-5)", async () => {
    const fake = await fakeDocker(bundle);
    const labels = (scope: string) => ({
      'deuz.operation-id': 'x',
      'deuz.scope': scope,
      'deuz.kind': 'process',
    });
    fake.update((state) => {
      state.volumes['deuz-other-ws'] = { labels: labels('tenant-b'), files: {} };
      state.volumes['deuz-mine-ws'] = { labels: labels('tenant-a'), files: {} };
    });
    const { runner } = setup(fake);
    const report = await runner.reconcile({ scope: 'tenant-a', removeOrphans: true });
    expect(report.removed).toEqual(['deuz-mine-ws']);
    expect(Object.keys(fake.state().volumes)).toEqual(['deuz-other-ws']);
    // Without a scope, every scope's dangling volumes go.
    expect((await runner.reconcile({ removeOrphans: true })).removed).toEqual(['deuz-other-ws']);
    expect(fake.state().volumes).toEqual({});
  });

  it('finishes what a crash left: an exit, a cancel, a container created but not recorded', async () => {
    const fake = await fakeDocker(bundle);
    const durable = createInMemoryProcessOperationStore();
    const crashed = setup(fake, {
      store: crashingStore(durable, { state: 'created', when: 'before' }),
    });
    await expect(crashed.runner.start(request({ operationId: 'half' }))).rejects.toThrow(HostCrash);
    const { runner } = setup(fake, { store: durable });
    await runner.start(request({ operationId: 'ends' }));
    fake.update((state) => {
      const container = Object.values(state.containers).find(
        (c) => c.labels['deuz.operation-id'] === 'ends',
      )!;
      container.state = 'exited';
      container.exitCode = 9;
    });
    const report = await runner.reconcile();
    expect(Object.fromEntries(report.matched.map((s) => [s.operationId, s.state]))).toEqual({
      half: 'created',
      ends: 'exited',
    });
    expect(report.orphans).toEqual([]);
    // The half-made operation continues with the same request: one container, one start.
    expect((await runner.start(request({ operationId: 'half' }))).state).toBe('running');
    expect(fake.containers()).toHaveLength(2);
  });
});

describe('createDockerProcessRunner: telemetry', () => {
  it('reports deuz.process.* spans with ids, states, codes and counts only', async () => {
    const fake = await fakeDocker(bundle);
    const observer = createMemoryObserver();
    const { runner } = setup(fake, { observer });
    await runner.start(request({ command: ['echo', 'private-output', ';', 'sleep'] }));
    await runner.poll('tenant-a', 'op-1');
    await runner.cancel('tenant-a', 'op-1');
    await runner.reconcile();
    const completed = observer.events().filter((e) => e.type === 'operation.completed') as {
      operation: string;
      attributes?: Record<string, unknown>;
    }[];
    const names = completed.map((e) => e.operation);
    for (const name of [
      'deuz.process.start',
      'deuz.process.poll',
      'deuz.process.cancel',
      'deuz.process.exit',
      'deuz.process.reconcile',
    ])
      expect(names).toContain(name);
    const exit = completed.find((e) => e.operation === 'deuz.process.exit')!;
    expect(exit.attributes).toMatchObject({
      'deuz.process.operation_id': 'op-1',
      'deuz.process.truncated': false,
    });
    const reconcile = completed.find((e) => e.operation === 'deuz.process.reconcile')!;
    expect(reconcile.attributes).toMatchObject({
      'deuz.process.orphans': 0,
      'deuz.process.reconcile_result': 'clean',
    });
    for (const event of completed)
      for (const value of Object.values(event.attributes ?? {}))
        expect(['string', 'number', 'boolean']).toContain(typeof value);
    expect(JSON.stringify(observer.events())).not.toContain('private-output');
  });
});
