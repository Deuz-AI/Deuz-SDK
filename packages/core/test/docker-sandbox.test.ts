/**
 * createDockerSandbox (2.4, spec §3.3) on the fake Docker CLI: every run is a
 * fresh container with the default isolation (UID/GID 10001, no network,
 * 1 CPU, 512 MiB, 128 PIDs, all capabilities dropped, no-new-privileges,
 * restart=no, no host mount), the image resolved once to its immutable id and
 * never pulled, the workspace staged through a bounded archive, `cwd` kept
 * inside the workspace, the output a bounded tail with `truncated`, and the
 * container removed afterwards. The CLI always runs with `shell: false`; the
 * fake sits in a directory with spaces and non-ASCII characters, so every
 * call here also proves the argv survives Windows quoting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDockerSandbox, DockerSandboxError } from '../src/compute/docker';
import { createInMemoryWorkspace } from '../src/workspace';
import { createMemoryObserver } from '../src/observe';
import {
  awkwardNodeBinary,
  buildFakeDocker,
  FAKE_IMAGE,
  FAKE_IMAGE_ID,
  fakeDocker,
  type FakeDockerBundle,
} from './fixtures/fake-docker';

let bundle: FakeDockerBundle;
beforeAll(async () => {
  bundle = await buildFakeDocker();
});
afterAll(async () => {
  await bundle.cleanup();
});

/** The argv of the first call to `sub`. */
const callOf = (calls: string[][], sub: string) => calls.find((argv) => argv[0] === sub);
/** The value after `flag` in an argv. */
const valueOf = (argv: string[] | undefined, flag: string) =>
  argv ? argv[argv.indexOf(flag) + 1] : undefined;
const valuesOf = (argv: string[] | undefined, flag: string) =>
  (argv ?? []).flatMap((arg, index, all) => (arg === flag ? [all[index + 1]!] : []));

describe('createDockerSandbox', () => {
  it('runs code in a fresh container with every isolation default, then removes it', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const res = await sandbox.runCode({
      language: 'python',
      code: 'echo hi ; stderr warn ; exit 3',
    });
    expect(res).toMatchObject({ stdout: 'hi\n', stderr: 'warn\n', exitCode: 3 });
    expect(res).not.toHaveProperty('truncated');
    expect(res.durationMs).toEqual(expect.any(Number));

    const create = callOf(fake.calls(), 'create')!;
    expect(valueOf(create, '--pull')).toBe('never');
    expect(valueOf(create, '--user')).toBe('10001:10001');
    expect(valueOf(create, '--network')).toBe('none');
    expect(valueOf(create, '--cpus')).toBe('1');
    expect(valueOf(create, '--memory')).toBe(String(512 * 1024 * 1024));
    expect(valueOf(create, '--memory-swap')).toBe(String(512 * 1024 * 1024));
    expect(valueOf(create, '--pids-limit')).toBe('128');
    expect(valueOf(create, '--cap-drop')).toBe('ALL');
    expect(valueOf(create, '--security-opt')).toBe('no-new-privileges');
    expect(valueOf(create, '--restart')).toBe('no');
    expect(valueOf(create, '--workdir')).toBe('/workspace');
    const labels = valuesOf(create, '--label');
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^deuz\.operation-id=.+/),
        'deuz.scope=default',
        'deuz.sdk-version=2.4.0',
        'deuz.kind=sandbox',
      ]),
    );
    // The resolved, immutable image id runs, the argv exactly as given.
    expect(create.slice(create.indexOf('--entrypoint=') + 1)).toEqual([
      FAKE_IMAGE_ID,
      'python3',
      '-c',
      'echo hi ; stderr warn ; exit 3',
    ]);
    // No host workspace, no Docker socket, nothing privileged.
    for (const forbidden of ['-v', '--volume', '--mount', '--privileged', '--read-only'])
      expect(create).not.toContain(forbidden);
    expect(create.join(' ')).not.toMatch(/docker\.sock/);

    expect(fake.subcommands()).toEqual(['image', 'create', 'cp', 'start', 'inspect', 'rm']);
    expect(fake.containers()).toEqual([]);
  });

  it('resolves the image once and never pulls; a missing image is image_not_found', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: 'alpine:3.20', ...fake.cli });
    await sandbox.runCode({ language: 'sh', code: 'echo one' });
    await sandbox.runCode({ language: 'sh', code: 'echo two' });
    expect(fake.subcommands().filter((sub) => sub === 'image')).toHaveLength(1);
    expect(fake.subcommands()).not.toContain('pull');

    const missing = createDockerSandbox({ image: 'nothing:here', ...fake.cli });
    const error = await missing
      .runCode({ language: 'sh', code: 'echo x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DockerSandboxError);
    expect(error).toMatchObject({ code: 'image_not_found' });
    expect((error as Error).message).toMatch(/never pulls/);
  });

  it('stages the workspace, owned by the run user, and leaves the host workspace untouched', async () => {
    const fake = await fakeDocker(bundle);
    const workspace = createInMemoryWorkspace();
    await workspace.write('a.txt', 'alpha');
    await workspace.write('dir/ğü ş.txt', 'unicode');
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, workspace, ...fake.cli });
    const res = await sandbox.runShell!({ command: 'ls ; write out.txt made-in-container' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.split('\n').filter(Boolean)).toEqual([
      'a.txt file 10001',
      'dir dir 10001',
      'dir/ğü ş.txt file 10001',
    ]);
    expect(await workspace.exists('out.txt')).toBe(false);
  });

  it('refuses a staging archive over maxStagingBytes before creating anything', async () => {
    const fake = await fakeDocker(bundle);
    const workspace = createInMemoryWorkspace();
    await workspace.write('big.txt', 'x'.repeat(4096));
    const sandbox = createDockerSandbox({
      image: FAKE_IMAGE,
      workspace,
      maxStagingBytes: 2048,
      ...fake.cli,
    });
    const error = await sandbox
      .runCode({ language: 'sh', code: 'echo x' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'staging_too_large' });
    expect(fake.subcommands()).not.toContain('create');
  });

  it('runShell: cwd resolves inside the workspace and a path outside it is refused', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    expect((await sandbox.runShell!({ command: 'pwd', cwd: 'sub/dir' })).stdout).toBe(
      '/workspace/sub/dir\n',
    );
    expect((await sandbox.runShell!({ command: 'pwd', cwd: '/workspace/abs' })).stdout).toBe(
      '/workspace/abs\n',
    );
    const creates = fake.calls().filter((argv) => argv[0] === 'create').length;
    for (const cwd of ['..', 'sub/../..', '/etc', '/workspace-other']) {
      const res = await sandbox.runShell!({ command: 'pwd', cwd });
      expect(res.exitCode).toBeNull();
      expect(res.stderr).toMatch(/outside the sandbox root/);
    }
    expect(fake.calls().filter((argv) => argv[0] === 'create')).toHaveLength(creates);
  });

  it('a timeout kills the container, reports timedOut and still removes it', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const res = await sandbox.runCode({
      language: 'sh',
      code: 'echo started ; sleep',
      timeoutMs: 1_500,
    });
    expect(res).toMatchObject({ exitCode: null, timedOut: true });
    expect(fake.subcommands()).toContain('kill');
    expect(fake.containers()).toEqual([]);
  }, 20_000);

  it('an abort kills it the same way', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const res = await sandbox.runShell!({ command: 'sleep', signal: controller.signal });
    expect(res).toMatchObject({ exitCode: null, timedOut: true });
    expect(fake.containers()).toEqual([]);
    const aborted = await sandbox.runShell!({ command: 'echo x', signal: AbortSignal.abort() });
    expect(aborted).toMatchObject({ exitCode: null, timedOut: true });
  }, 20_000);

  it('keeps the tail of a long output and says which stream was cut', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, maxOutputBytes: 8, ...fake.cli });
    const res = await sandbox.runCode({ language: 'sh', code: 'emit 20 a ; echo end ; stderr ok' });
    expect(res.stdout).toBe('aaaaend\n');
    expect(res.stderr).toBe('ok\n');
    expect(res.truncated).toEqual({ stdout: true, stderr: false });
  });

  it('passes env through a private env file, never on the command line', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const res = await sandbox.runCode({
      language: 'sh',
      code: 'env TOKEN',
      env: { TOKEN: 's3cr3t value' },
    });
    expect(res.stdout).toBe('s3cr3t value\n');
    expect(JSON.stringify(fake.calls())).not.toContain('s3cr3t');
    await expect(
      sandbox.runCode({ language: 'sh', code: 'env X', env: { 'BAD NAME': 'x' } }),
    ).rejects.toThrow(TypeError);
  });

  it('writes stdin to the process and closes it', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const res = await sandbox.runCode({ language: 'sh', code: 'cat', stdin: 'hello çğ' });
    expect(res.stdout).toBe('hello çğ');
    expect(callOf(fake.calls(), 'create')).toContain('--interactive');
    expect(callOf(fake.calls(), 'start')).toEqual(
      expect.arrayContaining(['--attach', '--interactive']),
    );
  });

  it('readOnlyRootFilesystem: --read-only, a bounded tmpfs /tmp and a writable workspace volume', async () => {
    const fake = await fakeDocker(bundle);
    const workspace = createInMemoryWorkspace();
    await workspace.write('in.txt', 'staged');
    const sandbox = createDockerSandbox({
      image: FAKE_IMAGE,
      workspace,
      readOnlyRootFilesystem: true,
      tmpfsBytes: 1024 * 1024,
      ...fake.cli,
    });
    const res = await sandbox.runShell!({ command: 'write out.txt ok ; ls' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('in.txt file 10001');
    expect(res.stdout).toContain('out.txt file 10001');
    const create = fake
      .calls()
      .find(
        (argv) => argv[0] === 'create' && valuesOf(argv, '--label').includes('deuz.kind=sandbox'),
      )!;
    expect(create).toContain('--read-only');
    expect(valueOf(create, '--tmpfs')).toBe('/tmp:rw,nosuid,nodev,size=1048576,mode=1777');
    expect(valueOf(create, '--mount')).toMatch(
      /^type=volume,src=deuz-sbx-[^,]+-ws,dst=\/workspace$/,
    );
    // The helper that staged the volume is gone, and so is the volume.
    expect(fake.containers()).toEqual([]);
    expect(fake.state().volumes).toEqual({});
  });

  it('passes a dockerPath and a command with spaces, quotes and non-ASCII through intact', async () => {
    const fake = await fakeDocker(bundle, { dockerPath: await awkwardNodeBinary(bundle) });
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const command = `echo "quoted" & 'single' ğüş 😀 %PATH% ^caret $HOME \\back\\slash\\`;
    const res = await sandbox.runShell!({ command });
    const create = callOf(fake.calls(), 'create')!;
    expect(create.slice(-3)).toEqual(['/bin/sh', '-c', command]);
    expect(res.stdout).toBe(`${command.slice('echo '.length)}\n`);
  });

  it('answers docker_unavailable when the daemon is down', async () => {
    const fake = await fakeDocker(bundle);
    fake.update((state) => {
      state.unreachable = true;
    });
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const error = await sandbox
      .runCode({ language: 'sh', code: 'echo x' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'docker_unavailable' });
  });

  it('validates its options at creation', () => {
    expect(() => createDockerSandbox({} as never)).toThrow(TypeError);
    expect(() => createDockerSandbox({ image: FAKE_IMAGE, labels: { 'deuz.scope': 'x' } })).toThrow(
      /cannot be overridden/,
    );
    expect(() => createDockerSandbox({ image: FAKE_IMAGE, user: 'root' })).toThrow(/numeric/);
    expect(() => createDockerSandbox({ image: FAKE_IMAGE, workdir: 'relative' })).toThrow(
      TypeError,
    );
  });

  it('reports an unknown language to the model without starting anything', async () => {
    const fake = await fakeDocker(bundle);
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, ...fake.cli });
    const res = await sandbox.runCode({ language: 'cobol', code: 'x' });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toMatch(/No interpreter configured for language 'cobol'/);
    expect(fake.calls()).toEqual([]);
  });

  it('emits deuz.process.start and deuz.process.exit spans with scalar attributes only', async () => {
    const fake = await fakeDocker(bundle);
    const observer = createMemoryObserver();
    const sandbox = createDockerSandbox({ image: FAKE_IMAGE, deps: { observer }, ...fake.cli });
    await sandbox.runCode({ language: 'sh', code: 'echo secret-output ; exit 2' });
    const spans = observer.events().filter((e) => e.type === 'operation.completed');
    const names = spans.map((e) => (e as { operation: string }).operation);
    expect(names).toEqual(expect.arrayContaining(['deuz.process.start', 'deuz.process.exit']));
    const exit = spans.find(
      (e) => (e as { operation: string }).operation === 'deuz.process.exit',
    ) as {
      attributes?: Record<string, unknown>;
    };
    expect(exit.attributes).toMatchObject({
      'deuz.process.exit_code': 2,
      'deuz.process.truncated': false,
    });
    expect(JSON.stringify(observer.events())).not.toContain('secret-output');
  });
});
