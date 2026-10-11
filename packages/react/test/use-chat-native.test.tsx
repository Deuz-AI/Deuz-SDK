/**
 * useChat against a native agent route (2.3, roadmap 23.5).
 *
 * The route is real core: `streamAgent` / `resumeStreamAgent` with a native
 * session, serialized by `toDeuzAgentStreamResponse` and journaled to a
 * `StreamStateStore`, with `resumeDeuzStreamResponse` as the resume endpoint.
 * A native run continues through `resumeStreamAgent`, which needs the run id
 * and, in ONE request, a verdict for every pending approval and a result for
 * every pending client call. The hook reads both pending sets from the run's
 * terminal frame and sends them back with `runId`. Offline: the mock model.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Message, StopDetails } from '@deuz-sdk/core';
import {
  createInMemoryAgentRunStore,
  resumeStreamAgent,
  streamAgent,
  type AgentToolSet,
} from '@deuz-sdk/core/agent';
import { createMockModel, type MockResponse } from '@deuz-sdk/core/testing';
import {
  createInMemoryStreamStateStore,
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
} from '@deuz-sdk/core/ui';
import type { DeuzAgentState, DeuzUIPart } from '@deuz-sdk/core/ui';
import { useChat } from '../src/use-chat';
import type { UseChatAgent, UseChatResult, UseChatStopDetails } from '../src/use-chat';
import { journal, parts, postResponse, recordingFetch, stallingResponse } from './wire';

const parameters = { type: 'object' as const, properties: {} };

type Body = {
  messages: Message[];
  runId?: string;
  approvalResponses?: Array<Record<string, unknown>>;
  clientToolResults?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/**
 * A native agent route plus its GET resume endpoint, as an app wires them:
 * a body without `runId` starts a run, a body with one resumes it.
 */
function nativeRoute(
  responses: MockResponse[],
  tools: AgentToolSet,
  extra: Record<string, unknown> = {},
) {
  const model = createMockModel({ responses });
  const runs = createInMemoryAgentRunStore();
  const streams = createInMemoryStreamStateStore();
  const bodies: Body[] = [];
  const resumes: Array<string | undefined> = [];
  let started = 0;
  /** Drop the POST response after this many SSE events (the server keeps running). */
  let dropAfter: number | undefined;
  let lastRunId: string | undefined;
  const fetchMock: typeof fetch = async (url, init) => {
    if (String(url) === '/api/resume') {
      const lastEventId = new Headers(init?.headers).get('last-event-id');
      resumes.push(lastEventId ?? undefined);
      return resumeDeuzStreamResponse(streams, lastRunId!, {
        lastEventId,
        pollIntervalMs: 5,
        idleTimeoutMs: 2000,
      });
    }
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    const runId = body.runId ?? `run-${++started}`;
    lastRunId = runId;
    const base = { model, tools, session: { store: runs, runId, scope: 'tenant' }, ...extra };
    const stream = body.runId
      ? resumeStreamAgent({
          ...base,
          ...(body.approvalResponses ? { approvalResponses: body.approvalResponses as never } : {}),
          ...(body.clientToolResults ? { clientToolResults: body.clientToolResults as never } : {}),
        })
      : streamAgent({ ...base, messages: body.messages });
    const response = toDeuzAgentStreamResponse(stream, {
      runId,
      store: streams,
      streamId: runId,
      messageId: `msg-${bodies.length}`,
    });
    if (dropAfter === undefined) return response;
    const limit = dropAfter;
    dropAfter = undefined;
    return dropping(response, limit);
  };
  return {
    fetch: fetchMock,
    bodies,
    resumes,
    runs,
    dropNextAfter: (events: number) => {
      dropAfter = events;
    },
  };
}

/** Pass `events` SSE events of `response` through, then fail the body like a lost connection. */
function dropping(response: Response, events: number): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === events) {
          // The client read everything it got; the next read fails.
          controller.error(new TypeError('network connection lost'));
          return;
        }
        while (!buffered.includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) return controller.close();
          buffered += decoder.decode(value);
        }
        const end = buffered.indexOf('\n\n') + 2;
        controller.enqueue(encoder.encode(buffered.slice(0, end)));
        buffered = buffered.slice(end);
        // At the limit the client is gone: the server keeps draining into its journal.
        if (++sent === events) void reader.cancel();
      },
    }),
    { headers: response.headers },
  );
}

const publishTools = (execute = vi.fn(() => 'published')): AgentToolSet => ({
  publish: { description: 'Publish.', parameters, needsApproval: true, execute },
});

describe('useChat — a native agent route (2.3)', () => {
  it('pauses on the run’s approval and resumes it with runId and the verdict', async () => {
    const execute = vi.fn(() => 'published');
    const route = nativeRoute(
      [
        { toolCalls: [{ toolName: 'publish', id: 'p1', args: { doc: 7 } }] },
        { text: 'Published.' },
      ],
      publishTools(execute),
    );
    const { result } = renderHook(() => useChat({ api: '/api/agent', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('publish doc 7');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(result.current.agent).toMatchObject({ status: 'suspended', runId: 'run-1' });
    expect(route.bodies[0]).not.toHaveProperty('runId');
    const request = result.current.pendingApprovals[0]!;
    expect(request).toMatchObject({ toolCallId: 'p1', toolName: 'publish', input: { doc: 7 } });

    await act(async () => {
      await result.current.addToolApprovalResponse({
        approvalId: request.approvalId,
        approved: true,
      });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]).toMatchObject({
      runId: 'run-1',
      approvalResponses: [{ approvalId: request.approvalId, approved: true }],
    });
    expect(route.bodies[1]).not.toHaveProperty('clientToolResults');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.agent).toMatchObject({
      status: 'completed',
      runId: 'run-1',
      output: 'Published.',
    });
    expect(result.current.messages.at(-1)?.content).toBe('Published.');
  });

  it('answers a client tool through onToolCall and resumes with clientToolResults', async () => {
    const route = nativeRoute(
      [
        { toolCalls: [{ toolName: 'locate', id: 'c1', args: { q: 'me' } }] },
        { text: 'You are home.' },
      ],
      { locate: { description: 'Where am I?', parameters } },
    );
    const onToolCall = vi.fn(async () => ({ city: 'Paris' }));
    const { result } = renderHook(() =>
      useChat({ api: '/api/agent', fetch: route.fetch, onToolCall }),
    );
    await act(async () => {
      await result.current.sendMessage('where am i?');
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      toolCallId: 'c1',
      toolName: 'locate',
      input: { q: 'me' },
    });
    expect(route.bodies[1]).toMatchObject({
      runId: 'run-1',
      clientToolResults: [{ toolCallId: 'c1', output: { city: 'Paris' } }],
    });
    // The canonical history still records the answer, as on a chat route.
    expect(route.bodies[1]!.messages.at(-1)).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'c1', result: { city: 'Paris' } }],
    });
    expect(result.current.messages.at(-1)?.content).toBe('You are home.');
  });

  it('parks a client call without onToolCall; addToolResult resumes the run', async () => {
    const route = nativeRoute(
      [{ toolCalls: [{ toolName: 'sign', id: 's1', args: { eth: 1 } }] }, { text: 'Signed.' }],
      { sign: { description: 'Sign.', parameters } },
    );
    const { result } = renderHook(() => useChat({ api: '/api/agent', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('sign it');
    });
    await waitFor(() => expect(result.current.pendingToolCalls).toHaveLength(1));
    expect(result.current.pendingToolCalls[0]).toMatchObject({
      toolCallId: 's1',
      input: { eth: 1 },
    });
    await act(async () => {
      await result.current.addToolResult({ toolCallId: 's1', output: '0xabc' });
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    expect(route.bodies[1]).toMatchObject({
      runId: 'run-1',
      clientToolResults: [{ toolCallId: 's1', output: '0xabc' }],
    });
    expect(result.current.pendingToolCalls).toEqual([]);
  });

  it('sends the verdicts and the client results of one suspension together', async () => {
    const route = nativeRoute(
      [
        {
          toolCalls: [
            { toolName: 'publish', id: 'p1', args: {} },
            { toolName: 'locate', id: 'c1', args: {} },
          ],
        },
        { text: 'Both done.' },
      ],
      { ...publishTools(), locate: { description: 'Where?', parameters } },
    );
    const onToolCall = vi.fn(async () => 'Paris');
    const { result } = renderHook(() =>
      useChat({ api: '/api/agent', fetch: route.fetch, onToolCall }),
    );
    await act(async () => {
      await result.current.sendMessage('go');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(onToolCall).not.toHaveBeenCalled(); // the approval gate comes first
    const { approvalId } = result.current.pendingApprovals[0]!;
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId, approved: true });
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(route.bodies).toHaveLength(2);
    expect(route.bodies[1]).toMatchObject({
      runId: 'run-1',
      approvalResponses: [{ approvalId, approved: true }],
      clientToolResults: [{ toolCallId: 'c1', output: 'Paris' }],
    });
    expect(result.current.messages.at(-1)?.content).toBe('Both done.');
  });

  it('F06 on the native path: a verdict with nothing pending, or twice, resumes nothing', async () => {
    const route = nativeRoute(
      [{ toolCalls: [{ toolName: 'publish', id: 'p1', args: {} }] }, { text: 'Published.' }],
      publishTools(),
    );
    const { result } = renderHook(() => useChat({ api: '/api/agent', fetch: route.fetch }));
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId: 'p1', approved: true });
    });
    expect(route.bodies).toHaveLength(0);
    await act(async () => {
      await result.current.sendMessage('publish');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    const { approvalId } = result.current.pendingApprovals[0]!;
    await act(async () => {
      await Promise.all([
        result.current.addToolApprovalResponse({ approvalId, approved: true }),
        result.current.addToolApprovalResponse({ approvalId, approved: true }),
      ]);
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId, approved: true });
    });
    expect(route.bodies).toHaveLength(2);
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('native stream → disconnect → reconnect → approval → terminal output', async () => {
    const route = nativeRoute(
      [{ toolCalls: [{ toolName: 'publish', id: 'p1', args: {} }] }, { text: 'Live.' }],
      publishTools(),
    );
    route.dropNextAfter(3); // start, the run frame, one more — then the connection is gone
    const { result } = renderHook(() =>
      useChat({ api: '/api/agent', fetch: route.fetch, resume: { endpoint: '/api/resume' } }),
    );
    await act(async () => {
      await result.current.sendMessage('ship it');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.agent).toMatchObject({ status: 'running', runId: 'run-1' });
    // The run finished on the server; the reconnect reads the rest of the leg.
    await waitFor(async () => expect((await route.runs.load('run-1'))?.result).toBeDefined());
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(route.resumes).toEqual(['2']); // after the last event the POST read delivered
    expect(result.current.agent?.status).toBe('suspended');
    const { approvalId } = result.current.pendingApprovals[0]!;
    await act(async () => {
      await result.current.addToolApprovalResponse({ approvalId, approved: true });
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    expect(route.bodies.at(-1)).toMatchObject({ runId: 'run-1' });
    expect(result.current.agent).toMatchObject({ output: 'Live.' });
    expect(result.current.error).toBeUndefined();
  });

  it('F07 on the native path: a reconnected client call runs once', async () => {
    const route = nativeRoute(
      [{ toolCalls: [{ toolName: 'locate', id: 'c1', args: {} }] }, { text: 'Found.' }],
      { locate: { description: 'Where?', parameters } },
    );
    route.dropNextAfter(2);
    const onToolCall = vi.fn(async () => 'Paris');
    const { result } = renderHook(() =>
      useChat({
        api: '/api/agent',
        fetch: route.fetch,
        onToolCall,
        resume: { endpoint: '/api/resume' },
      }),
    );
    await act(async () => {
      await result.current.sendMessage('where?');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(onToolCall).not.toHaveBeenCalled();
    await waitFor(async () => expect((await route.runs.load('run-1'))?.result).toBeDefined());
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    // A second reconnect is caught up: nothing runs or is appended again.
    const history = result.current.history.canonical;
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(result.current.history.canonical).toEqual(history);
  });

  it('keeps the agent frames out of onData and dataParts', async () => {
    const route = nativeRoute([{ text: 'Hi.' }], {});
    const onData = vi.fn();
    const { result } = renderHook(() => useChat({ api: '/api/agent', fetch: route.fetch, onData }));
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    expect(onData).not.toHaveBeenCalled();
    expect(result.current.dataParts).toEqual([]);
    expect(result.current.messages.at(-1)?.parts?.some((p) => p.type === 'data')).toBe(false);
  });

  it('shows the typed final output, never a draft as the output', async () => {
    const route = nativeRoute(
      [{ text: '{"answer": 42}' }],
      {},
      {
        output: {
          mode: 'json',
          schema: { type: 'object', properties: { answer: { type: 'number' } } },
          validate: (value: unknown) => value as { answer: number },
        },
      },
    );
    const { result } = renderHook(() => useChat({ api: '/api/agent', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('answer?');
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('completed'));
    const agent = result.current.agent!;
    expect(agent).toMatchObject({ status: 'completed', output: { answer: 42 } });
    expect(agent).not.toHaveProperty('partial');
  });

  it('stop() during a native stream settles nothing and is not an error', async () => {
    const posts: unknown[] = [];
    // A run that is still streaming: the response stalls until the request is aborted.
    const fetchMock: typeof fetch = async (_url, init) => {
      posts.push(init?.body);
      return stallingResponse(
        [
          { id: 0, data: JSON.stringify(parts.start('msg-1')) },
          {
            id: 1,
            data: JSON.stringify({
              type: 'data-agent',
              id: 'run',
              payload: { kind: 'run', seq: 1, runId: 'run-1', status: 'running' },
            }),
          },
          { id: 2, data: JSON.stringify(parts.text('Thinking about')) },
        ],
        init?.signal,
      );
    };
    const { result } = renderHook(() => useChat({ api: '/api/agent', fetch: fetchMock }));
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.sendMessage('talk');
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Thinking about'));
    expect(result.current.agent).toMatchObject({ status: 'running', runId: 'run-1' });
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await sending;
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
    expect(posts).toHaveLength(1);
    // Nothing settled: the stopped turn did not join the canonical history.
    expect(result.current.history.canonical.map((m) => m.role)).toEqual(['user']);
    expect(result.current.messages.at(-1)?.parts?.[0]).toMatchObject({ state: 'done' });
  });
});

describe('useChat — a chat route is unchanged (2.3)', () => {
  it('sends no native fields, and keeps no agent state', async () => {
    const route = recordingFetch((round) =>
      round === 1
        ? postResponse([
            parts.toolCall('t1', 'del', { p: '/x' }),
            parts.approval('a1', 't1', 'del', { p: '/x' }),
            parts.finish(),
          ])
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
    expect(Object.keys(route.bodies[0]!)).toEqual(['messages']);
    expect(Object.keys(route.bodies[1]!)).toEqual(['messages', 'approvalResponses']);
    expect(result.current.agent).toBeUndefined();
  });

  it('shows a refusal’s stopDetails and each tool call’s outcome', async () => {
    const refusal = { type: 'refusal', category: 'cyber', explanation: 'Not that.' };
    const route = recordingFetch(() =>
      postResponse([
        parts.toolCall('t1', 'scan', {}),
        {
          type: 'tool-state',
          toolCallId: 't1',
          toolName: 'scan',
          state: 'error',
          denied: true,
          outcome: 'permission-denied',
        },
        { type: 'text-delta', text: 'I can’t help with that.' },
        { ...parts.finish(), finishReason: 'content_filter', stopDetails: refusal } as DeuzUIPart,
      ]),
    );
    const { result } = renderHook(() => useChat({ api: '/api/chat', fetch: route.fetch }));
    await act(async () => {
      await result.current.sendMessage('scan it');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.finishReason).toBe('content_filter');
    expect(result.current.stopDetails).toEqual(refusal);
    expect(result.current.messages.at(-1)?.toolCalls?.[0]).toMatchObject({
      toolCallId: 't1',
      denied: true,
      outcome: 'permission-denied',
    });
  });
});

describe('useChat — reconnect never re-appends what the hook holds (G1 hand-off)', () => {
  it('a reconnect after a settled POST leg is caught up, not a second turn', async () => {
    const wire = journal();
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: async () =>
          wire.respond([parts.start('srv-1'), parts.text('Hello.'), parts.finish()]),
        resume: { endpoint: wire.endpoint },
      }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    const settled = result.current.history;
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // The POST read carried the journal's ids, so the reconnect resumes after them.
    expect(wire.cursors).toEqual(['2']);
    expect(result.current.history).toEqual(settled);
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('a reconnect after a POST-continued leg does not append the continuation again', async () => {
    const wire = journal();
    await wire.leg([parts.toolCall('c1', 'geo', {}), parts.finish()]); // seq 0, 1 (+ done 2)
    const { result } = renderHook(() =>
      useChat({
        api: '/api/chat',
        fetch: async () => wire.respond([parts.text('Paris.'), parts.finish()]), // seq 3, 4
        onToolCall: async () => ({ lat: 48.85 }),
        resume: { endpoint: wire.endpoint },
        initialMessages: [{ role: 'user', content: 'where am i?' }],
      }),
    );
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Paris.'));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    const settled = result.current.history;
    await act(async () => {
      await result.current.reconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(wire.cursors).toEqual([undefined, '4']);
    expect(result.current.history).toEqual(settled);
    expect(result.current.history.canonical.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });
});

describe('useChat — native readout types', () => {
  it('derives UseChatAgent and UseChatStopDetails from the installed core', () => {
    expectTypeOf<UseChatAgent>().toEqualTypeOf<DeuzAgentState>();
    expectTypeOf<UseChatStopDetails>().toEqualTypeOf<StopDetails>();
    expectTypeOf<UseChatResult['agent']>().toEqualTypeOf<DeuzAgentState | undefined>();
    // Only a completed run has an output.
    expectTypeOf<Extract<DeuzAgentState, { status: 'running' }>>().not.toHaveProperty('output');
  });
});
