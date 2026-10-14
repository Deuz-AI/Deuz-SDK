/**
 * Postgres transactions on one pinned connection (2.4): `withPgTransaction`,
 * the pool guard that lets a new store refuse a query()-only client, and the
 * schema-meta helper every new Postgres store keeps its version in.
 *
 * Offline: a scripted pool for the protocol, PGlite behind `pglitePool` for
 * the schema helper. Live, when DEUZ_TEST_POSTGRES_URL names a server: a `pg`
 * pool at REPEATABLE READ, where a forced serialization conflict and a
 * deadlock really happen and really get retried.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertPgPool,
  ensurePgSchema,
  isPgPool,
  withPgTransaction,
  type PgPoolClientLike,
  type PgPoolLike,
  type PgSchemaSpec,
} from '../src/node/pg-tx';
import type { PgClientLike } from '../src/node/store-postgres';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const pgError = (code: string, message = `pg error ${code}`) =>
  Object.assign(new Error(message), { code });

/**
 * A pool whose connections log every statement as `<connection>:<sql>` and
 * answer through `reply`, which may throw. `releases` records each release
 * argument, in order.
 */
function scriptedPool(reply: (sql: string, connection: number) => void = () => undefined) {
  const log: string[] = [];
  const releases: unknown[] = [];
  let connections = 0;
  const pool: PgPoolLike = {
    async query() {
      throw new Error('a transaction must not use the pool directly');
    },
    async connect(): Promise<PgPoolClientLike> {
      const id = ++connections;
      return {
        async query(sql) {
          log.push(`${id}:${sql}`);
          reply(sql, id);
          return { rows: [] };
        },
        release(destroy?: Error | boolean) {
          releases.push(destroy);
        },
      };
    },
  };
  return { pool, log, releases, connections: () => connections };
}

describe('withPgTransaction', () => {
  it('runs the function between BEGIN and COMMIT on one connection, then releases it', async () => {
    const { pool, log, releases } = scriptedPool();
    const result = await withPgTransaction(pool, async (tx) => {
      await tx.query('SELECT 1');
      await tx.query('SELECT 2', [2]);
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(log).toEqual(['1:BEGIN', '1:SELECT 1', '1:SELECT 2', '1:COMMIT']);
    expect(releases).toEqual([undefined]);
  });

  it('rolls back and releases when the function throws, and rethrows its error', async () => {
    const { pool, log, releases } = scriptedPool();
    const failure = new Error('half way');
    await expect(
      withPgTransaction(pool, async (tx) => {
        await tx.query('INSERT 1');
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(log).toEqual(['1:BEGIN', '1:INSERT 1', '1:ROLLBACK']);
    expect(releases).toEqual([undefined]);
  });

  it('runs again on a fresh connection after a serialization failure or a deadlock', async () => {
    const { pool, log, releases } = scriptedPool();
    const failures = [pgError('40001'), pgError('40P01')];
    let calls = 0;
    const result = await withPgTransaction(pool, async (tx) => {
      calls++;
      await tx.query('UPDATE');
      const failure = failures.shift();
      if (failure) throw failure;
      return calls;
    });
    expect(result).toBe(3);
    expect(log).toEqual([
      '1:BEGIN',
      '1:UPDATE',
      '1:ROLLBACK',
      '2:BEGIN',
      '2:UPDATE',
      '2:ROLLBACK',
      '3:BEGIN',
      '3:UPDATE',
      '3:COMMIT',
    ]);
    expect(releases).toEqual([undefined, undefined, undefined]);
  });

  it('runs again when COMMIT itself fails with a serialization failure', async () => {
    let commits = 0;
    const { pool, log } = scriptedPool((sql) => {
      if (sql === 'COMMIT' && ++commits === 1) throw pgError('40001');
    });
    expect(await withPgTransaction(pool, async () => 'ok')).toBe('ok');
    expect(log).toEqual(['1:BEGIN', '1:COMMIT', '1:ROLLBACK', '2:BEGIN', '2:COMMIT']);
  });

  it('gives up after five attempts in all, as the stores do, or the number asked for', async () => {
    const always = async () => {
      throw pgError('40001', 'could not serialize access');
    };
    const five = scriptedPool();
    await expect(withPgTransaction(five.pool, always)).rejects.toThrow('could not serialize');
    expect(five.connections()).toBe(5);
    expect(five.releases).toHaveLength(5);
    const two = scriptedPool();
    await expect(withPgTransaction(two.pool, always, { attempts: 2 })).rejects.toThrow();
    expect(two.connections()).toBe(2);
  });

  it('never runs again after any other error, or one outside the codes asked for', async () => {
    for (const [error, retryOn] of [
      [pgError('23505'), undefined],
      [new Error('plain'), undefined],
      [pgError('40001'), ['40P01']],
    ] as const) {
      const { pool, connections } = scriptedPool();
      await expect(
        withPgTransaction(
          pool,
          async () => {
            throw error;
          },
          retryOn ? { retryOn } : {},
        ),
      ).rejects.toBe(error);
      expect(connections()).toBe(1);
    }
  });

  it('destroys a connection whose ROLLBACK failed instead of pooling it', async () => {
    const broken = new Error('connection terminated');
    const { pool, releases } = scriptedPool((sql) => {
      if (sql === 'ROLLBACK') throw broken;
    });
    const failure = new Error('the real cause');
    await expect(
      withPgTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(releases).toEqual([broken]);
  });

  it('refuses statements on a transaction that already ended', async () => {
    const { pool, log } = scriptedPool();
    const leaked = await withPgTransaction(pool, async (tx) => tx);
    await expect(leaked.query('SELECT 1')).rejects.toThrow(/already ended/);
    expect(log).toEqual(['1:BEGIN', '1:COMMIT']);
  });

  it('begins at the isolation level asked for', async () => {
    for (const [isolation, begin] of [
      ['read committed', 'BEGIN ISOLATION LEVEL READ COMMITTED'],
      ['repeatable read', 'BEGIN ISOLATION LEVEL REPEATABLE READ'],
      ['serializable', 'BEGIN ISOLATION LEVEL SERIALIZABLE'],
    ] as const) {
      const { pool, log } = scriptedPool();
      await withPgTransaction(pool, async () => undefined, { isolation });
      expect(log[0]).toBe(`1:${begin}`);
    }
  });

  it('refuses a pool whose connect() hands out no releasable connection', async () => {
    // A single pg.Client resolves connect() with nothing, and cannot be shared.
    const single = {
      query: async () => ({ rows: [] }),
      connect: async () => undefined,
    } as unknown as PgPoolLike;
    await expect(withPgTransaction(single, async () => 1)).rejects.toThrow(
      /connect\(\) must resolve to a connection with query\(\) and release\(\)/,
    );
  });
});

describe('isPgPool / assertPgPool', () => {
  it('tells a pool from a client that only runs one statement at a time', () => {
    const queryOnly: PgClientLike = { query: async () => ({ rows: [] }) };
    const { pool } = scriptedPool();
    expect(isPgPool(queryOnly)).toBe(false);
    expect(isPgPool(pool)).toBe(true);
    expect(() => assertPgPool(queryOnly, 'createPostgresTestStore')).toThrow(
      /createPostgresTestStore needs a pool .*connect\(\).*query\(\)-only client/,
    );
    expect(() => assertPgPool(pool, 'createPostgresTestStore')).not.toThrow();
  });

  it('takes a pg.Pool as it is', () => {
    const pool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const typed: PgPoolLike = pool;
    expect(isPgPool(typed)).toBe(true);
    void pool.end();
  });
});

/**
 * A store whose schema went through three versions, as in the SQLite helper's
 * test: 1 had `items(id)`, 2 added `label`, 3 added `size` and an index. `log`
 * records every upgrade step.
 */
function spec(schema: string, version: 1 | 2 | 3, extra: Partial<PgSchemaSpec> = {}) {
  const items = `${schema}.test_items`;
  const log = `${schema}.test_log`;
  const shapes = {
    1: `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY)`,
    2: `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '')`,
    3: `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', size INTEGER)`,
  };
  const upgrades: NonNullable<PgSchemaSpec['upgrades']> = {
    1: [
      `ALTER TABLE ${items} ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
      `UPDATE ${items} SET label = 'from 1'`,
      `INSERT INTO ${log} (step) VALUES ('1 to 2')`,
    ],
    // A step can be code, for a change SQL alone cannot express.
    2: [
      async (tx) => {
        await tx.query(`ALTER TABLE ${items} ADD COLUMN size INTEGER`);
        const { rows } = await tx.query(`SELECT id FROM ${items}`);
        for (const row of rows)
          await tx.query(`UPDATE ${items} SET size = $1 WHERE id = $2`, [
            String(row.id).length,
            row.id,
          ]);
        await tx.query(`INSERT INTO ${log} (step) VALUES ('2 to 3')`);
      },
    ],
  };
  return {
    name: 'test_store',
    schema,
    version,
    create: [
      `CREATE TABLE IF NOT EXISTS ${log} (step TEXT NOT NULL, at SERIAL)`,
      shapes[version],
      ...(version === 3 ? [`CREATE INDEX IF NOT EXISTS test_items_size ON ${items} (size)`] : []),
    ],
    upgrades: Object.fromEntries(Object.entries(upgrades).filter(([from]) => +from < version)),
    ...extra,
  } satisfies PgSchemaSpec;
}

describe('ensurePgSchema (PGlite)', () => {
  const db = new PGlite();
  const pool = pglitePool(db);
  // Start-up is slow under load; keep it out of the first test's time budget.
  beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
  afterAll(() => db.close());

  let schemas = 0;
  const freshSchema = async () => {
    const schema = `pgtx_${++schemas}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };
  const rows = async (sql: string) => (await pool.query(sql)).rows;
  const steps = async (schema: string) =>
    (await rows(`SELECT step FROM ${schema}.test_log ORDER BY at`)).map((row) => row.step);
  const version = async (schema: string) =>
    (await rows(`SELECT singleton, version FROM ${schema}.test_store_schema`)).map((row) => ({
      ...row,
    }));
  const tables = async (schema: string) =>
    (
      await rows(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`,
      )
    ).map((row) => row.table_name);

  it('creates a fresh schema whole, with its own single-row version table', async () => {
    const schema = await freshSchema();
    expect(await ensurePgSchema(pool, spec(schema, 3))).toEqual({ stored: undefined, version: 3 });
    expect(await tables(schema)).toEqual(['test_items', 'test_log', 'test_store_schema']);
    expect(await version(schema)).toEqual([{ singleton: 1, version: 3 }]);
    expect(await steps(schema)).toEqual([]);
    expect(pool.stats().connected).toBe(pool.stats().released);
  });

  it('leaves a schema at its version as it is, and adds what create gained since', async () => {
    const schema = await freshSchema();
    await ensurePgSchema(pool, spec(schema, 2));
    await pool.query(`INSERT INTO ${schema}.test_items (id, label) VALUES ('a', 'kept')`);
    const later = spec(schema, 2, {
      create: [
        ...spec(schema, 2).create,
        `CREATE INDEX IF NOT EXISTS test_items_label ON ${schema}.test_items (label)`,
      ],
    });
    expect(await ensurePgSchema(pool, later)).toEqual({ stored: 2, version: 2 });
    expect(await steps(schema)).toEqual([]);
    expect(await rows(`SELECT id, label FROM ${schema}.test_items`)).toEqual([
      { id: 'a', label: 'kept' },
    ]);
    expect(
      await rows(`SELECT indexname FROM pg_indexes WHERE indexname = 'test_items_label'`),
    ).toEqual([{ indexname: 'test_items_label' }]);
  });

  it('upgrades an older schema through every step from its version, in order', async () => {
    const schema = await freshSchema();
    await ensurePgSchema(pool, spec(schema, 1));
    await pool.query(`INSERT INTO ${schema}.test_items (id) VALUES ('ab'), ('abcd')`);
    expect(await ensurePgSchema(pool, spec(schema, 3))).toEqual({ stored: 1, version: 3 });
    expect(await steps(schema)).toEqual(['1 to 2', '2 to 3']);
    expect(await rows(`SELECT id, label, size FROM ${schema}.test_items ORDER BY id`)).toEqual([
      { id: 'ab', label: 'from 1', size: 2 },
      { id: 'abcd', label: 'from 1', size: 4 },
    ]);
    expect(await version(schema)).toEqual([{ singleton: 1, version: 3 }]);
  });

  it('refuses a newer schema with a clear error and changes nothing', async () => {
    const schema = await freshSchema();
    await ensurePgSchema(pool, spec(schema, 3));
    const before = await tables(schema);
    await expect(ensurePgSchema(pool, spec(schema, 2))).rejects.toThrow(
      `${schema}.test_store_schema holds schema version 3, newer than this build reads (versions 1 to 2)`,
    );
    expect(await tables(schema)).toEqual(before);
    expect(await version(schema)).toEqual([{ singleton: 1, version: 3 }]);
    expect(pool.stats().connected).toBe(pool.stats().released);
  });

  it('refuses a schema older than its oldest upgrade step', async () => {
    const schema = await freshSchema();
    await ensurePgSchema(pool, spec(schema, 1));
    const noUpgrades = spec(schema, 3, { upgrades: { 2: spec(schema, 3).upgrades[2]! } });
    await expect(ensurePgSchema(pool, noUpgrades)).rejects.toThrow(
      `${schema}.test_store_schema holds schema version 1, older than this build upgrades (versions 2 to 3)`,
    );
  });

  it('rolls an upgrade back whole when a step fails', async () => {
    const schema = await freshSchema();
    await ensurePgSchema(pool, spec(schema, 1));
    const broken = spec(schema, 2, {
      upgrades: {
        1: [...spec(schema, 2).upgrades[1]!, `INSERT INTO ${schema}.no_such_table VALUES (1)`],
      },
    });
    await expect(ensurePgSchema(pool, broken)).rejects.toThrow(/no_such_table/);
    expect(await version(schema)).toEqual([{ singleton: 1, version: 1 }]);
    expect(await steps(schema)).toEqual([]);
    expect(
      (
        await rows(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'test_items'`,
        )
      ).map((row) => row.column_name),
    ).toEqual(['id']);
  });

  it('keeps one version per schema, and refuses reserved or invalid names', async () => {
    const [one, two] = [await freshSchema(), await freshSchema()];
    await ensurePgSchema(pool, spec(one, 1));
    await ensurePgSchema(pool, spec(two, 3));
    expect(await version(one)).toEqual([{ singleton: 1, version: 1 }]);
    expect(await version(two)).toEqual([{ singleton: 1, version: 3 }]);
    await expect(
      ensurePgSchema(pool, { name: 'deuz_ops', version: 1, create: [] }),
    ).rejects.toThrow(/reserved/);
    for (const schema of ['Public', 'a-b', 'x; DROP TABLE y', ''])
      await expect(
        ensurePgSchema(pool, { name: 'test_store', schema, version: 1, create: [] }),
      ).rejects.toThrow(/schema name/);
  });
});

const url = postgresUrl();
// A network round trip per statement, and real waits on locks.
if (url) vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!url)('withPgTransaction on a live server (REPEATABLE READ, pooled)', () => {
  let pool: pg.Pool;
  // One prefix per run: schemas from an earlier, interrupted run never collide,
  // and only the schemas this file created are dropped.
  const prefix = `deuz_w0b_pgtx_${Date.now().toString(36)}`;
  const schemas: string[] = [];
  const freshSchema = async () => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
    // As in postgres-live: every pooled connection defaults to REPEATABLE READ,
    // so a concurrent write fails with 40001 instead of waiting.
    pool.on('connect', (connection) => {
      void connection.query(
        'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      );
    });
  });

  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('retries a forced serialization conflict until it commits', async () => {
    const schema = await freshSchema();
    await pool.query(`CREATE TABLE ${schema}.counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
    await pool.query(`INSERT INTO ${schema}.counter VALUES (1, 0)`);
    const read = async (tx: PgClientLike) =>
      Number((await tx.query(`SELECT n FROM ${schema}.counter WHERE id = 1`)).rows[0]!.n);
    const bothRead = [deferred(), deferred()];
    let attemptsB = 0;
    const a = withPgTransaction(pool, async (tx) => {
      const n = await read(tx);
      bothRead[0]!.resolve();
      await bothRead[1]!.promise;
      await tx.query(`UPDATE ${schema}.counter SET n = $1 WHERE id = 1`, [n + 1]);
    });
    const b = withPgTransaction(pool, async (tx) => {
      attemptsB++;
      const n = await read(tx);
      if (attemptsB === 1) {
        // Both snapshots are taken; let A commit its update over this one.
        bothRead[1]!.resolve();
        await bothRead[0]!.promise;
        await a;
      }
      await tx.query(`UPDATE ${schema}.counter SET n = $1 WHERE id = 1`, [n + 1]);
      return n;
    });
    await a;
    // The first attempt read 0 and lost to A; the retry read A's 1.
    expect(await b).toBe(1);
    expect(attemptsB).toBe(2);
    expect((await pool.query(`SELECT n FROM ${schema}.counter`)).rows).toEqual([{ n: 2 }]);
  });

  it('retries the victim of a deadlock until both commit', async () => {
    const schema = await freshSchema();
    await pool.query(`CREATE TABLE ${schema}.pair (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
    await pool.query(`INSERT INTO ${schema}.pair VALUES (1, 0), (2, 0)`);
    const locked = [deferred(), deferred()];
    const codes: string[] = [];
    let attempts = 0;
    const cross = (first: 1 | 2) =>
      withPgTransaction(
        pool,
        async (tx) => {
          attempts++;
          const second = first === 1 ? 2 : 1;
          try {
            await tx.query(`UPDATE ${schema}.pair SET n = n + 1 WHERE id = $1`, [first]);
            locked[first - 1]!.resolve();
            await locked[second - 1]!.promise;
            await tx.query(`UPDATE ${schema}.pair SET n = n + 1 WHERE id = $1`, [second]);
          } catch (error) {
            codes.push(String((error as { code?: unknown }).code));
            throw error;
          }
        },
        // READ COMMITTED: the loser fails as a deadlock victim, never with 40001.
        { isolation: 'read committed' },
      );
    await Promise.all([cross(1), cross(2)]);
    expect(codes).toEqual(['40P01']);
    expect(attempts).toBe(3);
    expect((await pool.query(`SELECT id, n FROM ${schema}.pair ORDER BY id`)).rows).toEqual([
      { id: 1, n: 2 },
      { id: 2, n: 2 },
    ]);
  });

  it('rolls everything back on a throw and leaks no connection', async () => {
    const schema = await freshSchema();
    await pool.query(`CREATE TABLE ${schema}.items (id TEXT PRIMARY KEY)`);
    // More failed transactions than the pool has connections: a leak would hang here.
    for (let i = 0; i < 10; i++)
      await expect(
        withPgTransaction(pool, async (tx) => {
          await tx.query(`INSERT INTO ${schema}.items VALUES ($1)`, [`row-${i}`]);
          throw new Error('abandon');
        }),
      ).rejects.toThrow('abandon');
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.items`)).rows).toEqual([
      { n: 0 },
    ]);
    expect(pool.totalCount).toBe(pool.idleCount);
  });

  it('queues concurrent first uses of a schema on its lock, under REPEATABLE READ', async () => {
    const schema = await freshSchema();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensurePgSchema(pool, spec(schema, 3))),
    );
    expect(results.filter((result) => result.stored === undefined)).toHaveLength(1);
    expect(results.filter((result) => result.stored === 3)).toHaveLength(5);
    expect(
      (await pool.query(`SELECT singleton, version FROM ${schema}.test_store_schema`)).rows,
    ).toEqual([{ singleton: 1, version: 3 }]);
  });

  it('upgrades a live schema and refuses a newer one', async () => {
    const schema = await freshSchema();
    await ensurePgSchema(pool, spec(schema, 1));
    expect(await ensurePgSchema(pool, spec(schema, 3))).toEqual({ stored: 1, version: 3 });
    await expect(ensurePgSchema(pool, spec(schema, 2))).rejects.toThrow(/newer than this build/);
  });
});
