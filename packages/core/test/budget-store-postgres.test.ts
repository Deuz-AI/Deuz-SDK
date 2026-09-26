import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';

const db = new PGlite();
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

  it('rejects an unsafe schema name', () => {
    expect(() => createPostgresBudgetStore({ client, schema: 'x; DROP TABLE y' })).toThrow(
      /schema/i,
    );
  });
});
