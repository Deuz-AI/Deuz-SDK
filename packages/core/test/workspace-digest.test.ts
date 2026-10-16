/**
 * workspace-digest.test.ts (2.4, spec §3.5) — `digestWorkspace` hashes what a
 * workspace holds with the `deuz-workspace-v1` algorithm: SHA-256 of the
 * canonical JSON of `{ path, size, digest }` entries sorted by UTF-8 path,
 * the format Docker artifacts share. `include` and `exclude` choose files by
 * glob. Edge-safe (WebCrypto); the same files give the same digest whichever
 * backend holds them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryWorkspace, digestWorkspace } from '../src/workspace';
import type { Workspace } from '../src/workspace';
import { createFileWorkspace } from '../src/node/workspace';
import { digestWorkspaceEntries, workspaceDigestEntry } from '../src/internal/digest';

async function workspaceWith(files: Record<string, string | Uint8Array>): Promise<Workspace> {
  const workspace = createInMemoryWorkspace();
  for (const [path, content] of Object.entries(files))
    if (typeof content === 'string') await workspace.write(path, content);
    else await workspace.writeBytes!(path, content);
  return workspace;
}

const files = {
  'src/index.ts': 'export const a = 1;\n',
  'src/util/strings.ts': 'export const b = "ş";\n',
  'README.md': '# Readme\n',
  'dist/index.js': 'var a=1;',
  'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]),
};

describe('digestWorkspace', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is the deuz-workspace-v1 digest of every file', async () => {
    const expected = await digestWorkspaceEntries(
      await Promise.all(
        Object.entries(files).map(([path, data]) => workspaceDigestEntry(path, data)),
      ),
    );
    expect(await digestWorkspace(await workspaceWith(files))).toBe(expected);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does not depend on the order files were written in', async () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(await digestWorkspace(await workspaceWith(reversed))).toBe(
      await digestWorkspace(await workspaceWith(files)),
    );
  });

  it('changes with any content, path or file set change', async () => {
    const base = await digestWorkspace(await workspaceWith(files));
    for (const changed of [
      { ...files, 'README.md': '# Readme!\n' },
      { ...files, 'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 254]) },
      { ...files, 'docs/new.md': '' },
    ])
      expect(await digestWorkspace(await workspaceWith(changed))).not.toBe(base);
    const { 'README.md': readme, ...rest } = files;
    expect(await digestWorkspace(await workspaceWith({ ...rest, 'readme.md': readme }))).not.toBe(
      base,
    );
  });

  it('digests an empty workspace as the empty set', async () => {
    expect(await digestWorkspace(createInMemoryWorkspace())).toBe(await digestWorkspaceEntries([]));
  });

  it('chooses files with include and exclude globs', async () => {
    const workspace = await workspaceWith(files);
    const only = async (...paths: (keyof typeof files)[]) =>
      digestWorkspaceEntries(
        await Promise.all(paths.map((path) => workspaceDigestEntry(path, files[path]))),
      );
    expect(await digestWorkspace(workspace, { include: ['src/**'] })).toBe(
      await only('src/index.ts', 'src/util/strings.ts'),
    );
    // A pattern without a slash part still names a directory and all below it.
    expect(await digestWorkspace(workspace, { include: ['src'] })).toBe(
      await only('src/index.ts', 'src/util/strings.ts'),
    );
    // `*` stays within one segment; `**` crosses them.
    expect(await digestWorkspace(workspace, { include: ['src/*.ts'] })).toBe(
      await only('src/index.ts'),
    );
    expect(await digestWorkspace(workspace, { include: ['**/*.ts'] })).toBe(
      await only('src/index.ts', 'src/util/strings.ts'),
    );
    expect(await digestWorkspace(workspace, { include: ['logo.p?g', '*.md'] })).toBe(
      await only('README.md', 'logo.png'),
    );
    // Exclude wins over include.
    expect(await digestWorkspace(workspace, { exclude: ['dist', '**/*.png'] })).toBe(
      await only('README.md', 'src/index.ts', 'src/util/strings.ts'),
    );
    expect(await digestWorkspace(workspace, { include: ['src/**'], exclude: ['src/util'] })).toBe(
      await only('src/index.ts'),
    );
    // Regex characters in a pattern are literal.
    expect(await digestWorkspace(workspace, { include: ['README.m+'] })).toBe(
      await digestWorkspaceEntries([]),
    );
    expect(await digestWorkspace(workspace, { include: [] })).toBe(
      await digestWorkspaceEntries([]),
    );
  });

  it('hashes the UTF-8 text of a backend without readBytes', async () => {
    const full = await workspaceWith({ 'a.txt': 'çalışma\n', 'b.txt': 'b' });
    const { readBytes: _readBytes, writeBytes: _writeBytes, ...textOnly } = full;
    expect(await digestWorkspace(textOnly)).toBe(await digestWorkspace(full));
  });

  it('gives the same digest for the same files in a directory workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deuz-digest-'));
    dirs.push(root);
    const onDisk = createFileWorkspace({ root });
    for (const [path, content] of Object.entries(files))
      if (typeof content === 'string') await onDisk.write(path, content);
      else await onDisk.writeBytes!(path, content);
    expect(await digestWorkspace(onDisk)).toBe(await digestWorkspace(await workspaceWith(files)));
    expect(await digestWorkspace(onDisk, { include: ['src/**'] })).toBe(
      await digestWorkspace(await workspaceWith(files), { include: ['src/**'] }),
    );
  });

  it('refuses malformed patterns', async () => {
    const workspace = await workspaceWith(files);
    for (const options of [
      { include: [''] },
      { exclude: [3] },
      { include: 'src/**' },
      { exclude: ['/abs'] },
      { include: ['../up'] },
    ])
      await expect(
        digestWorkspace(workspace, options as never),
        JSON.stringify(options),
      ).rejects.toThrow(TypeError);
  });
});
