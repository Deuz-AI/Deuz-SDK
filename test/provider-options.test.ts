import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const ANTHROPIC_MINI = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const CC_MINI = sseEvents([
  { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
  { data: '[DONE]' },
]);

const RESP_MINI = sseEvents([
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'ok' } },
  {
    event: 'response.completed',
    data: { type: 'response.completed', response: { status: 'completed', usage: {} } },
  },
]);

const GEMINI_MINI = sseEvents([
  {
    data: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  },
]);

function body(calls: { url: string; init?: RequestInit }[]): Record<string, unknown> {
  return JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
}

describe('providerOptions escape hatch (1.2.0)', () => {
  it('anthropic: merges unknown top-level fields (e.g. fallbacks)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_MINI]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { anthropic: { fallbacks: [{ model: 'claude-opus-4-8' }] } },
    });
    await result.finishReason;
    expect(body(calls).fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
  });

  it('canonical fields always win over providerOptions', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_MINI]));
    const result = streamChat({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { openai: { model: 'evil-model', service_tier: 'flex' } },
    });
    await result.finishReason;
    const b = body(calls);
    expect(b.model).toBe('gpt-5.5'); // canonical wins
    expect(b.service_tier).toBe('flex'); // gap filled
  });

  it('responses wire honors its provider key', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([RESP_MINI]));
    const result = streamChat({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { openai: { background: true } },
    });
    await result.finishReason;
    expect(body(calls).background).toBe(true);
  });

  it('google native: cachedContent rides providerOptions.google', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([GEMINI_MINI]));
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-3.5-flash'),
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { google: { cachedContent: 'cachedContents/abc' } },
    });
    await result.finishReason;
    expect(body(calls).cachedContent).toBe('cachedContents/abc');
  });

  it("another provider's key is ignored", async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_MINI]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { openai: { service_tier: 'flex' } },
    });
    await result.finishReason;
    expect(body(calls).service_tier).toBeUndefined();
  });
});
