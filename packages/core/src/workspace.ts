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
import { digestWorkspaceEntries, workspaceDigestEntry, type Sha256Digest } from './internal/digest';
import { mapWithConcurrency } from './internal/p-limit';

export type { Workspace, WorkspaceEntry } from './types/workspace';

/**
 * Normalize a workspace-relative path and reject traversal. Backslashes fold to
 * `/`, a leading `./` is stripped, and any `..` segment or absolute path throws
 * `InvalidRequestError` — a workspace backend never sees an escaping path.
 *
 * This guard is the ONLY one every backend shares (the in-memory store, a KV or
 * object-store adapter, and `createFileWorkspace`), so it has to be complete on
 * its own rather than leaning on the filesystem to catch what it misses:
 *
 * - A **Windows drive-letter** path (`D:/x`, `d:x`) does not start with `/`, so
 *   the leading-slash test never saw it. On the Node backend that walked
 *   straight out of the sandbox: `path.relative` returns an ABSOLUTE path when
 *   the two sides live on different devices, so the backend's own `'..'` check
 *   passed too and the model only had to emit a foreign drive letter.
 * - A **UNC / device path** (`//server/share`, `\\?\C:\…`) folds to `//…` and is
 *   caught by the leading-slash test — pinned by a test so it stays that way.
 * - A **NUL byte** used to pass every string check and was stopped only by
 *   `node:fs` (`ERR_INVALID_ARG_VALUE`). A backend that happily stores the key
 *   verbatim — any KV — would have inherited the hole.
 */
export function normalizeWorkspacePath(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.length === 0) {
    throw new InvalidRequestError({ message: 'Empty workspace path.' });
  }
  if (norm.includes('\0')) {
    throw new InvalidRequestError({
      message: `Illegal workspace path (contains a NUL byte).`,
    });
  }
  if (
    norm.startsWith('/') ||
    /^[a-zA-Z]:/.test(norm) ||
    norm.split('/').some((seg) => seg === '..')
  ) {
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

/** Which files `digestWorkspace` covers (2.4). */
export interface DigestWorkspaceOptions {
  /**
   * Globs of the files to cover; default every file. A glob is a relative
   * path anchored at the workspace root: `*` matches within one path segment,
   * `?` one character of it, `**` any number of whole segments, and every
   * other character itself. A glob that matches a directory covers every file
   * below it, so `'src'` and `'src/**'` are the same. Use `'**\/*.ts'` for
   * files at any depth.
   */
  include?: readonly string[];
  /** Globs of files to leave out, as `include`; exclusion wins. */
  exclude?: readonly string[];
}

/** Files a workspace digest reads at once. */
const DIGEST_CONCURRENCY = 8;

/** A digest glob as a regular expression over normalized paths. */
function globPattern(glob: unknown, label: string): RegExp {
  if (typeof glob !== 'string' || glob === '')
    throw new TypeError(`${label} globs must be nonempty strings`);
  const norm = glob.replace(/^\.\//, '');
  if (
    norm === '' ||
    norm.includes('\\') ||
    norm.includes('\0') ||
    norm.startsWith('/') ||
    /^[a-zA-Z]:/.test(norm) ||
    norm.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new TypeError(
      `${label} glob ${JSON.stringify(glob)} must be a relative path: forward slashes, no '.', '..' or empty segment`,
    );
  const segments = norm.split('/');
  let source = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    for (const char of segment)
      source +=
        char === '*'
          ? '[^/]*'
          : char === '?'
            ? '[^/]'
            : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!last) source += '/';
  });
  // A match on a directory covers everything below it.
  return new RegExp(`^${source}(?:/.*)?$`, 'u');
}

function globs(value: unknown, label: string): RegExp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of globs`);
  return value.map((glob: unknown) => globPattern(glob, label));
}

/**
 * The digest of a workspace's files (2.4, spec §3.5): `deuz-workspace-v1`,
 * the SHA-256 of the canonical JSON of `{ path, size, digest }` entries
 * sorted by the UTF-8 bytes of their paths, where `digest` is `sha256:<hex>`
 * of the file's bytes. The same files give the same digest on any backend and
 * in the Docker runner's artifacts; a changed byte, path or file set changes
 * it. Use it as `GoalEvidence.workspaceDigest` and in a
 * `GoalArtifactResolver` for `verifyGoalAcceptance`.
 *
 * Files come from `workspace.list()` and are read with `readBytes` when the
 * backend has it, otherwise with `read` (whose UTF-8 encoding is hashed).
 * `include` and `exclude` choose files by glob (see `DigestWorkspaceOptions`);
 * a malformed glob throws a TypeError. A file that disappears while the
 * workspace is read rejects; digest again once writes settle. Edge-safe
 * (WebCrypto); nothing is cached or written.
 */
export async function digestWorkspace(
  workspace: Workspace,
  options: DigestWorkspaceOptions = {},
): Promise<Sha256Digest> {
  const include = globs(options.include, 'include');
  const exclude = globs(options.exclude, 'exclude') ?? [];
  const chosen = (await workspace.list()).filter(
    ({ path }) =>
      (include === undefined || include.some((glob) => glob.test(path))) &&
      !exclude.some((glob) => glob.test(path)),
  );
  const entries = await mapWithConcurrency(chosen, DIGEST_CONCURRENCY, async ({ path }) =>
    workspaceDigestEntry(
      path,
      workspace.readBytes ? await workspace.readBytes(path) : await workspace.read(path),
    ),
  );
  return digestWorkspaceEntries(entries);
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
