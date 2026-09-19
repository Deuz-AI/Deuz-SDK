import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent';
import { createExecutionContext } from '../src/execution-policy';
import { createMockModel } from '../src/testing';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import type { SwarmStore } from '../src/types/swarm';

describe('swarm native agent integration', () => {
  it('blocks dependent work when the native verifier cannot certify an output', async () => {
    const reduce = vi.fn(() => 'must not run');
    const verify = vi.fn(() => ({
      status: 'inconclusive' as const,
      reason: 'checker unavailable',
    }));
    const swarm = createSwarm({
      agents: {
        worker: {
          agent: createAgent({ model: createMockModel({ responses: [{ text: 'candidate' }] }) }),
          verify,
        },
      },
      reducers: { accept: { execute: reduce } },
      store: createInMemorySwarmStore(),
    });
    const result = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'a', agent: 'worker', prompt: 'answer' },
          { id: 'b', reducer: 'accept', dependsOn: ['a'] },
        ],
      })
    ).result;
    expect(verify).toHaveBeenCalledOnce();
    expect(result.tasks.map((task) => task.status)).toEqual(['failed', 'blocked']);
    expect(reduce).not.toHaveBeenCalled();
  });

  it('uses binding-scoped native context and keeps raw tool results separate from projections', async () => {
    const execute = vi.fn((_args: unknown, ctx: { context?: unknown }) => ({
      tenant: ctx.context,
      secret: 'private data',
    }));
    const swarm = createSwarm({
      agents: {
        worker: {
          agent: createAgent({
            model: createMockModel({
              responses: [{ toolCalls: [{ toolName: 'lookup', args: {} }] }, { text: 'done' }],
            }),
          }),
          tools: {
            lookup: {
              parameters: { type: 'object', properties: {} },
              validateContext(value) {
                if (value !== 'tenant-a') throw new Error('Wrong tenant');
                return value;
              },
              execute,
              toModelOutput: () => 'public answer',
            },
          },
          toolsContext: { lookup: 'tenant-a' },
        },
      },
      store: createInMemorySwarmStore(),
    });
    const result = await (
      await swarm.run({
        scope: 'tenant-a',
        tasks: [{ id: 'a', agent: 'worker', prompt: 'lookup' }],
      })
    ).result;
    expect(result.run.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
    expect(Object.values(result.tasks[0]!.agentState!.toolResults!)[0]).toMatchObject({
      stage: 'completed',
      rawResult: { tenant: 'tenant-a', secret: 'private data' },
      modelOutput: 'public answer',
    });
  });

  it('rejects a pre-bound execution context instead of discarding its mandatory restrictions', async () => {
    const store = createInMemorySwarmStore();
    const create = vi.spyOn(store, 'create');
    const agent = createAgent({
      model: createMockModel({ responses: [] }),
      execution: createExecutionContext({ policy: { allowedTools: [] } }),
    });
    const swarm = createSwarm({ agents: { worker: agent }, store });
    await expect(
      swarm.run({ scope: 'tenant', tasks: [{ id: 'a', agent: 'worker', prompt: 'run' }] }),
    ).rejects.toThrow('pre-bound execution');
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves an agent template budget when a binding requests a higher cap', async () => {
    const agent = createAgent({
      model: createMockModel({ responses: [{ text: 'not admitted' }] }),
      budget: { tokens: 0 },
    });
    const swarm = createSwarm({
      agents: { worker: { agent, budget: { tokens: 10000 } } },
      store: createInMemorySwarmStore(),
    });
    const outcome = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'a', agent: 'worker', prompt: 'run' }] })
    ).result;
    expect(outcome.tasks[0]?.status).toBe('failed');
    expect(outcome.run.executionState?.ledger.reservations).toHaveLength(0);
  });
  it('runs isolated native agents and reduces their accepted outputs', async () => {
    const agent = createAgent({ model: createMockModel({ responses: [{ text: 'answer' }] }) });
    const swarm = createSwarm({
      agents: { worker: agent },
      store: createInMemorySwarmStore(),
      reducers: {
        join: {
          execute(results) {
            return Object.values(results)
              .map((result) => result.output)
              .join(',');
          },
        },
      },
    });
    const result = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'a', agent: 'worker', prompt: 'first' },
          { id: 'b', agent: 'worker', prompt: 'second' },
          { id: 'c', reducer: 'join', dependsOn: ['a', 'b'] },
        ],
      })
    ).result;
    expect(result.tasks.map((task) => task.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(result.tasks[2]?.result?.output).toBe('answer,answer');
    expect(result.tasks[0]?.agentState?.runId).not.toBe(result.tasks[1]?.agentState?.runId);
    expect(result.run.executionState?.ledger.reservations.length).toBe(2);
  });

  it('recovers committed native terminal output after the task terminal write fails without a model replay', async () => {
    const inner = createInMemorySwarmStore();
    let fail = true;
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        if (fail && change.events?.some((event) => event.type === 'task.completed'))
          throw new Error('crash after native checkpoint');
        return inner.commit(change);
      },
    };
    const model = createMockModel({
      responses: [{ text: 'persisted' }, { text: 'must not replay' }],
    });
    const options = { agents: { worker: createAgent({ model }) }, store };
    const handle = await createSwarm(options).run({
      scope: 'tenant',
      runId: 'native-recover',
      tasks: [{ id: 'a', agent: 'worker', prompt: 'answer' }],
    });
    await expect(handle.result).rejects.toThrow('crash after native checkpoint');
    const interrupted = await inner.load(handle);
    expect(interrupted?.tasks[0]?.agentState?.phase).toBe('terminal');
    expect(interrupted?.tasks[0]?.status).toBe('running');
    fail = false;
    const recovered = await (await createSwarm(options).resume(handle)).result;
    expect(recovered.tasks[0]?.result?.output).toBe('persisted');
    expect(recovered.run.executionState?.ledger.reservations.length).toBe(1);
  });

  it('suspends tool approval durably and resumes only the specifically approved task', async () => {
    const execute = vi.fn(() => 'written');
    const agent = createAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'write', args: {} }] }, { text: 'done' }],
      }),
      tools: {
        write: {
          description: 'write',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          needsApproval: true,
          execute,
        },
      },
    });
    const store = createInMemorySwarmStore();
    const options = { agents: { worker: agent }, store };
    const swarm = createSwarm(options);
    const first = await (
      await swarm.run({
        scope: 'tenant',
        runId: 'approval',
        tasks: [{ id: 'a', agent: 'worker', prompt: 'write' }],
      })
    ).result;
    expect(first.run.status).toBe('suspended');
    expect(execute).not.toHaveBeenCalled();
    const untouched = await (await createSwarm(options).resume(first.run)).result;
    expect(untouched.tasks[0]?.status).toBe('suspended');
    expect(execute).not.toHaveBeenCalled();
    const native = first.tasks[0]!.result!.agentResult!;
    if (native.status !== 'suspended') throw new Error('Expected suspension');
    const approved = await (
      await createSwarm(options).resume({
        ...first.run,
        approvals: {
          a: native.pendingApprovals.map((request) => ({
            approvalId: request.approvalId,
            approved: true,
          })),
        },
      })
    ).result;
    expect(approved.tasks[0]?.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('resumes task-scoped client tool results through the native loop', async () => {
    const agent = createAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'client', args: {} }] }, { text: 'client complete' }],
      }),
      tools: {
        client: { parameters: { type: 'object', properties: {}, additionalProperties: false } },
      },
    });
    const store = createInMemorySwarmStore();
    const swarm = createSwarm({ agents: { worker: agent }, store });
    const first = await (
      await swarm.run({
        scope: 'tenant',
        runId: 'client',
        tasks: [{ id: 'a', agent: 'worker', prompt: 'client' }],
      })
    ).result;
    const native = first.tasks[0]!.result!.agentResult!;
    if (native.status !== 'suspended') throw new Error('Expected client suspension');
    const recovered = await (
      await swarm.resume({
        ...first.run,
        clientToolResults: {
          a: native.pendingClientCalls.map((call) => ({
            toolCallId: call.toolCallId,
            output: { value: 42 },
          })),
        },
      })
    ).result;
    expect(recovered.tasks[0]?.status).toBe('completed');
    expect(recovered.tasks[0]?.result?.output).toBe('client complete');
  });
});
