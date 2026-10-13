/**
 * structured-tools-wire.test.ts (2.3, F15 follow-up) — a json-strategy
 * structured-output request that carries tools.
 *
 * runAgent's finalization asks for the structured output with the loop's own
 * tools and `toolChoice: 'none'`, so the request prefix (prompt cache,
 * preserved thinking) stays the loop's. Every adapter used to branch
 * `if (object) … else if (tools) …` and dropped the tools. Now the Anthropic,
 * Chat Completions and Responses wires send the tools with the requested
 * tool_choice beside `output_config.format` / `response_format` / `text.format`.
 *
 * Gemini native keeps dropping them: @google/genai 2.28.0 documents no request
 * that combines function declarations with a JSON response schema, and with
 * `toolChoice: 'none'` (mode NONE: "same as when not passing any function
 * declarations") nothing is lost. A drop that loses a callable tool is reported.
 *
 * Shapes are derived from the official SDK types (@anthropic-ai/sdk 0.133.0,
 * openai 7.32.0, @google/genai 2.28.0). NOT live-verified: these pin what the
 * SDK sends, not what a provider answers.
 */
import { describe, expect, it } from 'vitest';
import { runStream, type InternalRunOptions } from '../src/core/inference';
import { runAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { toGeminiSchema } from '../src/schema/gemini';
import { mockFetch, mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';
import type { ObjectRequest, WireToolRequest } from '../src/adapters/types';
import type { CommonCallOptions } from '../src/types/config';
import type { CallWarning } from '../src/types/methods';
import type { LanguageModel } from '../src/types/model';

type Body = Record<string, unknown>;
type Make = (fetch: typeof globalThis.fetch) => LanguageModel;

const OBJ = {
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
};
const LOOKUP = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
const OTHER = { type: 'object', properties: {} };

const object: ObjectRequest = { schema: OBJ, name: 'answer', strategy: 'json' };
const tools = (toolChoice: WireToolRequest['toolChoice']): WireToolRequest => ({
  tools: [
    { name: 'lookup', description: 'Look it up.', parameters: LOOKUP },
    { name: 'other', parameters: OTHER },
  ],
  toolChoice,
  allowParallel: true,
});

/** A minimal well-formed answer per wire — the request is what these tests read. */
const ANSWER: Record<LanguageModel['surface'], string> = {
  anthropic: sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 1 } } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]),
  chat_completions: sseEvents([
    { data: { choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] } },
    { data: '[DONE]' },
  ]),
  responses: sseEvents([
    {
      event: 'response.completed',
      data: { type: 'response.completed', response: { status: 'completed', usage: {} } },
    },
  ]),
  native: sseEvents([
    {
      data: {
        candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      },
    },
  ]),
};

const anthropic: Make = (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5');
const chat: Make = (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-5.5');
const responses: Make = (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.5');
const native: Make = (fetch) => createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash');

/** Send one request through the real pump and adapter; return its body and warnings. */
async function send(
  make: Make,
  internal: InternalRunOptions,
  options: Partial<CommonCallOptions> = {},
): Promise<{ body: Body; warnings: CallWarning[] }> {
  let surface: LanguageModel['surface'] = 'anthropic';
  const { fetch, calls } = mockFetch(() => sseResponse([ANSWER[surface]]));
  const model = make(fetch);
  surface = model.surface;
  const result = runStream(
    { ...options, model, messages: [{ role: 'user', content: 'hi' }] },
    internal,
  );
  for await (const part of result.fullStream) if (part.type === 'error') throw part.error;
  return {
    body: JSON.parse(String(calls[0]!.init!.body)) as Body,
    warnings: await result.warnings!,
  };
}

const pick = (body: Body, keys: readonly string[]): Body =>
  Object.fromEntries(keys.filter((key) => key in body).map((key) => [key, body[key]]));

describe('json-strategy object request with tools: request snapshot per wire', () => {
  it('anthropic: tools and tool_choice none beside output_config.format', async () => {
    const { body } = await send(anthropic, { object, tools: tools('none') }, { effort: 'high' });
    expect(pick(body, ['tools', 'tool_choice', 'output_config'])).toEqual({
      tools: [
        { name: 'lookup', description: 'Look it up.', input_schema: LOOKUP },
        { name: 'other', input_schema: OTHER },
      ],
      tool_choice: { type: 'none' },
      output_config: { format: { type: 'json_schema', schema: OBJ }, effort: 'high' },
    });
  });

  it('chat completions: tools and tool_choice none beside response_format', async () => {
    const { body } = await send(chat, { object, tools: tools('none') });
    expect(pick(body, ['tools', 'tool_choice', 'parallel_tool_calls', 'response_format'])).toEqual({
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Look it up.', parameters: LOOKUP },
        },
        { type: 'function', function: { name: 'other', parameters: OTHER } },
      ],
      tool_choice: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: OBJ },
      },
    });
  });

  it('responses: tools and tool_choice none beside text.format', async () => {
    const { body } = await send(responses, { object, tools: tools('none') });
    expect(pick(body, ['tools', 'tool_choice', 'text'])).toEqual({
      tools: [
        { type: 'function', name: 'lookup', description: 'Look it up.', parameters: LOOKUP },
        { type: 'function', name: 'other', parameters: OTHER },
      ],
      tool_choice: 'none',
      text: { format: { type: 'json_schema', name: 'answer', strict: true, schema: OBJ } },
    });
  });

  it('gemini native: the JSON response schema alone, without a warning for tool_choice none', async () => {
    const { body, warnings } = await send(native, { object, tools: tools('none') });
    expect(pick(body, ['tools', 'toolConfig'])).toEqual({});
    expect(body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(OBJ),
    });
    expect(warnings).toEqual([]);
  });

  it('gemini native: reports the dropped tools when they were callable', async () => {
    const { body, warnings } = await send(native, { object, tools: tools('auto') });
    expect(pick(body, ['tools', 'toolConfig'])).toEqual({});
    expect(warnings).toEqual([
      expect.objectContaining({
        type: 'unsupported-tool',
        message: expect.stringContaining('lookup, other'),
      }),
    ]);
  });
});

describe('json-strategy object request with tools: the tools are the loop’s own', () => {
  const WIRES: [string, Make, readonly string[], readonly string[]][] = [
    ['anthropic', anthropic, ['tools', 'tool_choice'], ['output_config']],
    [
      'chat completions',
      chat,
      ['tools', 'tool_choice', 'parallel_tool_calls'],
      ['response_format'],
    ],
    ['responses', responses, ['tools', 'tool_choice'], ['text']],
  ];

  it.each(WIRES)(
    '%s: the tool fields match the tools-only request and the format the object-only one',
    async (_wire, make, toolKeys, formatKeys) => {
      for (const choice of ['none', 'auto'] as const) {
        for (const allowParallel of [true, false]) {
          const wire = { ...tools(choice), allowParallel };
          const both = (await send(make, { object, tools: wire })).body;
          const toolsOnly = (await send(make, { tools: wire })).body;
          const objectOnly = (await send(make, { object })).body;
          expect(pick(both, toolKeys)).toEqual(pick(toolsOnly, toolKeys));
          expect(pick(both, formatKeys)).toEqual(pick(objectOnly, formatKeys));
          expect(pick(both, toolKeys)).toHaveProperty('tools');
        }
      }
    },
  );

  it('the tool strategy still forces its own json_output call alone', async () => {
    const { body } = await send(chat, {
      object: { ...object, strategy: 'tool' },
      tools: tools('none'),
    });
    expect(pick(body, ['tools', 'tool_choice', 'response_format'])).toEqual({
      tools: [
        {
          type: 'function',
          function: {
            name: 'answer',
            description: 'Return the structured result.',
            parameters: OBJ,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'answer' } },
    });
  });
});

/** One streamed text answer, in each wire's own event shape. */
const TEXT: Record<'anthropic' | 'chat' | 'responses' | 'google', (text: string) => string> = {
  anthropic: (text) =>
    sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 2 } } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
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
  chat: (text) =>
    sseEvents([
      { data: { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
      { data: '[DONE]' },
    ]),
  responses: (text) =>
    sseEvents([
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: text },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } },
        },
      },
    ]),
  google: (text) =>
    sseEvents([
      { data: { candidates: [{ content: { role: 'model', parts: [{ text }] } }] } },
      {
        data: {
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        },
      },
    ]),
};

describe('runAgent finalization sends the loop’s tools with the structured format (F15)', () => {
  const MODELS: Record<keyof typeof TEXT, Make> = {
    anthropic: (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
    chat: (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
    responses: (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.5'),
    google: (fetch) => createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
  };
  const NONE = { anthropic: { type: 'none' }, chat: 'none', responses: 'none' } as const;
  const FORMAT = {
    anthropic: 'output_config',
    chat: 'response_format',
    responses: 'text',
  } as const;

  async function finalize(wire: keyof typeof TEXT): Promise<{ loop: Body; final: Body }> {
    const sequence = mockFetchSequence([
      () => sseResponse([TEXT[wire]('Rome is mild today.')]),
      () => sseResponse([TEXT[wire]('{"a":"mild"}')]),
    ]);
    const result = await runAgent({
      model: MODELS[wire](sequence.fetch),
      prompt: 'Weather in Rome as JSON.',
      maxRetries: 0,
      tools: {
        lookup: { description: 'Look it up.', parameters: LOOKUP, execute: () => 'mild' },
        other: { parameters: OTHER, execute: () => 'x' },
      },
      output: { schema: OBJ, mode: 'json', validate: (value: unknown) => value as { a: string } },
    });
    expect(result).toMatchObject({ status: 'completed', output: { a: 'mild' } });
    expect(sequence.calls).toHaveLength(2);
    const [loop, final] = sequence.calls.map((c) => JSON.parse(String(c.init!.body)) as Body);
    return { loop: loop!, final: final! };
  }

  it.each(['anthropic', 'chat', 'responses'] as const)(
    '%s: the finalization tools are byte-identical to the loop’s',
    async (wire) => {
      const { loop, final } = await finalize(wire);
      expect(JSON.stringify(final.tools)).toBe(JSON.stringify(loop.tools));
      expect(final.tool_choice).toEqual(NONE[wire]);
      expect(final[FORMAT[wire]]).toBeDefined();
    },
  );

  it('google: the finalization keeps only the JSON schema (documented drop)', async () => {
    const { loop, final } = await finalize('google');
    expect(loop.tools).toBeDefined();
    expect(final).not.toHaveProperty('tools');
    expect(final).not.toHaveProperty('toolConfig');
    expect(final.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
  });
});
