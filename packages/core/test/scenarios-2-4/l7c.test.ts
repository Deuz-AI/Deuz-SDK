// @vitest-environment jsdom
/**
 * Lane L7C acceptance scenarios (spec §5.1, area chat-stream-react): the
 * React side of spec §3.4, driven through `@deuz-sdk/react`'s `useChat`
 * against real 2.4 routes built from core's sources.
 *
 * - snapshot-id-replay (fault): a page that dies mid-answer leaves a
 *   `ChatSnapshotV1`; the page that restores it reconnects from the
 *   snapshot's cursor to a durable stream and gets every remaining frame
 *   once, under the ids the server gave, with two equal-text answers kept.
 * - capability-handshake-old-and-new-core: the same client against a route
 *   that takes no part in the handshake (the 2.3 stream, byte for byte) and
 *   against one that announces its capabilities. Against the first nothing
 *   is announced and the client behaves as 2.3 did; against the second it
 *   uses what was announced and nothing more.
 *
 * The hook is loaded with a dynamic import so core's type check does not
 * follow it into the React package (whose own checks cover it). Like the
 * React tests, it reads `@deuz-sdk/core` from the built `dist`. Every store,
 * lease provider and model is built inside the scenario.
 */
import { expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { streamChat } from '../../src/index';
import { createInMemoryLeaseProvider } from '../../src/ops';
import { createMockModel } from '../../src/testing';
import type { Message } from '../../src/types/message';
import {
  createInMemoryDurableStreamStateStore,
  createInMemoryStreamStateStore,
  resumeDeuzStreamResponse,
  toDeuzStreamResponse,
  type StreamStateStore,
  type ToDeuzStreamOptions,
} from '../../src/ui';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

/** The part of `useChat`'s result the scenarios read. */
interface Chat {
  messages: Array<{ id: string; role: string; content: string }>;
  history: { canonical: Message[] };
  status: 'idle' | 'streaming' | 'error';
  capabilities?: string[];
  sendMessage(text: string): Promise<void>;
  reconnect(): Promise<void>;
  exportSnapshot(): Snapshot;
}

/** `ChatSnapshotV1`, as far as the scenarios read it. */
interface Snapshot {
  version: 1;
  messages: Message[];
  messageIds?: string[];
  cursor?: string;
  capabilities?: string[];
}

const { useChat } = (await import('../../../react/src/use-chat' as string)) as {
  useChat: (options: Record<string, unknown>) => Chat;
};

const HEADER = 'x-deuz-capabilities';
const ANSWER = 'echo, echo';

/** The `id:` of every SSE event in `text`, in order. */
function eventIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

/** `response`, with everything that passes through it also handed to `sink`. */
function tapped(response: Response, sink: (text: string) => void): Response {
  const decoder = new TextDecoder();
  const body = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sink(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, headers: response.headers });
}

/**
 * The first `events` SSE events of `response`, then a connection that hangs
 * until `signal` aborts it: a page that read that far and then went away. The
 * server is not told and keeps producing into its journal.
 */
function hangingAfter(response: Response, events: number, signal: AbortSignal): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === events) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener('abort', () => resolve());
          });
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        while (!buffered.includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) return controller.close();
          buffered += decoder.decode(value, { stream: true });
        }
        const end = buffered.indexOf('\n\n') + 2;
        controller.enqueue(encoder.encode(buffered.slice(0, end)));
        buffered = buffered.slice(end);
        sent++;
      },
    }),
    { headers: response.headers },
  );
}

interface RouteOptions {
  /** Capabilities the route announces; absent: the route takes no part (the 2.3 stream). */
  announce?: string[];
  /** Serve durable streams (persist before publish) instead of the legacy journal. */
  durable?: boolean;
  /** Cut the POST of this round after `events` SSE events (a page that went away). */
  hangRound?: { round: number; events: number };
}

/**
 * A chat route (`POST /api/chat`) and its resume endpoint (`GET /api/resume`),
 * as an app wires them over core: one stream per POST (`turn-<n>`, message id
 * `m-<n>`), every answer `ANSWER`.
 */
function chatRoute(options: RouteOptions) {
  const model = createMockModel({ responses: [{ text: ANSWER }, { text: ANSWER }] });
  const durableStore = options.durable ? createInMemoryDurableStreamStateStore() : undefined;
  const store: StreamStateStore = durableStore ?? createInMemoryStreamStateStore();
  const lease = { provider: createInMemoryLeaseProvider() };
  const posts: Array<{ headers: Headers; body: Record<string, unknown>; text: string[] }> = [];
  const resumes: Array<{ headers: Headers; text: string[] }> = [];
  let round = 0;
  const handshake = (headers: Headers): Pick<ToDeuzStreamOptions, 'capabilities'> =>
    options.announce ? { capabilities: { request: headers, announce: options.announce } } : {};
  const fetchMock = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (String(url) === '/api/resume') {
      const entry = { headers, text: [] as string[] };
      resumes.push(entry);
      return tapped(
        resumeDeuzStreamResponse(store, `turn-${round}`, {
          lastEventId: headers.get('last-event-id'),
          pollIntervalMs: 5,
          idleTimeoutMs: 2_000,
          ...handshake(headers),
        }),
        (text) => entry.text.push(text),
      );
    }
    const body = JSON.parse(String(init?.body)) as { messages: Message[] };
    const entry = { headers, body, text: [] as string[] };
    posts.push(entry);
    round++;
    const response = toDeuzStreamResponse(streamChat({ model, messages: body.messages }), {
      streamId: `turn-${round}`,
      messageId: `m-${round}`,
      ...(durableStore
        ? { durable: { store: durableStore, lease, batch: { maxDelayMs: 1 } } }
        : { store }),
      ...handshake(headers),
    });
    const served =
      options.hangRound?.round === round
        ? hangingAfter(response, options.hangRound.events, init!.signal!)
        : response;
    return tapped(served, (text) => entry.text.push(text));
  };
  return { fetch: fetchMock, posts, resumes, store };
}

type Rendered = { current: Chat };

async function send(result: Rendered, text: string): Promise<void> {
  await act(async () => {
    await result.current.sendMessage(text);
  });
  await waitFor(() => expect(result.current.status).toBe('idle'));
}

const contents = (chat: Chat) => chat.messages.map((m) => [m.id, m.content]);

scenario(
  'chat-stream-react',
  'snapshot-id-replay',
  async () => {
    const route = chatRoute({
      announce: ['message-ids', 'chat-snapshot-v1'],
      durable: true,
      // Round 2: the capabilities frame, `start`, a warning and the first text delta reach the page.
      hangRound: { round: 2, events: 4 },
    });
    const options = { api: '/api/chat', fetch: route.fetch, resume: { endpoint: '/api/resume' } };

    // The first page: one settled answer, then a second one with the same text, cut short.
    const first = renderHook(() => useChat(options));
    await send(first.result, 'same');
    act(() => {
      void first.result.current.sendMessage('same');
    });
    await waitFor(() => expect(first.result.current.messages.at(-1)?.content).toBe('echo,'));
    // The app persists the snapshot as the page renders; then the page goes away.
    const snapshot = JSON.parse(JSON.stringify(first.result.current.exportSnapshot())) as Snapshot;
    first.unmount();

    expect(snapshot.capabilities).toEqual(['chat-snapshot-v1', 'durable-stream', 'message-ids']);
    expect(snapshot.cursor).toBe('2');
    const [u1, , u2] = snapshot.messageIds!;
    expect(snapshot.messageIds).toEqual([u1, 'm-1', u2]);

    // The second page restores it and reconnects on mount.
    const second = renderHook(() =>
      useChat({
        ...options,
        resume: { endpoint: '/api/resume', auto: true },
        initialSnapshot: snapshot,
      }),
    );
    await waitFor(() => expect(second.result.current.messages.at(-1)?.content).toBe(ANSWER));
    await waitFor(() => expect(second.result.current.status).toBe('idle'));

    // It asked for what came after the cursor and got exactly that: every frame once.
    expect(route.resumes.map((r) => r.headers.get('last-event-id'))).toEqual(['2']);
    const journal: number[] = [];
    for await (const record of route.store.read('turn-2')) journal.push(record.seq);
    const firstPage = eventIds(route.posts[1]!.text.join(''));
    const secondPage = eventIds(route.resumes[0]!.text.join(''));
    expect(firstPage).toEqual([0, 1, 2]);
    expect(secondPage.filter((seq) => seq <= 2)).toEqual([]);
    expect([...firstPage, ...secondPage].filter((seq) => journal.includes(seq))).toEqual(
      journal.filter((seq) => seq <= Math.max(...secondPage)),
    );

    // Ids intact; the two equal-text answers are both kept, each under its own id.
    expect(contents(second.result.current)).toEqual([
      [u1, 'same'],
      ['m-1', ANSWER],
      [u2, 'same'],
      ['m-2', ANSWER],
    ]);
    expect(second.result.current.history.canonical.map((m) => m.content)).toEqual([
      'same',
      ANSWER,
      'same',
      ANSWER,
    ]);
    expect(second.result.current.exportSnapshot().messageIds).toEqual([u1, 'm-1', u2, 'm-2']);
    second.unmount();
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'chat-stream-react',
  'capability-handshake-old-and-new-core',
  async () => {
    /** The same client flow: two equal-text turns, then a replay that starts over (a lost cursor). */
    async function drive(route: ReturnType<typeof chatRoute>) {
      const options = { api: '/api/chat', fetch: route.fetch, resume: { endpoint: '/api/resume' } };
      const live = renderHook(() => useChat(options));
      await send(live.result, 'same');
      await send(live.result, 'same');
      const announced = live.result.current.capabilities;
      const snapshot = live.result.current.exportSnapshot();
      live.unmount();
      // A restored page without the cursor: its resume read replays the last stream from the start.
      const { cursor: _lost, ...withoutCursor } = snapshot;
      const restored = renderHook(() => useChat({ ...options, initialSnapshot: withoutCursor }));
      await act(async () => {
        await restored.result.current.reconnect();
      });
      const after = restored.result.current;
      restored.unmount();
      return { announced, after };
    }

    // An old core: the route takes no part, so its stream is the 2.3 stream.
    const old = chatRoute({});
    const before = await drive(old);
    // The client asked every time; the route answered neither header nor frame.
    expect([...old.posts, ...old.resumes].map((r) => r.headers.get(HEADER))).toEqual(
      Array(3).fill('chat-snapshot-v1, durable-stream, message-ids'),
    );
    expect(old.posts.map((p) => p.text.join('')).join('')).not.toContain('"capabilities"');
    expect(before.announced).toBeUndefined();
    // Features stay off: the 2.3 bodies, and the replay renders the last answer again (2.3).
    expect(old.posts.map((p) => Object.keys(p.body))).toEqual([['messages'], ['messages']]);
    expect(before.after.messages.map((m) => m.content)).toEqual([
      'same',
      ANSWER,
      'same',
      ANSWER,
      ANSWER,
    ]);

    // A new core: the route announces what it supports.
    const fresh = chatRoute({ announce: ['message-ids', 'chat-snapshot-v1'] });
    const now = await drive(fresh);
    expect(now.announced).toEqual(['chat-snapshot-v1', 'message-ids']);
    // chat-snapshot-v1: once announced, the body carries the ids the UI renders.
    expect(Object.keys(fresh.posts[0]!.body)).toEqual(['messages']);
    expect(fresh.posts[1]!.body.messageIds).toEqual(
      now.after.exportSnapshot().messageIds!.slice(0, 3),
    );
    // message-ids: the replay re-delivers m-2, which the history holds: nothing doubles,
    // and the equal-text answers stay two messages.
    expect(
      contents(now.after)
        .map(([id]) => id)
        .slice(1),
    ).toEqual(['m-1', expect.any(String), 'm-2']);
    expect(now.after.messages.map((m) => m.content)).toEqual(['same', ANSWER, 'same', ANSWER]);
    expect(now.after.history.canonical).toHaveLength(4);
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);
