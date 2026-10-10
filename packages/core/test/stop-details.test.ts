/**
 * stop-details.test.ts (2.3, F16 follow-up) — the provider's explanation of a
 * stop on every single-turn result.
 *
 * `GenerateTextResult`, the `finish` / `step-finish` parts and `AgentResult`
 * carried `stopDetails` since wave 1. `streamChat`, `generateObject` and
 * `streamObject` dropped it: a refused structured request was invisible
 * unless the caller dug the raw object out of the finish part's
 * `providerMetadata`. They now report it with the same normalization.
 *
 * Anthropic sends `stop_details` only with `stop_reason: 'refusal'` (Claude API
 * reference, cached 2026-10-06); the fixtures follow that shape. Not
 * live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateObject, generateText, streamChat, streamObject } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { NoObjectGeneratedError } from '../src/errors';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

const REFUSAL = {
  type: 'refusal',
  category: 'cyber',
  explanation: 'The request asks for working malware.',
};

/** One Anthropic answer: `text`, then the given stop reason and raw `stop_details`. */
function answer(text: string, stopReason: string, stopDetails?: unknown): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}),
        },
        usage: { output_tokens: 3 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function claude(body: string | (() => Response)) {
  const { fetch, calls } = mockFetch(typeof body === 'string' ? () => sseResponse([body]) : body);
  return { model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'), calls };
}

const messages = [{ role: 'user' as const, content: 'hi' }];
const OBJ = {
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
};

describe('streamChat: stopDetails', () => {
  it('resolves with the refusal explanation', async () => {
    const { model } = claude(answer('I can’t help with that.', 'refusal', REFUSAL));
    const result = streamChat({ model, messages });
    expect(await result.finishReason).toBe('content_filter');
    expect(await result.stopDetails).toEqual(REFUSAL);
  });

  it('starts the stream on its own, like finishReason', async () => {
    const { model } = claude(answer('No.', 'refusal', REFUSAL));
    expect(await streamChat({ model, messages }).stopDetails).toEqual(REFUSAL);
  });

  it('resolves undefined when the provider explained nothing', async () => {
    const { model } = claude(answer('Hello.', 'end_turn'));
    const result = streamChat({ model, messages });
    expect(await result.finishReason).toBe('stop');
    expect(await result.stopDetails).toBeUndefined();
  });

  it.each([
    ['null fields stay null', { type: 'refusal', category: null, explanation: null }],
    ['unknown fields are dropped', { type: 'refusal', category: 'bio', note: 'x' }],
    ['a detail without a type is not one', { category: 'cyber' }],
  ])('normalizes exactly as generateText does: %s', async (_case, raw) => {
    const fixture = answer('No.', 'refusal', raw);
    const text = await generateText({ model: claude(fixture).model, messages });
    const stream = streamChat({ model: claude(fixture).model, messages });
    expect(await stream.stopDetails).toEqual(text.stopDetails);
  });

  it('rejects with the call’s error when the call fails', async () => {
    const { model } = claude(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
          { status: 400 },
        ),
    );
    const result = streamChat({ model, messages, maxRetries: 0 });
    const failure = await result.finishReason.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    await expect(result.stopDetails).rejects.toBe(failure);
  });

  it('resolves undefined when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return sseResponse([answer('No.', 'refusal', REFUSAL)]);
    }) as typeof globalThis.fetch;
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5');
    const result = streamChat({ model, messages, signal: controller.signal });
    expect(await result.finishReason).toBe('aborted');
    expect(await result.stopDetails).toBeUndefined();
  });
});

describe('generateObject: stopDetails', () => {
  it('reports the explanation of a stop that still produced a valid object', async () => {
    const { model } = claude(answer('{"a":"x"}', 'refusal', REFUSAL));
    const result = await generateObject({ model, messages, schema: OBJ, mode: 'json' });
    expect(result).toMatchObject({ object: { a: 'x' }, finishReason: 'content_filter' });
    expect(result.stopDetails).toEqual(REFUSAL);
  });

  it('has no stopDetails when the provider explained nothing', async () => {
    const { model } = claude(answer('{"a":"x"}', 'end_turn'));
    const result = await generateObject({ model, messages, schema: OBJ, mode: 'json' });
    expect(result).not.toHaveProperty('stopDetails');
  });
});

describe('streamObject: stopDetails', () => {
  it('explains a refused request even though the object rejects', async () => {
    const { model } = claude(answer('I can’t help with that.', 'refusal', REFUSAL));
    const result = streamObject({ model, messages, schema: OBJ, mode: 'json' });
    await expect(result.object).rejects.toBeInstanceOf(NoObjectGeneratedError);
    expect(await result.finishReason).toBe('content_filter');
    expect(await result.stopDetails).toEqual(REFUSAL);
  });

  it('resolves undefined when the provider explained nothing', async () => {
    const { model } = claude(answer('{"a":"x"}', 'end_turn'));
    const result = streamObject({ model, messages, schema: OBJ, mode: 'json' });
    expect(await result.object).toEqual({ a: 'x' });
    expect(await result.stopDetails).toBeUndefined();
  });

  it('rejects with the call’s error when the call fails', async () => {
    const { model } = claude(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
          { status: 400 },
        ),
    );
    const result = streamObject({ model, messages, schema: OBJ, mode: 'json', maxRetries: 0 });
    const failure = await result.finishReason.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    await expect(result.stopDetails).rejects.toBe(failure);
  });
});
