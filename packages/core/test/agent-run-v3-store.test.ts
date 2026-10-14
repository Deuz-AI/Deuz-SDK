/**
 * The V3 run stores (2.4, spec §4.1, §4.4): the `AgentRunStoreV3` contract on
 * the in-memory store, the SQLite store and the Postgres store (PGlite and,
 * with DEUZ_TEST_POSTGRES_URL, a live server), and what each backend adds:
 * separate tables with their own version table, so a 2.3 process never lists,
 * prunes or resumes a V3 run.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { contextPackageBlob } from '../src/agent-run-v3-context';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createSqliteAgentRunStoreV3 } from '../src/node/runs-v3-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { envelope } from './fixtures/agent-run-store-conformance';
import { agentRunStoreV3Contracts, withBlobs } from './fixtures/agent-run-store-v3-conformance';
import { contextPackage, envelopeV3 } from './fixtures/agent-run-v3';
import { manualClock } from './fixtures/manual-clock';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

/** Disk and database stores: a loaded machine makes their I/O slow. */
const SLOW = { timeout: SLOW_TEST_TIMEOUT_MS };

agentRunStoreV3Contracts('in-memory V3 run store', async () => {
  const { clock, advance } = manualClock();
  return {
    store: createInMemoryAgentRunStoreV3({ deps: { clock } }),
    advance,
    now: async () => clock.now(),
  };
});

type DatabaseSyncConstructor = new (path: string) => SqliteDatabaseLike;
let DatabaseSync: DatabaseSyncConstructor | undefined;
try {
  const mod = (await import('node:sqlite' as string)) as { DatabaseSync?: DatabaseSyncConstructor };
  DatabaseSync = typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : undefined;
} catch {
  /* runtime without node:sqlite */
}

const tables = (db: SqliteDatabaseLike): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

const version = (db: SqliteDatabaseLike, table: string): number =>
  Number(
    (db.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as { version: number })
      .version,
  );

describe.skipIf(!DatabaseSync)('SQLite V3 run store', SLOW, () => {
  agentRunStoreV3Contracts('contract (:memory:)', async () => {
    const { clock, advance } = manualClock();
    const store = createSqliteAgentRunStoreV3({ path: ':memory:', clock });
    return { store, advance, now: async () => clock.now(), cleanup: () => store.close() };
  });

  it('keeps V3 runs in their own tables, out of the 2.3 ops store listing and pruning', async () => {
    const db = new DatabaseSync!(':memory:');
    const { clock, advance } = manualClock();
    // The 2.3 ops store owns the handle it is given; the V3 store borrows it.
    const ops = createSqliteOpsStore({ path: ':memory:', database: db, clock });
    const v3 = createSqliteAgentRunStoreV3({ database: db, clock });
    await ops.agentRuns.save(envelope('legacy', 1, { phase: 'terminal' }));
    await v3.save(envelopeV3('modern', 1, { phase: 'terminal' }));
    await advance(10);

    expect((await ops.agentRuns.list()).runs.map((run) => run.runId)).toEqual(['legacy']);
    expect(await ops.agentRuns.load('modern')).toBeUndefined();
    expect((await v3.list()).runs.map((run) => run.runId)).toEqual(['modern']);
    expect(await v3.load('legacy')).toBeUndefined();
    expect(await ops.agentRuns.prune(clock.now())).toBe(1);
    expect(await v3.load('modern')).toMatchObject({ version: 3 });

    // The 2.3 version stays where 2.3 wrote it; V3 keeps its own.
    expect(version(db, 'deuz_ops_schema')).toBe(1);
    expect(version(db, 'deuz_runs_v3_schema')).toBe(1);
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'deuz_agent_runs',
        'deuz_runs_v3',
        'deuz_runs_v3_blob_records',
        'deuz_runs_v3_blob_refs',
        'deuz_runs_v3_blobs',
        'deuz_runs_v3_forgotten',
        'deuz_runs_v3_schema',
      ]),
    );
    expect(await v3.prune({ terminalBefore: clock.now() })).toBe(1);
    await v3.close();
    // Borrowed: still open for its owner.
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    await ops.close();
  });

  it('keeps runs, blobs and redactions across a restart on a file database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-runs-v3-'));
    const path = join(dir, 'runs.db');
    try {
      const blob = await contextPackageBlob(contextPackage(0, 'restart'));
      const first = createSqliteAgentRunStoreV3({ path });
      await first.putBlob(blob);
      await first.save(withBlobs('run', 1, [blob]));
      await first.close();

      const second = createSqliteAgentRunStoreV3({ path });
      expect(await second.load('run')).toEqual(withBlobs('run', 1, [blob]));
      expect(await second.getBlob(blob.digest)).toEqual({ status: 'found', content: blob.content });
      expect(
        await second.redactForgotten({
          scope: {},
          recordId: 'mem-b',
          revisions: [1],
          operationId: 'f',
        }),
      ).toBe(1);
      await second.close();

      const third = createSqliteAgentRunStoreV3({ path });
      expect(await third.getBlob(blob.digest)).toEqual({ status: 'redacted' });
      expect((await third.load('run'))?.context?.steps[0]?.manifest.redacted).toBe(true);
      await third.save({ ...(await third.load('run'))!, revision: 2 });
      await third.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });

  it('refuses calls after close, and a schema a newer build wrote', async () => {
    const db = new DatabaseSync!(':memory:');
    const store = createSqliteAgentRunStoreV3({ database: db });
    await store.save(envelopeV3('run', 1));
    await store.close();
    await store.close();
    await expect(store.load('run')).rejects.toThrow(/closed/);
    db.exec('UPDATE deuz_runs_v3_schema SET version = 2 WHERE singleton = 1');
    const newer = createSqliteAgentRunStoreV3({ database: db });
    await expect(newer.load('run')).rejects.toThrow(/deuz_runs_v3_schema/);
    db.close();
  });
});
