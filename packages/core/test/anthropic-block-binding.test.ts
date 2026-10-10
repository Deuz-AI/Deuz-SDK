/**
 * anthropic-block-binding.test.ts (2.3, F21 with F22's binding controls).
 *
 * Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking
 * block's signature to the conversation before it; on accounts opened from
 * 2026-08-31 a replayed block whose prefix changed fails the request with 400.
 * Now that every block is replayed (F21), a request that sends thinking back to
 * such a model asks for `thinking.block_binding.prefix_mismatch_behavior:
 * 'drop_block'` (beta `thinking-binding-controls-2026-08-01`), so the API drops
 * a mismatched block instead of failing, until the transcript prefix is stable
 * (F22). `providerOptions.anthropic` overrides it. The response's
 * `input_transformations` report surfaces as a typed warning.
 *
 * Request and response shapes come from @anthropic-ai/sdk 0.133.0's beta types;
 * the behaviour itself is not live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { mockFetch, mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import type { CommonCallOptions } from '../src/types/config';
import type { Message } from '../src/types/message';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';

const BETA = 'thinking-binding-controls-2026-08-01';
const DROP = { prefix_mismatch_behavior: 'drop_block' };

function done(extra: { start?: unknown; delta?: unknown } = {}): string {
  return sseEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          usage: { input_tokens: 5, output_tokens: 1 },
          ...(extra.start !== undefined ? { input_transformations: extra.start } : {}),
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
        ...(extra.delta !== undefined ? { input_transformations: extra.delta } : {}),
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

/** A conversation whose earlier assistant turn thought on Claude. */
const REPLAYS: Message[] = [
  { role: 'user', content: 'q' },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '', signature: 'S0', source: 'anthropic' },
      { type: 'text', text: 'Hi.' },
    ],
  },
  { role: 'user', content: 'more' },
];

const PLAIN: Message[] = [
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'Hi.' },
  { role: 'user', content: 'more' },
];

async function request(
  modelId: string,
  messages: Message[],
  options: Partial<CommonCallOptions> = {},
  settings: { headers?: Record<string, string> } = {},
) {
  const { fetch, calls } = mockFetch(() => sseResponse([done()]));
  await generateText({
    model: createAnthropic({ apiKey: 'k', fetch, ...settings })(modelId),
    messages,
    ...options,
  });
  const init = calls[0]!.init!;
  return {
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
    headers: init.headers as Record<string, string>,
  };
}

describe('block_binding default: replaying thinking to a binding Claude model', () => {
  it.each([
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-sonnet-5-6', // the 5.x family fallback: an unknown id gets the 5.x rules
  ])('%s: adaptive thinking with drop_block, under the beta header', async (id) => {
    const { body, headers } = await request(id, REPLAYS);
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: DROP });
    expect(headers['anthropic-beta']).toBe(BETA);
  });

  it('keeps output_config.effort as it was', async () => {
    const { body } = await request('claude-opus-5-5', REPLAYS, { effort: 'high' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: DROP });
  });

  it('a redacted block alone is a replay too', async () => {
    const { body } = await request('claude-opus-5-5', [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'R', redacted: true },
          { type: 'text', text: 'Hi.' },
        ],
      },
      { role: 'user', content: 'more' },
    ]);
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: DROP });
  });

  it('nothing changes when no thinking is replayed', async () => {
    const { body, headers } = await request('claude-opus-5-5', PLAIN, { effort: 'high' });
    expect(body.thinking).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    // Foreign reasoning is never replayed, so it does not count either.
    const foreign = await request('claude-opus-5-5', [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'ENC', encrypted: true, source: 'openai' },
          { type: 'text', text: 'Hi.' },
        ],
      },
      { role: 'user', content: 'more' },
    ]);
    expect(foreign.body.thinking).toBeUndefined();
    expect(foreign.headers['anthropic-beta']).toBeUndefined();
  });

  it.each(['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6'])(
    '%s binds no blocks: no binding is sent',
    async (id) => {
      const { body, headers } = await request(id, REPLAYS);
      expect(body.thinking === undefined || !('block_binding' in (body.thinking as object))).toBe(
        true,
      );
      expect(headers['anthropic-beta']).toBeUndefined();
    },
  );

  it("effort 'none' turns thinking off: disabled and between_tools carry no binding", async () => {
    const sonnet = await request('claude-sonnet-5-5', REPLAYS, { effort: 'none' });
    expect(sonnet.body.thinking).toEqual({ type: 'between_tools' });
    expect(sonnet.headers['anthropic-beta']).toBeUndefined();
    const haiku = await request('claude-haiku-5-5', REPLAYS, { effort: 'none' });
    expect(haiku.body.thinking).toEqual({ type: 'disabled' });
    expect(haiku.headers['anthropic-beta']).toBeUndefined();
  });
});

describe('providerOptions.anthropic overrides the binding', () => {
  it("an explicit block_binding is sent as given ('error')", async () => {
    const { body, headers } = await request('claude-opus-5-5', REPLAYS, {
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } },
        },
      },
    });
    expect(body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'error' },
    });
    expect(headers['anthropic-beta']).toBe(BETA);
  });

  it('block_binding: null sends no binding and no beta header', async () => {
    const { body, headers } = await request('claude-opus-5-5', REPLAYS, {
      providerOptions: { anthropic: { thinking: { type: 'adaptive', block_binding: null } } },
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('an explicit binding also applies to a model that binds nothing by default', async () => {
    const { body, headers } = await request('claude-opus-4-8', PLAIN, {
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        },
      },
    });
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: DROP });
    expect(headers['anthropic-beta']).toBe(BETA);
  });

  it("the caller's other thinking fields are kept next to the default", async () => {
    const { body } = await request('claude-opus-5-5', REPLAYS, {
      providerOptions: { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } },
    });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: DROP });
  });

  it("a caller's anthropic-beta header is merged, not replaced", async () => {
    const { headers } = await request(
      'claude-opus-5-5',
      REPLAYS,
      {},
      { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } },
    );
    expect(headers['anthropic-beta']).toBe(`interleaved-thinking-2025-05-14,${BETA}`);
  });
});

describe('input_transformations surface as a typed warning', () => {
  const DROPPED = [
    { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
    { type: 'thinking_dropped', path: 'messages.1.content.1', reason: 'prefix_binding_mismatch' },
  ];

  async function drain(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
    const parts: StreamPart[] = [];
    for await (const part of stream) parts.push(part);
    return parts;
  }

  it('streamChat: one warning part before finish, the raw report on the finish metadata', async () => {
    const { fetch } = mockFetch(() => sseResponse([done({ start: DROPPED })]));
    const parts = await drain(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
        messages: REPLAYS,
      }).fullStream,
    );
    const warnings = parts.filter((p) => p.type === 'warning');
    expect(warnings).toHaveLength(1);
    const warning = (warnings[0] as Extract<StreamPart, { type: 'warning' }>).warning;
    expect(warning.type).toBe('other');
    expect(warning.setting).toBe('thinking.block_binding');
    expect(warning.message).toContain('2 thinking blocks');
    expect(warning.message).toContain('prefix_binding_mismatch');
    expect(warning.message).toContain('messages.1.content.0');
    expect(parts.indexOf(warnings[0]!)).toBeLessThan(parts.findIndex((p) => p.type === 'finish'));
    const finish = parts.find((p) => p.type === 'finish') as Extract<
      StreamPart,
      { type: 'finish' }
    >;
    expect(finish.providerMetadata).toEqual({ anthropic: { input_transformations: DROPPED } });
  });

  it('a shown-anyway mismatch is reported too', async () => {
    const allowed = [
      {
        type: 'thinking_mismatch_allowed',
        path: 'messages.1.content.0',
        reason: 'prefix_binding_mismatch',
      },
    ];
    const { fetch } = mockFetch(() => sseResponse([done({ start: allowed })]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
      messages: REPLAYS,
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'other', setting: 'thinking.block_binding' }),
    ]);
    expect(result.warnings![0]!.message).toContain('shown to the model');
  });

  it("a server-side fallback's report in message_delta replaces message_start's", async () => {
    const replaced = [
      { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' },
    ];
    const { fetch } = mockFetch(() => sseResponse([done({ start: DROPPED, delta: replaced })]));
    const parts = await drain(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
        messages: REPLAYS,
      }).fullStream,
    );
    const finish = parts.find((p) => p.type === 'finish') as Extract<
      StreamPart,
      { type: 'finish' }
    >;
    expect(finish.providerMetadata).toEqual({ anthropic: { input_transformations: replaced } });
    const warning = parts.find((p) => p.type === 'warning') as Extract<
      StreamPart,
      { type: 'warning' }
    >;
    expect(warning.warning.message).toContain('model_binding_mismatch');
    expect(warning.warning.message).toContain('1 thinking block ');
  });

  it('an empty report is no warning and no metadata', async () => {
    const { fetch } = mockFetch(() => sseResponse([done({ start: [] })]));
    const parts = await drain(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
        messages: REPLAYS,
      }).fullStream,
    );
    expect(parts.some((p) => p.type === 'warning')).toBe(false);
    expect(parts.find((p) => p.type === 'finish')).not.toHaveProperty('providerMetadata');
  });

  it('a malformed report entry is skipped, never thrown on', async () => {
    const { fetch } = mockFetch(() => sseResponse([done({ start: [null, 'x', 7, DROPPED[0]] })]));
    const parts = await drain(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
        messages: REPLAYS,
      }).fullStream,
    );
    expect(parts.some((p) => p.type === 'error')).toBe(false);
    const warning = parts.find((p) => p.type === 'warning') as Extract<
      StreamPart,
      { type: 'warning' }
    >;
    expect(warning.warning.message).toContain('removed 1 thinking block ');
    const finish = parts.find((p) => p.type === 'finish') as Extract<
      StreamPart,
      { type: 'finish' }
    >;
    expect(finish.providerMetadata).toEqual({ anthropic: { input_transformations: [DROPPED[0]] } });
  });

  const LOOKUP: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };
  const toolCall = sseEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { usage: { input_tokens: 5, output_tokens: 1 }, input_transformations: DROPPED },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 2 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  it('the buffered loop reports it once on the result', async () => {
    const seq = mockFetchSequence([() => sseResponse([toolCall]), () => sseResponse([done()])]);
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: seq.fetch })('claude-opus-5-5'),
      messages: REPLAYS,
      tools: { lookup: { parameters: LOOKUP, execute: () => 'r' } },
      maxSteps: 3,
    });
    expect(result.warnings?.filter((w) => w.setting === 'thinking.block_binding')).toHaveLength(1);
  });

  it('the streaming loop streams it once and reports it on the result', async () => {
    const seq = mockFetchSequence([() => sseResponse([toolCall]), () => sseResponse([done()])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: seq.fetch })('claude-opus-5-5'),
      messages: REPLAYS,
      tools: { lookup: { parameters: LOOKUP, execute: () => 'r' } },
      maxSteps: 3,
    });
    const parts = await drain(result.fullStream);
    const streamed = parts.filter(
      (p) => p.type === 'warning' && p.warning.setting === 'thinking.block_binding',
    );
    expect(streamed).toHaveLength(1);
    expect(
      (await result.warnings)?.filter((w) => w.setting === 'thinking.block_binding'),
    ).toHaveLength(1);
  });
});
