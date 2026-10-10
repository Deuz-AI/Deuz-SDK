import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteBudgetStore } from '../src/node/budget-sqlite';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import type { PgClientLike } from '../src/node/store-postgres';

// 2.3 adds indexes (and, for the SQLite budget store, a running total) to
// schemas that 2.2 created, on first use and under the same schema version:
// a 2.2 process sharing the database keeps working. The names are the ones
// the operations guide tells you to create ahead of time on a large table.

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const objects = (db: SqliteDatabaseLike) =>
  (
    db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'deuz_%' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe.skipIf(!DatabaseSync)('SQLite stores on a 2.2 file (2.3)', () => {
  it('adds the ops retention indexes and keeps version 1', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(`CREATE TABLE deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
      INSERT INTO deuz_ops_schema VALUES (1, 1);
      CREATE TABLE deuz_leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, signals TEXT NOT NULL);
      CREATE TABLE deuz_agent_runs (run_id TEXT PRIMARY KEY, scope TEXT NOT NULL,
        revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE deuz_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL);`);
    const ops = createSqliteOpsStore({ path: ':memory:', database: db });
    cleanup.push(() => ops.close());
    expect(await ops.claims('k')).toBe(true);
    expect(objects(db)).toEqual(
      expect.arrayContaining(['deuz_agent_runs_updated_at', 'deuz_claims_claimed_at']),
    );
    expect(db.prepare('SELECT version FROM deuz_ops_schema').get()).toEqual({ version: 1 });
  });

  it('adds the budget requests index and running totals and keeps version 1', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(`CREATE TABLE deuz_budget_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
      INSERT INTO deuz_budget_schema VALUES (1, 1);
      CREATE TABLE deuz_budget_scopes (key TEXT PRIMARY KEY, window_ms INTEGER, buckets INTEGER NOT NULL, bucket_ms INTEGER NOT NULL);
      CREATE TABLE deuz_budget_counters (key TEXT NOT NULL, bucket INTEGER NOT NULL, model_id TEXT NOT NULL,
        tokens INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY(key, bucket, model_id));
      CREATE TABLE deuz_budget_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, model_id TEXT NOT NULL,
        tokens INTEGER NOT NULL, usd REAL NOT NULL, state TEXT NOT NULL, charges TEXT NOT NULL,
        actual_tokens INTEGER, actual_usd REAL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    const store = createSqliteBudgetStore({ path: ':memory:', database: db });
    cleanup.push(() => store.close());
    await store.usage('user:1');
    expect(objects(db)).toEqual(
      expect.arrayContaining([
        'deuz_budget_requests_state',
        'deuz_budget_totals',
        'deuz_budget_totals_delete',
        'deuz_budget_totals_insert',
        'deuz_budget_totals_update',
      ]),
    );
    expect(db.prepare('SELECT version FROM deuz_budget_schema').get()).toEqual({ version: 1 });
  });

  it('adds the settled-runs index to a swarm file and keeps version 2', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(`CREATE TABLE deuz_swarm_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
      INSERT INTO deuz_swarm_schema VALUES (1, 2);
      CREATE TABLE deuz_swarm_runs (scope TEXT NOT NULL, run_id TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT, updated_at INTEGER, PRIMARY KEY(scope, run_id));
      CREATE TABLE deuz_swarm_tasks (scope TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope, run_id, task_id));
      CREATE TABLE deuz_swarm_events (scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(scope, run_id, sequence));
      CREATE TABLE deuz_swarm_channels (scope TEXT NOT NULL, run_id TEXT NOT NULL, channel TEXT NOT NULL,
        sequence INTEGER NOT NULL, entry_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(scope, run_id, channel, sequence), UNIQUE(scope, run_id, entry_id));
      CREATE INDEX deuz_swarm_runs_status ON deuz_swarm_runs(scope, status, updated_at);`);
    const store = createSqliteSwarmStore({ path: ':memory:', database: db });
    cleanup.push(() => store.close());
    expect(await store.listRuns!({ limit: 1 })).toEqual([]);
    expect(objects(db)).toContain('deuz_swarm_runs_settled');
    expect(db.prepare('SELECT version FROM deuz_swarm_schema').get()).toEqual({ version: 2 });
  });
});

describe('Postgres stores on a 2.2 schema (2.3)', () => {
  const pg = new PGlite();
  beforeAll(() => pg.waitReady, 60_000);
  afterAll(async () => {
    await pg.close();
  });
  const client: PgClientLike = {
    query: (sql, params) => pg.query<Record<string, unknown>>(sql, params),
  };
  const found = async (name: string) =>
    (await client.query(`SELECT to_regclass('${name}') AS found`)).rows[0]?.found !== null;

  it('adds the ops retention indexes and keeps version 1', async () => {
    await pg.exec(`CREATE SCHEMA ops22;
      CREATE TABLE ops22.deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
      INSERT INTO ops22.deuz_ops_schema VALUES (1, 1);
      CREATE TABLE ops22.deuz_leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, token BIGINT NOT NULL,
        expires_at BIGINT NOT NULL, signals JSONB NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE ops22.deuz_agent_runs (run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision BIGINT NOT NULL,
        payload TEXT NOT NULL, updated_at BIGINT NOT NULL);
      CREATE TABLE ops22.deuz_claims (key TEXT PRIMARY KEY, claimed_at BIGINT NOT NULL);`);
    const ops = createPostgresOpsStore({ client, schema: 'ops22' });
    expect(await ops.claims('k')).toBe(true);
    expect(await found('ops22.deuz_claims_claimed_at')).toBe(true);
    expect(await found('ops22.deuz_agent_runs_updated_at')).toBe(true);
    expect((await client.query('SELECT version FROM ops22.deuz_ops_schema')).rows).toEqual([
      { version: 1 },
    ]);
  });

  it('adds the budget requests index and keeps version 1', async () => {
    await client.query('CREATE SCHEMA budget22');
    // The 2.2 tables, as the 2.3 store creates them minus the new index.
    await createPostgresBudgetStore({ client, schema: 'budget22' }).usage('user:1');
    await client.query('DROP INDEX budget22.deuz_budget_requests_state');
    expect(await found('budget22.deuz_budget_requests_state')).toBe(false);
    await createPostgresBudgetStore({ client, schema: 'budget22' }).usage('user:1');
    expect(await found('budget22.deuz_budget_requests_state')).toBe(true);
    expect((await client.query('SELECT version FROM budget22.deuz_budget_schema')).rows).toEqual([
      { version: 1 },
    ]);
  });
});
