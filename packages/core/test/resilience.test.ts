import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { Clock } from '../src/types/deps';
import { sseResponse, sseEvents } from './fixtures/sse';

/** Fire short (backoff) timers fast; never fire the long ttft/total timers. */
function fastClock(): Clock {
  return {
    now: () => 0,
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

const OK_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
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
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function errorResponse(status: number, type: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: type } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sequenceFetch(responses: (() => Response)[]): {
  fetch: typeof fetch;
  count: () => number;
} {
  let i = 0;
  const fn = (async () => {
    const make = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return make();
  }) as typeof fetch;
  return { fetch: fn, count: () => i };
}

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) void _;
  })();
}

describe('resilience', () => {
  it('retries a 529 overload then succeeds', async () => {
    const { fetch, count } = sequenceFetch([
      () => errorResponse(529, 'overloaded_error'),
      () => sseResponse([OK_STREAM]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok');
    expect(await result.finishReason).toBe('stop');
    expect(count()).toBe(2); // one retry
  });

  it('does NOT retry a 400 invalid_request', async () => {
    const { fetch, count } = sequenceFetch([() => errorResponse(400, 'invalid_request_error')]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await drain(result.fullStream); // error part, no throw
    await expect(result.usage).rejects.toMatchObject({ code: 'invalid_request' });
    expect(count()).toBe(1); // no retry
  });

  it('a user abort resolves finishReason "aborted" (no retry, no throw on fullStream)', async () => {
    const controller = new AbortController();
    const abortFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted)
        throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
      return sseResponse([OK_STREAM]);
    }) as typeof fetch;

    controller.abort();
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: abortFetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      deps: { clock: fastClock(), generateId: () => 'fixed-id' },
    });
    await drain(result.fullStream);
    expect(await result.finishReason).toBe('aborted');
  });
});
