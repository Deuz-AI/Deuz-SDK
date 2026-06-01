import { describe, it, expect, vi } from 'vitest';
import { streamChat } from '../src/index';
import { toDeuzStreamResponse, readDeuzStream } from '../src/ui';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetch, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

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
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'getWeather' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const FINAL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
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
      delta: { type: 'text_delta', text: 'Sunny in Paris.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('Deuz UI wire', () => {
  it('serializes a plain stream and round-trips via readDeuzStream', async () => {
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const response = toDeuzStreamResponse(result, { messageId: 'm1' });

    expect(response.headers.get('x-deuz-stream')).toBe('v1');
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);

    expect(parts[0]).toEqual({ type: 'start', messageId: 'm1' });
    expect(parts.at(-1)?.type).toBe('finish');
    const text = parts
      .filter((p): p is Extract<typeof p, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('Sunny in Paris.');
  });

  it('emits tool-call + tool-result UI parts across an agentic stream', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });
    const response = toDeuzStreamResponse(result);

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);

    const types = parts.map((p) => p.type);
    expect(types).toContain('step-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types.at(-1)).toBe('finish');

    const call = parts.find(
      (p): p is Extract<typeof p, { type: 'tool-call' }> => p.type === 'tool-call',
    );
    expect(call).toMatchObject({ toolName: 'getWeather', input: { city: 'Paris' } });
  });

  it('redacts secrets in the error part', async () => {
    const errStream = sseEvents([
      {
        event: 'error',
        data: {
          type: 'error',
          error: { type: 'api_error', message: 'boom sk-ant-SECRETxyz1234567' },
        },
      },
    ]);
    const { fetch } = mockFetch(() => sseResponse([errStream]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const response = toDeuzStreamResponse(result);

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);
    const err = parts.find((p): p is Extract<typeof p, { type: 'error' }> => p.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).not.toContain('SECRETxyz');
  });
});
