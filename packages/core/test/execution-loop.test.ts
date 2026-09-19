import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/generate';
import { agentTool } from '../src/inference/agent-tool';
import { createExecutionContext } from '../src/execution-policy';
import {
  createApprovalSigner,
  createInMemorySessionStore,
  resumeFromCheckpoint,
} from '../src/durable';
import { createMockModel, sseResponse, sseEvents, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { CommonCallOptions } from '../src/types/config';
import type { SessionStore } from '../src/types/session';

const schema = { type: 'object' as const, properties: {} };
const messages = [{ role: 'user' as const, content: 'work' }];
function model(responses: MockResponse[], id = 'mock-model') {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  return { value: attachConfig({ ...base, modelId: id }, { ...config, fetch }), fetch };
}
async function invoke(options: CommonCallOptions, streaming: boolean) {
  if (!streaming) return generateText(options);
  const result = streamChat(options);
  let failure: unknown;
  for await (const part of result.fullStream) if (part.type === 'error') failure = part.error;
  await result.consume!();
  if (failure) throw failure;
  return { usage: await result.usage };
}

describe.each([false, true])('native execution propagation (streaming=%s)', (streaming) => {
  it('rejects forbidden models before dispatch', async () => {
    const m = model([{ text: 'must not run' }]);
    await expect(
      invoke(
        {
          model: m.value,
          messages,
          tools: {},
          execution: createExecutionContext({
            policy: { allowedModels: [] },
          }),
        },
        streaming,
      ),
    ).rejects.toThrow();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('stops strict persistence failure before the next model call', async () => {
    const m = model([{ toolCalls: [{ toolName: 'read', args: {} }] }, { text: 'done' }]);
    const store: SessionStore = {
      load: () => undefined,
      save: () => {
        throw new Error('disk full');
      },
    };
    await expect(
      invoke(
        {
          model: m.value,
          messages,
          maxSteps: 4,
          tools: { read: { parameters: schema, execute: () => 'read' } },
          session: { store, runId: 'strict', durability: 'strict' },
        },
        streaming,
      ),
    ).rejects.toThrow('could not be committed');
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates child checkpoint failures instead of self-healing', async () => {
    const child = model([{ text: 'child answer' }]);
    const parent = model([
      { toolCalls: [{ toolName: 'worker', args: { prompt: 'go' } }] },
      { text: 'wrong success' },
    ]);
    const store: SessionStore = {
      load: () => undefined,
      save: () => {
        throw new Error('offline');
      },
    };
    await expect(
      invoke(
        {
          model: parent.value,
          messages,
          maxSteps: 4,
          tools: { worker: agentTool({ name: 'worker', description: 'work', model: child.value }) },
          session: { store, runId: 'parent', durability: 'strict' },
        },
        streaming,
      ),
    ).rejects.toThrow('could not be committed');
    expect(parent.fetch).toHaveBeenCalledTimes(1);
    expect(child.fetch).toHaveBeenCalledTimes(1);
  });

  it('prices actual models once across nested agents', async () => {
    const child = model([{ text: 'child answer' }], 'child');
    const parent = model(
      [{ toolCalls: [{ toolName: 'worker', args: { prompt: 'go' } }] }, { text: 'done' }],
      'parent',
    );
    const execution = createExecutionContext({});
    const result = await invoke(
      {
        model: parent.value,
        messages,
        maxSteps: 4,
        execution,
        tools: { worker: agentTool({ name: 'worker', description: 'work', model: child.value }) },
        deps: {
          priceProvider: {
            priceUsage: (id, usage) => usage.totalTokens * (id === 'child' ? 2 : 1),
          },
        },
      },
      streaming,
    );
    expect(result.usage.totalTokens).toBe(45);
    expect(execution.ledger.totals().spent).toEqual({ tokens: 45, usd: 60 });
    expect(execution.ledger.snapshot().reservations).toHaveLength(3);
  });

  it('enforces shared child depth and tool restrictions', async () => {
    const execute = vi.fn(() => 'unsafe');
    const m = model([{ toolCalls: [{ toolName: 'unsafe', args: {} }] }]);
    await expect(
      invoke(
        {
          model: m.value,
          messages,
          maxSteps: 3,
          tools: { unsafe: { parameters: schema, execute } },
          execution: createExecutionContext({ policy: { allowedTools: [] } }),
        },
        streaming,
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

it('does not publish a strict approval before its checkpoint commits', async () => {
  const m = model([{ toolCalls: [{ toolName: 'pay', args: {} }] }]);
  const result = streamChat({
    model: m.value,
    messages,
    tools: { pay: { parameters: schema, execute: () => 'paid', needsApproval: true } },
    session: {
      runId: 'x',
      durability: 'strict',
      store: {
        load: () => undefined,
        save: () => {
          throw new Error('offline');
        },
      },
    },
  });
  const types: string[] = [];
  for await (const part of result.fullStream) types.push(part.type);
  expect(types).toContain('error');
  expect(types).not.toContain('tool-approval-request');
  expect(types).not.toContain('finish');
});

it('keeps child approval tokens through suspension and valid resume without double usage', async () => {
  const execute = vi.fn(() => 'paid');
  const child = model([
    { toolCalls: [{ toolName: 'pay', id: 'payment', args: {} }] },
    { text: 'paid' },
  ]);
  const parent = model([
    { toolCalls: [{ toolName: 'worker', id: 'delegation', args: { prompt: 'pay' } }] },
    { text: 'done' },
  ]);
  const store = createInMemorySessionStore();
  const signer = createApprovalSigner({ secret: 'test secret' });
  const execution = createExecutionContext({});
  const tools = {
    worker: agentTool({
      name: 'worker',
      description: 'work',
      model: child.value,
      tools: { pay: { parameters: schema, execute, needsApproval: true } },
    }),
  };
  const first = await generateText({
    model: parent.value,
    messages,
    tools,
    maxSteps: 4,
    execution,
    approvalSigner: signer,
    session: { store, runId: 'root', durability: 'strict' },
  });
  const approval = first.pendingApprovals![0]!;
  expect(approval.token).toBeTruthy();
  expect((await signer.verify(approval.token!))?.runId).toBe('root::worker#delegation');
  expect(first.usage.totalTokens).toBe(30);
  const second = await resumeFromCheckpoint(store, 'root', {
    model: parent.value,
    tools,
    maxSteps: 4,
    execution,
    approvalSigner: signer,
    approvalResponses: [{ approvalId: approval.approvalId, approved: true, token: approval.token }],
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(second.usage.totalTokens).toBe(30);
  expect(execution.ledger.totals().spent.tokens).toBe(60);
});

it('rejects a signed token for changed arguments', async () => {
  const execute = vi.fn(() => 'paid');
  const signer = createApprovalSigner({ secret: 'test secret' });
  const token = await signer.sign(
    { approvalId: 'pay', toolCallId: 'pay', toolName: 'pay', input: { amount: 1 } },
    { runId: 'x' },
  );
  await generateText({
    model: model([{ text: 'denied' }]).value,
    messages: [
      ...messages,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'pay', name: 'pay', input: { amount: 100 } }],
      },
    ],
    tools: { pay: { parameters: schema, execute, needsApproval: true } },
    maxSteps: 2,
    execution: createExecutionContext({}),
    approvalSigner: signer,
    session: { store: createInMemorySessionStore(), runId: 'x' },
    approvalResponses: [{ approvalId: 'pay', approved: true, token }],
  });
  expect(execute).not.toHaveBeenCalled();
});

it('admits only one concurrent request competing for the last reservation', async () => {
  const execution = createExecutionContext({ budget: { tokens: 20 } });
  const m = model([{ text: 'done' }]);
  const options = { model: m.value, messages, execution, executionEstimate: { tokens: 15 } };
  const settled = await Promise.allSettled([generateText(options), generateText(options)]);
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(execution.ledger.totals().spent.tokens).toBe(15);
});

it('holds the reservation when the provider omits usage', async () => {
  const execution = createExecutionContext({ budget: { tokens: 20 } });
  const base = createMockModel({ responses: [] });
  const m = attachConfig(
    { ...base },
    {
      ...readConfig(base)!,
      fetch: async () =>
        sseResponse([
          sseEvents([
            { data: { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] } },
            { data: '[DONE]' },
          ]),
        ]),
    },
  );
  await generateText({ model: m, messages, execution, executionEstimate: { tokens: 20 } });
  expect(execution.ledger.totals()).toMatchObject({
    spent: { tokens: 0 },
    reserved: { tokens: 20 },
    unknownTokens: 1,
  });
  await expect(
    generateText({ model: m, messages, execution, executionEstimate: { tokens: 1 } }),
  ).rejects.toThrow('budget exceeded');
});

it('holds unknown network attempts instead of retrying them for free', async () => {
  const execution = createExecutionContext({ budget: { tokens: 20 } });
  const base = createMockModel({ responses: [] });
  const fetch = vi.fn(async () => {
    throw new Error('connection lost');
  });
  const m = attachConfig({ ...base }, { ...readConfig(base)!, fetch });
  await expect(
    generateText({
      model: m,
      messages,
      execution,
      executionEstimate: { tokens: 20 },
      maxRetries: 1,
      deps: {
        clock: {
          now: () => 0,
          setTimeout: (fn) => {
            queueMicrotask(fn);
            return () => {};
          },
        },
      },
      timeout: { totalMs: 0, ttftMs: 0 },
    }),
  ).rejects.toThrow('budget exceeded');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(execution.ledger.totals().unknownTokens).toBe(1);
});
