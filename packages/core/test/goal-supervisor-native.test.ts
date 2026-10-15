/**
 * The native `RunLauncher` (2.4, spec §3.1): V3 runs through the existing
 * executor, loaded with a lazy `import()`. The executor module is mocked
 * here (its V3 overloads come from lane L3b); the mock writes V3 envelopes
 * into a real in-memory V3 store the way a run does, so the launcher's own
 * work is real: start or resume, retry, working memory, approvals, the
 * native run lease, ledger totals and maintenance.
 */
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createExecutionContext } from '../src/execution-policy';
import { createGoal } from '../src/goal';
import {
  createGoalSupervisor,
  createInMemoryGoalRuntimeStore,
  createNativeRunLauncher,
} from '../src/goal/runtime';
import type { RunLaunchRequest } from '../src/goal/runtime';
import { agentRunLeaseKey, createInMemoryLeaseProvider } from '../src/ops';
import type { AgentResult } from '../src/types/agent-run';
import type { AgentRunEnvelopeV3, AgentRunOptionsV3 } from '../src/types/agent-run-v3';
import { envelopeV3 } from './fixtures/agent-run-v3';
import { results } from './fixtures/fake-run-launcher';
import { createWorkingMemoryFixture } from './fixtures/working-memory';

const agent = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock('../src/agent-run', () => agent);

const SCOPE = 'tenant';
const T0 = Date.parse('2026-10-15T09:00:00Z');

function request(patch: Partial<RunLaunchRequest> = {}): RunLaunchRequest {
  return {
    scope: SCOPE,
    goalId: 'g-1',
    intentId: 'g-1#1',
    runId: 'g-1:run:1',
    attempt: 1,
    kind: 'start',
    goal: createGoal(
      { goalId: 'g-1', scope: SCOPE, objective: 'x', specGeneration: 1 },
      { now: T0 },
    ),
    ...patch,
  };
}

/** What a run leaves in its store when it ends with `result`. */
async function finish(
  options: AgentRunOptionsV3<unknown>,
  result: AgentResult<unknown>,
  extra: Partial<AgentRunEnvelopeV3> = {},
): Promise<AgentResult<unknown>> {
  const { store, runId, scope } = options.session;
  const stored = await store.load(runId);
  await store.save(
    envelopeV3(runId, (stored?.revision ?? 0) + 1, {
      scope,
      phase: 'terminal',
      result,
      ...extra,
    }),
  );
  return result;
}

beforeEach(() => {
  agent.runAgent.mockReset();
  agent.resumeAgent.mockReset();
});

describe('createNativeRunLauncher', () => {
  it('never imports the executor statically', async () => {
    for (const file of [
      'supervisor.ts',
      'supervisor-drive.ts',
      'supervisor-shared.ts',
      'supervisor-native.ts',
    ]) {
      const source = await readFile(
        new URL(`../src/goal/runtime/${file}`, import.meta.url),
        'utf8',
      );
      expect(source, file).not.toMatch(/from '\.\.\/\.\.\/agent-run'/);
    }
  });

  it('refuses a store that is not a V3 store', () => {
    expect(() =>
      createNativeRunLauncher({ store: {} as never, options: () => ({}) as never }),
    ).toThrow(TypeError);
  });

  it('starts a new V3 run with the inherited working memory and the native run lease', async () => {
    const store = createInMemoryAgentRunStoreV3();
    const provider = createInMemoryLeaseProvider();
    const memory = createWorkingMemoryFixture({ scope: SCOPE });
    const after = createWorkingMemoryFixture({ scope: SCOPE, revision: 9 });
    agent.runAgent.mockImplementation((options: AgentRunOptionsV3<unknown>) =>
      finish(options, results.completed(options.session.runId), { workingMemory: after }),
    );
    const options = vi.fn(() => ({ model: 'test-model', workingMemory: { tools: true } }) as never);
    const launcher = createNativeRunLauncher({ store, options, lease: { provider, ttlMs: 9_000 } });
    const approvalResponses = [{ approvalId: 'ap-1', approved: true }];
    const ran = await launcher.launch(request({ workingMemory: memory, approvalResponses }));
    expect(options).toHaveBeenCalledWith(expect.objectContaining({ runId: 'g-1:run:1' }));
    expect(agent.resumeAgent).not.toHaveBeenCalled();
    const passed = agent.runAgent.mock.calls[0]![0] as AgentRunOptionsV3<unknown>;
    expect(passed).toMatchObject({
      model: 'test-model',
      checkpointVersion: 3,
      session: { store, runId: 'g-1:run:1', scope: SCOPE },
      lease: { provider, ttlMs: 9_000 },
      workingMemory: { tools: true, snapshot: memory },
      approvalResponses,
    });
    expect(passed).not.toHaveProperty('retryFailed');
    expect(ran).toEqual({
      runId: 'g-1:run:1',
      result: results.completed('g-1:run:1'),
      workingMemory: after,
    });
  });

  it('resumes a stored run instead of starting it again, and retries a transient failure', async () => {
    const store = createInMemoryAgentRunStoreV3();
    await store.save(envelopeV3('g-1:run:1', 1, { scope: SCOPE }));
    agent.resumeAgent.mockImplementation((options: AgentRunOptionsV3<unknown>) =>
      finish(options, results.failed(options.session.runId, 'overloaded'), {
        retry: { cause: 'model-call', phase: 'running' },
      }),
    );
    const launcher = createNativeRunLauncher({ store, options: () => ({}) as never });
    const memory = createWorkingMemoryFixture({ scope: SCOPE });
    const first = await launcher.launch(request({ workingMemory: memory }));
    expect(agent.runAgent).not.toHaveBeenCalled();
    const resumed = agent.resumeAgent.mock.calls[0]![0] as AgentRunOptionsV3<unknown>;
    // A stored run keeps its own working memory.
    expect(resumed.workingMemory).toBeUndefined();
    expect(resumed).not.toHaveProperty('retryFailed');
    expect(first).toMatchObject({ retryable: true, result: { status: 'failed' } });
    agent.resumeAgent.mockImplementation((options: AgentRunOptionsV3<unknown>) =>
      finish(options, results.completed(options.session.runId)),
    );
    const clientToolResults = [{ toolCallId: 'c-1', output: 1 }];
    const retried = await launcher.resume(
      request({ kind: 'retry', attempt: 2, clientToolResults }),
    );
    expect(agent.resumeAgent.mock.calls[1]![0]).toMatchObject({
      retryFailed: true,
      clientToolResults,
    });
    expect(retried.retryable).toBeUndefined();
    expect(retried.result.status).toBe('completed');
  });

  it('reports a leg that another executor of the run refused, as nothing happened to the run', async () => {
    const store = createInMemoryAgentRunStoreV3();
    const launcher = createNativeRunLauncher({ store, options: () => ({}) as never });
    const failed = (name: string, message: string, code?: string): AgentResult<unknown> => {
      const result = results.failed('g-1:run:1') as Extract<AgentResult, { status: 'failed' }>;
      return { ...result, error: { name, message, ...(code !== undefined ? { code } : {}) } };
    };
    for (const result of [
      failed('AgentRunLeaseError', 'Another executor holds this native run.', 'lease_held'),
      failed('AgentRunLeaseError', 'This executor lost the native run lease.', 'lease_lost'),
      failed('TypeError', 'This native run already has an active executor.'),
    ]) {
      agent.runAgent.mockResolvedValueOnce(result);
      expect(await launcher.launch(request())).toEqual({
        runId: 'g-1:run:1',
        result,
        heldElsewhere: true,
      });
    }
    // Any other failure is the run's own.
    agent.runAgent.mockResolvedValueOnce(
      failed('TypeError', 'maxSteps must be a positive integer.'),
    );
    expect((await launcher.launch(request())).heldElsewhere).toBeUndefined();
  });

  it('refuses a stored run of another scope', async () => {
    const store = createInMemoryAgentRunStoreV3();
    await store.save(envelopeV3('g-1:run:1', 1, { scope: 'other' }));
    const launcher = createNativeRunLauncher({ store, options: () => ({}) as never });
    await expect(launcher.launch(request())).rejects.toMatchObject({ code: 'scope_mismatch' });
    expect(agent.resumeAgent).not.toHaveBeenCalled();
  });

  it('cancels and drains through the native run lease', async () => {
    const store = createInMemoryAgentRunStoreV3();
    const provider = createInMemoryLeaseProvider();
    const launcher = createNativeRunLauncher({
      store,
      options: () => ({}) as never,
      lease: { provider },
    });
    const key = agentRunLeaseKey({ scope: SCOPE, runId: 'g-1:run:1' });
    // Nobody holds the run: the cancel is not delivered (the supervisor keeps it).
    expect(await launcher.cancel({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(false);
    const executor = await provider.acquire({ key, owner: 'executor', ttlMs: 30_000 });
    expect(await launcher.cancel({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(true);
    expect(await launcher.drain({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(true);
    expect(await provider.renew(executor!, 30_000)).toMatchObject({
      held: true,
      signals: ['cancel', 'drain'],
    });
    const bare = createNativeRunLauncher({ store, options: () => ({}) as never });
    expect(await bare.cancel({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(false);
    expect(await bare.drain({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(false);
  });

  it('takes the goal lease of the first supervisor it is given to when created without a lease', async () => {
    const store = createInMemoryAgentRunStoreV3();
    agent.runAgent.mockImplementation((options: AgentRunOptionsV3<unknown>) =>
      finish(options, results.completed(options.session.runId)),
    );
    const provider = createInMemoryLeaseProvider();
    const own = createInMemoryLeaseProvider();
    const bare = createNativeRunLauncher({ store, options: () => ({}) as never });
    const leased = createNativeRunLauncher({
      store,
      options: () => ({}) as never,
      lease: { provider: own, ttlMs: 9_000 },
    });
    expect(await bare.drain({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(false);
    for (const launcher of [bare, leased]) {
      const goals = createInMemoryGoalRuntimeStore();
      createGoalSupervisor({ store: goals, launcher, lease: { provider, ttlMs: 6_000 } });
      // A second supervisor changes nothing.
      createGoalSupervisor({
        store: goals,
        launcher,
        lease: { provider: createInMemoryLeaseProvider() },
      });
    }
    await bare.launch(request());
    await leased.launch(request({ runId: 'g-1:run:2' }));
    const first = agent.runAgent.mock.calls[0]![0] as AgentRunOptionsV3<unknown>;
    const second = agent.runAgent.mock.calls[1]![0] as AgentRunOptionsV3<unknown>;
    expect(first.lease?.provider).toBe(provider);
    expect(first.lease?.ttlMs).toBe(6_000);
    expect(second.lease?.provider).toBe(own);
    expect(second.lease?.ttlMs).toBe(9_000);
    // Its cancel and drain now reach a run that holds its lease.
    const key = agentRunLeaseKey({ scope: SCOPE, runId: 'g-1:run:1' });
    const executor = await provider.acquire({ key, owner: 'executor', ttlMs: 30_000 });
    expect(await bare.drain({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(true);
    expect(await bare.cancel({ scope: SCOPE, runId: 'g-1:run:1' })).toBe(true);
    expect(await provider.renew(executor!, 30_000)).toMatchObject({ held: true });
  });

  it('reads the run ledger from its durable checkpoint, and its maintenance', async () => {
    const store = createInMemoryAgentRunStoreV3();
    const context = createExecutionContext();
    await context.reserve({ requestId: 'r-1', modelId: 'm', tokens: 50, usd: 0.5 });
    await context.ledger.settle({ requestId: 'r-1', tokens: 40, usd: 0.25 });
    await context.reserve({ requestId: 'r-2', modelId: 'm', tokens: 30, usd: 0.3 });
    await context.ledger.markUnknown('r-2');
    await store.save(
      envelopeV3('g-1:run:1', 1, {
        scope: SCOPE,
        execution: context.snapshot(),
        memory: {
          extraction: { status: 'pending', operationId: 'op-1' },
        } as AgentRunEnvelopeV3['memory'],
      }),
    );
    const launcher = createNativeRunLauncher({ store, options: () => ({}) as never });
    const totals = await launcher.accounting!({ scope: SCOPE, runId: 'g-1:run:1' });
    expect(totals).toEqual(context.ledger.totals(context.scopeId));
    expect(totals?.spent.tokens).toBe(40);
    expect(totals?.reserved.tokens).toBe(30);
    expect(await launcher.maintenance!({ scope: SCOPE, runId: 'g-1:run:1' })).toBe('pending');
    expect(await launcher.accounting!({ scope: 'other', runId: 'g-1:run:1' })).toBeUndefined();
    expect(await launcher.accounting!({ scope: SCOPE, runId: 'missing' })).toBeUndefined();
  });
});
