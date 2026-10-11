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
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { manualClock } from './fixtures/manual-clock';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}

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

/**
 * A store whose first read waits for the test, as a round trip to a database
 * does: runAgent's check that the run is new, resumeAgent's load.
 */
function slowFirstRead(store: AgentRunStore) {
  const reading = createDeferred<void>();
  const answered = createDeferred<void>();
  let first = true;
  const view: AgentRunStore = {
    load: async (runId) => {
      if (first) {
        first = false;
        reading.resolve();
        await answered.promise;
      }
      return store.load(runId);
    },
    save: (envelope) => store.save(envelope),
  };
  return { store: view, reading: reading.promise, answer: () => answered.resolve() };
}

/** A 2.2-style view of a provider: a renewal removes every signal it delivers. */
const withoutAck = (leases: LeaseProvider): LeaseProvider => ({
  acquire: (request) => leases.acquire(request),
  renew: (lease, ttlMs) => leases.renew(lease, ttlMs),
  release: (lease) => leases.release(lease),
  signal: (k, signal) => leases.signal(k, signal),
});

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

  it('stops a new run cancelled while it checks that the run is new', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const slow = slowFirstRead(store);
    const parked = parkedTool();
    const run = runAgent({
      model: createMockModel({ responses: toolThenDone }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store: slow.store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await slow.reading;
    // Another process cancels the run it just started: the key is held, so
    // the cancel is accepted for the run.
    expect(await leases.signal(key, 'cancel')).toBe(true);
    slow.answer();
    await parked.entered;
    // The next renewal, one heartbeat later, stops it.
    await advance(100);
    parked.release();
    expect(await run).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(await store.load('job')).toMatchObject({
      phase: 'terminal',
      result: { status: 'stopped', reason: 'cancelled' },
    });
    const next = (await leases.acquire({ key, owner: 'b', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({ signals: [] });
  });

  it('stops a new run cancelled during a heartbeat before its first read returned', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const slow = slowFirstRead(store);
    const { model, fetch } = counted([{ text: 'done' }]);
    const run = runAgent({
      model,
      prompt: 'Work.',
      session: { ...session, store: slow.store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await slow.reading;
    expect(await leases.signal(key, 'cancel')).toBe(true);
    // The heartbeat delivers it while the run still reads the store.
    await advance(100);
    slow.answer();
    expect(await run).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.load('job')).toMatchObject({
      phase: 'terminal',
      result: { status: 'stopped', reason: 'cancelled' },
    });
  });

  it('renews the lease from the claim on, through a slow first read of the store', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const slow = slowFirstRead(store);
    const run = runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'Work.',
      session: { ...session, store: slow.store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await slow.reading;
    // The read outlasts the lease: the heartbeat keeps it.
    await advance(1_000);
    expect(await leases.acquire({ key, owner: 'b', ttlMs: 300 })).toBeUndefined();
    slow.answer();
    expect(await run).toMatchObject({ status: 'completed', output: 'done' });
  });

  it('starts a new run clean of a cancel queued before it, delivered again while it reads', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    await leases.acquire({ key, owner: 'ghost', ttlMs: 300 });
    await leases.signal(key, 'cancel');
    await advance(1_000);
    const slow = slowFirstRead(store);
    const run = runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'Do the job.',
      session: { ...session, store: slow.store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await slow.reading;
    // Each heartbeat during the read delivers the queued cancel again: it is
    // still the one from before the run.
    await advance(250);
    slow.answer();
    expect(await run).toMatchObject({ status: 'completed', output: 'done' });
    const next = (await leases.acquire({ key, owner: 'b', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({ signals: [] });
  });

  it('leaves a cancel queued for a stored run when runAgent finds the run exists', async () => {
    for (const acknowledged of [true, false]) {
      const { leases, store, session, key, clock, advance } = setup();
      const provider = acknowledged ? leases : withoutAck(leases);
      await crashedRun(store, session);
      // One cancel from before the claim, one sent while runAgent reads.
      await leases.acquire({ key, owner: 'ghost', ttlMs: 300 });
      expect(await leases.signal(key, 'cancel')).toBe(true);
      await advance(1_000);
      const slow = slowFirstRead(store);
      const run = runAgent({
        model: createMockModel({ responses: [{ text: 'done' }] }),
        prompt: 'Do the job.',
        session: { ...session, store: slow.store },
        lease: { provider, owner: 'a', ttlMs: 300 },
        deps: { clock },
      });
      await slow.reading;
      await advance(100);
      expect(await leases.signal(key, 'cancel')).toBe(true);
      await advance(100);
      slow.answer();
      expect(await run, String(acknowledged)).toMatchObject({
        status: 'failed',
        error: { message: 'Native run already exists; use resumeAgent.' },
      });
      // The cancel is the stored run's: its next executor applies it before any model call.
      const { model, fetch } = counted([{ text: 'done' }]);
      expect(
        await resumeAgent({
          model,
          session: { ...session, store },
          lease: { provider, owner: 'b', ttlMs: 300 },
          deps: { clock },
        }),
        String(acknowledged),
      ).toMatchObject({ status: 'stopped', reason: 'cancelled' });
      expect(fetch).not.toHaveBeenCalled();
    }
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

  it('gives the key back and writes nothing when the first renewal fails', async () => {
    const { leases, store, session, key, clock } = setup();
    const outage: LeaseProvider = {
      ...leases,
      renew: async () => {
        throw new Error('lease provider down');
      },
    };
    const { model, fetch } = counted([{ text: 'done' }]);
    expect(
      await runAgent({
        model,
        prompt: 'Work.',
        session: { ...session, store },
        lease: { provider: outage, owner: 'a', ttlMs: 300 },
        deps: { clock },
      }),
    ).toMatchObject({ status: 'failed', error: { message: 'lease provider down' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.list()).toEqual({ runs: [] });
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

  it.skipIf(!DatabaseSync)('works with a durable lease provider and store', async () => {
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
