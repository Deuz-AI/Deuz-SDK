/**
 * chat-reasoning.test.ts (2.3, F21) — the UI projections keep every reasoning
 * block, so a chat client sends the model's turn back unchanged.
 *
 * Before the fix the UI wire carried only a reasoning delta's text and
 * signature, the reducer merged consecutive blocks into one, put opaque
 * payloads into the readable `reasoning` text, `assistantMessageFromTurn`
 * dropped all reasoning from the canonical turn `useChat` POSTs back, and
 * `canonicalContentFromUI` dropped every block whose text was empty — which is
 * every Claude 5.x block under the default `display: 'omitted'`.
 */
import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import {
  applyUIPart,
  assistantMessageFromTurn,
  canonicalFromUI,
  clientToolResultMessage,
  createAssistantTurn,
  uiFromMessages,
  type AssistantTurnState,
} from '../src/chat';
import { readDeuzStream, toDeuzStreamResponse, toDeuzTextStreamResponse } from '../src/ui';
import type { DeuzUIPart } from '../src/ui';
import { mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import type { Message } from '../src/types/message';
import type { StreamChatResult } from '../src/types/methods';
import type { StreamPart } from '../src/types/stream';

const S0 = 'sig-zero';
const S1 = 'sig-one';
const RED = 'opaque-redacted';

function fold(parts: DeuzUIPart[]): AssistantTurnState {
  let turn = createAssistantTurn('m1');
  for (const part of parts) turn = applyUIPart(turn, part);
  return turn;
}

/**
 * The acceptance blocks as UI frames, in the shape the 2.3 wire carries them:
 * an opaque block's payload rides `data`, and its `text` is empty.
 */
const FRAMES: DeuzUIPart[] = [
  { type: 'reasoning-delta', text: '', signature: S0, id: '0', source: 'anthropic' },
  { type: 'reasoning-delta', text: 'a', id: '1', source: 'anthropic' },
  { type: 'reasoning-delta', text: '', signature: S1, id: '1', source: 'anthropic' },
  { type: 'reasoning-delta', text: '', redacted: true, id: '2', source: 'anthropic', data: RED },
  { type: 'text-delta', text: 'Checking.' },
  { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'lookup', input: { q: 'x' } },
];

describe('applyUIPart keeps one UI part per block', () => {
  it('splits on a new block id and records the flags and the source', () => {
    const turn = fold(FRAMES);
    expect(turn.message.parts).toEqual([
      { type: 'reasoning', text: '', signature: S0, id: '0', source: 'anthropic', state: 'done' },
      { type: 'reasoning', text: 'a', signature: S1, id: '1', source: 'anthropic', state: 'done' },
      {
        type: 'reasoning',
        text: RED,
        redacted: true,
        id: '2',
        source: 'anthropic',
        state: 'done',
      },
      { type: 'text', text: 'Checking.', state: 'done' },
      { type: 'tool', toolCallId: 'toolu_1' },
    ]);
    // The readable bucket is display text only: no opaque payload in it.
    expect(turn.message.reasoning).toBe('a');
  });

  it('an encrypted block is a part of its own, never display text', () => {
    const turn = fold([
      { type: 'reasoning-delta', text: 'Planning.', id: 'rs_1', source: 'openai' },
      {
        type: 'reasoning-delta',
        text: '',
        signature: 'rs_1',
        encrypted: true,
        id: 'rs_1',
        source: 'openai',
        data: 'ENC',
      },
      { type: 'text-delta', text: 'Done.' },
    ]);
    expect(turn.message.parts!.slice(0, 2)).toEqual([
      { type: 'reasoning', text: 'Planning.', id: 'rs_1', source: 'openai', state: 'done' },
      {
        type: 'reasoning',
        text: 'ENC',
        signature: 'rs_1',
        encrypted: true,
        id: 'rs_1',
        source: 'openai',
        state: 'done',
      },
    ]);
    expect(turn.message.reasoning).toBe('Planning.');
  });

  it('deltas without an id still extend one block (a pre-2.3 server)', () => {
    const turn = fold([
      { type: 'reasoning-delta', text: 'let me ' },
      { type: 'reasoning-delta', text: 'search', signature: 'sig' },
    ]);
    expect(turn.message.parts).toEqual([
      { type: 'reasoning', text: 'let me search', signature: 'sig', state: 'streaming' },
    ]);
  });

  it('ignores malformed flags from the wire (the reducer is total)', () => {
    const turn = fold([
      {
        type: 'reasoning-delta',
        text: 'x',
        id: 7,
        redacted: 'yes',
        encrypted: 1,
        source: {},
        data: 'not opaque, so not read',
      } as unknown as DeuzUIPart,
    ]);
    expect(turn.message.parts).toEqual([{ type: 'reasoning', text: 'x', state: 'streaming' }]);
    expect(turn.message.reasoning).toBe('x');
  });

  it('reads an opaque payload from `text` when a frame has no string `data`', () => {
    // A server that put the payload in `text` (as no released Deuz server
    // did); a non-string `data` reads as absent, like every other wire field.
    const turn = fold([
      { type: 'reasoning-delta', text: RED, redacted: true, id: '2', source: 'anthropic' },
      {
        type: 'reasoning-delta',
        text: 'ENC',
        encrypted: true,
        id: 'rs_1',
        source: 'openai',
        data: 42,
      } as unknown as DeuzUIPart,
    ]);
    expect(turn.message.parts).toEqual([
      { type: 'reasoning', text: RED, redacted: true, id: '2', source: 'anthropic', state: 'done' },
      {
        type: 'reasoning',
        text: 'ENC',
        encrypted: true,
        id: 'rs_1',
        source: 'openai',
        state: 'streaming',
      },
    ]);
    expect(turn.message.reasoning).toBeUndefined();
  });
});

describe('canonical projections keep every block', () => {
  it('assistantMessageFromTurn sends the blocks back in order', () => {
    expect(assistantMessageFromTurn(fold(FRAMES))).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', signature: S0, source: 'anthropic' },
        { type: 'reasoning', text: 'a', signature: S1, source: 'anthropic' },
        { type: 'reasoning', text: RED, redacted: true, source: 'anthropic' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
      ],
    });
  });

  it('keeps reasoning on a text answer; a plain answer stays a string', () => {
    expect(
      assistantMessageFromTurn(
        fold([
          { type: 'reasoning-delta', text: '', signature: S0, id: '0', source: 'anthropic' },
          { type: 'text-delta', text: 'Hi.' },
        ]),
      ),
    ).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', signature: S0, source: 'anthropic' },
        { type: 'text', text: 'Hi.' },
      ],
    });
    expect(assistantMessageFromTurn(fold([{ type: 'text-delta', text: 'Hi.' }]))).toEqual({
      role: 'assistant',
      content: 'Hi.',
    });
  });

  it('a turn that is reasoning alone sends no reasoning back', () => {
    expect(
      assistantMessageFromTurn(
        fold([{ type: 'reasoning-delta', text: '', signature: S0, id: '0', source: 'anthropic' }]),
      ),
    ).toEqual({ role: 'assistant', content: '' });
  });

  it('uiFromMessages → canonicalFromUI round-trips empty signed blocks and the source', () => {
    const history: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', signature: S0, source: 'anthropic' },
          { type: 'reasoning', text: RED, redacted: true, source: 'anthropic' },
          { type: 'reasoning', text: 'ENC', encrypted: true, signature: 'rs_1', source: 'openai' },
          { type: 'text', text: 'Hi.' },
        ],
      },
    ];
    let n = 0;
    const ui = uiFromMessages(history, () => `id-${n++}`);
    // The readable bucket never shows opaque payloads.
    expect(ui[1]!.reasoning).toBeUndefined();
    expect(canonicalFromUI(ui)).toEqual(history);
  });
});

describe('the UI wire carries block identity, flags and source', () => {
  function manual(parts: StreamPart[]): StreamChatResult {
    const usage = Promise.resolve({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 0,
    });
    return {
      fullStream: (async function* () {
        yield* parts;
      })(),
      textStream: (async function* () {})(),
      usage,
      finishReason: Promise.resolve('stop' as const),
    };
  }

  it('toDeuzStreamResponse frames the new fields; readDeuzStream reads them back', async () => {
    const response = toDeuzStreamResponse(
      manual([
        { type: 'reasoning-delta', text: RED, redacted: true, id: '2', source: 'anthropic' },
        {
          type: 'reasoning-delta',
          text: 'ENC',
          signature: 'rs_1',
          encrypted: true,
          id: 'rs_1',
          source: 'openai',
        },
      ]),
      { messageId: 'm1' },
    );
    const frames: DeuzUIPart[] = [];
    for await (const frame of readDeuzStream(response)) frames.push(frame);
    expect(frames.filter((f) => f.type === 'reasoning-delta')).toEqual([
      {
        type: 'reasoning-delta',
        text: '',
        id: '2',
        redacted: true,
        source: 'anthropic',
        data: RED,
      },
      {
        type: 'reasoning-delta',
        text: '',
        signature: 'rs_1',
        id: 'rs_1',
        encrypted: true,
        source: 'openai',
        data: 'ENC',
      },
    ]);
  });

  it.each(['v1', 'v2'] as const)(
    'an opaque payload rides `data`, never `text`, so a reader that predates the flags shows none (%s wire)',
    async (wireVersion) => {
      const response = toDeuzStreamResponse(
        manual([
          { type: 'reasoning-delta', text: 'think. ', id: '0', source: 'anthropic' },
          { type: 'reasoning-delta', text: RED, redacted: true, id: '1', source: 'anthropic' },
          {
            type: 'reasoning-delta',
            text: 'ENC',
            signature: 'rs_1',
            encrypted: true,
            id: 'rs_1',
            source: 'openai',
          },
          { type: 'text-delta', text: 'Answer.' },
        ]),
        { messageId: 'm1', wireVersion },
      );
      const frames: DeuzUIPart[] = [];
      for await (const frame of readDeuzStream(response)) frames.push(frame);
      // What a 2.2 reducer, the frozen `@deuz-sdk/core/react` hook or a custom
      // reader does with a reasoning frame: append its `text`.
      const shown = frames
        .filter((f): f is Extract<DeuzUIPart, { type: 'reasoning-delta' }> => {
          return f.type === 'reasoning-delta';
        })
        .map((f) => f.text)
        .join('');
      expect(shown).toBe('think. ');
      // A 2.3 decoder rebuilds both blocks from `data`, unchanged.
      let turn = createAssistantTurn('m1');
      for (const frame of frames) turn = applyUIPart(turn, frame);
      expect(assistantMessageFromTurn(turn)).toEqual({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think. ', source: 'anthropic' },
          { type: 'reasoning', text: RED, redacted: true, source: 'anthropic' },
          {
            type: 'reasoning',
            text: 'ENC',
            signature: 'rs_1',
            encrypted: true,
            source: 'openai',
          },
          { type: 'text', text: 'Answer.' },
        ],
      });
      expect(turn.message.reasoning).toBe('think. ');
    },
  );

  it('a text stream with reasoning never writes opaque payloads', async () => {
    const body = await toDeuzTextStreamResponse(
      manual([
        { type: 'reasoning-delta', text: 'think. ', id: '0', source: 'anthropic' },
        { type: 'reasoning-delta', text: RED, redacted: true, id: '1', source: 'anthropic' },
        { type: 'text-delta', text: 'Answer.' },
      ]),
      { includeReasoning: true },
    ).text();
    expect(body).toBe('think. Answer.');
  });
});

describe('F21 acceptance through the UI wire: server → client → server', () => {
  type Block =
    | { type: 'thinking'; text?: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; json: string };

  function turn(blocks: Block[], stop: string): string {
    const events: { event: string; data: unknown }[] = [
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      },
    ];
    blocks.forEach((block, index) => {
      const start = (content_block: unknown) =>
        events.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index, content_block },
        });
      const delta = (d: unknown) =>
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: d },
        });
      if (block.type === 'thinking') {
        start({ type: 'thinking', thinking: '', signature: '' });
        if (block.text) delta({ type: 'thinking_delta', thinking: block.text });
        delta({ type: 'signature_delta', signature: block.signature });
      } else if (block.type === 'redacted_thinking') {
        start({ type: 'redacted_thinking', data: block.data });
      } else if (block.type === 'text') {
        start({ type: 'text', text: '' });
        delta({ type: 'text_delta', text: block.text });
      } else {
        start({ type: 'tool_use', id: block.id, name: block.name, input: {} });
        delta({ type: 'input_json_delta', partial_json: block.json });
      }
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    });
    events.push({
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return sseEvents(events);
  }

  it('a client tool round-trip replays [thinking ""/S0, thinking "a"/S1, redacted, text, tool_use] unchanged', async () => {
    const provider = mockFetchSequence([
      () =>
        sseResponse([
          turn(
            [
              { type: 'thinking', signature: S0 },
              { type: 'thinking', text: 'a', signature: S1 },
              { type: 'redacted_thinking', data: RED },
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{"q":"x"}' },
            ],
            'tool_use',
          ),
        ]),
      () => sseResponse([turn([{ type: 'text', text: 'Found it.' }], 'end_turn')]),
    ]);
    const model = createAnthropic({ apiKey: 'k', fetch: provider.fetch })('claude-opus-5-5');
    // `lookup` has no execute: a client tool, answered by the chat client.
    const tools = { lookup: { parameters: { type: 'object' as const, properties: {} } } };

    // Leg 1 on the server, read by the client.
    const history: Message[] = [{ role: 'user', content: 'q' }];
    const leg1 = toDeuzStreamResponse(streamChat({ model, messages: [...history], tools }));
    let state = createAssistantTurn('t1');
    for await (const part of readDeuzStream(leg1)) state = applyUIPart(state, part);
    history.push(
      assistantMessageFromTurn(state),
      clientToolResultMessage([{ toolCallId: 'toolu_1', result: 'r' }]),
    );

    // Leg 2: the client POSTs the history as JSON; the server replays it.
    const posted = JSON.parse(JSON.stringify(history)) as Message[];
    const leg2 = toDeuzStreamResponse(streamChat({ model, messages: posted, tools }));
    for await (const _ of readDeuzStream(leg2)) void _;

    const second = JSON.parse(String(provider.calls[1]!.init!.body)) as {
      messages: { role: string; content: unknown }[];
      thinking?: unknown;
    };
    expect(JSON.stringify(second.messages[1]!.content)).toBe(
      JSON.stringify([
        { type: 'thinking', thinking: '', signature: S0 },
        { type: 'thinking', thinking: 'a', signature: S1 },
        { type: 'redacted_thinking', data: RED },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
      ]),
    );
    expect(second.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });
});
