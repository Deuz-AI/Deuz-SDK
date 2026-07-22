import { describe, it, expect } from 'vitest';
import {
  createInMemoryWorkspace,
  createWorkspaceTools,
  normalizeWorkspacePath,
} from '../src/workspace';
import type { ToolExecuteContext } from '../src/types/tool';

const ctx: ToolExecuteContext = { toolCallId: 'call_1', messages: [] };

describe('normalizeWorkspacePath', () => {
  it('folds backslashes and strips a leading ./', () => {
    expect(normalizeWorkspacePath('a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(normalizeWorkspacePath('./notes/plan.json')).toBe('notes/plan.json');
  });

  it('rejects traversal and absolute paths', () => {
    expect(() => normalizeWorkspacePath('../etc/passwd')).toThrow();
    expect(() => normalizeWorkspacePath('a/../../b')).toThrow();
    expect(() => normalizeWorkspacePath('/abs')).toThrow();
    expect(() => normalizeWorkspacePath('')).toThrow();
  });
});

describe('createInMemoryWorkspace', () => {
  it('round-trips text, reports existence, lists sorted, and deletes', async () => {
    const ws = createInMemoryWorkspace();
    await ws.write('b.txt', 'bee');
    await ws.write('a/nested.txt', 'nested');
    await ws.write('a.txt', 'aye');

    expect(await ws.read('b.txt')).toBe('bee');
    expect(await ws.exists('a/nested.txt')).toBe(true);
    expect(await ws.exists('missing.txt')).toBe(false);

    const all = await ws.list();
    expect(all.map((e) => e.path)).toEqual(['a.txt', 'a/nested.txt', 'b.txt']); // sorted
    expect(all.find((e) => e.path === 'a.txt')!.size).toBe(3);

    const underA = await ws.list('a/');
    expect(underA.map((e) => e.path)).toEqual(['a/nested.txt']);

    await ws.delete('b.txt');
    expect(await ws.exists('b.txt')).toBe(false);
    await ws.delete('b.txt'); // idempotent, no throw
  });

  it('read of a missing path throws; bytes round-trip', async () => {
    const ws = createInMemoryWorkspace();
    await expect(ws.read('nope.txt')).rejects.toBeDefined();
    await ws.writeBytes!('bin', new Uint8Array([1, 2, 3]));
    expect(Array.from(await ws.readBytes!('bin'))).toEqual([1, 2, 3]);
  });

  it('records modifiedAt when a now() is injected', async () => {
    let t = 1000;
    const ws = createInMemoryWorkspace({ now: () => t });
    await ws.write('x', 'v1');
    t = 2000;
    await ws.write('y', 'v2');
    const list = await ws.list();
    expect(list.find((e) => e.path === 'x')!.modifiedAt).toBe(1000);
    expect(list.find((e) => e.path === 'y')!.modifiedAt).toBe(2000);
  });
});

describe('createWorkspaceTools', () => {
  it('exposes read/write/list/delete tools driving the workspace', async () => {
    const ws = createInMemoryWorkspace();
    const tools = createWorkspaceTools(ws);
    expect(Object.keys(tools)).toEqual(['readFile', 'writeFile', 'listFiles', 'deleteFile']);

    const w = await tools.writeFile!.execute!({ path: 'note.md', content: 'hello' }, ctx);
    expect(w).toEqual({ path: 'note.md', bytesWritten: 5 });

    const r = await tools.readFile!.execute!({ path: 'note.md' }, ctx);
    expect(r).toEqual({ path: 'note.md', content: 'hello' });

    const l = (await tools.listFiles!.execute!({}, ctx)) as { files: { path: string }[] };
    expect(l.files.map((f) => f.path)).toEqual(['note.md']);

    await tools.deleteFile!.execute!({ path: 'note.md' }, ctx);
    expect(await ws.exists('note.md')).toBe(false);
  });

  it('readOnly exposes only read tools; approveWrites gates mutations', () => {
    const ws = createInMemoryWorkspace();
    expect(Object.keys(createWorkspaceTools(ws, { readOnly: true }))).toEqual([
      'readFile',
      'listFiles',
    ]);
    const gated = createWorkspaceTools(ws, { approveWrites: true });
    expect(gated.writeFile!.needsApproval).toBe(true);
    expect(gated.deleteFile!.needsApproval).toBe(true);
    expect(gated.readFile!.needsApproval).toBeUndefined();
  });
});
