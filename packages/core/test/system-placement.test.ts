/**
 * system-placement.test.ts (2.3, F22): where a `role: 'system'` message lands
 * on each wire.
 *
 * The top-level system slot is the LEADING run of system messages only. A
 * system message after the first non-system message is a mid-conversation
 * system message: Claude 5.x (the models that bind thinking to the transcript
 * prefix) takes it in place as a `role: 'system'` message, which
 * `@anthropic-ai/sdk` 0.133.0 types as part of `MessageParam`; OpenAI
 * Responses takes it in place as a `system` input item; Chat Completions kept
 * it in place already; Gemini (`Content.role` is 'user' or 'model' only) and
 * the older Claude models fold it into the top-level instruction, as 2.2 did.
 * Not live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { extractSystem, normalizeMessages } from '../src/core/normalize';
import { bindsThinkingToPrefix } from '../src/internal/stable-prefix';
import { mockFetch, sseEvents, sseResponse } from '../src/testing';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';

const ANTHROPIC_OK = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
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
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
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
const GEMINI_OK = sseEvents([
  {
    data: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
    },
  },
]);

/** A history whose second system message comes after the conversation started. */
const HISTORY: Message[] = [
  { role: 'system', content: 'A' },
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' },
  { role: 'system', content: 'B' },
  { role: 'user', content: 'q2' },
];

async function wireBody(
  make: (fetch: typeof globalThis.fetch) => LanguageModel,
  ok: string,
  messages: Message[] = HISTORY,
): Promise<Record<string, unknown>> {
  const { fetch, calls } = mockFetch(() => sseResponse([ok]));
  await generateText({ model: make(fetch), messages });
  return JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
}

const claude = (id: string) => (fetch: typeof globalThis.fetch) =>
  createAnthropic({ apiKey: 'k', fetch })(id);

describe('extractSystem: the top-level slot is the leading system run (2.3, F22)', () => {
  it('in place: a later system message stays where it is', () => {
    const { system, rest } = extractSystem(normalizeMessages(HISTORY), { inPlace: true });
    expect(system).toBe('A');
    expect(rest.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'user']);
  });

  it('fold (the default): every system text joins the top-level slot in array order, as in 2.2', () => {
    const { system, rest } = extractSystem(normalizeMessages(HISTORY));
    expect(system).toBe('A\n\nB');
    expect(rest.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('a leading run of several system messages is all top-level, in both modes', () => {
    const messages = normalizeMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q' },
    ]);
    expect(extractSystem(messages, { inPlace: true }).system).toBe('A\n\nB');
    expect(extractSystem(messages).system).toBe('A\n\nB');
  });

  it('a system message without text adds nothing to the top-level slot', () => {
    const messages = normalizeMessages([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q' },
      { role: 'system', content: [] },
    ]);
    expect(extractSystem(messages)).toEqual({
      system: 'A',
      rest: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    });
  });
});

describe('which models bind thinking to the prefix', () => {
  it.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])(
    '%s on the Anthropic wire',
    (modelId) => {
      expect(bindsThinkingToPrefix({ provider: 'anthropic', modelId, surface: 'anthropic' })).toBe(
        true,
      );
    },
  );

  it('an unknown 5.x id on the family fallback', () => {
    expect(
      bindsThinkingToPrefix({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5-6',
        surface: 'anthropic',
      }),
    ).toBe(true);
  });

  it('not an older Claude, and not another wire', () => {
    expect(
      bindsThinkingToPrefix({
        provider: 'anthropic',
        modelId: 'claude-opus-4-8',
        surface: 'anthropic',
      }),
    ).toBe(false);
    expect(
      bindsThinkingToPrefix({
        provider: 'openai',
        modelId: 'claude-opus-5-5',
        surface: 'chat_completions',
      }),
    ).toBe(false);
  });
});

describe('a mid-conversation system message on each wire', () => {
  it('Claude 5.x: in place as a role:system message; the top-level system is the leading run', async () => {
    const body = await wireBody(claude('claude-opus-5-5'), ANTHROPIC_OK);
    expect(body.system).toBe('A');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'system', content: [{ type: 'text', text: 'B' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ]);
  });

  it('an older Claude keeps the 2.2 fold (the request it sent before)', async () => {
    const body = await wireBody(claude('claude-opus-4-8'), ANTHROPIC_OK);
    expect(body.system).toBe('A\n\nB');
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('OpenAI Responses: leading run in `instructions`, the later one a system input item in place', async () => {
    const body = await wireBody(
      (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.5'),
      RESP_OK,
    );
    expect(body.instructions).toBe('A');
    expect(body.input).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('Chat Completions: in place, as in 2.2', async () => {
    const body = await wireBody((fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-4.1'), CC_OK);
    expect(body.messages).toEqual([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('Gemini: folded into systemInstruction, as in 2.2', async () => {
    const body = await wireBody(
      (fetch) => createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      GEMINI_OK,
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'A\n\nB' }] });
    expect((body.contents as Array<{ role: string }>).map((c) => c.role)).toEqual([
      'user',
      'model',
      'user',
    ]);
  });

  it('a system message without text is sent by no wire', async () => {
    const empty: Message[] = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q' },
      { role: 'system', content: [] },
    ];
    const anthropic = await wireBody(claude('claude-opus-5-5'), ANTHROPIC_OK, empty);
    expect((anthropic.messages as unknown[]).length).toBe(1);
    const responses = await wireBody(
      (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.5'),
      RESP_OK,
      empty,
    );
    expect(responses.input).toEqual([{ role: 'user', content: 'q' }]);
    const cc = await wireBody(
      (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-4.1'),
      CC_OK,
      empty,
    );
    expect(cc.messages).toEqual([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q' },
    ]);
  });
});
