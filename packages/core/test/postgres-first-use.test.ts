import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import { createPostgresSwarmStore } from '../src/node/swarm-postgres';
import { createPostgresStores } from '../src/node/store-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import type { BudgetStore } from '../src/types/budget-store';

// PGlite is one connection, so real concurrent sessions cannot meet here. These
// tests pin what makes a first use safe on a pool of connections: the whole
// schema creation is one statement that queues on an advisory lock.
const db = new PGlite();
// Start-up is slow under load; keep it out of the first test's time budget.
beforeAll(() => db.waitReady, 60_000);
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

  it('sends its schema statement again when a concurrent first use failed it', async () => {
    const schema = await freshSchema();
    // 40001: under REPEATABLE READ or SERIALIZABLE the statement's snapshot
    // predates its advisory-lock wait, so it misses what the lock holder
    // committed. 23505, 42P07 and 42710: two sessions created one table at once.
    const codes = ['40001', '23505', '42P07', '42710'];
    let attempts = 0;
    const racing: PgClientLike = {
      async query(sql, params) {
        if (/^\s*DO\b/.test(sql)) {
          const code = codes[attempts++];
          if (code) throw Object.assign(new Error(`concurrent first use (${code})`), { code });
        }
        return client.query(sql, params);
      },
    };
    await first(racing, schema);
    expect(attempts).toBe(5);
    const { rows } = await client.query(`SELECT to_regclass('${schema}.${table}') AS found`);
    expect(rows[0]?.found).not.toBeNull();
  });

  it('gives up after five attempts, and never retries any other error', async () => {
    const failing = (code: string) => {
      const sent = { attempts: 0 };
      const failingClient: PgClientLike = {
        async query(sql, params) {
          if (!/^\s*DO\b/.test(sql)) return client.query(sql, params);
          sent.attempts++;
          throw Object.assign(new Error(`schema statement failed (${code})`), { code });
        },
      };
      return { sent, client: failingClient };
    };
    const serializing = failing('40001');
    await expect(first(serializing.client, await freshSchema())).rejects.toMatchObject({
      code: '40001',
    });
    expect(serializing.sent.attempts).toBe(5);
    const denied = failing('42501');
    await expect(first(denied.client, await freshSchema())).rejects.toMatchObject({
      code: '42501',
    });
    expect(denied.sent.attempts).toBe(1);
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

describe('Postgres store pack (2.0), first use', () => {
  // Its own database: a regression here leaves the connection unusable.
  const pack = new PGlite();
  beforeAll(() => pack.waitReady, 60_000);
  afterAll(async () => {
    await pack.close();
  });
  // PGlite's query() takes one statement, so the migration batch goes through
  // exec(): the simple query protocol `pg` sends a parameterless batch with.
  const packClient: PgClientLike = {
    async query(sql, params) {
      if (params === undefined && sql.includes(';')) {
        const results = await pack.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      }
      return pack.query<Record<string, unknown>>(sql, params);
    },
  };

  it('leaves a single-connection client usable after a failed batch, and migrates on the next call', async () => {
    await packClient.query('CREATE SCHEMA pack_1');
    // A deuz_runs without a status column fails the batch's index on it (42703),
    // after BEGIN.
    await packClient.query('CREATE TABLE pack_1.deuz_runs (run_id TEXT PRIMARY KEY)');
    const stores = createPostgresStores({ client: packClient, schema: 'pack_1', pgvector: 'off' });
    await expect(stores.migrate()).rejects.toMatchObject({ code: '42703' });
    // Left inside the aborted transaction block, the connection would answer
    // 25P02 to every statement from here on.
    await expect(packClient.query('SELECT 1 AS one')).resolves.toMatchObject({
      rows: [{ one: 1 }],
    });
    const { rows } = await packClient.query(`SELECT to_regclass('pack_1.deuz_memory') AS found`);
    expect(rows[0]?.found).toBeNull();
    await packClient.query('DROP TABLE pack_1.deuz_runs');
    await expect(stores.migrate()).resolves.toBeUndefined();
  });

  it('migrates one new schema from two packs at once', async () => {
    await packClient.query('CREATE SCHEMA pack_2');
    const a = createPostgresStores({ client: packClient, schema: 'pack_2', pgvector: 'off' });
    const b = createPostgresStores({ client: packClient, schema: 'pack_2', pgvector: 'off' });
    await expect(Promise.all([a.migrate(), b.migrate()])).resolves.toHaveLength(2);
    await b.runs.create({ runId: 'r', status: 'running', createdAt: 1, updatedAt: 1 });
    expect(await a.runs.get('r')).toMatchObject({ runId: 'r' });
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
