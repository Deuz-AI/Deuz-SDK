/**
 * schema-pins.test.ts (2.4, W0A) — the rollback rule of spec §4.2. A 2.3
 * process must still open and use every database a 2.4 process writes, and a
 * 2.3 build refuses a schema version it does not know. So no existing schema
 * version may move: new tables get their own version table, and an addition to
 * an existing store is a `CREATE ... IF NOT EXISTS` that leaves the version be.
 *
 * Pinned here, each at its 2.3.0 value:
 *   - SQLite: the ops (`deuz_ops_schema`), budget, swarm and evolve version
 *     tables, and the store pack's `PRAGMA user_version`;
 *   - Postgres: the store pack's `deuz_meta.schema_version` and the ops,
 *     budget and swarm version tables (PGlite always; a live server too when
 *     DEUZ_TEST_POSTGRES_URL is set);
 *   - Redis: the ops, budget and swarm key-layout versions (ioredis-mock
 *     always; a live server too when DEUZ_TEST_REDIS_URL is set);
 *   - the version every persisted record format carries.
 *
 * The table layout 2.3.0 created is recorded in `fixtures/schema-layout-2.3.0.json`:
 * every 2.3 table, column and index must still be there as 2.3 wrote it (a 2.3
 * process reads and writes them), and a column added to a 2.3 table must be
 * nullable or have a default, or a 2.3 insert would fail. A database built from
 * the recorded 2.3 SQLite schema must open on the current code, work, and keep
 * its version. `DEUZ_SCHEMA_PIN_RECORD=1` writes the layout file when it is
 * missing; it can only be recorded from the 2.3.0 code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createSqliteOpsStore } from '../../src/node/ops-sqlite';
import { createSqliteBudgetStore } from '../../src/node/budget-sqlite';
import { createSqliteSwarmStore } from '../../src/node/swarm-sqlite';
import { createSqlitePopulationStore } from '../../src/node/evolve-sqlite';
import { createSqliteStores, type SqliteDatabaseLike } from '../../src/node/store-sqlite';
import { createPostgresStores, type PgClientLike } from '../../src/node/store-postgres';
import { createPostgresOpsStore } from '../../src/node/ops-postgres';
import { createPostgresBudgetStore } from '../../src/node/budget-postgres';
import { createPostgresSwarmStore } from '../../src/node/swarm-postgres';
import { createRedisOpsStore } from '../../src/node/ops-redis';
import { createRedisBudgetStore } from '../../src/node/redis-budget';
import { createRedisSwarmStore } from '../../src/node/swarm-redis';
import type { RedisScriptClient } from '../../src/node/store-redis';
import { createInMemoryAgentRunStore, runAgent } from '../../src/agent-run';
import { createMemoryBatchJobStore } from '../../src/batch/store';
import { createBatchClient } from '../../src/batch/client';
import { createAnthropic } from '../../src/anthropic';
import { createInMemorySessionStore } from '../../src/durable';
import { generateText } from '../../src/generate';
import { createGoal, GOAL_EVENT_VERSION, GOAL_RECORD_VERSION } from '../../src/goal';
import { DEUZ_STREAM_VERSION, DEUZ_STREAM_VERSIONS } from '../../src/ui';
import { createMockModel } from '../../src/testing';
import { createInMemoryMemoryStore } from '../../src/memory';
import { liveRedisServer, mockRedisServer } from '../fixtures/redis-harness';
import { postgresUrl, redisUrl, requiredServices } from '../fixtures/services';

const LAYOUT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'schema-layout-2.3.0.json',
);
const RECORD = process.env.DEUZ_SCHEMA_PIN_RECORD === '1';
// The shared helpers throw at load when a required server's URL is missing.
const liveUrl = postgresUrl();
const liveRedisUrl = redisUrl();
/** With DEUZ_TEST_REQUIRE_SERVICES=1 a missing live server fails instead of skipping. */
const requireServices = requiredServices().size > 0;

function missingService(name: string, variable: string): void {
  if (requireServices) {
    describe(`${name} schema pins (live server)`, () => {
      it(`needs ${variable} (DEUZ_TEST_REQUIRE_SERVICES=1)`, () => {
        throw new Error(
          `${variable} is not set, and DEUZ_TEST_REQUIRE_SERVICES=1 forbids skipping`,
        );
      });
    });
  } else {
    describe.skip(`${name} schema pins (live server: ${variable} is not set)`, () => {
      it('skipped', () => {});
    });
  }
}
// A network round trip per statement on the live servers; PGlite starts slowly.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

interface ColumnLayout {
  name: string;
  type: string;
  notNull: boolean;
  /** The default as the database reports it, or null. */
  default: string | null;
  /** Position in the primary key (SQLite, 1-based), 0 outside it; always 0 on Postgres. */
  pk: number;
}

interface IndexLayout {
  name: string;
  /** SQLite: `unique:<0|1> origin:<c|u|pk> columns:<a,b>`; Postgres: the index definition. */
  definition: string;
}

interface TableLayout {
  columns: ColumnLayout[];
  indexes: IndexLayout[];
}

interface StoreLayout {
  tables: Record<string, TableLayout>;
  /** SQLite only: trigger name to its `CREATE TRIGGER` statement. */
  triggers?: Record<string, string>;
  /**
   * SQLite only: every `CREATE` statement of the schema (tables, indexes,
   * triggers) in creation order, to rebuild the database 2.3 created.
   */
  sql?: string[];
}

type LayoutFile = Record<string, StoreLayout>;

function readLayouts(): LayoutFile {
  return existsSync(LAYOUT_FILE)
    ? (JSON.parse(readFileSync(LAYOUT_FILE, 'utf8')) as LayoutFile)
    : {};
}

const recorded: LayoutFile = readLayouts();
const pendingRecord: LayoutFile = {};

afterAll(() => {
  if (!RECORD || Object.keys(pendingRecord).length === 0) return;
  const next = { ...readLayouts(), ...pendingRecord };
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(LAYOUT_FILE), { recursive: true });
  writeFileSync(LAYOUT_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
});

/**
 * The current layout must keep every 2.3 table, column and index as 2.3 wrote
 * it; an added column must be nullable or have a default.
 */
function expectKeeps23Layout(key: string, current: StoreLayout): void {
  const expected = recorded[key];
  if (!expected) {
    if (!RECORD) {
      throw new Error(
        `No 2.3.0 layout for '${key}' in fixtures/schema-layout-2.3.0.json. It can only be ` +
          'recorded from the 2.3.0 code (DEUZ_SCHEMA_PIN_RECORD=1).',
      );
    }
    pendingRecord[key] = current;
    return;
  }
  for (const [table, old] of Object.entries(expected.tables)) {
    const now = current.tables[table];
    expect(now, `${key}: table ${table} (2.3) is missing`).toBeDefined();
    for (const column of old.columns) {
      const found = now!.columns.find((c) => c.name === column.name);
      expect(found, `${key}: column ${table}.${column.name} (2.3) is missing`).toBeDefined();
      expect(
        { type: found!.type, notNull: found!.notNull, pk: found!.pk },
        `${key}: column ${table}.${column.name} changed`,
      ).toEqual({ type: column.type, notNull: column.notNull, pk: column.pk });
    }
    for (const added of now!.columns.filter((c) => !old.columns.some((o) => o.name === c.name))) {
      expect(
        !added.notNull || added.default !== null,
        `${key}: column ${table}.${added.name} was added NOT NULL without a default; a 2.3 insert would fail`,
      ).toBe(true);
    }
    for (const index of old.indexes) {
      expect(
        now!.indexes.find((i) => i.name === index.name)?.definition,
        `${key}: index ${index.name} on ${table} (2.3) is missing or changed`,
      ).toBe(index.definition);
    }
  }
  // A 2.3 writer relies on the triggers it created (FTS sync, budget totals).
  for (const [name, sql] of Object.entries(expected.triggers ?? {})) {
    expect(
      squash(current.triggers?.[name]),
      `${key}: trigger ${name} (2.3) is missing or changed`,
    ).toBe(squash(sql));
  }
}

const squash = (sql: string | undefined) => sql?.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

type DatabaseSyncCtor = new (path: string) => SqliteDatabaseLike;
let DatabaseSync: DatabaseSyncCtor;
beforeAll(async () => {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: DatabaseSyncCtor })
    .DatabaseSync;
});

const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`;

function sqliteLayout(db: SqliteDatabaseLike): StoreLayout {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  // FTS5 keeps its own shadow tables (`<name>_data`, ...): SQLite's, not the store's.
  const virtual = objects
    .filter((o) => o.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(o.sql ?? ''))
    .map((o) => o.name);
  const isShadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
  // Triggers named after the FTS table (`deuz_memory_fts_ai`) are the store's own.
  const ownObject = (o: { type: string; tbl_name: string }) =>
    o.type === 'trigger' || !isShadow(o.tbl_name);
  const tables: Record<string, TableLayout> = {};
  for (const table of objects.filter((o) => o.type === 'table' && !isShadow(o.name))) {
    const columns = (
      db.prepare(`PRAGMA table_info(${quoteId(table.name)})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[]
    ).map((c) => ({
      name: c.name,
      type: c.type,
      notNull: c.notnull === 1,
      default: c.dflt_value,
      pk: c.pk,
    }));
    const indexes = (
      db.prepare(`PRAGMA index_list(${quoteId(table.name)})`).all() as {
        name: string;
        unique: number;
        origin: string;
      }[]
    )
      .map((index) => {
        const names = (
          db.prepare(`PRAGMA index_info(${quoteId(index.name)})`).all() as { name: string | null }[]
        ).map((c) => c.name ?? '<expr>');
        return {
          name: index.name,
          definition: `unique:${index.unique} origin:${index.origin} columns:${names.join(',')}`,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    tables[table.name] = { columns, indexes };
  }
  const own = objects.filter((o) => o.sql !== null && ownObject(o));
  const triggers = Object.fromEntries(
    own.filter((o) => o.type === 'trigger').map((o) => [o.name, o.sql!]),
  );
  return { tables, triggers, sql: own.map((o) => o.sql!) };
}

interface SqliteCase {
  key: string;
  /** Open the store on `db` (the store owns it) and run one call, which creates the schema. */
  touch(db: SqliteDatabaseLike): Promise<{ close(): Promise<void> }>;
  /** Read the store's schema version from `db`. */
  version(db: SqliteDatabaseLike): unknown;
  /** The 2.3.0 value. */
  pinned: number;
}

const versionTable = (table: string) => (db: SqliteDatabaseLike) =>
  (db.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as { version: number })
    .version;

const SQLITE_CASES: readonly SqliteCase[] = [
  {
    key: 'sqlite/ops',
    async touch(database) {
      const store = createSqliteOpsStore({ path: ':memory:', database });
      await store.agentRuns.load('pin-probe');
      return store;
    },
    version: versionTable('deuz_ops_schema'),
    pinned: 1,
  },
  {
    key: 'sqlite/budget',
    async touch(database) {
      const store = createSqliteBudgetStore({ path: ':memory:', database });
      await store.usage('pin-probe');
      return store;
    },
    version: versionTable('deuz_budget_schema'),
    pinned: 1,
  },
  {
    key: 'sqlite/swarm',
    async touch(database) {
      const store = createSqliteSwarmStore({ path: ':memory:', database });
      await store.load({ scope: 'pin', runId: 'probe' });
      return store;
    },
    version: versionTable('deuz_swarm_schema'),
    pinned: 2,
  },
  {
    key: 'sqlite/evolve',
    async touch(database) {
      const store = createSqlitePopulationStore({ path: ':memory:', database });
      await store.loadRun({ scope: 'pin', runId: 'probe' });
      return store;
    },
    version: versionTable('deuz_evolve_schema'),
    pinned: 1,
  },
  {
    key: 'sqlite/stores',
    async touch(database) {
      const stores = createSqliteStores({ path: ':memory:', database });
      await stores.chats.loadChat('pin-probe');
      return stores;
    },
    version: (db) =>
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    pinned: 1,
  },
];

/**
 * The recorded 2.3 layout of `sqlite/stores` includes its FTS5 index, which a
 * Node whose SQLite lacks FTS5 (22.14, the release job's) never creates.
 */
function needsFts5(key: string): boolean {
  if (key !== 'sqlite/stores') return false;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

describe('SQLite schema versions stay at their 2.3.0 values', () => {
  for (const entry of SQLITE_CASES) {
    it(`${entry.key}: a new database is stamped ${entry.pinned} and keeps the 2.3 layout`, async (ctx) => {
      if (needsFts5(entry.key)) ctx.skip();
      const db = new DatabaseSync(':memory:');
      const store = await entry.touch(db);
      try {
        expect(entry.version(db)).toBe(entry.pinned);
        expectKeeps23Layout(entry.key, sqliteLayout(db));
      } finally {
        await store.close();
      }
    });

    it(`${entry.key}: a database 2.3 created opens, works and keeps version ${entry.pinned}`, async (ctx) => {
      if (needsFts5(entry.key)) ctx.skip();
      const layout = recorded[entry.key];
      if (!layout) return; // Reported by the layout test above.
      const db = new DatabaseSync(':memory:');
      for (const sql of layout.sql ?? []) db.exec(sql);
      if (entry.key === 'sqlite/stores') db.exec(`PRAGMA user_version = ${entry.pinned}`);
      else {
        const meta = Object.keys(layout.tables).find((name) => name.endsWith('_schema'))!;
        db.exec(`INSERT INTO ${meta} (singleton, version) VALUES (1, ${entry.pinned})`);
      }
      const store = await entry.touch(db);
      try {
        expect(entry.version(db)).toBe(entry.pinned);
      } finally {
        await store.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

async function postgresLayout(client: PgClientLike, schema: string): Promise<StoreLayout> {
  const placeholder = (text: string) => text.split(`${schema}.`).join('<schema>.');
  const columns = (
    await client.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema],
    )
  ).rows;
  const indexes = (
    await client.query(
      'SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname',
      [schema],
    )
  ).rows;
  const tables: Record<string, TableLayout> = {};
  for (const row of columns) {
    const table = (tables[String(row.table_name)] ??= { columns: [], indexes: [] });
    table.columns.push({
      name: String(row.column_name),
      type: String(row.data_type),
      notNull: row.is_nullable === 'NO',
      default: row.column_default === null ? null : placeholder(String(row.column_default)),
      pk: 0,
    });
  }
  for (const row of indexes) {
    tables[String(row.tablename)]?.indexes.push({
      name: String(row.indexname),
      definition: placeholder(String(row.indexdef)),
    });
  }
  return { tables };
}

interface PostgresCase {
  key: string;
  /** Create the store's schema in `schema`. */
  touch(client: PgClientLike, schema: string): Promise<void>;
  version(client: PgClientLike, schema: string): Promise<unknown>;
  pinned: unknown;
}

const metaVersion = (table: string) => async (client: PgClientLike, schema: string) =>
  (await client.query(`SELECT version FROM ${schema}.${table} WHERE singleton = 1`)).rows[0]
    ?.version;

const POSTGRES_CASES: readonly PostgresCase[] = [
  {
    key: 'postgres/stores',
    async touch(client, schema) {
      await createPostgresStores({ client, schema, pgvector: 'off' }).migrate();
    },
    async version(client, schema) {
      return (
        await client.query(`SELECT value FROM ${schema}.deuz_meta WHERE key = 'schema_version'`)
      ).rows[0]?.value;
    },
    pinned: '1',
  },
  {
    key: 'postgres/ops',
    async touch(client, schema) {
      await createPostgresOpsStore({ client, schema }).agentRuns.load('pin-probe');
    },
    version: metaVersion('deuz_ops_schema'),
    pinned: 1,
  },
  {
    key: 'postgres/budget',
    async touch(client, schema) {
      await createPostgresBudgetStore({ client, schema }).usage('pin-probe');
    },
    version: metaVersion('deuz_budget_schema'),
    pinned: 1,
  },
  {
    key: 'postgres/swarm',
    async touch(client, schema) {
      await createPostgresSwarmStore({ client, schema }).load({ scope: 'pin', runId: 'probe' });
    },
    version: metaVersion('deuz_swarm_pg_schema'),
    pinned: 1,
  },
];

function postgresPins(
  label: string,
  connect: () => Promise<{ client: PgClientLike; close(): Promise<void> }>,
  /** The live server is compared with the PGlite layout too, but only PGlite records it. */
  records: boolean,
) {
  describe(`Postgres schema versions stay at their 2.3.0 values (${label})`, () => {
    let client: PgClientLike;
    let close: () => Promise<void> = async () => {};
    const schemas: string[] = [];
    const run = `w0a_pins_${Date.now().toString(36)}`;

    beforeAll(async () => {
      ({ client, close } = await connect());
    });
    afterAll(async () => {
      try {
        for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await close();
      }
    });

    for (const entry of POSTGRES_CASES) {
      it(`${entry.key}: a new schema is stamped ${String(entry.pinned)} and keeps the 2.3 layout`, async () => {
        const schema = `${run}_${schemas.length + 1}`;
        schemas.push(schema);
        await client.query(`CREATE SCHEMA ${schema}`);
        await entry.touch(client, schema);
        expect(await entry.version(client, schema)).toBe(entry.pinned);
        const layout = await postgresLayout(client, schema);
        if (records || recorded[entry.key]) expectKeeps23Layout(entry.key, layout);
        // A second store on the schema 2.3 created keeps the version.
        await entry.touch(client, schema);
        expect(await entry.version(client, schema)).toBe(entry.pinned);
      });
    }
  });
}

postgresPins(
  'PGlite',
  async () => {
    const db = new PGlite();
    await db.waitReady;
    return {
      client: {
        // PGlite's extended protocol takes one statement; the store pack's
        // migration is a script, which the simple protocol (`exec`) runs.
        async query(sql, params) {
          if (params?.length) return db.query<Record<string, unknown>>(sql, params);
          const results = await db.exec(sql);
          return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
        },
      },
      close: () => db.close(),
    };
  },
  true,
);

if (liveUrl) {
  postgresPins(
    'live server',
    async () => {
      const pool = new pg.Pool({ connectionString: liveUrl, max: 2 });
      return {
        client: {
          async query(sql, params) {
            return { rows: (await pool.query(sql, params)).rows as Record<string, unknown>[] };
          },
        },
        close: () => pool.end(),
      };
    },
    false,
  );
} else {
  missingService('Postgres', 'DEUZ_TEST_POSTGRES_URL');
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

interface RedisServer {
  client: RedisScriptClient;
  get(key: string): Promise<string | null>;
  prefix(): string;
  close(): Promise<void>;
}

const REDIS_CASES = [
  {
    store: 'ops',
    touch: (client: RedisScriptClient, prefix: string) =>
      createRedisOpsStore({ client, prefix }).agentRuns.load('pin-probe'),
  },
  {
    store: 'budget',
    touch: (client: RedisScriptClient, prefix: string) =>
      createRedisBudgetStore({ client, prefix }).usage('pin-probe'),
  },
  {
    store: 'swarm',
    touch: (client: RedisScriptClient, prefix: string) =>
      createRedisSwarmStore({ client, prefix }).load({ scope: 'pin', runId: 'probe' }),
  },
] as const;

function redisPins(label: string, connect: () => Promise<RedisServer>) {
  describe(`Redis key-layout versions stay at their 2.3.0 value (${label})`, () => {
    let server: RedisServer;
    beforeAll(async () => {
      server = await connect();
    });
    afterAll(async () => {
      await server.close();
    });

    for (const entry of REDIS_CASES) {
      it(`${entry.store}: stamps {prefix:${entry.store}}:schema = 1`, async () => {
        const prefix = server.prefix();
        await entry.touch(server.client, prefix);
        expect(await server.get(`{${prefix}:${entry.store}}:schema`)).toBe('1');
      });
    }
  });
}

redisPins('ioredis-mock', async () => {
  const mock = mockRedisServer();
  let count = 0;
  return {
    client: mock.client,
    get: (key) => mock.redis.get(key),
    prefix: () => `w0a-pins-${++count}`,
    close: async () => {
      mock.redis.disconnect();
    },
  };
});

if (liveRedisUrl) {
  const url = liveRedisUrl;
  redisPins('live server', async () => {
    const live = await liveRedisServer(url);
    return {
      client: live.client as unknown as RedisScriptClient,
      get: (key) => live.client.get(key),
      // The harness's own prefixes: its close() drops every key they named.
      prefix: () => live.prefix(),
      close: () => live.close(),
    };
  });
} else {
  missingService('Redis', 'DEUZ_TEST_REDIS_URL');
}

// ---------------------------------------------------------------------------
// Persisted record formats
// ---------------------------------------------------------------------------

describe('persisted record formats keep their 2.3.0 versions', () => {
  it('a native run without memory, chat or fail-over saves envelope version 1', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'done' }] });
    await runAgent({ model, prompt: 'hi', session: { store, runId: 'pin', scope: 'tenant' } });
    expect((await store.load('pin'))?.version).toBe(1);
  });

  it('a native run with memory saves envelope version 2', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'done' }] });
    let id = 0;
    await runAgent({
      model,
      prompt: 'hi',
      session: { store, runId: 'pin', scope: 'tenant' },
      memory: {
        seams: {
          store: createInMemoryMemoryStore(),
          llm: async () => '{"facts":[]}',
          clock: { now: () => 1, setTimeout: () => () => {} },
          generateId: () => `m${++id}`,
        },
        scope: { userId: 'u' },
        extract: false,
      },
    });
    expect((await store.load('pin'))?.version).toBe(2);
  });

  it('a legacy checkpoint is version 1', async () => {
    const store = createInMemorySessionStore();
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'noop', args: {} }] }, { text: 'done' }],
    });
    const tools = { noop: { parameters: { type: 'object' as const }, execute: async () => 'ok' } };
    await generateText({
      model,
      prompt: 'hi',
      tools,
      maxSteps: 2,
      session: { store, runId: 'pin' },
    });
    expect((await store.load('pin'))?.version).toBe(1);
  });

  it('goal records and events are version 1', () => {
    expect(GOAL_RECORD_VERSION).toBe(1);
    expect(GOAL_EVENT_VERSION).toBe(1);
    const goal = createGoal({ goalId: 'g', scope: 's', objective: 'Pin' }, { now: 1 });
    expect(goal.version).toBe(1);
  });

  it('batch jobs are version 1', async () => {
    const store = createMemoryBatchJobStore();
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'msgbatch_pin',
          type: 'message_batch',
          processing_status: 'in_progress',
          request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
          created_at: '2026-01-01T00:00:00Z',
          expires_at: '2026-01-02T00:00:00Z',
          ended_at: null,
          cancel_initiated_at: null,
          archived_at: null,
          results_url: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof globalThis.fetch;
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-sonnet-4-5');
    const job = await createBatchClient({ model, store }).submit([{ id: 'q', prompt: 'hi' }]);
    expect(job.version).toBe(1);
    expect((await store.list())[0]?.version).toBe(1);
  });

  it('the UI stream wire keeps v2 as its default and reads v1 and v2', () => {
    expect(DEUZ_STREAM_VERSION).toBe('v2');
    expect([...DEUZ_STREAM_VERSIONS]).toEqual(expect.arrayContaining(['v1', 'v2']));
  });
});
