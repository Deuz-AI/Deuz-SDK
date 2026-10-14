/**
 * ProcessOperationStore (2.4, spec §3.3): the in-memory store and the SQLite
 * store run one contract. SQLite adds its own rules: a version table of its
 * own (`deuz_process_ops_schema`, spec §4.2: no existing version moves),
 * records that survive a reopen, a borrowed handle left open, and a newer
 * schema refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInMemoryProcessOperationStore,
  createSqliteProcessOperationStore,
} from '../src/compute/docker';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import {
  newRecord,
  processOperationStoreContracts,
} from './fixtures/process-ops-store-conformance';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const { DatabaseSync } = (await import('node:sqlite' as string)) as {
  DatabaseSync: new (path: string) => SqliteDatabaseLike;
};

function clock(start = 1_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe('ProcessOperationStore', () => {
  processOperationStoreContracts('in-memory', async () => {
    const time = clock();
    return {
      store: createInMemoryProcessOperationStore({ deps: { clock: time.clock } }),
      advance: time.advance,
      now: time.now,
    };
  });

  processOperationStoreContracts('SQLite (:memory:)', async () => {
    const time = clock();
    const store = createSqliteProcessOperationStore({ path: ':memory:', clock: time.clock });
    cleanup.push(() => store.close());
    return { store, advance: time.advance, now: time.now };
  });
});

describe('createSqliteProcessOperationStore', () => {
  it('keeps its version in deuz_process_ops_schema and leaves user_version alone', async () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const store = createSqliteProcessOperationStore({ database: db });
    await store.create(newRecord());
    expect(db.prepare('SELECT version FROM deuz_process_ops_schema').all()).toEqual([
      { version: 1 },
    ]);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    await store.close();
    // Borrowed: the handle is still usable after close().
    expect(db.prepare('SELECT COUNT(*) AS n FROM deuz_process_ops').get()).toEqual({ n: 1 });
  });

  it('refuses a schema written by a newer build, naming both versions', async () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    db.exec(
      'CREATE TABLE deuz_process_ops_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
    );
    db.exec('INSERT INTO deuz_process_ops_schema (singleton, version) VALUES (1, 2)');
    const store = createSqliteProcessOperationStore({ database: db });
    await expect(store.get('tenant-a', 'op-1')).rejects.toThrow(/2.*1|1.*2/);
  });

  it('rejects calls after close()', async () => {
    const store = createSqliteProcessOperationStore({ path: ':memory:' });
    await store.close();
    await expect(store.get('tenant-a', 'op-1')).rejects.toThrow(/closed/);
  });

  it(
    'keeps records across a reopen of the same file',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'deuz-process-ops-'));
      cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      const path = join(dir, 'ops.db');
      const first = createSqliteProcessOperationStore({ path });
      await first.create(newRecord());
      await first.update(
        'tenant-a',
        'op-1',
        { state: 'running', containerId: 'c1' },
        {
          expectedRevision: 1,
        },
      );
      await first.close();

      const second = createSqliteProcessOperationStore({ path });
      cleanup.push(() => second.close());
      expect(await second.get('tenant-a', 'op-1')).toMatchObject({
        state: 'running',
        containerId: 'c1',
        revision: 2,
      });
      expect((await second.create(newRecord())).status).toBe('existing');
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
