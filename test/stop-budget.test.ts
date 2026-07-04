import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { totalTokensExceed, costExceeds } from '../src/inference/stop';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import type { Usage } from '../src/types/usage';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

/** Tool-calling turn: usage totals 15 (10 in + 5 out). Repeats forever via mockFetchSequence. */
const TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const TOOLS = {
  search: { description: 'Search', parameters: SCHEMA, execute: vi.fn(async () => 'result') },
};

function makeLogger() {
  const noop = (_message: string, _fields?: Record<string, unknown>): void => {};
  return { debug: vi.fn(noop), info: vi.fn(noop), warn: vi.fn(noop), error: vi.fn(noop) };
}

describe('totalTokensExceed', () => {
  it('stops the loop on cumulative REAL usage and marks stoppedBy metadata', async () => {
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 10,
      stopWhen: totalTokensExceed(20), // step1: 15 < 20 → continue; step2: 30 ≥ 20 → stop
    });
    expect(calls).toHaveLength(2);
    expect(res.usage.totalTokens).toBe(30);
    expect(res.finishReason).toBe('tool_calls'); // FinishReason lock: budget stop does NOT invent a reason
    expect(res.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'totalTokensExceed' });
  });

  it('plain maxSteps bound does NOT set stoppedBy (implicit condition, todays behavior)', async () => {
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 2,
    });
    expect(calls).toHaveLength(2);
    expect(res.providerMetadata).toBeUndefined();
  });
});

describe('costExceeds', () => {
  it('stops on priceProvider USD and passes the model id', async () => {
    const priceUsage = vi.fn((_model: string, usage: Usage) => usage.totalTokens * 0.02);
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 10,
      stopWhen: costExceeds(0.5), // step1: $0.30 → continue; step2: $0.60 → stop
      deps: { priceProvider: { priceUsage } },
    });
    expect(calls).toHaveLength(2);
    expect(priceUsage).toHaveBeenCalledWith('claude-opus-4-8', expect.anything());
    expect(res.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'costExceeds' });
  });

  it('without a priceProvider: warns once, condition stays inert, loop hits maxSteps', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 2,
      stopWhen: costExceeds(0.5),
      deps: { logger },
    });
    expect(calls).toHaveLength(2); // ran to the maxSteps bound
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(res.providerMetadata).toBeUndefined();
  });
});

describe('streaming parity', () => {
  it('budget stop surfaces stoppedBy on the finish part', async () => {
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 10,
      stopWhen: totalTokensExceed(20),
    });
    let finishMeta: Record<string, unknown> | undefined;
    for await (const part of res.fullStream) {
      if (part.type === 'finish') finishMeta = part.providerMetadata;
    }
    expect(calls).toHaveLength(2);
    expect(finishMeta?.deuz).toMatchObject({ stoppedBy: 'totalTokensExceed' });
    await expect(res.usage).resolves.toMatchObject({ totalTokens: 30 });
  });

  it('finish part carries NO providerMetadata when only maxSteps bounded (regression)', async () => {
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 2,
    });
    for await (const part of res.fullStream) {
      if (part.type === 'finish') expect(part.providerMetadata).toBeUndefined();
    }
  });
});
