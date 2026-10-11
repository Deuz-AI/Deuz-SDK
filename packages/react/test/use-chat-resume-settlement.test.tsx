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

  it('a dropped continuation continues from where its POST read stopped, never folded twice', async () => {
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
    // Since 2.3 the POST read's event ids move the cursor (the G1 hand-off):
    // the reconnect asks for what came after 'Hel' and continues that turn.
    expect(wire.cursors).toEqual([undefined, '3']);
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

/**
 * A provider without call ids gets `tool_0`, `tool_1`, … from core's adapter
 * afresh in every model response, so one id can name several calls of one
 * exchange. A result settles the call that came BEFORE it, never a later one
 * that reuses its id, and a call this client answered under a recycled id does
 * not stand in for a newer, identical call the server still waits on.
 */
describe('useChat — recycled call ids in a replayed turn (2.3)', () => {
  const CLEANUP: Message = { role: 'user', content: 'clean up /tmp' };
  // Round 1 runs the server tool `search` as tool_0; round 2's gated `del` is tool_0 again.
  const GATED_LEG = [
    parts.start('srv-1'),
    parts.toolCall('tool_0', 'search', { q: 'tmp' }),
    parts.toolResult('tool_0', 'search', '1 file'),
    parts.toolCall('tool_0', 'del', { p: '/tmp/a' }),
    parts.approval('tool_0', 'tool_0', 'del', { p: '/tmp/a' }),
    parts.finish(),
  ];

  it('keeps the gate of a call whose id an earlier, executed call used — on the POST and in a replay', async () => {
    const post = recordingFetch((round) =>
      round === 1
        ? postResponse(GATED_LEG)
        : postResponse([parts.text('Deleted.'), parts.finish()]),
    );
    const { result: posted } = renderHook(() => useChat({ api: '/api/chat', fetch: post.fetch }));
    await act(async () => {
      await posted.current.sendMessage('clean up /tmp');
    });
    await waitFor(() => expect(posted.current.status).toBe('idle'));
    expect(posted.current.pendingApprovals.map((a) => a.toolName)).toEqual(['del']);

    // The same leg read back after a reload pauses on the same gate.
    const wire = journal();
    await wire.leg(GATED_LEG);
    const route = answeringRoute('Deleted.');
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        resume: { endpoint: wire.endpoint, auto: true },
        initialMessages: [CLEANUP],
      }),
    );
    await waitFor(() => expect(wire.cursors).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.messages.at(-1)?.toolCalls?.[0]).toMatchObject({
      toolCallId: 'tool_0',
      toolName: 'del',
      state: 'approval-requested',
    });
    expect(result.current.pendingApprovals.map((a) => a.toolName)).toEqual(['del']);
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'tool_0', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(1);
    expect(route.bodies[0]!.approvalResponses).toEqual([{ approvalId: 'tool_0', approved: true }]);
  });

  it('rebuilds that gate when reconnect() follows a dropped POST', async () => {
    const wire = journal();
    let posts = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      posts++;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      // The server journals the whole leg; the client sees two frames, then the drop.
      if (posts === 1) return wire.respondDropping(GATED_LEG, 2);
      return postResponse([parts.text('Deleted.'), parts.finish()]);
    };
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, resume: { endpoint: wire.endpoint } }),
    );
    await act(async () => {
      await result.current.sendMessage('clean up /tmp');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.pendingApprovals.map((a) => a.toolName)).toEqual(['del']);
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'tool_0', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(posts).toBe(2);
    expect(bodies[1]!.approvalResponses).toEqual([{ approvalId: 'tool_0', approved: true }]);
  });

  it('opens only the newest gate of a replay whose continuation reuses the settled id', async () => {
    const wire = journal();
    await wire.leg([
      parts.toolCall('tool_0', 'del', { p: '/a' }),
      parts.approval('tool_0', 'tool_0', 'del', { p: '/a' }),
      parts.finish(),
    ]);
    // Approved: the server ran it, and the model's next gated call is tool_0 again.
    await wire.leg([
      parts.toolResult('tool_0', 'del', 'deleted /a'),
      parts.toolCall('tool_0', 'del', { p: '/b' }),
      parts.approval('tool_0', 'tool_0', 'del', { p: '/b' }),
      parts.finish(),
    ]);
    const route = answeringRoute('Done.');
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        resume: { endpoint: wire.endpoint, auto: true },
        initialMessages: [CLEANUP],
      }),
    );
    await waitFor(() => expect(wire.cursors).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.pendingApprovals.map((a) => a.input)).toEqual([{ p: '/b' }]);
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'tool_0', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(1);
  });

  it('runs a client call whose id an earlier, executed call used — on the POST and in a replay', async () => {
    // Round 1 runs the server tool `search` as tool_0; round 2 asks the client for `pick`, tool_0 again.
    const leg = [
      parts.toolCall('tool_0', 'search', { q: 'rag' }),
      parts.toolResult('tool_0', 'search', '3 hits'),
      parts.toolCall('tool_0', 'pick', { n: 3 }),
      parts.finish(),
    ];
    const post = recordingFetch((round) =>
      round === 1 ? postResponse(leg) : postResponse([parts.text('Picked.'), parts.finish()]),
    );
    const onPost = vi.fn(async (_call: ToolCallArg) => 'paper-2');
    const { result: posted } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: post.fetch, onToolCall: onPost }),
    );
    await act(async () => {
      await posted.current.sendMessage('find and pick');
    });
    await waitFor(() => expect(posted.current.status).toBe('idle'));
    expect(onPost.mock.calls.map(([call]) => call.toolName)).toEqual(['pick']);
    expect(post.bodies).toHaveLength(2);

    const wire = journal();
    await wire.leg(leg);
    const route = answeringRoute('Picked.');
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
      toolCallId: 'tool_0',
      toolName: 'pick',
    });
    await act(async () => {
      await result.current.addToolResult({ toolCallId: 'tool_0', output: 'paper-2' });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(1);
    expect(route.bodies[0]!.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'tool_0', result: 'paper-2' }],
    });
  });

  it('runs an identical repeated client call after a reconnect that follows a dropped POST', async () => {
    // Both legs ask roll({}) as tool_0. Leg 1 is answered; leg 2's stream drops.
    const leg = [parts.toolCall('tool_0', 'roll', {}), parts.finish()];
    const wire = journal();
    let posts = 0;
    const fetchMock: typeof fetch = async () => {
      posts++;
      if (posts === 1) return wire.respond(leg);
      if (posts === 2) return wire.respondDropping(leg, 1);
      return postResponse([parts.text('Rolled twice.'), parts.finish()]);
    };
    const onToolCall = vi.fn(async (_call: ToolCallArg) => 4);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: fetchMock,
        onToolCall,
        resume: { endpoint: wire.endpoint },
      }),
    );
    await act(async () => {
      await result.current.sendMessage('roll twice');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(onToolCall).toHaveBeenCalledTimes(1);

    // The POST reads carried the journal's ids (2.3), so the reconnect asks
    // for the rest of leg 2 only. Its roll({}) is new, although the history
    // already answers an identical tool_0 from leg 1.
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(wire.cursors).toEqual(['3']);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(posts).toBe(3);
    expect(result.current.messages.at(-1)?.content).toBe('Rolled twice.');
  });

  it('runs an identical repeated client call once when a reload replays both legs from no cursor', async () => {
    // Both legs ask roll({}) as tool_0. The app persisted leg 1 with its
    // answer; leg 2 was in flight when the page reloaded, and no cursor survived.
    const leg = [parts.toolCall('tool_0', 'roll', {}), parts.finish()];
    const wire = journal();
    await wire.leg(leg);
    await wire.leg(leg);
    const route = answeringRoute('Rolled twice.');
    const onToolCall = vi.fn(async (_call: ToolCallArg) => 4);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: wire.endpoint, auto: true },
        initialMessages: [
          { role: 'user', content: 'roll twice' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool_0', name: 'roll', input: {} }],
          },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tool_0', result: 4 }] },
        ],
      }),
    );
    // The replay holds both legs: two deliveries of roll({}) against one answer.
    await waitFor(() => expect(route.bodies).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(wire.cursors).toEqual([undefined]);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(result.current.messages.at(-1)?.content).toBe('Rolled twice.');
  });

  it('runs an identical repeated client call after a reconnect from the cursor', async () => {
    const leg = [parts.toolCall('tool_0', 'roll', {}), parts.finish()];
    const wire = journal();
    await wire.leg(leg); // the server ran leg 1 while the page reloaded
    let posts = 0;
    const fetchMock: typeof fetch = async () => {
      posts++;
      if (posts === 1) return wire.respondDropping(leg, 1);
      return postResponse([parts.text('Rolled twice.'), parts.finish()]);
    };
    const onToolCall = vi.fn(async (_call: ToolCallArg) => 4);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: fetchMock,
        onToolCall,
        resume: { endpoint: wire.endpoint, auto: true },
        initialMessages: [{ role: 'user', content: 'roll twice' }],
      }),
    );
    // The auto resume reads leg 1, runs roll and POSTs its result; that continuation drops.
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(onToolCall).toHaveBeenCalledTimes(1);

    // The replay holds leg 2 only. Its roll({}) is new, although the history
    // already answers an identical tool_0 from leg 1. The cursor is where the
    // continuation's POST read stopped (2.3).
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(wire.cursors).toEqual([undefined, '3']);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(posts).toBe(2);
    // The transcript never ends on an unanswered tool_use.
    expect(result.current.history.canonical.at(-1)).toEqual({
      role: 'assistant',
      content: 'Rolled twice.',
    });
  });

  it('still never runs an answered call again when the endpoint ignores the cursor', async () => {
    const leg = [parts.toolCall('tool_0', 'roll', {}), parts.finish()];
    const wire = journal();
    await wire.leg(leg);
    const route = answeringRoute('Rolled.');
    const onToolCall = vi.fn(async (_call: ToolCallArg) => 4);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: wire.replayEverything },
        initialMessages: [USER],
      }),
    );
    for (let read = 0; read < 3; read++) {
      await act(async () => {
        await result.current.reconnect();
      });
      await waitFor(() => expect(result.current.status).toBe('idle'));
    }
    // One delivery of roll({}), answered once: re-reading it from the start changes nothing.
    expect(wire.cursors).toEqual([undefined, '1', '1']);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(route.bodies).toHaveLength(1);
  });
});
