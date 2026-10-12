import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../src/adapters/anthropic';
import { googleNativeAdapter } from '../src/adapters/google-native';
import { openaiCompatibleAdapter } from '../src/adapters/openai-compatible';
import { openaiResponsesAdapter } from '../src/adapters/openai-responses';
import type { Adapter } from '../src/adapters/types';
import { parseReply } from '../src/batch/parse';
import type { ModelCapabilities } from '../src/core/registry';
import type { StreamPart } from '../src/types/stream';
import { sseEvents } from './fixtures/sse';
import { GEMINI_CALL, GEMINI_FINISH_REASONS } from './fixtures/provider-finish';

// BA2: batch results arrive as FINAL (non-streaming) JSON bodies. The batch
// parsers normalize them to the same contract the streaming adapters produce —
// usage per the 2.3 contract (outputTokens includes reasoning, inputTokens
// excludes cache reads), the same finish reasons — so a batch request costs
// what the same request costs on the streaming path.

function body(events: { event?: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sseEvents(events));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Drive an adapter's streaming parser; return its finish part and the availability it reported. */
async function streamFinish(adapter: Adapter, events: { event?: string; data: unknown }[]) {
  let available: boolean | undefined;
  const ctx = {
    provider: 'test',
    generateId: () => 'id',
    caps: {} as ModelCapabilities,
    usageAvailable: (value: boolean) => {
      available = value;
    },
  };
  for await (const part of adapter.parseStream(body(events), ctx)) {
    if (part.type === 'finish')
      return { ...(part as Extract<StreamPart, { type: 'finish' }>), available };
  }
  throw new Error('stream ended without a finish part');
}

describe('parseReply: Anthropic Message', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [
      { type: 'thinking', thinking: 'Let me see.', signature: 'sig' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 12, output_tokens: 30 },
    ...over,
  });

  it('collects text and reasoning and maps the stop reason', () => {
    const reply = parseReply('anthropic', message());
    expect(reply.text).toBe('Hello world');
    expect(reply.reasoning).toBe('Let me see.');
    expect(reply.finishReason).toBe('stop');
    expect(reply.usageAvailable).toBe(true);
    expect(reply.usage).toMatchObject({ inputTokens: 12, outputTokens: 30, totalTokens: 42 });
  });

  it.each([
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
  ])('maps stop_reason %s to %s', (stop, finish) => {
    expect(parseReply('anthropic', message({ stop_reason: stop })).finishReason).toBe(finish);
  });

  it('keeps tool_use inputs as objects and skips provider-executed tools', () => {
    const reply = parseReply(
      'anthropic',
      message({
        content: [
          { type: 'server_tool_use', id: 'srv', name: 'web_search', input: { query: 'x' } },
          { type: 'tool_use', id: 'tu_1', name: 'json_output', input: { label: 'spam' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
    expect(reply.toolCalls).toEqual([{ name: 'json_output', input: { label: 'spam' } }]);
  });

  it('reports a refusal with its stop details', () => {
    const reply = parseReply(
      'anthropic',
      message({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'No.' },
      }),
    );
    expect(reply.finishReason).toBe('content_filter');
    expect(reply.stopDetails).toEqual({ type: 'refusal', category: 'cyber', explanation: 'No.' });
    expect(reply.providerMetadata).toEqual({
      anthropic: { stop_details: { type: 'refusal', category: 'cyber', explanation: 'No.' } },
    });
  });

  it('marks usage the provider did not report as unavailable (F02)', () => {
    expect(parseReply('anthropic', message({ usage: undefined })).usageAvailable).toBe(false);
  });

  it.each([
    ['plain', { input_tokens: 100, output_tokens: 1000 }],
    [
      'cache reads and both cache writes',
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 200 },
      },
    ],
    [
      'thinking tokens',
      { input_tokens: 10, output_tokens: 900, output_tokens_details: { thinking_tokens: 700 } },
    ],
    [
      'server tools',
      { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 2 } },
    ],
    [
      'fallback iterations',
      {
        input_tokens: 10,
        output_tokens: 20,
        iterations: [
          { input_tokens: 10, output_tokens: 5 },
          { input_tokens: 12, output_tokens: 20, cache_read_input_tokens: 3 },
        ],
      },
    ],
    [
      'fallback iterations with top-level server tools and thinking',
      {
        input_tokens: 10,
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 8 },
        server_tool_use: { web_search_requests: 2 },
        iterations: [
          { input_tokens: 10, output_tokens: 5 },
          { input_tokens: 12, output_tokens: 20 },
        ],
      },
    ],
  ])('bills %s exactly as the streaming adapter does', async (_label, usage) => {
    const stream = await streamFinish(anthropicAdapter, [
      { event: 'message_start', data: { type: 'message_start', message: { usage } } },
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const reply = parseReply('anthropic', message({ usage }));
    expect(reply.usage).toEqual(stream.usage);
    expect(reply.usageAvailable).toBe(stream.available);
  });
});

describe('parseReply: OpenAI Responses', () => {
  const response = (over: Record<string, unknown> = {}) => ({
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Thinking.' }],
        encrypted_content: 'enc',
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [
          { type: 'output_text', text: 'Hi ', annotations: [] },
          { type: 'output_text', text: 'there', annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 60,
    },
    ...over,
  });

  it('collects output text and reasoning summaries, and keeps the message phase', () => {
    const reply = parseReply('responses', response());
    expect(reply.text).toBe('Hi there');
    expect(reply.reasoning).toBe('Thinking.');
    expect(reply.finishReason).toBe('stop');
    expect(reply.providerMetadata).toEqual({ openai: { phase: 'final_answer' } });
    expect(reply.usage).toMatchObject({ inputTokens: 20, outputTokens: 40, reasoningTokens: 10 });
  });

  it('maps an incomplete response by its reason', () => {
    const cut = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    expect(parseReply('responses', response(cut)).finishReason).toBe('length');
    const filtered = { status: 'incomplete', incomplete_details: { reason: 'content_filter' } };
    expect(parseReply('responses', response(filtered)).finishReason).toBe('content_filter');
  });

  it('returns function calls with their argument text and finishes as tool_calls', () => {
    const reply = parseReply(
      'responses',
      response({
        output: [
          { type: 'function_call', call_id: 'c1', name: 'json_output', arguments: '{"a":1}' },
        ],
      }),
    );
    expect(reply.toolCalls).toEqual([{ name: 'json_output', input: '{"a":1}' }]);
    expect(reply.finishReason).toBe('tool_calls');
  });

  it('surfaces a refusal and a failed response', () => {
    const refused = parseReply(
      'responses',
      response({
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] },
        ],
      }),
    );
    expect(refused.providerMetadata).toEqual({ openai: { refusal: 'No.' } });
    const failed = parseReply(
      'responses',
      response({ status: 'failed', error: { code: 'server_error', message: 'Boom.' }, output: [] }),
    );
    expect(failed.error).toEqual({ code: 'server_error', message: 'Boom.' });
  });

  it.each([
    ['plain', { input_tokens: 100, output_tokens: 1000, total_tokens: 1100 }],
    [
      'cached and reasoning',
      {
        input_tokens: 500,
        input_tokens_details: { cached_tokens: 400 },
        output_tokens: 1000,
        output_tokens_details: { reasoning_tokens: 800 },
        total_tokens: 1500,
      },
    ],
    [
      'reasoning counted beside the output',
      {
        input_tokens: 10,
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 50 },
        total_tokens: 80,
      },
    ],
    ['no total', { input_tokens: 10, output_tokens: 20 }],
  ])('bills %s exactly as the streaming adapter does', async (_label, usage) => {
    const stream = await streamFinish(openaiResponsesAdapter, [
      { data: { type: 'response.completed', response: { status: 'completed', usage } } },
    ]);
    const reply = parseReply('responses', response({ usage }));
    expect(reply.usage).toEqual(stream.usage);
    expect(reply.usageAvailable).toBe(stream.available);
  });

  it('marks a response without usage as unavailable', async () => {
    const stream = await streamFinish(openaiResponsesAdapter, [
      { data: { type: 'response.completed', response: { status: 'completed' } } },
    ]);
    const reply = parseReply('responses', response({ usage: undefined }));
    expect(reply.usage).toEqual(stream.usage);
    expect(reply.usageAvailable).toBe(false);
  });
});

describe('parseReply: Chat Completions', () => {
  const completion = (message: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 30,
      completion_tokens: 12,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 10 },
    },
    ...over,
  });

  it('reads the message, its reasoning_content and its usage', () => {
    const reply = parseReply(
      'chat_completions',
      completion({ content: 'Answer', reasoning_content: 'Because.' }),
    );
    expect(reply.text).toBe('Answer');
    expect(reply.reasoning).toBe('Because.');
    expect(reply.usage).toMatchObject({ inputTokens: 20, cachedReadTokens: 10, outputTokens: 12 });
    expect(reply.usageAvailable).toBe(true);
  });

  it('returns tool calls and maps finish reasons', () => {
    const call = {
      id: 't1',
      type: 'function',
      function: { name: 'json_output', arguments: '{"b":2}' },
    };
    const choice = (message: Record<string, unknown>, finish_reason: string) => ({
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
    });
    const reply = parseReply(
      'chat_completions',
      completion({}, choice({ content: null, tool_calls: [call] }, 'tool_calls')),
    );
    expect(reply.toolCalls).toEqual([{ name: 'json_output', input: '{"b":2}' }]);
    expect(reply.finishReason).toBe('tool_calls');
    for (const [wire, finish] of [
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['function_call', 'tool_calls'],
      ['stop', 'stop'],
    ] as const) {
      const reply = parseReply('chat_completions', completion({}, choice({ content: '' }, wire)));
      expect(reply.finishReason).toBe(finish);
    }
  });

  it('bills usage exactly as the streaming adapter does', async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 170,
      completion_tokens_details: { reasoning_tokens: 20 },
      prompt_cache_hit_tokens: 30,
    };
    const stream = await streamFinish(openaiCompatibleAdapter, [
      { data: { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage } },
      { data: '[DONE]' },
    ]);
    const reply = parseReply('chat_completions', completion({ content: 'x' }, { usage }));
    expect(reply.usage).toEqual(stream.usage);
    expect(reply.usageAvailable).toBe(stream.available);
  });
});

describe('parseReply: Gemini generateContent', () => {
  const response = (parts: unknown[], over: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 40,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 5,
      totalTokenCount: 55,
    },
    ...over,
  });

  it('separates thought parts from text and folds thoughts into the output', () => {
    const reply = parseReply(
      'native',
      response([{ text: 'Plan.', thought: true }, { text: '{"ok":' }, { text: 'true}' }]),
    );
    expect(reply.text).toBe('{"ok":true}');
    expect(reply.reasoning).toBe('Plan.');
    expect(reply.usage).toMatchObject({ inputTokens: 40, outputTokens: 15, reasoningTokens: 5 });
  });

  it('reports function calls as tool_calls even when the candidate says STOP', () => {
    const reply = parseReply('native', response([{ functionCall: { name: 'f', args: { x: 1 } } }]));
    expect(reply.toolCalls).toEqual([{ name: 'f', input: { x: 1 } }]);
    expect(reply.finishReason).toBe('tool_calls');
  });

  it('maps safety stops and a blocked prompt to content_filter', () => {
    const safety = response([], {
      candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
    });
    expect(parseReply('native', safety).finishReason).toBe('content_filter');
    const blocked = {
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 4 },
    };
    expect(parseReply('native', blocked).finishReason).toBe('content_filter');
    expect(
      parseReply(
        'native',
        response([], {
          candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
        }),
      ).finishReason,
    ).toBe('length');
  });

  // 2.3 (K4): every value of @google/genai 2.28's FinishReason, the same as on the stream.
  it.each(GEMINI_FINISH_REASONS)('maps finish reason %s to %s', (finishReason, expected) => {
    const candidates = [{ content: { parts: [{ text: 'x' }] }, finishReason }];
    expect(parseReply('native', response([], { candidates })).finishReason).toBe(expected);
  });

  it.each([...GEMINI_FINISH_REASONS.map(([wire]) => wire), 'A_LATER_REASON'])(
    'maps %s exactly as the streaming adapter does, with or without a call',
    async (finishReason) => {
      for (const parts of [[{ text: 'x' }], [GEMINI_CALL]]) {
        const candidates = [{ content: { role: 'model', parts }, finishReason }];
        const stream = await streamFinish(googleNativeAdapter, [{ data: { candidates } }]);
        const reply = parseReply('native', response(parts, { candidates }));
        expect(reply.finishReason, JSON.stringify(parts)).toBe(stream.finishReason);
      }
    },
  );

  it('bills usage exactly as the streaming adapter does', async () => {
    const usageMetadata = {
      promptTokenCount: 300,
      cachedContentTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 25,
      totalTokenCount: 375,
    };
    const stream = await streamFinish(googleNativeAdapter, [
      {
        data: {
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
          usageMetadata,
        },
      },
    ]);
    const reply = parseReply('native', response([{ text: 'x' }], { usageMetadata }));
    expect(reply.usage).toEqual(stream.usage);
    expect(reply.usageAvailable).toBe(stream.available);
  });
});

describe('parseReply: malformed bodies', () => {
  it.each(['anthropic', 'responses', 'chat_completions', 'native'] as const)(
    'turns a body that is not an object into an error without usage (%s)',
    (surface) => {
      const reply = parseReply(surface, 'not json');
      expect(reply.error?.message).toMatch(/is not an? .* response/i);
      expect(reply.usageAvailable).toBe(false);
      expect(reply.text).toBe('');
    },
  );
});
