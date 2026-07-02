import { describe, it, expect } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogle } from '../src/google';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

function consume(chunks: string[]) {
  return mockFetch(() => sseResponse(chunks));
}

describe('OpenAI Chat Completions wire', () => {
  const CC = sseEvents([
    { data: { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] } },
    { data: { choices: [{ delta: { content: ' world' }, finish_reason: null }] } },
    { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
    {
      data: {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    },
    { data: '[DONE]' },
  ]);

  it('streams text, takes usage from the include_usage chunk', async () => {
    const { fetch, calls } = consume([CC]);
    const result = streamChat({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('Hello world');
    expect(await result.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 5,
      cachedReadTokens: 3,
      totalTokens: 15,
    });
    expect(await result.finishReason).toBe('stop');

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('accumulates a streamed tool call and parses args once', async () => {
    const TOOL = sseEvents([
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
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
    const { fetch } = consume([TOOL]);
    const res = await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'weather in Paris?' }],
    });
    expect(res.finishReason).toBe('tool_calls');
    const content = res.response.messages[0]!.content;
    const parts = Array.isArray(content) ? content : [];
    const tool = parts.find((p) => p.type === 'tool_use');
    expect(tool).toMatchObject({ id: 'call_1', name: 'get_weather', input: { city: 'Paris' } });
  });
});

describe('Gemini OpenAI-compat (usage-per-chunk quirk)', () => {
  const GEMINI = sseEvents([
    {
      data: {
        choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    },
    {
      data: {
        choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    },
    { data: '[DONE]' },
  ]);

  it('takes only the LAST usage chunk and omits stream_options', async () => {
    const { fetch, calls } = consume([GEMINI]);
    const result = streamChat({
      model: createGoogle({ apiKey: 'k', fetch })('gemini-3.5-flash'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('Hi there');
    expect(await result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });

    // Gemini-compat needs the include_usage opt-in too (we still take last usage).
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('OpenAI Responses API wire', () => {
  const RESP = sseEvents([
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'Hello' },
    },
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: ' GPT' },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 12,
            output_tokens: 6,
            total_tokens: 18,
            output_tokens_details: { reasoning_tokens: 4 },
          },
        },
      },
    },
  ]);

  it('streams text and maps Responses usage (incl. reasoning tokens)', async () => {
    const { fetch, calls } = consume([RESP]);
    const result = streamChat({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('Hello GPT');
    expect(await result.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 6,
      reasoningTokens: 4,
      totalTokens: 18,
    });

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.instructions).toBe('be terse'); // system hoisted to instructions
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_output_tokens).toBeDefined();
  });
});

describe('OpenAI effort semantics (0.2.0)', () => {
  const CC_MINI = sseEvents([
    { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
    { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
    { data: '[DONE]' },
  ]);
  const RESP_MINI = sseEvents([
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'ok' },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
      },
    },
  ]);

  it('chat completions clamps max → xhigh', async () => {
    const { fetch, calls } = consume([CC_MINI]);
    const result = streamChat({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    });
    await result.finishReason;
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.reasoning_effort).toBe('xhigh');
  });

  it("responses wire sends effort 'none' explicitly (real OpenAI value)", async () => {
    const { fetch, calls } = consume([RESP_MINI]);
    const result = streamChat({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'none',
    });
    await result.finishReason;
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.reasoning).toEqual({ effort: 'none' });
  });
});
