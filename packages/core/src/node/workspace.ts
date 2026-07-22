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
 * A `Workspace` backed by a sandboxed directory. Reads/writes/lists happen
 * under `root`; a path that would escape the root (after normalization) throws.
 * `write` creates parent directories; `delete` of a missing path is a no-op.
 */
export function createFileWorkspace(options: FileWorkspaceOptions): Workspace {
  // Resolve a normalized relative path to an absolute path under the root, and
  // assert it cannot escape (defense in depth on top of normalizeWorkspacePath).
  const resolveInside = (path: NodePath, root: string, rel: string): string => {
    const abs = path.resolve(root, normalizeWorkspacePath(rel));
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.resolve(root, relToRoot) !== abs) {
      throw new Error(`Workspace path '${rel}' escapes the sandbox root.`);
    }
    return abs;
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
      const bytes = await fs.readFile(resolveInside(path, options.root, rel));
      return new TextDecoder().decode(bytes);
    },
    async readBytes(rel: string): Promise<Uint8Array> {
      const { fs, path } = await load();
      return fs.readFile(resolveInside(path, options.root, rel));
    },
    async write(rel: string, content: string): Promise<void> {
      const { fs, path } = await load();
      const abs = resolveInside(path, options.root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, new TextEncoder().encode(content));
    },
    async writeBytes(rel: string, content: Uint8Array): Promise<void> {
      const { fs, path } = await load();
      const abs = resolveInside(path, options.root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    async exists(rel: string): Promise<boolean> {
      const { fs, path } = await load();
      try {
        await fs.stat(resolveInside(path, options.root, rel));
        return true;
      } catch {
        return false;
      }
    },
    async list(prefix?: string): Promise<WorkspaceEntry[]> {
      const { fs, path } = await load();
      const out: WorkspaceEntry[] = [];
      await walk(fs, path, options.root, options.root, out);
      const filtered = prefix
        ? out.filter((e) => e.path.startsWith(normalizeWorkspacePath(prefix)))
        : out;
      filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return filtered;
    },
    async delete(rel: string): Promise<void> {
      const { fs, path } = await load();
      try {
        await fs.unlink(resolveInside(path, options.root, rel));
      } catch {
        /* already gone */
      }
    },
  };
}
