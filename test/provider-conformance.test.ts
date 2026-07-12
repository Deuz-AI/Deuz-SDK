import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/index';
import { AuthenticationError } from '../src/errors';
import { createAnthropic } from '../src/anthropic';
import { createGoogleNative } from '../src/google';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import type { LanguageModel } from '../src/types/model';

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const wire = events
    .map(({ event, data }) => {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
    })
    .join('');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const successFixtures = {
  anthropic: () =>
    sse([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 2 } } },
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
          usage: { output_tokens: 1 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
  chat: () =>
    sse([
      { data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
      { data: '[DONE]' },
    ]),
  responses: () =>
    sse([
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'ok' },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } },
        },
      },
    ]),
  google: () =>
    sse([
      { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] } },
      {
        data: {
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        },
      },
    ]),
};

interface ProviderCase {
  name: string;
  provider: string;
  createModel: (fetch: typeof globalThis.fetch) => LanguageModel;
  response: () => Response;
  expectedUrl: RegExp;
  authHeader: string;
  streamFlag: 'body' | 'query';
}

const baseURL = 'https://wire.example/base';
const cases: ProviderCase[] = [
  {
    name: 'Anthropic Messages',
    provider: 'anthropic',
    createModel: (fetch) =>
      createAnthropic({ apiKey: 'test-key', baseURL, fetch })('claude-opus-4-8'),
    response: successFixtures.anthropic,
    expectedUrl: /\/base\/v1\/messages$/,
    authHeader: 'x-api-key',
    streamFlag: 'body',
  },
  {
    name: 'OpenAI Chat Completions',
    provider: 'openai',
    createModel: (fetch) => createOpenAI({ apiKey: 'test-key', baseURL, fetch })('gpt-5.5'),
    response: successFixtures.chat,
    expectedUrl: /\/base\/chat\/completions$/,
    authHeader: 'authorization',
    streamFlag: 'body',
  },
  {
    name: 'OpenAI Responses',
    provider: 'openai',
    createModel: (fetch) =>
      createOpenAIResponses({ apiKey: 'test-key', baseURL, fetch })('gpt-5.5'),
    response: successFixtures.responses,
    expectedUrl: /\/base\/responses$/,
    authHeader: 'authorization',
    streamFlag: 'body',
  },
  {
    name: 'Google native',
    provider: 'google',
    createModel: (fetch) =>
      createGoogleNative({ apiKey: 'test-key', baseURL, fetch })('gemini-2.5-flash'),
    response: successFixtures.google,
    expectedUrl: /\/base\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/,
    authHeader: 'x-goog-api-key',
    streamFlag: 'query',
  },
];

describe.each(cases)('$name provider conformance', (providerCase) => {
  it('normalizes request, text, usage, and finish semantics', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return providerCase.response();
    }) as typeof globalThis.fetch;

    const result = streamChat({
      model: providerCase.createModel(fetch),
      messages: [{ role: 'user', content: 'hello' }],
      maxRetries: 0,
    });
    let text = '';
    const parts = [];
    for await (const part of result.fullStream) {
      parts.push(part);
      if (part.type === 'text-delta') text += part.text;
    }

    expect(text).toBe('ok');
    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1);
    expect((await result.usage).totalTokens).toBe(3);
    expect(await result.finishReason).toBe('stop');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toMatch(providerCase.expectedUrl);
    expect(requests[0]!.init?.method).toBe('POST');
    const headers = requests[0]!.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers[providerCase.authHeader]).toBeDefined();
    const body = JSON.parse(String(requests[0]!.init?.body)) as { stream?: boolean };
    if (providerCase.streamFlag === 'body') expect(body.stream).toBe(true);
    else expect(requests[0]!.url).toContain('alt=sse');
  });

  it('maps authentication failures to the shared error contract', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
        },
      )) as typeof globalThis.fetch;
    const result = streamChat({
      model: providerCase.createModel(fetch),
      messages: [{ role: 'user', content: 'hello' }],
      maxRetries: 0,
    });
    const usage = result.usage.catch((error: unknown) => error);
    const finish = result.finishReason.catch((error: unknown) => error);
    const errors = [];
    for await (const part of result.fullStream) {
      if (part.type === 'error') errors.push(part.error);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AuthenticationError);
    expect(errors[0]).toMatchObject({
      code: 'authentication',
      provider: providerCase.provider,
      statusCode: 401,
      isRetryable: false,
    });
    expect(await usage).toBe(errors[0]);
    expect(await finish).toBe(errors[0]);
  });
});
