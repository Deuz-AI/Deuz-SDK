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

describe('server-tool stream parsing (1.2.0)', () => {
  it('anthropic: web_search_tool_result → source parts, server_tool_use skipped, usage counter', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              { type: 'web_search_result', url: 'https://a.com', title: 'A' },
              { type: 'web_search_result', url: 'https://b.com', title: 'B' },
            ],
          },
        },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'ok' } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3, server_tool_use: { web_search_requests: 2 } },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch } = mockFetch(() => sseResponse([stream]));
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-fable-5'),
      messages: [{ role: 'user', content: 'search' }],
      tools: { web_search: anthropicWebSearch() },
    });
    expect(res.text).toBe('ok');
    expect(res.toolCalls ?? []).toEqual([]); // server_tool_use never becomes a local tool call
    expect(res.usage.serverToolUses).toBe(2);
  });

  it('anthropic streaming: source parts appear on fullStream', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_9',
            content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }],
          },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch } = mockFetch(() => sseResponse([stream]));
    const { streamChat } = await import('../src/index');
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: Array<{ type: string; url?: string; title?: string }> = [];
    for await (const p of result.fullStream) parts.push(p as never);
    const source = parts.find((p) => p.type === 'source');
    expect(source).toMatchObject({ url: 'https://a.com', title: 'A' });
  });

  it('responses: url_citation annotations → source parts', async () => {
    const stream = sseEvents([
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'cited' },
      },
      {
        event: 'response.output_text.annotation.added',
        data: {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://c.com', title: 'C' },
        },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { status: 'completed', usage: {} } },
      },
    ]);
    const { fetch } = mockFetch(() => sseResponse([stream]));
    const { streamChat } = await import('../src/index');
    const result = streamChat({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: Array<{ type: string; url?: string }> = [];
    for await (const p of result.fullStream) parts.push(p as never);
    expect(parts.find((p) => p.type === 'source')).toMatchObject({ url: 'https://c.com' });
  });
});
