/**
 * F06 (2.3): an approval verdict only resumes the chat when it answers the gate
 * the chat is ACTUALLY paused on. Before 2.3, `addToolApprovalResponse` checked
 * `approvalsRef.current.every(...)` — `true` for an EMPTY array — so a verdict
 * with nothing pending, a double click, a stale card or another run's verdict
 * each sent a fresh POST and rendered an empty assistant bubble, and a foreign
 * verdict recorded while a gate was open rode along in its `approvalResponses`.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChat } from '../src/use-chat';
import { parts, postResponse, recordingFetch } from './wire';

interface GatedCall {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input?: unknown;
  token?: string;
}

/** Round 1 pauses on approvals for `calls`; every later round answers 'Done.'. */
function gatedRoute(calls: GatedCall[]) {
  return recordingFetch((round) =>
    round === 1
      ? postResponse([
          parts.start('srv-1'),
          ...calls.map((c) => parts.toolCall(c.toolCallId, c.toolName, c.input)),
          ...calls.map((c) =>
            parts.approval(c.approvalId, c.toolCallId, c.toolName, c.input, c.token),
          ),
          parts.finish(),
        ])
      : postResponse([parts.start(`srv-${round}`), parts.text('Done.'), parts.finish()]),
  );
}

const assistantCount = (messages: Array<{ role: string }>): number =>
  messages.filter((m) => m.role === 'assistant').length;

describe('useChat — approval verdicts are matched to the open gate (F06)', () => {
  it('a verdict with NOTHING pending is a no-op: no POST, no empty assistant bubble', async () => {
    const route = recordingFetch(() =>
      postResponse([parts.start('srv-1'), parts.text('hi'), parts.finish()]),
    );
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));

    // A fresh hook: no turn has ever paused.
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'ghost', approved: true });
    });
    expect(route.bodies).toHaveLength(0);
    expect(result.current.messages).toEqual([]);
    expect(result.current.history.canonical).toEqual([]);

    // A completed turn without approvals: still nothing to answer.
    await act(async () => {
      await result.current.sendMessage('hello');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'ghost', approved: true });
    });
    expect(route.bodies).toHaveLength(1);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.history.canonical).toHaveLength(2);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('a consumed verdict is idempotent: a double click resumes ONCE, a later repeat never', async () => {
    const route = gatedRoute([
      { approvalId: 'a1', toolCallId: 't1', toolName: 'del', input: { p: '/x' }, token: 'tok-1' },
    ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('delete /x');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    // Two clicks in the same tick — the second lands while the first's
    // continuation is already in flight.
    await act(async () => {
      const verdict = { approvalId: 'a1', approved: true };
      await Promise.all([
        result.current.addToolApprovalResponse(verdict),
        result.current.addToolApprovalResponse(verdict),
      ]);
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]!.approvalResponses).toEqual([
      { approvalId: 'a1', approved: true, token: 'tok-1' },
    ]);

    // The same verdict after the chat moved on: still nothing.
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    expect(route.bodies).toHaveLength(2);
    expect(assistantCount(result.current.messages)).toBe(2);
    expect(result.current.messages.at(-1)?.content).toBe('Done.');
  });

  it('a stale verdict for an EARLIER gate neither resumes nor rides along with the current one', async () => {
    // Round 1 pauses on a1; the continuation pauses again on a NEW approval a2.
    const route = recordingFetch((round) =>
      round === 1
        ? postResponse([
            parts.toolCall('t1', 'del', { p: '/x' }),
            parts.approval('a1', 't1', 'del', { p: '/x' }),
            parts.finish(),
          ])
        : round === 2
          ? postResponse([
              parts.toolCall('t2', 'del', { p: '/y' }),
              parts.approval('a2', 't2', 'del', { p: '/y' }),
              parts.finish(),
            ])
          : postResponse([parts.text('Both gone.'), parts.finish()]),
    );
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('delete /x then /y');
    });
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    await waitFor(() =>
      expect(result.current.pendingApprovals.map((a) => a.approvalId)).toEqual(['a2']),
    );
    expect(route.bodies).toHaveLength(2);

    // A card left over from the first gate.
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: false });
    });
    expect(route.bodies).toHaveLength(2);
    expect(result.current.pendingApprovals.map((a) => a.approvalId)).toEqual(['a2']);

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a2', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(3);
    // ONLY the open gate's verdict — the stale a1 never reaches the server.
    expect(route.bodies[2]!.approvalResponses).toEqual([{ approvalId: 'a2', approved: true }]);
  });

  it('a verdict for an approval that is not in the gate is ignored and never POSTed', async () => {
    const route = gatedRoute([{ approvalId: 'a1', toolCallId: 't1', toolName: 'del' }]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'zzz', approved: true });
    });
    expect(route.bodies).toHaveLength(1);
    expect(result.current.pendingApprovals).toHaveLength(1);

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]!.approvalResponses).toEqual([{ approvalId: 'a1', approved: true }]);
  });

  it("another run's verdict (a different signed token) is a no-op; the request's own token resumes", async () => {
    // Same approvalId, minted by a DIFFERENT run: providers that number their
    // calls (`tool_0`, …) recycle ids, so only the run-bound token tells them apart.
    const route = gatedRoute([
      { approvalId: 'tool_0', toolCallId: 'tool_0', toolName: 'del', token: 'tok-run-B' },
    ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: 'tool_0',
        approved: true,
        token: 'tok-run-A',
      });
    });
    expect(route.bodies).toHaveLength(1);
    expect(result.current.pendingApprovals).toHaveLength(1);

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'tool_0', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]!.approvalResponses).toEqual([
      { approvalId: 'tool_0', approved: true, token: 'tok-run-B' },
    ]);
  });

  it('a stale card for a RECYCLED approval id answers nothing when it echoes its own token', async () => {
    // Both gates pause on `tool_0` (an OpenAI-compatible server that omits call
    // ids), so only the token minted for each request tells the two apart.
    const route = recordingFetch((round) => {
      if (round > 2) return postResponse([parts.text('Both gone.'), parts.finish()]);
      const input = { p: round === 1 ? '/x' : '/y' };
      return postResponse([
        parts.toolCall('tool_0', 'del', input),
        parts.approval('tool_0', 'tool_0', 'del', input, `tok-${round}`),
        parts.finish(),
      ]);
    });
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('delete /x then /y');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    const first = result.current.pendingApprovals[0]!; // what a stale card's closure keeps

    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: first.approvalId,
        approved: true,
        token: first.token,
      });
    });
    await waitFor(() =>
      expect(result.current.pendingApprovals.map((a) => a.token)).toEqual(['tok-2']),
    );
    expect(route.bodies).toHaveLength(2);

    // The first card answers again: the same id, but the first request's token.
    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: first.approvalId,
        approved: false,
        token: first.token,
      });
    });
    expect(route.bodies).toHaveLength(2);
    expect(result.current.pendingApprovals.map((a) => a.token)).toEqual(['tok-2']);

    const second = result.current.pendingApprovals[0]!;
    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: second.approvalId,
        approved: true,
        token: second.token,
      });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(3);
    expect(route.bodies[2]!.approvalResponses).toEqual([
      { approvalId: 'tool_0', approved: true, token: 'tok-2' },
    ]);
  });

  it('a gate replaced by setHistory takes its approvals with it: a late verdict is a no-op', async () => {
    const route = gatedRoute([{ approvalId: 'a1', toolCallId: 't1', toolName: 'del' }]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    act(() => {
      result.current.setHistory({ ui: [], canonical: [] }); // switch chats
    });
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    expect(route.bodies).toHaveLength(1);
    expect(result.current.messages).toEqual([]);
    expect(result.current.history.canonical).toEqual([]);
  });

  it('multi-approval resumes only once EVERY approval has a verdict; denials and reasons survive', async () => {
    const route = gatedRoute([
      { approvalId: 'a1', toolCallId: 't1', toolName: 'rm', input: { p: '/a' }, token: 'tok-a' },
      { approvalId: 'a2', toolCallId: 't2', toolName: 'rm', input: { p: '/b' }, token: 'tok-b' },
    ]);
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('clean up');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(2));

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    expect(route.bodies).toHaveLength(1); // a2 still open — the chat stays paused
    expect(result.current.pendingApprovals).toHaveLength(2);

    // Changing your mind before the gate completes REPLACES the earlier verdict.
    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: 'a1',
        approved: false,
        reason: 'changed my mind',
      });
    });
    expect(route.bodies).toHaveLength(1);

    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: 'a2',
        approved: false,
        reason: 'too risky',
      });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]!.approvalResponses).toEqual([
      { approvalId: 'a1', approved: false, reason: 'changed my mind', token: 'tok-a' },
      { approvalId: 'a2', approved: false, reason: 'too risky', token: 'tok-b' },
    ]);
    expect(result.current.pendingApprovals).toEqual([]);
  });

  it('a repeated approval frame is ONE pending approval, answered by one verdict', async () => {
    const request = parts.approval('a1', 't1', 'del', { p: '/x' }, 'tok-1');
    const route = recordingFetch((round) =>
      round === 1
        ? postResponse([parts.toolCall('t1', 'del', { p: '/x' }), request, request, parts.finish()])
        : postResponse([parts.text('Deleted.'), parts.finish()]),
    );
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('delete /x');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'a1', approved: true });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]!.approvalResponses).toEqual([
      { approvalId: 'a1', approved: true, token: 'tok-1' },
    ]);
  });
});
