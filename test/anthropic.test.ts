import { describe, it, expect } from 'vitest';
import { streamChat, generateText, generateObject } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const TEXT_STREAM = sseEvents([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 25,
          output_tokens: 1,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 0,
        },
      },
    },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think.' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'SIG123' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 12 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function model(chunks: string[]) {
  const { fetch, calls } = mockFetch(() => sseResponse(chunks));
  return { provider: createAnthropic({ apiKey: 'test', fetch }), calls };
}

describe('Anthropic streamChat (vertical slice)', () => {
  it('streams text, reasoning(+signature), usage and finishReason', async () => {
    const { provider } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });

    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);

    expect(parts.map((p) => p.type)).toEqual([
      'reasoning-delta',
      'reasoning-delta',
      'text-delta',
      'text-delta',
      'finish',
    ]);
    const sig = parts.find((p) => p.type === 'reasoning-delta' && p.signature);
    expect(sig && sig.type === 'reasoning-delta' && sig.signature).toBe('SIG123');

    const usage = await result.usage;
    expect(usage).toEqual({
      inputTokens: 25,
      outputTokens: 12,
      reasoningTokens: 0,
      cachedReadTokens: 10,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 47,
    });
    expect(await result.finishReason).toBe('stop');
  });

  it('textStream yields only the text projection', async () => {
    const { provider } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('Hello world');
  });

  it('sends x-api-key + anthropic-version and a system slot', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    for await (const _ of result.fullStream) void _;
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.system).toBe('be brief');
    expect(body.messages).toHaveLength(1);
    expect(body.max_tokens).toBe(128_000);
  });

  it('streamChat returns synchronously and does not throw on a missing key', async () => {
    const { fetch } = mockFetch(() => sseResponse([TEXT_STREAM]));
    // No api key anywhere → must surface via the stream, not a sync throw.
    const m = { provider: 'anthropic', modelId: 'claude-opus-4-8', surface: 'anthropic' as const };
    void fetch;
    const result = streamChat({ model: m, messages: [{ role: 'user', content: 'hi' }] });
    await expect(
      (async () => {
        for await (const _ of result.fullStream) void _;
      })(),
    ).resolves.toBeUndefined(); // fullStream yields an error part then ends (no throw)
    await expect(result.usage).rejects.toMatchObject({ code: 'authentication' });
  });
});

describe('Anthropic generateText (buffered, single-turn)', () => {
  it('buffers text + preserves reasoning/signature in response.messages', async () => {
    const { provider } = model([TEXT_STREAM]);
    const res = await generateText({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('Hello world');
    expect(res.finishReason).toBe('stop');
    const content = res.response.messages[0]!.content as Array<{
      type: string;
      signature?: string;
    }>;
    expect(content[0]).toMatchObject({ type: 'reasoning', signature: 'SIG123' });
    expect(content[1]).toMatchObject({ type: 'text' });
  });
});

describe('Anthropic generateObject (json mode)', () => {
  const JSON_STREAM = sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '{"city":' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '"Paris"}' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const schema: JSONSchema = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  };

  it('parses a JSON object via native output_config', async () => {
    const { provider, calls } = model([JSON_STREAM]);
    const res = await generateObject({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'capital of France?' }],
      schema,
    });
    expect(res.object).toEqual({ city: 'Paris' });

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });
});

// --- 0.2.0: effort wire, usage extensions, refusal stop_details ---

function lastBody(calls: { url: string; init?: RequestInit }[]): Record<string, unknown> {
  return JSON.parse(String(calls[calls.length - 1]!.init!.body)) as Record<string, unknown>;
}

const TEXT_STREAM_JSON = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '{"a":"x"}' },
    },
  },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('Anthropic effort wire (0.2.0)', () => {
  it('fable-5: effort → output_config.effort, no thinking block, sampling stripped', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
      temperature: 0.2,
      topP: 0.9,
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(128_000); // caps.maxOutput, no budget bump
  });

  it('fable-5 without effort sends neither thinking nor output_config', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('opus-4-6 keeps the legacy budget_tokens path; xhigh/max map to 48k', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-6'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 48_000 });
    expect(body.output_config).toBeUndefined();
  });

  it('output_config.effort merges with json structured-output format', async () => {
    const { provider, calls } = model([TEXT_STREAM_JSON]);
    await generateObject({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
      schema: { type: 'object', properties: { a: { type: 'string' } } } as JSONSchema,
    });
    const body = lastBody(calls);
    const oc = body.output_config as Record<string, unknown>;
    expect(oc.effort).toBe('high');
    expect(oc.format).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { a: { type: 'string' } } },
    });
  });
});

describe('Anthropic usage extensions (0.2.0)', () => {
  it('maps output_tokens_details.thinking_tokens to reasoningTokens', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const usage = await result.usage;
    expect(usage.reasoningTokens).toBe(7);
    expect(usage.outputTokens).toBe(20); // thinking stays inside output_tokens (billing unchanged)
    expect(usage.totalTokens).toBe(30);
  });

  it('sums usage.iterations when present (fallbacks/compaction)', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 20,
            iterations: [
              { type: 'message', input_tokens: 10, output_tokens: 3 },
              { type: 'fallback_message', input_tokens: 12, output_tokens: 20 },
            ],
          },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const usage = await result.usage;
    // Iterations replace the top-level attempt view: inputs and outputs sum across attempts.
    expect(usage.inputTokens).toBe(22);
    expect(usage.outputTokens).toBe(23);
    expect(usage.totalTokens).toBe(45);
  });
});
