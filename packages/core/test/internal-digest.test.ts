/**
 * internal/digest.ts (2.4): the one digest convention every 2.4 store, the
 * context manifest, acceptance evidence and Docker artifacts share —
 * `sha256:<hex>` over WebCrypto, canonical JSON for structured content, and the
 * workspace-entry algorithm `digestWorkspace` and Docker artifacts both use.
 * The SHA-256 results are checked against an independent implementation
 * (node:crypto), so a broken WebCrypto path cannot agree with itself.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_DIGEST_ALGORITHM,
  canonicalJson,
  compareDigestPaths,
  digestJson,
  digestWorkspaceEntries,
  isSha256Digest,
  sha256Digest,
  sha256Hex,
  workspaceDigestEntry,
} from '../src/internal/digest';

const nodeHex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

describe('sha256Hex / sha256Digest', () => {
  it('matches the published SHA-256 test vectors', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes strings as UTF-8 and bytes as they are', async () => {
    const text = 'çağrı — 🙂';
    expect(await sha256Hex(text)).toBe(nodeHex(text));
    const bytes = new Uint8Array([0, 255, 1, 128]);
    expect(await sha256Hex(bytes)).toBe(nodeHex(bytes));
  });

  it('prefixes the digest with sha256: (the existing convention)', async () => {
    const digest = await sha256Digest('abc');
    expect(digest).toBe(`sha256:${nodeHex('abc')}`);
    expect(isSha256Digest(digest)).toBe(true);
  });

  it('recognises only a lower-case sha256:<64 hex> digest', () => {
    expect(isSha256Digest(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isSha256Digest(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isSha256Digest(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(isSha256Digest('a'.repeat(64))).toBe(false);
    expect(isSha256Digest(`md5:${'a'.repeat(32)}`)).toBe(false);
    expect(isSha256Digest(42)).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: { q: 2, p: 1 } } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":{"p":1,"q":2},"z":1}}',
    );
  });

  it('orders keys by UTF-16 code unit (RFC 8785), not by locale', () => {
    // U+00E9 sorts after 'z'; an astral key (surrogate pair) sorts before U+FB01.
    expect(canonicalJson({ é: 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"é":1}');
    expect(canonicalJson({ ﬁ: 1, '🙂': 2 })).toBe('{"🙂":2,"ﬁ":1}');
  });

  it('gives equal values one encoding whatever their key insertion order', () => {
    const left = { scope: 's', revision: 2, sources: [{ kind: 'user', id: 'm1' }] };
    const right = { sources: [{ id: 'm1', kind: 'user' }], revision: 2, scope: 's' };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('omits undefined properties, so an absent optional field digests like a missing one', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('serialises numbers and strings exactly as JSON does', () => {
    expect(canonicalJson([0.1, 1e21, -0, 10, 1.5e-7])).toBe('[0.1,1e+21,0,10,1.5e-7]');
    expect(canonicalJson('a"b\\c\n ')).toBe(JSON.stringify('a"b\\c\n '));
    expect(canonicalJson('\ud800')).toBe('"\\ud800"');
  });

  it('rejects values JSON would change or drop silently', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      () => 1,
      Symbol('s'),
      undefined,
      [1, undefined],
      new Date(0),
      new Map(),
      new Uint8Array(1),
      cyclic,
      { nested: { bad: Number.NaN } },
    ]) {
      expect(() => canonicalJson(value), String(value)).toThrow(TypeError);
    }
  });

  it('accepts a shared (non-cyclic) reference twice', () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('accepts null-prototype objects', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 2;
    bare.a = 1;
    expect(canonicalJson(bare)).toBe('{"a":1,"b":2}');
  });
});

describe('digestJson', () => {
  it('is the sha256 digest of the canonical JSON', async () => {
    const value = { b: [1, 2], a: 'x' };
    expect(await digestJson(value)).toBe(`sha256:${nodeHex('{"a":"x","b":[1,2]}')}`);
  });
});

describe('workspace-entry digest', () => {
  it('describes one entry by its path, UTF-8 byte size and content digest', async () => {
    const entry = await workspaceDigestEntry('notes/é.txt', 'é');
    expect(entry).toEqual({
      path: 'notes/é.txt',
      size: 2,
      digest: `sha256:${nodeHex('é')}`,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await workspaceDigestEntry('bin/a.dat', bytes)).toEqual({
      path: 'bin/a.dat',
      size: 3,
      digest: `sha256:${nodeHex(bytes)}`,
    });
  });

  it('hashes the documented serialization of the path-sorted entries', async () => {
    const a = await workspaceDigestEntry('b.txt', 'two');
    const b = await workspaceDigestEntry('a.txt', 'one');
    const expected =
      `{"algorithm":"${WORKSPACE_DIGEST_ALGORITHM}","entries":[` +
      `{"digest":"${b.digest}","path":"a.txt","size":3},` +
      `{"digest":"${a.digest}","path":"b.txt","size":3}]}`;
    expect(WORKSPACE_DIGEST_ALGORITHM).toBe('deuz-workspace-v1');
    expect(await digestWorkspaceEntries([a, b])).toBe(`sha256:${nodeHex(expected)}`);
  });

  it('does not depend on the order entries are given in', async () => {
    const entries = await Promise.all([
      workspaceDigestEntry('src/index.ts', 'export {}'),
      workspaceDigestEntry('README.md', '# x'),
      workspaceDigestEntry('src/a/b.ts', ''),
    ]);
    const forward = await digestWorkspaceEntries(entries);
    expect(await digestWorkspaceEntries([...entries].reverse())).toBe(forward);
  });

  it('changes with any path, size or content change', async () => {
    const base = await digestWorkspaceEntries([await workspaceDigestEntry('a.txt', 'one')]);
    expect(await digestWorkspaceEntries([await workspaceDigestEntry('a.txt', 'One')])).not.toBe(
      base,
    );
    expect(await digestWorkspaceEntries([await workspaceDigestEntry('b.txt', 'one')])).not.toBe(
      base,
    );
    expect(await digestWorkspaceEntries([])).not.toBe(base);
  });

  it('sorts paths in UTF-8 byte order, as LC_ALL=C sort does', () => {
    const paths = ['b', 'a/b', 'ﬁ', '🙂', 'A', 'a', 'a-b'];
    expect([...paths].sort(compareDigestPaths)).toEqual(['A', 'a', 'a-b', 'a/b', 'b', 'ﬁ', '🙂']);
  });

  it('refuses paths that are not normalized relative workspace paths', async () => {
    for (const path of ['', '/abs', '../up', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a/', 'a\0b']) {
      await expect(workspaceDigestEntry(path, 'x'), JSON.stringify(path)).rejects.toThrow(
        TypeError,
      );
    }
  });

  it('refuses a list with a repeated path or a malformed entry', async () => {
    const entry = await workspaceDigestEntry('a.txt', 'x');
    await expect(digestWorkspaceEntries([entry, entry])).rejects.toThrow(TypeError);
    await expect(
      digestWorkspaceEntries([{ ...entry, digest: 'sha256:nothex' as `sha256:${string}` }]),
    ).rejects.toThrow(TypeError);
    await expect(digestWorkspaceEntries([{ ...entry, size: -1 }])).rejects.toThrow(TypeError);
  });
});
