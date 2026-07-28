import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import type { ImagePart, Message } from '@deuz-sdk/core';
import { uiFromMessages } from '@deuz-sdk/core/chat';
import { useChat, partsFromFiles } from '../src/use-chat';
import { useObject } from '../src/use-object';

/** Deterministic id source per test. */
function scriptedIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

/** React 18/19 StrictMode double-invokes effects — `resume.auto` must survive it. */
const Strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

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

/** One macrotask, so a pushed SSE frame is fully folded before we read state. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A Deuz-wire SSE Response the TEST paces, frame by frame. `act()` flushes
 * React at the end of each call, so pushing one frame per `act` makes every
 * commit individually observable — which is the only way to see what
 * `throttleMs` does. (Pushing them all inside one `act` would be coalesced by
 * React itself, throttle or not, and prove nothing.)
 */
function controllableSse(): {
  response: Response;
  push: (line: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v2' } },
  );
  return {
    response,
    push: (line) => controller?.enqueue(encoder.encode(`data: ${line}\n\n`)),
    close: () => controller?.close(),
  };
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

/** A complete canonical `Usage` as the wire carries it. */
const USAGE = {
  inputTokens: 20,
  outputTokens: 6,
  reasoningTokens: 0,
  cachedReadTokens: 4,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 26,
};

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

  it('a 500 route becomes error state instead of an empty assistant bubble (1.9)', async () => {
    const seenErrors: string[] = [];
    // A failing route returns an HTML error page — zero `data:` lines. Pre-1.9
    // the stream ended silently and the user saw an EMPTY bubble at status idle.
    const failing: typeof fetch = async () =>
      new Response('<!doctype html><html><body>Internal Server Error</body></html>', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'text/html' },
      });
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: failing, onError: (e) => seenErrors.push(e.message) }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toContain('500');
    expect(result.current.error?.message).toContain('Internal Server Error');
    expect(result.current.error?.message).not.toContain('<html>'); // body never echoed
    expect(seenErrors).toHaveLength(1);
  });

  it('onHttpError:"ignore" restores the pre-1.9 silence', async () => {
    const failing: typeof fetch = async () =>
      new Response('nope', { status: 503, statusText: 'Service Unavailable' });
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: failing, onHttpError: 'ignore' }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.at(-1)).toMatchObject({ role: 'assistant', content: '' });
  });

  it('verify, finish and step-finish parts land in state (1.9)', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'srv-3' }),
        JSON.stringify({ type: 'step-finish', step: 0, finishReason: 'tool_calls', usage: USAGE }),
        JSON.stringify({
          type: 'verify',
          stepIndex: 0,
          attempt: 0,
          ok: false,
          willRetry: true,
          feedback: 'redo',
        }),
        JSON.stringify({ type: 'text-delta', text: 'Better answer' }),
        JSON.stringify({ type: 'verify', stepIndex: 1, attempt: 1, ok: true, willRetry: false }),
        JSON.stringify({ type: 'finish', finishReason: 'length', usage: USAGE }),
        '[DONE]',
      ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.verifications?.map((v) => v.ok)).toEqual([false, true]);
    expect(result.current.verifications?.[0]).toMatchObject({ willRetry: true, feedback: 'redo' });
    expect(result.current.usage).toEqual(USAGE);
    expect(result.current.finishReason).toBe('length'); // a UI can say "truncated"
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

/** 3.2b — the transcript is WRITABLE. Every one of these was impossible in 1.8. */
describe('useChat — writable state (1.9)', () => {
  const okStream = (text: string): Response =>
    sseResponseOf([JSON.stringify({ type: 'text-delta', text }), finishPart, '[DONE]']);

  it('setMessages deletes a rendered turn and the NEXT POST carries the new canonical history', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return okStream('ok');
    };
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, generateId: scriptedIds('w') }),
    );
    await act(async () => {
      await result.current.sendMessage('one');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.messages).toHaveLength(2);

    act(() => {
      result.current.setMessages((prev) => prev.filter((m) => m.role === 'user'));
    });
    expect(result.current.messages).toHaveLength(1);

    // COHERENCE PROOF: the canonical view was re-derived from the UI one, so the
    // deleted assistant turn is gone from the wire too — not just from the DOM.
    await act(async () => {
      await result.current.sendMessage('two');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(bodies[1]!.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ]);
  });

  it('setHistory replaces BOTH views wholesale — a system prompt the UI cannot carry survives', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return okStream('ok');
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    // Hydrating AFTER mount — 1.8 needed a remount with a new React key.
    const canonical: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'restored question' },
      { role: 'assistant', content: 'restored answer' },
    ];
    act(() => {
      result.current.setHistory({ ui: uiFromMessages(canonical, scriptedIds('r')), canonical });
    });
    expect(result.current.messages).toHaveLength(2); // system messages are not rendered
    // Replaced WHOLESALE into new arrays (immutable history) — the caller's
    // array is never adopted by reference, so later mutation cannot leak in.
    expect(result.current.history.canonical).not.toBe(canonical);
    expect(result.current.history.canonical).toEqual(canonical);

    await act(async () => {
      await result.current.sendMessage('next');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(bodies[0]!.messages).toEqual([...canonical, { role: 'user', content: 'next' }]);
  });

  it('addToolResult answers a parked client tool from OUTSIDE the hook and the chat continues', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return sseResponseOf(
        ++call === 1
          ? [
              JSON.stringify({
                type: 'tool-call',
                toolCallId: 't1',
                toolName: 'signTx',
                input: { eth: 1 },
              }),
              finishPart,
              '[DONE]',
            ]
          : [JSON.stringify({ type: 'text-delta', text: 'Signed.' }), finishPart, '[DONE]'],
      );
    };
    // NO onToolCall: a tool needing a wallet signature PARKS instead of
    // deadlocking the round-trip (1.8 abandoned the tool_use here).
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('send 1 eth');
    });
    await waitFor(() => expect(result.current.pendingToolCalls).toHaveLength(1));
    expect(call).toBe(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.pendingToolCalls[0]).toMatchObject({
      toolCallId: 't1',
      toolName: 'signTx',
    });

    // An id nobody is waiting on is IGNORED — an orphan tool_result 400s the
    // next request, so it must never reach the wire.
    await act(async () => {
      await result.current.addToolResult({ toolCallId: 'ghost', output: 1 });
    });
    expect(call).toBe(1);

    await act(async () => {
      await result.current.addToolResult({ toolCallId: 't1', output: { hash: '0xabc' } });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(call).toBe(2);
    expect(result.current.pendingToolCalls).toHaveLength(0);
    const msgs = bodies[1]!.messages;
    expect(msgs.at(-2)).toMatchObject({ role: 'assistant' });
    expect(msgs.at(-1)).toMatchObject({ role: 'tool' });
    expect(JSON.stringify(msgs.at(-1))).toContain('0xabc');
    expect(result.current.messages.at(-1)?.content).toBe('Signed.');
    // Folded through the SAME reducer path onToolCall's return value takes.
    const card = result.current.messages.find((m) => m.toolCalls?.length)?.toolCalls?.[0];
    expect(card).toMatchObject({ toolCallId: 't1', state: 'result', output: { hash: '0xabc' } });
  });

  it('clearError returns status to idle and the next send works', async () => {
    let call = 0;
    const fetchMock: typeof fetch = async () =>
      ++call === 1
        ? sseResponseOf([JSON.stringify({ type: 'error', message: 'boom' }), '[DONE]'])
        : okStream('fine');
    const { result } = renderHook(() => useChat({ api: '/x', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => {
      result.current.clearError();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      await result.current.sendMessage('again');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.messages.at(-1)?.content).toBe('fine');
    expect(result.current.error).toBeUndefined();
  });
});

/** 3.3b — multimodal input. The blocking layer was purely the hook signature. */
describe('useChat — multimodal input (1.9)', () => {
  it('partsFromFiles → sendMessage({ text, parts }) posts the image part, media FIRST', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return sseResponseOf([
        JSON.stringify({ type: 'text-delta', text: 'A screenshot.' }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    const files = [
      new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }),
    ];
    let parts: ImagePart[] = [];
    await act(async () => {
      parts = await partsFromFiles(files);
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });

    await act(async () => {
      await result.current.sendMessage({ text: 'what is in this?', parts });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    const posted = bodies[0]!.messages[0] as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(posted.role).toBe('user');
    expect(posted.content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(posted.content[1]).toEqual({ type: 'text', text: 'what is in this?' });

    // The user bubble carries the ordered `file` element, so the attachment can
    // actually be rendered — 1.8 dropped it and showed a text-only bubble.
    const bubble = result.current.messages[0]!;
    expect(bubble.content).toBe('what is in this?');
    expect(bubble.parts?.map((p) => p.type)).toEqual(['file', 'text']);
    expect(bubble.parts?.[0]).toMatchObject({ type: 'file', mediaType: 'image/png' });
  });

  it('a bare string is unchanged: canonical content stays a plain STRING', async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      return sseResponseOf([
        JSON.stringify({ type: 'text-delta', text: 'y' }),
        finishPart,
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // A prompt-cache prefix must not move when a caller upgrades to 1.9.
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    // Null-tolerant: `<input type="file">.files` is nullable.
    await expect(partsFromFiles(null)).resolves.toEqual([]);
  });
});

/** 3.4 — one React commit per fold, optionally coalesced. */
describe('useChat — render coalescing (1.9)', () => {
  const words = Array.from({ length: 24 }, (_, n) => `${n} `);
  const expected = words.join('');

  /** Stream 24 deltas one flushed frame at a time, recording what the UI showed. */
  const measure = async (
    throttleMs: number,
  ): Promise<{ renders: number; seen: string[]; final?: string }> => {
    const wire = controllableSse();
    const fetchMock: typeof fetch = async () => wire.response;
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useChat({ api: '/api/chat', fetch: fetchMock, throttleMs });
    });
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.sendMessage('count');
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    const rendersBeforeDeltas = renders;
    const seen: string[] = [];
    for (const text of words) {
      await act(async () => {
        wire.push(JSON.stringify({ type: 'text-delta', text }));
        await tick();
      });
      seen.push(result.current.messages.at(-1)?.content ?? '<none>');
    }
    const deltaRenders = renders - rendersBeforeDeltas;
    await act(async () => {
      wire.push(finishPart);
      wire.push('[DONE]');
      wire.close();
      await sending;
    });
    return { renders: deltaRenders, seen, final: result.current.messages.at(-1)?.content };
  };

  it('throttleMs coalesces deltas into far fewer commits and never loses the final text', async () => {
    const live = await measure(0);
    const throttled = await measure(60_000);

    // The terminal frame is ALWAYS flushed, so coalescing can never truncate an
    // answer — that is the whole risk of throttling and the reason `flush()`
    // sits on every exit path.
    expect(live.final).toBe(expected);
    expect(throttled.final).toBe(expected);

    // 1.8 semantics (throttleMs 0): every delta is visible as it arrives.
    expect(new Set(live.seen).size).toBe(words.length);
    expect(live.seen.at(-1)).toBe(expected);
    expect(live.renders).toBeGreaterThanOrEqual(words.length);

    // Throttled: nothing lands mid-window — the transcript is not re-rendered
    // once per token, which is what pins the main thread on a long chat.
    // `seen` is the exact assertion: no delta content is ever observable inside
    // the window. The render COUNT is bounded rather than pinned to 0 — with
    // real timers and 24 sequential `act()` flushes, React can legitimately
    // commit once for an unrelated state settle, and that raced under full-suite
    // load while passing in isolation. The property under test is "not once per
    // token", so a bound two orders below `words.length` states it without
    // asserting a scheduler detail.
    expect(new Set(throttled.seen)).toEqual(new Set(['']));
    expect(throttled.renders).toBeLessThanOrEqual(2);
    expect(throttled.renders).toBeLessThan(words.length / 4);
  });
});

/** 3.6 — resumability finally has a TRIGGER. */
describe('useChat — automatic resume (1.9)', () => {
  it('resume.auto fires exactly ONCE under StrictMode and persists the cursor through the adapter', async () => {
    let hits = 0;
    const saved: string[] = [];
    const loaded: string[] = [];
    const endpoint = (ctx: { lastEventId?: string }): Response => {
      hits++;
      loaded.push(ctx.lastEventId ?? '<none>');
      return v2SseResponseOf([
        { id: 7, data: JSON.stringify({ type: 'text-delta', text: 'resumed' }) },
        { id: 8, data: finishPart },
        { id: 9, data: '[DONE]' },
      ]);
    };
    const cursor = {
      load: (): string | undefined => '6',
      save: (id: string): void => {
        saved.push(id);
      },
    };
    const { result } = renderHook(
      () => useChat({ api: '/api/chat', resume: { endpoint, auto: true, cursor } }),
      { wrapper: Strict },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(hits).toBe(1); // the ref guard survives StrictMode's double-invoke
    expect(loaded).toEqual(['6']); // the persisted cursor was used, not localStorage
    expect(result.current.messages[0]).toMatchObject({ role: 'assistant', content: 'resumed' });
    expect(saved).toEqual(['7', '8']); // committed per delivered part; `[DONE]` is off-cursor
  });

  it('a caught-up endpoint ([DONE] immediately) is a SILENT no-op — no bubble, no canonical write', async () => {
    const endpoint = (): Response => v2SseResponseOf([{ id: 0, data: '[DONE]' }]);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        resume: { endpoint },
        initialMessages: [{ role: 'user', content: 'q' }],
      }),
    );
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages).toHaveLength(1); // no empty assistant bubble
    // An empty assistant message in the canonical history would poison the next POST.
    expect(result.current.history.canonical).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('an AUTO attempt that fails stays idle; the same failure from reconnect() is reported', async () => {
    // A wire-v1 endpoint (no `id:` lines) cannot be resumed — connectDeuzStream
    // refuses rather than silently duplicating the parts it already delivered.
    const v1Endpoint = (): Response =>
      sseResponseOf([JSON.stringify({ type: 'text-delta', text: 'partial' })]);

    const errors: string[] = [];
    const { result: auto } = renderHook(() =>
      useChat({
        api: '/api/chat',
        resume: { endpoint: v1Endpoint, auto: true },
        onError: (e) => errors.push(e.message),
      }),
    );
    await waitFor(() => expect(auto.current.messages).toHaveLength(1));
    await waitFor(() => expect(auto.current.status).toBe('idle'));
    expect(auto.current.error).toBeUndefined();
    expect(errors).toEqual([]); // nothing the user did failed — see resume.auto

    const { result: manual } = renderHook(() =>
      useChat({ api: '/api/chat', resume: { endpoint: v1Endpoint } }),
    );
    await act(async () => {
      await manual.current.reconnect();
    });
    await waitFor(() => expect(manual.current.status).toBe('error'));
    expect(manual.current.error?.message).toContain('wire v1');
  });
});

/** 3.7c — everything the 1.9 wire carries reaches the consumer. */
describe('useChat — the 1.9 wire fields', () => {
  it('ordered parts, tool denial, reconciled dataParts, steps and verifications all surface', async () => {
    const seenData: Array<{ name: string; id?: string; payload: unknown }> = [];
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'srv-9' }),
        JSON.stringify({ type: 'step-start', step: 0 }),
        JSON.stringify({ type: 'reasoning-delta', text: 'let me check', signature: 'sig-1' }),
        JSON.stringify({ type: 'tool-call', toolCallId: 't1', toolName: 'rm', input: { p: '/x' } }),
        JSON.stringify({ type: 'data-status', id: 's1', payload: 'searching' }),
        JSON.stringify({ type: 'data-status', id: 's1', payload: 'done' }),
        JSON.stringify({
          type: 'tool-state',
          toolCallId: 't1',
          toolName: 'rm',
          state: 'error',
          denied: true,
          deniedReason: 'user declined',
        }),
        JSON.stringify({ type: 'text-delta', text: 'I stopped.' }),
        JSON.stringify({ type: 'verify', stepIndex: 0, attempt: 0, ok: true, willRetry: false }),
        JSON.stringify({ type: 'step-finish', step: 0, finishReason: 'tool_calls', usage: USAGE }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: USAGE }),
        '[DONE]',
      ]);
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, onData: (d) => seenData.push(d) }),
    );
    await act(async () => {
      await result.current.sendMessage('rm -rf /x');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    const turn = result.current.messages.at(-1)!;
    // The INTERLEAVE, which the flat buckets destroy: a renderer can now place
    // the tool card between the reasoning and the sentence that follows it.
    expect(turn.parts?.map((p) => p.type)).toEqual([
      'step-start',
      'reasoning',
      'tool',
      'data',
      'text',
    ]);
    expect(turn.parts?.[1]).toMatchObject({ type: 'reasoning', signature: 'sig-1' });
    // The wire's terminal `finish` sealed every streaming element.
    expect(
      turn.parts?.filter(
        (p) => (p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming',
      ),
    ).toEqual([]);
    // A declined call is not "rm failed".
    expect(turn.toolCalls?.[0]).toMatchObject({
      toolCallId: 't1',
      runState: 'error',
      denied: true,
      deniedReason: 'user declined',
    });
    // Addressable data: ONE entry, last write, original position.
    expect(result.current.dataParts).toEqual([{ name: 'status', id: 's1', payload: 'done' }]);
    // onData fires BEFORE reconciliation, so a caller sees the intermediate write.
    expect(seenData).toEqual([
      { name: 'status', id: 's1', payload: 'searching' },
      { name: 'status', id: 's1', payload: 'done' },
    ]);
    expect(result.current.steps).toEqual([{ step: 0, usage: USAGE, finishReason: 'tool_calls' }]);
    expect(result.current.verifications?.[0]).toMatchObject({ stepIndex: 0, ok: true });
    expect(result.current.finishReason).toBe('stop');
  });

  it('stop() seals the tail so a truncated turn does not render as still streaming', async () => {
    // A body that never finishes: the abort is the only terminal boundary, and
    // the wire sent no `finish`, so only the BINDING can seal the turn. The mock
    // errors the body on abort, exactly as a real `fetch` cancels it.
    const hangingFetch: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'text-delta', text: 'half a sen' })}\n\n`,
              ),
            );
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v2' } },
      );
    const { result } = renderHook(() => useChat({ api: '/x', fetch: hangingFetch }));
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('half a sen'));
    expect(result.current.messages.at(-1)?.parts?.[0]).toMatchObject({ state: 'streaming' });

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await sending;
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.at(-1)?.parts?.[0]).toMatchObject({
      type: 'text',
      text: 'half a sen',
      state: 'done',
    });
  });
});

// ===================================================================
// 1.9 WIRING PASS — the readouts for the three wire parts that had no consumer
// path at all: `warning`, `false-finish` and `sub-agent` (a delegated agentTool
// run used to be completely invisible here), plus denial vs a thrown tool.
// ===================================================================
describe('useChat — sub-agent, warnings and false-finish readouts (1.9)', () => {
  it('surfaces a sub-agent run WITHOUT putting its words in the parent bubble', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'srv-sub' }),
        JSON.stringify({ type: 'text-delta', text: 'Delegating. ' }),
        JSON.stringify({
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'researcher',
          input: { prompt: 'find papers' },
        }),
        // The child's stream, forwarded live and single-wrapped.
        JSON.stringify({
          type: 'sub-agent',
          agentPath: ['researcher'],
          part: { type: 'text-delta', text: 'searching arxiv' },
        }),
        JSON.stringify({
          type: 'sub-agent',
          agentPath: ['researcher'],
          part: {
            type: 'tool-call',
            toolCallId: 'child-1',
            toolName: 'search',
            input: { q: 'rag' },
          },
        }),
        // A 2nd-level sub-agent is a SIBLING frame with a 2-segment path.
        JSON.stringify({
          type: 'sub-agent',
          agentPath: ['researcher', 'coder'],
          part: { type: 'text-delta', text: 'writing a script' },
        }),
        JSON.stringify({
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'researcher',
          output: '3 papers.',
        }),
        JSON.stringify({ type: 'text-delta', text: 'Here they are.' }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: USAGE }),
        '[DONE]',
      ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('research rag');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // The readout a "Computer"-style panel renders: one frame per agentPath, in
    // the order each first spoke, each holding the child's OWN turn.
    expect(result.current.subAgents?.map((f) => f.agentPath)).toEqual([
      ['researcher'],
      ['researcher', 'coder'],
    ]);
    const child = result.current.subAgents![0]!;
    expect(child.turn.message.content).toBe('searching arxiv');
    expect(child.turn.message.toolCalls?.[0]).toMatchObject({ toolCallId: 'child-1' });
    // Its ordered parts are sealed with the parent's terminal `finish`.
    expect(child.turn.message.parts?.[0]).toMatchObject({ type: 'text', state: 'done' });
    expect(result.current.subAgents![1]!.turn.message.content).toBe('writing a script');
    // `afterPart` puts the frame back where the handoff happened (after the
    // parent's text and the agentTool card), so a renderer can indent it there.
    expect(child.afterPart).toBe(2);

    // NOT misattributed: the parent bubble is the parent's own words only, and
    // the POSTable canonical history never learns about the child's tool_use.
    const bubble = result.current.messages.at(-1)!;
    expect(bubble.content).toBe('Delegating. Here they are.');
    expect(bubble.content).not.toContain('searching arxiv');
    expect(bubble.toolCalls?.map((c) => c.toolCallId)).toEqual(['call-1']);
    expect(JSON.stringify(result.current.history.canonical)).not.toContain('child-1');
  });

  it('surfaces warnings and false-finish rejections without failing the turn', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        JSON.stringify({
          type: 'warning',
          warning: {
            type: 'unsupported-setting',
            setting: 'topP',
            message: 'topP is not supported on this model.',
          },
        }),
        JSON.stringify({ type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true }),
        JSON.stringify({ type: 'text-delta', text: 'ok, continuing' }),
        JSON.stringify({ type: 'false-finish', stepIndex: 1, attempt: 1, willRetry: false }),
        JSON.stringify({
          type: 'warning',
          warning: { type: 'unknown-model', message: 'fallback row' },
        }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: USAGE }),
        '[DONE]',
      ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(result.current.warnings).toEqual([
      {
        type: 'unsupported-setting',
        setting: 'topP',
        message: 'topP is not supported on this model.',
      },
      { type: 'unknown-model', message: 'fallback row' },
    ]);
    expect(result.current.falseFinishes).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
      { type: 'false-finish', stepIndex: 1, attempt: 1, willRetry: false },
    ]);
    // A warning is not an error and a rejected finish is not a failure: the turn
    // is a normal, successful one that also tells the truth about itself.
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.at(-1)?.content).toBe('ok, continuing');
  });

  it('renders a denied tool distinguishably from a thrown one', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        JSON.stringify({
          type: 'tool-call',
          toolCallId: 'd1',
          toolName: 'deleteRepo',
          input: { repo: 'x' },
        }),
        JSON.stringify({
          type: 'tool-call',
          toolCallId: 'e1',
          toolName: 'getWeather',
          input: { city: 'Paris' },
        }),
        JSON.stringify({
          type: 'tool-state',
          toolCallId: 'd1',
          toolName: 'deleteRepo',
          state: 'error',
          denied: true,
          deniedReason: 'declined by you',
        }),
        JSON.stringify({
          type: 'tool-result',
          toolCallId: 'd1',
          toolName: 'deleteRepo',
          output: 'denied',
          isError: true,
        }),
        JSON.stringify({
          type: 'tool-state',
          toolCallId: 'e1',
          toolName: 'getWeather',
          state: 'error',
        }),
        JSON.stringify({
          type: 'tool-result',
          toolCallId: 'e1',
          toolName: 'getWeather',
          output: 'boom',
          isError: true,
        }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: USAGE }),
        '[DONE]',
      ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('rm -rf');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    const calls = result.current.messages.at(-1)!.toolCalls!;
    expect(calls[0]).toMatchObject({
      toolCallId: 'd1',
      runState: 'error',
      isError: true,
      denied: true,
      deniedReason: 'declined by you',
    });
    // The whole point: a thrown tool carries NO denial keys, so the UI can draw
    // "declined by you" for one and a red error for the other.
    expect(calls[1]!.denied).toBeUndefined();
    expect(calls[1]!.deniedReason).toBeUndefined();
    expect(calls[1]).toMatchObject({ toolCallId: 'e1', runState: 'error', isError: true });
  });

  it('stays silent (and never throws) when the new parts are absent or malformed', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([
        // A hostile/older server: junk payloads for each new kind.
        JSON.stringify({ type: 'warning' }),
        JSON.stringify({ type: 'warning', warning: { message: 42 } }),
        JSON.stringify({
          type: 'sub-agent',
          agentPath: [],
          part: { type: 'text-delta', text: 'x' },
        }),
        JSON.stringify({ type: 'sub-agent', agentPath: ['a'], part: null }),
        JSON.stringify({ type: 'text-delta', text: 'fine' }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: USAGE }),
        '[DONE]',
      ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: fetchMock }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // Absent readouts stay ABSENT (never an empty array pretending to be data),
    // the stream is unharmed, and nothing threw.
    expect(result.current.warnings).toBeUndefined();
    expect(result.current.falseFinishes).toBeUndefined();
    expect(result.current.subAgents).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.at(-1)?.content).toBe('fine');
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
