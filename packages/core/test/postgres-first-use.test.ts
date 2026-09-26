import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import { createPostgresSwarmStore } from '../src/node/swarm-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import type { BudgetStore } from '../src/types/budget-store';

// PGlite is one connection, so real concurrent sessions cannot meet here. These
// tests pin what makes a first use safe on a pool of connections: the whole
// schema creation is one statement that queues on an advisory lock.
const db = new PGlite();
afterAll(async () => {
  await db.close();
});
const client: PgClientLike = {
  query: (sql, params) => db.query<Record<string, unknown>>(sql, params),
};

let schemas = 0;
async function freshSchema(): Promise<string> {
  const schema = `first_use_${++schemas}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  return schema;
}

interface StoreCase {
  name: string;
  /** The store's schema version table and one of its data tables. */
  meta: string;
  table: string;
  /** The store's first call, which creates its schema. */
  first(client: PgClientLike, schema: string): Promise<unknown>;
}

const stores: StoreCase[] = [
  {
    name: 'budget',
    meta: 'deuz_budget_schema',
    table: 'deuz_budget_requests',
    first: (c, schema) => createPostgresBudgetStore({ client: c, schema }).usage('user:1'),
  },
  {
    name: 'ops',
    meta: 'deuz_ops_schema',
    table: 'deuz_leases',
    first: async (c, schema) => createPostgresOpsStore({ client: c, schema }).agentRuns.load('run'),
  },
  {
    name: 'swarm',
    meta: 'deuz_swarm_pg_schema',
    table: 'deuz_swarm_runs',
    first: (c, schema) =>
      createPostgresSwarmStore({ client: c, schema }).load({ scope: 's', runId: 'r' }),
  },
];

describe.each(stores)('Postgres $name store, first use', ({ name, meta, table, first }) => {
  it('creates its schema in one statement that takes an advisory lock first', async () => {
    const schema = await freshSchema();
    const sent: string[] = [];
    const recording: PgClientLike = {
      query(sql, params) {
        sent.push(sql);
        return client.query(sql, params);
      },
    };
    await first(recording, schema);
    const creating = sent.filter((sql) => /\bCREATE\s+(TABLE|INDEX)\b/i.test(sql));
    expect(creating).toHaveLength(1);
    const statement = creating[0]!;
    expect(statement.trimStart()).toMatch(/^DO\b/);
    const lock = statement.indexOf('pg_advisory_xact_lock');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(statement.search(/\bCREATE\s+TABLE\b/i));
  });

  it('starts two store instances at once on a new schema', async () => {
    const schema = await freshSchema();
    await expect(Promise.all([first(client, schema), first(client, schema)])).resolves.toHaveLength(
      2,
    );
    // And again, now that every table exists.
    await expect(first(client, schema)).resolves.not.toBeInstanceOf(Error);
  });

  it('refuses a schema version it does not know, before creating any table', async () => {
    const schema = await freshSchema();
    await client.query(
      `CREATE TABLE ${schema}.${meta} (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
    );
    await client.query(`INSERT INTO ${schema}.${meta} VALUES (1, 9)`);
    await expect(first(client, schema)).rejects.toThrow(
      `Unsupported Postgres ${name} schema version`,
    );
    const { rows } = await client.query(`SELECT to_regclass('${schema}.${table}') AS found`);
    expect(rows[0]?.found).toBeNull();
  });
});

describe('Postgres budget store, concurrent first reserves', () => {
  const reserve = (store: BudgetStore, requestId: string, ms: number) =>
    store.reserve({
      requestId,
      modelId: 'm',
      tokens: 1,
      scopes: [{ key: 'user:1', limits: { tokens: 100 }, window: { ms } }],
    });

  it('answers window_conflict when another reserve created the key with another window', async () => {
    const schema = await freshSchema();
    await reserve(createPostgresBudgetStore({ client, schema }), 'a', 60_000);
    // The loser's scope insert began before the winner's row committed: the
    // insert then does nothing, and the statement's snapshot misses the row.
    const stale: PgClientLike = {
      async query(sql, params) {
        const result = await client.query(sql, params);
        return /WITH created AS/.test(sql) ? { rows: [] } : result;
      },
    };
    await expect(
      reserve(createPostgresBudgetStore({ client: stale, schema }), 'b', 3_600_000),
    ).rejects.toMatchObject({ name: 'BudgetStoreError', code: 'window_conflict' });
    const { rows } = await client.query(
      `SELECT request_id FROM ${schema}.deuz_budget_requests ORDER BY request_id`,
    );
    expect(rows.map((row) => row.request_id)).toEqual(['a']);
  });
});
