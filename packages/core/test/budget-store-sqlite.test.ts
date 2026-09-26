import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSqliteBudgetStore } from '../src/node/budget-sqlite';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';

function manualClock(start = 1_000_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: async (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

budgetStoreContracts('SQLite budget store', async () => {
  const { clock, advance, now } = manualClock();
  return { store: createSqliteBudgetStore({ path: ':memory:', clock }), advance, now };
});

describe('SQLite budget store', () => {
  it('shares one budget between two stores on the same file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deuz-budget-'));
    directories.push(directory);
    const path = join(directory, 'budget.sqlite');
    const { clock } = manualClock();
    const first = createSqliteBudgetStore({ path, clock });
    const second = createSqliteBudgetStore({ path, clock });
    const scope = { key: 'user:1', limits: { tokens: 100 } };
    try {
      expect(
        await first.reserve({ requestId: 'a', modelId: 'm', tokens: 70, scopes: [scope] }),
      ).toMatchObject({ admitted: true });
      expect(
        await second.reserve({ requestId: 'b', modelId: 'm', tokens: 70, scopes: [scope] }),
      ).toMatchObject({ admitted: false, committed: 70 });
      await second.release('a');
      expect(await first.usage('user:1')).toEqual({ tokens: 0, usd: 0 });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('refuses a schema it does not know and closes idempotently', async () => {
    const { DatabaseSync } = (await import('node:sqlite' as string)) as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          run(...p: unknown[]): unknown;
          get(...p: unknown[]): unknown;
          all(...p: unknown[]): unknown[];
        };
        close(): void;
      };
    };
    const database = new DatabaseSync(':memory:');
    database.exec(
      'CREATE TABLE deuz_budget_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO deuz_budget_schema VALUES (1, 99);',
    );
    const store = createSqliteBudgetStore({ path: ':memory:', database });
    await expect(store.usage('user:1')).rejects.toThrow(/schema/i);
    await store.close();
    await store.close();
    await expect(store.usage('user:1')).rejects.toThrow(/closed/i);
  });
});
