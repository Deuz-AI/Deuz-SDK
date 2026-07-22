/**
 * Workspace (1.8 additive) — the externalized-memory / file-system seam an
 * autonomous agent uses to persist artifacts and task state ACROSS iterations
 * (Manus's "file system as externalized memory"). A `Workspace` is a small,
 * path-addressed key/value store the agent reads and writes through tools; the
 * agent's `plan.json`, notes, and generated files all live here so they survive
 * a compaction, a checkpoint, or a whole process restart.
 *
 * The seam is storage-agnostic: `createInMemoryWorkspace()` (edge-safe) is the
 * reference, `createFileWorkspace({ root })` (`@deuz-sdk/core/workspace/node`)
 * binds it to a sandboxed directory, and any KV/object store (S3, R2, a DB
 * table) can back it in a few lines. Paths are always relative and normalized;
 * traversal (`..`, leading `/`) is rejected before the backend ever sees them.
 */

/** Metadata for one workspace entry (returned by `list`). */
export interface WorkspaceEntry {
  /** Normalized relative path (forward slashes, no leading `/`). */
  path: string;
  /** Byte length of the stored content. */
  size: number;
  /** `deps.clock.now()` ms at last write, when the backend tracks it. */
  modifiedAt?: number;
}

/**
 * A path-addressed workspace. Text is the primary currency (`read`/`write`);
 * binary helpers (`readBytes`/`writeBytes`) are optional so a text-only backend
 * can omit them. `read`/`readBytes` throw when the path is missing — guard with
 * `exists` (mirrors filesystem semantics so the Node backend needs no shim).
 */
export interface Workspace {
  /** Read a UTF-8 text file. Throws if the path does not exist. */
  read(path: string): Promise<string>;
  /** Write (overwrite) a UTF-8 text file, creating parents as needed. */
  write(path: string, content: string): Promise<void>;
  /** True when the path exists. */
  exists(path: string): Promise<boolean>;
  /** List entries, optionally under a path `prefix`. Deterministic order (sorted by path). */
  list(prefix?: string): Promise<WorkspaceEntry[]>;
  /** Remove a path. A missing path is a no-op (never throws). */
  delete(path: string): Promise<void>;
  /** Optional: read raw bytes (binary artifacts — screenshots, generated files). */
  readBytes?(path: string): Promise<Uint8Array>;
  /** Optional: write raw bytes. */
  writeBytes?(path: string, content: Uint8Array): Promise<void>;
}
