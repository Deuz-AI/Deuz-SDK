/**
 * How the Node sandbox spawns (2.4): no console window flashes up on Windows
 * (`windowsHide`), and on POSIX the child leads its own process group
 * (`detached`) so a timeout or abort can kill everything it started with one
 * group signal. Windows has no process groups: the tree is killed with
 * `taskkill /T /F` instead. The behaviour itself is tested on real processes
 * in compute.test.ts; this file pins the spawn options, which nothing else can
 * observe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Spawned {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

const spawned: Spawned[] = [];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options });
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
    // A sandbox child exits cleanly at once; a taskkill child too.
    setTimeout(() => {
      for (const listener of listeners.exit ?? []) listener(0, null);
      for (const listener of listeners.close ?? []) listener(0, null);
    }, 5);
    return child;
  },
}));

const { createNodeSandbox } = await import('../src/node/compute');

afterEach(() => {
  spawned.length = 0;
});

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
