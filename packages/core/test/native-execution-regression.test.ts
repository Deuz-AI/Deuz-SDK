import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { createExecutionContext } from '../src/execution-policy';
import { generateText } from '../src/generate';
import { agentTool } from '../src/inference/agent-tool';
import {
  createApprovalSigner,
  createInMemorySessionStore,
  resumeFromCheckpoint,
} from '../src/durable';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import { createSqliteSwarmStore } from '../src/node/swarm-sqlite';
import { createMockModel, sseEvents, sseResponse } from '../src/testing';
import type { MockResponse } from '../src/testing';
import type { AgentRunStore } from '../src/types/agent-run';
import type { Clock } from '../src/types/deps';
import type { NativeExecutionContext } from '../src/types/execution';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import type { SwarmSnapshot, SwarmStore } from '../src/types/swarm';

const parameters = { type: 'object' as const, properties: {} };
function mock(responses: MockResponse[]) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  return { model: attachConfig({ ...base }, { ...config, fetch }), fetch };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
  };
}

describe('native execution cross-feature regressions', () => {
  it.each([false, true])(
    'retains a swarm executor until a timed-out tool settles (late rejection=%s)',
    async (rejectLate) => {
      const started = gate();
      const release = gate();
      const clock = manualClock();
      let signal: AbortSignal | undefined;
      let effectSettled = false;
      const model = mock([
        { toolCalls: [{ toolName: 'slow', id: 'slow-effect', args: {} }] },
        { text: 'recovered after the timeout' },
      ]);
      const agent = createAgent({
        model: model.model,
        timeout: { totalMs: 0, ttftMs: 0, toolMs: 5 },
        tools: {
          slow: {
            parameters,
            async execute(_args, context) {
              signal = context.signal;
              started.resolve();
              await release.promise; // Deliberately ignores the cancellation signal.
              effectSettled = true;
              if (rejectLate) throw new Error('late tool failure');
              return 'late tool value';
            },
          },
        },
      });
      const swarm = createSwarm({
        agents: { worker: agent },
        store: createInMemorySwarmStore(),
        deps: { clock },
      });
      const handle = await swarm.run({
        scope: 'tenant',
        tasks: [{ id: 'a', agent: 'worker', prompt: 'work' }],
      });
      let terminalPublished = false;
      void handle.result.then(() => {
        terminalPublished = true;
      });
      await started.promise;
      clock.advance(5);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const publishedBeforeDrain = terminalPublished;
      const callsBeforeDrain = model.fetch.mock.calls.length;
      let executorStillOwned = false;
      try {
        const duplicate = await swarm.resume(handle);
        await duplicate.result;
      } catch (error) {
        executorStillOwned = error instanceof Error && error.message.includes('executor');
      }
      release.resolve();
      const outcome = await handle.result;
      expect(signal?.aborted).toBe(true);
      expect(publishedBeforeDrain).toBe(false);
      expect(callsBeforeDrain).toBe(1);
      expect(executorStillOwned).toBe(true);
      expect(effectSettled).toBe(true);
      expect(outcome.tasks[0]?.status).toBe('completed');
      expect(model.fetch).toHaveBeenCalledTimes(2);
      expect(String(model.fetch.mock.calls[1]?.[1]?.body)).toContain('timed out');
    },
  );

  it('does not hide a late fatal receipt persistence failure behind a tool timeout', async () => {
    const started = gate();
    const release = gate();
    const clock = manualClock();
    const inner = createInMemoryAgentRunStore();
    let rejectedWrites = 0;
    const store: AgentRunStore = {
      ...inner,
      save(envelope) {
        if (
          Object.values(envelope.toolResults ?? {}).some(
            (receipt) => receipt.toolCallId === 'slow' && receipt.stage === 'executed',
          )
        ) {
          rejectedWrites++;
          throw new Error('late receipt failure');
        }
        return inner.save(envelope);
      },
    };
    const model = mock([
      { toolCalls: [{ toolName: 'slow', id: 'slow', args: {} }] },
      { text: 'must not recover' },
    ]);
    const pending = runAgent({
      model: model.model,
      prompt: 'work',
      timeout: { totalMs: 0, ttftMs: 0, toolMs: 5 },
      session: { store, runId: 'late-fatal-timeout', scope: 'tenant' },
      deps: { clock },
      tools: {
        slow: {
          parameters,
          async execute() {
            started.resolve();
            await release.promise;
            return 'effect complete';
          },
        },
      },
    });
    await started.promise;
    clock.advance(5);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    release.resolve();
    const result = await pending;
    expect(rejectedWrites).toBe(1);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toContain('late receipt failure');
    expect(model.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not execute a signed approval bound to a different agent path', async () => {
    const execute = vi.fn(() => 'paid');
    const model = mock([
      { toolCalls: [{ toolName: 'pay', id: 'payment', args: {} }] },
      { text: 'done' },
    ]);
    const signer = createApprovalSigner({ secret: 'path binding test' });
    const store = createInMemorySessionStore();
    const execution = createExecutionContext();
    const tools = { pay: { parameters, execute, needsApproval: true } };
    const first = await generateText({
      model: model.model,
      messages: [{ role: 'user', content: 'pay' }],
      tools,
      execution,
      approvalSigner: signer,
      session: { store, runId: 'path-bound', durability: 'strict' },
    });
    const request = first.pendingApprovals![0]!;
    const wrongPath = await signer.sign(
      { ...request, agentPath: ['another-agent'] },
      { runId: 'path-bound' },
    );
    await resumeFromCheckpoint(store, 'path-bound', {
      model: model.model,
      tools,
      execution,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: request.approvalId, approved: true, token: wrongPath }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists caller-supplied execution reservations before native model dispatch', async () => {
    const store = createInMemoryAgentRunStore();
    const base = createMockModel({ responses: [{ text: 'done' }] });
    const config = readConfig(base)!;
    const holdsAtDispatch: number[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const envelope = await store.load('provided-execution');
      holdsAtDispatch.push(envelope?.execution?.ledger.reservations.length ?? 0);
      return config.fetch!(input, init);
    };
    const model = attachConfig({ ...base }, { ...config, fetch });
    const result = await runAgent({
      model,
      prompt: 'work',
      execution: createExecutionContext({ scopeId: 'caller-supplied', budget: { tokens: 30 } }),
      executionEstimate: { tokens: 20 },
      session: { store, runId: 'provided-execution', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    expect(holdsAtDispatch).toEqual([1]);
  });

  it('settles signed sibling approvals when providers reuse the same tool-call ID', async () => {
    const executeA = vi.fn(() => 'a paid');
    const executeB = vi.fn(() => 'b paid');
    const a = mock([
      { toolCalls: [{ toolName: 'pay', id: 'same', args: {} }] },
      { text: 'a done' },
    ]);
    const b = mock([
      { toolCalls: [{ toolName: 'pay', id: 'same', args: {} }] },
      { text: 'b done' },
    ]);
    const parent = mock([
      {
        toolCalls: [
          { toolName: 'a', id: 'delegate-a', args: { prompt: 'pay' } },
          { toolName: 'b', id: 'delegate-b', args: { prompt: 'pay' } },
        ],
      },
      { text: 'done' },
    ]);
    const tools = {
      a: agentTool({
        name: 'a',
        description: 'a',
        model: a.model,
        tools: { pay: { parameters, execute: executeA, needsApproval: true } },
      }),
      b: agentTool({
        name: 'b',
        description: 'b',
        model: b.model,
        tools: { pay: { parameters, execute: executeB, needsApproval: true } },
      }),
    };
    const store = createInMemorySessionStore();
    const signer = createApprovalSigner({ secret: 'sibling test key' });
    const execution = createExecutionContext();
    const first = await generateText({
      model: parent.model,
      messages: [{ role: 'user', content: 'pay both' }],
      tools,
      maxSteps: 5,
      execution,
      approvalSigner: signer,
      session: { store, runId: 'siblings', durability: 'strict' },
    });
    expect(first.pendingApprovals).toHaveLength(2);
    expect(first.pendingApprovals?.map((request) => request.approvalId)).toEqual(['same', 'same']);
    await resumeFromCheckpoint(store, 'siblings', {
      model: parent.model,
      tools,
      maxSteps: 5,
      execution,
      approvalSigner: signer,
      approvalResponses: first.pendingApprovals!.map((request) => ({
        approvalId: request.approvalId,
        approved: true,
        token: request.token,
      })),
    });
    expect(executeA).toHaveBeenCalledTimes(1);
    expect(executeB).toHaveBeenCalledTimes(1);
  });

  it('resumes native sub-agent approval without classifying its delegation as an unknown side effect', async () => {
    const execute = vi.fn(() => 'paid');
    const child = mock([
      { toolCalls: [{ toolName: 'pay', id: 'pay-child', args: {} }] },
      { text: 'paid' },
    ]);
    const parent = mock([
      { toolCalls: [{ toolName: 'worker', id: 'delegate', args: { prompt: 'pay' } }] },
      { text: 'done' },
    ]);
    const tools = {
      worker: agentTool({
        name: 'worker',
        description: 'worker',
        model: child.model,
        tools: { pay: { parameters, execute, needsApproval: true } },
      }),
    };
    const options = {
      model: parent.model,
      prompt: 'pay',
      tools,
      session: { store: createInMemoryAgentRunStore(), runId: 'native-child', scope: 'tenant' },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') throw new Error(`Expected suspension, got ${first.status}`);
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: first.pendingApprovals.map((request) => ({
        approvalId: request.approvalId,
        approved: true,
      })),
    });
    expect(resumed.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(parent.fetch).toHaveBeenCalledTimes(2);
    expect(child.fetch).toHaveBeenCalledTimes(2);
  });

  it('persists a default native budget reservation before dispatch and stops on failure', async () => {
    const inner = createInMemoryAgentRunStore();
    const store: AgentRunStore = {
      ...inner,
      save(envelope) {
        if (envelope.execution?.ledger.reservations.some((item) => item.state === 'reserved'))
          throw new Error('reservation disk failure');
        return inner.save(envelope);
      },
    };
    const model = mock([{ text: 'must not be dispatched' }]);
    const result = await runAgent({
      model: model.model,
      prompt: 'work',
      budget: { tokens: 20 },
      executionEstimate: { tokens: 15 },
      session: { store, runId: 'reservation-failure', scope: 'tenant' },
    });
    expect(result.status).toBe('failed');
    expect(model.fetch).not.toHaveBeenCalled();
    expect((await inner.load('reservation-failure'))?.execution?.ledger.reservations).toHaveLength(
      0,
    );
  });

  it('does not dispatch parallel native runs after shared ledger persistence fails', async () => {
    const persist = vi.fn(async () => {
      throw new Error('ledger unavailable');
    });
    const root = createExecutionContext({ budget: { tokens: 100 }, persist });
    const model = mock([{ text: 'must not be dispatched' }]);
    const results = await Promise.all(
      ['a', 'b'].map((id) =>
        runAgent({
          model: model.model,
          prompt: id,
          execution: root.child({ scopeId: id }),
          executionEstimate: { tokens: 20 },
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(['failed', 'failed']);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(model.fetch).not.toHaveBeenCalled();
  });

  it('retains suspended approvals when resumed without a verdict', async () => {
    const execute = vi.fn(() => 'written');
    const model = mock([
      { toolCalls: [{ toolName: 'write', id: 'write-1', args: {} }] },
      { text: 'done' },
    ]);
    const options = {
      model: model.model,
      prompt: 'write',
      tools: { write: { parameters, execute, needsApproval: true } },
      session: {
        store: createInMemoryAgentRunStore(),
        runId: 'approval-no-verdict',
        scope: 'tenant',
      },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const second = await resumeAgent(options);
    expect(second.status).toBe('suspended');
    expect(execute).not.toHaveBeenCalled();
    expect(model.fetch).toHaveBeenCalledTimes(1);
    expect((await options.session.store.load(options.session.runId))?.result?.status).toBe(
      'suspended',
    );
  });

  it('rejects replacing a recovered budget ledger with fresh counters', async () => {
    const execute = vi.fn(() => 'written');
    const model = mock([
      { toolCalls: [{ toolName: 'write', id: 'write-1', args: {} }] },
      { text: 'done' },
    ]);
    const options = {
      model: model.model,
      prompt: 'write',
      budget: { tokens: 30 },
      executionEstimate: { tokens: 15 },
      tools: { write: { parameters, execute, needsApproval: true } },
      session: { store: createInMemoryAgentRunStore(), runId: 'ledger-recovery', scope: 'tenant' },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') throw new Error('Expected suspension');
    const fresh = createExecutionContext({
      scopeId: options.session.runId,
      budget: { tokens: 30 },
    });
    const resumed = await resumeAgent({
      ...options,
      execution: fresh,
      approvalResponses: first.pendingApprovals.map((item) => ({
        approvalId: item.approvalId,
        approved: true,
      })),
    });
    expect(resumed.status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    expect(model.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns committed terminal results without replaying a tool or paid model call', async () => {
    const execute = vi.fn(() => 'written');
    const model = mock([
      { toolCalls: [{ toolName: 'write', id: 'write-1', args: {} }] },
      { text: 'done' },
      { text: 'must not run' },
    ]);
    const options = {
      model: model.model,
      prompt: 'write',
      tools: { write: { parameters, execute } },
      session: { store: createInMemoryAgentRunStore(), runId: 'completed', scope: 'tenant' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('completed');
    expect(await resumeAgent(options)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves inherited execution in a tool with validated private context', async () => {
    const root = createExecutionContext({
      policy: { allowedTools: ['inspect'], maxDepth: 2 },
      budget: { tokens: 100 },
    });
    const execution = root.child({ scopeId: 'native', budget: { tokens: 40 } });
    let observed: NativeExecutionContext | undefined;
    const model = mock([{ toolCalls: [{ toolName: 'inspect', args: {} }] }, { text: 'done' }]);
    const result = await runAgent({
      model: model.model,
      prompt: 'inspect',
      execution,
      executionEstimate: { tokens: 20 },
      toolsContext: { inspect: { tenant: 'a' } },
      tools: {
        inspect: {
          parameters,
          validateContext: (value: unknown) => value,
          execute: (_args, context) => {
            observed = context.execution;
            return context.context;
          },
        },
      },
    });
    expect(result.status).toBe('completed');
    expect(observed).toBe(execution);
    expect(observed?.ledger).toBe(root.ledger);
    expect(root.ledger.totals().spent.tokens).toBe(30);
  });

  it('cancels a running swarm agent through the signal exposed to its tools', async () => {
    const started = gate();
    const release = gate();
    let signal: AbortSignal | undefined;
    const model = mock([
      { toolCalls: [{ toolName: 'wait', id: 'wait-1', args: {} }] },
      { text: 'done' },
    ]);
    const agent = createAgent({
      model: model.model,
      tools: {
        wait: {
          parameters,
          async execute(_args, context) {
            signal = context.signal;
            started.resolve();
            await release.promise;
            return 'released';
          },
        },
      },
    });
    const swarm = createSwarm({ agents: { worker: agent }, store: createInMemorySwarmStore() });
    const handle = await swarm.run({
      scope: 'tenant',
      tasks: [{ id: 'a', agent: 'worker', prompt: 'wait' }],
    });
    await started.promise;
    await handle.cancel();
    const observedAbort = signal?.aborted;
    release.resolve();
    const outcome = await handle.result;
    expect(observedAbort).toBe(true);
    expect(outcome.tasks[0]?.status).toBe('cancelled');
    expect(model.fetch).toHaveBeenCalledTimes(1);
  });

  it('retains unknown billed usage in swarm checkpoints and later admission', async () => {
    const base = createMockModel({ responses: [] });
    const fetch = vi.fn(async () =>
      sseResponse([
        sseEvents([
          { data: { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] } },
          { data: '[DONE]' },
        ]),
      ]),
    );
    const model = attachConfig({ ...base }, { ...readConfig(base)!, fetch });
    const reducer = vi.fn(async (_results, context) => {
      await context.execution.reserve({ requestId: 'later', modelId: model.modelId, tokens: 1 });
      return 'should not be admitted';
    });
    const options = {
      agents: { worker: createAgent({ model, executionEstimate: { tokens: 20 } }) },
      store: createInMemorySwarmStore(),
      budget: { tokens: 20 },
      reducers: { after: { execute: reducer } },
    };
    const first = await (
      await createSwarm(options).run({
        scope: 'tenant',
        tasks: [
          { id: 'a', agent: 'worker', prompt: 'answer' },
          { id: 'b', reducer: 'after', dependsOn: ['a'] },
        ],
      })
    ).result;
    expect(first.tasks.map((task) => task.status)).toEqual(['completed', 'failed']);
    const restored = createExecutionContext({ snapshot: first.run.executionState! });
    expect(restored.ledger.totals()).toMatchObject({ reserved: { tokens: 20 }, unknownTokens: 1 });
    const resumed = await (await createSwarm(options).resume(first.run)).result;
    expect(resumed.run.executionState?.ledger.reservations).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('halts all swarm dispatch when the durable reservation write fails', async () => {
    const inner = createInMemorySwarmStore();
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        if (change.run?.executionState?.ledger.reservations.length)
          throw new Error('reservation commit failed');
        return inner.commit(change);
      },
    };
    const model = mock([{ text: 'must not run' }]);
    const agent = createAgent({ model: model.model, executionEstimate: { tokens: 20 } });
    const handle = await createSwarm({ agents: { worker: agent }, store, concurrency: 2 }).run({
      scope: 'tenant',
      tasks: [
        { id: 'a', agent: 'worker', prompt: 'a' },
        { id: 'b', agent: 'worker', prompt: 'b' },
      ],
    });
    await expect(handle.result).rejects.toThrow('reservation commit failed');
    expect(model.fetch).not.toHaveBeenCalled();
  });
});

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* Optional runtime. */
}

it.skipIf(!DatabaseSync)('drains an admitted SQLite write before a concurrent close', async () => {
  const store = createSqliteSwarmStore({
    path: ':memory:',
    database: new DatabaseSync!(':memory:'),
  });
  const initial: SwarmSnapshot = {
    run: {
      kind: 'deuz-swarm',
      version: 1,
      scope: 'tenant',
      runId: 'close-race',
      definitionVersion: '1',
      status: 'running',
      revision: 0,
      lastSequence: 0,
      createdAt: 1,
      updatedAt: 1,
      cancelRequested: false,
    },
    tasks: [],
  };
  const write = store.create(initial, []);
  const close = store.close();
  const [written, closed] = await Promise.allSettled([write, close]);
  expect(written.status).toBe('fulfilled');
  expect(closed.status).toBe('fulfilled');
  await expect(store.load(initial.run)).rejects.toThrow('closed');
});
