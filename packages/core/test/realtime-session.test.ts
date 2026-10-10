import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createRealtimeSession,
  createOpenAIRealtime,
  createGeminiLive,
  RealtimeError,
  type RealtimeEvent,
} from '../src/realtime';
import {
  fakeRealtimeServer,
  openaiHandshake,
  flush,
  FakeRealtimeSocket,
} from './fixtures/realtime-socket';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('default WebSocket factory (globalThis.WebSocket)', () => {
  /** Records constructor calls; behaves as a socket that never opens. */
  function stubGlobalWebSocket(): { calls: unknown[][]; sockets: FakeRealtimeSocket[] } {
    const calls: unknown[][] = [];
    const sockets: FakeRealtimeSocket[] = [];
    class StubWebSocket extends FakeRealtimeSocket {
      constructor(url: string, protocolsOrInit?: unknown) {
        super(url, {});
        calls.push(protocolsOrInit === undefined ? [url] : [url, protocolsOrInit]);
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', StubWebSocket);
    return { calls, sockets };
  }

  it('passes subprotocols only when there is nothing to put in a header (browser path)', async () => {
    const { calls, sockets } = stubGlobalWebSocket();
    const session = createRealtimeSession({
      model: createOpenAIRealtime()('gpt-realtime'),
      ephemeralToken: 'ek_1',
    });
    void session.connect().catch(() => {});
    await flush();
    expect(calls).toEqual([
      [
        'wss://api.openai.com/v1/realtime?model=gpt-realtime',
        ['realtime', 'openai-insecure-api-key.ek_1'],
      ],
    ]);
    // Binary frames (Gemini sends JSON in them) arrive as ArrayBuffer, not Blob.
    expect(sockets[0]!.binaryType).toBe('arraybuffer');
    await session.close();
  });

  it('uses the WebSocketInit form with headers for a server-side key (Node >= 22, Deno, Bun)', async () => {
    const { calls } = stubGlobalWebSocket();
    const session = createRealtimeSession({
      model: createGeminiLive({ apiKey: 'g-key' })('gemini-live-2.5-flash-preview'),
    });
    void session.connect().catch(() => {});
    await flush();
    expect(calls[0]).toEqual([
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      { protocols: [], headers: { 'x-goog-api-key': 'g-key' } },
    ]);
    await session.close();
  });

  it('explains how to get a socket when the runtime has no WebSocket', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
    });
    const failure = await session.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RealtimeError);
    expect(failure).toMatchObject({ kind: 'no-websocket' });
    expect((failure as Error).message).toContain('deps.webSocket');
  });

  it('points a browser that rejects header auth at ephemeral tokens', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new DOMException("The subprotocol '[object Object]' is invalid.", 'SyntaxError');
        }
      },
    );
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk-should-not-be-in-a-browser' })('gpt-realtime'),
    });
    const failure = await session.connect().catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'connect-failed' });
    expect((failure as Error).message).toContain('ephemeral');
    expect((failure as Error).message).not.toContain('sk-should-not-be-in-a-browser');
  });
});

describe('session plumbing', () => {
  async function open(options: { rawEvents?: boolean } = {}) {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const errors: unknown[] = [];
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      ...options,
      deps: {
        webSocket: server.webSocket,
        logger: { debug() {}, info() {}, warn() {}, error: (message) => errors.push(message) },
      },
    });
    return { session, server, errors };
  }

  it('shares one handshake between concurrent connect() calls and refuses to reopen', async () => {
    const { session, server } = await open();
    const first = session.connect();
    const second = session.connect();
    await Promise.all([first, second]);
    expect(server.sockets).toHaveLength(1);
    await session.connect(); // already open: resolves without dialing again
    expect(server.sockets).toHaveLength(1);
    await session.close();
    await expect(session.connect()).rejects.toMatchObject({ kind: 'closed' });
  });

  it('isolates a throwing listener: others still run and the session stays up', async () => {
    const { session, server, errors } = await open();
    const seen: string[] = [];
    session.on('response-started', () => {
      throw new Error('listener bug');
    });
    session.on('response-started', (event) => seen.push(event.responseId));
    await session.connect();
    server.socket.push({ type: 'response.created', event_id: 'e', response: { id: 'resp_1' } });
    await flush();
    expect(seen).toEqual(['resp_1']);
    expect(errors).toHaveLength(1);
    expect(session.status).toBe('open');
  });

  it('unsubscribes, buffers events() for slow consumers and ends it on close', async () => {
    const { session, server } = await open();
    const typed: string[] = [];
    const off = session.on('response-started', (event) => typed.push(event.responseId));
    await session.connect();
    const iterator = session.events();
    server.socket.push({ type: 'response.created', event_id: 'e', response: { id: 'resp_1' } });
    off();
    server.socket.push({ type: 'response.created', event_id: 'e', response: { id: 'resp_2' } });
    await flush();
    await session.close();

    const drained: RealtimeEvent['type'][] = [];
    for await (const event of iterator) drained.push(event.type);
    expect(typed).toEqual(['resp_1']);
    expect(drained).toEqual(['response-started', 'response-started', 'session-closed']);
  });

  it('passes raw frames through on request and lets the app send provider events', async () => {
    const { session, server } = await open({ rawEvents: true });
    const raw: unknown[] = [];
    session.on('raw', (event) => raw.push(event.message));
    await session.connect();
    server.socket.push({ type: 'rate_limits.updated', event_id: 'e', rate_limits: [] });
    await flush();
    expect(raw).toContainEqual({ type: 'rate_limits.updated', event_id: 'e', rate_limits: [] });

    session.sendRaw({ type: 'input_audio_buffer.clear' });
    expect(server.socket.messages.at(-1)).toEqual({ type: 'input_audio_buffer.clear' });
  });

  it('ignores frames it cannot parse, reporting them as non-fatal', async () => {
    const { session, server } = await open();
    const events: RealtimeEvent[] = [];
    session.on('*', (event) => events.push(event));
    await session.connect();
    server.socket.push('{not json');
    server.socket.push({ type: 'response.created', event_id: 'e', response: { id: 'resp_9' } });
    await flush();
    expect(events.slice(1).map((event) => event.type)).toEqual(['error', 'response-started']);
    expect(events[1]).toMatchObject({ fatal: false, error: { kind: 'invalid-message' } });
  });
});
