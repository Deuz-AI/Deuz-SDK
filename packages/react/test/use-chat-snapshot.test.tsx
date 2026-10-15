/**
 * `ChatSnapshotV1` (2.4, spec §3.4): `useChat({ initialSnapshot })` restores a
 * chat and `exportSnapshot()` captures one. The history half mirrors
 * `ChatRecord` (`messages` plus `messageIds` aligned with them), so a stored
 * record restores under the ids the server gave it (H7), and two messages
 * with the same text stay two messages: ids, never text, tell them apart.
 */
import { StrictMode, createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Message } from '@deuz-sdk/core';
import type { DeuzUIPart } from '@deuz-sdk/core/ui';
import { useChat } from '../src/use-chat';
import type { ChatSnapshotV1 } from '../src/index';
import { journal, parts, postResponse, recordingFetch, stallingResponse } from './wire';

const SAME_TWICE: Message[] = [
  { role: 'user', content: 'same' },
  { role: 'assistant', content: 'echo' },
  { role: 'user', content: 'same' },
  { role: 'assistant', content: 'echo' },
];

/** A deterministic id source: gen-0, gen-1, … */
function counter(prefix = 'gen'): () => string {
  let next = 0;
  return () => `${prefix}-${next++}`;
}

const noFetch: typeof fetch = async () => {
  throw new Error('no request expected');
};

describe('useChat({ initialSnapshot }) — the history', () => {
  it('restores a stored chat under the server’s ids and keeps equal-text messages apart', () => {
    const snapshot: ChatSnapshotV1 = {
      version: 1,
      messages: SAME_TWICE,
      messageIds: ['u1', 'a1', 'u2', 'a2'],
    };
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: noFetch, initialSnapshot: snapshot }),
    );
    expect(result.current.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['u1', 'user', 'same'],
      ['a1', 'assistant', 'echo'],
      ['u2', 'user', 'same'],
      ['a2', 'assistant', 'echo'],
    ]);
    expect(result.current.history.canonical).toEqual(SAME_TWICE);
    expect(result.current.pendingApprovals).toEqual([]);
    expect(result.current.pendingToolCalls).toEqual([]);
    expect(result.current.status).toBe('idle');
  });

  it('generates an id only for a missing, empty or repeated one', () => {
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        generateId: counter(),
        initialSnapshot: {
          version: 1,
          messages: [...SAME_TWICE, { role: 'user', content: 'more' }],
          messageIds: ['u1', '', 'u1'],
        },
      }),
    );
    expect(result.current.messages.map((m) => m.id)).toEqual([
      'u1',
      'gen-0',
      'gen-1',
      'gen-2',
      'gen-3',
    ]);
  });

  it('skips system messages and folds tool results like uiFromMessages, ids aligned with messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'weather', input: { city: 'Paris' } }],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', result: 'sunny' }] },
      { role: 'assistant', content: 'Sunny.' },
    ];
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        initialSnapshot: { version: 1, messages, messageIds: ['s', 'u', 'a1', 't', 'a2'] },
      }),
    );
    expect(result.current.messages.map((m) => m.id)).toEqual(['u', 'a1', 'a2']);
    expect(result.current.messages[1]!.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: 'c1', state: 'result', output: 'sunny' }),
    ]);
    // Every message keeps its stored id on the way out, the ones the UI has no bubble for too.
    expect(result.current.exportSnapshot()).toEqual({
      version: 1,
      messages,
      messageIds: ['s', 'u', 'a1', 't', 'a2'],
    });
  });

  it('round-trips: what exportSnapshot captures restores the same chat', () => {
    const first = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        initialSnapshot: { version: 1, messages: SAME_TWICE, messageIds: ['u1', 'a1', 'u2', 'a2'] },
      }),
    );
    const snapshot = first.result.current.exportSnapshot();
    expect(snapshot).toEqual({
      version: 1,
      messages: SAME_TWICE,
      messageIds: ['u1', 'a1', 'u2', 'a2'],
    });
    // A snapshot is plain data: it survives JSON.
    const second = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        initialSnapshot: JSON.parse(JSON.stringify(snapshot)) as ChatSnapshotV1,
      }),
    );
    expect(second.result.current.messages).toEqual(first.result.current.messages);
    expect(second.result.current.history.canonical).toEqual(SAME_TWICE);
  });

  it('captures the ids of a live chat: the user bubbles’ and the ids the stream’s start gave', async () => {
    const wire = recordingFetch((round) =>
      postResponse([parts.start(`srv-${round}`), parts.text('echo'), parts.finish()]),
    );
    const generateId = counter('ui');
    const live = renderHook(() => useChat({ api: '/api/chat', fetch: wire.fetch, generateId }));
    await act(async () => {
      await live.result.current.sendMessage('same');
    });
    await act(async () => {
      await live.result.current.sendMessage('same');
    });
    await waitFor(() => expect(live.result.current.status).toBe('idle'));
    const ids = live.result.current.messages.map((m) => m.id);
    expect(ids).toEqual([ids[0], 'srv-1', ids[2], 'srv-2']);
    expect(new Set(ids).size).toBe(4);

    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot.messages).toEqual(SAME_TWICE);
    expect(snapshot.messageIds).toEqual(ids);

    const restored = renderHook(() =>
      useChat({ api: '/api/chat', fetch: noFetch, initialSnapshot: snapshot }),
    );
    expect(restored.result.current.messages.map((m) => [m.id, m.content])).toEqual([
      [ids[0], 'same'],
      ['srv-1', 'echo'],
      [ids[2], 'same'],
      ['srv-2', 'echo'],
    ]);
  });

  it('keeps initialMessages as it was: ids come from generateId, and export carries them', () => {
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        generateId: counter(),
        initialMessages: SAME_TWICE,
      }),
    );
    expect(result.current.messages.map((m) => m.id)).toEqual(['gen-0', 'gen-1', 'gen-2', 'gen-3']);
    expect(result.current.history.canonical).toEqual(SAME_TWICE);
    expect(result.current.exportSnapshot().messageIds).toEqual([
      'gen-0',
      'gen-1',
      'gen-2',
      'gen-3',
    ]);
  });

  it('exports the ids the UI renders under StrictMode, whose double initializers discard ids', () => {
    let next = 0;
    const generateId = () => `gen-${next++}`;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);
    const { result } = renderHook(
      () => useChat({ api: '/api/chat', fetch: noFetch, generateId, initialMessages: SAME_TWICE }),
      { wrapper },
    );
    expect(result.current.exportSnapshot().messageIds).toEqual(
      result.current.messages.map((m) => m.id),
    );
  });

  it('pairs a history set with setMessages with its UI ids', () => {
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: noFetch }));
    act(() => {
      result.current.setMessages([
        { id: 'x-1', role: 'user', content: 'same' },
        { id: 'x-2', role: 'assistant', content: 'echo' },
      ]);
    });
    expect(result.current.exportSnapshot()).toEqual({
      version: 1,
      messages: SAME_TWICE.slice(0, 2),
      messageIds: ['x-1', 'x-2'],
    });
  });

  it('prefers initialSnapshot over initialMessages', () => {
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        initialMessages: [{ role: 'user', content: 'ignored' }],
        initialSnapshot: { version: 1, messages: SAME_TWICE.slice(0, 2), messageIds: ['u', 'a'] },
      }),
    );
    expect(result.current.messages.map((m) => m.content)).toEqual(['same', 'echo']);
  });

  it('refuses a snapshot it does not understand', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const bad of [
        { version: 2, messages: [] },
        { version: 1, messages: 'nope' },
        { version: 1, messages: [], messageIds: 'nope' },
      ])
        expect(() =>
          renderHook(() =>
            useChat({
              api: '/api/chat',
              fetch: noFetch,
              initialSnapshot: bad as unknown as ChatSnapshotV1,
            }),
          ),
        ).toThrow(TypeError);
    } finally {
      error.mockRestore();
    }
  });
});

/** A leg the server journals whole; the POST read may see only its first frames. */
const PARIS_LEG = [
  parts.start('m-1'),
  parts.text('Hel'),
  parts.text('lo, '),
  parts.text('Paris.'),
  parts.finish(),
];

const USER: Message = { role: 'user', content: 'hi' };

/** A chat whose POST read dropped after `delivered` frames of `PARIS_LEG`; returns its snapshot. */
async function droppedChat(delivered: number) {
  const wire = journal();
  const fetchMock: typeof fetch = async () => wire.respondDropping(PARIS_LEG, delivered);
  const { result } = renderHook(() =>
    useChat({ api: '/api/chat', fetch: fetchMock, resume: { endpoint: wire.endpoint } }),
  );
  await act(async () => {
    await result.current.sendMessage('hi');
  });
  await waitFor(() => expect(result.current.status).toBe('error'));
  return { wire, snapshot: result.current.exportSnapshot(), live: result };
}

describe('useChat({ initialSnapshot }) — the turn in progress and the cursor', () => {
  it('captures the unsettled turn and the cursor of the last frame read', async () => {
    const { snapshot, live } = await droppedChat(2);
    expect(snapshot.messages).toEqual([USER]);
    expect(snapshot.cursor).toBe('1');
    expect(snapshot.turn?.message).toEqual(live.current.messages.at(-1));
    expect(snapshot.turn?.message).toMatchObject({ id: 'm-1', role: 'assistant', content: 'Hel' });
  });

  it('restores the partial bubble and continues it from the cursor, every frame once', async () => {
    const { wire, snapshot } = await droppedChat(2);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        resume: { endpoint: wire.endpoint },
        initialSnapshot: JSON.parse(JSON.stringify(snapshot)) as ChatSnapshotV1,
      }),
    );
    expect(result.current.messages.map((m) => [m.id, m.content])).toEqual([
      [snapshot.messageIds![0], 'hi'],
      ['m-1', 'Hel'],
    ]);
    expect(result.current.status).toBe('idle');

    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(wire.cursors).toEqual(['1']);
    expect(result.current.messages.map((m) => [m.id, m.content])).toEqual([
      [snapshot.messageIds![0], 'hi'],
      ['m-1', 'Hello, Paris.'],
    ]);
    expect(result.current.history.canonical).toEqual([
      USER,
      { role: 'assistant', content: 'Hello, Paris.' },
    ]);
    const settled = result.current.exportSnapshot();
    expect(settled.turn).toBeUndefined();
    expect(settled.messageIds).toEqual([snapshot.messageIds![0], 'm-1']);
    expect(settled.cursor).toBe('4');
  });

  it('continues with resume.auto on mount', async () => {
    const { wire, snapshot } = await droppedChat(3);
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        resume: { endpoint: wire.endpoint, auto: true },
        initialSnapshot: snapshot,
      }),
    );
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Hello, Paris.'));
    expect(wire.cursors).toEqual(['2']);
    expect(result.current.messages).toHaveLength(2);
  });

  it('seals the restored turn when nothing can continue it', async () => {
    const { snapshot } = await droppedChat(2);
    expect(snapshot.turn?.message.parts?.at(-1)).toMatchObject({
      type: 'text',
      state: 'streaming',
    });
    const { result } = renderHook(() =>
      useChat({ api: '/api/chat', fetch: noFetch, initialSnapshot: snapshot }),
    );
    expect(result.current.messages.at(-1)?.parts?.at(-1)).toMatchObject({
      type: 'text',
      state: 'done',
    });
  });

  it('rebuilds a restored turn that was read without event ids from the start of its stream', async () => {
    const wire = journal();
    await wire.leg(PARIS_LEG);
    // The POST route does not journal: its frames carry no ids, so no cursor.
    const fetchMock: typeof fetch = async (_url, init) =>
      stallingResponse(
        PARIS_LEG.slice(0, 2).map((part) => ({ data: JSON.stringify(part) })),
        init?.signal,
      );
    const live = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, resume: { endpoint: wire.endpoint } }),
    );
    let sending!: Promise<void>;
    act(() => {
      sending = live.result.current.sendMessage('hi');
    });
    await waitFor(() => expect(live.result.current.messages.at(-1)?.content).toBe('Hel'));
    await act(async () => {
      live.result.current.stop();
      await sending;
    });
    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot.cursor).toBeUndefined();
    expect(snapshot.turn?.message.content).toBe('Hel');

    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        resume: { endpoint: wire.endpoint },
        initialSnapshot: snapshot,
      }),
    );
    await act(async () => {
      await result.current.reconnect();
    });
    expect(wire.cursors).toEqual([undefined]);
    expect(result.current.messages.map((m) => [m.id, m.content])).toEqual([
      [snapshot.messageIds![0], 'hi'],
      ['m-1', 'Hello, Paris.'],
    ]);
  });

  it('resumes a settled chat after its cursor, adding nothing it already holds', async () => {
    const wire = journal();
    const fetchMock: typeof fetch = async () => wire.respond(PARIS_LEG);
    const live = renderHook(() =>
      useChat({ api: '/api/chat', fetch: fetchMock, resume: { endpoint: wire.endpoint } }),
    );
    await act(async () => {
      await live.result.current.sendMessage('hi');
    });
    await waitFor(() => expect(live.result.current.status).toBe('idle'));
    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot).toMatchObject({ cursor: '4', messageIds: [expect.any(String), 'm-1'] });
    expect(snapshot.turn).toBeUndefined();

    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: noFetch,
        resume: { endpoint: wire.endpoint },
        initialSnapshot: snapshot,
      }),
    );
    await act(async () => {
      await result.current.reconnect();
    });
    expect(wire.cursors).toEqual(['4']);
    expect(result.current.messages.map((m) => m.content)).toEqual(['hi', 'Hello, Paris.']);
    expect(result.current.history.canonical).toHaveLength(2);
  });
});

/** A verdict as the request body carries it. */
type Verdict = { approvalId: string; approved: boolean; token?: string };

/** Restores `snapshot` (through JSON) against a recording POST route. */
function restore(snapshot: ChatSnapshotV1) {
  const wire = recordingFetch(() => postResponse([parts.text('Done.'), parts.finish()]));
  const hook = renderHook(() =>
    useChat({
      api: '/api/chat',
      fetch: wire.fetch,
      initialSnapshot: JSON.parse(JSON.stringify(snapshot)) as ChatSnapshotV1,
    }),
  );
  return { ...hook, bodies: wire.bodies };
}

describe('useChat({ initialSnapshot }) — gates', () => {
  it('keeps an approval gate across a remount; the verdict resumes with the restored history', async () => {
    const live = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: recordingFetch(() =>
          postResponse([
            parts.start('m-1'),
            parts.toolCall('d1', 'del', { path: '/a' }),
            parts.approval('ap1', 'd1', 'del', { path: '/a' }, 'tok-1'),
            parts.finish(),
          ]),
        ).fetch,
      }),
    );
    await act(async () => {
      await live.result.current.sendMessage('clean up');
    });
    await waitFor(() => expect(live.result.current.pendingApprovals).toHaveLength(1));
    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot.pendingApprovals).toEqual(live.result.current.pendingApprovals);
    expect(snapshot.turn).toBeUndefined();

    const restored = restore(snapshot);
    expect(restored.result.current.pendingApprovals).toEqual(snapshot.pendingApprovals);
    expect(restored.result.current.messages.map((m) => m.id)).toEqual(snapshot.messageIds);
    await act(async () => {
      await restored.result.current.addToolApprovalResponse({ approvalId: 'ap1', approved: true });
    });
    await waitFor(() => expect(restored.result.current.status).toBe('idle'));
    expect(restored.bodies).toHaveLength(1);
    expect(restored.bodies[0]!.messages).toEqual(snapshot.messages);
    expect(restored.bodies[0]!.approvalResponses).toEqual([
      { approvalId: 'ap1', approved: true, token: 'tok-1' },
    ]);
    expect(restored.result.current.pendingApprovals).toEqual([]);
  });

  it('keeps the verdicts a gate already has', async () => {
    const live = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: recordingFetch(() =>
          postResponse([
            parts.toolCall('d1', 'del', { path: '/a' }),
            parts.approval('ap1', 'd1', 'del', { path: '/a' }),
            parts.toolCall('d2', 'del', { path: '/b' }),
            parts.approval('ap2', 'd2', 'del', { path: '/b' }),
            parts.finish(),
          ]),
        ).fetch,
      }),
    );
    await act(async () => {
      await live.result.current.sendMessage('clean up');
    });
    await waitFor(() => expect(live.result.current.pendingApprovals).toHaveLength(2));
    await act(async () => {
      await live.result.current.addToolApprovalResponse({ approvalId: 'ap1', approved: false });
    });
    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot.gate?.approvalResponses).toEqual([{ approvalId: 'ap1', approved: false }]);

    const restored = restore(snapshot);
    await act(async () => {
      await restored.result.current.addToolApprovalResponse({ approvalId: 'ap2', approved: true });
    });
    await waitFor(() => expect(restored.result.current.status).toBe('idle'));
    expect(restored.bodies[0]!.approvalResponses as Verdict[]).toEqual([
      { approvalId: 'ap1', approved: false },
      { approvalId: 'ap2', approved: true },
    ]);
  });

  it('keeps parked client calls and the results already given; the last one resumes the chat', async () => {
    const live = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: recordingFetch(() =>
          postResponse([
            parts.start('m-1'),
            parts.toolCall('c1', 'pick', { what: 'file' }),
            parts.toolCall('c2', 'pick', { what: 'dir' }),
            parts.finish(),
          ]),
        ).fetch,
      }),
    );
    await act(async () => {
      await live.result.current.sendMessage('choose');
    });
    await waitFor(() => expect(live.result.current.pendingToolCalls).toHaveLength(2));
    await act(async () => {
      await live.result.current.addToolResult({ toolCallId: 'c1', output: 'a.txt' });
    });
    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot.pendingToolCalls?.map((call) => call.toolCallId)).toEqual(['c1', 'c2']);
    expect(snapshot.gate?.toolResults).toEqual([{ toolCallId: 'c1', output: 'a.txt' }]);
    expect(snapshot.gate?.turn?.message.id).toBe('m-1');

    const restored = restore(snapshot);
    expect(restored.result.current.pendingToolCalls).toEqual(snapshot.pendingToolCalls);
    await act(async () => {
      await restored.result.current.addToolResult({ toolCallId: 'c2', output: '/tmp' });
    });
    await waitFor(() => expect(restored.result.current.status).toBe('idle'));
    // The answers fold into the restored bubble, which keeps its id.
    const bubble = restored.result.current.messages.find((m) => m.id === 'm-1');
    expect(bubble?.toolCalls?.map((call) => [call.toolCallId, call.state, call.output])).toEqual([
      ['c1', 'result', 'a.txt'],
      ['c2', 'result', '/tmp'],
    ]);
    expect(restored.bodies).toHaveLength(1);
    expect(restored.bodies[0]!.messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: 'c1', result: 'a.txt' },
        { type: 'tool_result', toolUseId: 'c2', result: '/tmp' },
      ],
    });
    expect(restored.result.current.pendingToolCalls).toEqual([]);
  });

  it('keeps a native run gate: the run id, its verdicts and its client calls ride the resume', async () => {
    const approval = {
      approvalId: 'ap1',
      toolCallId: 'd1',
      toolName: 'del',
      input: { path: '/a' },
    };
    const agentFrame = (payload: Record<string, unknown>) =>
      ({ type: 'data-agent', id: String(payload.kind), payload }) as unknown as DeuzUIPart;
    const live = renderHook(() =>
      useChat({
        api: '/api/agent',
        fetch: recordingFetch(() =>
          postResponse([
            parts.start('m-1'),
            agentFrame({ kind: 'run', seq: 1, runId: 'run-1', status: 'running' }),
            parts.toolCall('d1', 'del', { path: '/a' }),
            parts.approval('ap1', 'd1', 'del', { path: '/a' }),
            parts.toolCall('c1', 'pick', { what: 'file' }),
            parts.finish(),
            agentFrame({
              kind: 'result',
              seq: 6,
              runId: 'run-1',
              status: 'suspended',
              pendingApprovals: [approval],
              pendingClientCalls: [{ toolCallId: 'c1', toolName: 'pick', input: { what: 'file' } }],
            }),
          ]),
        ).fetch,
      }),
    );
    await act(async () => {
      await live.result.current.sendMessage('go');
    });
    await waitFor(() => expect(live.result.current.pendingApprovals).toHaveLength(1));
    const gated = live.result.current.exportSnapshot();
    expect(gated.gate).toMatchObject({ runId: 'run-1', clientCalls: [{ toolCallId: 'c1' }] });

    // First remount: the verdict lands; the run's client call parks (no onToolCall).
    const first = restore(gated);
    await act(async () => {
      await first.result.current.addToolApprovalResponse({ approvalId: 'ap1', approved: true });
    });
    await waitFor(() => expect(first.result.current.pendingToolCalls).toHaveLength(1));
    expect(first.bodies).toHaveLength(0);
    const parked = first.result.current.exportSnapshot();
    expect(parked.gate).toMatchObject({
      runId: 'run-1',
      approvalResponses: [{ approvalId: 'ap1', approved: true }],
    });

    // Second remount: the result resumes the run, with the verdict, in one request.
    const second = restore(parked);
    await act(async () => {
      await second.result.current.addToolResult({ toolCallId: 'c1', output: 'a.txt' });
    });
    await waitFor(() => expect(second.result.current.status).toBe('idle'));
    expect(second.bodies).toHaveLength(1);
    expect(second.bodies[0]).toMatchObject({
      runId: 'run-1',
      approvalResponses: [{ approvalId: 'ap1', approved: true }],
      clientToolResults: [{ toolCallId: 'c1', output: 'a.txt' }],
    });
  });
});

/**
 * A route without a `messageId` names every response 'deuz-msg'
 * (`toDeuzStreamResponse`'s default), so a stored history repeats that id.
 * Restoring keeps it on the FIRST message and gives the later ones fresh ids,
 * while the gate's turn still carries the stored id: its answers must fold
 * into its own bubble, never into the earlier one that kept the id.
 */
describe('useChat({ initialSnapshot }) — a gate under a repeated message id', () => {
  it('folds a restored parked call’s result into its own bubble, not the earlier one', async () => {
    const first = recordingFetch((round) =>
      round === 1
        ? postResponse([parts.start('deuz-msg'), parts.text('first answer'), parts.finish()])
        : postResponse([
            parts.start('deuz-msg'),
            parts.toolCall('c1', 'pick', { what: 'file' }),
            parts.finish(),
          ]),
    );
    const live = renderHook(() => useChat({ api: '/api/chat', fetch: first.fetch }));
    await act(async () => {
      await live.result.current.sendMessage('q1');
    });
    await act(async () => {
      await live.result.current.sendMessage('q2');
    });
    await waitFor(() => expect(live.result.current.pendingToolCalls).toHaveLength(1));
    const snapshot = live.result.current.exportSnapshot();
    expect(snapshot.messageIds?.[1]).toBe('deuz-msg');
    expect(snapshot.messageIds?.[3]).toBe('deuz-msg');
    expect(snapshot.gate?.turn?.message.id).toBe('deuz-msg');

    const wire = recordingFetch(() =>
      postResponse([parts.start('deuz-msg'), parts.text('done'), parts.finish()]),
    );
    const restored = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: wire.fetch,
        initialSnapshot: JSON.parse(JSON.stringify(snapshot)) as ChatSnapshotV1,
      }),
    );
    const parkedId = restored.result.current.messages[3]!.id;
    expect(parkedId).not.toBe('deuz-msg');
    // The gate a restored chat exports names the bubble it folds into.
    expect(restored.result.current.exportSnapshot().gate?.turn?.message.id).toBe(parkedId);

    await act(async () => {
      await restored.result.current.addToolResult({ toolCallId: 'c1', output: 'a.txt' });
    });
    await waitFor(() => expect(restored.result.current.status).toBe('idle'));
    const view = restored.result.current.messages;
    expect(view.map((m) => [m.id, m.content, m.toolCalls?.map((call) => call.state)])).toEqual([
      [snapshot.messageIds![0], 'q1', undefined],
      ['deuz-msg', 'first answer', undefined],
      [snapshot.messageIds![2], 'q2', undefined],
      [parkedId, '', ['result']],
      ['deuz-msg', 'done', undefined],
    ]);
    expect(wire.bodies).toHaveLength(1);
    expect(wire.bodies[0]!.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'c1', result: 'a.txt' }],
    });
  });

  it('folds a restored native gate’s client results into its own bubble', async () => {
    const approval = {
      approvalId: 'ap1',
      toolCallId: 'd1',
      toolName: 'del',
      input: { path: '/a' },
    };
    const agentFrame = (payload: Record<string, unknown>) =>
      ({ type: 'data-agent', id: String(payload.kind), payload }) as unknown as DeuzUIPart;
    const first = recordingFetch((round) =>
      round === 1
        ? postResponse([parts.start('deuz-msg'), parts.text('first answer'), parts.finish()])
        : postResponse([
            parts.start('deuz-msg'),
            agentFrame({ kind: 'run', seq: 1, runId: 'run-1', status: 'running' }),
            parts.toolCall('d1', 'del', { path: '/a' }),
            parts.approval('ap1', 'd1', 'del', { path: '/a' }),
            parts.toolCall('c1', 'pick', { what: 'file' }),
            parts.finish(),
            agentFrame({
              kind: 'result',
              seq: 6,
              runId: 'run-1',
              status: 'suspended',
              pendingApprovals: [approval],
              pendingClientCalls: [{ toolCallId: 'c1', toolName: 'pick', input: { what: 'file' } }],
            }),
          ]),
    );
    const live = renderHook(() => useChat({ api: '/api/agent', fetch: first.fetch }));
    await act(async () => {
      await live.result.current.sendMessage('q1');
    });
    await act(async () => {
      await live.result.current.sendMessage('go');
    });
    await waitFor(() => expect(live.result.current.pendingApprovals).toHaveLength(1));
    const gated = live.result.current.exportSnapshot();
    expect(gated.gate?.turn?.message.id).toBe('deuz-msg');

    // The verdict lands on a restored chat whose onToolCall answers the client call.
    const wire = recordingFetch(() =>
      postResponse([parts.start('deuz-msg'), parts.text('done'), parts.finish()]),
    );
    const restored = renderHook(() =>
      useChat({
        api: '/api/agent',
        fetch: wire.fetch,
        onToolCall: () => 'a.txt',
        initialSnapshot: JSON.parse(JSON.stringify(gated)) as ChatSnapshotV1,
      }),
    );
    const gateId = restored.result.current.messages[3]!.id;
    expect(gateId).not.toBe('deuz-msg');
    await act(async () => {
      await restored.result.current.addToolApprovalResponse({ approvalId: 'ap1', approved: true });
    });
    await waitFor(() => expect(restored.result.current.status).toBe('idle'));
    const view = restored.result.current.messages;
    expect(view[1]).toMatchObject({ id: 'deuz-msg', content: 'first answer' });
    expect(view[1]!.toolCalls).toBeUndefined();
    expect(view[3]!.id).toBe(gateId);
    expect(view[3]!.toolCalls?.find((call) => call.toolCallId === 'c1')?.state).toBe('result');
    expect(view).toHaveLength(5);
    expect(wire.bodies[0]).toMatchObject({
      runId: 'run-1',
      clientToolResults: [{ toolCallId: 'c1', output: 'a.txt' }],
    });
  });
});
