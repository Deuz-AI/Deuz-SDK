/**
 * The capability handshake, client side (2.4, spec §3.4 and §4.5). The hook
 * lists what it understands in an `x-deuz-capabilities` request header; a
 * 2.4 route that takes part answers with the same response header and a
 * first `capabilities` frame; a 2.3 route answers neither, and the hook
 * behaves exactly as 2.3 did.
 *
 * The routes are real core: `streamChat` on the mock model, serialized by
 * `toDeuzStreamResponse` and journaled to an in-memory `StreamStateStore`,
 * with `resumeDeuzStreamResponse` as the resume endpoint. A "2.3 route" is
 * one that passes no `capabilities` option, whose stream is byte for byte
 * what 2.3 sent.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { streamChat } from '@deuz-sdk/core';
import type { Message } from '@deuz-sdk/core';
import { createMockModel } from '@deuz-sdk/core/testing';
import {
  createInMemoryStreamStateStore,
  resumeDeuzStreamResponse,
  toDeuzStreamResponse,
} from '@deuz-sdk/core/ui';
import { useChat } from '../src/use-chat';
import type { UseChatOptions } from '../src/use-chat';

const HEADER = 'x-deuz-capabilities';
const ADVERTISED = 'chat-snapshot-v1, durable-stream, message-ids';

interface RouteOptions {
  /** What the route announces; absent: a 2.3 route (no `capabilities` option). */
  announce?: string[];
  /** Strip the response header, like a cross-origin response that does not expose it. */
  hideHeader?: boolean;
  /** The model's answers, one per POST. */
  answers?: string[];
}

/**
 * A chat route (`POST /api/chat`) and its resume endpoint (`GET /api/resume`),
 * one journaled stream per POST (`turn-<n>`, message id `m-<n>`).
 */
function chatRoute(options: RouteOptions = {}) {
  const answers = options.answers ?? ['Hi there.', 'Hi again.', 'Still here.'];
  const model = createMockModel({ responses: answers.map((text) => ({ text })) });
  const store = createInMemoryStreamStateStore();
  const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
  let turn = 0;
  const handshake = (headers: Headers) =>
    options.announce ? { capabilities: { request: headers, announce: options.announce } } : {};
  const finish = (response: Response): Response => {
    if (!options.hideHeader) return response;
    const headers = new Headers(response.headers);
    headers.delete(HEADER);
    return new Response(response.body, { status: response.status, headers });
  };
  const fetchMock: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url) === '/api/resume') {
      requests.push({ url: String(url), headers });
      return finish(
        resumeDeuzStreamResponse(store, `turn-${turn}`, {
          lastEventId: headers.get('last-event-id'),
          pollIntervalMs: 5,
          idleTimeoutMs: 2000,
          ...handshake(headers),
        }),
      );
    }
    const body = JSON.parse(String(init?.body)) as { messages: Message[] };
    requests.push({ url: String(url), headers, body });
    turn++;
    return finish(
      toDeuzStreamResponse(streamChat({ model, messages: body.messages }), {
        store,
        streamId: `turn-${turn}`,
        messageId: `m-${turn}`,
        ...handshake(headers),
      }),
    );
  };
  return { fetch: fetchMock, requests, store };
}

function chat(route: ReturnType<typeof chatRoute>, extra: Partial<UseChatOptions> = {}) {
  return renderHook(() =>
    useChat({
      api: '/api/chat',
      fetch: route.fetch,
      resume: { endpoint: '/api/resume' },
      ...extra,
    }),
  );
}

async function send(result: { current: ReturnType<typeof useChat> }, text: string) {
  await act(async () => {
    await result.current.sendMessage(text);
  });
  await waitFor(() => expect(result.current.status).toBe('idle'));
}

describe('useChat — the capability handshake', () => {
  it('lists what it understands on every POST and resume read', async () => {
    const route = chatRoute();
    const { result } = chat(route);
    await send(result, 'hi');
    await act(async () => {
      await result.current.reconnect();
    });
    expect(route.requests.map((r) => [r.url, r.headers.get(HEADER)])).toEqual([
      ['/api/chat', ADVERTISED],
      ['/api/resume', ADVERTISED],
    ]);
  });

  it('hands a function resume endpoint the header value as ctx.capabilities', async () => {
    const route = chatRoute({ announce: ['message-ids'] });
    const seen: Array<{ lastEventId?: string; capabilities?: string }> = [];
    const { result } = chat(route, {
      resume: {
        endpoint: (ctx) => {
          seen.push(ctx);
          return resumeDeuzStreamResponse(route.store, 'turn-1', {
            lastEventId: ctx.lastEventId ?? null,
            capabilities: { request: ctx.capabilities, announce: ['message-ids'] },
          });
        },
      },
    });
    await send(result, 'hi');
    await act(async () => {
      await result.current.reconnect();
    });
    expect(seen).toEqual([{ lastEventId: '4', capabilities: ADVERTISED }]);
    expect(result.current.messages.map((m) => m.content)).toEqual(['hi', 'Hi there.']);
  });

  it('with capabilityHandshake: false, sends nothing and ignores nothing new: exactly 2.3', async () => {
    const route = chatRoute({ announce: ['message-ids', 'chat-snapshot-v1'] });
    const seen: Array<Record<string, unknown>> = [];
    const { result } = chat(route, {
      capabilityHandshake: false,
      resume: {
        endpoint: (ctx) => {
          seen.push({ ...ctx });
          return route.fetch('/api/resume', {
            headers: ctx.lastEventId ? { 'last-event-id': ctx.lastEventId } : {},
          });
        },
      },
    });
    await send(result, 'hi');
    await act(async () => {
      await result.current.reconnect();
    });
    expect(route.requests.map((r) => r.headers.get(HEADER))).toEqual([null, null]);
    expect(seen).toEqual([{ lastEventId: '4' }]);
    expect(result.current.capabilities).toBeUndefined();
    expect(result.current.exportSnapshot().capabilities).toBeUndefined();
  });

  it('against a 2.3 route: nothing is announced and nothing changes', async () => {
    const route = chatRoute();
    const onData = vi.fn();
    const { result } = chat(route, { onData });
    await send(result, 'hi');
    expect(result.current.capabilities).toBeUndefined();
    expect(result.current.messages.map((m) => [m.id, m.content])).toEqual([
      [expect.any(String), 'hi'],
      ['m-1', 'Hi there.'],
    ]);
    expect(onData).not.toHaveBeenCalled();
    expect(result.current.exportSnapshot().capabilities).toBeUndefined();
  });

  it('against a 2.4 route: reads the announcement, and the frame never reaches the turn', async () => {
    const route = chatRoute({ announce: ['message-ids', 'chat-snapshot-v1'] });
    const onData = vi.fn();
    const { result } = chat(route, { onData });
    await send(result, 'hi');
    expect(result.current.capabilities).toEqual(['chat-snapshot-v1', 'message-ids']);
    const reply = result.current.messages.at(-1)!;
    expect(reply).toMatchObject({ id: 'm-1', content: 'Hi there.' });
    expect(reply.parts).toEqual([{ type: 'text', text: 'Hi there.', state: 'done' }]);
    expect(onData).not.toHaveBeenCalled();
    expect(result.current.exportSnapshot().capabilities).toEqual([
      'chat-snapshot-v1',
      'message-ids',
    ]);
  });

  it('reads the first frame when the response header is not exposed', async () => {
    const route = chatRoute({ announce: ['message-ids'], hideHeader: true });
    const { result } = chat(route);
    await send(result, 'hi');
    expect(result.current.capabilities).toEqual(['message-ids']);
  });

  it('keeps a caught-up resume silent when all it sends is the capabilities frame', async () => {
    const route = chatRoute({ announce: ['message-ids'], hideHeader: true });
    const { result } = chat(route);
    await send(result, 'hi');
    const before = result.current.history;
    await act(async () => {
      await result.current.reconnect();
    });
    expect(route.requests.at(-1)?.headers.get('last-event-id')).toBe('4');
    expect(result.current.history).toBe(before);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('starts from the capabilities a restored snapshot recorded', () => {
    const route = chatRoute();
    const { result } = chat(route, {
      initialSnapshot: {
        version: 1,
        messages: [],
        capabilities: ['message-ids', 'Durable-Stream'],
      },
    });
    expect(result.current.capabilities).toEqual(['durable-stream', 'message-ids']);
  });

  it('keeps the set when a response announces nothing, and takes an empty announcement', async () => {
    const quiet = chatRoute();
    const kept = chat(quiet, {
      initialSnapshot: { version: 1, messages: [], capabilities: ['message-ids'] },
    });
    await send(kept.result, 'hi');
    expect(kept.result.current.capabilities).toEqual(['message-ids']);

    const empty = chatRoute({ announce: [] });
    const cleared = chat(empty, {
      initialSnapshot: { version: 1, messages: [], capabilities: ['message-ids'] },
    });
    await send(cleared.result, 'hi');
    expect(cleared.result.current.capabilities).toEqual([]);
  });
});
