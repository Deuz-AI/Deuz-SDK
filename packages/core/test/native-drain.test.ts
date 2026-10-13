/**
 * native-drain.test.ts (2.3) — a `'drain'` lease signal stops a leased native
 * run at its next model-step boundary. The step in flight finishes, its tool
 * calls included; no further model call or tool dispatch starts; the run is
 * left as its last save had it, so a resume goes on from there; the result is
 * `stopped` with reason `'drained'`. Before, native runs ignored a drain.
 *
 * Each "process" is its own view of one store sharing one lease provider; time
 * is a manual clock, so the heartbeat that delivers a signal runs on demand.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent, streamAgent } from '../src/agent-run';
import { agentRunLeaseKey, createInMemoryLeaseProvider } from '../src/ops';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import { createInMemoryChatStore } from '../src/chat';
import { createMemoryObserver } from '../src/observe';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createDeferred } from '../src/internal/async-iter';
import type { AgentEvent, AgentRunStore, AgentToolSet } from '../src/types/agent-run';
import type { LeaseProvider } from '../src/types/lease';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { manualClock } from './fixtures/manual-clock';
import { claudeTurn, openaiTurn, overloaded, scriptedFetch } from './fixtures/wire-turns';

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

/** A tool that runs until the test releases it; it ignores a drain, as it should. */
function parkedTool() {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  let runs = 0;
  const tools: AgentToolSet = {
    work: {
      description: 'Long work.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        runs += 1;
        entered.resolve();
        await released.promise;
        return 'worked';
      },
    },
  };
  return {
    tools,
    entered: entered.promise,
    release: () => released.resolve(),
    runs: () => runs,
  };
}

/** A provider on which a drain reaches the holder right after it claims a key. */
const drainingOnClaim = (leases: LeaseProvider): LeaseProvider => ({
  acquire: async (request) => {
    const lease = await leases.acquire(request);
    if (lease) await leases.signal(request.key, 'drain');
    return lease;
  },
  renew: (lease, ttlMs, options) => leases.renew(lease, ttlMs, options),
  release: (lease) => leases.release(lease),
  signal: (key, signal) => leases.signal(key, signal),
  ack: (lease, signal) => leases.ack!(lease, signal),
});

function setup() {
  const time = manualClock(0);
  const leases = createInMemoryLeaseProvider({ clock: time.clock });
  const store = createInMemoryAgentRunStore({ clock: time.clock });
  const session = { runId: 'job', scope: 'tenant' };
  const key = agentRunLeaseKey(session);
  return { ...time, leases, store, session, key };
}

const workThenDone: MockResponse[] = [
  { toolCalls: [{ toolName: 'work', id: 'w1', args: {} }] },
  { text: 'done' },
];

/** A client-side tool: the caller answers its calls with `clientToolResults`. */
const ask = {
  description: 'Ask the user.',
  parameters: { type: 'object' as const, properties: {} },
};

/** The tool results the model was given, from the request of the `call`-th model call. */
function toolMessages(fetch: ReturnType<typeof counted>['fetch'], call: number): unknown[] {
  const body = JSON.parse(String(fetch.mock.calls[call]![1]?.body)) as {
    messages: { role: string; content: unknown }[];
  };
  return body.messages.filter((message) => message.role === 'tool').map((m) => m.content);
}

describe('a drain signal stops a leased native run at its next step boundary (2.3)', () => {
  it('lets the step in flight finish, stops before the next model call, and resumes from there', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const { model, fetch } = counted([...workThenDone]);
    const run = runAgent({
      model,
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    expect(await leases.signal(key, 'drain')).toBe(true);
    // The next heartbeat delivers it; the tool in flight is not interrupted.
    await advance(100);
    parked.release();
    const drained = await run;
    expect(drained).toMatchObject({ status: 'stopped', reason: 'drained' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(parked.runs()).toBe(1);

    // The run is left at the step boundary, unended: a plain running checkpoint
    // whose history holds the step's tool result, and no result.
    const stored = (await store.load('job'))!;
    expect(stored.phase).toBe('running');
    expect(stored.result).toBeUndefined();
    expect(stored.checkpoints.job).toMatchObject({ status: 'running' });
    expect(stored.checkpoints.job!.messages.at(-1)?.role).toBe('tool');
    expect(stored.loopOutcome?.stoppedBy).toBeUndefined();
    expect(Object.values(stored.toolResults ?? {}).map((r) => r.stage)).toEqual(['completed']);

    // The lease went back, and the drain went with it: it concerned that holder.
    const next = (await leases.acquire({ key, owner: 'probe', ttlMs: 300 }))!;
    expect(await leases.renew(next, 300)).toMatchObject({ held: true, signals: [] });
    await leases.release(next);

    // Another executor goes on from the boundary; the tool does not run again.
    const resumed = await resumeAgent({
      model,
      tools: parked.tools,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
      deps: { clock },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(parked.runs()).toBe(1);
  });

  it('reports the boundary checkpoint as the running one the store keeps (W3 review V1-3)', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const observer = createMemoryObserver();
    const run = runAgent({
      model: createMockModel({ responses: [...workThenDone] }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock, observer },
    });
    await parked.entered;
    expect(await leases.signal(key, 'drain')).toBe(true);
    await advance(100);
    parked.release();
    expect(await run).toMatchObject({ status: 'stopped', reason: 'drained' });
    const stored = (await store.load('job'))!.checkpoints.job!;
    expect(stored.status).toBe('running');
    const saved = observer
      .events()
      .filter((event) => event.type === 'checkpoint.saved' && event.stepId === stored.stepId);
    expect(saved).toEqual([expect.objectContaining({ checkpointStatus: 'running' })]);
    // The run's own end still says why it stopped.
    expect(observer.events()).toContainEqual(
      expect.objectContaining({ type: 'run.completed', stoppedBy: 'drained' }),
    );
  });

  it('stops a new run that a drain reaches as it starts, before any model call', async () => {
    const { leases, store, session, clock } = setup();
    const { model, fetch } = counted([...workThenDone]);
    const parked = parkedTool();
    parked.release();
    const options = { model, prompt: 'Work.', tools: parked.tools, deps: { clock } };
    const drained = await runAgent({
      ...options,
      session: { ...session, store },
      lease: { provider: drainingOnClaim(leases), owner: 'a' },
    });
    expect(drained).toMatchObject({ status: 'stopped', reason: 'drained' });
    expect(fetch).not.toHaveBeenCalled();
    // The run was admitted, so another executor can take it up.
    expect(await store.load('job')).toMatchObject({ phase: 'running', modelSteps: 0 });
    const resumed = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops before a final answer call', async () => {
    const { leases, store, session, clock } = setup();
    const { model, fetch } = counted([{ text: '{"answer":42}' }]);
    const options = {
      model,
      prompt: 'Answer.',
      output: {
        schema: {
          type: 'object' as const,
          properties: { answer: { type: 'number' as const } },
          required: ['answer'],
        },
        mode: 'json' as const,
        validate: (value: unknown) => value as { answer: number },
      },
      deps: { clock },
    };
    const drained = await runAgent({
      ...options,
      session: { ...session, store },
      lease: { provider: drainingOnClaim(leases), owner: 'a' },
    });
    expect(drained).toMatchObject({ status: 'stopped', reason: 'drained' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.load('job')).toMatchObject({ phase: 'finalizing', finalizationAttempts: 0 });
    const resumed = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: { answer: 42 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('leaves a run untouched when a drain reaches the resume before it starts', async () => {
    const { leases, store, session, clock } = setup();
    const ran: string[] = [];
    const { model, fetch } = counted([
      { toolCalls: [{ toolName: 'publish', id: 'p1', args: {} }] },
      { text: 'done' },
    ]);
    const options = {
      model,
      prompt: 'Publish.',
      tools: {
        publish: {
          parameters: { type: 'object' as const, properties: {} },
          needsApproval: true,
          execute: () => {
            ran.push('publish');
            return 'published';
          },
        },
      },
      deps: { clock },
    };
    const first = await runAgent({ ...options, session: { ...session, store } });
    expect(first.status).toBe('suspended');
    const approvalResponses =
      first.status === 'suspended'
        ? first.pendingApprovals.map((r) => ({ approvalId: r.approvalId, approved: true }))
        : [];
    const before = await store.load('job');
    const drained = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: drainingOnClaim(leases), owner: 'a' },
      approvalResponses,
    });
    expect(drained).toMatchObject({ status: 'stopped', reason: 'drained' });
    // Nothing was written: the run still waits for the same verdict.
    expect(await store.load('job')).toEqual(before);
    expect(ran).toEqual([]);
    const resumed = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b' },
      approvalResponses,
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(ran).toEqual(['publish']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('applies what a resume was given before it stops, once it took the run up', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    parked.release();
    const { model, fetch } = counted([
      { toolCalls: [{ toolName: 'ask', id: 'a1', args: {} }] },
      ...workThenDone,
    ]);
    const options = {
      model,
      prompt: 'Ask, then work.',
      tools: { ...parked.tools, ask },
      deps: { clock },
    };
    expect((await runAgent({ ...options, session: { ...session, store } })).status).toBe(
      'suspended',
    );
    // The drain reaches the executor while the write that takes the run up is in flight.
    let taken = false;
    const drainOnFirstWrite: AgentRunStore = {
      load: (runId) => store.load(runId),
      save: async (envelope) => {
        if (!taken) {
          taken = true;
          await leases.signal(key, 'drain');
          await advance(100);
        }
        return store.save(envelope);
      },
    };
    const drained = await resumeAgent({
      ...options,
      session: { ...session, store: drainOnFirstWrite },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      clientToolResults: [{ toolCallId: 'a1', output: 'blue' }],
    });
    // The client's answer went in first; the run stopped at the step boundary after it.
    expect(drained).toMatchObject({ status: 'stopped', reason: 'drained' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(parked.runs()).toBe(1);
    const resumed = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 2)).toEqual(['blue', 'worked']);
  });

  it('lets a call that fails over go to the next model, then stops at the boundary', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    parked.release();
    const primaryWire = scriptedFetch([
      claudeTurn([{ type: 'tool_use', id: 'toolu_1', name: 'ask', json: '{}' }], 'tool_use'),
      overloaded,
    ]);
    let primaryCalls = 0;
    const primary = createAnthropic({
      apiKey: 'a',
      fetch: async (url, init) => {
        // The drain reaches the executor during the call that is about to fail.
        if (++primaryCalls === 2) {
          await leases.signal(key, 'drain');
          await advance(100);
        }
        return primaryWire.fetch(url, init);
      },
    })('claude-opus-5-5');
    const fallbackWire = scriptedFetch([
      openaiTurn({ toolCalls: [{ id: 'w1', name: 'work', json: '{}' }] }),
      openaiTurn({ text: 'done' }),
    ]);
    const fallback = createOpenAI({ apiKey: 'b', fetch: fallbackWire.fetch })('gpt-5.2');
    const options = {
      model: primary,
      fallbackModels: [fallback],
      maxRetries: 0,
      prompt: 'Ask, then work.',
      tools: { ...parked.tools, ask },
      deps: { clock },
    };
    expect((await runAgent({ ...options, session: { ...session, store } })).status).toBe(
      'suspended',
    );
    const drained = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      clientToolResults: [{ toolCallId: 'toolu_1', output: 'blue' }],
    });
    // The failed call went to the fallback as part of the step in flight.
    expect(drained).toMatchObject({ status: 'stopped', reason: 'drained' });
    expect(primaryWire.calls()).toBe(2);
    expect(fallbackWire.calls()).toBe(1);
    expect(parked.runs()).toBe(1);
    const resumed = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(parked.runs()).toBe(1);
    expect(JSON.stringify(fallbackWire.bodies[1]!.messages)).toContain('blue');
  });

  it('lets a final answer call that fails over go to the next model', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const primaryWire = scriptedFetch([overloaded]);
    const primary = createAnthropic({
      apiKey: 'a',
      fetch: async (url, init) => {
        await leases.signal(key, 'drain');
        await advance(100);
        return primaryWire.fetch(url, init);
      },
    })('claude-opus-5-5');
    const fallbackWire = scriptedFetch([openaiTurn({ text: '{"answer":42}' })]);
    const fallback = createOpenAI({ apiKey: 'b', fetch: fallbackWire.fetch })('gpt-5.2');
    const result = await runAgent({
      model: primary,
      fallbackModels: [fallback],
      maxRetries: 0,
      prompt: 'Answer.',
      output: {
        schema: {
          type: 'object' as const,
          properties: { answer: { type: 'number' as const } },
          required: ['answer'],
        },
        mode: 'json' as const,
        validate: (value: unknown) => value as { answer: number },
      },
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    // The retried call answered, so no model call was left for the drain to stop.
    expect(result).toMatchObject({ status: 'completed', output: { answer: 42 } });
    expect(primaryWire.calls()).toBe(1);
    expect(fallbackWire.calls()).toBe(1);
  });

  it('projects the chat of a drained run, and its resume appends nothing twice', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const chats = createInMemoryChatStore();
    const options = {
      model: createMockModel({ responses: [...workThenDone] }),
      prompt: 'Work.',
      tools: parked.tools,
      chat: { store: chats, chatId: 'chat-d', scope: { userId: 'ada' } },
      deps: { clock },
    };
    const run = runAgent({
      ...options,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
    });
    await parked.entered;
    await leases.signal(key, 'drain');
    await advance(100);
    parked.release();
    expect(await run).toMatchObject({ status: 'stopped', reason: 'drained' });
    // The chat shows what the run did up to the boundary it stopped at.
    const roles = async () =>
      (await chats.loadChat('chat-d'))!.messages.map((message) => message.role);
    expect(await roles()).toEqual(['user', 'assistant', 'tool']);
    const resumed = await resumeAgent({
      ...options,
      session: { ...session, store: processView(store) },
      lease: { provider: leases, owner: 'b', ttlMs: 300 },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(await roles()).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((await chats.loadChat('chat-d'))!.messages).toEqual(resumed.messages);
  });

  it('names the drain on the stream', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const stream = streamAgent({
      model: createMockModel({ responses: [...workThenDone] }),
      prompt: 'Work.',
      tools: parked.tools,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    const events: AgentEvent[] = [];
    const read = (async () => {
      for await (const event of stream.events) events.push(event);
    })();
    await parked.entered;
    await leases.signal(key, 'drain');
    await advance(100);
    parked.release();
    await read;
    expect(await stream.result).toMatchObject({ status: 'stopped', reason: 'drained' });
    const finish = events.findLast(
      (event) => event.type === 'part' && event.part.type === 'finish',
    );
    expect(finish).toMatchObject({
      part: { providerMetadata: { deuz: { stoppedBy: 'drained' } } },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'stopped', reason: 'drained' },
    });
  });

  it('lets a cancel outrank a drain', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const entered = createDeferred<void>();
    const run = runAgent({
      model: createMockModel({ responses: [...workThenDone] }),
      prompt: 'Work.',
      tools: {
        work: {
          parameters: { type: 'object', properties: {} },
          execute: (_args, ctx) =>
            new Promise((_resolve, reject) => {
              entered.resolve();
              ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            }),
        },
      },
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await entered.promise;
    await leases.signal(key, 'drain');
    await leases.signal(key, 'cancel');
    await advance(100);
    expect(await run).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(await store.load('job')).toMatchObject({
      phase: 'terminal',
      result: { status: 'stopped', reason: 'cancelled' },
    });
  });

  it('keeps every other stop ahead of a drain at the same boundary', async () => {
    const { leases, store, session, key, clock, advance } = setup();
    const parked = parkedTool();
    const run = runAgent({
      model: createMockModel({ responses: [...workThenDone] }),
      prompt: 'Work.',
      tools: parked.tools,
      // The run's own step limit is reached at the same boundary.
      maxSteps: 1,
      session: { ...session, store },
      lease: { provider: leases, owner: 'a', ttlMs: 300 },
      deps: { clock },
    });
    await parked.entered;
    await leases.signal(key, 'drain');
    await advance(100);
    parked.release();
    expect(await run).toMatchObject({ status: 'stopped', reason: 'max-steps' });
    expect(await store.load('job')).toMatchObject({ phase: 'terminal' });
  });

  it.skipIf(!DatabaseSync)('drains with the SQLite lease provider and run store', async () => {
    const { clock, advance } = manualClock(0);
    const ops = createSqliteOpsStore({ path: ':memory:', clock });
    try {
      const parked = parkedTool();
      const { model, fetch } = counted([...workThenDone]);
      const session = { runId: 'durable', scope: 'tenant' };
      const key = agentRunLeaseKey(session);
      const run = runAgent({
        model,
        prompt: 'Work.',
        tools: parked.tools,
        session: { ...session, store: ops.agentRuns },
        lease: { provider: ops.leases, owner: 'a', ttlMs: 300 },
        deps: { clock },
      });
      await parked.entered;
      expect(await ops.leases.signal(key, 'drain')).toBe(true);
      await advance(100);
      parked.release();
      expect(await run).toMatchObject({ status: 'stopped', reason: 'drained' });
      expect(await ops.agentRuns.load('durable')).toMatchObject({ phase: 'running' });
      expect(
        await resumeAgent({
          model,
          tools: parked.tools,
          session: { ...session, store: ops.agentRuns },
          lease: { provider: ops.leases, owner: 'b', ttlMs: 300 },
          deps: { clock },
        }),
      ).toMatchObject({ status: 'completed', output: 'done' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(parked.runs()).toBe(1);
    } finally {
      await ops.close();
    }
  });
});
