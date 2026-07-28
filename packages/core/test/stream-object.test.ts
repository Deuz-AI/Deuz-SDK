import { describe, it, expect, vi } from 'vitest';
import { generateObject, streamObject } from '../src/index';
import { InvalidRequestError, NoObjectGeneratedError } from '../src/errors';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import type { JSONSchema } from '../src/types/schema';
import type { CommonCallOptions } from '../src/types/config';
import type { ToolSet } from '../src/types/tool';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

/** Anthropic json-mode SSE streaming the object text across the given deltas. */
function anthropicJsonStream(deltas: string[]): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    ...deltas.map((text) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

describe('streamObject (json strategy)', () => {
  it('streams growing partial objects, then resolves the validated final', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":', '"Par', 'is"}'])]),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'capital of France?' }],
      schema: SCHEMA,
    });

    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    expect(partials).toEqual([{}, { city: 'Par' }, { city: 'Paris' }]);

    expect(await result.object).toEqual({ city: 'Paris' });
    expect((await result.usage).totalTokens).toBeGreaterThan(0);
    expect(await result.finishReason).toBe('stop');

    // json strategy rode the native structured-output config.
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('does not emit when a delta changes nothing (cut mid-key)', async () => {
    const { fetch } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{', '"ci', 'ty":"Paris"}'])]),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    // Three deltas, two emissions — the mid-key delta parsed to the same {}.
    expect(partials).toEqual([{}, { city: 'Paris' }]);
  });

  it('rejects object AND the partial stream on invalid final JSON — no repair retry', async () => {
    const { fetch, calls } = mockFetch(
      () => sseResponse([anthropicJsonStream(['{"city": "Paris"'])]), // never closed
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });

    const partials: unknown[] = [];
    await expect(
      (async () => {
        for await (const p of result.partialObjectStream) partials.push(p);
      })(),
    ).rejects.toBeInstanceOf(NoObjectGeneratedError);
    expect(partials).toEqual([{ city: 'Paris' }]); // best-effort partial WAS emitted

    await expect(result.object).rejects.toBeInstanceOf(NoObjectGeneratedError);
    await expect(result.object).rejects.toMatchObject({ text: '{"city": "Paris"' });
    // usage/finishReason still resolve — the tokens were spent.
    expect((await result.usage).totalTokens).toBeGreaterThan(0);
    expect(await result.finishReason).toBe('stop');
    expect(calls).toHaveLength(1); // documented divergence from generateObject: no repair retry
  });

  it('G2: returns synchronously and starts the pump lazily', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    expect(calls).toHaveLength(0); // nothing accessed yet — no network
    expect(await result.object).toEqual({ city: 'Paris' });
    expect(calls).toHaveLength(1);
  });

  it('surfaces transport errors as rejections, never a sync throw', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    await expect(
      (async () => {
        for await (const _ of result.partialObjectStream) void _;
      })(),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(result.object).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(result.usage).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(result.finishReason).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

// ---------------------------------------------------------------------------
// 1.9 (2.4): consume() on StreamObjectResult. The pump is lazy (G2), so without
// a consumer the terminal effects (onUsage/onFinish) never ran.
// ---------------------------------------------------------------------------

describe('streamObject consume() (1.9)', () => {
  it('drains and fires the terminal effects with NO iteration by the caller', async () => {
    const onUsage = vi.fn();
    const onFinish = vi.fn();
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]),
    );
    const result = streamObject<{ city: string }>({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      onUsage,
      onFinish,
    });
    expect(calls).toHaveLength(0); // lazy — nothing accessed yet
    await expect(result.consume?.()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(await result.object).toEqual({ city: 'Paris' });
  });

  it('NEVER rejects on a validation failure — the error goes to onError', async () => {
    const { fetch } = mockFetch(() => sseResponse([anthropicJsonStream(['{"city": "Paris"'])]));
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    const errors: unknown[] = [];
    await expect(result.consume?.({ onError: (e) => errors.push(e) })).resolves.toBeUndefined();
    expect(errors[0]).toBeInstanceOf(NoObjectGeneratedError);
    // Still a rejection on `object` — consume() reports, it does not swallow.
    await expect(result.object).rejects.toBeInstanceOf(NoObjectGeneratedError);
    // And with no handler at all it stays silent.
    await expect(result.consume?.()).resolves.toBeUndefined();
  });

  it('is safe to call twice (one upstream request) and leaves partialObjectStream intact', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":', '"Paris"}'])]),
    );
    const result = streamObject<{ city: string }>({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    const partials: unknown[] = [];
    const iterated = (async () => {
      for await (const p of result.partialObjectStream) partials.push(p);
    })();
    await Promise.all([result.consume?.(), result.consume?.()]);
    await iterated;
    expect(calls).toHaveLength(1);
    // The drain used its OWN subscription — the caller's partials are complete.
    expect(partials).toEqual([{}, { city: 'Paris' }]);
  });
});

describe('streamObject (tool strategy — buffered)', () => {
  const TOOL_STREAM = sseEvents([
    {
      data: {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'json_output', arguments: '' } },
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

  it('emits the final validated object exactly once', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([TOOL_STREAM]));
    const result = streamObject({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      mode: 'tool',
    });
    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    expect(partials).toEqual([{ city: 'Paris' }]); // single buffered emission
    expect(await result.object).toEqual({ city: 'Paris' });

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.tool_choice).toBeDefined(); // tool coercion rode the wire
  });
});

// ---------------------------------------------------------------------------
// 1.9: loop options an object call cannot honour must FAIL LOUD.
// Until 1.9 `generateObject({ …, tools })` type-checked, ran, and dropped the
// tools in silence — the guard turns that into an InvalidRequestError.
// ---------------------------------------------------------------------------

const WEATHER: ToolSet = {
  weather: {
    description: 'current weather',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'sunny',
  },
};

/** Every ignored key at once. Cast because the surface INTENTIONALLY still
 *  accepts them (narrowing GenerateObjectOptions would be a breaking type
 *  change) — the point is that detection happens at RUNTIME. */
const EVERY_IGNORED_OPTION = {
  tools: WEATHER,
  toolChoice: 'auto',
  maxSteps: 4,
  stopWhen: () => false,
  budget: { usd: 1 },
  maxToolConcurrency: 2,
  onStepFinish: () => {},
  prepareStep: () => undefined,
  activeTools: ['weather'],
  verifyStep: () => undefined,
  maxVerifyAttempts: 2,
  compaction: 'auto',
  approveToolCall: () => true,
  approvalResponses: [{ approvalId: 'a1', approved: true }],
  session: { store: { save: () => {}, load: () => undefined } },
  chat: { store: {}, chatId: 'c1', scope: { userId: 'u1' } },
  memory: { seams: {}, scope: { userId: 'u1' } },
  fallbackModels: [createAnthropic({ apiKey: 'k' })('claude-opus-4-8')],
  approvalSigner: { sign: async () => 't', verify: async () => null },
  approvalMaxAgeMs: 5_000,
} as unknown as Partial<CommonCallOptions>;

/** Declaration order of `CommonCallOptions` — the guard's list is stable. */
const EVERY_IGNORED_KEY = [
  'tools',
  'toolChoice',
  'maxSteps',
  'stopWhen',
  'budget',
  'maxToolConcurrency',
  'onStepFinish',
  'prepareStep',
  'activeTools',
  'verifyStep',
  'maxVerifyAttempts',
  'compaction',
  'approveToolCall',
  'approvalResponses',
  'session',
  'chat',
  'memory',
  'fallbackModels',
  'approvalSigner',
  'approvalMaxAgeMs',
];

/** The keys the error message actually listed. */
function listedKeys(message: string): string[] {
  const match = /silently: (.+?)\. Structured/.exec(message);
  return match?.[1] ? match[1].split(', ') : [];
}

describe('object calls reject silently-ignored loop options (1.9)', () => {
  it('generateObject rejects with InvalidRequestError naming tools — nothing reaches the wire', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]),
    );
    const promise = generateObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      tools: WEATHER, // type-checks (surface is locked) but was never sent
    });
    await expect(promise).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(promise).rejects.toThrow(/tools/);
    await expect(promise).rejects.toThrow(/generateText\/streamChat/);
    expect(calls).toHaveLength(0); // failed before any network work
  });

  it('names EVERY ignored option that was present, in a stable order', async () => {
    const { fetch } = mockFetch(() => sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]));
    const err = await generateObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      ...EVERY_IGNORED_OPTION,
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(listedKeys(err!.message)).toEqual(EVERY_IGNORED_KEY);
  });

  it('streamObject surfaces the failure on the stream and rejects object (G2: no sync throw)', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]),
    );
    const make = (): ReturnType<typeof streamObject> =>
      streamObject({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'hi' }],
        schema: SCHEMA,
        session: { store: { save: () => {}, load: () => undefined } },
      });
    let result!: ReturnType<typeof make>;
    expect(() => {
      result = make();
    }).not.toThrow();

    await expect(
      (async () => {
        for await (const p of result.partialObjectStream) void p;
      })(),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(result.object).rejects.toThrow(/session/);
    await expect(result.usage).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(result.finishReason).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('a clean generateObject call is unaffected', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]),
    );
    const res = await generateObject<{ city: string }>({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
    });
    expect(res.object).toEqual({ city: 'Paris' });
    expect(calls).toHaveLength(1);
  });

  it('no false positives: every HONOURED option (and empty collections) passes the guard', async () => {
    const onUsage = vi.fn();
    const onFinish = vi.fn();
    const controller = new AbortController();
    // Honoured on an object call — verified against generate-object.ts /
    // core/inference.ts / the adapters. Flagging any of these would break
    // working code, which is worse than the silent-drop bug being fixed.
    const honoured = {
      signal: controller.signal,
      maxRetries: 1,
      headers: { 'x-test': '1' },
      deps: {},
      onUsage,
      onFinish,
      temperature: 0.2,
      maxOutputTokens: 256,
      topP: 0.9,
      stopSequences: ['\n\n'],
      effort: 'none',
      responseFormat: 'json',
      providerOptions: { anthropic: { foo: 'bar' } },
      promptCaching: 'auto',
      agentPath: ['planner'],
      // Empty/default-valued loop options ask for NOTHING — a generic wrapper
      // that always spreads them behaves identically today, so they must pass.
      tools: {},
      activeTools: [],
      maxSteps: 1,
      budget: {},
      stopWhen: [],
      approvalResponses: [],
      fallbackModels: [],
    } satisfies Partial<CommonCallOptions>;

    const gen = mockFetch(() => sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]));
    const res = await generateObject<{ city: string }>({
      model: createAnthropic({ apiKey: 'k', fetch: gen.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      ...honoured,
    });
    expect(res.object).toEqual({ city: 'Paris' });
    expect(gen.calls).toHaveLength(1);
    expect((gen.calls[0]!.init!.headers as Record<string, string>)['x-test']).toBe('1');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);

    const str = mockFetch(() => sseResponse([anthropicJsonStream(['{"city":"Paris"}'])]));
    const streamed = streamObject<{ city: string }>({
      model: createAnthropic({ apiKey: 'k', fetch: str.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      ...honoured,
    });
    expect(await streamed.object).toEqual({ city: 'Paris' });
  });
});
