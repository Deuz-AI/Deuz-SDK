import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresSchema,
  postgresSchemaStatement,
  type PostgresSchemaSpec,
} from '../src/node/postgres-migrate';
import type { PgClientLike } from '../src/node/store-postgres';

// The schema statement every Postgres store sends on first use (2.2), with the
// forward migrations 2.3 adds: a schema stored at an older version is brought
// up to date in the same locked statement, instead of being refused.
const db = new PGlite();
// Start-up is slow under load; keep it out of the first test's time budget.
beforeAll(() => db.waitReady, 60_000);
afterAll(async () => {
  await db.close();
});
const client: PgClientLike = {
  query: (sql, params) => db.query<Record<string, unknown>>(sql, params),
};

let schemas = 0;
async function freshSchema(): Promise<string> {
  const schema = `migrate_${++schemas}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  return schema;
}

/**
 * A store whose schema went through three versions: 1 had `items(id)`, 2 added
 * `items.label`, 3 added `items.size` and an index on it. `log` records every
 * upgrade step that ran.
 */
function spec(schema: string, version: 1 | 2 | 3): PostgresSchemaSpec {
  const items = `${schema}.items`;
  const log = `${schema}.log`;
  const shapes = {
    1: `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY)`,
    2: `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '')`,
    3: `CREATE TABLE IF NOT EXISTS ${items} (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', size INTEGER)`,
  };
  const upgrades: Record<number, string[]> = {
    1: [
      `ALTER TABLE ${items} ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT ''`,
      `UPDATE ${items} SET label = 'from 1' WHERE label = ''`,
      `INSERT INTO ${log} (step) VALUES ('1 to 2')`,
    ],
    2: [
      `ALTER TABLE ${items} ADD COLUMN IF NOT EXISTS size INTEGER`,
      `UPDATE ${items} SET size = length(id) WHERE size IS NULL`,
      `INSERT INTO ${log} (step) VALUES ('2 to 3')`,
    ],
  };
  return {
    lock: `test:${schema}`,
    meta: `${schema}.meta`,
    version,
    unsupported: 'Unsupported Postgres test schema version',
    create: [
      shapes[version],
      `CREATE TABLE IF NOT EXISTS ${log} (step TEXT NOT NULL)`,
      ...(version === 3 ? [`CREATE INDEX IF NOT EXISTS items_size ON ${items} (size)`] : []),
    ],
    ...(version > 1
      ? {
          upgrades: Object.fromEntries(
            Object.entries(upgrades).filter(([from]) => Number(from) < version),
          ),
        }
      : {}),
  };
}

const migrate = (target: PostgresSchemaSpec, via: PgClientLike = client) =>
  createPostgresSchema(via, postgresSchemaStatement(target));
const stored = async (schema: string) =>
  (await client.query(`SELECT version FROM ${schema}.meta`)).rows.map((row) => row.version);
const steps = async (schema: string) =>
  (await client.query(`SELECT step FROM ${schema}.log`)).rows.map((row) => row.step);
const items = async (schema: string) =>
  (await client.query(`SELECT * FROM ${schema}.items ORDER BY id`)).rows;

describe('Postgres schema statement, forward migrations (2.3)', () => {
  it('creates a new schema at the current version without running any upgrade step', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 3));
    expect(await stored(schema)).toEqual([3]);
    expect(await steps(schema)).toEqual([]);
    await client.query(`INSERT INTO ${schema}.items (id, label, size) VALUES ('a', 'x', 1)`);
  });

  it('upgrades a schema stored at an older version, step by step, keeping its rows', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 1));
    await client.query(`INSERT INTO ${schema}.items (id) VALUES ('ab'), ('abc')`);
    await migrate(spec(schema, 3));
    expect(await stored(schema)).toEqual([3]);
    expect(await steps(schema)).toEqual(['1 to 2', '2 to 3']);
    expect(await items(schema)).toEqual([
      { id: 'ab', label: 'from 1', size: 2 },
      { id: 'abc', label: 'from 1', size: 3 },
    ]);
    const { rows } = await client.query(`SELECT to_regclass('${schema}.items_size') AS found`);
    expect(rows[0]?.found).not.toBeNull();
  });

  it('runs only the steps a schema still needs, and none once it is current', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 2));
    await migrate(spec(schema, 3));
    expect(await steps(schema)).toEqual(['2 to 3']);
    await migrate(spec(schema, 3));
    expect(await steps(schema)).toEqual(['2 to 3']);
    expect(await stored(schema)).toEqual([3]);
  });

  it('upgrades once when two first uses arrive together', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 1));
    await Promise.all([migrate(spec(schema, 3)), migrate(spec(schema, 3))]);
    expect(await steps(schema)).toEqual(['1 to 2', '2 to 3']);
  });

  it('refuses a version newer than this build, naming it, before running anything', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 1));
    await client.query(`UPDATE ${schema}.meta SET version = 7`);
    await expect(migrate(spec(schema, 3))).rejects.toThrow(
      'Unsupported Postgres test schema version 7; this build reads versions 1 to 3',
    );
    expect(await steps(schema)).toEqual([]);
    expect(await stored(schema)).toEqual([7]);
  });

  it('refuses a version older than its oldest upgrade step', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 1));
    await client.query(`UPDATE ${schema}.meta SET version = 0`);
    await expect(migrate(spec(schema, 3))).rejects.toThrow(
      'Unsupported Postgres test schema version 0; this build reads versions 1 to 3',
    );
    await client.query(`UPDATE ${schema}.meta SET version = 1`);
    // Without upgrade steps, only the version itself is readable.
    await expect(migrate({ ...spec(schema, 3), upgrades: undefined })).rejects.toThrow(
      'Unsupported Postgres test schema version 1; this build reads version 3',
    );
  });

  it('leaves the schema as it was when an upgrade step fails', async () => {
    const schema = await freshSchema();
    await migrate(spec(schema, 1));
    await client.query(`INSERT INTO ${schema}.items (id) VALUES ('a')`);
    const broken = spec(schema, 3);
    const failing: PostgresSchemaSpec = {
      ...broken,
      upgrades: { ...broken.upgrades, 2: [`SELECT * FROM ${schema}.missing_table`] },
    };
    await expect(migrate(failing)).rejects.toMatchObject({ code: '42P01' });
    expect(await stored(schema)).toEqual([1]);
    expect(await steps(schema)).toEqual([]);
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = 'items' ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(['id']);
  });

  it('adds new objects of the current version to an existing schema without a version change', async () => {
    const schema = await freshSchema();
    const v1 = spec(schema, 1);
    await migrate(v1);
    await migrate({
      ...v1,
      create: [...v1.create, `CREATE INDEX IF NOT EXISTS items_id ON ${schema}.items (id)`],
    });
    expect(await stored(schema)).toEqual([1]);
    const { rows } = await client.query(`SELECT to_regclass('${schema}.items_id') AS found`);
    expect(rows[0]?.found).not.toBeNull();
  });

  it('rejects upgrade steps that do not lead to its version', () => {
    const base = spec('public', 3);
    expect(() => postgresSchemaStatement({ ...base, upgrades: { 2: [] } })).not.toThrow();
    const invalid: Record<number, string[]>[] = [
      { 3: [] },
      { 1: [] },
      { 0.5: [] },
      { [-1]: [], 1: [], 2: [] },
    ];
    for (const upgrades of invalid)
      expect(() => postgresSchemaStatement({ ...base, upgrades })).toThrow(/upgrade/i);
  });
});
