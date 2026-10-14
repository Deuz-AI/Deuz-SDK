/**
 * agent-run-list-redis.test.ts (2.3) — native run discovery on the Redis ops
 * store. `agentRuns.list` pages through sorted-set indexes that the save and
 * prune scripts keep, with each save's time read from the server's `TIME`.
 *
 * The shared listing contract runs on ioredis-mock, whose clock stands still
 * between advances (fixtures/redis-harness.ts), so saves can share a
 * millisecond, and on a real Redis when DEUZ_TEST_REDIS_URL names one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resumeAgent, runAgent } from '../src/agent-run';
import { createRedisOpsStore } from '../src/node/ops-redis';
import { hexUnits } from '../src/node/redis-scripts';
import { findStaleAgentRuns } from '../src/ops';
import { createMockModel } from '../src/testing';
import type {
  AgentResult,
  AgentRunEnvelope,
  AgentRunListQuery,
  AgentRunStore,
} from '../src/types/agent-run';
import type { Clock } from '../src/types/deps';
import { agentRunListContracts, envelope } from './fixtures/agent-run-store-conformance';
import { liveRedisServer, liveRedisUrl, mockRedisServer, wait } from './fixtures/redis-harness';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const fresh = () => {
  const server = mockRedisServer();
  return { server, ops: createRedisOpsStore({ client: server.client }) };
};
/** The server's clock, as findStaleAgentRuns reads it. */
const serverClock = (now: () => number): Clock => ({ now, setTimeout: () => () => {} });
const ids = (page: { runs: { runId: string }[] }) => page.runs.map((run) => run.runId);
const T = '{deuz:ops}';

const usage = envelope('x', 1).usage;
const suspended: AgentResult<unknown> = {
  runId: 'x',
  text: '',
  messages: [],
  usage,
  modelSteps: 1,
  status: 'suspended',
  pendingApprovals: [],
  pendingClientCalls: [],
};
const completed: AgentResult<unknown> = {
  runId: 'x',
  text: 'done',
  messages: [],
  usage,
  modelSteps: 1,
  status: 'completed',
  output: 'done',
};

agentRunListContracts('Redis agent run listing (ioredis-mock, server time)', async () => {
  const { server, ops } = fresh();
  return { store: ops.agentRuns, advance: server.advance, now: server.now, frozen: true };
});

describe('Redis agent run listing', () => {
  it('orders runs saved in one millisecond by run ID, as JavaScript compares them', async () => {
    const { ops } = fresh();
    // UTF-8 byte order would put '😀' after '￿'; a run ID that is a prefix
    // of another comes first; '-' must not read as a separator.
    const runIds = ['b', 'a', 'a\u0000', 'ab', 'a-b', '-', 'Z', 'é', '😀', '￿', '0'];
    for (const runId of runIds) await ops.agentRuns.save(envelope(runId, 1));
    const expected = [...runIds].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
    expect(ids(await ops.agentRuns.list())).toEqual(expected);
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await ops.agentRuns.list({ limit, ...(cursor ? { cursor } : {}) });
        seen.push(...ids(page));
        cursor = page.cursor;
      } while (cursor && seen.length <= runIds.length);
      expect(seen, `limit ${limit}`).toEqual(expected);
    }
  });

  it('keeps each run in the indexes of its phase and scope as it moves', async () => {
    const { server, ops } = fresh();
    await ops.agentRuns.save(envelope('r', 1, { scope: 'a' }));
    await server.advance(1);
    await ops.agentRuns.save(envelope('r', 2, { phase: 'finalizing', scope: 'a' }));
    await server.advance(1);
    await ops.agentRuns.save(
      envelope('r', 3, { phase: 'terminal', scope: 'b', result: completed }),
    );
    for (const query of [
      { phases: ['running'] },
      { phases: ['running', 'finalizing'] },
      { scope: 'a' },
      { phases: ['finalizing'], scope: 'a' },
      { phases: ['terminal'], scope: 'a' },
    ] as AgentRunListQuery[])
      expect(await ops.agentRuns.list(query), JSON.stringify(query)).toEqual({ runs: [] });
    const summary = {
      runId: 'r',
      scope: 'b',
      phase: 'terminal',
      revision: 3,
      status: 'completed',
      updatedAt: server.now(),
    };
    for (const query of [
      {},
      { phases: ['terminal'] },
      { phases: ['finalizing', 'terminal'] },
      { scope: 'b' },
      { phases: ['terminal'], scope: 'b' },
      { phases: ['running', 'terminal'], scope: 'b' },
    ] as AgentRunListQuery[])
      expect(await ops.agentRuns.list(query), JSON.stringify(query)).toEqual({ runs: [summary] });
    // Four index entries (every run, its phase, its scope, both): none left behind.
    let entries = 0;
    for (const key of await server.redis.keys(`${T}:run:ix*`))
      entries += await server.redis.zcard(key);
    expect(entries).toBe(4);
  });

  it('drops a pruned run from every index', async () => {
    const { server, ops } = fresh();
    await ops.agentRuns.save(envelope('done', 1, { phase: 'terminal', scope: 'a' }));
    await ops.agentRuns.save(envelope('live', 1, { scope: 'a' }));
    await server.advance(1);
    expect(await ops.agentRuns.prune(server.now())).toBe(1);
    expect(ids(await ops.agentRuns.list())).toEqual(['live']);
    expect(ids(await ops.agentRuns.list({ scope: 'a' }))).toEqual(['live']);
    expect(await ops.agentRuns.list({ phases: ['terminal'] })).toEqual({ runs: [] });
    expect(await ops.agentRuns.list({ phases: ['terminal'], scope: 'a' })).toEqual({ runs: [] });
    const left: string[] = [];
    for (const key of await server.redis.keys(`${T}:run:ix*`))
      left.push(...(await server.redis.zrange(key, 0, -1)));
    expect(left).toHaveLength(4);
    for (const member of left) expect(member).toContain(hexUnits('live'));
    // A pruned run saved again under its ID lists once, as new.
    await ops.agentRuns.save(envelope('done', 1));
    expect(ids(await ops.agentRuns.list())).toEqual(['done', 'live']);
  });

  it('reads cut-offs and cursors between whole milliseconds and far outside the clock', async () => {
    const { server, ops } = fresh();
    const at = server.now();
    await ops.agentRuns.save(envelope('x', 1));
    await ops.agentRuns.save(envelope('y', 1));
    await server.advance(1);
    await ops.agentRuns.save(envelope('z', 1));
    const list = async (query: AgentRunListQuery) => ids(await ops.agentRuns.list(query));
    const cursor = (time: number, runId: string) => JSON.stringify([time, runId]);
    expect(await list({ updatedBefore: at + 0.5 })).toEqual(['y', 'x']);
    expect(await list({ updatedBefore: at + 1 })).toEqual(['y', 'x']);
    expect(await list({ updatedBefore: at })).toEqual([]);
    expect(await list({ updatedBefore: -5 })).toEqual([]);
    expect(await list({ updatedBefore: 1e300 })).toEqual(['z', 'y', 'x']);
    // A cursor is a position in the order, whichever clock made it.
    expect(await list({ cursor: cursor(at, 'y') })).toEqual(['x']);
    expect(await list({ cursor: cursor(at, 'x') })).toEqual([]);
    expect(await list({ cursor: cursor(at + 1, '') })).toEqual(['y', 'x']);
    expect(await list({ cursor: cursor(at + 0.5, 'zzz') })).toEqual(['y', 'x']);
    expect(await list({ cursor: cursor(-1, 'x') })).toEqual([]);
    expect(await list({ cursor: cursor(1e300, '') })).toEqual(['z', 'y', 'x']);
    // Both bounds: the tighter one applies.
    expect(await list({ cursor: cursor(at + 1, 'zz'), updatedBefore: at + 1 })).toEqual(['y', 'x']);
    expect(await list({ cursor: cursor(at, 'y'), updatedBefore: at + 1 })).toEqual(['x']);
  });

  it('lists the status the stored result records, and none for an unknown one', async () => {
    const { ops } = fresh();
    await ops.agentRuns.save(envelope('s', 1, { result: suspended }));
    await ops.agentRuns.save(
      envelope('odd', 1, { result: { ...completed, status: 'paused' } as unknown as AgentResult }),
    );
    const { runs } = await ops.agentRuns.list();
    expect(runs.map(({ runId, status }) => ({ runId, status }))).toEqual([
      { runId: 's', status: 'suspended' },
      { runId: 'odd', status: undefined },
    ]);
    expect(runs[1]).not.toHaveProperty('status');
  });

  it('refuses to list a run whose envelope records an unknown phase, as the SQL stores do', async () => {
    const { ops } = fresh();
    await ops.agentRuns.save(envelope('odd', 1, { phase: 'Paused!' as 'running' }));
    await expect(ops.agentRuns.list()).rejects.toThrow(/odd has an unknown phase/);
    // The run stays loadable and is listed again once a save records a known phase.
    expect(await ops.agentRuns.load('odd')).toMatchObject({ phase: 'Paused!' });
    await ops.agentRuns.save(envelope('odd', 2));
    expect(ids(await ops.agentRuns.list())).toEqual(['odd']);
  });

  it('leaves a run in an unknown phase out of a listing that names every phase, as the SQL stores do', async () => {
    const { ops } = fresh();
    const every = ['running', 'finalizing', 'terminal'] as const;
    await ops.agentRuns.save(envelope('ok', 1));
    await ops.agentRuns.save(envelope('odd', 1, { phase: 'paused' as 'running' }));
    await ops.agentRuns.save(envelope('near', 1, { phase: 'paused' as 'running', scope: 'other' }));
    // Every known phase, named in one list or split over two, is the same filter.
    expect(ids(await ops.agentRuns.list({ phases: ['running', 'finalizing'] }))).toEqual(['ok']);
    expect(ids(await ops.agentRuns.list({ phases: [...every] }))).toEqual(['ok']);
    expect(ids(await ops.agentRuns.list({ phases: [...every], scope: 'tenant' }))).toEqual(['ok']);
    expect(ids(await ops.agentRuns.list({ phases: [...every], scope: 'other' }))).toEqual([]);
    // Without a phase filter the listing still refuses the unknown phase.
    await expect(ops.agentRuns.list()).rejects.toThrow(/has an unknown phase/);
  });
});

describe('findStaleAgentRuns on the Redis ops store', () => {
  it('finds runs whose last save on the server clock is old', async () => {
    const { server, ops } = fresh();
    const clock = serverClock(server.now);
    await ops.agentRuns.save(envelope('crashed', 1));
    await ops.agentRuns.save(envelope('finalizing', 1, { phase: 'finalizing', scope: 'other' }));
    await ops.agentRuns.save(envelope('waiting', 1, { result: suspended }));
    await ops.agentRuns.save(envelope('done', 1, { phase: 'terminal', result: completed }));
    await server.advance(90_000);
    await ops.agentRuns.save(envelope('live', 1));
    // Saved in one millisecond: run ID descending.
    expect(ids({ runs: await findStaleAgentRuns(ops.agentRuns, { clock }) })).toEqual([
      'finalizing',
      'crashed',
    ]);
    expect(
      ids({ runs: await findStaleAgentRuns(ops.agentRuns, { clock, includeSuspended: true }) }),
    ).toEqual(['waiting', 'finalizing', 'crashed']);
    expect(
      ids({ runs: await findStaleAgentRuns(ops.agentRuns, { clock, scope: 'other' }) }),
    ).toEqual(['finalizing']);
    expect(await findStaleAgentRuns(ops.agentRuns, { clock, staleMs: 120_000 })).toEqual([]);
  });

  it('finds a native run whose executor died, which a leased executor then finishes', async () => {
    const { server, ops } = fresh();
    const clock = serverClock(server.now);
    // The first executor's process dies after its first save: every later write fails.
    let saves = 0;
    const dying: AgentRunStore = {
      load: ops.agentRuns.load,
      save: async (value: AgentRunEnvelope) => {
        if (++saves > 1) throw new Error('process died');
        await ops.agentRuns.save(value);
      },
    };
    const session = { runId: 'job-1', scope: 'tenant' };
    const first = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'Do the job.',
      session: { ...session, store: dying },
    });
    expect(first.status).toBe('failed');
    const savedAt = server.now();

    await server.advance(5 * 60_000);
    expect(await findStaleAgentRuns(ops.agentRuns, { clock })).toEqual([
      { runId: 'job-1', scope: 'tenant', phase: 'running', revision: 1, updatedAt: savedAt },
    ]);
    const resumed = await resumeAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      session: { ...session, store: ops.agentRuns },
      lease: { provider: ops.leases, owner: 'worker-2' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(await findStaleAgentRuns(ops.agentRuns, { clock })).toEqual([]);
    expect(await ops.agentRuns.list({ phases: ['terminal'] })).toMatchObject({
      runs: [{ runId: 'job-1', status: 'completed' }],
    });
  });
});

// A network round trip per script, and real waits for server time.
if (liveRedisUrl)
  vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_HOOK_TIMEOUT_MS });

describe.skipIf(!liveRedisUrl)('Redis agent run listing on a live server', () => {
  let server: Awaited<ReturnType<typeof liveRedisServer>>;
  beforeAll(async () => {
    server = await liveRedisServer(liveRedisUrl!);
  });
  afterAll(() => server?.close());
  const live = () => createRedisOpsStore({ client: server.client, prefix: server.prefix() });
  const now = () => Date.now() + server.skew;

  agentRunListContracts('agent run listing (live)', async () => ({
    store: live().agentRuns,
    advance: wait,
    now,
    // `now` estimates the server clock across a network round trip.
    slack: 25,
  }));

  it('indexes the runs a pre-index build saved on the first listing', async () => {
    // The layout a pre-release 2.3 build wrote: a stamped schema, runs without entries.
    const prefix = server.prefix();
    const t = `{${prefix}:ops}`;
    const doneAt = Math.floor(now()) - 60_000;
    const seeded = [
      envelope('old-done', 2, { phase: 'terminal', result: completed }),
      envelope('old-waiting', 1, { result: suspended }),
      ...Array.from({ length: 150 }, (_, index) => envelope(`old-${index}`, 1)),
    ];
    await server.client.set(`${t}:schema`, '1');
    for (const value of seeded) {
      await server.client.hSet(`${t}:run:payload`, value.runId, JSON.stringify(value));
      await server.client.hSet(`${t}:run:revision`, value.runId, String(value.revision));
    }
    await server.client.zAdd(`${t}:run:terminal`, { score: doneAt, value: 'old-done' });
    const before = now();
    const ops = createRedisOpsStore({ client: server.client, prefix });
    const { runs } = await ops.agentRuns.list({ limit: 1000 });
    expect(runs).toHaveLength(seeded.length);
    expect(runs.at(-1)).toEqual({
      runId: 'old-done',
      scope: 'tenant',
      phase: 'terminal',
      revision: 2,
      status: 'completed',
      updatedAt: doneAt,
    });
    for (const run of runs.slice(0, -1)) {
      expect(run.updatedAt).toBeGreaterThanOrEqual(before - 25);
      expect(run.updatedAt).toBeLessThanOrEqual(now() + 25);
    }
    expect(runs.find((run) => run.runId === 'old-waiting')).toMatchObject({ status: 'suspended' });
    const running = await ops.agentRuns.list({ phases: ['running'], limit: 1000 });
    expect(running.runs).toHaveLength(seeded.length - 1);
    expect(await server.client.get(`${t}:run:indexed`)).toBe('1');
  });

  it('finds stale runs on the server clock', async () => {
    const ops = live();
    await ops.agentRuns.save(envelope('crashed', 1));
    await ops.agentRuns.save(envelope('waiting', 1, { result: suspended }));
    await wait(300);
    await ops.agentRuns.save(envelope('live', 1));
    const clock = serverClock(now);
    expect(ids({ runs: await findStaleAgentRuns(ops.agentRuns, { clock, staleMs: 150 }) })).toEqual(
      ['crashed'],
    );
  });
});
