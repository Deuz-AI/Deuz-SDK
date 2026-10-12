import { describe, it, expect, vi } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogle } from '../src/google';
import { openaiWebSearch } from '../src/server-tools';
import { runStream } from '../src/core/inference';
import { getCapabilities } from '../src/core/registry';
import { withCapabilityOverride } from '../src/internal/config-symbol';
import { InvalidRequestError } from '../src/errors';
import { sseResponse, sseEvents, mockFetch, mockFetchSequence } from './fixtures/sse';
import { responsesTurn, type ResponsesTurn } from './fixtures/provider-finish';
import type { JSONSchema } from '../src/types/schema';
import type { Logger } from '../src/types/deps';
import type { LanguageModel } from '../src/types/model';
import type { CommonCallOptions } from '../src/types/config';
import type { CallWarning } from '../src/types/methods';
import type { WireToolRequest } from '../src/adapters/types';

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
        response: {
          status: 'completed',
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
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

describe('Chat Completions hosted-tool drop is loud (1.9.0)', () => {
  const CC_MINI = sseEvents([
    { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
    { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
    { data: '[DONE]' },
  ]);

  function makeLogger(): Logger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  const echoTool = {
    description: 'Echo',
    parameters: { type: 'object', properties: { v: { type: 'string' } } } as JSONSchema,
    execute: async (args: unknown) => args,
  };

  it('drops the provider-executed tool, keeps the function tool, and warns exactly once', async () => {
    const logger = makeLogger();
    const { fetch, calls } = consume([CC_MINI]);
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'search then echo' }],
      tools: { echo: echoTool, web_search: openaiWebSearch({ search_context_size: 'low' }) },
      deps: { logger },
    });

    const body = JSON.parse(String(calls[0]!.init!.body));
    const tools = body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toEqual(['echo']);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, fields] = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]! as [string, Record<string, unknown>];
    expect(message).toContain('web_search');
    expect(message).toContain('provider-executed');
    expect(message).toContain('gpt-5.5');
    expect(fields).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.5',
      droppedTools: ['web_search'],
    });
  });

  it('does not warn when every tool is a function tool', async () => {
    const logger = makeLogger();
    const { fetch } = consume([CC_MINI]);
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'echo' }],
      tools: { echo: echoTool },
      deps: { logger },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('the request body is otherwise unchanged (the warn is the ONLY new behaviour)', async () => {
    const { fetch, calls } = consume([CC_MINI]);
    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'search then echo' }],
      tools: { echo: echoTool, web_search: openaiWebSearch({ search_context_size: 'low' }) },
    });
    // Pinned byte-for-byte against 1.8.0 output: dropping stays a drop, the
    // hosted definition is NOT smuggled into the wire, nothing else moved.
    // 2.3 (F08, DELIBERATE, NOT live-verified): gpt-5.5 is a reasoning row, so
    // the cap rides `max_completion_tokens` (was `max_tokens`) next to
    // reasoning_effort, as the registry's samplingRestrictions note requires.
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'search then echo' }],
      stream: true,
      max_completion_tokens: 128000,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'Echo',
            parameters: { type: 'object', properties: { v: { type: 'string' } } },
          },
        },
      ],
    });
  });
});

// ===================================================================
// 2.3 — the OpenAI wires. Model facts are research-dated (roadmap 5.3,
// 2026-10-09) and NOT live-verified: these tests pin the REQUEST the SDK
// builds per model id (F08), the stateless Responses default (F20) and that
// no value is changed in silence (F26).
// ===================================================================

const CC_OK = sseEvents([
  { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
  { data: '[DONE]' },
]);
const RESP_OK = sseEvents([
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
]);

const ECHO_TOOL: WireToolRequest = {
  tools: [{ name: 'echo', parameters: { type: 'object', properties: {} } }],
};

/**
 * One request through the real pump: the wire body, the warnings and the raw
 * calls. Per-call `capabilities` is folded in as the public boundary does.
 */
async function openaiRequest(
  make: (fetch: typeof globalThis.fetch) => LanguageModel,
  options: Partial<CommonCallOptions> = {},
  tools?: WireToolRequest,
): Promise<{
  body: Record<string, unknown>;
  warnings: CallWarning[];
  calls: { url: string; init?: RequestInit }[];
  error?: unknown;
}> {
  const { fetch, calls } = mockFetch(() =>
    sseResponse([make(fetch).surface === 'responses' ? RESP_OK : CC_OK]),
  );
  const result = runStream(
    {
      ...options,
      model: withCapabilityOverride(make(fetch), options.capabilities),
      messages: options.messages ?? [{ role: 'user', content: 'hi' }],
    },
    tools ? { tools } : {},
  );
  let error: unknown;
  for await (const part of result.fullStream) if (part.type === 'error') error = part.error;
  const body =
    calls.length > 0 ? (JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>) : {};
  return { body, warnings: await result.warnings!, calls, error };
}

const chat = (id: string) => (fetch: typeof globalThis.fetch) =>
  createOpenAI({ apiKey: 'k', fetch })(id);
const responses = (id: string) => (fetch: typeof globalThis.fetch) =>
  createOpenAIResponses({ apiKey: 'k', fetch })(id);
const clamps = (warnings: CallWarning[]) =>
  warnings.filter((w) => w.type === 'clamped-setting').map((w) => w.setting);

describe('OpenAI effort clamps are reported (2.3, F26)', () => {
  it("'max' → 'xhigh' on a model without a real 'max': clamped-setting on both wires", async () => {
    const viaChat = await openaiRequest(chat('gpt-5.5'), { effort: 'max' });
    expect(viaChat.body.reasoning_effort).toBe('xhigh');
    expect(clamps(viaChat.warnings)).toEqual(['effort']);

    const viaResponses = await openaiRequest(responses('gpt-5.4'), { effort: 'max' });
    expect(viaResponses.body.reasoning).toEqual({ effort: 'xhigh' });
    expect(clamps(viaResponses.warnings)).toEqual(['effort']);
    expect(viaResponses.warnings[0]!.message).toContain("'max'");
    expect(viaResponses.warnings[0]!.message).toContain("'xhigh'");
  });

  it('a level the model has is not a clamp', async () => {
    const { body, warnings } = await openaiRequest(responses('gpt-5.4'), { effort: 'xhigh' });
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(warnings).toEqual([]);
  });
});

describe('gpt-6.1-sol (2.3, F08 — research 2026-10-09, not live-verified)', () => {
  it('profile row: 1_050_000 context, 128_000 output, effort low..max', () => {
    const caps = getCapabilities({
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
      surface: 'responses',
    });
    expect(caps.known).toBe(true);
    expect(caps).toMatchObject({
      reasoning: true,
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      toolSurfaces: ['responses'],
    });
  });

  it("'max' is sent as 'max' — no max→xhigh mapping for Sol", async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const { body, warnings } = await openaiRequest(responses('gpt-6.1-sol'), { effort });
      expect(body.reasoning, effort).toEqual({ effort });
      expect(warnings, effort).toEqual([]);
      expect(body.max_output_tokens).toBe(128_000);
    }
  });

  it("negative: Sol has no 'none' (or 'minimal') → the lowest level, reported", async () => {
    const { body, warnings } = await openaiRequest(responses('gpt-6.1-sol'), { effort: 'none' });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(clamps(warnings)).toEqual(['effort']);
  });

  it('tools ride the Responses wire', async () => {
    const { body, error } = await openaiRequest(responses('gpt-6.1-sol'), {}, ECHO_TOOL);
    expect(error).toBeUndefined();
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['echo']);
  });

  it('a tool request on Chat Completions is rejected before any network call', async () => {
    const { calls, error } = await openaiRequest(chat('gpt-6.1-sol'), {}, ECHO_TOOL);
    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(String((error as Error).message)).toContain('createOpenAIResponses');
  });

  it('a tool-less Chat Completions call still works (and keeps max)', async () => {
    const { body, error } = await openaiRequest(chat('gpt-6.1-sol'), { effort: 'max' });
    expect(error).toBeUndefined();
    expect(body.reasoning_effort).toBe('max');
  });
});

describe('gpt-6-astra / gpt-6-luna (2.3, F08 — as far as the roadmap documents them)', () => {
  it('both are known reasoning rows on Responses; effort reaches the wire', async () => {
    for (const id of ['gpt-6-astra', 'gpt-6-luna']) {
      const { body, warnings } = await openaiRequest(responses(id), { effort: 'high' });
      expect(body.reasoning, id).toEqual({ effort: 'high' });
      expect(warnings, id).toEqual([]);
    }
  });

  it("luna documents 'none' (it is not generalised to Sol)", async () => {
    const { body } = await openaiRequest(responses('gpt-6-luna'), { effort: 'none' });
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('their output limits are undocumented, so no output cap is invented', async () => {
    for (const id of ['gpt-6-astra', 'gpt-6-luna']) {
      const { body } = await openaiRequest(responses(id));
      expect('max_output_tokens' in body, id).toBe(false);
    }
  });
});

describe('gpt-5.5 / gpt-5.5-pro on Chat Completions (2.3, F08 — not live-verified)', () => {
  it('reasoning rows: max_completion_tokens, no sampling params, developer role', async () => {
    for (const id of ['gpt-5.5', 'gpt-5.5-pro']) {
      const { body, warnings } = await openaiRequest(chat(id), {
        effort: 'high',
        temperature: 0.2,
        topP: 0.9,
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
        ],
      });
      expect(body.reasoning_effort, id).toBe('high');
      expect(body.max_completion_tokens, id).toBe(128_000);
      expect('max_tokens' in body, id).toBe(false);
      expect(body.temperature, id).toBeUndefined();
      expect(body.top_p, id).toBeUndefined();
      expect((body.messages as { role: string }[])[0]!.role, id).toBe('developer');
      expect(
        warnings.filter((w) => w.type === 'unsupported-setting').map((w) => w.setting),
        id,
      ).toEqual(['temperature', 'topP']);
    }
  });
});

describe('unknown-model output cap (2.3, F08)', () => {
  it('an unknown slug no longer gets max_tokens 4096 on either OpenAI wire', async () => {
    const viaChat = await openaiRequest(chat('gpt-6.2-unreleased'));
    expect('max_tokens' in viaChat.body).toBe(false);
    expect('max_completion_tokens' in viaChat.body).toBe(false);
    const viaResponses = await openaiRequest(responses('gpt-6.2-unreleased'));
    expect('max_output_tokens' in viaResponses.body).toBe(false);
    // The unknown-model warning says what happened to the cap.
    for (const { warnings } of [viaChat, viaResponses]) {
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain('no output cap is sent');
    }
  });

  it('a caller-supplied cap still reaches the wire', async () => {
    const perCall = await openaiRequest(chat('gpt-6.2-unreleased'), { maxOutputTokens: 900 });
    expect(perCall.body.max_tokens).toBe(900);
    const override = await openaiRequest(responses('gpt-6.2-unreleased'), {
      capabilities: { maxOutput: 32_000 },
    });
    expect(override.body.max_output_tokens).toBe(32_000);
  });
});

describe('Responses is stateless by default (2.3, F20 — retention behaviour not live-verified)', () => {
  it('every Responses request carries store:false — with or without tools, reasoning or not', async () => {
    for (const [id, tools] of [
      ['gpt-5.4', undefined],
      ['gpt-5.4', ECHO_TOOL],
      ['gpt-6.2-unreleased', undefined],
      ['gpt-6.2-unreleased', ECHO_TOOL],
    ] as const) {
      const { body } = await openaiRequest(responses(id), {}, tools);
      expect(body.store, `${id}/${tools ? 'tools' : 'no tools'}`).toBe(false);
    }
  });

  it('a reasoning model asks for encrypted reasoning even without tools', async () => {
    const { body } = await openaiRequest(responses('gpt-5.4'));
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    // A model that does not reason has nothing to round-trip.
    const plain = await openaiRequest(responses('gpt-6.2-unreleased'));
    expect('include' in plain.body).toBe(false);
  });

  it('providerOptions.openai.store:true opts back into server-side storage', async () => {
    const { body } = await openaiRequest(responses('gpt-5.4'), {
      providerOptions: { openai: { store: true } },
    });
    expect(body.store).toBe(true);
  });

  it('a caller-supplied include list is merged, not dropped', async () => {
    const { body } = await openaiRequest(responses('gpt-5.4'), {
      providerOptions: { openai: { include: ['message.output_text.logprobs'] } },
    });
    expect(body.include).toEqual(['reasoning.encrypted_content', 'message.output_text.logprobs']);
  });

  it('encrypted reasoning round-trips on a tool-less multi-turn conversation', async () => {
    const TURN = sseEvents([
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC_TOOLLESS' },
        },
      },
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'A' },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { status: 'completed', usage: {} } },
      },
    ]);
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TURN]),
      () => sseResponse([RESP_OK]),
    ]);
    const model = createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4');
    const first = await generateText({ model, messages: [{ role: 'user', content: 'q1' }] });
    await generateText({
      model,
      messages: [
        { role: 'user', content: 'q1' },
        ...first.response.messages,
        { role: 'user', content: 'q2' },
      ],
    });
    const second = JSON.parse(String(calls[1]!.init!.body)) as {
      input: Record<string, unknown>[];
      store: boolean;
    };
    expect(second.store).toBe(false);
    expect(second.input).toContainEqual({
      type: 'reasoning',
      id: 'rs_9',
      encrypted_content: 'ENC_TOOLLESS',
      summary: [],
    });
  });
});

// ===================================================================
// 2.3 (K4) — how a streamed Responses turn ends. The `incomplete_details`
// reasons come from openai 7.32's types; not live-verified.
// ===================================================================

describe('Responses finish reasons (2.3, K4)', () => {
  async function finishOf(turn: ResponsesTurn): Promise<string> {
    const { fetch } = consume([responsesTurn(turn)]);
    const result = streamChat({
      model: createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _ of result.fullStream) void _;
    return result.finishReason;
  }
  const call = { args: '{"city": "Ro' };

  it.each([
    [undefined, 'stop', 'tool_calls'],
    ['max_output_tokens', 'length', 'length'],
    ['content_filter', 'content_filter', 'content_filter'],
    // Undocumented beyond the name in openai 7.32, and WebSocket-only: as before.
    ['max_messages', 'stop', 'tool_calls'],
    ['steered', 'stop', 'tool_calls'],
  ] as const)(
    'incomplete %s ends a turn with %s, or %s after a call',
    async (incomplete, plain, afterCall) => {
      expect(await finishOf({ text: 'Partial', incomplete })).toBe(plain);
      expect(await finishOf({ call, incomplete })).toBe(afterCall);
    },
  );
});
