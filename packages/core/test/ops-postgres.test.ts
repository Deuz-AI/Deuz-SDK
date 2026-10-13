import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import {
  agentRunListContracts,
  agentRunPruneContracts,
  agentRunStoreContracts,
  envelope,
} from './fixtures/agent-run-store-conformance';

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
async function freshOps() {
  const schema = `ops_${++schemas}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  return createPostgresOpsStore({ client, schema });
}

// Postgres leases run on database time, so the contract waits for real.
leaseProviderContracts('Postgres lease provider (PGlite, database time)', async () => ({
  provider: (await freshOps()).leases,
  advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ttl: 200,
  // PGlite runs in this process, so the database clock is the host clock.
  now: () => Date.now(),
}));

agentRunStoreContracts(
  'Postgres agent run store (PGlite)',
  async () => (await freshOps()).agentRuns,
);

agentRunPruneContracts('Postgres agent run retention (PGlite, database time)', async () => ({
  store: (await freshOps()).agentRuns,
  advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}));

agentRunListContracts('Postgres agent run listing (PGlite, database time)', async () => ({
  store: (await freshOps()).agentRuns,
  advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}));

describe('Postgres ops store', () => {
  it('shares leases and fenced agent runs across store instances on one database', async () => {
    const schema = `ops_${++schemas}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    const a = createPostgresOpsStore({ client, schema });
    const b = createPostgresOpsStore({ client, schema });
    const lease = await a.leases.acquire({ key: 'run', owner: 'a', ttlMs: 60_000 });
    expect(lease).toMatchObject({ owner: 'a', token: 1 });
    expect(lease!.expiresAt).toBeGreaterThan(0);
    expect(await b.leases.acquire({ key: 'run', owner: 'b', ttlMs: 60_000 })).toBeUndefined();
    expect(await b.leases.signal('run', 'cancel')).toBe(true);
    expect(await b.leases.signal('run', 'cancel')).toBe(true);
    expect(await a.leases.renew(lease!, 60_000)).toMatchObject({
      held: true,
      signals: ['cancel'],
    });
    await a.agentRuns.save(envelope('r', 1));
    await expect(Promise.resolve(b.agentRuns.save(envelope('r', 1)))).rejects.toThrow(/revision/);
    await b.agentRuns.save(envelope('r', 2, { modelSteps: 4 }));
    expect(await a.agentRuns.load('r')).toMatchObject({ revision: 2, modelSteps: 4 });
  });

  it('stores a cancel awaiting acknowledgement as 2.2 stores a queued cancel', async () => {
    const schema = `ops_${++schemas}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    const ops = createPostgresOpsStore({ client, schema });
    const lease = (await ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 60_000 }))!;
    await ops.leases.signal('run', 'drain');
    await ops.leases.signal('run', 'cancel');
    await ops.leases.renew(lease, 60_000, { acknowledge: true });
    const stored = async () =>
      (await client.query(`SELECT signals::text AS signals FROM ${schema}.deuz_leases`)).rows[0];
    // A 2.2 process on the same schema reads the same queued cancel.
    expect(await stored()).toEqual({ signals: '["cancel"]' });
    await ops.leases.ack!(lease, 'cancel');
    expect(await stored()).toEqual({ signals: '[]' });
  });

  it('rejects an invalid schema name and an unknown signal', async () => {
    expect(() => createPostgresOpsStore({ client, schema: 'x;drop' })).toThrow(/schema/);
    const ops = await freshOps();
    await expect(ops.leases.signal('run', 'stop' as 'cancel')).rejects.toThrow(/signal/);
  });
});

/** The plan Postgres picks for `sql` when it may not fall back to a sequential scan. */
async function indexedPlan(sql: string, params: unknown[]): Promise<string> {
  await db.query('SET enable_seqscan = off');
  try {
    const { rows } = await db.query<Record<string, unknown>>(`EXPLAIN ${sql}`, params);
    return rows.map((row) => String(Object.values(row)[0])).join('\n');
  } finally {
    await db.query('SET enable_seqscan = on');
  }
}

describe('Postgres ops retention on BIGINT times', () => {
  it('range-scans the claimed_at and updated_at indexes, with a fractional cutoff', async () => {
    const prunes: Array<{ sql: string; params: unknown[] }> = [];
    const recording: PgClientLike = {
      query: (sql, params) => {
        if (/^WITH gone AS \(DELETE FROM/.test(sql)) prunes.push({ sql, params: params ?? [] });
        return client.query(sql, params);
      },
    };
    const schema = `ops_${++schemas}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    const ops = createPostgresOpsStore({ client: recording, schema });
    await ops.claims('seed'); // first use creates the tables and the 2.3 indexes
    await client.query(`DELETE FROM ${schema}.deuz_claims`);
    await client.query(
      `INSERT INTO ${schema}.deuz_claims (key, claimed_at)
       SELECT 'k' || g, g FROM generate_series(1, 2000) g`,
    );
    await client.query(
      `INSERT INTO ${schema}.deuz_agent_runs (run_id, scope, revision, payload, updated_at)
       SELECT 'r' || g, 's', 1, '{"phase":"terminal"}', g FROM generate_series(1, 2000) g`,
    );
    await client.query(`ANALYZE ${schema}.deuz_claims`);
    await client.query(`ANALYZE ${schema}.deuz_agent_runs`);

    // Times are whole milliseconds, so a cutoff of 100.5 keeps 101 and later.
    expect(await ops.claims.prune(100.5)).toBe(100);
    expect(await ops.agentRuns.prune(100.5)).toBe(100);
    const [claimsPrune, runsPrune] = prunes;
    // Comparing a BIGINT column with a float8 parameter casts every row and
    // rules the index out; the retention indexes exist for these statements.
    expect(await indexedPlan(claimsPrune!.sql, claimsPrune!.params)).toMatch(
      /Index (Only )?Scan using deuz_claims_claimed_at|Bitmap Index Scan on deuz_claims_claimed_at/,
    );
    expect(await indexedPlan(runsPrune!.sql, runsPrune!.params)).toMatch(
      /Index (Only )?Scan using deuz_agent_runs_updated_at|Bitmap Index Scan on deuz_agent_runs_updated_at/,
    );
  });

  it('accepts any finite cutoff, however far from the stored times', async () => {
    const ops = await freshOps();
    expect(await ops.claims('k')).toBe(true);
    await ops.agentRuns.save(envelope('done', 1, { phase: 'terminal' }));
    const lease = (await ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 60_000 }))!;
    for (const before of [-Number.MAX_VALUE, -1e300, -0.5]) {
      expect(await ops.claims.prune(before)).toBe(0);
      expect(await ops.agentRuns.prune(before)).toBe(0);
      expect(await ops.leases.prune(before)).toBe(0);
    }
    // Past every bigint: the old and the new rows go, and a held lease stays.
    expect(await ops.claims.prune(Number.MAX_VALUE)).toBe(1);
    expect(await ops.agentRuns.prune(1e300)).toBe(1);
    expect(await ops.leases.prune(Number.MAX_VALUE)).toBe(0);
    expect(await ops.leases.renew(lease, 60_000)).toMatchObject({ held: true });
  });
});
