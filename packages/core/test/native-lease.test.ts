/**
 * native-lease.test.ts (2.3) — runAgent's `lease` option: a LeaseProvider
 * claim, so two processes cannot drive one native run. Each "process" here is
 * a separate wrapper around one store (the in-process claim is per store
 * object) sharing one lease provider; time is a manual clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { agentRunLeaseKey, createInMemoryLeaseProvider } from '../src/ops';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createDeferred } from '../src/internal/async-iter';
import type { AgentRunEnvelope, AgentRunStore, AgentToolSet } from '../src/types/agent-run';
import type { LeaseProvider } from '../src/types/lease';
import { manualClock } from './fixtures/manual-clock';

/** A mock model that counts its calls. */
function counted(responses: Parameters<typeof createMockModel>[0]['responses']) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  return { model: attachConfig({ ...base }, { ...config, fetch }), fetch };
}

/** Another process's view of the same store. */
const processView = (store: AgentRunStore): AgentRunStore => ({
  load: (runId) => store.load(runId),
  save: (envelope) => store.save(envelope),
});

/** A tool that runs until the test releases it or the run is aborted. */
function parkedTool() {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const tools: AgentToolSet = {
    work: {
      description: 'Long work.',
      parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        entered.resolve();
        await new Promise<void>((resolve, reject) => {
          void released.promise.then(() => resolve());
          ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        return 'worked';
      },
    },
  };
  return { tools, entered: entered.promise, release: () => released.resolve() };
}

const toolThenDone = [{ toolCalls: [{ toolName: 'work', args: {} }] }, { text: 'done' }];

function setup() {
  const time = manualClock(0);
  const leases = createInMemoryLeaseProvider({ clock: time.clock });
  const store = createInMemoryAgentRunStore({ clock: time.clock });
  const session = { runId: 'job', scope: 'tenant' };
  const key = agentRunLeaseKey(session);
  return { ...time, leases, store, session, key };
}

/** A run whose first executor died after its first save: phase running, revision 1. */
async function crashedRun(store: AgentRunStore, session: { runId: string; scope: string }) {
  let saves = 0;
  const dying: AgentRunStore = {
    load: (runId) => store.load(runId),
    save: async (value: AgentRunEnvelope) => {
      if (++saves > 1) throw new Error('process died');
      await store.save(value);
    },
  };
  const result = await runAgent({
    model: createMockModel({ responses: [{ text: 'done' }] }),
    prompt: 'Do the job.',
    session: { ...session, store: dying },
  });
  expect(result.status).toBe('failed');
  expect(await store.load(session.runId)).toMatchObject({ phase: 'running', revision: 1 });
}

describe('runAgent lease (2.3)', () => {
  it('holds the run lease while it drives the run and releases it at the end', async () => {
    const { leases, store, session, key, clock } = setup();
    const parked = parkedTool();
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a' },
      deps: { clock },
    });
    await parked.entered;
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 1_000 })).toBeUndefined();
    parked.release();
    expect(await run).toMatchObject({ status: 'completed', output: 'done' });
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 1_000 })).toMatchObject({
      owner: 'b',
      token: 2,
    });
  });

  it('refuses a second process while the first one drives the run', async () => {
    const { leases, store, session, clock } = setup();
    const parked = parkedTool();
    const first = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a' },
      deps: { clock },
    });
    await parked.entered;
    const revision = (await store.load('job'))!.revision;
    const second = counted([{ text: 'stolen' }]);
    for (const attempt of [
      () =>
        resumeAgent({
          model: second.model,
          tools: parked.tools,
          session: { ...session, store: processView(store) },
          lease: { provider: leases, owner: 'b' },
          deps: { clock },
        }),
      () =>
        runAgent({
          model: second.model,
          prompt: 'Work.',
          session: { ...session, store: processView(store) },
          lease: { provider: leases, owner: 'b' },
          deps: { clock },
        }),
    ])
      expect(await attempt()).toMatchObject({
        status: 'failed',
        error: { name: 'AgentRunLeaseError', code: 'lease_held' },
      });
    // Nothing was read into a model or written.
    expect(second.fetch).not.toHaveBeenCalled();
    expect((await store.load('job'))!.revision).toBe(revision);
    parked.release();
    expect(await first).toMatchObject({ status: 'completed' });
  });

  it('renews the lease every ttlMs / 3 while a step outlives the lease', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const renew = vi.spyOn(leases, 'renew');
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    await advance(750);
    // Two and a half TTLs later, the executor still holds the run.
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 300 })).toBeUndefined();
    // One renewal collects the queued signals, then one every 100 ms.
    expect(renew).toHaveBeenCalledTimes(8);
    parked.release();
    expect(await run).toMatchObject({ status: 'completed' });
  });

  it('stops with reason cancelled on a cancel from another process, and acknowledges it once recorded', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    expect(await leases.signal(key, 'cancel')).toBe(true);
    await advance(100);
    const result = await run;
    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(await store.load('job')).toMatchObject({
      phase: 'terminal',
      result: { status: 'stopped', reason: 'cancelled' },
    });
    // Recorded, so acknowledged: the next holder of the key finds no cancel.
    const next = (await leases.acquire({ key, owner: 'b', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({
      held: true,
      signals: [],
    });
  });

  it('applies a cancel its dead holder never read before any model call on resume', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    await crashedRun(store, session);
    // The executor that held the lease died before reading the cancel.
    await leases.acquire({ key, owner: 'ghost', ttlMs: 300 });
    expect(await leases.signal(key, 'cancel')).toBe(true);
    await advance(1_000);
    const { model, fetch } = counted([{ text: 'done' }]);
    const result = await resumeAgent({
      model,
      session: { ...session, store },
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
      deps: { clock },
    });
    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.load('job')).toMatchObject({
      phase: 'terminal',
      result: { status: 'stopped', reason: 'cancelled' },
    });
    const next = (await leases.acquire({ key, owner: 'c', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({
      signals: [],
    });
  });

  it('starts a new run clean of a cancel queued for the run ID before it', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    await leases.acquire({ key, owner: 'ghost', ttlMs: 300 });
    await leases.signal(key, 'cancel');
    await advance(1_000);
    const result = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'Do the job.',
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    const next = (await leases.acquire({ key, owner: 'b', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({
      signals: [],
    });
  });

  it('drops a cancel that reaches a run already ended', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    expect(
      await runAgent({
        model: createMockModel({ responses: [{ text: 'done' }] }),
        prompt: 'Do the job.',
        session: { ...session, store },
        lease: { provider: leases, owner: 'a', ttlMs: 300 },
        deps: { clock },
      }),
    ).toMatchObject({ status: 'completed' });
    await leases.acquire({ key, owner: 'ghost', ttlMs: 300 });
    await leases.signal(key, 'cancel');
    await advance(1_000);
    const { model, fetch } = counted([{ text: 'again' }]);
    expect(
      await resumeAgent({
        model,
        session: { ...session, store },
        lease: { provider: leases, owner: 'b', ttlMs: 300 },
        deps: { clock },
      }),
    ).toMatchObject({ status: 'completed', output: 'done' });
    expect(fetch).not.toHaveBeenCalled();
    const next = (await leases.acquire({ key, owner: 'c', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({
      signals: [],
    });
  });

  it('keeps a cancel queued for the next executor when the run could not record it', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    let refuse = false;
    const flaky: AgentRunStore = {
      load: (runId) => store.load(runId),
      save: async (value) => {
        if (refuse) throw new Error('database down');
        await store.save(value);
      },
    };
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store: flaky },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    refuse = true;
    await leases.signal(key, 'cancel');
    await advance(100);
    expect(await run).toMatchObject({ status: 'failed' });
    expect((await store.load('job'))!.phase).toBe('running');
    // The next executor reads the cancel and records it. (The interrupted
    // call is reconciled first: a resume stops for reconciliation before it
    // admits the run, and the cancel stays queued meanwhile.)
    const { model, fetch } = counted([{ text: 'done' }]);
    const resume = () =>
      resumeAgent({
        model,
        tools: parked.tools,
        session: { ...session, store },
        lease: { provider: leases, owner: 'b', ttlMs: 300 },
        deps: { clock },
      });
    expect(await resume()).toMatchObject({
      status: 'stopped',
      reason: 'tool-reconciliation-required',
    });
    expect(
      await resumeAgent({
        model,
        tools: parked.tools,
        session: { ...session, store },
        lease: { provider: leases, owner: 'b', ttlMs: 300 },
        retryToolCallIds: ['call_1'],
        deps: { clock },
      }),
    ).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('puts back a cancel a provider without ack consumed when the run could not record it', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    // A 2.2-style provider: a renewal removes every signal it delivers.
    const plain: LeaseProvider = {
      acquire: (request) => leases.acquire(request),
      renew: (lease, ttlMs) => leases.renew(lease, ttlMs),
      release: (lease) => leases.release(lease),
      signal: (k, signal) => leases.signal(k, signal),
    };
    const parked = parkedTool();
    let refuse = false;
    const flaky: AgentRunStore = {
      load: (runId) => store.load(runId),
      save: async (value) => {
        if (refuse) throw new Error('database down');
        await store.save(value);
      },
    };
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store: flaky },
      lease: { provider: plain, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    refuse = true;
    await leases.signal(key, 'cancel');
    await advance(100);
    expect(await run).toMatchObject({ status: 'failed' });
    const { model, fetch } = counted([{ text: 'done' }]);
    expect(
      await resumeAgent({
        model,
        tools: parked.tools,
        session: { ...session, store },
        lease: { provider: plain, owner: 'b', ttlMs: 300 },
        retryToolCallIds: ['call_1'],
        deps: { clock },
      }),
    ).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops writing once the lease is lost and reports lease_lost', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    let down = false;
    const outage: LeaseProvider = {
      ...leases,
      acquire: (request) => leases.acquire(request),
      renew: async (lease, ttlMs, options) => {
        if (down) throw new Error('lease provider down');
        return leases.renew(lease, ttlMs, options);
      },
    };
    const parked = parkedTool();
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: outage, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    const before = await store.load('job');
    down = true;
    // An outage is survivable until the lease could have lapsed.
    await advance(200);
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 300 })).toBeUndefined();
    await advance(200);
    const result = await run;
    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'AgentRunLeaseError', code: 'lease_lost' },
    });
    // The run stays as the last executor left it, for the next one.
    expect(await store.load('job')).toEqual(before);
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 300 })).toMatchObject({ owner: 'b' });
  });

  it('notices a lease another executor took over at its next renewal', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    let stall: Promise<void> | undefined;
    const slow: LeaseProvider = {
      ...leases,
      renew: async (lease, ttlMs, options) => {
        if (stall) await stall;
        return leases.renew(lease, ttlMs, options);
      },
    };
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: slow, owner: 'a', ttlMs: 3_000 },
      deps: { clock },
    });
    await parked.entered;
    const before = await store.load('job');
    // The executor's renewal hangs (a paused process), its lease lapses, and
    // another process takes the run over.
    const gate = createDeferred<void>();
    stall = gate.promise;
    await advance(4_000);
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 3_000 })).toMatchObject({ owner: 'b' });
    stall = undefined;
    gate.resolve();
    await advance(1);
    expect(await run).toMatchObject({ status: 'failed', error: { code: 'lease_lost' } });
    expect(await store.load('job')).toEqual(before);
  });

  it('works with a durable lease provider and store', async () => {
    const { clock } = manualClock(0);
    const ops = createSqliteOpsStore({ path: ':memory:', clock });
    try {
      const session = { runId: 'durable', scope: 'tenant', store: ops.agentRuns };
      expect(
        await runAgent({
          model: createMockModel({ responses: [{ text: 'done' }] }),
          prompt: 'Do the job.',
          session,
          lease: { provider: ops.leases },
          deps: { clock },
        }),
      ).toMatchObject({ status: 'completed' });
      expect(
        await ops.leases.acquire({ key: agentRunLeaseKey(session), owner: 'x', ttlMs: 1_000 }),
      ).toMatchObject({ token: 2 });
    } finally {
      await ops.close();
    }
  });

  it('rejects a lease without a session and a malformed lease', async () => {
    const { leases, store, session } = setup();
    const model = createMockModel({ responses: [{ text: 'done' }] });
    expect(await runAgent({ model, prompt: 'x', lease: { provider: leases } })).toMatchObject({
      status: 'failed',
      error: { name: 'TypeError', message: 'A native run lease requires a session.' },
    });
    const malformed: unknown[] = [
      { provider: leases, ttlMs: 2 },
      { provider: leases, ttlMs: 1.5 },
      { provider: leases, owner: '' },
      { provider: {} },
    ];
    for (const [index, lease] of malformed.entries())
      expect(
        await runAgent({
          model,
          prompt: 'x',
          session: { ...session, store, runId: `bad-${index}` },
          lease: lease as never,
        }),
        JSON.stringify(lease),
      ).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(await store.list()).toEqual({ runs: [] });
  });

  it('names the lease key after the scope and run ID', () => {
    expect(agentRunLeaseKey({ scope: 'tenant', runId: 'job' })).toBe('agent:["tenant","job"]');
  });
});
