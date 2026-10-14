/**
 * goal-runtime-postgres.test.ts (2.4, spec §3.1) — the PostgreSQL goal
 * runtime store: the 2.3 goal-store fixture and the goal runtime store
 * fixture on PGlite and, when DEUZ_TEST_POSTGRES_URL is set, on a live server
 * (each test in a schema of its own, dropped afterwards); plus what only this
 * backend owes: a pool is required, its own `deuz_goal_runtime_schema` beside
 * the legacy pack, a write that fails half way leaves nothing behind, and
 * concurrent writers on separate connections: exactly one wins each race.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { goalInboxKey } from '../src/goal/runtime';
import type { PgPoolClientLike, PgPoolLike } from '../src/node/pg-tx';
import { createPostgresGoalRuntimeStore } from '../src/node/goal-runtime-postgres';
import { createPostgresStores } from '../src/node/store-postgres';
import {
  T0,
  delivery,
  goalRuntimeStoreContracts,
  nextGoal,
  occurrence,
  runIntent,
  runtimeGoal,
  runtimeState,
  scheduleInput,
} from './fixtures/goal-runtime-store-conformance';
import { goalStoreContracts } from './fixtures/goal-store-conformance';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

/** A pool whose connections throw on statements starting with `prefix` while `fail.on` is set. */
function failingPool(inner: PgPoolLike, prefix: string): PgPoolLike & { fail: { on: boolean } } {
  const fail = { on: false };
  return {
    fail,
    query: (sql, params) => inner.query(sql, params),
    async connect(): Promise<PgPoolClientLike> {
      const connection = await inner.connect();
      return {
        query: (sql, params) =>
          fail.on && sql.startsWith(prefix)
            ? Promise.reject(new Error('injected failure'))
            : connection.query(sql, params),
        release: (destroy) => connection.release(destroy),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// PGlite
// ---------------------------------------------------------------------------

const lite = new PGlite();
const litePool = pglitePool(lite);
let liteSchemas = 0;
const liteSchema = async (): Promise<string> => {
  const schema = `goal_rt_${++liteSchemas}`;
  await litePool.query(`CREATE SCHEMA ${schema}`);
  return schema;
};
beforeAll(() => lite.waitReady, SLOW_HOOK_TIMEOUT_MS);
afterAll(() => lite.close());

goalStoreContracts('postgres goal runtime store (GoalStore, PGlite)', async () =>
  createPostgresGoalRuntimeStore({ pool: litePool, schema: await liteSchema() }),
);

goalRuntimeStoreContracts(
  'postgres goal runtime store (PGlite)',
  async ({ clock }) => {
    const store = createPostgresGoalRuntimeStore({
      pool: litePool,
      schema: await liteSchema(),
      clock,
    });
    return { store, cleanup: () => store.close() };
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

describe('createPostgresGoalRuntimeStore (PGlite)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('refuses a client that cannot lend a connection', () => {
    expect(() =>
      createPostgresGoalRuntimeStore({
        pool: { query: async () => ({ rows: [] }) } as unknown as PgPoolLike,
      }),
    ).toThrow(/needs a pool/);
  });

  it('refuses a schema name that needs quoting', () => {
    expect(() => createPostgresGoalRuntimeStore({ pool: litePool, schema: 'Bad-Name' })).toThrow(
      /schema name/,
    );
  });

  it('keeps its version in deuz_goal_runtime_schema and leaves the legacy pack alone', async () => {
    const schema = await liteSchema();
    const legacy = createPostgresStores({ client: litePool, schema, pgvector: 'off' });
    await legacy.migrate();
    const before = await litePool.query(`SELECT * FROM ${schema}.deuz_meta ORDER BY key`);
    const store = createPostgresGoalRuntimeStore({ pool: litePool, schema });
    await store.migrate();
    await store.save(runtimeGoal('g'));
    expect((await litePool.query(`SELECT * FROM ${schema}.deuz_meta ORDER BY key`)).rows).toEqual(
      before.rows,
    );
    expect(
      (await litePool.query(`SELECT version FROM ${schema}.deuz_goal_runtime_schema`)).rows,
    ).toEqual([{ version: 1 }]);
    await store.close();
  });

  it('refuses a schema a newer build wrote', async () => {
    const schema = await liteSchema();
    const first = createPostgresGoalRuntimeStore({ pool: litePool, schema });
    await first.migrate();
    await litePool.query(`UPDATE ${schema}.deuz_goal_runtime_schema SET version = 2`);
    const second = createPostgresGoalRuntimeStore({ pool: litePool, schema });
    await expect(second.load('g')).rejects.toThrow(/holds schema version 2/);
  });

  it('rolls a half-written inbox apply back whole', async () => {
    const schema = await liteSchema();
    const failing = failingPool(litePool, `INSERT INTO ${schema}.deuz_goal_runtime_intents`);
    const store = createPostgresGoalRuntimeStore({ pool: failing, schema });
    const goal = runtimeGoal('g');
    await store.runtime.save(runtimeState(goal), goal);
    const { entry } = await store.inbox.enqueue(delivery(goal, 'd1'));
    const application = {
      scope: 'tenant',
      goalId: 'g',
      entryId: entry.id,
      disposition: 'applied' as const,
      goal: nextGoal(goal),
      runtime: runtimeState(goal, 2),
      intent: runIntent(goal, 'g#2'),
    };
    failing.fail.on = true;
    await expect(store.inbox.apply(application)).rejects.toThrow('injected failure');
    expect(await store.inbox.get('tenant', entry.id)).toEqual(entry);
    expect((await store.load('g'))?.revision).toBe(1);
    expect((await store.runtime.get('tenant', 'g'))?.revision).toBe(1);
    failing.fail.on = false;
    expect(await store.inbox.apply(application)).toEqual({ status: 'committed' });
    expect(litePool.stats().connected).toBe(litePool.stats().released);
  });

  it('keeps fractional times exactly', async () => {
    const store = createPostgresGoalRuntimeStore({
      pool: litePool,
      schema: await liteSchema(),
      clock: { now: () => T0 + 0.5, setTimeout: () => () => {} },
    });
    const goal = runtimeGoal('g');
    await store.save(goal);
    const { entry } = await store.inbox.enqueue(delivery(goal, 'd1'));
    expect(entry.enqueuedAt).toBe(T0 + 0.5);
    expect(
      (await store.inbox.list({ scope: 'tenant', cursor: JSON.stringify([T0, 'a']) })).entries,
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A live server
// ---------------------------------------------------------------------------

const url = postgresUrl();
if (url) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!url)('createPostgresGoalRuntimeStore (live server)', () => {
  let pool: pg.Pool;
  // One prefix per run, and only the schemas this file created are dropped.
  const prefix = `deuz_l4a_goal_${Date.now().toString(36)}`;
  const schemas: string[] = [];
  const freshSchema = async (): Promise<string> => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
  });
  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  goalStoreContracts('postgres goal runtime store (GoalStore, live)', async () =>
    createPostgresGoalRuntimeStore({ pool, schema: await freshSchema() }),
  );

  goalRuntimeStoreContracts(
    'postgres goal runtime store (live)',
    async ({ clock }) => {
      const store = createPostgresGoalRuntimeStore({ pool, schema: await freshSchema(), clock });
      return { store, cleanup: () => store.close() };
    },
    { timeout: SLOW_TEST_TIMEOUT_MS },
  );

  it('opens and ends its own pool from a connection string', async () => {
    const store = createPostgresGoalRuntimeStore({
      connectionString: url!,
      schema: await freshSchema(),
    });
    await store.save(runtimeGoal('g'));
    expect((await store.load('g'))?.goalId).toBe('g');
    await store.close();
    await expect(store.load('g')).rejects.toThrow(/closed/);
  });

  it('lets exactly one of two racing applies of one entry commit', async () => {
    const schema = await freshSchema();
    const a = createPostgresGoalRuntimeStore({ pool, schema });
    const b = createPostgresGoalRuntimeStore({ pool, schema });
    const goal = runtimeGoal('g');
    await a.runtime.save(runtimeState(goal), goal);
    const { entry } = await a.inbox.enqueue(delivery(goal, 'd1'));
    const apply = (store: typeof a, intentId: string) =>
      store.inbox.apply({
        scope: 'tenant',
        goalId: 'g',
        entryId: entry.id,
        disposition: 'applied',
        goal: nextGoal(goal),
        runtime: runtimeState(goal, 2),
        intent: runIntent(goal, intentId),
      });
    const results = await Promise.all([apply(a, 'i-a'), apply(b, 'i-b')]);
    expect(results.map((result) => result.status).sort()).toEqual(['committed', 'conflict']);
    expect((await a.load('g'))?.revision).toBe(2);
    expect((await a.intents.list({ scope: 'tenant' })).intents).toHaveLength(1);
  });

  it('queues one of two racing enqueues of a new delivery; the other is a duplicate', async () => {
    const schema = await freshSchema();
    const a = createPostgresGoalRuntimeStore({ pool, schema });
    const b = createPostgresGoalRuntimeStore({ pool, schema });
    const goal = runtimeGoal('g');
    await a.save(goal);
    const results = await Promise.all([
      a.inbox.enqueue(delivery(goal, 'd1')),
      b.inbox.enqueue(delivery(goal, 'd1')),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['duplicate', 'enqueued']);
    expect(
      await a.inbox.get('tenant', goalInboxKey('tenant', 'webhook:github', 'd1')),
    ).toBeDefined();
  });

  it('lets one of two racing advances from one cursor win, and one of two claims', async () => {
    const schema = await freshSchema();
    const a = createPostgresGoalRuntimeStore({ pool, schema });
    const b = createPostgresGoalRuntimeStore({ pool, schema });
    const goal = runtimeGoal('g');
    await a.save(goal);
    await a.schedules.put(scheduleInput(goal, 's1'), { expectedRevision: 0, effectiveFrom: T0 });
    const step = {
      scope: 'tenant',
      scheduleId: 's1',
      expectedRevision: 1,
      fromCursor: T0,
      toCursor: T0 + 60_000,
      occurrences: [occurrence(goal, 's1', T0 + 60_000)],
    };
    const advanced = await Promise.all([a.schedules.advance(step), b.schedules.advance(step)]);
    expect(advanced.map((result) => result.status).sort()).toEqual(['advanced', 'conflict']);
    expect((await a.inbox.list({ scope: 'tenant' })).entries).toHaveLength(1);
    await a.intents.record(runIntent(goal, 'i1'));
    const claims = await Promise.all([
      a.intents.claim('tenant', 'i1', { owner: 'a', token: 1, expectedRevision: 1 }),
      b.intents.claim('tenant', 'i1', { owner: 'b', token: 2, expectedRevision: 1 }),
    ]);
    expect(claims.map((result) => result.status).sort()).toEqual(['committed', 'conflict']);
  });
});
