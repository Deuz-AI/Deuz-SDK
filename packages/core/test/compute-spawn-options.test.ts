/**
 * How the Node sandbox spawns (2.4): no console window flashes up on Windows
 * (`windowsHide`), and on POSIX the child leads its own process group
 * (`detached`) so a timeout or abort can kill everything it started with one
 * group signal. Windows has no process groups: the tree is killed with
 * `taskkill /T /F` instead. The behaviour itself is tested on real processes
 * in compute.test.ts; this file pins the spawn options, which nothing else can
 * observe, and which kill a timeout sends once the child already exited.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Spawned {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

const spawned: Spawned[] = [];
/**
 * What a sandbox child does: `clean` exits and closes at once; `exit-only`
 * exits but a program it started keeps the pipes open, so 'close' never
 * comes; `hang` does neither; `killable` hangs until taskkill ends it, then
 * exits and closes with code 1, as a process taskkill /F ended does. A
 * taskkill child always exits and closes.
 */
let behaviour: 'clean' | 'exit-only' | 'hang' | 'killable' = 'clean';
/** Ends the last sandbox child the way taskkill /F does. */
let endLastChild: (() => void) | undefined;

/** How the mocked realpath rewrites a real path; undefined passes it through. */
let realpathRewrite: ((path: string) => string) | undefined;

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    realpath: async (path: string) => {
      const resolved = await real.realpath(path);
      return realpathRewrite ? realpathRewrite(resolved) : resolved;
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options });
    const killer = /taskkill/i.test(command);
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      pid: 4242,
      stdout: { on: () => {}, destroy: () => {} },
      stderr: { on: () => {}, destroy: () => {} },
      stdin: null,
      on(event: string, listener: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(listener);
      },
      kill: () => true,
    };
    const emit = (event: string, code: number) => {
      for (const listener of listeners[event] ?? []) listener(code, null);
    };
    if (!killer)
      endLastChild = () => {
        emit('exit', 1);
        emit('close', 1);
      };
    else if (behaviour === 'killable') setTimeout(() => endLastChild?.(), 1);
    setTimeout(() => {
      if (!killer && (behaviour === 'hang' || behaviour === 'killable')) return;
      for (const listener of listeners.exit ?? []) listener(0, null);
      if (killer || behaviour === 'clean')
        for (const listener of listeners.close ?? []) listener(0, null);
    }, 5);
    return child;
  },
}));

const { createNodeSandbox } = await import('../src/node/compute');

afterEach(() => {
  spawned.length = 0;
  behaviour = 'clean';
  realpathRewrite = undefined;
  vi.restoreAllMocks();
});

const killers = () => spawned.filter((call) => /taskkill/i.test(call.command));

describe('createNodeSandbox spawn options (2.4)', () => {
  it('hides the console window and puts a POSIX child in its own process group', async () => {
    await createNodeSandbox().runCode({ language: 'node', code: '1' });
    await createNodeSandbox().runShell!({ command: 'echo hi' });
    expect(spawned).toHaveLength(2);
    for (const call of spawned) {
      expect(call.options.windowsHide).toBe(true);
      expect(call.options.detached).toBe(process.platform !== 'win32');
    }
  });
});

describe('createNodeSandbox tree kill after the child exited (R4-8)', () => {
  it.runIf(process.platform === 'win32')(
    'aims no taskkill at the pid of a child that already exited (Windows may reuse it)',
    async () => {
      behaviour = 'exit-only';
      const res = await createNodeSandbox().runShell!({
        command: 'start /b node server.js',
        timeoutMs: 100,
      });
      expect(res.timedOut).toBe(true);
      expect(killers()).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'still kills the tree of a child alive at the timeout',
    async () => {
      behaviour = 'hang';
      const res = await createNodeSandbox().runShell!({
        command: 'ping -t localhost',
        timeoutMs: 100,
      });
      expect(res.timedOut).toBe(true);
      expect(killers().map((call) => call.args)).toEqual([['/PID', '4242', '/T', '/F']]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'still signals the process group once the leader exited: its members hold the pipes',
    async () => {
      behaviour = 'exit-only';
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const res = await createNodeSandbox().runShell!({ command: 'sleep 9 &', timeoutMs: 100 });
      expect(res.timedOut).toBe(true);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    },
  );
});

describe('createNodeSandbox exit code of a killed run', () => {
  it.runIf(process.platform === 'win32')(
    'is null, as before 2.4, even when the child taskkill ended closes within the grace',
    async () => {
      behaviour = 'killable';
      const res = await createNodeSandbox().runShell!({
        command: 'ping -t localhost',
        timeoutMs: 100,
      });
      expect(killers()).toHaveLength(1);
      expect(res).toMatchObject({ timedOut: true, exitCode: null });
    },
  );
});

describe('createNodeSandbox runShell cwd (R4-11)', () => {
  it('spawns in the lexical directory; the real path only decides containment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deuz-cwd-'));
    try {
      await mkdir(join(root, 'sub'));
      const real = await import('node:fs/promises').then((fs) => fs.realpath(root));
      // A mapped network drive: its real path is a UNC path, which cmd.exe
      // refuses as a working directory (it falls back to C:\Windows).
      const unc = process.platform === 'win32' ? '\\\\server\\share\\proj' : '/net/server/proj';
      realpathRewrite = (path) => (path.startsWith(real) ? unc + path.slice(real.length) : path);
      const res = await createNodeSandbox({ cwd: root }).runShell!({ command: 'cd', cwd: 'sub' });
      expect(res.exitCode).toBe(0);
      expect(spawned.at(-1)!.options.cwd).toBe(resolve(root, 'sub'));
      // The containment check still runs on the real path: a link out is refused.
      realpathRewrite = (path) =>
        path.startsWith(real + sep + 'sub')
          ? `${unc}-elsewhere${sep}sub`
          : path.startsWith(real)
            ? unc + path.slice(real.length)
            : path;
      const refused = await createNodeSandbox({ cwd: root }).runShell!({
        command: 'cd',
        cwd: 'sub',
      });
      expect(refused.exitCode).toBeNull();
      expect(refused.stderr).toMatch(/outside the sandbox root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
