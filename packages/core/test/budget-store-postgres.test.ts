import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';

const db = new PGlite();
// Start-up is slow under load; keep it out of the first test's time budget.
beforeAll(() => db.waitReady, 60_000);
const client: PgClientLike = {
  query: (sql, params) => db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>,
};
let schemas = 0;
async function freshSchema(): Promise<string> {
  const schema = `budget_${++schemas}`;
  await db.query(`CREATE SCHEMA ${schema}`);
  return schema;
}
afterAll(async () => {
  await db.close();
});

// Postgres windows run on database time, so advancing means really waiting.
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

budgetStoreContracts('Postgres budget store (PGlite)', async () => ({
  store: createPostgresBudgetStore({ client, schema: await freshSchema() }),
  advance: wait,
  // PGlite runs in this process, so the database clock is the host clock.
  now: () => Date.now(),
}));

describe('Postgres budget store', () => {
  it('shares one budget between two stores on the same database', async () => {
    const schema = await freshSchema();
    const first = createPostgresBudgetStore({ client, schema });
    const second = createPostgresBudgetStore({ client, schema });
    const scope = { key: 'user:1', limits: { tokens: 100 } };
    expect(
      await first.reserve({ requestId: 'a', modelId: 'm', tokens: 70, scopes: [scope] }),
    ).toMatchObject({ admitted: true });
    expect(
      await second.reserve({ requestId: 'b', modelId: 'm', tokens: 70, scopes: [scope] }),
    ).toMatchObject({ admitted: false, committed: 70 });
    await second.settle('a', { tokens: 20, usd: 0.5 });
    expect(await first.usage('user:1')).toEqual({ tokens: 20, usd: 0.5 });
  });

  it('folds lifetime history per model and keeps its total (2.3)', async () => {
    const schema = await freshSchema();
    const store = createPostgresBudgetStore({ client, schema });
    const scope = { key: 'org:1', limits: { tokens: 1_000 } };
    await store.reserve({ requestId: 'now', modelId: 'm', tokens: 5, scopes: [scope] });
    await store.settle('now', { tokens: 5, usd: 0 });
    // Hours-old history, as an hourly caller leaves it; database time cannot
    // be moved, so it is written directly, before the current hour's row.
    const { rows: current } = await client.query(
      `SELECT bucket FROM ${schema}.deuz_budget_counters`,
    );
    const hour = Number(current[0]?.bucket);
    await client.query(
      `INSERT INTO ${schema}.deuz_budget_counters (key, bucket, model_id, tokens, usd)
       VALUES ('org:1', $1, 'm', 10, 0.5), ('org:1', $2, 'm', 20, 0.25), ('org:1', $3, 'old', 7, 0)`,
      [hour - 5, hour - 4, hour - 3],
    );
    const before = await store.usage('org:1', { byModel: true });
    expect(await store.prune!({ before: Date.now() + 1_000 })).toEqual({
      requests: 1,
      buckets: 1,
    });
    expect(await store.usage('org:1', { byModel: true })).toEqual(before);
    const { rows } = await client.query(
      `SELECT bucket, tokens, usd FROM ${schema}.deuz_budget_counters WHERE model_id = 'm' ORDER BY bucket`,
    );
    expect(rows.map((row) => [Number(row.bucket), Number(row.tokens), Number(row.usd)])).toEqual([
      [hour - 4, 30, 0.75],
      [hour, 5, 0],
    ]);
  });

  it('keeps the settlement of a hold whose history row a racing prune folded (2.3)', async () => {
    const schema = await freshSchema();
    const store = createPostgresBudgetStore({ client, schema });
    await store.reserve({
      requestId: 'r',
      modelId: 'm',
      tokens: 10,
      scopes: [{ key: 'user:1', limits: { tokens: 100 } }],
    });
    // A prune whose snapshot predates this reservation moved the bucket's row,
    // the hold's estimate included, into an older one.
    const counters = `${schema}.deuz_budget_counters`;
    await client.query(
      `INSERT INTO ${counters} (key, bucket, model_id, tokens, usd)
       SELECT key, bucket - 1, model_id, tokens, usd FROM ${counters}`,
    );
    await client.query(
      `DELETE FROM ${counters} WHERE bucket = (SELECT max(bucket) FROM ${counters})`,
    );
    await store.settle('r', { tokens: 30, usd: 0 });
    expect(await store.usage('user:1')).toEqual({ tokens: 30, usd: 0 });
  });

  it('rejects an unsafe schema name', () => {
    expect(() => createPostgresBudgetStore({ client, schema: 'x; DROP TABLE y' })).toThrow(
      /schema/i,
    );
  });

  it('bounds the open holds by created_at on its index, for any finite cutoff (2.3)', async () => {
    const schema = await freshSchema();
    const reads: Array<{ sql: string; params: unknown[] }> = [];
    const recording: PgClientLike = {
      query: (sql, params) => {
        if (/^SELECT request_id/.test(sql.trim())) reads.push({ sql, params: params ?? [] });
        return client.query(sql, params);
      },
    };
    const store = createPostgresBudgetStore({ client: recording, schema });
    await store.usage('nobody'); // first use creates the tables and the 2.3 index
    // Even ids hold, odd ids settled: whole-millisecond times 1 to 2000.
    await client.query(
      `INSERT INTO ${schema}.deuz_budget_requests
         (request_id, fingerprint, model_id, tokens, usd, state, charges, outcome, created_at)
       SELECT 'r' || lpad(g::text, 4, '0'), 'f', 'm', 1, 0,
         CASE WHEN g % 2 = 0 THEN 'reserved' ELSE 'settled' END, '[]'::jsonb, '{}'::jsonb, g
       FROM generate_series(1, 2000) g`,
    );
    await client.query(`ANALYZE ${schema}.deuz_budget_requests`);

    // Times are whole milliseconds, so a cutoff of 100.5 keeps 101 and later.
    const holds = await store.holds({ before: 100.5, limit: 1_000 });
    expect(holds).toHaveLength(50);
    expect(holds.at(-1)).toMatchObject({ requestId: 'r0100', reservedAt: 100 });
    await db.query('SET enable_seqscan = off');
    try {
      const { rows } = await db.query<Record<string, unknown>>(
        `EXPLAIN ${reads[0]!.sql}`,
        reads[0]!.params,
      );
      const plan = rows.map((row) => String(Object.values(row)[0])).join('\n');
      // A float8 `before` would cast every row's created_at and leave the
      // index only its state column.
      expect(plan).toMatch(/Index Cond: \(\(state = 'reserved'::text\) AND \(created_at < /);
    } finally {
      await db.query('SET enable_seqscan = on');
    }
    // Any finite cutoff, however far from the stored times.
    expect(await store.holds({ before: -Number.MAX_VALUE })).toEqual([]);
    expect(await store.holds({ before: Number.MAX_VALUE, limit: 1_000 })).toHaveLength(1_000);
    expect(await store.prune({ before: 100.5 })).toMatchObject({ requests: 50 });
    expect(await store.prune({ before: -1e300 })).toMatchObject({ requests: 0 });
    expect(await store.prune({ before: Number.MAX_VALUE })).toMatchObject({ requests: 950 });
  });
});
