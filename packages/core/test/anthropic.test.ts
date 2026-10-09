import { describe, it, expect, vi } from 'vitest';
import { streamChat, generateText, generateObject, streamObject } from '../src/index';
import { ContextOverflowError, InvalidRequestError } from '../src/errors';
import { createAnthropic } from '../src/anthropic';
import { runStream } from '../src/core/inference';
import { withCapabilityOverride } from '../src/internal/config-symbol';
import { createWarningSink } from '../src/internal/warnings';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';
import type { CommonCallOptions } from '../src/types/config';
import type { CallWarning } from '../src/types/methods';
import type { WireToolRequest } from '../src/adapters/types';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const TEXT_STREAM = sseEvents([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 25,
          output_tokens: 1,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 0,
        },
      },
    },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think.' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'SIG123' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 12 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function model(chunks: string[]) {
  const { fetch, calls } = mockFetch(() => sseResponse(chunks));
  return { provider: createAnthropic({ apiKey: 'test', fetch }), calls };
}

describe('Anthropic streamChat (vertical slice)', () => {
  it('streams text, reasoning(+signature), usage and finishReason', async () => {
    const { provider } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });

    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);

    expect(parts.map((p) => p.type)).toEqual([
      'reasoning-delta',
      'reasoning-delta',
      'text-delta',
      'text-delta',
      'finish',
    ]);
    const sig = parts.find((p) => p.type === 'reasoning-delta' && p.signature);
    expect(sig && sig.type === 'reasoning-delta' && sig.signature).toBe('SIG123');

    const usage = await result.usage;
    expect(usage).toEqual({
      inputTokens: 25,
      outputTokens: 12,
      reasoningTokens: 0,
      cachedReadTokens: 10,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 47,
    });
    expect(await result.finishReason).toBe('stop');
  });

  it('textStream yields only the text projection', async () => {
    const { provider } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('Hello world');
  });

  it('sends x-api-key + anthropic-version and a system slot', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    for await (const _ of result.fullStream) void _;
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.system).toBe('be brief');
    expect(body.messages).toHaveLength(1);
    expect(body.max_tokens).toBe(128_000);
  });

  it('streamChat returns synchronously and does not throw on a missing key', async () => {
    const { fetch } = mockFetch(() => sseResponse([TEXT_STREAM]));
    // No api key anywhere → must surface via the stream, not a sync throw.
    const m = { provider: 'anthropic', modelId: 'claude-opus-4-8', surface: 'anthropic' as const };
    void fetch;
    const result = streamChat({ model: m, messages: [{ role: 'user', content: 'hi' }] });
    await expect(
      (async () => {
        for await (const _ of result.fullStream) void _;
      })(),
    ).resolves.toBeUndefined(); // fullStream yields an error part then ends (no throw)
    await expect(result.usage).rejects.toMatchObject({ code: 'authentication' });
  });
});

describe('Anthropic generateText (buffered, single-turn)', () => {
  it('buffers text + preserves reasoning/signature in response.messages', async () => {
    const { provider } = model([TEXT_STREAM]);
    const res = await generateText({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('Hello world');
    expect(res.finishReason).toBe('stop');
    const content = res.response.messages[0]!.content as Array<{
      type: string;
      signature?: string;
    }>;
    expect(content[0]).toMatchObject({ type: 'reasoning', signature: 'SIG123' });
    expect(content[1]).toMatchObject({ type: 'text' });
  });
});

describe('Anthropic generateObject (json mode)', () => {
  const JSON_STREAM = sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '{"city":' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '"Paris"}' },
      },
    },
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

  const schema: JSONSchema = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  };

  it('parses a JSON object via native output_config', async () => {
    const { provider, calls } = model([JSON_STREAM]);
    const res = await generateObject({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'capital of France?' }],
      schema,
    });
    expect(res.object).toEqual({ city: 'Paris' });

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });
});

// --- 0.2.0: effort wire, usage extensions, refusal stop_details ---

function lastBody(calls: { url: string; init?: RequestInit }[]): Record<string, unknown> {
  return JSON.parse(String(calls[calls.length - 1]!.init!.body)) as Record<string, unknown>;
}

const TEXT_STREAM_JSON = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '{"a":"x"}' },
    },
  },
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

describe('Anthropic effort wire (0.2.0)', () => {
  it('fable-5: effort → output_config.effort, no thinking block, sampling stripped', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
      temperature: 0.2,
      topP: 0.9,
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBe(128_000); // caps.maxOutput, no budget bump
  });

  it('fable-5 without effort sends neither thinking nor output_config', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('opus-4-6 keeps the legacy budget_tokens path; xhigh/max map to 48k', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-6'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 48_000 });
    expect(body.output_config).toBeUndefined();
  });

  it('output_config.effort merges with json structured-output format', async () => {
    const { provider, calls } = model([TEXT_STREAM_JSON]);
    await generateObject({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
      schema: { type: 'object', properties: { a: { type: 'string' } } } as JSONSchema,
    });
    const body = lastBody(calls);
    const oc = body.output_config as Record<string, unknown>;
    expect(oc.effort).toBe('high');
    expect(oc.format).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { a: { type: 'string' } } },
    });
  });
});

describe('Anthropic usage extensions (0.2.0)', () => {
  it('maps output_tokens_details.thinking_tokens to reasoningTokens', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
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
          usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const usage = await result.usage;
    expect(usage.reasoningTokens).toBe(7);
    expect(usage.outputTokens).toBe(20); // thinking stays inside output_tokens (billing unchanged)
    expect(usage.totalTokens).toBe(30);
  });

  it('sums usage.iterations when present (fallbacks/compaction)', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
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
          usage: {
            output_tokens: 20,
            iterations: [
              { type: 'message', input_tokens: 10, output_tokens: 3 },
              { type: 'fallback_message', input_tokens: 12, output_tokens: 20 },
            ],
          },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const usage = await result.usage;
    // Iterations replace the top-level attempt view: inputs and outputs sum across attempts.
    expect(usage.inputTokens).toBe(22);
    expect(usage.outputTokens).toBe(23);
    expect(usage.totalTokens).toBe(45);
  });
});

describe('Anthropic context management interop (1.4.0)', () => {
  const CONTEXT_MANAGEMENT = { edits: [{ type: 'clear_tool_uses_20250919' }] };

  it('passes providerOptions.anthropic.context_management to the request body verbatim', async () => {
    const { provider, calls } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { anthropic: { context_management: CONTEXT_MANAGEMENT } },
    });
    await result.finishReason;
    const body = lastBody(calls);
    expect(body.context_management).toEqual(CONTEXT_MANAGEMENT);
  });

  it('surfaces message_delta context_management as providerMetadata.anthropic.contextManagement', async () => {
    const appliedEdits = {
      applied_edits: [
        { type: 'clear_tool_uses_20250919', cleared_tool_uses: 3, cleared_input_tokens: 5_000 },
      ],
    };
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
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
          usage: { output_tokens: 4 },
          context_management: appliedEdits,
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const finish = parts.find((p) => p.type === 'finish');
    const meta =
      finish && finish.type === 'finish'
        ? (finish.providerMetadata?.anthropic as { contextManagement?: unknown })
        : undefined;
    expect(meta?.contextManagement).toEqual(appliedEdits);
  });

  it('finish part carries no contextManagement (and no providerMetadata) on a normal stream', async () => {
    const { provider } = model([TEXT_STREAM]);
    const result = streamChat({
      model: provider('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish && finish.type === 'finish' && finish.providerMetadata).toBeUndefined();
  });
});

describe('Anthropic refusal stop_details (0.2.0)', () => {
  it('maps refusal → content_filter and carries stop_details on the finish part', async () => {
    const stream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'blocked' },
          },
          usage: { output_tokens: 0 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { provider } = model([stream]);
    const result = streamChat({
      model: provider('claude-fable-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish && finish.type === 'finish' && finish.finishReason).toBe('content_filter');
    const meta =
      finish && finish.type === 'finish'
        ? (finish.providerMetadata?.anthropic as { stop_details?: { category?: string } })
        : undefined;
    expect(meta?.stop_details?.category).toBe('cyber');
  });
});

describe('Anthropic context overflow mapping (2.0)', () => {
  /** Drive one failing call and hand back the mapped error part. */
  async function errorFrom(status: number, error: { type: string; message: string }) {
    const fetch = (async () =>
      new Response(JSON.stringify({ type: 'error', error }), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'test', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 0,
    });
    const usage = result.usage.catch((e: unknown) => e);
    const finish = result.finishReason.catch((e: unknown) => e);
    const errors: unknown[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'error') errors.push(part.error);
    }
    await Promise.all([usage, finish]);
    return errors[0];
  }

  it('maps a 400 "prompt is too long" to ContextOverflowError', async () => {
    // Anthropic ships no code for this — the message is the ONLY signal, and
    // the loop's overflow recovery keys on the error class.
    const error = await errorFrom(400, {
      type: 'invalid_request_error',
      message: 'prompt is too long: 210000 tokens > 200000 maximum',
    });
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error).toMatchObject({
      code: 'context_overflow',
      provider: 'anthropic',
      statusCode: 400,
      isRetryable: false,
    });
  });

  it('maps a 413 request_too_large to ContextOverflowError', async () => {
    const error = await errorFrom(413, {
      type: 'request_too_large',
      message: 'Request body too large',
    });
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error).toMatchObject({ statusCode: 413, isRetryable: false });
  });

  it('leaves ordinary invalid requests as InvalidRequestError', async () => {
    const error = await errorFrom(400, {
      type: 'invalid_request_error',
      message: 'messages: at least one message is required',
    });
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).not.toBeInstanceOf(ContextOverflowError);
  });
});

// ===================================================================
// 2.3 (F26) — every value the Anthropic wire changes is reported. The
// `clamped-setting` warning type existed since 1.9 but was never emitted.
// ===================================================================

describe('Anthropic clamps are reported, never silent (2.3, F26)', () => {
  it("budget_tokens wire: 'xhigh' and 'max' share the 48k budget → clamped-setting", async () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const { body, warnings } = await claudeRequest('claude-opus-4-6', { effort });
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 48_000 });
      const clamp = warnings.find((w) => w.type === 'clamped-setting');
      expect(clamp, effort).toMatchObject({ setting: 'effort' });
      expect(clamp!.message).toContain('48000');
    }
    // A level with its own budget is not a clamp.
    const high = await claudeRequest('claude-opus-4-6', { effort: 'high' });
    expect(high.body.thinking).toEqual({ type: 'enabled', budget_tokens: 24_000 });
    expect(high.warnings).toEqual([]);
  });

  it('temperature and topP dropped while extended thinking is on → clamped-setting each', async () => {
    const { body, warnings } = await claudeRequest('claude-opus-4-6', {
      effort: 'high',
      temperature: 0.2,
      topP: 0.9,
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(settingsOf(warnings, 'clamped-setting')).toEqual(['temperature', 'topP']);
    // Without thinking the same values ride the wire, and nothing is reported.
    const free = await claudeRequest('claude-opus-4-6', { temperature: 0.2 });
    expect(free.body.temperature).toBe(0.2);
    expect(free.warnings).toEqual([]);
  });

  it('an explicit maxOutputTokens raised to fit the thinking budget is reported', async () => {
    const { body, warnings } = await claudeRequest('claude-opus-4-6', {
      effort: 'max',
      maxOutputTokens: 1_000,
    });
    expect(body.max_tokens).toBe(49_024);
    const raised = warnings.find((w) => w.setting === 'maxOutputTokens');
    expect(raised).toMatchObject({ type: 'clamped-setting' });
    expect(raised!.message).toContain('1000');
    expect(raised!.message).toContain('49024');
  });

  it('forced toolChoice under extended thinking falls back to auto — and now says so', async () => {
    const { body, warnings } = await claudeRequest(
      'claude-opus-4-6',
      { effort: 'high' },
      { tools: [WEATHER_TOOL], toolChoice: 'required' },
    );
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(settingsOf(warnings, 'clamped-setting')).toEqual(['toolChoice']);
  });

  it('the clamp is logged once per run, not once per rebuilt request', async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const sink = createWarningSink();
    const { fetch } = mockFetch(() => sseResponse([TEXT_STREAM_JSON]));
    for (let step = 0; step < 3; step++) {
      const result = runStream(
        {
          model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-6'),
          messages: [{ role: 'user', content: 'hi' }],
          effort: 'max',
          deps: { logger },
        },
        { warnings: sink },
      );
      for await (const _ of result.fullStream) void _;
    }
    expect(sink.list().filter((w) => w.type === 'clamped-setting')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      warning: 'clamped-setting',
      setting: 'effort',
      modelId: 'claude-opus-4-6',
    });
  });
});

// ===================================================================
// 2.3 (F14) — Claude 5.x request rules. Verified against Anthropic's API
// reference (cached 2026-10-06), NOT live-verified: the 400s these guard
// against are inferred from the documented rules, so the tests pin the
// REQUEST the SDK builds, per model id.
// ===================================================================

const CLAUDE_5 = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
/** An id the registry has never heard of, in the 5.x family → family fallback rules. */
const FAMILY_ID = 'claude-opus-9-9';

const WEATHER_TOOL: WireToolRequest['tools'][number] = {
  name: 'get_weather',
  description: 'Weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

/**
 * Drive ONE request through the real pump and hand back the wire body + warnings.
 * The pump is called directly (so a tool request needs no loop); the per-call
 * `capabilities` is folded into the descriptor exactly as the public call
 * boundary (`generate.ts`) does.
 */
async function claudeRequest(
  modelId: string,
  options: Partial<CommonCallOptions> = {},
  tools?: WireToolRequest,
): Promise<{ body: Record<string, unknown>; warnings: CallWarning[] }> {
  const { fetch, calls } = mockFetch(() => sseResponse([TEXT_STREAM_JSON]));
  const result = runStream(
    {
      ...options,
      model: withCapabilityOverride(
        createAnthropic({ apiKey: 'k', fetch })(modelId),
        options.capabilities,
      ),
      messages: [{ role: 'user', content: 'hi' }],
    },
    tools ? { tools } : {},
  );
  for await (const _ of result.fullStream) void _;
  return { body: lastBody(calls), warnings: await result.warnings! };
}

const settingsOf = (warnings: CallWarning[], type: CallWarning['type']) =>
  warnings.filter((w) => w.type === type).map((w) => w.setting);

describe('Claude 5.x request rules (2.3, F14)', () => {
  it('every id × effort max/high/low × temperature 0.2 sends ONLY output_config.effort', async () => {
    for (const id of [...CLAUDE_5, FAMILY_ID]) {
      for (const effort of ['max', 'high', 'low'] as const) {
        const { body } = await claudeRequest(id, { effort, temperature: 0.2, topP: 0.9 });
        expect(body.output_config, `${id}/${effort}`).toEqual({ effort });
        expect(body.thinking, `${id}/${effort}`).toBeUndefined();
        expect(body.temperature, `${id}/${effort}`).toBeUndefined();
        expect(body.top_p, `${id}/${effort}`).toBeUndefined();
        expect(body.max_tokens, `${id}/${effort}`).toBe(128_000);
      }
    }
  });

  it('the dropped sampling parameters are reported, never silent', async () => {
    const { warnings } = await claudeRequest('claude-opus-5-5', { temperature: 0.2, topP: 0.9 });
    expect(settingsOf(warnings, 'unsupported-setting')).toEqual(['temperature', 'topP']);
  });

  it("forced toolChoice ('required' / a named tool) becomes auto + clamped-setting where it is rejected", async () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', FAMILY_ID]) {
      for (const toolChoice of ['required', { type: 'tool', toolName: 'get_weather' }] as const) {
        // Without effort too: these models think by default, so forcing is always a 400.
        const { body, warnings } = await claudeRequest(
          id,
          {},
          { tools: [WEATHER_TOOL], toolChoice },
        );
        expect(body.tool_choice, id).toEqual({ type: 'auto' });
        expect(settingsOf(warnings, 'clamped-setting'), id).toEqual(['toolChoice']);
      }
    }
  });

  it('Haiku 5.5 accepts a forced tool_choice (thinking is skipped), so it is sent as-is', async () => {
    const { body, warnings } = await claudeRequest(
      'claude-haiku-5-5',
      { effort: 'high' },
      { tools: [WEATHER_TOOL], toolChoice: 'required' },
    );
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(warnings).toEqual([]);
  });

  it("toolChoice 'none' and 'auto' are never clamped", async () => {
    for (const toolChoice of ['none', 'auto'] as const) {
      const { body, warnings } = await claudeRequest(
        'claude-opus-5-5',
        {},
        { tools: [WEATHER_TOOL], toolChoice },
      );
      expect(body.tool_choice).toEqual({ type: toolChoice });
      expect(warnings).toEqual([]);
    }
  });

  it("effort 'none': Sonnet 5.5 → thinking between_tools, nothing else", async () => {
    const { body, warnings } = await claudeRequest('claude-sonnet-5-5', { effort: 'none' });
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.output_config).toBeUndefined(); // the API default (high) is within the ≤ high limit
    expect(warnings).toEqual([]);
  });

  it("effort 'none': Haiku 5.5 → thinking disabled, nothing else", async () => {
    const { body, warnings } = await claudeRequest('claude-haiku-5-5', { effort: 'none' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toBeUndefined(); // the API default (medium) is within the limit
    expect(warnings).toEqual([]);
  });

  it("effort 'none': Opus 5 disables thinking and pins effort low (its default is undocumented)", async () => {
    const { body, warnings } = await claudeRequest('claude-opus-5', { effort: 'none' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(warnings).toEqual([]);
  });

  it("effort 'none': Fable 5.1, Opus 5.5 and the family fallback cannot disable thinking → low + clamped-setting", async () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', FAMILY_ID]) {
      const { body, warnings } = await claudeRequest(id, { effort: 'none' });
      expect(body.thinking, id).toBeUndefined();
      expect(body.output_config, id).toEqual({ effort: 'low' });
      const clamp = warnings.find((w) => w.type === 'clamped-setting');
      expect(clamp, id).toMatchObject({ setting: 'effort' });
      expect(clamp!.message).toContain("'none'");
      expect(clamp!.message).toContain("'low'");
    }
  });

  it('the documented capabilities override cannot put budget_tokens or temperature on the wire', async () => {
    // F14's broken cure: `{ reasoning: true }` on an unknown 5.x id used to send budget_tokens.
    const cured = await claudeRequest(FAMILY_ID, {
      effort: 'high',
      temperature: 0.2,
      capabilities: { reasoning: true },
    });
    expect(cured.body.thinking).toBeUndefined();
    expect(cured.body.output_config).toEqual({ effort: 'high' });
    expect(cured.body.temperature).toBeUndefined();

    // Even an override that explicitly claims the old wire is overruled — and says so.
    const forced = await claudeRequest('claude-opus-5-5', {
      effort: 'max',
      temperature: 0.2,
      capabilities: { effortWire: 'budget_tokens', samplingRestrictions: false },
    });
    expect(forced.body.thinking).toBeUndefined();
    expect(forced.body.output_config).toEqual({ effort: 'max' });
    expect(forced.body.temperature).toBeUndefined();
    expect(forced.warnings.find((w) => w.setting === 'capabilities')).toMatchObject({
      type: 'unsupported-setting',
    });
  });

  it('an unknown non-family slug still sends the required max_tokens, and the warning documents it', async () => {
    const plain = await claudeRequest('claude-unreleased-9');
    expect(plain.body.max_tokens).toBe(4_096);
    const unknown = plain.warnings.filter((w) => w.type === 'unknown-model');
    expect(unknown).toHaveLength(1); // the default is named in THE warning — no second one
    expect(unknown[0]!.message).toContain('max_tokens 4096');
    expect(unknown[0]!.message).toContain('maxOutputTokens');
    expect(unknown[0]!.message).toContain('capabilities: { maxOutput }');

    // Configured: the override reaches the wire and the note is no longer true, so it goes.
    const configured = await claudeRequest('claude-unreleased-9', {
      capabilities: { maxOutput: 32_000 },
    });
    expect(configured.body.max_tokens).toBe(32_000);
    expect(configured.warnings[0]!.message).not.toContain('max_tokens');
  });

  it('a dropped promptCaching is reported on the Anthropic wire', async () => {
    const { body, warnings } = await claudeRequest('claude-unreleased-9', {
      promptCaching: 'auto',
    });
    expect(body.cache_control).toBeUndefined();
    expect(warnings.find((w) => w.setting === 'promptCaching')).toMatchObject({
      type: 'unsupported-setting',
    });
  });

  it('prompt caching reaches the wire on the 5.x rows (it used to be dropped)', async () => {
    for (const id of [...CLAUDE_5, FAMILY_ID]) {
      const { body } = await claudeRequest(id, { promptCaching: 'auto-1h' });
      expect(body.cache_control, id).toEqual({ type: 'ephemeral', ttl: '1h' });
    }
  });

  it('generateObject / streamObject use output_config.format — never the forced-tool strategy', async () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    } as JSONSchema;
    for (const id of [...CLAUDE_5, FAMILY_ID]) {
      for (const mode of ['auto', 'tool'] as const) {
        const gen = mockFetch(() => sseResponse([TEXT_STREAM_JSON]));
        await generateObject({
          model: createAnthropic({ apiKey: 'k', fetch: gen.fetch })(id),
          messages: [{ role: 'user', content: 'hi' }],
          schema,
          mode,
        });
        const body = lastBody(gen.calls);
        expect(body.output_config, `${id}/${mode}`).toEqual({
          format: { type: 'json_schema', schema },
        });
        expect(body.tools, `${id}/${mode}`).toBeUndefined();
        expect(body.tool_choice, `${id}/${mode}`).toBeUndefined();
      }
      const str = mockFetch(() => sseResponse([TEXT_STREAM_JSON]));
      const streamed = streamObject({
        model: createAnthropic({ apiKey: 'k', fetch: str.fetch })(id),
        messages: [{ role: 'user', content: 'hi' }],
        schema,
        mode: 'tool',
      });
      expect(await streamed.object).toEqual({ a: 'x' });
      expect(lastBody(str.calls).tool_choice, id).toBeUndefined();
    }
  });
});
