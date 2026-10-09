/**
 * Node-only `Workspace` backend (1.8) — binds the workspace seam to a real
 * directory so an autonomous agent's files survive a process restart. Ships as
 * `@deuz-sdk/core/workspace/node`; lazily imports `node:fs/promises` /
 * `node:path` (like `mcp/stdio.ts`) so the edge-safe core never resolves a
 * node: specifier. Every path is normalized + traversal-checked in
 * `../workspace`, then re-verified to resolve INSIDE the sandbox root.
 */
import { normalizeWorkspacePath, type Workspace, type WorkspaceEntry } from '../workspace';

// Minimal node builtin shapes; `as string` specifiers keep tsup's dts builder
// from statically resolving node: (matches node/chat-store.ts + skills/node.ts).
interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  unlink(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; size: number; mtimeMs: number }>;
  readdir(
    path: string,
    opts: { withFileTypes: true },
  ): Promise<{ name: string; isDirectory(): boolean }[]>;
}
interface NodePath {
  join(...parts: string[]): string;
  dirname(p: string): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  sep: string;
}

async function load(): Promise<{ fs: NodeFs; path: NodePath }> {
  try {
    const fs = (await import('node:fs/promises' as string)) as unknown as NodeFs;
    const path = (await import('node:path' as string)) as unknown as NodePath;
    return { fs, path };
  } catch (err) {
    throw new Error(
      'createFileWorkspace requires a Node runtime (node:fs/promises). Use createInMemoryWorkspace on the edge.',
      { cause: err },
    );
  }
}

export interface FileWorkspaceOptions {
  /** Sandbox root directory. Created on first write. Every path resolves inside it. */
  root: string;
}

/**
 * True when a `path.relative` result leaves its base: it starts with a real `..`
 * SEGMENT, two dots followed by the separator or the end. A bare
 * `startsWith('..')` also matched ordinary names such as `..notes` or `...` and
 * refused them as traversal (F11).
 */
const climbsOut = (path: NodePath, rel: string): boolean =>
  rel === '..' || rel.startsWith(`..${path.sep}`);

/** Nothing at the path: it is missing, or one of its parents is a file. */
const isMissing = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * A `Workspace` backed by a sandboxed directory. Reads/writes/lists happen
 * under `root`; a path that would escape the root (after normalization) throws,
 * from every method. `write` creates parent directories. A missing path is the
 * only soft case: `exists` returns false and `delete` is a no-op; any other
 * failure (deleting a directory, a locked file) rejects.
 */
export function createFileWorkspace(options: FileWorkspaceOptions): Workspace {
  // Layer 2: lexical containment, defense in depth over normalizeWorkspacePath.
  //
  // `path.isAbsolute(relToRoot)` is load-bearing and not redundant: when the two
  // sides live on DIFFERENT DEVICES (a Windows drive letter, a UNC share)
  // `path.relative` returns an absolute path rather than a '..'-prefixed one, so
  // the '..' test alone accepted `D:/x` from a root on `C:`. The primary fix is
  // in normalizeWorkspacePath (every backend shares it); this keeps the file
  // backend self-sufficient.
  const lexicalInside = (path: NodePath, root: string, rel: string): string => {
    const abs = path.resolve(root, normalizeWorkspacePath(rel));
    const relToRoot = path.relative(root, abs);
    if (
      climbsOut(path, relToRoot) ||
      path.isAbsolute(relToRoot) ||
      path.resolve(root, relToRoot) !== abs
    ) {
      throw new Error(`Workspace path '${rel}' escapes the sandbox root.`);
    }
    return abs;
  };

  // Layer 3: the real path. Layers 1-2 are pure string math and CANNOT see a
  // symlink or an NTFS junction, so `<root>/link -> /outside` passed every check
  // and reads/writes landed outside the sandbox. Only the filesystem can resolve
  // a link, so re-verify the deepest EXISTING ancestor of the target: anything
  // below it does not exist yet and therefore cannot be a link. The walk stops
  // at `root` — above it there is nothing left to escape from.
  const realpathOr = async (fs: NodeFs, p: string): Promise<string | undefined> => {
    try {
      return await fs.realpath(p);
    } catch {
      return undefined; // does not exist yet (a fresh write) — nothing to follow
    }
  };

  const resolveInside = async (
    fs: NodeFs,
    path: NodePath,
    root: string,
    rel: string,
  ): Promise<string> => {
    const abs = lexicalInside(path, root, rel);
    const realRoot = (await realpathOr(fs, root)) ?? path.resolve(root);
    let probe = abs;
    for (;;) {
      const real = await realpathOr(fs, probe);
      if (real !== undefined) {
        const relReal = path.relative(realRoot, real);
        // The same segment test as layer 2: with only layer 2 fixed, a `..notes`
        // write went through and its read failed here as "(via a link)".
        if (relReal !== '' && (climbsOut(path, relReal) || path.isAbsolute(relReal))) {
          throw new Error(`Workspace path '${rel}' escapes the sandbox root (via a link).`);
        }
        return abs;
      }
      if (probe === root || path.resolve(probe) === realRoot) return abs;
      const parent = path.dirname(probe);
      if (parent === probe) return abs; // filesystem root; nothing exists below it
      probe = parent;
    }
  };

  const walk = async (
    fs: NodeFs,
    path: NodePath,
    root: string,
    dir: string,
    out: WorkspaceEntry[],
  ): Promise<void> => {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dir → nothing to list
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(fs, path, root, abs, out);
        continue;
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      try {
        const info = await fs.stat(abs);
        out.push({ path: rel, size: info.size, modifiedAt: info.mtimeMs });
      } catch {
        /* raced with a delete */
      }
    }
  };

  return {
    async read(rel: string): Promise<string> {
      const { fs, path } = await load();
      const bytes = await fs.readFile(await resolveInside(fs, path, options.root, rel));
      return new TextDecoder().decode(bytes);
    },
    async readBytes(rel: string): Promise<Uint8Array> {
      const { fs, path } = await load();
      return fs.readFile(await resolveInside(fs, path, options.root, rel));
    },
    async write(rel: string, content: string): Promise<void> {
      const { fs, path } = await load();
      const abs = await resolveInside(fs, path, options.root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, new TextEncoder().encode(content));
    },
    async writeBytes(rel: string, content: Uint8Array): Promise<void> {
      const { fs, path } = await load();
      const abs = await resolveInside(fs, path, options.root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    // exists/delete used to run the guard INSIDE their try/catch: an illegal or
    // escaping path came back as `false` / a silent success, unlike read/write
    // and unlike createInMemoryWorkspace, and delete() "succeeded" on anything it
    // could not remove. Only a missing path is soft now.
    async exists(rel: string): Promise<boolean> {
      const { fs, path } = await load();
      const abs = await resolveInside(fs, path, options.root, rel);
      try {
        await fs.stat(abs);
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    async list(prefix?: string): Promise<WorkspaceEntry[]> {
      // Checked up front: per entry, an empty root never checked it at all.
      const norm = prefix ? normalizeWorkspacePath(prefix) : '';
      const { fs, path } = await load();
      const out: WorkspaceEntry[] = [];
      await walk(fs, path, options.root, options.root, out);
      const filtered = norm ? out.filter((e) => e.path.startsWith(norm)) : out;
      filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return filtered;
    },
    async delete(rel: string): Promise<void> {
      const { fs, path } = await load();
      const abs = await resolveInside(fs, path, options.root, rel);
      try {
        await fs.unlink(abs);
      } catch (err) {
        if (!isMissing(err)) throw err; // already gone is fine; still there is not
      }
    },
  };
}
