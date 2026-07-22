/**
 * Node-only background-run helpers (1.8) — a file-backed `RunStore` and a
 * "find the runs that need continuing" poll helper for a worker/cron. Ships as
 * `@deuz-sdk/core/runtime/node`; lazily imports `node:fs/promises` so the
 * edge-safe core never resolves a node: specifier.
 *
 * The worker loop itself is yours: `pollStaleRuns` returns the stale
 * `running`/`suspended` records; for each, load its `SessionStore` checkpoint
 * and continue with `resumeFromCheckpoint` / `resumeDeuzChatResponse`.
 */
import type { RunRecord, RunStatus, RunStore } from '../types/runtime';

interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: string): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
}

async function fsp(): Promise<NodeFs> {
  return (await import('node:fs/promises' as string)) as unknown as NodeFs;
}

function fileNameFor(runId: string): string {
  return `${encodeURIComponent(runId)}.json`;
}

export interface FileRunStoreOptions {
  /** Directory holding one JSON file per run (created on first write). */
  dir: string;
}

/** A `RunStore` backed by one JSON file per run (atomic-enough temp+rename). */
export function createFileRunStore(options: FileRunStoreOptions): Required<RunStore> {
  const path = (name: string): string => `${options.dir}/${name}`;

  const readAll = async (): Promise<RunRecord[]> => {
    const fs = await fsp();
    let names: string[];
    try {
      names = await fs.readdir(options.dir);
    } catch {
      return [];
    }
    const out: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await fs.readFile(path(name), 'utf8')) as RunRecord);
      } catch {
        /* skip unreadable/partial file */
      }
    }
    return out;
  };

  const write = async (record: RunRecord): Promise<void> => {
    const fs = await fsp();
    await fs.mkdir(options.dir, { recursive: true });
    const target = path(fileNameFor(record.runId));
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
    await fs.rename(temp, target);
  };

  return {
    async create(record) {
      await write(record);
    },
    async update(runId, patch) {
      const existing = await this.get(runId);
      if (existing) await write({ ...existing, ...patch, runId });
    },
    async get(runId) {
      const fs = await fsp();
      try {
        return JSON.parse(await fs.readFile(path(fileNameFor(runId)), 'utf8')) as RunRecord;
      } catch {
        return undefined;
      }
    },
    async list(filter) {
      const all = await readAll();
      return filter?.status ? all.filter((r) => r.status === filter.status) : all;
    },
    async delete(runId) {
      const fs = await fsp();
      try {
        await fs.unlink(path(fileNameFor(runId)));
      } catch {
        /* already gone */
      }
    },
  };
}

export interface PollStaleRunsOptions {
  /** A run counts as stale when `now - updatedAt >= staleMs`. Default 60_000. */
  staleMs?: number;
  /** Statuses considered continuable. Default `['running', 'suspended']`. */
  statuses?: RunStatus[];
  /** Time source (defaults to the host clock). */
  now?: () => number;
}

/**
 * Return the runs a worker should continue: `running`/`suspended` records whose
 * `updatedAt` is older than `staleMs` (their producer likely died). The worker
 * then resumes each from its `SessionStore` checkpoint.
 */
export async function pollStaleRuns(
  store: RunStore,
  options: PollStaleRunsOptions = {},
): Promise<RunRecord[]> {
  const staleMs = options.staleMs ?? 60_000;
  const statuses = options.statuses ?? (['running', 'suspended'] as RunStatus[]);
  const now = options.now ? options.now() : Date.now();
  const all = await store.list();
  return all.filter((r) => statuses.includes(r.status) && now - r.updatedAt >= staleMs);
}
