/**
 * agent-run-discovery.test.ts (2.3) — finding native runs whose executor is
 * gone. A native run saves its envelope at every step; one whose last save is
 * old and that is still running or finalizing lost its executor (or is in a
 * long tool call: the run lease tells the two apart on resume).
 */
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { findStaleAgentRuns } from '../src/ops';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { createMockModel } from '../src/testing';
import type { AgentResult, AgentRunEnvelope, AgentRunStore } from '../src/types/agent-run';
import { envelope } from './fixtures/agent-run-store-conformance';
import { manualClock } from './fixtures/manual-clock';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}

const usage = envelope('x', 1).usage;
const suspended: AgentResult<unknown> = {
  runId: 'x',
  text: '',
  messages: [],
  usage,
  modelSteps: 1,
  status: 'suspended',
  pendingApprovals: [],
  pendingClientCalls: [],
};
const completed: AgentResult<unknown> = {
  runId: 'x',
  text: 'done',
  messages: [],
  usage,
  modelSteps: 1,
  status: 'completed',
  output: 'done',
};

async function seeded() {
  const { clock, advance } = manualClock(0);
  const store = createInMemoryAgentRunStore({ clock });
  await store.save(envelope('stale-running', 1));
  await store.save(envelope('stale-finalizing', 1, { phase: 'finalizing' }));
  await store.save(envelope('stale-suspended', 1, { result: suspended }));
  await store.save(envelope('stale-terminal', 1, { phase: 'terminal', result: completed }));
  await store.save(envelope('stale-other', 1, { scope: 'other' }));
  await advance(60_000);
  await store.save(envelope('fresh', 1));
  await advance(1);
  return { store, clock, advance };
}

const ids = (runs: { runId: string }[]) => runs.map((run) => run.runId).sort();

describe('findStaleAgentRuns (2.3)', () => {
  it('finds running and finalizing runs last saved more than staleMs ago', async () => {
    const { store, clock } = await seeded();
    expect(ids(await findStaleAgentRuns(store, { staleMs: 30_000, clock }))).toEqual([
      'stale-finalizing',
      'stale-other',
      'stale-running',
    ]);
    // A suspended run waits for a person, not for an executor.
    expect(
      ids(await findStaleAgentRuns(store, { staleMs: 30_000, clock, includeSuspended: true })),
    ).toEqual(['stale-finalizing', 'stale-other', 'stale-running', 'stale-suspended']);
    expect(
      ids(await findStaleAgentRuns(store, { staleMs: 30_000, clock, scope: 'other' })),
    ).toEqual(['stale-other']);
    // Nothing is that old yet.
    expect(await findStaleAgentRuns(store, { staleMs: 120_000, clock })).toEqual([]);
  });

  it('defaults to a minute on the host clock', async () => {
    const store = createInMemoryAgentRunStore();
    await store.save(envelope('now', 1));
    expect(await findStaleAgentRuns(store)).toEqual([]);
  });

  it('pages past suspended runs and stops at limit', async () => {
    let time = 0;
    const clock = { now: () => time, setTimeout: () => () => {} };
    const store = createInMemoryAgentRunStore({ clock });
    for (let index = 0; index < 250; index++) {
      await store.save(envelope(`stale-${String(index).padStart(3, '0')}`, 1));
      // Suspended runs in between, newer than the stale ones.
      time += 1;
      await store.save(envelope(`waiting-${index}`, 1, { result: suspended }));
      time += 1;
    }
    time += 60_001;
    const found = await findStaleAgentRuns(store, { clock, limit: 120 });
    expect(found).toHaveLength(120);
    expect(found.every((run) => run.runId.startsWith('stale-'))).toBe(true);
    // Newest change first, as the store lists them.
    expect(found[0]!.runId).toBe('stale-249');
    expect((await findStaleAgentRuns(store, { clock, limit: 1000 })).length).toBe(250);
  });

  it('rejects a store that cannot list runs, and malformed options', async () => {
    const memory = createInMemoryAgentRunStore();
    const store: AgentRunStore = { load: memory.load, save: memory.save };
    await expect(findStaleAgentRuns(store)).rejects.toThrow('cannot list runs');
    for (const options of [{ staleMs: -1 }, { staleMs: Number.NaN }, { limit: 0 }, { limit: 1.5 }])
      await expect(findStaleAgentRuns(memory, options), JSON.stringify(options)).rejects.toThrow(
        TypeError,
      );
  });

  it.skipIf(!DatabaseSync)('works on a durable store', async () => {
    const { clock, advance } = manualClock(0);
    const ops = createSqliteOpsStore({ path: ':memory:', clock });
    try {
      await ops.agentRuns.save(envelope('crashed', 1));
      await ops.agentRuns.save(envelope('waiting', 1, { result: suspended }));
      await advance(90_000);
      await ops.agentRuns.save(envelope('live', 1));
      expect(ids(await findStaleAgentRuns(ops.agentRuns, { clock }))).toEqual(['crashed']);
    } finally {
      await ops.close();
    }
  });

  it('finds a native run whose executor died, which another executor then finishes', async () => {
    const { clock, advance } = manualClock(0);
    const store = createInMemoryAgentRunStore({ clock });
    // The first executor's process dies after its first save: every later write fails.
    let saves = 0;
    const dying: AgentRunStore = {
      load: store.load,
      save: async (value: AgentRunEnvelope) => {
        if (++saves > 1) throw new Error('process died');
        await store.save(value);
      },
    };
    const session = { runId: 'job-1', scope: 'tenant' };
    const first = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'Do the job.',
      session: { ...session, store: dying },
      deps: { clock },
    });
    expect(first.status).toBe('failed');
    expect(await store.load('job-1')).toMatchObject({ phase: 'running', revision: 1 });

    await advance(5 * 60_000);
    const stale = await findStaleAgentRuns(store, { clock });
    expect(stale).toEqual([
      { runId: 'job-1', scope: 'tenant', phase: 'running', revision: 1, updatedAt: 0 },
    ]);
    const resumed = await resumeAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      session: { ...session, store },
      deps: { clock },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(await findStaleAgentRuns(store, { clock })).toEqual([]);
  });
});

describe('listing the runs of a database a 2.2 process wrote (2.3)', () => {
  const payload = (runId: string, phase: string) =>
    JSON.stringify({ ...envelope(runId, 1), phase }).replace(/'/g, "''");

  it.skipIf(!DatabaseSync)('adds the index on first use and keeps version 1 (SQLite)', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(`CREATE TABLE deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
      INSERT INTO deuz_ops_schema VALUES (1, 1);
      CREATE TABLE deuz_leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, signals TEXT NOT NULL);
      CREATE TABLE deuz_agent_runs (run_id TEXT PRIMARY KEY, scope TEXT NOT NULL,
        revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO deuz_agent_runs VALUES ('old', 'tenant', 1, '${payload('old', 'running')}', 5);
      INSERT INTO deuz_agent_runs VALUES ('done', 'tenant', 1, '${payload('done', 'terminal')}', 7);`);
    const ops = createSqliteOpsStore({ path: ':memory:', database: db });
    try {
      // Listing is the first thing this store does with the file.
      expect(await ops.agentRuns.list()).toEqual({
        runs: [
          { runId: 'done', scope: 'tenant', phase: 'terminal', revision: 1, updatedAt: 7 },
          { runId: 'old', scope: 'tenant', phase: 'running', revision: 1, updatedAt: 5 },
        ],
      });
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE name = 'deuz_agent_runs_updated_at'`)
          .get(),
      ).toEqual({ name: 'deuz_agent_runs_updated_at' });
      expect(db.prepare('SELECT version FROM deuz_ops_schema').get()).toEqual({ version: 1 });
    } finally {
      await ops.close();
    }
  });

  it('adds the index on first use and keeps version 1 (Postgres)', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`CREATE SCHEMA ops22;
        CREATE TABLE ops22.deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
        INSERT INTO ops22.deuz_ops_schema VALUES (1, 1);
        CREATE TABLE ops22.deuz_agent_runs (run_id TEXT PRIMARY KEY, scope TEXT NOT NULL,
          revision BIGINT NOT NULL, payload TEXT NOT NULL, updated_at BIGINT NOT NULL);
        INSERT INTO ops22.deuz_agent_runs VALUES ('old', 'tenant', 1, '${payload('old', 'running')}', 5);`);
      const ops = createPostgresOpsStore({
        client: { query: (sql, params) => pg.query<Record<string, unknown>>(sql, params) },
        schema: 'ops22',
      });
      expect(await ops.agentRuns.list({ phases: ['running'] })).toEqual({
        runs: [{ runId: 'old', scope: 'tenant', phase: 'running', revision: 1, updatedAt: 5 }],
      });
      const found = await pg.query(
        `SELECT to_regclass('ops22.deuz_agent_runs_updated_at') AS found`,
      );
      expect(found.rows).toEqual([{ found: 'ops22.deuz_agent_runs_updated_at' }]);
      expect((await pg.query('SELECT version FROM ops22.deuz_ops_schema')).rows).toEqual([
        { version: 1 },
      ]);
    } finally {
      await pg.close();
    }
  }, 60_000);
});
