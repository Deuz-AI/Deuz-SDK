/**
 * `@deuz-sdk/core/workspace` (1.8) — the edge-safe workspace seam, an in-memory
 * reference backend, and a `ToolSet` that exposes a workspace to a model.
 *
 * The workspace is an autonomous agent's externalized memory: it reads/writes
 * files here to track progress across steps, so a long run survives compaction,
 * a durable checkpoint, or a process restart (the Node backend at
 * `@deuz-sdk/core/workspace/node` persists to a real directory). This module is
 * pure Web APIs — no node builtins — so it runs anywhere `fetch` runs.
 */
import type { JSONSchema } from './types/schema';
import type { Tool, ToolSet } from './types/tool';
import type { Workspace, WorkspaceEntry } from './types/workspace';
import { InvalidRequestError } from './errors';

export type { Workspace, WorkspaceEntry } from './types/workspace';

/**
 * Normalize a workspace-relative path and reject traversal. Backslashes fold to
 * `/`, a leading `./` is stripped, and any `..` segment or absolute path throws
 * `InvalidRequestError` — a workspace backend never sees an escaping path.
 */
export function normalizeWorkspacePath(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.length === 0) {
    throw new InvalidRequestError({ message: 'Empty workspace path.' });
  }
  if (norm.startsWith('/') || norm.split('/').some((seg) => seg === '..')) {
    throw new InvalidRequestError({
      message: `Illegal workspace path '${rel}' (absolute paths and '..' traversal are not allowed).`,
    });
  }
  return norm;
}

/**
 * In-memory `Workspace` reference implementation (edge-safe, deterministic).
 * Backs tests and single-process runs; swap in `createFileWorkspace` (Node) or
 * your own KV/object-store adapter for durability across restarts. Pass a
 * `now` for `modifiedAt` timestamps (defaults to no timestamp — no ambient
 * clock is read, keeping the module deterministic).
 */
export function createInMemoryWorkspace(options: { now?: () => number } = {}): Workspace {
  const store = new Map<string, Uint8Array>();
  const times = new Map<string, number>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const put = (path: string, bytes: Uint8Array): void => {
    const key = normalizeWorkspacePath(path);
    store.set(key, bytes);
    if (options.now) times.set(key, options.now());
  };

  return {
    async read(path: string): Promise<string> {
      const key = normalizeWorkspacePath(path);
      const bytes = store.get(key);
      if (bytes === undefined) {
        throw new InvalidRequestError({ message: `Workspace path not found: '${key}'.` });
      }
      return decoder.decode(bytes);
    },
    async readBytes(path: string): Promise<Uint8Array> {
      const key = normalizeWorkspacePath(path);
      const bytes = store.get(key);
      if (bytes === undefined) {
        throw new InvalidRequestError({ message: `Workspace path not found: '${key}'.` });
      }
      return bytes;
    },
    async write(path: string, content: string): Promise<void> {
      put(path, encoder.encode(content));
    },
    async writeBytes(path: string, content: Uint8Array): Promise<void> {
      put(path, content);
    },
    async exists(path: string): Promise<boolean> {
      return store.has(normalizeWorkspacePath(path));
    },
    async list(prefix?: string): Promise<WorkspaceEntry[]> {
      const norm = prefix ? normalizeWorkspacePath(prefix) : '';
      const out: WorkspaceEntry[] = [];
      for (const [path, bytes] of store) {
        if (norm && !path.startsWith(norm)) continue;
        const modifiedAt = times.get(path);
        out.push({
          path,
          size: bytes.byteLength,
          ...(modifiedAt !== undefined ? { modifiedAt } : {}),
        });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    },
    async delete(path: string): Promise<void> {
      const key = normalizeWorkspacePath(path);
      store.delete(key);
      times.delete(key);
    },
  };
}

export interface WorkspaceToolsOptions {
  /** Expose only the read tools (`readFile`, `listFiles`). Default: false (full set). */
  readOnly?: boolean;
  /** Mark the mutating tools (`writeFile`, `deleteFile`) as needing approval. Default: false. */
  approveWrites?: boolean;
}

const readFileParams: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
  required: ['path'],
  additionalProperties: false,
};

const writeFileParams: JSONSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Workspace-relative file path.' },
    content: { type: 'string', description: 'UTF-8 text to write (overwrites).' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

const listFilesParams: JSONSchema = {
  type: 'object',
  properties: { prefix: { type: 'string', description: 'Optional path prefix filter.' } },
  additionalProperties: false,
};

const deleteFileParams: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
  required: ['path'],
  additionalProperties: false,
};

/**
 * Wrap a `Workspace` as a `ToolSet` the model can call: `readFile`, `writeFile`,
 * `listFiles`, `deleteFile`. Parameters are raw JSON Schema (no zod dependency).
 * Pass `{ readOnly: true }` for a research agent that must not mutate, or
 * `{ approveWrites: true }` to route every mutation through your `approveToolCall`
 * policy.
 */
export function createWorkspaceTools(
  workspace: Workspace,
  options: WorkspaceToolsOptions = {},
): ToolSet {
  const readFile: Tool = {
    description: 'Read a UTF-8 text file from the workspace by relative path.',
    parameters: readFileParams,
    execute: async (args) => {
      const { path } = args as { path: string };
      const content = await workspace.read(path);
      return { path, content };
    },
  };

  const listFiles: Tool = {
    description: 'List files in the workspace, optionally filtered by a path prefix.',
    parameters: listFilesParams,
    execute: async (args) => {
      const { prefix } = args as { prefix?: string };
      const files = await workspace.list(prefix);
      return { files };
    },
  };

  if (options.readOnly) return { readFile, listFiles };

  const writeFile: Tool = {
    description: 'Write (overwrite) a UTF-8 text file in the workspace.',
    parameters: writeFileParams,
    ...(options.approveWrites ? { needsApproval: true } : {}),
    execute: async (args) => {
      const { path, content } = args as { path: string; content: string };
      await workspace.write(path, content);
      return { path, bytesWritten: content.length };
    },
  };

  const deleteFile: Tool = {
    description: 'Delete a file from the workspace by relative path.',
    parameters: deleteFileParams,
    ...(options.approveWrites ? { needsApproval: true } : {}),
    execute: async (args) => {
      const { path } = args as { path: string };
      await workspace.delete(path);
      return { path, deleted: true };
    },
  };

  return { readFile, writeFile, listFiles, deleteFile };
}
