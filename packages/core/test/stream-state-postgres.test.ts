/**
 * The PostgreSQL durable stream state store (2.4, spec §3.4). Offline: the
 * shared contract on PGlite behind `pglitePool`, one schema per store. Live,
 * when DEUZ_TEST_POSTGRES_URL names a server: the same contract on a `pg`
 * pool whose sessions run at REPEATABLE READ, so racing commits really fail
 * with 40001 and really run again. Time is the database's.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostgresDurableStreamStateStore } from '../src/node/stream-state-postgres';
import type { PgPoolLike } from '../src/node/pg-tx';
import {
  durableStreamStoreContracts,
  readAll,
  records,
} from './fixtures/durable-stream-store-conformance';
import { estimateClockSkew } from './fixtures/clock-skew';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('createPostgresDurableStreamStateStore on PGlite', () => {
  let db: PGlite;
  let pool: ReturnType<typeof pglitePool>;
  let schemas = 0;
  const freshSchema = async () => {
    const schema = `stream_state_${++schemas}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };

  beforeAll(async () => {
    db = new PGlite();
    pool = pglitePool(db);
  }, SLOW_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });

  durableStreamStoreContracts(
    'contract',
    async () => {
      const store = createPostgresDurableStreamStateStore({ pool, schema: await freshSchema() });
      return { store, now: () => Date.now(), advance: wait };
    },
    { timeout: SLOW_TEST_TIMEOUT_MS },
  );

  it('keeps its version in <schema>.deuz_stream_state_schema and gives every connection back', async () => {
    const schema = await freshSchema();
    const store = createPostgresDurableStreamStateStore({ pool, schema });
    await store.migrate();
    await store.migrate();
    await store.commit({ streamId: 's', token: 1, records: records(0, [{ type: 'done' }]) });
    const { rows } = await pool.query(`SELECT version FROM ${schema}.deuz_stream_state_schema`);
    expect(rows).toEqual([{ version: 1 }]);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'deuz_stream_state_records',
      'deuz_stream_state_schema',
      'deuz_stream_state_streams',
    ]);
    // The part is kept as text: jsonb would reorder its keys.
    const parts = await pool.query(
      `SELECT pg_typeof(part)::text AS type FROM ${schema}.deuz_stream_state_records`,
    );
    expect(parts.rows).toEqual([{ type: 'text' }]);
    const { connected, released } = pool.stats();
    expect(released).toBe(connected);
    // A borrowed pool stays open.
    await store.close();
    expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  });

  it('refuses a query()-only client and a malformed schema name at construction', () => {
    const queryOnly = { query: async () => ({ rows: [] }) } as unknown as PgPoolLike;
    expect(() => createPostgresDurableStreamStateStore({ pool: queryOnly })).toThrow(
      /needs a pool/,
    );
    expect(() => createPostgresDurableStreamStateStore({ pool, schema: 'bad-name' })).toThrow(
      TypeError,
    );
  });

  it('rejects calls after close()', async () => {
    const store = createPostgresDurableStreamStateStore({ pool, schema: await freshSchema() });
    await store.close();
    await expect(store.lastSeq('s')).rejects.toThrow(/closed/);
  });
});

const url = postgresUrl();
if (url) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!url)('createPostgresDurableStreamStateStore on a live server', () => {
  let pool: pg.Pool;
  let skew = 0;
  const prefix = `deuz_l7b_stream_${Date.now().toString(36)}`;
  const schemas: string[] = [];
  const freshSchema = async () => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
    pool.on('connect', (connection) => {
      void connection.query(
        'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      );
    });
    ({ skew } = await estimateClockSkew(async () => {
      const { rows } = await pool.query(
        'SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now',
      );
      return Number(rows[0]!.now);
    }));
  });

  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  durableStreamStoreContracts('contract', async () => {
    const store = createPostgresDurableStreamStateStore({ pool, schema: await freshSchema() });
    return { store, now: () => Date.now() + skew, advance: wait };
  });

  it('opens and ends its own pool from a connection string', async () => {
    const schema = await freshSchema();
    const store = createPostgresDurableStreamStateStore({ connectionString: url!, schema });
    await store.commit({ streamId: 's', token: 1, records: records(0, [{ type: 'done' }]) });
    expect(await readAll(store, 's')).toEqual(records(0, [{ type: 'done' }]));
    await store.close();
    await expect(store.lastSeq('s')).rejects.toThrow(/closed/);
  });
});
