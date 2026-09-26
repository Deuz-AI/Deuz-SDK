import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { leaseProviderContracts } from './fixtures/lease-provider-conformance';
import { agentRunStoreContracts, envelope } from './fixtures/agent-run-store-conformance';
import { manualClock } from './fixtures/manual-clock';

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
  const directory = await mkdtemp(join(tmpdir(), 'deuz-ops-'));
  cleanup.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
  );
  return join(directory, 'ops.sqlite');
}

describe.skipIf(!DatabaseSync)('SQLite ops store', () => {
  leaseProviderContracts('SQLite lease provider', async () => {
    const { clock, advance } = manualClock();
    const ops = createSqliteOpsStore({ path: ':memory:', clock });
    cleanup.push(() => ops.close());
    return { provider: ops.leases, advance, ttl: 1_000 };
  });

  agentRunStoreContracts('SQLite agent run store', () => {
    const ops = createSqliteOpsStore({ path: ':memory:' });
    cleanup.push(() => ops.close());
    return ops.agentRuns;
  });

  it('keeps two connections on one file consistent', async () => {
    const path = await tempFile();
    const { clock, advance } = manualClock();
    const a = createSqliteOpsStore({ path, clock });
    const b = createSqliteOpsStore({ path, clock });
    cleanup.push(() => a.close());
    cleanup.push(() => b.close());
    const lease = await a.leases.acquire({ key: 'swarm', owner: 'a', ttlMs: 1_000 });
    expect(lease).toMatchObject({ owner: 'a', token: 1 });
    expect(await b.leases.acquire({ key: 'swarm', owner: 'b', ttlMs: 1_000 })).toBeUndefined();
    expect(await b.leases.signal('swarm', 'cancel')).toBe(true);
    expect(await a.leases.renew(lease!, 1_000)).toMatchObject({ held: true, signals: ['cancel'] });
    await advance(5_000);
    expect(await b.leases.acquire({ key: 'swarm', owner: 'b', ttlMs: 1_000 })).toMatchObject({
      owner: 'b',
      token: 2,
    });
    expect(await a.leases.renew(lease!, 1_000)).toEqual({ held: false });

    await a.agentRuns.save(envelope('run', 1));
    expect(await b.agentRuns.load('run')).toEqual(envelope('run', 1));
    await b.agentRuns.save(envelope('run', 2, { modelSteps: 5 }));
    await expect(Promise.resolve(a.agentRuns.save(envelope('run', 2)))).rejects.toThrow(/revision/);
    expect(await a.agentRuns.load('run')).toMatchObject({ revision: 2, modelSteps: 5 });
  });

  it('refuses an unsupported ops schema version and a closed store', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec(
      'CREATE TABLE deuz_ops_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO deuz_ops_schema VALUES(1,9)',
    );
    const future = createSqliteOpsStore({ path: ':memory:', database: db });
    await expect(Promise.resolve(future.agentRuns.load('x'))).rejects.toThrow('Unsupported');
    const ops = createSqliteOpsStore({ path: ':memory:' });
    await ops.close();
    await expect(Promise.resolve(ops.agentRuns.load('x'))).rejects.toThrow('closed');
  });
});
