import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import { agentRunStoreContracts, envelope } from './fixtures/agent-run-store-conformance';

const db = new PGlite();
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
}));

agentRunStoreContracts(
  'Postgres agent run store (PGlite)',
  async () => (await freshOps()).agentRuns,
);

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

  it('rejects an invalid schema name and an unknown signal', async () => {
    expect(() => createPostgresOpsStore({ client, schema: 'x;drop' })).toThrow(/schema/);
    const ops = await freshOps();
    await expect(ops.leases.signal('run', 'stop' as 'cancel')).rejects.toThrow(/signal/);
  });
});
