/**
 * The V3 run stores (2.4, spec §4.1, §4.4): the `AgentRunStoreV3` contract on
 * the in-memory store, the SQLite store and the Postgres store (PGlite and,
 * with DEUZ_TEST_POSTGRES_URL, a live server), and what each backend adds:
 * separate tables with their own version table, so a 2.3 process never lists,
 * prunes or resumes a V3 run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { contextPackageBlob } from '../src/agent-run-v3-context';
import { RevisionConflictError } from '../src/errors';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import type { PgPoolLike } from '../src/node/pg-tx';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createPostgresAgentRunStoreV3 } from '../src/node/runs-v3-postgres';
import { createSqliteAgentRunStoreV3 } from '../src/node/runs-v3-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { envelope } from './fixtures/agent-run-store-conformance';
import { agentRunStoreV3Contracts, withBlobs } from './fixtures/agent-run-store-v3-conformance';
import { contextPackage, envelopeV3 } from './fixtures/agent-run-v3';
import { manualClock } from './fixtures/manual-clock';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const NOW_SQL = 'SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now';
const databaseNow = async (pool: PgPoolLike) => Number((await pool.query(NOW_SQL)).rows[0]!.now);
const pgVersion = async (pool: PgPoolLike, table: string) =>
  Number((await pool.query(`SELECT version FROM ${table} WHERE singleton = 1`)).rows[0]!.version);

describe('Postgres V3 run store (PGlite pool)', SLOW, () => {
  const db = new PGlite();
  // Start-up is slow under load; keep it out of the first test's time budget.
  beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });
  const pool = pglitePool(db);
  let schemas = 0;
  const freshSchema = async () => {
    const schema = `runs_v3_${++schemas}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };

  agentRunStoreV3Contracts('contract (database time)', async () => {
    const store = createPostgresAgentRunStoreV3({ pool, schema: await freshSchema() });
    return {
      store,
      advance: wait,
      now: () => databaseNow(pool),
      cleanup: () => store.close(),
    };
  });

  it('keeps V3 runs in their own tables beside the 2.3 ops store', async () => {
    const schema = await freshSchema();
    const ops = createPostgresOpsStore({ client: pool, schema });
    const v3 = createPostgresAgentRunStoreV3({ pool, schema });
    await ops.agentRuns.save(envelope('legacy', 1, { phase: 'terminal' }));
    await v3.save(envelopeV3('modern', 1, { phase: 'terminal' }));
    await wait(5);
    const now = await databaseNow(pool);
    expect((await ops.agentRuns.list()).runs.map((run) => run.runId)).toEqual(['legacy']);
    expect(await ops.agentRuns.load('modern')).toBeUndefined();
    expect((await v3.list()).runs.map((run) => run.runId)).toEqual(['modern']);
    expect(await v3.load('legacy')).toBeUndefined();
    expect(await ops.agentRuns.prune(now + 1)).toBe(1);
    expect(await v3.load('modern')).toMatchObject({ version: 3 });
    expect(await pgVersion(pool, `${schema}.deuz_ops_schema`)).toBe(1);
    expect(await pgVersion(pool, `${schema}.deuz_runs_v3_schema`)).toBe(1);
    await v3.close();
    // Borrowed: the pool still serves its owner.
    expect((await pool.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 });
  });

  it('needs a pool and a valid schema, and refuses calls after close', async () => {
    const queryOnly = { query: pool.query.bind(pool) };
    expect(() => createPostgresAgentRunStoreV3({ pool: queryOnly as never })).toThrow(/pool/);
    expect(() => createPostgresAgentRunStoreV3({} as never)).toThrow(TypeError);
    expect(() => createPostgresAgentRunStoreV3({ pool, schema: 'Bad-Name' })).toThrow(TypeError);
    const schema = await freshSchema();
    const store = createPostgresAgentRunStoreV3({ pool, schema });
    await store.migrate();
    const tables = (
      await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
        [schema],
      )
    ).rows.map((row) => row.table_name);
    expect(tables).toEqual([
      'deuz_runs_v3',
      'deuz_runs_v3_blob_records',
      'deuz_runs_v3_blob_refs',
      'deuz_runs_v3_blobs',
      'deuz_runs_v3_forgotten',
      'deuz_runs_v3_schema',
    ]);
    await store.close();
    await store.close();
    await expect(store.load('run')).rejects.toThrow(/closed/);
    expect(pool.stats().connected).toBe(pool.stats().released);
  });

  it('refuses a schema a newer build wrote', async () => {
    const schema = await freshSchema();
    await createPostgresAgentRunStoreV3({ pool, schema }).migrate();
    await pool.query(`UPDATE ${schema}.deuz_runs_v3_schema SET version = 2`);
    await expect(createPostgresAgentRunStoreV3({ pool, schema }).load('x')).rejects.toThrow(
      /deuz_runs_v3_schema/,
    );
  });
});

const liveUrl = postgresUrl();
// A network round trip per statement, and real waits on locks.
if (liveUrl) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!liveUrl)('Postgres V3 run store (live server)', () => {
  let pool: pg.Pool;
  // One prefix per run: only the schemas this file created are dropped.
  const prefix = `deuz_l3a_runs_${Date.now().toString(36)}`;
  const schemas: string[] = [];
  const freshSchema = async () => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: liveUrl, max: 8 });
    // As in postgres-live: pooled connections default to REPEATABLE READ.
    pool.on('connect', (connection) => {
      void connection.query(
        'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      );
    });
  });
  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  agentRunStoreV3Contracts('contract (database time)', async () => {
    const store = createPostgresAgentRunStoreV3({ pool, schema: await freshSchema() });
    return { store, advance: wait, now: () => databaseNow(pool), cleanup: () => store.close() };
  });

  it('lets exactly one of two concurrent first saves win', async () => {
    const schema = await freshSchema();
    const a = createPostgresAgentRunStoreV3({ pool, schema });
    const b = createPostgresAgentRunStoreV3({ pool, schema });
    await a.migrate();
    for (let round = 0; round < 5; round++) {
      const runId = `race-${round}`;
      const outcomes = await Promise.allSettled([
        a.save(envelopeV3(runId, 1, { modelSteps: 1 })),
        b.save(envelopeV3(runId, 1, { modelSteps: 2 })),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((outcome) => outcome.status === 'rejected');
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    }
  });

  it('never leaves a forgotten record unredacted when a put races the forget', async () => {
    const schema = await freshSchema();
    const writer = createPostgresAgentRunStoreV3({ pool, schema });
    const forgetter = createPostgresAgentRunStoreV3({ pool, schema });
    await writer.migrate();
    for (let round = 0; round < 8; round++) {
      const blob = await contextPackageBlob(contextPackage(0, `race-${round}`, 100 + round));
      await Promise.all([
        writer.putBlob(blob),
        forgetter.redactForgotten({
          scope: {},
          recordId: 'mem-a',
          revisions: [100 + round],
          operationId: `f-${round}`,
        }),
      ]);
      expect(await writer.getBlob(blob.digest)).toEqual({ status: 'redacted' });
    }
  });

  it('keeps a package whose put races a prune, for the run that saves it next', async () => {
    const schema = await freshSchema();
    const writer = createPostgresAgentRunStoreV3({ pool, schema });
    const pruner = createPostgresAgentRunStoreV3({ pool, schema });
    await writer.migrate();
    await pruner.migrate();
    for (let round = 0; round < 6; round++) {
      const blob = await contextPackageBlob(contextPackage(0, `prune-race-${round}`));
      await writer.putBlob(blob);
      await writer.save(withBlobs(`old-${round}`, 1, [blob], { phase: 'terminal' }));
      await wait(5);
      const cut = await databaseNow(pool);
      await wait(5);
      const [, pruned] = await Promise.all([
        writer.putBlob(blob),
        pruner.prune({ terminalBefore: cut + 50 }),
      ]);
      expect(pruned).toBe(1);
      await writer.save(withBlobs(`new-${round}`, 1, [blob]));
      expect((await writer.getBlob(blob.digest)).status, `round ${round}`).toBe('found');
    }
  });

  it('opens and ends its own pool from a connection string', async () => {
    const schema = await freshSchema();
    const store = createPostgresAgentRunStoreV3({ connectionString: liveUrl!, schema });
    await store.save(envelopeV3('own', 1));
    expect(await store.load('own')).toMatchObject({ revision: 1 });
    await store.close();
    await expect(store.load('own')).rejects.toThrow(/closed/);
  });
});
