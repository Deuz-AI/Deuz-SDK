/**
 * The shared SQLite plumbing (2.4): open-or-borrow, busy timeout and WAL, the
 * transaction helper, close ownership, and the schema-meta helper every new
 * store keeps its version in. Logic runs on `:memory:`; only the WAL check
 * needs a file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteConnection,
  createSqliteOpener,
  ensureSqliteSchema,
  sqliteTransaction,
  type SqliteSchemaSpec,
} from '../src/node/sqlite-handle';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createSqliteStores, type SqliteDatabaseLike } from '../src/node/store-sqlite';
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

function memory(): SqliteDatabaseLike {
  const db = new DatabaseSync!(':memory:');
  cleanup.push(() => {
    if (isOpen(db)) db.close();
  });
  return db;
}

function isOpen(db: SqliteDatabaseLike): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** Forwards to `inner`, records every `exec`, and fails the ones `failing` matches. */
function recording(inner: SqliteDatabaseLike, failing?: RegExp) {
  const execs: string[] = [];
  let closes = 0;
  const db: SqliteDatabaseLike = {
    prepare: (sql) => inner.prepare(sql),
    exec(sql) {
      execs.push(sql);
      if (failing?.test(sql)) throw new Error(`refused: ${sql}`);
      inner.exec(sql);
    },
    close() {
      closes++;
      inner.close();
    },
  };
  return { db, execs, closes: () => closes };
}

const rows = (db: SqliteDatabaseLike, sql: string) => db.prepare(sql).all();
const tableNames = (db: SqliteDatabaseLike) =>
  (
    rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as {
      name: string;
    }[]
  ).map((row) => row.name);
const storedVersion = (db: SqliteDatabaseLike, table: string) =>
  (db.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as { version: number })
    .version;

describe.skipIf(!DatabaseSync)('sqliteTransaction', () => {
  it('commits what the function wrote and returns its value', () => {
    const db = memory();
    db.exec('CREATE TABLE t (v INTEGER)');
    const value = sqliteTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)');
      return 'done';
    });
    expect(value).toBe('done');
    expect(rows(db, 'SELECT v FROM t')).toEqual([{ v: 1 }]);
  });

  it('rolls back everything the function wrote when it throws, and rethrows its error', () => {
    const db = memory();
    db.exec('CREATE TABLE t (v INTEGER)');
    const failure = new Error('half way');
    expect(() =>
      sqliteTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)');
        throw failure;
      }),
    ).toThrow(failure);
    expect(rows(db, 'SELECT v FROM t')).toEqual([]);
  });

  it('takes the write lock at BEGIN by default, and defers it when asked', () => {
    const { db, execs } = recording(memory());
    sqliteTransaction(db, () => undefined);
    sqliteTransaction(db, () => undefined, 'deferred');
    expect(execs).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN', 'COMMIT']);
  });

  it('never lets a failed ROLLBACK hide the error that caused it', () => {
    const { db } = recording(memory(), /^ROLLBACK$/);
    const failure = new Error('the real cause');
    expect(() =>
      sqliteTransaction(db, () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});

describe.skipIf(!DatabaseSync)('createSqliteOpener', () => {
  it('opens once for concurrent callers and hands each the same setup result', async () => {
    let setups = 0;
    const open = createSqliteOpener(
      { path: ':memory:' },
      { setup: (db) => ({ db, setup: ++setups }) },
    );
    expect(open.pending).toBeUndefined();
    const [first, second] = await Promise.all([open(), open()]);
    expect(first).toBe(second);
    expect(setups).toBe(1);
    expect(await open.pending).toBe(first);
    first.db.close();
  });

  it('gives a handle a busy timeout before setup runs, and keeps one it already has', async () => {
    const fresh = await createSqliteOpener(
      { path: ':memory:', database: memory() },
      { setup: (db) => db.prepare('PRAGMA busy_timeout').get() },
    )();
    expect(fresh).toEqual({ timeout: 5000 });
    const tuned = memory();
    tuned.exec('PRAGMA busy_timeout = 1234');
    const kept = await createSqliteOpener(
      { path: ':memory:', database: tuned },
      { setup: (db) => db.prepare('PRAGMA busy_timeout').get() },
    )();
    expect(kept).toEqual({ timeout: 1234 });
  });

  it(
    'switches a file to WAL unless told not to, and leaves :memory: alone',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'deuz-sqlite-handle-'));
      cleanup.push(() =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
      );
      const journal = (db: SqliteDatabaseLike) =>
        (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
      for (const [file, wal, expected] of [
        ['wal.sqlite', undefined, 'wal'],
        ['delete.sqlite', false, 'delete'],
      ] as const) {
        const db = await createSqliteOpener(
          { path: join(directory, file), wal },
          { setup: (opened) => opened },
        )();
        expect(journal(db)).toBe(expected);
        db.close();
      }
      const inMemory = await createSqliteOpener({ path: ':memory:' }, { setup: (db) => db })();
      expect(journal(inMemory)).toBe('memory');
      inMemory.close();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it('fails an open whose WAL switch fails, or keeps the journal when told to', async () => {
    const wal = /journal_mode = WAL/;
    const strict = createSqliteOpener(
      { path: 'store.sqlite', database: recording(memory(), wal).db },
      { setup: () => 'opened' },
    );
    await expect(strict()).rejects.toThrow(/journal_mode/);
    const lenient = createSqliteOpener(
      { path: 'store.sqlite', database: recording(memory(), wal).db },
      { setup: () => 'opened', walFailure: 'ignore' },
    );
    await expect(lenient()).resolves.toBe('opened');
  });

  it('retries after a failed setup, closing a handle it opened and keeping an injected one', async () => {
    const opened: SqliteDatabaseLike[] = [];
    let fail = true;
    const own = createSqliteOpener(
      { path: ':memory:' },
      {
        setup(db) {
          opened.push(db);
          if (fail) throw new Error('setup failed');
          return db;
        },
      },
    );
    await expect(own()).rejects.toThrow('setup failed');
    expect(own.pending).toBeUndefined();
    expect(isOpen(opened[0]!)).toBe(false);
    fail = false;
    const retried = await own();
    // Compared by identity: printing a closed handle throws.
    expect(retried === opened[0]).toBe(false);
    retried.close();

    const injected = memory();
    fail = true;
    const borrowed = createSqliteOpener(
      { path: ':memory:', database: injected },
      {
        setup(db) {
          if (fail) throw new Error('setup failed');
          return db;
        },
      },
    );
    await expect(borrowed()).rejects.toThrow('setup failed');
    expect(isOpen(injected)).toBe(true);
    fail = false;
    expect(await borrowed()).toBe(injected);
  });
});

describe.skipIf(!DatabaseSync)('createSqliteConnection', () => {
  it('borrows an injected handle: close() leaves it open', async () => {
    const db = memory();
    const connection = createSqliteConnection(
      { path: ':memory:', database: db },
      { injected: 'borrowed', setup: (handle) => handle },
    );
    expect(await connection.use((handle) => handle)).toBe(db);
    await connection.close();
    expect(isOpen(db)).toBe(true);
  });

  it('closes a handle it opened itself, whichever the policy for injected ones', async () => {
    for (const injected of ['borrowed', 'owned'] as const) {
      const connection = createSqliteConnection(
        { path: ':memory:' },
        { injected, setup: (handle) => handle },
      );
      const db = await connection.use((handle) => handle);
      await connection.close();
      expect(isOpen(db)).toBe(false);
    }
  });

  it('owns an injected handle when told to: close() closes it, even unused', async () => {
    for (const use of [true, false]) {
      const db = memory();
      const connection = createSqliteConnection(
        { path: ':memory:', database: db },
        { injected: 'owned', setup: (handle) => handle },
      );
      if (use) await connection.use(() => undefined);
      await connection.close();
      expect(isOpen(db)).toBe(false);
    }
  });

  it('refuses calls after close(), with the message it was given', async () => {
    const connection = createSqliteConnection(
      { path: ':memory:' },
      { injected: 'borrowed', setup: (db) => db, closedMessage: 'Test store is closed' },
    );
    await connection.close();
    await expect(connection.use(() => 1)).rejects.toThrow('Test store is closed');
    const unnamed = createSqliteConnection(
      { path: ':memory:' },
      { injected: 'borrowed', setup: (db) => db },
    );
    await unnamed.close();
    await expect(unnamed.use(() => 1)).rejects.toThrow(/closed/);
  });

  it('waits for admitted calls, async ones included, before it closes', async () => {
    const db = memory();
    const connection = createSqliteConnection(
      { path: ':memory:', database: db },
      { injected: 'owned', setup: (handle) => handle },
    );
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const running = connection.use(async (handle) => {
      await gate;
      return handle.prepare('SELECT 7 AS n').get();
    });
    await Promise.resolve();
    const first = connection.close();
    const second = connection.close();
    let closed = false;
    void Promise.all([first, second]).then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    expect(isOpen(db)).toBe(true);
    finish();
    await expect(running).resolves.toEqual({ n: 7 });
    await Promise.all([first, second]);
    expect(isOpen(db)).toBe(false);
  });
});

/**
 * A store whose schema went through three versions: 1 had `items(id)`, 2 added
 * `label`, 3 added `size` and an index. `log` records every upgrade step.
 */
function spec(version: 1 | 2 | 3, extra: Partial<SqliteSchemaSpec> = {}): SqliteSchemaSpec {
  const shapes = {
    1: 'CREATE TABLE IF NOT EXISTS test_items (id TEXT PRIMARY KEY)',
    2: "CREATE TABLE IF NOT EXISTS test_items (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '')",
    3: "CREATE TABLE IF NOT EXISTS test_items (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', size INTEGER)",
  };
  const upgrades: SqliteSchemaSpec['upgrades'] = {
    1: [
      "ALTER TABLE test_items ADD COLUMN label TEXT NOT NULL DEFAULT ''",
      "UPDATE test_items SET label = 'from 1'",
      "INSERT INTO test_log (step) VALUES ('1 to 2')",
    ],
    // A step can be code, for a change SQL alone cannot express.
    2: [
      (db) => {
        db.exec('ALTER TABLE test_items ADD COLUMN size INTEGER');
        for (const row of db.prepare('SELECT id FROM test_items').all() as { id: string }[])
          db.prepare('UPDATE test_items SET size = ? WHERE id = ?').run(row.id.length, row.id);
        db.exec("INSERT INTO test_log (step) VALUES ('2 to 3')");
      },
    ],
  };
  return {
    name: 'test_store',
    version,
    create: [
      'CREATE TABLE IF NOT EXISTS test_log (step TEXT NOT NULL)',
      shapes[version],
      ...(version === 3 ? ['CREATE INDEX IF NOT EXISTS test_items_size ON test_items (size)'] : []),
    ],
    upgrades: Object.fromEntries(Object.entries(upgrades).filter(([from]) => +from < version)),
    ...extra,
  };
}

const steps = (db: SqliteDatabaseLike) =>
  (rows(db, 'SELECT step FROM test_log') as { step: string }[]).map((row) => row.step);

describe.skipIf(!DatabaseSync)('ensureSqliteSchema', () => {
  it('creates a fresh schema whole, with its own single-row version table', () => {
    const db = memory();
    expect(ensureSqliteSchema(db, spec(3))).toEqual({ stored: undefined, version: 3 });
    expect(tableNames(db)).toEqual(['test_items', 'test_log', 'test_store_schema']);
    expect(rows(db, 'SELECT singleton, version FROM test_store_schema')).toEqual([
      { singleton: 1, version: 3 },
    ]);
    expect(() => db.exec('INSERT INTO test_store_schema VALUES (2, 3)')).toThrow(/CHECK/);
    expect(steps(db)).toEqual([]);
  });

  it('leaves a schema at its version as it is, and adds what create gained since', () => {
    const db = memory();
    ensureSqliteSchema(db, spec(2));
    db.exec("INSERT INTO test_items (id, label) VALUES ('a', 'kept')");
    const later = spec(2, {
      create: [
        ...spec(2).create,
        'CREATE INDEX IF NOT EXISTS test_items_label ON test_items (label)',
      ],
    });
    expect(ensureSqliteSchema(db, later)).toEqual({ stored: 2, version: 2 });
    expect(steps(db)).toEqual([]);
    expect(rows(db, 'SELECT id, label FROM test_items')).toEqual([{ id: 'a', label: 'kept' }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'test_items_label'").get(),
    ).toEqual({ name: 'test_items_label' });
  });

  it('upgrades an older schema through every step from its version, in order', () => {
    const db = memory();
    ensureSqliteSchema(db, spec(1));
    db.exec("INSERT INTO test_items (id) VALUES ('ab'), ('abcd')");
    expect(ensureSqliteSchema(db, spec(3))).toEqual({ stored: 1, version: 3 });
    expect(steps(db)).toEqual(['1 to 2', '2 to 3']);
    expect(rows(db, 'SELECT id, label, size FROM test_items ORDER BY id')).toEqual([
      { id: 'ab', label: 'from 1', size: 2 },
      { id: 'abcd', label: 'from 1', size: 4 },
    ]);
    expect(storedVersion(db, 'test_store_schema')).toBe(3);

    const fromTwo = memory();
    ensureSqliteSchema(fromTwo, spec(2));
    ensureSqliteSchema(fromTwo, spec(3));
    expect(steps(fromTwo)).toEqual(['2 to 3']);
  });

  it('refuses a newer schema with a clear error and changes nothing', () => {
    const db = memory();
    ensureSqliteSchema(db, spec(3));
    const before = tableNames(db);
    expect(() => ensureSqliteSchema(db, spec(2))).toThrow(
      'test_store_schema holds schema version 3, newer than this build reads (versions 1 to 2)',
    );
    expect(() => ensureSqliteSchema(db, spec(1))).toThrow(/version 3, newer .*\(version 1\)/);
    expect(tableNames(db)).toEqual(before);
    expect(storedVersion(db, 'test_store_schema')).toBe(3);
  });

  it('refuses a schema older than its oldest upgrade step', () => {
    const db = memory();
    ensureSqliteSchema(db, spec(1));
    const noUpgrades = spec(3, { upgrades: { 2: spec(3).upgrades![2]! } });
    expect(() => ensureSqliteSchema(db, noUpgrades)).toThrow(
      'test_store_schema holds schema version 1, older than this build upgrades (versions 2 to 3)',
    );
    expect(storedVersion(db, 'test_store_schema')).toBe(1);
  });

  it('rolls an upgrade back whole when a step fails', () => {
    const db = memory();
    ensureSqliteSchema(db, spec(1));
    const broken = spec(2, {
      upgrades: { 1: [...spec(2).upgrades![1]!, 'INSERT INTO no_such_table VALUES (1)'] },
    });
    expect(() => ensureSqliteSchema(db, broken)).toThrow(/no_such_table/);
    expect(storedVersion(db, 'test_store_schema')).toBe(1);
    expect(steps(db)).toEqual([]);
    expect(
      rows(db, 'PRAGMA table_info(test_items)').map((c) => (c as { name: string }).name),
    ).toEqual(['id']);
  });

  it('runs under BEGIN IMMEDIATE, so two first opens of one file never race', () => {
    const { db, execs } = recording(memory());
    ensureSqliteSchema(db, spec(1));
    expect(execs[0]).toBe('BEGIN IMMEDIATE');
    expect(execs.at(-1)).toBe('COMMIT');
  });

  it('never touches PRAGMA user_version or a 2.3 store version table on the same file', async () => {
    const db = memory();
    // The store pack and the ops store share the file and stamp their versions.
    const pack = createSqliteStores({ path: ':memory:', database: db });
    await pack.sweepExpiredMemories(0);
    const ops = createSqliteOpsStore({ path: ':memory:', database: db });
    await ops.agentRuns.load('x');
    const userVersion = () => db.prepare('PRAGMA user_version').get();
    const pinned = { user_version: userVersion(), ops: storedVersion(db, 'deuz_ops_schema') };

    ensureSqliteSchema(db, spec(1));
    ensureSqliteSchema(db, spec(3));
    expect({ user_version: userVersion(), ops: storedVersion(db, 'deuz_ops_schema') }).toEqual(
      pinned,
    );
    expect(pinned).toEqual({ user_version: { user_version: 1 }, ops: 1 });
    // Both 2.3 stores still open the file.
    expect(await createSqliteOpsStore({ path: ':memory:', database: db }).agentRuns.load('x')).toBe(
      undefined,
    );
    expect(await createSqliteStores({ path: ':memory:', database: db }).memory.get('x')).toBeNull();
  });

  it('refuses the version tables of the 2.3 stores, bad names and malformed steps', () => {
    const db = memory();
    for (const name of ['deuz_ops', 'deuz_budget', 'deuz_swarm', 'deuz_evolve', 'deuz_swarm_pg'])
      expect(() => ensureSqliteSchema(db, { name, version: 1, create: [] })).toThrow(/reserved/);
    for (const name of ['', 'Test', 'test-store', 'test store', '1test', 'x'.repeat(60)])
      expect(() => ensureSqliteSchema(db, { name, version: 1, create: [] })).toThrow(/name/);
    for (const version of [0, 1.5, Number.NaN])
      expect(() => ensureSqliteSchema(db, { name: 'test_store', version, create: [] })).toThrow(
        /version/,
      );
    expect(() =>
      ensureSqliteSchema(db, { name: 'test_store', version: 3, create: [], upgrades: { 1: [] } }),
    ).toThrow(/without gaps up to version 3/);
    expect(tableNames(db)).toEqual([]);
  });
});
