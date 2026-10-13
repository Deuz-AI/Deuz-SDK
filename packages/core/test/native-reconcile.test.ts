/**
 * native-reconcile.test.ts (2.3) — reconcileAgentRun's `lease` option. The
 * call claims the run's lease as an executor does, so it never settles what a
 * live executor is still settling: an extraction stays pending from the
 * terminal commit until its outcome is saved, also while the executor that
 * completed the run is extracting. Each "process" here is a separate wrapper
 * around one store (the in-process guard is per store object) sharing one
 * lease provider; time is a manual clock.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  resumeAgent,
  runAgent,
} from '../src/agent-run';
import { createInMemoryChatStore, type ChatStore } from '../src/chat';
import { createInMemoryMemoryStore, type MemorySeams } from '../src/memory';
import { agentRunLeaseKey, createInMemoryLeaseProvider } from '../src/ops';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createDeferred } from '../src/internal/async-iter';
import type { AgentRunStore } from '../src/types/agent-run';
import type { LeaseProvider } from '../src/types/lease';
import { manualClock } from './fixtures/manual-clock';

const parameters = { type: 'object', properties: {} };
const scope = { userId: 'ada' };

/** A mock model that counts its calls. */
function counted(responses: Parameters<typeof createMockModel>[0]['responses']) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  return { model: attachConfig({ ...base }, { ...config, fetch }), fetch };
}

/** Holds the next call that passes it, once armed, until the test opens it. */
function gate() {
  const entered = createDeferred<void>();
  const opened = createDeferred<void>();
  let armed = false;
  return {
    arm: () => void (armed = true),
    async pass(): Promise<void> {
      if (!armed) return;
      armed = false;
      entered.resolve();
      await opened.promise;
    },
    entered: entered.promise,
    open: () => opened.resolve(),
  };
}

/** Another process's view of the same store; its reads can be held. */
function processView(store: AgentRunStore) {
  const held = gate();
  const load = vi.fn(async (runId: string) => {
    await held.pass();
    return store.load(runId);
  });
  const view: AgentRunStore = { load, save: (envelope) => store.save(envelope) };
  return { store: view, load, held };
}

/** A 2.2-style view of a provider: a renewal removes every signal it delivers. */
const withoutAck = (leases: LeaseProvider): LeaseProvider => ({
  acquire: (request) => leases.acquire(request),
  renew: (lease, ttlMs) => leases.renew(lease, ttlMs),
  release: (lease) => leases.release(lease),
  signal: (k, signal) => leases.signal(k, signal),
});

/** Memory seams whose LLM extracts one fact; its calls can be held. */
function memorySeams() {
  const store = createInMemoryMemoryStore();
  const held = gate();
  const llm = vi.fn<MemorySeams['llm']>(async ({ system }) => {
    await held.pass();
    return system.includes('extract')
      ? '{"facts":["prefers tea"]}'
      : '{"memory":[{"event":"ADD","text":"prefers tea"}]}';
  });
  let n = 0;
  const seams: MemorySeams = {
    store,
    llm,
    clock: { now: () => 5_000, setTimeout: (fn: () => void) => (fn(), () => {}) },
    generateId: () => `mem-${n++}`,
    hashFn: async (text) => `h:${text}`,
  };
  return { seams, store, llm, held };
}

/** A chat store whose next write can fail and whose reads can be held. */
function chatStore() {
  const inner = createInMemoryChatStore();
  const held = gate();
  let failures = 0;
  const store: ChatStore = {
    loadChat: async (id) => {
      await held.pass();
      return inner.loadChat(id);
    },
    saveChat: (record) => {
      if (failures > 0) {
        failures--;
        throw new Error('chat db unavailable');
      }
      return inner.saveChat(record);
    },
  };
  return { store, inner, held, failNext: () => void (failures = 1) };
}

function setup() {
  const time = manualClock(0);
  const leases = createInMemoryLeaseProvider({ clock: time.clock });
  const store = createInMemoryAgentRunStore({ clock: time.clock });
  const session = { runId: 'tea', scope: 'tenant' };
  return { ...time, leases, store, session, key: agentRunLeaseKey(session) };
}

describe('reconcileAgentRun lease (2.3)', () => {
  it('refuses while the executor that completed the run is still extracting', async () => {
    const { leases, store, session, clock } = setup();
    const memory = memorySeams();
    memory.held.arm();
    const run = runAgent({
      model: createMockModel({ responses: [{ text: 'Noted.' }] }),
      prompt: 'I prefer tea.',
      memory: { seams: memory.seams, scope },
      session: { ...session, store },
      lease: { provider: leases, owner: 'executor' },
      deps: { clock },
    });
    await memory.held.entered;
    const pending = (await store.load('tea'))!;
    expect(pending).toMatchObject({
      phase: 'terminal',
      memory: { extraction: { status: 'pending' } },
    });

    // A supervisor in another process finds the pending extraction.
    const supervisor = processView(store);
    const reconcile = () =>
      reconcileAgentRun({
        session: { ...session, store: supervisor.store },
        memory: { seams: memory.seams, scope },
        lease: { provider: leases, owner: 'supervisor' },
        deps: { clock },
      });
    await expect(reconcile()).rejects.toMatchObject({
      name: 'AgentRunLeaseError',
      code: 'lease_held',
    });
    // Nothing was read or written, and no second extraction ran.
    expect(supervisor.load).not.toHaveBeenCalled();
    expect(memory.llm).toHaveBeenCalledTimes(1);
    expect(await store.load('tea')).toEqual(pending);

    memory.held.open();
    expect(await run).toMatchObject({ status: 'completed' });
    const calls = memory.llm.mock.calls.length;
    // The executor kept its lease until the extraction was saved: settled.
    expect(await reconcile()).toEqual({ runId: 'tea', memory: 'completed' });
    expect(memory.llm).toHaveBeenCalledTimes(calls);
    expect(await memory.store.list(scope)).toHaveLength(1);
  });

  it('holds the lease while it settles, renews it, and gives it back however it ends', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const chat = chatStore();
    const options = {
      model: createMockModel({ responses: [{ text: 'Hello.' }] }),
      prompt: 'Hi.',
      chat: { store: chat.store, chatId: 'chat-1', scope },
      session: { ...session, store },
      lease: { provider: leases, owner: 'executor', ttlMs: 300 },
      deps: { clock },
    };
    chat.failNext();
    expect(await runAgent(options)).toMatchObject({ status: 'completed' });
    expect((await store.load('tea'))!.chat?.status).toBe('failed');

    chat.held.arm();
    const reconciled = reconcileAgentRun({
      session: { ...session, store: processView(store).store },
      chat: options.chat,
      lease: { provider: leases, owner: 'supervisor', ttlMs: 300 },
      deps: { clock },
    });
    await chat.held.entered;
    // Held past its ttl: the heartbeat renews it.
    await advance(400);
    expect(await leases.acquire({ key, owner: 'other', ttlMs: 300 })).toBeUndefined();
    chat.held.open();
    expect(await reconciled).toEqual({ runId: 'tea', chat: 'saved' });
    expect(await leases.acquire({ key, owner: 'other', ttlMs: 300 })).toMatchObject({
      owner: 'other',
    });

    // A call that fails gives its key back too.
    const unknown = { runId: 'nope', scope: 'tenant' };
    await expect(
      reconcileAgentRun({
        session: { ...unknown, store },
        lease: { provider: leases, owner: 'supervisor' },
        deps: { clock },
      }),
    ).rejects.toThrow('Unknown native run: nope');
    expect(
      await leases.acquire({ key: agentRunLeaseKey(unknown), owner: 'other', ttlMs: 300 }),
    ).toMatchObject({ owner: 'other' });
  });

  for (const acknowledged of [true, false])
    it(`leaves a cancel for the executor that resumes a suspended run (ack: ${acknowledged})`, async () => {
      const { leases, store, session, key, clock, advance } = setup();
      const provider = acknowledged ? leases : withoutAck(leases);
      const tools = { gate: { parameters, needsApproval: true, execute: () => 'ok' } };
      const suspended = await runAgent({
        model: createMockModel({ responses: [{ toolCalls: [{ toolName: 'gate', args: {} }] }] }),
        prompt: 'Gated.',
        tools,
        session: { ...session, store },
        lease: { provider, owner: 'executor', ttlMs: 300 },
        deps: { clock },
      });
      expect(suspended.status).toBe('suspended');

      // The cancel reaches the key while reconcileAgentRun holds it.
      const supervisor = processView(store);
      supervisor.held.arm();
      const reconciled = reconcileAgentRun({
        session: { ...session, store: supervisor.store },
        lease: { provider, owner: 'supervisor', ttlMs: 300 },
        deps: { clock },
      });
      await supervisor.held.entered;
      expect(await leases.signal(key, 'cancel')).toBe(true);
      await advance(100);
      supervisor.held.open();
      expect(await reconciled).toEqual({ runId: 'tea' });

      // It concerns the run: the resume that takes it up stops before any model call.
      const { model, fetch } = counted([{ text: 'done' }]);
      const approvalId =
        suspended.status === 'suspended' ? suspended.pendingApprovals[0]!.approvalId : '';
      expect(
        await resumeAgent({
          model,
          tools,
          session: { ...session, store },
          approvalResponses: [{ approvalId, approved: true }],
          lease: { provider, owner: 'next', ttlMs: 300 },
          deps: { clock },
        }),
      ).toMatchObject({ status: 'stopped', reason: 'cancelled' });
      expect(fetch).not.toHaveBeenCalled();
    });

  for (const acknowledged of [true, false])
    it(`drops a cancel an ended run makes moot, as its resume does (ack: ${acknowledged})`, async () => {
      const { leases, store, session, key, clock, advance } = setup();
      const provider = acknowledged ? leases : withoutAck(leases);
      expect(
        await runAgent({
          model: createMockModel({ responses: [{ text: 'done' }] }),
          prompt: 'Do the job.',
          session: { ...session, store },
          lease: { provider, owner: 'executor', ttlMs: 300 },
          deps: { clock },
        }),
      ).toMatchObject({ status: 'completed' });
      // A cancel its last holder never read.
      await leases.acquire({ key, owner: 'ghost', ttlMs: 300 });
      expect(await leases.signal(key, 'cancel')).toBe(true);
      await advance(1_000);
      expect(
        await reconcileAgentRun({
          session: { ...session, store },
          lease: { provider, owner: 'supervisor', ttlMs: 300 },
          deps: { clock },
        }),
      ).toEqual({ runId: 'tea' });
      const next = (await leases.acquire({ key, owner: 'next', ttlMs: 300 }))!;
      expect(await leases.renew(next, 300, { acknowledge: true })).toMatchObject({
        held: true,
        signals: [],
      });
    });

  it('writes nothing more once its lease is lost and rejects with lease_lost', async () => {
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
    const chat = chatStore();
    const options = {
      model: createMockModel({ responses: [{ text: 'Hello.' }] }),
      prompt: 'Hi.',
      chat: { store: chat.store, chatId: 'chat-1', scope },
      session: { ...session, store },
    };
    chat.failNext();
    expect(await runAgent(options)).toMatchObject({ status: 'completed' });
    const before = await store.load('tea');

    chat.held.arm();
    const reconciled = reconcileAgentRun({
      session: { ...session, store: processView(store).store },
      chat: options.chat,
      lease: { provider: outage, owner: 'supervisor', ttlMs: 300 },
      deps: { clock },
    });
    await chat.held.entered;
    down = true;
    // An outage is survivable until the lease could have lapsed.
    await advance(400);
    chat.held.open();
    await expect(reconciled).rejects.toMatchObject({
      name: 'AgentRunLeaseError',
      code: 'lease_lost',
    });
    // The run stays as its last save left it, for the next call.
    expect(await store.load('tea')).toEqual(before);
    expect(await leases.acquire({ key, owner: 'next', ttlMs: 300 })).toMatchObject({
      owner: 'next',
    });
  });

  it('reports a lost lease however the loss surfaced', async () => {
    const { leases, store, session, clock, advance } = setup();
    let down = false;
    const outage: LeaseProvider = {
      ...leases,
      renew: async (lease, ttlMs, options) => {
        if (down) throw new Error('lease provider down');
        return leases.renew(lease, ttlMs, options);
      },
    };
    const view = processView(store);
    const failing: AgentRunStore = {
      load: async (runId) => {
        await view.load(runId);
        throw new Error('database down');
      },
      save: view.store.save,
    };
    view.held.arm();
    const reconciled = reconcileAgentRun({
      session: { ...session, store: failing },
      lease: { provider: outage, owner: 'supervisor', ttlMs: 300 },
      deps: { clock },
    });
    await view.held.entered;
    down = true;
    await advance(400);
    view.held.open();
    await expect(reconciled).rejects.toMatchObject({
      name: 'AgentRunLeaseError',
      code: 'lease_lost',
    });
  });

  it('rejects a malformed lease before it reads the run', async () => {
    const { store, session } = setup();
    const view = processView(store);
    for (const lease of [{ provider: {} }, { provider: createInMemoryLeaseProvider(), ttlMs: 2 }])
      await expect(
        reconcileAgentRun({ session: { ...session, store: view.store }, lease: lease as never }),
        JSON.stringify(lease),
      ).rejects.toThrow(TypeError);
    expect(view.load).not.toHaveBeenCalled();
  });
});
