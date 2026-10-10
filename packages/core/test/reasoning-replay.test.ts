/**
 * reasoning-replay.test.ts (2.3, F21) — reasoning rides back only to the
 * provider family that produced it, and each family's own state round-trips.
 *
 * Before the fix an OpenAI encrypted reasoning item went to Anthropic as a
 * `thinking` block (signature `rs_1`) and to Gemini as a `thoughtSignature`,
 * which the fallback engine invited by replaying the same canonical history to
 * the next candidate; DeepSeek's and Kimi's `reasoning_content` was parsed but
 * never sent back on the tool-call turn; Gemini's signature on a plain text part
 * was dropped. All wires are replayed offline. The DeepSeek / Kimi requirement
 * and Gemini's handling of text signatures are not live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createGoogleNative } from '../src/google';
import { createOpenAIResponses } from '../src/openai';
import { createDeepSeek, createKimi, createQwen } from '../src/providers-compat';
import { mockFetch, mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import type { Message } from '../src/types/message';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';

const LOOKUP: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};
const tools = () => ({ lookup: { parameters: LOOKUP, execute: () => 'result' } });

type Body = Record<string, unknown> & {
  messages?: { role: string; content: unknown; reasoning_content?: unknown }[];
  contents?: { role: string; parts: Record<string, unknown>[] }[];
  input?: Record<string, unknown>[];
};
const bodiesOf = (calls: { init?: RequestInit }[]): Body[] =>
  calls.map((c) => JSON.parse(String(c.init!.body)) as Body);

// --- wire fixtures ---------------------------------------------------------

const ANTHROPIC_DONE = sseEvents([
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

const geminiTurn = (parts: Record<string, unknown>[][]) =>
  sseEvents(
    parts.map((chunk, i) => ({
      data: {
        candidates: [
          {
            content: { role: 'model', parts: chunk },
            ...(i === parts.length - 1 ? { finishReason: 'STOP' } : {}),
          },
        ],
        ...(i === parts.length - 1
          ? { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }
          : {}),
      },
    })),
  );
const GEMINI_DONE = geminiTurn([[{ text: 'ok' }]]);

const responsesDone = sseEvents([
  { data: { type: 'response.output_text.delta', delta: 'ok' } },
  {
    data: {
      type: 'response.completed',
      response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    },
  },
]);

const chatTurn = (chunks: Record<string, unknown>[], finish: string) =>
  sseEvents([
    ...chunks.map((delta) => ({ data: { choices: [{ index: 0, delta, finish_reason: null }] } })),
    { data: { choices: [{ index: 0, delta: {}, finish_reason: finish }] } },
    {
      data: {
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    },
    { data: '[DONE]' },
  ]);

const unavailable = (): Response =>
  new Response(JSON.stringify({ error: { type: 'server_error', message: 'down' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

/** A history whose assistant turn reasoned on OpenAI Responses. */
function openaiHistory(source: 'marked' | 'legacy'): Message[] {
  return [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'ENC_BLOB_FROM_OPENAI',
          encrypted: true,
          signature: 'rs_1',
          ...(source === 'marked' ? { source: 'openai' } : {}),
        },
        {
          type: 'reasoning',
          text: 'a readable summary',
          ...(source === 'marked' ? { source: 'openai' } : {}),
        },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      ],
    },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', result: 'result' }] },
  ];
}

// --- foreign reasoning is never replayed -----------------------------------

describe('foreign reasoning never reaches another provider', () => {
  it.each(['marked', 'legacy'] as const)(
    'OpenAI encrypted reasoning (%s) is no Anthropic thinking block and no Gemini thought',
    async (source) => {
      const a = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
      await generateText({
        model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
        messages: openaiHistory(source),
        tools: tools(),
        maxSteps: 1,
      });
      const anthropicTurn = bodiesOf(a.calls)[0]!.messages![1]!;
      expect(anthropicTurn.content).toEqual([
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      ]);

      const g = mockFetch(() => sseResponse([GEMINI_DONE]));
      await generateText({
        model: createGoogleNative({ apiKey: 'k', fetch: g.fetch })('gemini-3.1-pro-preview'),
        messages: openaiHistory(source),
        tools: tools(),
        maxSteps: 1,
      });
      const geminiTurnParts = bodiesOf(g.calls)[0]!.contents![1]!.parts;
      expect(geminiTurnParts.some((p) => p.thought === true || 'thoughtSignature' in p)).toBe(
        // A legacy summary part has no source and no signature: it rides as a
        // plain thought, exactly as before 2.3; the encrypted blob never does.
        source === 'legacy',
      );
      expect(JSON.stringify(geminiTurnParts)).not.toContain('ENC_BLOB_FROM_OPENAI');
      expect(JSON.stringify(geminiTurnParts)).not.toContain('rs_1');
    },
  );

  it("Claude's thinking never reaches Gemini, OpenAI or a Chat Completions host", async () => {
    const history: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'claude thinks', signature: 'SIG', source: 'anthropic' },
          { type: 'reasoning', text: 'REDACTED', redacted: true },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'toolu_1', result: 'r' }] },
    ];
    const g = mockFetch(() => sseResponse([GEMINI_DONE]));
    await generateText({
      model: createGoogleNative({ apiKey: 'k', fetch: g.fetch })('gemini-3.1-pro-preview'),
      messages: history,
      tools: tools(),
      maxSteps: 1,
    });
    const geminiParts = JSON.stringify(bodiesOf(g.calls)[0]!.contents);
    expect(geminiParts).not.toContain('claude thinks');
    expect(geminiParts).not.toContain('SIG');
    expect(geminiParts).not.toContain('REDACTED');

    const o = mockFetch(() => sseResponse([responsesDone]));
    await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch: o.fetch })('gpt-5.4'),
      messages: history,
      tools: tools(),
      maxSteps: 1,
    });
    expect(bodiesOf(o.calls)[0]!.input!.some((item) => item.type === 'reasoning')).toBe(false);

    const d = mockFetch(() => sseResponse([chatTurn([{ content: 'ok' }], 'stop')]));
    await generateText({
      model: createDeepSeek({ apiKey: 'k', fetch: d.fetch })('deepseek-v4-pro'),
      messages: history,
      tools: tools(),
      maxSteps: 1,
    });
    const deepseekTurn = bodiesOf(d.calls)[0]!.messages!.find((m) => m.role === 'assistant')!;
    expect(deepseekTurn.reasoning_content).toBeUndefined();
  });

  it("Gemini's thoughts never reach Claude", async () => {
    const history: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'gemini thinks', signature: 'TSIG', source: 'google' },
          { type: 'text', text: 'Hi.' },
        ],
      },
      { role: 'user', content: 'more' },
    ];
    const a = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
      messages: history,
    });
    expect(bodiesOf(a.calls)[0]!.messages![1]!.content).toEqual([{ type: 'text', text: 'Hi.' }]);
  });

  it('a thinking block without its signature never goes to Claude (it is always a 400)', async () => {
    const a = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'unsigned' },
            { type: 'text', text: 'Hi.' },
          ],
        },
        { role: 'user', content: 'more' },
      ],
    });
    expect(bodiesOf(a.calls)[0]!.messages![1]!.content).toEqual([{ type: 'text', text: 'Hi.' }]);
  });
});

describe('fallback replays only what the next candidate can read', () => {
  it('OpenAI fails over to Claude: the encrypted item is left out', async () => {
    const o = mockFetch(unavailable);
    const a = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const parts: StreamPart[] = [];
    for await (const part of streamChat({
      model: createOpenAIResponses({ apiKey: 'k', fetch: o.fetch })('gpt-5.4'),
      fallbackModels: [createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8')],
      messages: [...openaiHistory('marked'), { role: 'user', content: 'and?' }],
      maxRetries: 0,
    }).fullStream)
      parts.push(part);
    expect(parts.at(-1)).toMatchObject({ type: 'finish' });
    expect(a.calls).toHaveLength(1);
    const sent = JSON.stringify(bodiesOf(a.calls)[0]!.messages);
    expect(sent).not.toContain('ENC_BLOB_FROM_OPENAI');
    expect(sent).not.toContain('"thinking"');
  });

  it('Claude fails over to another Claude: the blocks are forwarded unchanged', async () => {
    const failing = mockFetch(unavailable);
    const next = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const history: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', signature: 'S0', source: 'anthropic' },
          { type: 'reasoning', text: 'R', redacted: true, source: 'anthropic' },
          { type: 'text', text: 'Hi.' },
        ],
      },
      { role: 'user', content: 'more' },
    ];
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: failing.fetch })('claude-opus-5-5'),
      fallbackModels: [createAnthropic({ apiKey: 'k', fetch: next.fetch })('claude-sonnet-5-5')],
      messages: history,
      maxRetries: 0,
    });
    expect(result.text).toBe('ok');
    expect(bodiesOf(next.calls)[0]!.messages![1]!.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'S0' },
      { type: 'redacted_thinking', data: 'R' },
      { type: 'text', text: 'Hi.' },
    ]);
  });
});

// --- each family's own state round-trips ------------------------------------

describe('DeepSeek and Kimi reasoning_content round-trips on the tool-call turn (not live-verified)', () => {
  const reasoningCall = chatTurn(
    [
      { reasoning_content: 'I should ' },
      { reasoning_content: 'call lookup.' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"x"}' },
          },
        ],
      },
    ],
    'tool_calls',
  );
  const done = chatTurn([{ content: 'final' }], 'stop');

  it.each([
    [
      'deepseek',
      (fetch: typeof globalThis.fetch) => createDeepSeek({ apiKey: 'k', fetch })('deepseek-v4-pro'),
    ],
    ['moonshot', (fetch: typeof globalThis.fetch) => createKimi({ apiKey: 'k', fetch })('kimi-k3')],
  ] as const)('%s: the streamed reasoning rides back with its tool_calls', async (_id, make) => {
    const seq = mockFetchSequence([() => sseResponse([reasoningCall]), () => sseResponse([done])]);
    const result = await generateText({
      model: make(seq.fetch),
      prompt: 'q',
      tools: tools(),
      maxSteps: 3,
    });
    expect(result.text).toBe('final');
    const replayed = bodiesOf(seq.calls)[1]!.messages!.find((m) => m.role === 'assistant')!;
    expect(replayed).toMatchObject({
      role: 'assistant',
      reasoning_content: 'I should call lookup.',
      tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    });
  });

  it('a text-only turn and other hosts send no reasoning_content', async () => {
    const seq = mockFetchSequence([() => sseResponse([reasoningCall]), () => sseResponse([done])]);
    await generateText({
      model: createQwen({ apiKey: 'k', fetch: seq.fetch })('qwen3-max'),
      prompt: 'q',
      tools: tools(),
      maxSteps: 3,
    });
    const replayed = bodiesOf(seq.calls)[1]!.messages!.find((m) => m.role === 'assistant')!;
    expect(replayed.reasoning_content).toBeUndefined();

    const d = mockFetch(() => sseResponse([done]));
    await generateText({
      model: createDeepSeek({ apiKey: 'k', fetch: d.fetch })('deepseek-v4-pro'),
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thought', source: 'deepseek' },
            { type: 'text', text: 'Hi.' },
          ],
        },
        { role: 'user', content: 'more' },
      ],
    });
    const textTurn = bodiesOf(d.calls)[0]!.messages![1]!;
    expect(textTurn).toEqual({ role: 'assistant', content: 'Hi.' });
  });
});

describe('Gemini thought signatures on plain text parts (not live-verified)', () => {
  it('a signed text part keeps its signature on the next request of the loop', async () => {
    const seq = mockFetchSequence([
      () =>
        sseResponse([
          geminiTurn([
            [{ text: 'a thought', thought: true, thoughtSignature: 'TS_THOUGHT' }],
            [{ text: 'Checking', thoughtSignature: 'TS_TEXT' }],
            [{ text: '.' }],
            [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'TS_FC' }],
          ]),
        ]),
      () => sseResponse([GEMINI_DONE]),
    ]);
    await generateText({
      model: createGoogleNative({ apiKey: 'k', fetch: seq.fetch })('gemini-3.1-pro-preview'),
      prompt: 'q',
      tools: tools(),
      maxSteps: 3,
    });
    expect(bodiesOf(seq.calls)[1]!.contents![1]!.parts).toEqual([
      { text: 'a thought', thought: true, thoughtSignature: 'TS_THOUGHT' },
      { text: 'Checking.', thoughtSignature: 'TS_TEXT' },
      { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'TS_FC' },
    ]);
  });

  it('a signature in an empty final chunk lands on the answer text and rides back', async () => {
    const first = mockFetch(() =>
      sseResponse([geminiTurn([[{ text: 'Hello' }], [{ text: '', thoughtSignature: 'TS_END' }]])]),
    );
    const answer = await generateText({
      model: createGoogleNative({ apiKey: 'k', fetch: first.fetch })('gemini-3.1-pro-preview'),
      prompt: 'q',
    });
    expect(answer.response.messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Hello',
          providerMetadata: { google: { thoughtSignature: 'TS_END' } },
        },
      ],
    });
    const next = mockFetch(() => sseResponse([GEMINI_DONE]));
    await generateText({
      model: createGoogleNative({ apiKey: 'k', fetch: next.fetch })('gemini-3.1-pro-preview'),
      messages: [
        { role: 'user', content: 'q' },
        ...answer.response.messages,
        { role: 'user', content: 'more' },
      ],
    });
    expect(bodiesOf(next.calls)[0]!.contents![1]!.parts).toEqual([
      { text: 'Hello', thoughtSignature: 'TS_END' },
    ]);
  });

  it("Gemini's thoughts carry the google source", async () => {
    const g = mockFetch(() =>
      sseResponse([
        geminiTurn([[{ text: 'hmm', thought: true, thoughtSignature: 'TS' }], [{ text: 'ok' }]]),
      ]),
    );
    const result = await generateText({
      model: createGoogleNative({ apiKey: 'k', fetch: g.fetch })('gemini-3.1-pro-preview'),
      prompt: 'q',
    });
    expect(result.response.messages[0]!.content).toEqual([
      { type: 'reasoning', text: 'hmm', signature: 'TS', source: 'google' },
      { type: 'text', text: 'ok' },
    ]);
  });
});

describe('OpenAI Responses keeps its own encrypted reasoning', () => {
  it('replays the marked item and carries the openai source', async () => {
    const seq = mockFetchSequence([
      () =>
        sseResponse([
          sseEvents([
            {
              data: {
                type: 'response.reasoning_summary_text.delta',
                item_id: 'rs_1',
                delta: 'Planning.',
              },
            },
            {
              data: {
                type: 'response.output_item.done',
                item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
              },
            },
            {
              data: {
                type: 'response.output_item.added',
                item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup' },
              },
            },
            {
              data: {
                type: 'response.function_call_arguments.delta',
                item_id: 'fc_1',
                delta: '{"q":"x"}',
              },
            },
            {
              data: {
                type: 'response.completed',
                response: { usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } },
              },
            },
          ]),
        ]),
      () => sseResponse([responsesDone]),
    ]);
    const result = await generateText({
      model: createOpenAIResponses({ apiKey: 'k', fetch: seq.fetch })('gpt-5.4'),
      prompt: 'q',
      tools: tools(),
      maxSteps: 3,
      effort: 'high',
    });
    const turn = result.response.messages[0]!;
    expect(turn.content).toEqual([
      { type: 'reasoning', text: 'Planning.', source: 'openai' },
      { type: 'reasoning', text: 'ENC', encrypted: true, signature: 'rs_1', source: 'openai' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
    ]);
    expect(bodiesOf(seq.calls)[1]!.input).toEqual([
      { role: 'user', content: 'q' },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ]);
  });
});
