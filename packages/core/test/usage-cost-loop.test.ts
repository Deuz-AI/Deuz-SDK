import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/generate';
import { costExceeds } from '../src/inference/stop';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createInMemorySessionStore, resumeStreamFromCheckpoint } from '../src/durable';
import type { StreamPart } from '../src/types/stream';

const schema = { type: 'object' as const, properties: {} };
const messages = [{ role: 'user' as const, content: 'work' }];
const tools = { read: { parameters: schema, execute: () => 'read' } };

describe.each([false, true])('per-invocation legacy cost (streaming=%s)', (streaming) => {
  it('prices prepareStep model changes before applying cumulative stops', async () => {
    const a = createMockModel({ responses: [{ toolCalls: [{ toolName: 'read', args: {} }] }] });
    const source = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'read', args: {} }] }],
    });
    const b = attachConfig({ ...source, modelId: 'expensive' }, readConfig(source)!);
    const priceUsage = vi.fn(
      (id: string, usage: { totalTokens: number }) =>
        usage.totalTokens * (id === 'expensive' ? 10 : 1),
    );
    const options = {
      model: a,
      messages,
      tools,
      maxSteps: 10,
      stopWhen: costExceeds(100),
      prepareStep: ({ stepIndex }: { stepIndex: number }) =>
        stepIndex > 0 ? { model: b } : undefined,
      deps: { priceProvider: { priceUsage } },
    };
    if (streaming) {
      const parts: StreamPart[] = [];
      for await (const part of streamChat(options).fullStream) parts.push(part);
      expect(parts.filter((p) => p.type === 'step-start')).toHaveLength(2);
      expect(parts.filter((p) => p.type === 'cost').map((p) => p.costUsd)).toEqual([15, 165]);
    } else {
      const result = await generateText(options);
      expect(result.steps).toHaveLength(2);
      expect(result.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'costExceeds' });
    }
    expect(priceUsage.mock.calls.map(([id]) => id)).toContain('expensive');
  });
});

it('retains historical settled cost when prices change between approval legs', async () => {
  const store = createInMemorySessionStore();
  const model = createMockModel({
    responses: [{ toolCalls: [{ toolName: 'pay', id: 'payment', args: {} }] }, { text: 'paid' }],
  });
  const gated = { pay: { parameters: schema, execute: () => 'paid', needsApproval: true } };
  let rate = 1;
  const deps = {
    priceProvider: {
      priceUsage: (_id: string, usage: { totalTokens: number }) => usage.totalTokens * rate,
    },
  };
  await generateText({
    model,
    messages,
    tools: gated,
    maxSteps: 3,
    deps,
    session: { store, runId: 'cost' },
  });
  expect((await store.load('cost'))?.cost?.pricedUsd).toBe(15);
  rate = 10;
  const result = resumeStreamFromCheckpoint(store, 'cost', {
    model,
    tools: gated,
    maxSteps: 3,
    deps,
    approvalResponses: [{ approvalId: 'payment', approved: true }],
  });
  const costs: Array<Extract<StreamPart, { type: 'cost' }>> = [];
  for await (const part of result.fullStream) if (part.type === 'cost') costs.push(part);
  expect(costs).toHaveLength(1);
  expect(costs[0]).toMatchObject({ costUsd: 165, deltaUsd: 150 });
  expect((await store.load('cost'))?.cost?.pricedUsd).toBe(165);
});
