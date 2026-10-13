// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useObject, useChat } from '../src/react';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { toDeuzStreamResponse, type DeuzWireVersion } from '../src/ui';
import { mockFetch, sseEvents, sseResponse } from '../src/testing';
import type { StreamChatResult } from '../src/types/methods';
import type { StreamPart } from '../src/types/stream';

/** Build a Deuz-wire SSE Response from raw data lines (jsdom's Blob lacks .stream()). */
function sseResponseOf(lines: string[]): Response {
  const bytes = new TextEncoder().encode(lines.map((l) => `data: ${l}\n\n`).join(''));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v1' } },
  );
}

describe('useObject', () => {
  it('accumulates object-delta parts and finishes', async () => {
    const bodies: unknown[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'm1' }),
        JSON.stringify({ type: 'object-delta', object: { city: 'Par' } }),
        JSON.stringify({ type: 'object-delta', object: { city: 'Paris' } }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: { totalTokens: 1 } }),
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() =>
      useObject<{ city: string }>({ api: '/api/object', fetch: fetchMock }),
    );
    expect(result.current.object).toBeUndefined();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      await result.current.submit({ prompt: 'capital of France' });
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.object).toEqual({ city: 'Paris' });
    expect(result.current.error).toBeUndefined();
    expect(bodies[0]).toEqual({ input: { prompt: 'capital of France' } });
  });

  it('surfaces wire error parts as error state', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([JSON.stringify({ type: 'error', message: 'boom' }), '[DONE]']);
    const { result } = renderHook(() => useObject({ api: '/x', fetch: fetchMock }));
    await act(async () => {
      await result.current.submit({});
    });
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.object).toBeUndefined();
  });

  it('a rejected fetch becomes error state (not a throw)', async () => {
    const fetchMock: typeof fetch = async () => {
      throw new Error('network down');
    };
    const { result } = renderHook(() => useObject({ api: '/x', fetch: fetchMock }));
    await act(async () => {
      await result.current.submit({});
    });
    await waitFor(() => expect(result.current.error?.message).toBe('network down'));
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useChat', () => {
  const finishPart = JSON.stringify({
    type: 'finish',
    finishReason: 'stop',
    usage: { totalTokens: 1 },
  });

  it('streams text into an assistant message', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'srv-1' }),
        JSON.stringify({ type: 'text-delta', text: 'Hel' }),
        JSON.stringify({ type: 'text-delta', text: 'lo' }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(result.current.messages[1]).toMatchObject({
      id: 'srv-1',
      role: 'assistant',
      content: 'Hello',
    });
    // Canonical history POSTed: just the user turn.
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('auto-runs client tools via onToolCall and re-POSTs with the tool_result', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponseOf(
        ++call === 1
          ? [
              JSON.stringify({ type: 'tool-call', toolCallId: 't1', toolName: 'geo', input: {} }),
              finishPart,
              '[DONE]',
            ]
          : [
              JSON.stringify({ type: 'text-delta', text: 'You are in Paris.' }),
              finishPart,
              '[DONE]',
            ],
      );
    };
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, onToolCall: async () => ({ lat: 48.85 }) }),
    );
    await act(async () => {
      await result.current.sendMessage('where am i?');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(call).toBe(2);
    // Second POST carries the reconstructed assistant tool_use turn + the tool message.
    const msgs = bodies[1]!.messages;
    expect(msgs.at(-2)).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(msgs.at(-2))).toContain('"t1"');
    expect(msgs.at(-1)).toMatchObject({ role: 'tool' });
    expect(JSON.stringify(msgs.at(-1))).toContain('48.85');
    expect(result.current.messages.at(-1)?.content).toBe('You are in Paris.');
    // The tool call is rendered with its client-side result.
    const toolMsg = result.current.messages.find((m) => m.toolCalls?.length);
    expect(toolMsg?.toolCalls?.[0]).toMatchObject({ toolCallId: 't1', state: 'result' });
  });

  it('collects approval requests, pauses, then re-POSTs approvalResponses after verdicts', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponseOf(
        ++call === 1
          ? [
              JSON.stringify({
                type: 'tool-call',
                toolCallId: 't1',
                toolName: 'del',
                input: { p: '/x' },
              }),
              JSON.stringify({
                type: 'tool-approval-request',
                approvalId: 't1',
                toolCallId: 't1',
                toolName: 'del',
                input: { p: '/x' },
              }),
              finishPart,
              '[DONE]',
            ]
          : [JSON.stringify({ type: 'text-delta', text: 'Deleted.' }), finishPart, '[DONE]'],
      );
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('delete /x');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(call).toBe(1); // paused — no auto re-POST while a verdict is missing
    expect(result.current.pendingApprovals[0]).toMatchObject({ approvalId: 't1', toolName: 'del' });

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 't1', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(call).toBe(2);
    expect(bodies[1]!.approvalResponses).toEqual([{ approvalId: 't1', approved: true }]);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.messages.at(-1)?.content).toBe('Deleted.');
  });

  it('stop() aborts the in-flight stream without erroring', async () => {
    const fetchMock: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await sendPromise;
    });
    expect(result.current.status).toBe('idle'); // abort is not an error
    expect(result.current.error).toBeUndefined();
  });
});

describe('useChat and opaque reasoning on the 2.3 wire (W2a review S2-2)', () => {
  // This hook predates the 2.3 reasoning flags: it appends every reasoning
  // delta's `text` to `message.reasoning`. Since 2.3 the Anthropic parser
  // streams a `redacted_thinking` block's opaque `data`, so the wire must carry
  // an opaque payload in the frame's `data`, never in its `text`.
  const RED = 'EmwKAhgBEgy3va3pzix0LafPsQ0aDOPAQUEREDACTEDPAYLOAD';

  const claudeTurn = (): string =>
    sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: RED },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

  /** jsdom's Blob lacks .stream(): re-wrap a served response's bytes (see `sseResponseOf`). */
  async function rewrap(res: Response): Promise<Response> {
    const bytes = new TextEncoder().encode(await res.text());
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { headers: res.headers },
    );
  }

  it.each(['v1', 'v2'] as const)(
    'never shows redacted thinking data as reasoning (%s wire)',
    async (wireVersion: DeuzWireVersion) => {
      const provider = mockFetch(() => sseResponse([claudeTurn()]));
      const model = createAnthropic({ apiKey: 'k', fetch: provider.fetch })('claude-opus-5-5');
      // A real core route: streamChat -> toDeuzStreamResponse.
      const route: typeof fetch = async (_url, init) => {
        const { messages } = JSON.parse(String(init?.body)) as { messages: never[] };
        return rewrap(toDeuzStreamResponse(streamChat({ model, messages }), { wireVersion }));
      };
      const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route }));
      await act(async () => {
        await result.current.sendMessage('hi');
      });
      await waitFor(() => expect(result.current.status).toBe('idle'));
      expect(result.current.error).toBeUndefined();
      const assistant = result.current.messages[1]!;
      expect(assistant.content).toBe('Hello');
      expect(assistant.reasoning ?? '').not.toContain(RED);
    },
  );

  it('never shows an OpenAI encrypted reasoning item as reasoning either', async () => {
    const ENC = 'gAAAAABpENCRYPTEDREASONINGITEM';
    const parts: StreamPart[] = [
      { type: 'reasoning-delta', text: 'Planning.', id: 'rs_1', source: 'openai' },
      {
        type: 'reasoning-delta',
        text: ENC,
        signature: 'rs_1',
        encrypted: true,
        id: 'rs_1',
        source: 'openai',
      },
      { type: 'text-delta', text: 'Done.' },
    ];
    const result$: StreamChatResult = {
      fullStream: (async function* () {
        yield* parts;
      })(),
      textStream: (async function* () {})(),
      usage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
      }),
      finishReason: Promise.resolve('stop' as const),
    };
    const route: typeof fetch = async () => rewrap(toDeuzStreamResponse(result$));
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.messages[1]!.content).toBe('Done.');
    expect(result.current.messages[1]!.reasoning).toBe('Planning.');
  });
});
