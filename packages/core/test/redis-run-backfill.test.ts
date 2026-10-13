/**
 * redis-run-backfill.test.ts (2.3) — the Redis ops store's listing index for
 * runs saved before it existed. Pre-release 2.3 builds wrote agent runs as
 * payload and revision hashes (plus the terminal set) with no listing entry;
 * the first `agentRuns.list` of a store such a build stamped indexes them, a
 * page at a time. The page is shrunk to three here, so paging is exercised on
 * a handful of runs (ioredis-mock spends milliseconds per command inside a
 * script).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentResult, AgentRunEnvelope } from '../src/types/agent-run';
import type { RedisScriptClient } from '../src/node/store-redis';

vi.mock('../src/node/redis-scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/node/redis-scripts')>()),
  BACKFILL_BATCH: 3,
}));

const { createRedisOpsStore } = await import('../src/node/ops-redis');
const { replyList } = await import('../src/node/redis-scripts');
const { envelope } = await import('./fixtures/agent-run-store-conformance');
const { mockRedisServer } = await import('./fixtures/redis-harness');

const T = '{deuz:ops}';
const usage = envelope('x', 1).usage;
const completed: AgentResult<unknown> = {
  runId: 'x',
  text: 'done',
  messages: [],
  usage,
  modelSteps: 1,
  status: 'completed',
  output: 'done',
};
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

/** A server holding what a pre-index build wrote: its schema stamp and runs without entries. */
function preIndexServer() {
  const server = mockRedisServer();
  const ready = server.redis.set(`${T}:schema`, '1');
  const legacy = async (value: AgentRunEnvelope, terminalAt?: number) => {
    await ready;
    await server.redis.hset(`${T}:run:payload`, value.runId, JSON.stringify(value));
    await server.redis.hset(`${T}:run:revision`, value.runId, String(value.revision ?? 0));
    if (terminalAt !== undefined)
      await server.redis.zadd(`${T}:run:terminal`, terminalAt, value.runId);
  };
  return { server, legacy };
}

/** A client that records each script's reply. */
function recording(client: RedisScriptClient) {
  const calls: { source: string; reply: unknown }[] = [];
  return {
    calls,
    client: {
      async eval(source: string, options: { keys: string[]; arguments: string[] }) {
        const reply = await client.eval(source, options);
        calls.push({ source, reply });
        return reply;
      },
    } satisfies RedisScriptClient,
  };
}
/** The scans that read a page: a scan of an indexed store answers nothing. */
const scans = (calls: { source: string; reply: unknown }[]) =>
  calls.filter((call) => call.source.includes("'HSCAN'") && replyList(call.reply).length > 0);

describe('Redis agent runs saved before the listing index', () => {
  it('are listed from the first listing on, a terminal run at its last save', async () => {
    const { server, legacy } = preIndexServer();
    const doneAt = server.now();
    await legacy(
      envelope('old-done', 2, { phase: 'terminal', scope: 'a', result: completed }),
      doneAt,
    );
    await legacy(envelope('old-running', 1));
    await legacy(envelope('old-waiting', 1, { result: suspended }));
    await legacy(envelope('old-pruned', 1, { phase: 'terminal' }), doneAt - 10);
    await legacy(envelope('old-saved', 1));
    await server.advance(60_000);
    const ops = createRedisOpsStore({ client: server.client });
    // This build saves one of them again and prunes another before anything lists.
    await ops.agentRuns.save(envelope('old-saved', 2));
    const savedAt = server.now();
    await server.advance(1);
    await ops.agentRuns.save(envelope('new', 1, { phase: 'finalizing' }));
    expect(await ops.agentRuns.prune(doneAt)).toBe(1);
    await server.advance(1);
    const listedAt = server.now();

    expect((await ops.agentRuns.list()).runs).toEqual([
      // Nothing records when these were last saved: they list as saved when indexed.
      {
        runId: 'old-waiting',
        scope: 'tenant',
        phase: 'running',
        revision: 1,
        status: 'suspended',
        updatedAt: listedAt,
      },
      { runId: 'old-running', scope: 'tenant', phase: 'running', revision: 1, updatedAt: listedAt },
      { runId: 'new', scope: 'tenant', phase: 'finalizing', revision: 1, updatedAt: listedAt - 1 },
      { runId: 'old-saved', scope: 'tenant', phase: 'running', revision: 2, updatedAt: savedAt },
      {
        runId: 'old-done',
        scope: 'a',
        phase: 'terminal',
        revision: 2,
        status: 'completed',
        updatedAt: doneAt,
      },
    ]);
    expect(await ops.agentRuns.list({ phases: ['terminal'], scope: 'a' })).toMatchObject({
      runs: [{ runId: 'old-done' }],
    });
    // Indexed runs then move, and leave, like any other.
    await ops.agentRuns.save(envelope('old-running', 2, { phase: 'terminal', result: completed }));
    expect(await ops.agentRuns.list({ phases: ['running'] })).toMatchObject({
      runs: [{ runId: 'old-waiting' }, { runId: 'old-saved' }],
    });
    await server.advance(1);
    expect(await ops.agentRuns.prune(server.now())).toBe(2);
    expect((await ops.agentRuns.list()).runs.map((run) => run.runId)).toEqual([
      'old-waiting',
      'new',
      'old-saved',
    ]);
  });

  it('indexes a page per script, and once per store', async () => {
    const { server, legacy } = preIndexServer();
    for (let index = 0; index < 10; index++) await legacy(envelope(`r${index}`, 1));
    const first = recording(server.client);
    const ops = createRedisOpsStore({ client: first.client });
    expect((await ops.agentRuns.list({ limit: 1000 })).runs).toHaveLength(10);
    const pages = scans(first.calls);
    expect(pages.length).toBeGreaterThan(1);
    // A scan answers its cursor, then three values per run it found unindexed.
    for (const page of pages) expect(replyList(page.reply).length).toBeLessThanOrEqual(1 + 3 * 3);
    expect(await ops.agentRuns.list({ limit: 1 })).toMatchObject({ runs: [{ runId: 'r9' }] });
    expect(scans(first.calls)).toHaveLength(pages.length);

    // Another process, or a restart, finds the store indexed.
    const second = recording(server.client);
    const again = createRedisOpsStore({ client: second.client });
    expect((await again.agentRuns.list({ limit: 1000 })).runs).toHaveLength(10);
    expect(scans(second.calls)).toEqual([]);
  });

  it('lets a save or a prune between its scan and its indexing win', async () => {
    const { server, legacy } = preIndexServer();
    const doneAt = server.now();
    await legacy(envelope('saved', 1));
    await legacy(envelope('pruned', 1, { phase: 'terminal' }), doneAt);
    await legacy(envelope('kept', 1));
    await server.advance(10);
    let interleaved = false;
    const ops = createRedisOpsStore({
      client: {
        async eval(source, options) {
          const reply = await server.client.eval(source, options);
          if (!interleaved && source.includes("'HSCAN'") && replyList(reply).length > 1) {
            // Another process writes after this page was read, before it is indexed.
            interleaved = true;
            await ops.agentRuns.save(envelope('saved', 2, { phase: 'finalizing' }));
            expect(await ops.agentRuns.prune(doneAt + 1)).toBe(1);
          }
          return reply;
        },
      },
    });
    // Both were written in this millisecond: the save, and the indexing of 'kept'.
    expect((await ops.agentRuns.list()).runs).toEqual([
      {
        runId: 'saved',
        scope: 'tenant',
        phase: 'finalizing',
        revision: 2,
        updatedAt: server.now(),
      },
      { runId: 'kept', scope: 'tenant', phase: 'running', revision: 1, updatedAt: server.now() },
    ]);
    expect(interleaved).toBe(true);
    let entries = 0;
    for (const key of await server.redis.keys(`${T}:run:ix*`))
      entries += await server.redis.zcard(key);
    expect(entries).toBe(8);
  });

  it('never scans a store this build created', async () => {
    const server = mockRedisServer();
    const recorded = recording(server.client);
    const ops = createRedisOpsStore({ client: recorded.client });
    await ops.agentRuns.save(envelope('r', 1));
    expect(await ops.agentRuns.list()).toMatchObject({ runs: [{ runId: 'r' }] });
    expect(scans(recorded.calls)).toEqual([]);
  });

  it('retries a backfill that failed on the next listing', async () => {
    const { server, legacy } = preIndexServer();
    await legacy(envelope('a', 1));
    let fail = true;
    const ops = createRedisOpsStore({
      client: {
        async eval(source, options) {
          if (fail && source.includes("'HSCAN'")) throw new Error('connection reset');
          return server.client.eval(source, options);
        },
      },
    });
    await expect(ops.agentRuns.list()).rejects.toThrow('connection reset');
    fail = false;
    expect(await ops.agentRuns.list()).toMatchObject({ runs: [{ runId: 'a' }] });
  });
});
