/**
 * The SQLite durable stream state store (2.4, spec §3.4): the shared contract
 * on `:memory:`, its own version table (never `PRAGMA user_version` or a 2.3
 * table), a borrowed handle left open, and a file that keeps frames and the
 * fence across a restart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDurableStreamStateStore } from '../src/node/stream-state-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import {
  durableStreamStoreContracts,
  readAll,
  records,
} from './fixtures/durable-stream-store-conformance';
import { manualClock } from './fixtures/manual-clock';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const text = (value: string) => ({ type: 'text-delta' as const, text: value });

describe.skipIf(!DatabaseSync)('createSqliteDurableStreamStateStore', () => {
  durableStreamStoreContracts('contract on :memory:', async () => {
    const time = manualClock(1_700_000_000_000);
    const store = createSqliteDurableStreamStateStore({ path: ':memory:', clock: time.clock });
    cleanup.push(() => store.close());
    return { store, now: () => time.clock.now(), advance: (ms) => time.advance(ms) };
  });

  it('keeps its version in deuz_stream_state_schema and leaves user_version alone', async () => {
    const db = new DatabaseSync!(':memory:');
    cleanup.push(() => db.close());
    db.exec('PRAGMA user_version = 7');
    const store = createSqliteDurableStreamStateStore({ database: db });
    await store.open('s', 1);
    expect(db.prepare('SELECT version FROM deuz_stream_state_schema').get()).toEqual({
      version: 1,
    });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual([
      'deuz_stream_state_records',
      'deuz_stream_state_schema',
      'deuz_stream_state_streams',
    ]);
    // A borrowed handle stays open.
    await store.close();
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    await expect(store.open('s', 1)).rejects.toThrow(/closed/);
  });

  it('refuses a database a newer build wrote', async () => {
    const db = new DatabaseSync!(':memory:');
    cleanup.push(() => db.close());
    db.exec(
      'CREATE TABLE deuz_stream_state_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)',
    );
    db.exec('INSERT INTO deuz_stream_state_schema (singleton, version) VALUES (1, 2)');
    const store = createSqliteDurableStreamStateStore({ database: db });
    await expect(store.lastSeq('s')).rejects.toThrow(/newer than this build reads/);
  });

  it(
    'keeps frames, the last seq and the fence in a file across a restart',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'deuz-stream-state-'));
      cleanup.push(() =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
      );
      const path = join(directory, 'streams.sqlite');
      const first = createSqliteDurableStreamStateStore({ path });
      expect(await first.open('run-1', 3)).toEqual({ status: 'opened', lastSeq: -1 });
      await first.commit({
        streamId: 'run-1',
        token: 3,
        records: records(0, [{ type: 'start', messageId: 'm' }, text('a')]),
      });
      await first.close();

      const second = createSqliteDurableStreamStateStore({ path });
      cleanup.push(() => second.close());
      expect(await second.lastSeq('run-1')).toBe(1);
      expect(await readAll(second, 'run-1', 0)).toEqual(records(1, [text('a')]));
      expect(await second.open('run-1', 2)).toEqual({ status: 'fenced', token: 3 });
      expect(await second.open('run-1', 4)).toEqual({ status: 'opened', lastSeq: 1 });
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
