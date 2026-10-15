/**
 * `ChatSnapshotV1` (2.4, spec §3.4): `useChat({ initialSnapshot })` restores a
 * chat and `exportSnapshot()` captures one. The history half mirrors
 * `ChatRecord` (`messages` plus `messageIds` aligned with them), so a stored
 * record restores under the ids the server gave it (H7), and two messages
 * with the same text stay two messages: ids, never text, tell them apart.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Message } from '@deuz-sdk/core';
import { useChat } from '../src/use-chat';
import type { ChatSnapshotV1 } from '../src/index';
import { parts, postResponse, recordingFetch } from './wire';

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
