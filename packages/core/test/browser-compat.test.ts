// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/edge';
import { createOpenAIResponses } from '../src/openai';

function response(text: string): Response {
  const wire =
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n\n`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('browser-compatible consumer', () => {
  it('uses Web APIs and never inserts /v1 into a custom Responses baseURL', async () => {
    const requests: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return response('browser-ok');
    }) as typeof globalThis.fetch;
    const result = streamChat({
      model: createOpenAIResponses({
        apiKey: 'test-key',
        baseURL: 'https://gateway.example',
        fetch,
      })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hello' }],
    });

    let text = '';
    for await (const chunk of result.textStream) text += chunk;

    expect(text).toBe('browser-ok');
    expect(requests).toEqual(['https://gateway.example/responses']);
    expect(await result.finishReason).toBe('stop');
  });

  it('preserves an explicitly supplied /v1 prefix exactly once', async () => {
    const requests: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return response('ok');
    }) as typeof globalThis.fetch;
    const result = streamChat({
      model: createOpenAIResponses({
        apiKey: 'test-key',
        baseURL: 'https://gateway.example/v1/',
        fetch,
      })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hello' }],
    });
    await result.finishReason;

    expect(requests).toEqual(['https://gateway.example/v1/responses']);
  });
});
