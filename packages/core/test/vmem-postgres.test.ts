/**
 * The PostgreSQL versioned memory store (2.4): the shared contract on PGlite
 * (in-process cosine, and the pgvector path against an emulated `vector`
 * type) and, when DEUZ_TEST_POSTGRES_URL is set, on a live server; plus what
 * only this backend owes: a pool is required, its own `deuz_vmem_schema`
 * table beside the legacy pack, and a commit that fails half way leaving
 * nothing behind.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VersionedMemoryCommit } from '../src/memory/versioned/types';
import type { ObserveEvent } from '../src/types/observe';
import { digestJson, sha256Digest } from '../src/internal/digest';
import type { PgPoolClientLike, PgPoolLike } from '../src/node/pg-tx';
import { createPostgresStores } from '../src/node/store-postgres';
import { createPostgresVersionedMemoryStore } from '../src/node/vmem-postgres';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';
import { assertVersionedMemoryStoreContract } from './fixtures/versioned-memory-store-conformance';

const SCOPE = { userId: 'u1' };

async function createOp(
  operationId: string,
  id: string,
  text: string,
  vector?: number[],
): Promise<VersionedMemoryCommit> {
  const request = {
    scope: SCOPE,
    actor: 'host' as const,
    mutations: [
      {
        type: 'create' as const,
        record: {
          id,
          text,
          origin: 'asserted' as const,
          sources: [{ kind: 'host' as const, digest: await sha256Digest(text) }],
        },
        ...(vector
          ? { embedding: { vector, modelId: 'model-a', textDigest: await sha256Digest(text) } }
          : {}),
      },
    ],
  };
  return { operationId, ...request, requestDigest: await digestJson(request) };
}

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
// PGlite: in-process cosine
// ---------------------------------------------------------------------------

const lite = new PGlite();
const litePool = pglitePool(lite);
let liteSchemas = 0;
const liteSchema = async (): Promise<string> => {
  const schema = `vmem_${++liteSchemas}`;
  await litePool.query(`CREATE SCHEMA ${schema}`);
  return schema;
};
beforeAll(() => lite.waitReady, SLOW_HOOK_TIMEOUT_MS);
afterAll(() => lite.close());

assertVersionedMemoryStoreContract(
  'postgres (PGlite, in-process cosine)',
  async ({ clock, logger }) => {
    const store = createPostgresVersionedMemoryStore({
      pool: litePool,
      schema: await liteSchema(),
      clock,
      logger,
    });
    return { store, cleanup: () => store.close() };
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

// ---------------------------------------------------------------------------
// PGlite with an emulated pgvector: a `vector` domain over real[] and a
// cosine-distance `<=>`, so the in-database distance path runs for real.
// ---------------------------------------------------------------------------

const emulated = new PGlite();
const emulatedPool = pglitePool(emulated);
let emulatedSchemas = 0;
beforeAll(async () => {
  await emulated.waitReady;
  await emulated.exec(`
    CREATE DOMAIN vector AS real[];
    CREATE FUNCTION deuz_test_cosine_distance(a real[], b real[]) RETURNS float8
      LANGUAGE sql IMMUTABLE AS $$
        SELECT 1 - (SELECT SUM(x * y) FROM unnest(a, b) AS t(x, y))
          / NULLIF(sqrt((SELECT SUM(x * x) FROM unnest(a) AS t(x))) * sqrt((SELECT SUM(y * y) FROM unnest(b) AS t(y))), 0)
      $$;
    CREATE OPERATOR <=> (LEFTARG = real[], RIGHTARG = real[], FUNCTION = deuz_test_cosine_distance);
  `);
}, SLOW_HOOK_TIMEOUT_MS);
afterAll(() => emulated.close());

assertVersionedMemoryStoreContract(
  'postgres (PGlite, emulated pgvector)',
  async ({ clock, logger }) => {
    const schema = `vmem_vec_${++emulatedSchemas}`;
    await emulatedPool.query(`CREATE SCHEMA ${schema}`);
    const store = createPostgresVersionedMemoryStore({
      pool: emulatedPool,
      schema,
      pgvector: 'require',
      clock,
      logger,
    });
    return { store, cleanup: () => store.close() };
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

describe('createPostgresVersionedMemoryStore (PGlite)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('drops the vectors of a pending generation that another model replaces', async () => {
    const schema = await liteSchema();
    const store = createPostgresVersionedMemoryStore({ pool: litePool, schema });
    await store.commit(await createOp('op-1', 'r1', 'a fact', [1, 0, 0]));
    const abandoned = await store.embeddings.begin({ modelId: 'model-b', dims: 2 });
    const vectors = async (generation: number) =>
      Number(
        (
          await litePool.query(
            `SELECT COUNT(*) AS n FROM ${schema}.deuz_vmem_vectors WHERE generation = $1`,
            [generation],
          )
        ).rows[0]!.n,
      );
    expect(
      await store.embeddings.put(abandoned.generation, [
        { id: 'r1', revision: 1, textDigest: await sha256Digest('a fact'), vector: [1, 0] },
      ]),
    ).toBe(1);
    expect(await vectors(abandoned.generation)).toBe(1);
    const next = await store.embeddings.begin({ modelId: 'model-c', dims: 2 });
    expect(await vectors(abandoned.generation)).toBe(0);
    const { rows } = await litePool.query(
      `SELECT generation, status FROM ${schema}.deuz_vmem_generations WHERE status <> 'active' ORDER BY generation`,
    );
    expect(rows.map((row) => [Number(row.generation), row.status])).toEqual([
      [abandoned.generation, 'retired'],
      [next.generation, 'pending'],
    ]);
    await store.close();
  });

  it('refuses a client that cannot lend a connection', () => {
    expect(() =>
      createPostgresVersionedMemoryStore({
        pool: { query: async () => ({ rows: [] }) } as unknown as PgPoolLike,
      }),
    ).toThrow(/needs a pool/);
  });

  it("refuses pgvector: 'require' without the vector type", async () => {
    const store = createPostgresVersionedMemoryStore({
      pool: litePool,
      schema: await liteSchema(),
      pgvector: 'require',
    });
    await expect(store.migrate()).rejects.toThrow(/vector type is not available/);
  });

  it('keeps its version in deuz_vmem_schema and leaves the legacy pack alone', async () => {
    const schema = await liteSchema();
    const legacy = createPostgresStores({ client: litePool, schema, pgvector: 'off' });
    await legacy.migrate();
    const tables = async () =>
      (
        await litePool.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name LIKE '%schema%' ORDER BY table_name`,
        )
      ).rows.map((row) => row.table_name);
    const legacyMeta = await tables();
    const before = await Promise.all(
      legacyMeta.map(
        async (name) => (await litePool.query(`SELECT * FROM ${schema}.${name}`)).rows,
      ),
    );

    const store = createPostgresVersionedMemoryStore({ pool: litePool, schema });
    await store.commit(await createOp('op-1', 'r1', 'versioned fact'));
    expect((await litePool.query(`SELECT version FROM ${schema}.deuz_vmem_schema`)).rows).toEqual([
      { version: 1 },
    ]);
    expect(await tables()).toEqual([...legacyMeta, 'deuz_vmem_schema'].sort());
    const after = await Promise.all(
      legacyMeta.map(
        async (name) => (await litePool.query(`SELECT * FROM ${schema}.${name}`)).rows,
      ),
    );
    expect(after).toEqual(before);
  });

  it('refuses a schema a newer build wrote', async () => {
    const schema = await liteSchema();
    await litePool.query(
      `CREATE TABLE ${schema}.deuz_vmem_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
    );
    await litePool.query(`INSERT INTO ${schema}.deuz_vmem_schema VALUES (1, 2)`);
    const store = createPostgresVersionedMemoryStore({ pool: litePool, schema });
    await expect(store.scopeRevision(SCOPE)).rejects.toThrow(/newer than this build reads/);
  });

  it('rolls back the revision, vector, scope revision and receipt of a commit that fails half way', async () => {
    const schema = await liteSchema();
    const pool = failingPool(litePool, `INSERT INTO ${schema}.deuz_vmem_receipts`);
    const store = createPostgresVersionedMemoryStore({ pool, schema });
    const op = await createOp('op-1', 'r1', 'a fact that must never be half written', [1, 0, 0]);

    pool.fail.on = true;
    await expect(store.commit(op)).rejects.toThrow('injected failure');
    expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toBeUndefined();
    expect(await store.history(SCOPE, 'r1')).toEqual([]);
    expect(await store.receipt('op-1')).toBeUndefined();
    expect(await store.scopeRevision(SCOPE)).toBe(0);
    expect(await store.embeddings.active()).toBeUndefined();
    expect(await store.search({ scope: SCOPE, text: 'fact' })).toEqual([]);
    for (const table of ['revisions', 'records', 'vectors', 'generations', 'receipts'])
      expect(
        (await litePool.query(`SELECT COUNT(*)::int AS n FROM ${schema}.deuz_vmem_${table}`)).rows,
      ).toEqual([{ n: 0 }]);

    pool.fail.on = false;
    expect((await store.commit(op)).status).toBe('committed');
    expect((await store.commit(op)).status).toBe('replayed');
    expect(litePool.stats().connected).toBe(litePool.stats().released);
  });
});

// ---------------------------------------------------------------------------
// A live server
// ---------------------------------------------------------------------------

const url = postgresUrl();
if (url) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!url)('createPostgresVersionedMemoryStore (live server)', () => {
  let pool: pg.Pool;
  // One prefix per run, and only the schemas this file created are dropped.
  const prefix = `deuz_l1b_vmem_${Date.now().toString(36)}`;
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

  assertVersionedMemoryStoreContract(
    'postgres (live)',
    async ({ clock, logger }) => {
      const store = createPostgresVersionedMemoryStore({
        pool,
        schema: await freshSchema(),
        clock,
        logger,
      });
      return { store, cleanup: () => store.close() };
    },
    { timeout: SLOW_TEST_TIMEOUT_MS },
  );

  it('opens and ends its own pool from a connection string', async () => {
    const store = createPostgresVersionedMemoryStore({
      connectionString: url!,
      schema: await freshSchema(),
    });
    expect((await store.commit(await createOp('op-1', 'r1', 'fact'))).status).toBe('committed');
    await store.close();
    await expect(store.scopeRevision(SCOPE)).rejects.toThrow(/closed/);
  });

  it('serializes concurrent commits of one operation id: one commits, the other replays', async () => {
    const schema = await freshSchema();
    const a = createPostgresVersionedMemoryStore({ pool, schema });
    const b = createPostgresVersionedMemoryStore({ pool, schema });
    await a.migrate();
    const op = await createOp('op-1', 'r1', 'raced fact', [1, 0, 0]);
    const results = await Promise.all([a.commit(op), b.commit(op)]);
    expect(results.map((r) => r.status).sort()).toEqual(['committed', 'replayed']);
    expect((await a.history(SCOPE, 'r1')).length).toBe(1);
    expect(await a.scopeRevision(SCOPE)).toBe(1);
  });

  it('lets exactly one of two racing revisions of a record commit', async () => {
    const schema = await freshSchema();
    const store = createPostgresVersionedMemoryStore({ pool, schema });
    await store.commit(await createOp('op-0', 'r1', 'first draft'));
    const revise = async (operationId: string, text: string): Promise<VersionedMemoryCommit> => {
      const request = {
        scope: SCOPE,
        actor: 'host' as const,
        mutations: [{ type: 'revise' as const, id: 'r1', expectedRevision: 1, changes: { text } }],
      };
      return { operationId, ...request, requestDigest: await digestJson(request) };
    };
    const results = await Promise.all([
      store.commit(await revise('op-a', 'draft a')),
      store.commit(await revise('op-b', 'draft b')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['committed', 'conflict']);
    expect((await store.history(SCOPE, 'r1')).map((r) => r.revision)).toEqual([1, 2]);
  });

  it('rolls back a commit whose connection fails half way', async () => {
    const schema = await freshSchema();
    const failing = failingPool(
      pool as unknown as PgPoolLike,
      `INSERT INTO ${schema}.deuz_vmem_receipts`,
    );
    const store = createPostgresVersionedMemoryStore({ pool: failing, schema });
    const op = await createOp('op-1', 'r1', 'a fact that must never be half written', [1, 0, 0]);
    failing.fail.on = true;
    await expect(store.commit(op)).rejects.toThrow('injected failure');
    for (const table of ['revisions', 'records', 'vectors', 'generations', 'receipts'])
      expect(
        (await pool.query(`SELECT COUNT(*)::int AS n FROM ${schema}.deuz_vmem_${table}`)).rows,
      ).toEqual([{ n: 0 }]);
    failing.fail.on = false;
    expect((await store.commit(op)).status).toBe('committed');
  });
});

describe('createPostgresVersionedMemoryStore: telemetry', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('reports deuz.memory.op spans for the retention calls, with counts only', async () => {
    const events: ObserveEvent[] = [];
    const store = createPostgresVersionedMemoryStore({
      pool: litePool,
      schema: await liteSchema(),
      observer: { emit: (event) => events.push(event) },
    });
    await store.commit(await createOp('op-1', 'r1', 'secret fact'));
    await store.pruneHistory({ olderThan: Date.now() + 1 });
    await store.pruneOperations({ olderThan: Date.now() + 1 });
    const completed = events.filter(
      (event) => event.type === 'operation.completed' && event.operation === 'deuz.memory.op',
    );
    expect(completed.map((event) => (event as { attributes?: unknown }).attributes)).toEqual([
      { 'deuz.memory.operation': 'prune-history', 'deuz.memory.record_count': 0 },
      { 'deuz.memory.operation': 'prune-operations', 'deuz.memory.record_count': 1 },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});
