import { describe, it, expect } from 'vitest';
import { streamObject } from '../src/index';
import { NoObjectGeneratedError } from '../src/errors';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

/** Anthropic json-mode SSE streaming the object text across the given deltas. */
function anthropicJsonStream(deltas: string[]): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    ...deltas.map((text) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })),
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
}

describe('streamObject (json strategy)', () => {
  it('streams growing partial objects, then resolves the validated final', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":', '"Par', 'is"}'])]),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'capital of France?' }],
      schema: SCHEMA,
    });

    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    expect(partials).toEqual([{}, { city: 'Par' }, { city: 'Paris' }]);

    expect(await result.object).toEqual({ city: 'Paris' });
    expect((await result.usage).totalTokens).toBeGreaterThan(0);
    expect(await result.finishReason).toBe('stop');

    // json strategy rode the native structured-output config.
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('does not emit when a delta changes nothing (cut mid-key)', async () => {
    const { fetch } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{', '"ci', 'ty":"Paris"}'])]),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    // Three deltas, two emissions — the mid-key delta parsed to the same {}.
    expect(partials).toEqual([{}, { city: 'Paris' }]);
  });

  it('rejects object AND the partial stream on invalid final JSON — no repair retry', async () => {
    const { fetch, calls } = mockFetch(
      () => sseResponse([anthropicJsonStream(['{"city": "Paris"'])]), // never closed
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });

    const partials: unknown[] = [];
    await expect(
      (async () => {
        for await (const p of result.partialObjectStream) partials.push(p);
      })(),
    ).rejects.toBeInstanceOf(NoObjectGeneratedError);
    expect(partials).toEqual([{ city: 'Paris' }]); // best-effort partial WAS emitted

    await expect(result.object).rejects.toBeInstanceOf(NoObjectGeneratedError);
    await expect(result.object).rejects.toMatchObject({ text: '{"city": "Paris"' });
    // usage/finishReason still resolve — the tokens were spent.
    expect((await result.usage).totalTokens).toBeGreaterThan(0);
    expect(await result.finishReason).toBe('stop');
    expect(calls).toHaveLength(1); // documented divergence from generateObject: no repair retry
  });

  it('G2: returns synchronously and starts the pump lazily', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    expect(calls).toHaveLength(0); // nothing accessed yet — no network
    expect(await result.object).toEqual({ city: 'Paris' });
    expect(calls).toHaveLength(1);
  });

  it('surfaces transport errors as rejections, never a sync throw', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    await expect(
      (async () => {
        for await (const _ of result.partialObjectStream) void _;
      })(),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(result.object).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(result.usage).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(result.finishReason).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('streamObject (tool strategy — buffered)', () => {
  const TOOL_STREAM = sseEvents([
    {
      data: {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'json_output', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    },
    {
      data: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
    },
    { data: '[DONE]' },
  ]);

  it('emits the final validated object exactly once', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([TOOL_STREAM]));
    const result = streamObject({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      mode: 'tool',
    });
    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    expect(partials).toEqual([{ city: 'Paris' }]); // single buffered emission
    expect(await result.object).toEqual({ city: 'Paris' });

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.tool_choice).toBeDefined(); // tool coercion rode the wire
  });
});
