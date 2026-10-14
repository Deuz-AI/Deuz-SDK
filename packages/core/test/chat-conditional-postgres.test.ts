/**
 * chat-conditional-postgres.test.ts (2.4) — the PostgreSQL conditional chat
 * store and its tsvector transcript index (`@deuz-sdk/core/stores/postgres`):
 * both shared contracts on PGlite and, when DEUZ_TEST_POSTGRES_URL is set, on
 * a live server; plus what only this backend owes — a pool is required, its
 * own `deuz_chat_conditional_schema` table and nothing else in the schema, a
 * GIN index, a write and its index update as one transaction, and real
 * concurrent writers that never lose an update.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { PgPoolClientLike, PgPoolLike } from '../src/node/pg-tx';
import { createPostgresConditionalChatStore } from '../src/node/chat-conditional-postgres';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';
import { chat, conditionalChatStoreContracts } from './fixtures/conditional-chat-store-conformance';
import { transcriptIndexContracts } from './fixtures/transcript-index-conformance';

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

const scope = { userId: 'ada' };

// ---------------------------------------------------------------------------
// PGlite
// ---------------------------------------------------------------------------

const lite = new PGlite();
const litePool = pglitePool(lite);
let liteSchemas = 0;
const liteSchema = async (): Promise<string> => {
  const schema = `chatc_${++liteSchemas}`;
  await litePool.query(`CREATE SCHEMA ${schema}`);
  return schema;
};
afterAll(async () => {
  await lite.close();
});

conditionalChatStoreContracts('PostgreSQL conditional chat store (PGlite)', async (clock) => {
  const store = createPostgresConditionalChatStore({
    pool: litePool,
    schema: await liteSchema(),
    clock,
  });
  return { store, transcript: store.transcript, close: () => store.close() };
});

transcriptIndexContracts('PostgreSQL transcript index (PGlite)', async (clock) => {
  const store = createPostgresConditionalChatStore({
    pool: litePool,
    schema: await liteSchema(),
    clock,
  });
  return { index: store.transcript, close: () => store.close() };
});

describe('PostgreSQL conditional chat store', () => {
  it('needs a pool, and a valid schema name', () => {
    expect(() =>
      createPostgresConditionalChatStore({ pool: { query: litePool.query } as never }),
    ).toThrow(/pool/);
    expect(() =>
      createPostgresConditionalChatStore({ pool: litePool, schema: 'Bad-Name' }),
    ).toThrow(/schema/);
  });

  it('creates its own tables, version table and GIN index, and nothing else', async () => {
    const schema = await liteSchema();
    const store = createPostgresConditionalChatStore({ pool: litePool, schema });
    await store.migrate();
    await store.migrate();
    const tables = await litePool.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'deuz_chat_conditional',
      'deuz_chat_conditional_schema',
      'deuz_chat_transcript',
    ]);
    const version = await litePool.query(
      `SELECT version FROM ${schema}.deuz_chat_conditional_schema`,
    );
    expect(version.rows).toEqual([{ version: 1 }]);
    const indexes = await litePool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1', [
      schema,
    ]);
    expect(indexes.rows.some((row) => /USING gin \(tsv\)/.test(String(row.indexdef)))).toBe(true);
    await store.close();
  });

  it('commits a chat write and its index update together, or neither', async () => {
    const schema = await liteSchema();
    const pool = failingPool(litePool, `INSERT INTO ${schema}.deuz_chat_transcript `);
    const store = createPostgresConditionalChatStore({ pool, schema });
    await store.writeChat(chat('c', ['first words']), { expectedRevision: 0 });
    pool.fail.on = true;
    await expect(
      store.writeChat(chat('c', ['second words']), { expectedRevision: 1 }),
    ).rejects.toThrow('injected failure');
    pool.fail.on = false;
    expect(await store.readChat('c')).toMatchObject({ record: { revision: 1 } });
    expect(await store.transcript.search(scope, 'first')).toHaveLength(1);
    expect(await store.transcript.search(scope, 'second')).toEqual([]);
    expect(litePool.stats().connected).toBe(litePool.stats().released);
    await store.close();
  });

  it('refuses calls after close, and leaves a borrowed pool open', async () => {
    const schema = await liteSchema();
    const store = createPostgresConditionalChatStore({ pool: litePool, schema });
    await store.saveChat(chat('c', ['x']));
    await store.close();
    await expect(store.loadChat('c')).rejects.toThrow(/closed/);
    expect((await litePool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// A live server
// ---------------------------------------------------------------------------

const url = postgresUrl();

describe.runIf(url)('PostgreSQL conditional chat store (live server)', () => {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  const schemas: string[] = [];
  const liveSchema = async (): Promise<string> => {
    const schema = `l7a_chat_${process.pid}_${schemas.length}_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    return schema;
  };
  afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }, SLOW_HOOK_TIMEOUT_MS);

  conditionalChatStoreContracts('live conditional chat store', async (clock) => {
    const store = createPostgresConditionalChatStore({ pool, schema: await liveSchema(), clock });
    return { store, transcript: store.transcript, close: () => store.close() };
  });

  transcriptIndexContracts('live transcript index', async (clock) => {
    const store = createPostgresConditionalChatStore({ pool, schema: await liveSchema(), clock });
    return { index: store.transcript, close: () => store.close() };
  });

  it(
    'never loses an update between truly concurrent writers',
    async () => {
      const store = createPostgresConditionalChatStore({ pool, schema: await liveSchema() });
      await store.migrate();
      const creators = await Promise.all(
        Array.from({ length: 10 }, (_, n) =>
          store.writeChat(chat('race', [`writer ${n}`]), { expectedRevision: 0 }),
        ),
      );
      expect(creators.filter((result) => result.status === 'committed')).toHaveLength(1);
      // Last writer wins, but every legacy save counts: ten saves, ten revisions more.
      await Promise.all(
        Array.from({ length: 10 }, (_, n) => store.saveChat(chat('race', [`save ${n}`]))),
      );
      expect(await store.readChat('race')).toMatchObject({ record: { revision: 11 } });
      expect(await store.transcript.search(scope, 'save')).toHaveLength(1);
      await store.close();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'opens and ends its own pool from a connection string',
    async () => {
      const schema = await liveSchema();
      const store = createPostgresConditionalChatStore({ connectionString: url!, schema });
      await store.saveChat(chat('own', ['pool of its own']));
      expect((await store.transcript.search(scope, 'pool')).map((hit) => hit.chatId)).toEqual([
        'own',
      ]);
      await store.close();
      await expect(store.readChat('own')).rejects.toThrow(/closed/);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
