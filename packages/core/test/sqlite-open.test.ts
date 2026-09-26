import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteBudgetStore } from '../src/node/budget-sqlite';
import { createSqlitePopulationStore } from '../src/node/evolve-sqlite';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createSqliteStores } from '../src/node/store-sqlite';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';

let available = true;
try {
  await import('node:sqlite' as string);
} catch {
  available = false;
}

interface OpenedStore {
  probe(): Promise<unknown>;
  close(): Promise<void>;
}

// Every SQLite store opens the same way, so each one gets the same two checks.
const STORES: { name: string; open(path: string, wal?: boolean): OpenedStore }[] = [
  {
    name: 'swarm',
    open(path, wal) {
      const store = createSqliteSwarmStore({ path, wal });
      return { probe: () => store.load({ scope: 's', runId: 'r' }), close: () => store.close() };
    },
  },
  {
    name: 'ops',
    open(path, wal) {
      const store = createSqliteOpsStore({ path, wal });
      return { probe: async () => store.agentRuns.load('r'), close: () => store.close() };
    },
  },
  {
    name: 'evolve population',
    open(path, wal) {
      const store = createSqlitePopulationStore({ path, wal });
      return { probe: () => store.loadRun({ scope: 's', runId: 'r' }), close: () => store.close() };
    },
  },
  {
    name: 'budget',
    open(path, wal) {
      const store = createSqliteBudgetStore({ path, wal });
      return { probe: () => store.usage('user:1'), close: () => store.close() };
    },
  },
  {
    name: 'memory and chat',
    open(path, wal) {
      const stores = createSqliteStores({ path, wal });
      return { probe: () => stores.sweepExpiredMemories(0), close: () => stores.close() };
    },
  },
];

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
  );
  return directory;
}

/**
 * Holds an exclusive lock on the file from another process for 400ms. The exit
 * promise is wrapped: an async function returning it bare would wait for it.
 */
async function holdLock(path: string): Promise<{ exited: Promise<unknown> }> {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    `const db = new DatabaseSync(${JSON.stringify(path)});`,
    "db.exec('BEGIN EXCLUSIVE');",
    "process.stdout.write('locked\\n');",
    "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);",
  ].join('\n');
  const holder = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
  return { exited };
}

describe.skipIf(!available)('SQLite store opening', () => {
  for (const store of STORES) {
    describe(`${store.name} store`, () => {
      it('waits for a write lock another process holds while opening', async () => {
        const path = join(await temporaryDirectory('deuz-sqlite-lock-'), 'locked.sqlite');
        // A rollback-journal file: reading it, or switching it to WAL, needs a
        // lock the holder has.
        const first = store.open(path, false);
        await first.probe();
        await first.close();
        const { exited } = await holdLock(path);
        const second = store.open(path);
        cleanup.push(() => second.close());
        await second.probe();
        await exited;
      });

      it('retries opening after a failed attempt instead of caching the failure', async () => {
        const directory = await temporaryDirectory('deuz-sqlite-retry-');
        const opened = store.open(join(directory, 'later', 'store.sqlite'));
        cleanup.push(() => opened.close());
        await expect(opened.probe()).rejects.toThrow();
        await mkdir(join(directory, 'later'));
        await expect(opened.probe()).resolves.not.toBeInstanceOf(Error);
      });
    });
  }
});
