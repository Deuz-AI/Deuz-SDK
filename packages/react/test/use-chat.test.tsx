import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChat } from '../src/use-chat';
import { useObject } from '../src/use-object';

/** Deterministic id source per test. */
function scriptedIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

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
    { headers: { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v2' } },
  );
}

/** Wire-v2 SSE Response with `id:` lines (resume endpoints emit these). */
function v2SseResponseOf(events: Array<{ id: number; data: string }>): Response {
  const bytes = new TextEncoder().encode(
    events.map((e) => `id: ${e.id}\ndata: ${e.data}\n\n`).join(''),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v2' } },
  );
}

const finishPart = JSON.stringify({
  type: 'finish',
  finishReason: 'stop',
  usage: { totalTokens: 1 },
});

describe('useChat', () => {
  it('streams text into an assistant message via the core reducer (chatId in the body)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'srv-1' }),
        JSON.stringify({ type: 'text-delta', text: 'Hel' }),
        JSON.stringify({ type: 'text-delta', text: 'lo' }),
        JSON.stringify({ type: 'cost', costUsd: 0.0123 }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, chatId: 'chat-7' }),
    );
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
    expect(result.current.cost).toEqual({ costUsd: 0.0123 });
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]!.chatId).toBe('chat-7');
  });

  it('renders initialMessages via uiFromMessages and POSTs them as canonical history', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return sseResponseOf([
        JSON.stringify({ type: 'text-delta', text: 'ok' }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: fetchMock,
        generateId: scriptedIds('seed'),
        initialMessages: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      }),
    );
    // Seed history is rendered immediately (legacy did not — 1.7 must).
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: 'earlier question' });
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'earlier answer',
    });

    await act(async () => {
      await result.current.sendMessage('next');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(bodies[0]!.messages).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'next' },
    ]);
    expect(result.current.messages).toHaveLength(4);
  });

  it('cost, budgetExceeded, data-* and citation parts land in state', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'srv-2' }),
        JSON.stringify({ type: 'text-delta', text: 'Answer' }),
        JSON.stringify({ type: 'data-chart', payload: { x: 1 } }),
        JSON.stringify({ type: 'citation', id: 'c1', url: 'https://ex.com', title: 'Doc' }),
        JSON.stringify({ type: 'cost', costUsd: 0.5, cacheSavingsUsd: 0.1 }),
        JSON.stringify({ type: 'budget-exceeded', kind: 'usd', limit: 0.4, value: 0.5 }),
        finishPart,
        '[DONE]',
      ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.cost).toEqual({ costUsd: 0.5, cacheSavingsUsd: 0.1 });
    expect(result.current.budgetExceeded).toEqual({ kind: 'usd', limit: 0.4, value: 0.5 });
    expect(result.current.dataParts).toEqual([{ name: 'chart', payload: { x: 1 } }]);
    expect(result.current.citations).toHaveLength(1);
    expect(result.current.citations[0]).toMatchObject({ id: 'c1', url: 'https://ex.com' });
  });

  it('approval flow: token-carrying request pauses; the verdict auto-echoes the token', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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
                approvalId: 'a1',
                toolCallId: 't1',
                toolName: 'del',
                input: { p: '/x' },
                token: 'tok-1',
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
    expect(result.current.pendingApprovals[0]).toMatchObject({
      approvalId: 'a1',
      toolName: 'del',
      token: 'tok-1',
    });
    const toolCall = result.current.messages.at(-1)?.toolCalls?.[0];
    expect(toolCall).toMatchObject({ toolCallId: 't1', state: 'approval-requested' });

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(call).toBe(2);
    // Token preserved automatically — the caller never threaded it.
    expect(bodies[1]!.approvalResponses).toEqual([
      { approvalId: 'a1', approved: true, token: 'tok-1' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.messages.at(-1)?.content).toBe('Deleted.');
  });

  it('auto-runs client tools via onToolCall and re-POSTs with the tool_result', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
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
    const msgs = bodies[1]!.messages;
    expect(msgs.at(-2)).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(msgs.at(-2))).toContain('"t1"');
    expect(msgs.at(-1)).toMatchObject({ role: 'tool' });
    expect(JSON.stringify(msgs.at(-1))).toContain('48.85');
    expect(result.current.messages.at(-1)?.content).toBe('You are in Paris.');
    const toolMsg = result.current.messages.find((m) => m.toolCalls?.length);
    expect(toolMsg?.toolCalls?.[0]).toMatchObject({ toolCallId: 't1', state: 'result' });
  });

  it('a thrown client tool self-heals into an is_error tool_result', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return sseResponseOf(
        ++call === 1
          ? [
              JSON.stringify({ type: 'tool-call', toolCallId: 't1', toolName: 'boom', input: {} }),
              finishPart,
              '[DONE]',
            ]
          : [JSON.stringify({ type: 'text-delta', text: 'recovered' }), finishPart, '[DONE]'],
      );
    };
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: fetchMock,
        onToolCall: () => {
          throw new Error('tool exploded');
        },
      }),
    );
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(call).toBe(2); // the throw did NOT kill the loop
    const toolTurn = JSON.stringify(bodies[1]!.messages.at(-1));
    expect(toolTurn).toContain('"isError":true');
    expect(toolTurn).toContain('tool exploded');
    expect(result.current.error).toBeUndefined();
  });

  it('regenerate drops the trailing assistant turn (core dropTrailingAssistant)', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return sseResponseOf([
        JSON.stringify({ type: 'text-delta', text: `answer ${bodies.length}` }),
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

    await act(async () => {
      await result.current.regenerate();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // The SECOND request re-ran the SAME user turn — assistant turn was cut.
    expect(bodies[1]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]?.content).toBe('answer 2');
  });

  it('editAndResend branches before the edited user turn (core branchBeforeUserMessage)', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return sseResponseOf([
        JSON.stringify({ type: 'text-delta', text: 'A' }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('first');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    const userId = result.current.messages[0]!.id;

    await act(async () => {
      await result.current.editAndResend(userId, 'second');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // The SECOND request history was cut BEFORE 'first' — only 'second' remains.
    expect(bodies[1]!.messages).toEqual([{ role: 'user', content: 'second' }]);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: 'second' });
  });

  it('an error part becomes error state (onError fires), and stop() is not an error', async () => {
    const seenErrors: string[] = [];
    const errFetch: typeof fetch = async () =>
      sseResponseOf([JSON.stringify({ type: 'error', message: 'boom' }), '[DONE]']);
    const { result } = renderHook(() =>
      useChat({ api: '/x', fetch: errFetch, onError: (e) => seenErrors.push(e.message) }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toBe('boom');
    expect(seenErrors).toEqual(['boom']);

    // stop(): abort mid-flight resolves to idle, no error.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const { result: r2 } = renderHook(() => useChat({ api: '/x', fetch: hangingFetch }));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = r2.current.sendMessage('hi');
    });
    await waitFor(() => expect(r2.current.status).toBe('streaming'));
    act(() => {
      r2.current.stop();
    });
    await act(async () => {
      await sendPromise;
    });
    expect(r2.current.status).toBe('idle');
    expect(r2.current.error).toBeUndefined();
  });

  it('reconnect() reads the resume endpoint via connectDeuzStream and folds the parts', async () => {
    const cursors: Array<string | undefined> = [];
    const endpoint = (ctx: { lastEventId?: string }): Response => {
      cursors.push(ctx.lastEventId);
      return v2SseResponseOf([
        { id: 0, data: JSON.stringify({ type: 'start', messageId: 'srv-9' }) },
        { id: 1, data: JSON.stringify({ type: 'text-delta', text: 'Resumed ' }) },
        { id: 2, data: JSON.stringify({ type: 'text-delta', text: 'answer' }) },
        { id: 3, data: finishPart },
        { id: 4, data: '[DONE]' },
      ]);
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', resume: { endpoint } }));
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(cursors).toEqual([undefined]); // no prior cursor — full replay
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: 'srv-9',
      role: 'assistant',
      content: 'Resumed answer',
    });
    expect(result.current.error).toBeUndefined();
  });
});

describe('useObject', () => {
  it('accumulates object-delta parts and finishes', async () => {
    const bodies: unknown[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'm1' }),
        JSON.stringify({ type: 'object-delta', object: { city: 'Par' } }),
        JSON.stringify({ type: 'object-delta', object: { city: 'Paris' } }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() =>
      useObject<{ city: string }>({ api: '/api/object', fetch: fetchMock }),
    );
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
});
