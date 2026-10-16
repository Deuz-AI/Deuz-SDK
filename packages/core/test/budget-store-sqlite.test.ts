import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createSqliteBudgetStore } from '../src/node/budget-sqlite';
import type { SqliteDatabaseLike, SqliteStatementLike } from '../src/node/store-sqlite';
import type { BudgetStore } from '../src/types/budget-store';
import { budgetStoreContracts } from './fixtures/budget-store-conformance';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

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

async function openDatabase(path: string): Promise<SqliteDatabaseLike> {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => SqliteDatabaseLike;
  };
  return new DatabaseSync(path);
}

/** A handle that records the SQL of every statement read through it. */
function recording(db: SqliteDatabaseLike): { database: SqliteDatabaseLike; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    database: {
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      prepare(sql): SqliteStatementLike {
        const statement = db.prepare(sql);
        return {
          run: (...params) => statement.run(...params),
          get: (...params) => {
            reads.push(sql);
            return statement.get(...params);
          },
          all: (...params) => {
            reads.push(sql);
            return statement.all(...params);
          },
        };
      },
    },
  };
}

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

budgetStoreContracts(
  'SQLite budget store',
  async () => {
    const { clock, advance, now } = manualClock();
    return { store: createSqliteBudgetStore({ path: ':memory:', clock }), advance, now };
  },
  { hours: true },
);

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

  // 2.2 summed a lifetime key's whole history on every admission (F25).
  it('admits a lifetime scope from its running total, without reading its history', async () => {
    const { clock, advance } = manualClock();
    const { database, reads } = recording(await openDatabase(':memory:'));
    const store = createSqliteBudgetStore({ path: ':memory:', database, clock });
    const scope = { key: 'org:life', limits: { tokens: 1_000 } };
    try {
      for (let hour = 0; hour < 50; hour++) {
        await store.reserve({ requestId: `h${hour}`, modelId: 'm', tokens: 10, scopes: [scope] });
        await store.settle(`h${hour}`, { tokens: 10, usd: 0 });
        await advance(3_600_000);
      }
      reads.length = 0;
      expect(
        await store.reserve({ requestId: 'next', modelId: 'm', tokens: 501, scopes: [scope] }),
      ).toMatchObject({ admitted: false, committed: 500 });
      expect(reads.filter((sql) => /\bFROM\s+deuz_budget_counters\b/i.test(sql))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('keeps the running total right when a 2.2 process writes the history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deuz-budget-'));
    directories.push(directory);
    const path = join(directory, 'budget.sqlite');
    const { clock } = manualClock();
    const store = createSqliteBudgetStore({ path, clock });
    const scope = { key: 'org:1', limits: { tokens: 100 } };
    const legacy = await openDatabase(path);
    try {
      await store.reserve({ requestId: 'a', modelId: 'm', tokens: 30, scopes: [scope] });
      // A 2.2 reserve of a 40-token hold, then its settlement at 25: 2.2 knows
      // only the history table.
      const charge = legacy.prepare(
        `INSERT INTO deuz_budget_counters(key, bucket, model_id, tokens, usd) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(key, bucket, model_id) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd`,
      );
      charge.run('org:1', 0, 'legacy', 40, 0);
      charge.run('org:1', 0, 'legacy', -15, 0);
      expect(
        await store.reserve({ requestId: 'b', modelId: 'm', tokens: 46, scopes: [scope] }),
      ).toMatchObject({ admitted: false, committed: 55 });
    } finally {
      legacy.close();
      await store.close();
    }
  });

  it(
    'builds the running total of a 2.2 file from its history, and keeps it readable by 2.2',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'deuz-budget-'));
      directories.push(directory);
      const path = join(directory, 'budget.sqlite');
      const legacy = await openDatabase(path);
      // The 2.2 schema, as 2.2 creates it, with 70 tokens of lifetime history.
      legacy.exec(`CREATE TABLE deuz_budget_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
      CREATE TABLE deuz_budget_scopes (key TEXT PRIMARY KEY, window_ms INTEGER, buckets INTEGER NOT NULL, bucket_ms INTEGER NOT NULL);
      CREATE TABLE deuz_budget_counters (key TEXT NOT NULL, bucket INTEGER NOT NULL, model_id TEXT NOT NULL,
        tokens INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY(key, bucket, model_id));
      CREATE TABLE deuz_budget_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, model_id TEXT NOT NULL,
        tokens INTEGER NOT NULL, usd REAL NOT NULL, state TEXT NOT NULL, charges TEXT NOT NULL,
        actual_tokens INTEGER, actual_usd REAL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO deuz_budget_schema VALUES (1, 1);
      INSERT INTO deuz_budget_scopes VALUES ('org:1', NULL, 1, 3600000);
      INSERT INTO deuz_budget_counters VALUES ('org:1', 0, 'm', 40, 0.5), ('org:1', 1, 'm', 30, 0.25);`);
      legacy.close();
      const { clock } = manualClock();
      const store = createSqliteBudgetStore({ path, clock });
      try {
        expect(
          await store.reserve({
            requestId: 'r',
            modelId: 'm',
            tokens: 31,
            scopes: [{ key: 'org:1', limits: { tokens: 100 } }],
          }),
        ).toMatchObject({ admitted: false, committed: 70 });
      } finally {
        await store.close();
      }
      const after = await openDatabase(path);
      try {
        expect(after.prepare('SELECT version FROM deuz_budget_schema').get()).toEqual({
          version: 1,
        });
      } finally {
        after.close();
      }
    },
    SLOW_TEST_TIMEOUT_MS,
  ); // a SQLite file opened, migrated and reopened: slow on a hosted Windows runner

  it('agrees with the memory store, and keeps its running totals, through any sequence', async () => {
    const { clock, advance, now } = manualClock();
    const db = await openDatabase(':memory:');
    const store = createSqliteBudgetStore({ path: ':memory:', database: db, clock });
    const reference = createInMemoryBudgetStore({ clock });
    let seed = 7;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const both = async <T>(act: (target: BudgetStore) => Promise<T>): Promise<T> => {
      const [actual, expected] = await Promise.all([act(store), act(reference)]);
      expect(actual).toEqual(expected);
      return actual;
    };
    const scopes = [
      { key: 'life', limits: { tokens: 4_000, usd: 1e9 } },
      { key: 'hour', limits: { tokens: 400 }, window: { ms: 3_600_000, buckets: 6 } },
    ];
    const open: string[] = [];
    let folded = 0;
    let denied = 0;
    try {
      for (let step = 0; step < 400; step++) {
        const action = random(10);
        if (action < 4) {
          const requestId = `r${step}`;
          const chosen = random(3);
          const input = {
            requestId,
            modelId: `m${random(3)}`,
            tokens: random(100),
            usd: random(100) / 100,
            scopes: chosen === 2 ? scopes : [scopes[chosen]!],
          };
          const outcome = await both((target) => target.reserve(input));
          if (outcome.admitted) open.push(requestId);
          else denied++;
        } else if (action < 6 && open.length) {
          const [requestId] = open.splice(random(open.length), 1);
          const actual = { tokens: random(100), usd: random(100) / 100 };
          await both((target) => target.settle(requestId!, actual));
        } else if (action < 7 && open.length) {
          const [requestId] = open.splice(random(open.length), 1);
          await both((target) => target.release(requestId!));
        } else if (action < 9) await advance(random(2 * 3_600_000));
        else {
          const before = now() - random(4 * 3_600_000);
          folded += (await both((target) => target.prune!({ before }))).buckets;
        }
      }
      expect(folded).toBeGreaterThan(0);
      expect(denied).toBeGreaterThan(0);
      for (const key of ['life', 'hour'])
        for (const since of [undefined, now() - 3 * 3_600_000])
          await both((target) => target.usage(key, { byModel: true, since }));
      const totals = db
        .prepare('SELECT key, tokens, usd FROM deuz_budget_totals ORDER BY key')
        .all() as { key: string; tokens: number; usd: number }[];
      const history = db
        .prepare(
          'SELECT key, SUM(tokens) AS tokens, SUM(usd) AS usd FROM deuz_budget_counters GROUP BY key ORDER BY key',
        )
        .all() as { key: string; tokens: number; usd: number }[];
      expect(totals.map((row) => [row.key, row.tokens])).toEqual(
        history.map((row) => [row.key, row.tokens]),
      );
      for (const [index, row] of totals.entries())
        expect(row.usd).toBeCloseTo(history[index]!.usd, 9);
    } finally {
      await store.close();
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
