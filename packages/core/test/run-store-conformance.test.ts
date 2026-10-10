/**
 * The `RunStore` contract (1.8) on every store that implements it: the memory
 * and file references, and the SQLite, Postgres and Redis packs. The Redis
 * pack gained `runs` in 2.3; it runs here on ioredis-mock, and on a real Redis
 * when DEUZ_TEST_REDIS_URL names one.
 */
import { afterAll, beforeAll, describe } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import RedisMock from 'ioredis-mock';
import { createClient } from 'redis';
import { createInMemoryRunStore } from '../src/runtime';
import { createFileRunStore } from '../src/node/runtime';
import { createSqliteStores, type SqliteDatabaseLike } from '../src/node/store-sqlite';
import { createPostgresStores, type PgClientLike } from '../src/node/store-postgres';
import { createRedisStores, wrapIoredisClient } from '../src/node/store-redis';
import { runStoreContracts } from './fixtures/run-store-conformance';

runStoreContracts('memory', async () => ({ store: createInMemoryRunStore() }));

runStoreContracts('file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deuz-run-contract-'));
  return {
    store: createFileRunStore({ dir }),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
  };
});

let hasSqlite = false;
try {
  const mod = (await import('node:sqlite' as string)) as {
    DatabaseSync?: new (path: string) => SqliteDatabaseLike;
  };
  hasSqlite = typeof mod.DatabaseSync === 'function';
} catch {
  /* runtime without node:sqlite */
}
describe.skipIf(!hasSqlite)('SQLite pack', () => {
  runStoreContracts('sqlite pack', async () => {
    const stores = createSqliteStores({ path: ':memory:' });
    return { store: stores.runs, cleanup: () => stores.close() };
  });
});

describe('Postgres pack (PGlite)', () => {
  const db = new PGlite();
  beforeAll(() => db.waitReady, 60_000);
  afterAll(async () => {
    await db.close();
  });
  // PGlite's query() takes one statement, so the migration batch goes through exec().
  const client: PgClientLike = {
    async query(sql, params) {
      if (params === undefined && sql.includes(';')) {
        const results = await db.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      }
      return db.query<Record<string, unknown>>(sql, params);
    },
  };
  let schemas = 0;
  runStoreContracts('postgres pack', async () => {
    const schema = `runs_${++schemas}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    return { store: createPostgresStores({ client, schema, pgvector: 'off' }).runs };
  });
});

// ioredis-mock shares data per host and port, as a server would: one port per store.
let port = 47_000;
runStoreContracts('redis pack (ioredis-mock)', async () => ({
  store: createRedisStores({ client: wrapIoredisClient(new RedisMock({ port: port++ })) }).runs,
}));

const url = process.env.DEUZ_TEST_REDIS_URL || undefined;
describe.skipIf(!url)('Redis pack on a live server', () => {
  const client = createClient({ url });
  beforeAll(() => client.connect(), 30_000);
  afterAll(() => client.quit());
  // One prefix per store, so runs on the shared server never meet.
  const run = `deuz-live-${Date.now().toString(36)}`;
  let stores = 0;
  runStoreContracts('redis pack (live)', async () => ({
    store: createRedisStores({ client, prefix: `${run}-${++stores}` }).runs,
  }));
});
