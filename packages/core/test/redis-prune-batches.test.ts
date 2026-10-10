/**
 * redis-prune-batches.test.ts — retention on the 2.3 Redis stores runs in
 * batches, so a backlog never holds the server in one long script. The batch
 * size is shrunk to four here, so the paging is exercised on a handful of
 * entries (ioredis-mock spends milliseconds per command inside a script).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/node/redis-scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/node/redis-scripts')>()),
  PRUNE_BATCH: 4,
}));

const { createRedisOpsStore } = await import('../src/node/ops-redis');
const { envelope } = await import('./fixtures/agent-run-store-conformance');
const { mockRedisServer } = await import('./fixtures/redis-harness');

describe('Redis ops store retention in batches of four', () => {
  it('pages past released leases that still owe a cancel', async () => {
    const server = mockRedisServer();
    const ops = createRedisOpsStore({ client: server.client });
    const owing = new Set(['k00', 'k01', 'k05']);
    for (let index = 0; index < 11; index++) {
      const key = `k${String(index).padStart(2, '0')}`;
      const lease = (await ops.leases.acquire({ key, owner: 'a', ttlMs: 1_000 }))!;
      if (owing.has(key)) await ops.leases.signal(key, 'cancel');
      await ops.leases.release(lease);
    }
    // Released keys all sit at 0 in the expiry range, in key order: the kept
    // ones open the first batch and sit inside the second.
    expect(await ops.leases.prune(server.now())).toBe(8);
    expect((await server.redis.zrange('{deuz:ops}:lease:expiry', 0, -1)).sort()).toEqual([
      ...owing,
    ]);
    expect(await ops.leases.prune(server.now())).toBe(0);
  });

  it('prunes claims and terminal runs to the last short batch', async () => {
    const server = mockRedisServer();
    const ops = createRedisOpsStore({ client: server.client });
    for (let index = 0; index < 9; index++) {
      expect(await ops.claims(`c${index}`)).toBe(true);
      await ops.agentRuns.save(envelope(`r${index}`, 1, { phase: 'terminal' }));
    }
    await server.advance(1);
    expect(await ops.claims.prune(server.now())).toBe(9);
    expect(await ops.agentRuns.prune(server.now())).toBe(9);
    expect(await server.redis.zcard('{deuz:ops}:claims')).toBe(0);
    expect(await server.redis.hlen('{deuz:ops}:run:payload')).toBe(0);
  });
});
