import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createInMemoryClaim, createScheduler, handleSignal } from '../src/schedule';
import type { ScheduleOccurrence } from '../src/schedule';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import type { PgClientLike } from '../src/node/store-postgres';
import { scheduleClaimContracts } from './fixtures/schedule-claim-conformance';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function tempFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'deuz-claims-'));
  cleanup.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
  );
  return join(directory, 'ops.sqlite');
}

function sqliteOps(path: string, database?: SqliteDatabaseLike) {
  const ops = createSqliteOpsStore({ path, ...(database ? { database } : {}) });
  cleanup.push(() => ops.close());
  return ops;
}

/** An injected handle whose run() executes but reports nothing, as some drivers do. */
function quietHandle(db: SqliteDatabaseLike): SqliteDatabaseLike {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params) => void statement.run(...params),
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

const pg = new PGlite();
// Start-up is slow under load; keep it out of the first test's time budget.
beforeAll(() => pg.waitReady, 60_000);
afterAll(async () => {
  await pg.close();
});
const client: PgClientLike = {
  query: (sql, params) => pg.query<Record<string, unknown>>(sql, params),
};
let schemas = 0;
async function freshSchema(): Promise<string> {
  const schema = `claims_${++schemas}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  return schema;
}

scheduleClaimContracts('in-memory claim', () => createInMemoryClaim());

describe.skipIf(!DatabaseSync)('SQLite ops store claims', () => {
  scheduleClaimContracts('SQLite claim', () => sqliteOps(':memory:').claims);
  // The grant must not depend on what an injected driver's run() returns.
  scheduleClaimContracts(
    'SQLite claim on a handle whose run() reports nothing',
    () => sqliteOps(':memory:', quietHandle(new DatabaseSync!(':memory:'))).claims,
  );

  it('shares claims between two connections on one file and keeps them across a reopen', async () => {
    const path = await tempFile();
    const a = sqliteOps(path);
    const b = sqliteOps(path);
    expect(await a.claims('digest@1')).toBe(true);
    expect(await b.claims('digest@1')).toBe(false);
    await b.claims.release('digest@1');
    expect(await a.claims('digest@1')).toBe(true);
    const results = await Promise.all([
      a.claims('race'),
      b.claims('race'),
      a.claims('race'),
      b.claims('race'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await a.close();
    await b.close();
    const reopened = sqliteOps(path);
    expect(await reopened.claims('digest@1')).toBe(false);
    expect(await reopened.claims('race')).toBe(false);
  });

  it('adds the claims table to an ops file written before claims existed', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(`CREATE TABLE deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
      INSERT INTO deuz_ops_schema VALUES (1, 1);
      CREATE TABLE deuz_leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, signals TEXT NOT NULL);
      CREATE TABLE deuz_agent_runs (run_id TEXT PRIMARY KEY, scope TEXT NOT NULL,
        revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
    const ops = sqliteOps(':memory:', db);
    expect(await ops.claims('k')).toBe(true);
    expect(await ops.claims('k')).toBe(false);
  });
});

describe('Postgres ops store claims (PGlite)', () => {
  scheduleClaimContracts(
    'Postgres claim',
    async () => createPostgresOpsStore({ client, schema: await freshSchema() }).claims,
  );

  it('shares claims between two store instances on one schema', async () => {
    const schema = await freshSchema();
    const a = createPostgresOpsStore({ client, schema });
    const b = createPostgresOpsStore({ client, schema });
    expect(await a.claims('digest@1')).toBe(true);
    expect(await b.claims('digest@1')).toBe(false);
    await b.claims.release('digest@1');
    expect(await a.claims('digest@1')).toBe(true);
    expect(await b.claims('digest@1')).toBe(false);
  });

  it('adds the claims table to an ops schema created before claims existed', async () => {
    const schema = await freshSchema();
    await client.query(
      `CREATE TABLE ${schema}.deuz_ops_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`,
    );
    await client.query(`INSERT INTO ${schema}.deuz_ops_schema VALUES (1, 1)`);
    const ops = createPostgresOpsStore({ client, schema });
    expect(await ops.claims('k')).toBe(true);
    expect(await ops.claims('k')).toBe(false);
  });
});

describe.skipIf(!DatabaseSync)('durable claims with the scheduler and signals', () => {
  it('dedupes an occurrence across two processes sharing an ops file', async () => {
    const path = await tempFile();
    const ran: string[] = [];
    const schedules = [
      { id: 'digest', cron: '0 * * * *', run: (o: ScheduleOccurrence) => void ran.push(o.key) },
    ];
    const at = Date.parse('2026-01-01T12:00:30Z');
    const first = createScheduler({ schedules, claim: sqliteOps(path).claims });
    const second = createScheduler({ schedules, claim: sqliteOps(path).claims });
    expect((await first.tick(at)).occurrences.map((o) => o.status)).toEqual(['ran']);
    expect((await second.tick(at + 10_000)).occurrences.map((o) => o.status)).toEqual([
      'duplicate',
    ]);
    expect(ran).toEqual([`digest@${Date.parse('2026-01-01T12:00:00Z')}`]);
  });

  it("releases a signal's durable claim when dispatch throws, so the retry dispatches", async () => {
    const path = await tempFile();
    let calls = 0;
    const dispatch = vi.fn(async () => {
      if (++calls === 1) throw new Error('queue full');
    });
    const deliver = (ops: ReturnType<typeof sqliteOps>) =>
      handleSignal(
        new Request('https://example.test/hook', {
          method: 'POST',
          body: '{}',
          headers: { 'x-github-delivery': 'd-1' },
        }),
        {
          verify: async () => ({ ok: true, body: '{}' }),
          key: ({ request }) => request.headers.get('x-github-delivery') ?? undefined,
          dedupe: ops.claims,
          dispatch,
        },
      );
    // Two instances behind a load balancer: the retry lands on the other one.
    expect((await deliver(sqliteOps(path))).status).toBe(500);
    expect((await deliver(sqliteOps(path))).status).toBe(202);
    expect((await deliver(sqliteOps(path))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
