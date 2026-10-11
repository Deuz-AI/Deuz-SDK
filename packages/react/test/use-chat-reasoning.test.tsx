/**
 * use-chat-reasoning.test.tsx (2.3, F21) — reasoning blocks survive the round
 * trip through `useChat`: a real core route streams Claude's turn over the Deuz
 * UI wire, the hook folds it, answers the client tool and POSTs the canonical
 * history back, and the route replays it to Claude.
 *
 * Acceptance (roadmap F21): `[thinking ''/S0, thinking 'a'/S1, redacted, text,
 * tool_use]` reaches the next Anthropic request byte-identically. Before 2.3 the
 * hook's canonical turn carried no reasoning at all. The Anthropic wire is
 * replayed offline.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { streamChat } from '@deuz-sdk/core';
import type { Message } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createGoogleNative } from '@deuz-sdk/core/google';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { mockFetchSequence, sseEvents, sseResponse } from '@deuz-sdk/core/testing';
import { useChat } from '../src/use-chat';

const S0 = 'EqQBCkgIARABGAIiQFirstSignatureOfAnEmptyThinkingBlock==';
const S1 = 'EqQBCkgIARABGAIiQSecondSignatureOfAThinkingBlock==';
const REDACTED = 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP';

type Block =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string };

/** One Anthropic Messages SSE turn, block by block, as the API streams it. */
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

describe('useChat keeps reasoning blocks (2.3, F21)', () => {
  it('replays [thinking ""/S0, thinking "a"/S1, redacted, text, tool_use] byte-identically', async () => {
    const provider = mockFetchSequence([
      () =>
        sseResponse([
          turn(
            [
              { type: 'thinking', signature: S0 },
              { type: 'thinking', text: 'a', signature: S1 },
              { type: 'redacted_thinking', data: REDACTED },
              { type: 'text', text: 'Let me look that up.' },
              { type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{"q":"x"}' },
            ],
            'tool_use',
          ),
        ]),
      () => sseResponse([turn([{ type: 'text', text: 'Found it.' }], 'end_turn')]),
    ]);
    const model = createAnthropic({ apiKey: 'k', fetch: provider.fetch })('claude-opus-5-5');
    let n = 0;
    // The chat route: replay the posted history to Claude, answer on the UI wire.
    // `lookup` has no `execute`, so it is a client tool the hook answers.
    const route: typeof fetch = async (_url, init) => {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Message[] };
      const generateId = () => `srv-${n++}`;
      return toDeuzStreamResponse(
        streamChat({
          model,
          messages,
          tools: { lookup: { parameters: { type: 'object', properties: {} } } },
          deps: { generateId },
        }),
        { generateId },
      );
    };

    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: route, onToolCall: () => 'result' }),
    );
    await act(async () => {
      await result.current.sendMessage('q');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(provider.calls).toHaveLength(2);
    const second = JSON.parse(String(provider.calls[1]!.init!.body)) as {
      messages: { role: string; content: unknown }[];
    };
    expect(JSON.stringify(second.messages[1]!.content)).toBe(
      JSON.stringify([
        { type: 'thinking', thinking: '', signature: S0 },
        { type: 'thinking', thinking: 'a', signature: S1 },
        { type: 'redacted_thinking', data: REDACTED },
        { type: 'text', text: 'Let me look that up.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
      ]),
    );

    // The hook's own canonical history holds one part per block, with its source.
    expect(result.current.history.canonical[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', signature: S0, source: 'anthropic' },
        { type: 'reasoning', text: 'a', signature: S1, source: 'anthropic' },
        { type: 'reasoning', text: REDACTED, redacted: true, source: 'anthropic' },
        { type: 'text', text: 'Let me look that up.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
      ],
    });
    // The readable reasoning shown to the user is the thinking text only.
    expect(result.current.messages[1]!.reasoning).toBe('a');
  });
});

describe('useChat keeps a Gemini function call signature (2.3)', () => {
  /** One Gemini `streamGenerateContent` SSE turn, one chunk per inner array. */
  function geminiTurn(chunks: Record<string, unknown>[][]): string {
    return sseEvents(
      chunks.map((parts, i) => ({
        data: {
          candidates: [
            {
              content: { role: 'model', parts },
              ...(i === chunks.length - 1 ? { finishReason: 'STOP' } : {}),
            },
          ],
          ...(i === chunks.length - 1
            ? {
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
              }
            : {}),
        },
      })),
    );
  }

  it('a client tool loop sends the thought and the function call signature back', async () => {
    // Gemini 3 checks a function call's signature within the current turn, and
    // a dropped one fails the next request (not live-verified).
    const provider = mockFetchSequence([
      () =>
        sseResponse([
          geminiTurn([
            [{ text: 'a thought', thought: true, thoughtSignature: 'TS_THOUGHT' }],
            [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'TS_FC' }],
          ]),
        ]),
      () => sseResponse([geminiTurn([[{ text: 'Found it.' }]])]),
    ]);
    const model = createGoogleNative({ apiKey: 'k', fetch: provider.fetch })(
      'gemini-3.1-pro-preview',
    );
    let n = 0;
    // Unique ids per round, as a real route gets from `deps.generateId`.
    const route: typeof fetch = async (_url, init) => {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Message[] };
      const generateId = () => `srv-${n++}`;
      return toDeuzStreamResponse(
        streamChat({
          model,
          messages,
          tools: { lookup: { parameters: { type: 'object', properties: {} } } },
          deps: { generateId },
        }),
        { generateId },
      );
    };

    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: route, onToolCall: () => 'result' }),
    );
    await act(async () => {
      await result.current.sendMessage('q');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(provider.calls).toHaveLength(2);
    const second = JSON.parse(String(provider.calls[1]!.init!.body)) as {
      contents: { role: string; parts: Record<string, unknown>[] }[];
    };
    expect(second.contents.find((c) => c.role === 'model')!.parts).toEqual([
      { text: 'a thought', thought: true, thoughtSignature: 'TS_THOUGHT' },
      { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'TS_FC' },
    ]);
    expect(result.current.messages[1]!.reasoning).toBe('a thought');
  });
});
