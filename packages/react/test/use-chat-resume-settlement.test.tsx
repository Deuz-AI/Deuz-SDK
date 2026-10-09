/**
 * F07 (2.3): a turn read back through `reconnect()` settles EXACTLY like one
 * read from the POST — one shared settlement. Before 2.3 the resume path
 * restored approvals only, so an unresolved client tool that arrived through
 * a reconnect reached neither `onToolCall` nor `pendingToolCalls`, and the
 * transcript kept a `tool_use` nobody would ever answer.
 *
 * The other half is replay safety: a resume endpoint re-delivers whatever its
 * journal holds after the client's cursor, so a call this client already
 * answered must never be dispatched a second time because it showed up again.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import type { Message } from '@deuz-sdk/core';
import { useChat } from '../src/use-chat';
import { journal, parts, postResponse, recordingFetch, stallingResponse } from './wire';

const Strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

type ToolCallArg = { toolCallId: string; toolName: string; input: unknown };

const USER: Message = { role: 'user', content: 'send 1 eth' };

/** A route whose every POST answers with the final text. */
const answeringRoute = (text = 'Signed.') =>
  recordingFetch(() => postResponse([parts.text(text), parts.finish()]));

describe('useChat — reconnect settles client tools like the POST path (F07)', () => {
  it('PARKS an unresolved client tool that arrives through reconnect(); addToolResult continues', async () => {
    const wire = journal();
    await wire.leg([
      parts.start('srv-1'),
      parts.text('Signing. '),
      parts.toolCall('c1', 'signTx', { eth: 1 }),
      parts.finish(),
    ]);
    const route = answeringRoute();
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        resume: { endpoint: wire.endpoint },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.pendingToolCalls).toHaveLength(1));
    expect(result.current.pendingToolCalls[0]).toMatchObject({
      toolCallId: 'c1',
      toolName: 'signTx',
      input: { eth: 1 },
    });
    expect(result.current.status).toBe('idle');
    expect(route.bodies).toHaveLength(0); // parked, exactly like the POST path

    await act(async () => {
      await result.current.addToolResult({ toolCallId: 'c1', output: { hash: '0xabc' } });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(1);
    // The continuation answers the replayed call under the SERVER's id.
    expect(route.bodies[0]!.messages).toEqual([
      USER,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Signing. ' },
          { type: 'tool_use', id: 'c1', name: 'signTx', input: { eth: 1 } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'c1', result: { hash: '0xabc' } }],
      },
    ]);
    expect(result.current.pendingToolCalls).toEqual([]);
    expect(result.current.messages.at(-1)?.content).toBe('Signed.');
  });

  it('runs onToolCall ONCE for a replayed client tool and POSTs its result under the same id', async () => {
    const wire = journal();
    await wire.leg([
      parts.start('srv-1'),
      parts.toolCall('c1', 'signTx', { eth: 1 }),
      parts.finish(),
    ]);
    const route = answeringRoute();
    const onToolCall = vi.fn(async (_call: ToolCallArg) => ({ hash: '0x1' }));
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: wire.endpoint },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      toolCallId: 'c1',
      toolName: 'signTx',
      input: { eth: 1 },
    });
    expect(route.bodies).toHaveLength(1);
    expect(route.bodies[0]!.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'c1', result: { hash: '0x1' } }],
    });
    const card = result.current.messages.find((m) => m.toolCalls?.length)?.toolCalls?.[0];
    expect(card).toMatchObject({ toolCallId: 'c1', state: 'result', output: { hash: '0x1' } });
    expect(result.current.messages.at(-1)?.content).toBe('Signed.');
    expect(result.current.pendingToolCalls).toEqual([]);
  });

  it('separates completed results from calls awaiting the client: a server-run call never reaches the client', async () => {
    const wire = journal();
    await wire.leg([
      parts.toolCall('s1', 'search', { q: 'rag' }),
      parts.toolResult('s1', 'search', '3 hits'),
      parts.toolCall('c1', 'pick', { n: 3 }),
      parts.finish(),
    ]);
    const route = answeringRoute('Picked.');
    const onToolCall = vi.fn(async (_call: ToolCallArg) => 'paper-2');
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: wire.endpoint },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall.mock.calls.map(([call]) => call.toolCallId)).toEqual(['c1']);
    expect(route.bodies).toHaveLength(1);
    expect(route.bodies[0]!.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'c1', result: 'paper-2' }],
    });
  });

  it('a repeated tool-call frame dispatches the call once — in a replay and on the POST', async () => {
    const wire = journal();
    await wire.leg([
      parts.toolCall('c1', 'geo', {}),
      parts.toolCall('c1', 'geo', {}), // the journal holds the frame twice
      parts.finish(),
    ]);
    const route = recordingFetch((round) =>
      round === 2
        ? postResponse([
            parts.toolCall('c2', 'geo', {}),
            parts.toolCall('c2', 'geo', {}),
            parts.finish(),
          ])
        : postResponse([parts.text('Paris.'), parts.finish()]),
    );
    const onToolCall = vi.fn(async (_call: ToolCallArg) => ({ lat: 48.85 }));
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: wire.endpoint },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await act(async () => {
      await result.current.sendMessage('and now?');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall.mock.calls.map(([call]) => call.toolCallId)).toEqual(['c1', 'c2']);
    const toolMessages = route.bodies
      .map((b) => b.messages.at(-1))
      .filter((m) => m?.role === 'tool');
    expect(toolMessages).toEqual([
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', result: { lat: 48.85 } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c2', result: { lat: 48.85 } }] },
    ]);
  });

  it('keeps the replay cursor: reconnecting a parked turn again is a no-op, and the cursor survives', async () => {
    const wire = journal();
    await wire.leg([parts.toolCall('c1', 'signTx', { eth: 1 }), parts.finish()]); // seq 0, 1
    const route = answeringRoute();
    const saved: string[] = [];
    const cursor = {
      load: (): string | undefined => undefined,
      save: (id: string): void => {
        saved.push(id);
      },
    };
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        resume: { endpoint: wire.endpoint, cursor },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.pendingToolCalls).toHaveLength(1));
    const parked = { messages: result.current.messages, history: result.current.history };

    // A second reconnect before the call is answered resumes AFTER the settled
    // leg: the endpoint is caught up, so nothing is re-parked or re-appended.
    await act(async () => {
      await result.current.reconnect();
    });
    expect(wire.cursors).toEqual([undefined, '1']);
    expect(saved).toEqual(['0', '1']);
    expect(result.current.messages).toEqual(parked.messages);
    expect(result.current.history).toEqual(parked.history);
    expect(result.current.pendingToolCalls.map((c) => c.toolCallId)).toEqual(['c1']);

    await act(async () => {
      await result.current.addToolResult({ toolCallId: 'c1', output: 'ok' });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(1);

    // The continuation did not reset it either.
    await act(async () => {
      await result.current.reconnect();
    });
    expect(wire.cursors.at(-1)).toBe('1');
    expect(route.bodies).toHaveLength(1);
  });

  it('a completed call is never run again by a replay, even one that ignores the cursor', async () => {
    const wire = journal();
    await wire.leg([parts.toolCall('c1', 'charge', { usd: 5 }), parts.finish()]);
    const route = answeringRoute('Charged.');
    const onToolCall = vi.fn(async (_call: ToolCallArg) => ({ receipt: 'r-1' }));
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        // A lost cursor: every read replays the whole journal.
        resume: { endpoint: wire.replayEverything },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(route.bodies).toHaveLength(1);

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // The result in the canonical history is the evidence: no second charge,
    // no second continuation, nothing parked.
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(route.bodies).toHaveLength(1);
    expect(result.current.pendingToolCalls).toEqual([]);
  });

  it('auto-resume under StrictMode and a re-registered callback dispatch the call once', async () => {
    const wire = journal();
    await wire.leg([parts.toolCall('c1', 'geo', {}), parts.finish()]);
    const route = answeringRoute('Paris.');
    const onToolCall = vi.fn(async (_call: ToolCallArg) => ({ lat: 48.85 }));
    const initialProps: { handler: (call: ToolCallArg) => Promise<unknown> } = {
      handler: onToolCall,
    };
    const { result, rerender } = renderHook(
      ({ handler }) =>
        useChat({
          api: '/api/chat',
          fetch: route.fetch,
          onToolCall: handler,
          resume: { endpoint: wire.replayEverything, auto: true },
          initialMessages: [USER],
        }),
      { wrapper: Strict, initialProps },
    );
    await waitFor(() => expect(route.bodies).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(1);

    // Re-register the same callback (a new identity, as an inline handler
    // gets on every render) and read the stream again.
    rerender({ handler: (call) => onToolCall(call) });
    rerender({ handler: onToolCall });
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(route.bodies).toHaveLength(1);
  });

  it('a call still running is not dispatched again by a concurrent replay', async () => {
    const wire = journal();
    await wire.leg([parts.toolCall('c1', 'confirm', {}), parts.finish()]);
    const route = answeringRoute('Confirmed.');
    let release: (value: unknown) => void = () => undefined;
    const onToolCall = vi.fn(
      (_call: ToolCallArg) =>
        new Promise((resolve) => {
          release = resolve; // a confirm dialog the user has not answered yet
        }),
    );
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: wire.replayEverything },
        initialMessages: [USER],
      }),
    );

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.reconnect();
    });
    await waitFor(() => expect(onToolCall).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.reconnect(); // the user hits "retry" while the dialog is open
    });
    expect(onToolCall).toHaveBeenCalledTimes(1);

    await act(async () => {
      release('yes');
      await first;
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(route.bodies).toHaveLength(1);
  });

  it('a replay that spans an approval leg and its continuation re-opens only the open approval', async () => {
    const wire = journal();
    await wire.leg([
      parts.toolCall('t1', 'del', { p: '/a' }),
      parts.approval('a1', 't1', 'del', { p: '/a' }),
      parts.finish(),
    ]);
    // The continuation leg settled a1 (its result is journaled) and paused again on a2.
    await wire.leg([
      parts.toolResult('t1', 'del', 'deleted /a'),
      parts.toolCall('t2', 'del', { p: '/b' }),
      parts.approval('a2', 't2', 'del', { p: '/b' }),
      parts.approval('a2', 't2', 'del', { p: '/b' }), // repeated frame
      parts.finish(),
    ]);
    const route = answeringRoute('Done.');
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        resume: { endpoint: wire.endpoint },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // a1's call already has its result — it is not a question any more.
    expect(result.current.pendingApprovals.map((a) => a.approvalId)).toEqual(['a2']);

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a2', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(1);
    expect(route.bodies[0]!.approvalResponses).toEqual([{ approvalId: 'a2', approved: true }]);
  });

  it('across a reload, only a result in the restored history proves a call completed', async () => {
    const leg = [parts.toolCall('c1', 'charge', { memo: 'coffee', usd: 5 }), parts.finish()];
    const answered: Message[] = [
      USER,
      {
        role: 'assistant',
        // Restored from a store that reorders object keys (Postgres JSONB
        // does): the same input, so the same invocation.
        content: [
          { type: 'tool_use', id: 'c1', name: 'charge', input: { usd: 5, memo: 'coffee' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'c1', result: { receipt: 'r-1' } }],
      },
    ];

    // The app persisted `history.canonical` WITH the result: the replay is inert.
    const withEvidence = journal();
    await withEvidence.leg(leg);
    const routeA = answeringRoute('Charged.');
    const chargeA = vi.fn(async (_call: ToolCallArg) => ({ receipt: 'r-2' }));
    const { result: a } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: routeA.fetch,
        onToolCall: chargeA,
        resume: { endpoint: withEvidence.endpoint, auto: true },
        initialMessages: answered,
      }),
    );
    await waitFor(() => expect(withEvidence.cursors).toHaveLength(1));
    await waitFor(() => expect(a.current.status).toBe('idle'));
    expect(chargeA).not.toHaveBeenCalled();
    expect(routeA.bodies).toHaveLength(0);

    // Without that evidence the hook cannot know the call ran before the
    // reload: it is dispatched again (at-least-once across a reload).
    const noEvidence = journal();
    await noEvidence.leg(leg);
    const routeB = answeringRoute('Charged.');
    const chargeB = vi.fn(async (_call: ToolCallArg) => ({ receipt: 'r-3' }));
    const { result: b } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: routeB.fetch,
        onToolCall: chargeB,
        resume: { endpoint: noEvidence.endpoint, auto: true },
        initialMessages: [USER],
      }),
    );
    await waitFor(() => expect(routeB.bodies).toHaveLength(1));
    await waitFor(() => expect(b.current.status).toBe('idle'));
    expect(chargeB).toHaveBeenCalledTimes(1);
  });

  it('a dropped continuation is rebuilt from the cursor, not folded twice into its partial turn', async () => {
    const wire = journal();
    await wire.leg([parts.toolCall('c1', 'geo', {}), parts.finish()]); // seq 0, 1 (+ done 2)
    // The continuation is journaled whole (the server keeps running), but the
    // client sees one frame of it before the connection drops.
    const continuation = [parts.text('Hel'), parts.text('lo, Paris.'), parts.finish()];
    let posts = 0;
    const fetchMock: typeof fetch = async () => {
      posts++;
      return wire.respondDropping(continuation, 1);
    };
    const errors: string[] = [];
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: fetchMock,
        onToolCall: async () => ({ lat: 48.85 }),
        onError: (e) => errors.push(e.message),
        resume: { endpoint: wire.endpoint },
        initialMessages: [USER],
      }),
    );

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.messages.at(-1)?.content).toBe('Hel');
    expect(errors).toHaveLength(1);

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(posts).toBe(1); // the reconnect re-read the journal; it did not re-POST
    expect(wire.cursors).toEqual([undefined, '1']);
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.at(-1)?.content).toBe('Hello, Paris.');
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(result.current.history.canonical.at(-1)).toEqual({
      role: 'assistant',
      content: 'Hello, Paris.',
    });
  });

  it('a stopped resume read settles nothing; the next reconnect continues the same turn', async () => {
    const wire = journal();
    const leg = [
      parts.text('Let me check. '),
      parts.toolCall('c1', 'geo', {}),
      parts.text('Checked.'),
      parts.finish(),
    ];
    await wire.leg(leg); // seq 0..3 (+ done 4)
    const posts: unknown[] = [];
    let resumes = 0;
    // One transport for both routes, as an app's `fetch` would be: the POST
    // route, and a GET resume route whose FIRST read stalls after two frames.
    const fetchMock: typeof fetch = async (url, init) => {
      if (String(url) === '/api/chat') {
        posts.push(JSON.parse(String(init?.body)));
        return postResponse([parts.text('Paris.'), parts.finish()]);
      }
      const lastEventId = new Headers(init?.headers).get('last-event-id') ?? undefined;
      if (++resumes === 1) {
        return stallingResponse(
          leg.slice(0, 2).map((part, id) => ({ id, data: JSON.stringify(part) })),
          init?.signal,
        );
      }
      return wire.endpoint(lastEventId !== undefined ? { lastEventId } : {});
    };
    const onToolCall = vi.fn(async (_call: ToolCallArg) => ({ lat: 48.85 }));
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: fetchMock,
        onToolCall,
        resume: { endpoint: '/api/resume' },
        initialMessages: [USER],
      }),
    );

    let reading: Promise<void> | undefined;
    act(() => {
      reading = result.current.reconnect();
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.toolCalls).toHaveLength(1));
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await reading;
    });
    // Stopped mid-read: like the POST path's abort, nothing is settled — the
    // call the read had already delivered is NOT run, nothing is POSTed.
    expect(result.current.status).toBe('idle');
    expect(onToolCall).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(result.current.history.canonical).toEqual([USER]);
    expect(result.current.messages.at(-1)?.parts?.[0]).toMatchObject({ state: 'done' });

    // The cursor addresses that turn, so the next read continues it.
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(wire.cursors).toEqual(['1']);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    const assistants = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual(['Let me check. Checked.', 'Paris.']);
  });

  it('the POST path never treats a recycled call id as a replay (`tool_0` runs every round)', async () => {
    // An OpenAI-compatible server that omits ids gets `tool_${index}` from the
    // adapter, so a fresh round can legitimately reuse an answered id.
    const route = recordingFetch((round) =>
      round <= 2
        ? postResponse([parts.toolCall('tool_0', 'roll', {}), parts.finish()])
        : postResponse([parts.text('Rolled twice.'), parts.finish()]),
    );
    const onToolCall = vi.fn(async (_call: ToolCallArg) => 4);
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: route.fetch, onToolCall }),
    );
    await act(async () => {
      await result.current.sendMessage('roll twice');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(route.bodies).toHaveLength(3);
  });
});
