/**
 * dispatch-narrowing.test.ts (2.3, roadmap 23.2) — a child of a run only ever
 * narrows what the run may do. A sub-agent, a handoff target and a spawned
 * swarm task run under the parent's tool and model policy, its deadline, its
 * cancellation and its budget; none of them can widen any of it.
 *
 * (Evolve's mutation calls are children of the evolve run's context; that
 * their policy, deadline and budget hold is pinned in evolve.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/generate';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import { createExecutionContext } from '../src/execution-policy';
import { runAgent } from '../src/agent-run';
import { createAgent } from '../src/agent';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';

const parameters = { type: 'object' as const, properties: {} };
const user: Message = { role: 'user', content: 'go' };

/** A mock model with its own id whose provider calls are counted. */
function counted(modelId: string, responses: MockResponse[]) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  let calls = 0;
  const aborted: boolean[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    aborted.push(init?.signal?.aborted === true);
    return config.fetch!(input, init);
  }) as typeof fetch;
  const model: LanguageModel = attachConfig(
    { provider: 'mock', modelId, surface: 'chat_completions' },
    { ...config, fetch: fetchImpl },
  );
  return { model, calls: () => calls, aborted };
}

const delegate: MockResponse = {
  toolCalls: [{ toolName: 'worker', id: 'w1', args: { prompt: 'do it' } }],
};

describe('a sub-agent narrows the parent run', () => {
  it('cannot call a tool the parent’s execution policy does not allow', async () => {
    const danger = vi.fn(async () => 'boom');
    const child = counted('child', [{ toolCalls: [{ toolName: 'danger', id: 'd1', args: {} }] }]);
    await expect(
      generateText({
        model: createMockModel({ responses: [delegate, { text: 'parent done' }] }),
        messages: [user],
        maxSteps: 4,
        tools: {
          worker: agentTool({
            name: 'worker',
            description: 'w',
            model: child.model,
            tools: { danger: { parameters, execute: danger } },
          }),
        },
        execution: createExecutionContext({ policy: { allowedTools: ['worker'] } }),
      }),
    ).rejects.toMatchObject({ name: 'ExecutionPolicyError', code: 'tool_not_allowed' });
    expect(danger).not.toHaveBeenCalled();
  });

  it('runs out of the parent’s time: a deadline that passes inside the child stops it', async () => {
    let now = 0;
    const clock = { now: () => now, setTimeout: () => () => {} };
    const child = counted('child', [
      { toolCalls: [{ toolName: 'tick', id: 't1', args: {} }] },
      { text: 'child done' },
    ]);
    await expect(
      generateText({
        model: createMockModel({ responses: [delegate, { text: 'parent done' }] }),
        messages: [user],
        maxSteps: 4,
        deps: { clock },
        tools: {
          worker: agentTool({
            name: 'worker',
            description: 'w',
            model: child.model,
            tools: {
              tick: {
                parameters,
                execute: async () => {
                  now = 100;
                  return 'later';
                },
              },
            },
          }),
        },
        execution: createExecutionContext({ policy: { deadlineAt: 50 } }),
      }),
    ).rejects.toMatchObject({ name: 'ExecutionPolicyError', code: 'deadline_exceeded' });
    // The child's second model call was refused before it was sent.
    expect(child.calls()).toBe(1);
  });

  it('spends from the parent’s ledger, under a scope of its own', async () => {
    const execution = createExecutionContext({ budget: { tokens: 100_000 } });
    const child = counted('child', [{ text: 'child done' }]);
    await generateText({
      model: createMockModel({ responses: [delegate, { text: 'parent done' }] }),
      messages: [user],
      maxSteps: 4,
      tools: { worker: agentTool({ name: 'worker', description: 'w', model: child.model }) },
      execution,
    });
    expect(child.calls()).toBe(1);
    const reservations = execution.ledger.snapshot().reservations;
    expect(reservations.filter((r) => r.modelId === 'child')).toHaveLength(1);
    const childScopes = reservations.find((r) => r.modelId === 'child')!.scopes.map((s) => s.id);
    expect(childScopes[0]).toBe(execution.scopeId);
    expect(childScopes.length).toBe(2);
    expect(execution.ledger.totals().spent.tokens).toBe(45);
  });

  it('stops with the parent’s cancellation', async () => {
    const controller = new AbortController();
    const child = counted('child', [
      { toolCalls: [{ toolName: 'stop', id: 's1', args: {} }] },
      { text: 'never' },
    ]);
    await generateText({
      model: createMockModel({ responses: [delegate, { text: 'parent done' }] }),
      messages: [user],
      maxSteps: 4,
      signal: controller.signal,
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'w',
          model: child.model,
          tools: {
            stop: {
              parameters,
              execute: async () => {
                controller.abort();
                return 'stopped';
              },
            },
          },
        }),
      },
    });
    // Every request the child makes after the cancel carries the parent's aborted
    // signal, so the transport never sends it.
    expect(child.aborted[0]).toBe(false);
    expect(child.aborted.slice(1).every(Boolean)).toBe(true);
  });
});

describe('a handoff target narrows the run it takes over', () => {
  const transfer: MockResponse = {
    toolCalls: [{ toolName: 'transfer_to_billing', id: 't1', args: {} }],
  };

  it('its model must be one the run’s policy allows', async () => {
    const billing = counted('billing-model', [{ text: 'billing here' }]);
    const root = counted('root-model', [transfer, { text: 'root' }]);
    const result = await runAgent({
      model: root.model,
      prompt: 'invoice',
      tools: handoff({ billing: { model: billing.model } }),
      execution: createExecutionContext({
        policy: { allowedModels: ['root-model'], allowedTools: ['transfer_to_billing'] },
      }),
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'model_not_allowed' } });
    expect(billing.calls()).toBe(0);
  });

  it('its own tools are held to the run’s tool policy', async () => {
    const refund = vi.fn(async () => 'refunded');
    const billing = counted('billing-model', [
      { toolCalls: [{ toolName: 'refund', id: 'r1', args: {} }] },
      { text: 'done' },
    ]);
    const result = await runAgent({
      model: counted('root-model', [transfer]).model,
      prompt: 'refund me',
      tools: handoff({
        billing: { model: billing.model, tools: { refund: { parameters, execute: refund } } },
      }),
      execution: createExecutionContext({ policy: { allowedTools: ['transfer_to_billing'] } }),
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'tool_not_allowed' } });
    expect(refund).not.toHaveBeenCalled();
  });

  it('spends from the run’s own ledger', async () => {
    const billing = counted('billing-model', [{ text: 'billing here' }]);
    const execution = createExecutionContext({ budget: { tokens: 100_000 } });
    const result = await runAgent({
      model: counted('root-model', [transfer]).model,
      prompt: 'invoice',
      tools: handoff({ billing: { model: billing.model } }),
      execution,
    });
    expect(result).toMatchObject({ status: 'completed', output: 'billing here' });
    const models = execution.ledger.snapshot().reservations.map((r) => r.modelId);
    expect(models).toEqual(['root-model', 'billing-model']);
  });
});

describe('a spawned swarm task narrows the swarm run', () => {
  const plannerOutput = {
    schema: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' } } },
      required: ['steps'],
    },
    mode: 'json' as const,
    validate: (value: unknown) => value as { steps: string[] },
  };

  it('a spawned worker is held to the swarm’s tool policy', async () => {
    const write = vi.fn(async () => 'written');
    const planner = createAgent({
      model: createMockModel({ responses: [{ text: '{"steps":["x"]}' }] }),
    });
    const worker = createAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'write', id: 'w1', args: {} }] }, { text: 'ok' }],
      }),
      tools: { write: { parameters, execute: write } },
    });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      dynamic: { maxTasks: 10, maxSpawnDepth: 2 },
      policy: { allowedTools: [] },
      agents: {
        planner: {
          agent: planner,
          output: plannerOutput,
          spawn: (output) =>
            (output as { steps: string[] }).steps.map((step) => ({
              key: step,
              agent: 'worker',
              prompt: `Do ${step}.`,
            })),
        },
        worker,
      },
    });
    const outcome = await (
      await swarm.run({ scope: 't', tasks: [{ id: 'plan', agent: 'planner', prompt: 'Plan.' }] })
    ).result;
    const spawned = outcome.tasks.find((task) => task.task.id === 'plan/x');
    expect(spawned?.status).toBe('failed');
    expect(spawned?.error).toMatchObject({ code: 'tool_not_allowed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('a spawned worker spends from the swarm’s budget', async () => {
    const planner = createAgent({
      model: createMockModel({ responses: [{ text: '{"steps":["x"]}' }] }),
    });
    const worker = createAgent({ model: createMockModel({ responses: [{ text: 'x done' }] }) });
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      dynamic: { maxTasks: 10, maxSpawnDepth: 2 },
      budget: { tokens: 100_000 },
      agents: {
        planner: {
          agent: planner,
          output: plannerOutput,
          spawn: (output) =>
            (output as { steps: string[] }).steps.map((step) => ({
              key: step,
              agent: 'worker',
              prompt: `Do ${step}.`,
            })),
        },
        worker,
      },
    });
    const outcome = await (
      await swarm.run({ scope: 't', tasks: [{ id: 'plan', agent: 'planner', prompt: 'Plan.' }] })
    ).result;
    expect(outcome.run.status).toBe('completed');
    const state = outcome.run.executionState!;
    const spent =
      state.ledger.reservations.reduce((sum, r) => sum + (r.actual?.tokens ?? 0), 0) +
      (state.ledger.aggregates ?? []).reduce((sum, a) => sum + a.spent.tokens, 0);
    // The planner's and the spawned worker's calls, all on the swarm's ledger.
    expect(spent).toBe(30);
  });
});
