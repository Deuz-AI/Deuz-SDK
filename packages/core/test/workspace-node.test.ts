/**
 * `@deuz-sdk/core/workspace/node` — regression coverage for the sandbox-escape
 * guard in `createFileWorkspace` (`src/node/workspace.ts`).
 *
 * This is a SECURITY CONTROL: an autonomous agent picks the path, so every
 * hostile string a model can emit must either be rejected or land inside the
 * root. The guard is two layers deep:
 *   1. `normalizeWorkspacePath` (edge core) folds `\` → `/`, strips a leading
 *      `./`, and throws `InvalidRequestError` on an empty path, a leading `/`,
 *      or any `..` segment.
 *   2. `resolveInside` (node backend) re-verifies with `path.resolve` +
 *      `path.relative` and throws a plain `Error('… escapes the sandbox root.')`.
 * Which layer fires is PLATFORM DEPENDENT (an absolute Windows path has no
 * leading `/`, so on win32 only layer 2 catches it) — the tests below assert the
 * universal property (never escape) and pin the layer only where it is stable.
 *
 * Layout: <base>/root is the sandbox, <base>/outside is a real, writable escape
 * target holding a secret — so a guard regression produces a visible artifact
 * rather than a silent pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWorkspace } from '../src/node/workspace';
import type { Workspace } from '../src/types/workspace';

const SECRET = 'TOP SECRET';
/** Sentinel written by escape attempts; must only ever appear under the root. */
const MARKER = 'MARKER-ba5eba11';
const isWin = process.platform === 'win32';

let base: string;
let root: string;
let outside: string;
let ws: Workspace;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'deuz-ws-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), SECRET);
  ws = createFileWorkspace({ root });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Every file currently under `outside/`, so an escape is provable. */
async function outsideFiles(): Promise<string[]> {
  return (await readdir(outside)).sort();
}

/**
 * The universal invariant: a hostile path either throws, or the bytes land
 * INSIDE the root. `ws.list()` only walks the root, so a write that escaped is
 * absent from it and the assertion fails loudly.
 */
async function writeAndAssertContained(rel: string): Promise<'rejected' | 'contained'> {
  try {
    await ws.write(rel, MARKER);
  } catch {
    expect(await outsideFiles()).toEqual(['secret.txt']);
    return 'rejected';
  }
  const entries = await ws.list();
  const bodies = await Promise.all(entries.map((e) => ws.read(e.path)));
  expect(bodies, `'${rel}' was accepted but its bytes are not under the root`).toContain(MARKER);
  expect(await outsideFiles()).toEqual(['secret.txt']);
  return 'contained';
}

describe('createFileWorkspace — sandbox escape guard', () => {
  // Layer 1 rejects these identically on every platform: after the backslash
  // fold they are either absolute (leading `/`, which covers UNC `\\server\…`)
  // or contain a `..` segment.
  it.each([
    ['../x', 'parent traversal'],
    ['../../etc/passwd', 'double parent traversal'],
    ['/etc/passwd', 'absolute POSIX path'],
    ['a/../../b', 'traversal hidden mid-path'],
    ['./../x', 'traversal behind a leading ./'],
    ['..\\..\\etc\\passwd', 'backslash-separated traversal (folded, so also rejected on POSIX)'],
    ['\\\\server\\share\\x', 'UNC path (folds to //server/share/x)'],
    ['//server/share/x', 'already-folded UNC path'],
    ['', 'empty path'],
  ])('rejects %j (%s) on read and write', async (bad) => {
    await expect(ws.read(bad)).rejects.toThrow(/Illegal workspace path|Empty workspace path/);
    await expect(ws.write(bad, MARKER)).rejects.toThrow(
      /Illegal workspace path|Empty workspace path/,
    );
    await expect(ws.readBytes!(bad)).rejects.toThrow(/workspace path/i);
    await expect(ws.writeBytes!(bad, new Uint8Array([1]))).rejects.toThrow(/workspace path/i);
    expect(await outsideFiles()).toEqual(['secret.txt']);
  });

  it('rejects the error type callers can branch on (InvalidRequestError, code invalid_request)', async () => {
    await expect(ws.write('../x', MARKER)).rejects.toMatchObject({
      name: 'InvalidRequestError',
      code: 'invalid_request',
    });
    // Layer 2 is a plain Error — it is defense in depth, not a caller-facing code.
    await expect(ws.write(join(outside, 'pwned.txt'), MARKER)).rejects.toThrow(
      /escapes the sandbox root|Illegal workspace path/,
    );
  });

  it('rejects an absolute native path pointing at a real directory outside the root', async () => {
    // win32: layer 2 (`C:\…` has no leading `/`). POSIX: layer 1 (leading `/`).
    // Either way the secret stays unreadable and no file appears outside.
    await expect(ws.read(join(outside, 'secret.txt'))).rejects.toThrow(
      /escapes the sandbox root|Illegal workspace path/,
    );
    expect(await writeAndAssertContained(join(outside, 'pwned.txt'))).toBe('rejected');
    expect(await readFile(join(outside, 'secret.txt'), 'utf-8')).toBe(SECRET);
  });

  it.skipIf(!isWin)(
    'rejects a drive-letter absolute path on the ROOT drive (layer 2)',
    async () => {
      // 'C:/Windows/…' survives layer 1 (no leading `/`, no `..`). Derive the
      // letter from the root so the case stays on ONE device wherever tmpdir
      // lives — the cross-DEVICE variant is a known gap, pinned separately below.
      const drive = root.slice(0, 2);
      expect(await writeAndAssertContained(`${drive}/Windows/System32/drivers/etc/hosts`)).toBe(
        'rejected',
      );
    },
  );

  it('rejects a drive-letter path on EVERY platform, not just win32', async () => {
    // Deliberately uniform (1.9): POSIX could treat 'C:/…' as a relative path
    // whose first segment is literally named 'C:', but a path that is contained
    // on Linux and escapes the sandbox on Windows is the worst possible split for
    // a portable SDK. Layer 1 rejects the shape everywhere.
    expect(await writeAndAssertContained('C:/Windows/System32/drivers/etc/hosts')).toBe('rejected');
  });

  it('rejects a drive-RELATIVE path ("C:name"), which used to land inside', async () => {
    // Node's win32 resolve keeps a device-relative path relative when the device
    // matches the accumulated root, so this previously resolved INSIDE the root.
    // Harmless there, but it is the same shape as the cross-device escape, so
    // layer 1 now refuses the whole `<letter>:` prefix rather than reasoning
    // about which device it names.
    expect(await writeAndAssertContained(`${root.slice(0, 2)}pwned.txt`)).toBe('rejected');
  });

  it('a NUL byte is rejected by the shared guard, not left to node:fs', async () => {
    // Before 1.9 a NUL passed every string check and was stopped only by node:fs
    // (ERR_INVALID_ARG_VALUE), so the edge-safe guard was not self-sufficient — a
    // KV/object-store backend storing the key verbatim inherited the hole.
    await expect(ws.write('a\0b', MARKER)).rejects.toThrow(/NUL byte/);
    await expect(ws.read('a\0b')).rejects.toThrow(/NUL byte/);
    expect(await ws.list()).toEqual([]); // nothing truncated, nothing created
    expect(await outsideFiles()).toEqual(['secret.txt']);
  });

  it('exists() and delete() fail CLOSED on a hostile path (false / no-op, no throw)', async () => {
    // Both call resolveInside INSIDE their try/catch, so the guard error is
    // swallowed. That is safe — nothing outside the root is ever stat'ed or
    // unlinked — but callers must not rely on a throw here.
    expect(await ws.exists(join(outside, 'secret.txt'))).toBe(false);
    expect(await ws.exists('../x')).toBe(false);
    await ws.delete('../../etc/passwd');
    await ws.delete(join(outside, 'secret.txt'));
    expect(await readFile(join(outside, 'secret.txt'), 'utf-8')).toBe(SECRET);
  });

  it('list() never reports anything outside the root', async () => {
    await ws.write('inside.txt', 'x');
    const paths = (await ws.list()).map((e) => e.path);
    expect(paths).toEqual(['inside.txt']);
    expect(paths.some((p) => p.includes('..') || p.includes('secret'))).toBe(false);
  });
});

/**
 * REGRESSION GUARD for a bug these tests found and 1.9 fixed: the sandbox used to
 * be LEXICAL ONLY. `path.resolve`/`path.relative` are pure string math and do not
 * follow links, and nothing called `fs.realpath` — so a link planted inside the
 * root (by a shell/compute tool in the same run, a git checkout, an unpacked
 * archive, or any other process sharing the directory) made reads and writes land
 * OUTSIDE the sandbox. Reproduced unprivileged on Windows via an NTFS junction and
 * on POSIX via a directory symlink.
 *
 * Layer 3 (`resolveInside`) now re-verifies the deepest EXISTING ancestor through
 * `fs.realpath`, the only layer that can resolve a link. Keep these as normal
 * `it` — if one ever needs `it.fails` again, the sandbox is broken.
 */
const linkKinds = isWin ? (['dir', 'junction'] as const) : (['dir'] as const);

/** Plant a link at <root>/escape → <outside>. Returns the kind that worked. */
async function plantLink(): Promise<'dir' | 'junction' | undefined> {
  for (const kind of linkKinds) {
    try {
      await symlink(outside, join(root, 'escape'), kind);
      return kind;
    } catch {
      /* EPERM without Developer Mode / admin — try the next kind */
    }
  }
  return undefined;
}

describe('createFileWorkspace — symlink / junction escape (FIXED, layer 3)', () => {
  it('rejects a write through a link that points outside the root', async () => {
    const kind = await plantLink();
    // Windows refuses an unprivileged `symlink(…, 'dir')`; a junction needs no
    // privileges and is the same vector. If BOTH are refused we cannot exercise
    // the vector at all — throw so it.fails still passes, and say why.
    if (!kind) throw new Error('SKIPPED: this platform refuses to create a link unprivileged.');
    await expect(ws.write('escape/pwned.txt', MARKER)).rejects.toThrow(/escapes the sandbox root/);
    // …and nothing was created on the far side of the link.
    await expect(readFile(join(outside, 'pwned.txt'), 'utf-8')).rejects.toThrow();
  });

  it('rejects a read through a link that points outside the root', async () => {
    const kind = await plantLink();
    if (!kind) throw new Error('SKIPPED: this platform refuses to create a link unprivileged.');
    await expect(ws.read('escape/secret.txt')).rejects.toThrow(/escapes the sandbox root/);
  });
});

/**
 * KNOWN GAP #2 — see the run report / followUps: "on win32 an absolute path on a
 * DIFFERENT drive letter defeats both guard layers". Worse than the symlink gap:
 * nothing has to be pre-planted, the model just emits `D:/x/y`.
 *
 * Layer 1 passes it (no leading `/`, no `..`). Layer 2 then fails because
 * `path.win32.relative()` across devices returns the absolute TARGET — which has
 * no `..` prefix — and `path.resolve(root, thatTarget)` round-trips to itself, so
 * both conditions read as "inside". Verified against `node:path/win32`:
 *   root=C:\ws\root rel="D:/other/x" -> "D:\other\x"  (accepted, INSIDE=false)
 *   root=C:\ws\root rel="Z:/net/x"   -> "Z:\net\x"    (accepted, INSIDE=false)
 *
 * The assertion below is READ-only and targets a path that will not exist, so it
 * has no side effect on a machine that does own that drive: the point is WHICH
 * error comes back — the guard's, or the filesystem's (proving the guard let the
 * path through). Source is not mine to change in this pass.
 */
describe.skipIf(!isWin)('createFileWorkspace — cross-drive escape (FIXED, layer 1)', () => {
  /** A drive letter that is definitely not the root's own device. */
  const otherDrive = (): string => (root.slice(0, 1).toUpperCase() === 'C' ? 'D:' : 'C:');

  // Observed on win32: `expected [Function] to throw error matching /escapes the
  // sandbox root/ but got "ENOENT: no such file or directory, open
  // 'D:\deuz-sandbox-escape-probe\never.txt'"` — i.e. the guard accepted the
  // path and node:fs was handed a target outside the root.
  it('rejects an absolute path on another drive letter', async () => {
    await expect(ws.read(`${otherDrive()}/deuz-sandbox-escape-probe/never.txt`)).rejects.toThrow(
      /escapes the sandbox root|Illegal workspace path/,
    );
  });
});

describe('createFileWorkspace — happy path', () => {
  it('a nested write creates missing parent directories', async () => {
    await ws.write('notes/2026/q3/plan.md', '# plan');
    expect(await readFile(join(root, 'notes', '2026', 'q3', 'plan.md'), 'utf-8')).toBe('# plan');
    expect(await ws.exists('notes/2026/q3/plan.md')).toBe(true);
    expect(await ws.exists('notes/2026/q3/missing.md')).toBe(false);
  });

  it('round-trips text and bytes exactly (UTF-8 in, UTF-8 out)', async () => {
    const text = 'çğıöşü — 漢字 — \u{1F600}\nline2\ttab';
    await ws.write('unicode.txt', text);
    expect(await ws.read('unicode.txt')).toBe(text);
    // Byte-exact: read() decodes the same bytes writeBytes() would have stored.
    expect(Array.from(await ws.readBytes!('unicode.txt'))).toEqual(
      Array.from(new TextEncoder().encode(text)),
    );

    const bytes = new Uint8Array([0, 1, 2, 255, 128, 127]);
    await ws.writeBytes!('blob.bin', bytes);
    expect(Array.from(await ws.readBytes!('blob.bin'))).toEqual(Array.from(bytes));

    await ws.write('over.txt', 'v1');
    await ws.write('over.txt', 'v2'); // overwrites, does not append
    expect(await ws.read('over.txt')).toBe('v2');
  });

  it('accepts a backslash-separated relative path (folded to /) on every platform', async () => {
    await ws.write('a\\b\\c.txt', 'folded');
    expect(await ws.read('a/b/c.txt')).toBe('folded');
    expect((await ws.list()).map((e) => e.path)).toEqual(['a/b/c.txt']);
  });

  it('list() sorts by path, always reports / separators, and carries size + mtime', async () => {
    await ws.write('b.txt', 'bee');
    await ws.write('a/nested.txt', 'nested');
    await ws.write('a.txt', 'aye');

    const all = await ws.list();
    // Same ordering as createInMemoryWorkspace ('.' 0x2E sorts before '/' 0x2F).
    expect(all.map((e) => e.path)).toEqual(['a.txt', 'a/nested.txt', 'b.txt']);
    // The backend splits on path.sep and rejoins with '/', so a WorkspaceEntry
    // path is portable regardless of the host separator.
    expect(all.every((e) => !e.path.includes('\\'))).toBe(true);
    expect(all.find((e) => e.path === 'a.txt')!.size).toBe(3);
    expect(all.find((e) => e.path === 'a/nested.txt')!.modifiedAt).toBeGreaterThan(0);

    expect((await ws.list('a/')).map((e) => e.path)).toEqual(['a/nested.txt']);
    // A prefix is normalized too, so a backslash prefix filters the same set.
    expect((await ws.list('a\\')).map((e) => e.path)).toEqual(['a/nested.txt']);
    expect(await ws.list('nope/')).toEqual([]);
  });

  it('list() on a root that does not exist yet returns [] instead of throwing', async () => {
    const fresh = createFileWorkspace({ root: join(base, 'never-created') });
    expect(await fresh.list()).toEqual([]);
  });

  it('delete() removes a file and is a no-op for a missing one', async () => {
    await ws.write('gone.txt', 'x');
    await ws.delete('gone.txt');
    expect(await ws.exists('gone.txt')).toBe(false);
    await ws.delete('gone.txt'); // idempotent — must not throw
    await ws.delete('never-existed.txt');
  });

  it('read of a missing file rejects (ENOENT surfaces, not a silent empty string)', async () => {
    await expect(ws.read('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('two workspaces on the same root see each other (real durability)', async () => {
    await ws.write('shared.txt', 'persisted');
    const second = createFileWorkspace({ root });
    expect(await second.read('shared.txt')).toBe('persisted');
  });
});
