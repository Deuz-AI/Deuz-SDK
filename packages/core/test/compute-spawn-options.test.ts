/**
 * How the Node sandbox spawns (2.4): no console window flashes up on Windows
 * (`windowsHide`), and on POSIX the child leads its own process group
 * (`detached`) so a timeout or abort can kill everything it started with one
 * group signal. Windows has no process groups: the tree is killed with
 * `taskkill /T /F` instead. The behaviour itself is tested on real processes
 * in compute.test.ts; this file pins the spawn options, which nothing else can
 * observe, and which kill a timeout sends once the child already exited.
 */
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
 * comes; `hang` does neither. A taskkill child always exits and closes.
 */
let behaviour: 'clean' | 'exit-only' | 'hang' = 'clean';

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
    setTimeout(() => {
      if (!killer && behaviour === 'hang') return;
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
