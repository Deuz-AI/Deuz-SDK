import { describe, it, expect } from 'vitest';
import { generateText } from '../src/index';
import { anthropicWebSearch, openaiWebSearch, googleSearch } from '../src/server-tools';
import { createAnthropic } from '../src/anthropic';
import { createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';
import type { JSONSchema } from '../src/types/schema';

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

const RESP_MINI = sseEvents([
  {
    event: 'response.output_text.delta',
    data: { type: 'response.output_text.delta', delta: 'ok' },
  },
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

const echoTool = {
  description: 'Echo',
  parameters: { type: 'object', properties: { v: { type: 'string' } } } as JSONSchema,
  execute: async (args: unknown) => args,
};

describe('provider-executed tools (1.2.0)', () => {
  it('anthropic: native web_search def rides tools[] next to function tools', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_MINI]));
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-fable-5'),
      messages: [{ role: 'user', content: 'search something' }],
      tools: { echo: echoTool, web_search: anthropicWebSearch({ max_uses: 3 }) },
    });
    expect(res.text).toBe('ok');
    const tools = body(calls).tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({ type: 'web_search_20260318', name: 'web_search', max_uses: 3 });
    expect(tools.find((t) => t.name === 'echo')).toMatchObject({ name: 'echo' });
  });

  it('responses: {type: web_search} entry emitted', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([RESP_MINI]));
    await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: 'search' }],
      tools: { web_search: openaiWebSearch({ search_context_size: 'low' }) },
    });
    const tools = body(calls).tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({ type: 'web_search', search_context_size: 'low' });
  });

  it('gemini native: google_search entry sits beside functionDeclarations', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([GEMINI_MINI]));
    await generateText({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-3.5-flash'),
      messages: [{ role: 'user', content: 'search' }],
      tools: { echo: echoTool, google_search: googleSearch() },
    });
    const tools = body(calls).tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({ google_search: {} });
    const fns = tools.find((t) => 'functionDeclarations' in t) as {
      functionDeclarations: Array<{ name: string }>;
    };
    expect(fns.functionDeclarations.map((f) => f.name)).toEqual(['echo']);
  });

  it('a provider tool alone does not break the loop as a client tool', async () => {
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_MINI]));
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      tools: { web_search: anthropicWebSearch() },
      maxSteps: 3,
    });
    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls ?? []).toEqual([]);
  });
});
