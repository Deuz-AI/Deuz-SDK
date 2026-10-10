import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createRealtimeSession,
  createOpenAIRealtime,
  createGeminiLive,
  RealtimeError,
  type RealtimeEvent,
  type RealtimeWebSocketFactory,
} from '../src/realtime';
import { tool } from '../src/tool';
import type { JSONSchema } from '../src/types/schema';
import {
  fakeRealtimeServer,
  openaiHandshake,
  geminiHandshake,
  flush,
  FakeRealtimeSocket,
} from './fixtures/realtime-socket';
import { manualClock } from './fixtures/manual-clock';

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

describe('session lifecycle edges', () => {
  it('cancels the dial when close() runs before the credential resolves', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    let release: (token: string) => void = () => {};
    const session = createRealtimeSession({
      model: createOpenAIRealtime()('gpt-realtime'),
      ephemeralToken: () => new Promise<string>((resolve) => (release = resolve)),
      deps: { webSocket: server.webSocket },
    });
    const pending = session.connect().catch((error: unknown) => error);
    await session.close();
    release('ek_late');
    await flush();
    expect(await pending).toMatchObject({ kind: 'closed' });
    expect(server.sockets).toHaveLength(0);
    expect(session.status).toBe('closed');
  });

  it('arms no connect timer when connectTimeoutMs is 0 or Infinity', async () => {
    for (const connectTimeoutMs of [0, Number.POSITIVE_INFINITY]) {
      const { clock, pending } = manualClock();
      const server = fakeRealtimeServer(); // never accepts
      const session = createRealtimeSession({
        model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
        connectTimeoutMs,
        deps: { webSocket: server.webSocket, clock },
      });
      const attempt = session.connect().catch((error: unknown) => error);
      await flush();
      expect(pending()).toBe(0);
      expect(session.status).toBe('connecting');
      await session.close();
      expect(await attempt).toMatchObject({ kind: 'closed' });
    }
  });

  it('rejects an already-aborted connect without dialing', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      signal: AbortSignal.abort(),
      deps: { webSocket: server.webSocket },
    });
    await expect(session.connect()).rejects.toMatchObject({ code: 'aborted' });
    expect(server.sockets).toHaveLength(0);
  });

  it('closes an open session from the client side when its signal aborts', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const controller = new AbortController();
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      signal: controller.signal,
      deps: { webSocket: server.webSocket },
    });
    const closed: RealtimeEvent[] = [];
    session.on('session-closed', (event) => closed.push(event));
    await session.connect();
    controller.abort();
    await flush();
    expect(closed).toEqual([
      { type: 'session-closed', code: 1000, reason: 'aborted', initiator: 'client' },
    ]);
  });

  it('ends quietly when the server closes normally', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      deps: { webSocket: server.webSocket },
    });
    const events: RealtimeEvent[] = [];
    session.on('*', (event) => events.push(event));
    await session.connect();
    server.socket.drop(1000, 'session ended');
    await flush();
    expect(events.slice(1)).toEqual([
      { type: 'session-closed', code: 1000, reason: 'session ended', initiator: 'server' },
    ]);
  });

  it('leaves provider-executed tools out of the session with a warning', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      tools: {
        web_search: tool({
          type: 'provider',
          parameters: { type: 'object' },
          providerTool: { type: 'web_search' },
        }),
      },
      deps: { webSocket: server.webSocket },
    });
    const warnings: RealtimeEvent[] = [];
    session.on('warning', (event) => warnings.push(event));
    await session.connect();
    expect(server.socket.messages[0]).not.toHaveProperty('session.tools');
    expect(warnings).toEqual([
      {
        type: 'warning',
        warning: expect.objectContaining({ type: 'unsupported-tool', setting: 'web_search' }),
      },
    ]);
  });

  it('scrubs the credential out of a socket factory error, plain or URL-encoded', async () => {
    const session = createRealtimeSession({
      model: createGeminiLive({ apiKey: 'g key/1', apiKeyLocation: 'query' })(
        'gemini-live-2.5-flash-preview',
      ),
      deps: {
        webSocket: (url) => {
          throw new Error(`cannot open ${url} (key g key/1)`);
        },
      },
    });
    const failure = (await session.connect().catch((error: unknown) => error)) as Error;
    expect(failure).toMatchObject({ kind: 'connect-failed' });
    expect(failure.message).not.toContain('g key/1');
    expect(failure.message).not.toContain('g%20key%2F1');
    expect(failure.message).toContain('[redacted]');
  });

  it('refuses sends and tool results before connect, and an unknown model surface outright', () => {
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
    });
    expect(() => session.sendText('hi')).toThrow(RealtimeError);
    expect(() => session.sendToolResult('call_1', 'x')).toThrow(
      expect.objectContaining({ kind: 'not-connected' }),
    );
    expect(() =>
      createRealtimeSession({
        model: { provider: 'acme', modelId: 'x', surface: 'acme-live' as never },
      }),
    ).toThrow(RealtimeError);
  });
});

describe('tool calls handled from inside a tool-call listener', () => {
  const CITY: JSONSchema = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  };

  /** A logger that records what the session swallowed (the default one is silent). */
  function recordingLogger(sink: string[]) {
    return {
      debug() {},
      info() {},
      warn() {},
      error: (message: string, fields?: Record<string, unknown>) =>
        sink.push(`${message} ${String(fields?.error ?? '')}`),
    };
  }

  it('OpenAI: a client tool answered synchronously from on("tool-call") reaches the wire', async () => {
    const swallowed: string[] = [];
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      tools: { get_weather: tool({ parameters: CITY }) }, // a client tool: no execute
      deps: { webSocket: server.webSocket, logger: recordingLogger(swallowed) },
    });
    session.on('tool-call', (event) => session.sendToolResult(event.toolCallId, { tempC: 19 }));
    await session.connect();
    const baseline = server.socket.sent.length;

    server.socket.push({
      type: 'response.done',
      event_id: 'e',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
        ],
      },
    });
    await flush();

    expect(server.socket.messages.slice(baseline)).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'call_1', output: '{"tempC":19}' },
      },
      expect.objectContaining({ type: 'response.create' }),
    ]);
    expect(swallowed).toEqual([]);
    // Answered once: a second answer is refused as before.
    expect(() => session.sendToolResult('call_1', 'again')).toThrow(
      expect.objectContaining({ kind: 'tool' }),
    );
  });

  it('Gemini: a synchronous answer joins the batch with its executed sibling', async () => {
    const swallowed: string[] = [];
    const server = fakeRealtimeServer((socket) => geminiHandshake(socket));
    const session = createRealtimeSession({
      model: createGeminiLive({ apiKey: 'g-key' })('gemini-live-2.5-flash-preview'),
      tools: {
        get_location: tool({ parameters: { type: 'object' } }), // a client tool
        get_weather: tool({ parameters: CITY, execute: async () => 'sunny' }),
      },
      deps: { webSocket: server.webSocket, logger: recordingLogger(swallowed) },
    });
    const events: RealtimeEvent[] = [];
    session.on('*', (event) => events.push(event));
    session.on('tool-call', (event) => {
      if (event.toolName === 'get_location') session.sendToolResult(event.toolCallId, 'Rome');
    });
    await session.connect();
    const baseline = server.socket.sent.length;

    server.socket.push({
      toolCall: {
        functionCalls: [
          { id: 'fc_1', name: 'get_location', args: {} },
          { id: 'fc_2', name: 'get_weather', args: { city: 'Rome' } },
        ],
      },
    });
    await flush();

    expect(server.socket.messages.slice(baseline)).toEqual([
      {
        toolResponse: {
          functionResponses: [
            { id: 'fc_1', name: 'get_location', response: { output: 'Rome' } },
            { id: 'fc_2', name: 'get_weather', response: { output: 'sunny' } },
          ],
        },
      },
    ]);
    expect(swallowed).toEqual([]);
    // Each result follows its own call.
    const order = events
      .filter((event) => event.type === 'tool-call' || event.type === 'tool-result')
      .map((event) => `${event.type}:${(event as { toolCallId: string }).toolCallId}`);
    expect(order.indexOf('tool-result:fc_1')).toBeGreaterThan(order.indexOf('tool-call:fc_1'));
    expect(order.indexOf('tool-result:fc_2')).toBeGreaterThan(order.indexOf('tool-call:fc_2'));
  });

  /** An OpenAI server that acknowledges the closing handshake after a round trip, like a real one. */
  function slowCloseServer(): {
    webSocket: RealtimeWebSocketFactory;
    socket: () => FakeRealtimeSocket;
  } {
    class SlowCloseSocket extends FakeRealtimeSocket {
      override close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        if (this.readyState >= 2) return;
        this.readyState = 2;
        setTimeout(() => this.drop(code ?? 1005, reason ?? ''), 5);
      }
    }
    let latest: FakeRealtimeSocket | undefined;
    return {
      webSocket: (url, init) => {
        latest = new SlowCloseSocket(url, init);
        openaiHandshake(latest);
        return latest;
      },
      socket: () => latest!,
    };
  }

  const transferCall = (calls: { call_id: string; name: string }[]) => ({
    type: 'response.done',
    event_id: 'e',
    response: {
      id: 'resp_1',
      status: 'completed',
      output: calls.map((call) => ({ type: 'function_call', ...call, arguments: '{}' })),
    },
  });

  async function closeHandshake(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
  }

  it('close() inside on("tool-call") keeps the announced call from executing', async () => {
    const server = slowCloseServer();
    const ran: string[] = [];
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      tools: {
        transfer: tool({
          parameters: { type: 'object' },
          execute: async () => {
            ran.push(session.status);
            return 'transferred $100';
          },
        }),
      },
      deps: { webSocket: server.webSocket },
    });
    session.on('tool-call', () => void session.close()); // e.g. a max-tool-calls guard
    await session.connect();
    server.socket().push(transferCall([{ call_id: 'c1', name: 'transfer' }]));
    await closeHandshake();
    expect(session.status).toBe('closed');
    expect(ran).toEqual([]);
  });

  it('aborting the signal inside on("tool-call") keeps the announced call from executing', async () => {
    const server = slowCloseServer();
    const controller = new AbortController();
    const ran: string[] = [];
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      signal: controller.signal,
      tools: {
        transfer: tool({
          parameters: { type: 'object' },
          execute: async () => {
            ran.push(session.status);
            return 'transferred $100';
          },
        }),
      },
      deps: { webSocket: server.webSocket },
    });
    session.on('tool-call', () => controller.abort());
    await session.connect();
    server.socket().push(transferCall([{ call_id: 'c1', name: 'transfer' }]));
    await closeHandshake();
    expect(session.status).toBe('closed');
    expect(ran).toEqual([]);
  });

  it('a close from a tool-result listener stops the rest of the batch', async () => {
    const server = slowCloseServer();
    const ran: string[] = [];
    const approveToolCall = vi.fn(() => true);
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      approveToolCall,
      tools: {
        transfer: tool({
          parameters: { type: 'object' },
          needsApproval: true,
          execute: async () => {
            ran.push(session.status);
            return 'transferred $100';
          },
        }),
      },
      deps: { webSocket: server.webSocket },
    });
    // The unknown tool is answered at once; its result closes the session.
    session.on('tool-result', () => void session.close());
    await session.connect();
    server.socket().push(
      transferCall([
        { call_id: 'c1', name: 'nope' },
        { call_id: 'c2', name: 'transfer' },
      ]),
    );
    await closeHandshake();
    expect(session.status).toBe('closed');
    expect(approveToolCall).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
  });
});
