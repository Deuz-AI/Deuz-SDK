import type {
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
  RealtimeWebSocketInit,
} from '../../src/realtime';

type Listener = (event: unknown) => void;
type ClientMessage = Record<string, unknown>;

/**
 * A scripted stand-in for a provider's realtime WebSocket endpoint. It speaks
 * the WHATWG `WebSocket` surface the session uses (readyState, send, close,
 * addEventListener) and gives the test the server's side of the wire:
 * `accept`, `push`, `drop` and `fail`. Nothing touches the network.
 */
export class FakeRealtimeSocket implements RealtimeWebSocket {
  readyState = 0;
  binaryType = 'blob';
  /** Every frame the client sent, verbatim. */
  readonly sent: string[] = [];
  /** Every `close()` call the client made. */
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  /** Scripted server reaction to each client message. */
  onClientMessage?: (message: ClientMessage, socket: FakeRealtimeSocket) => void;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly init: RealtimeWebSocketInit,
  ) {}

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    // A real socket throws InvalidStateError before `open`; so does this one.
    if (this.readyState !== 1) throw new Error('InvalidStateError: the socket is not open');
    this.sent.push(data);
    this.onClientMessage?.(JSON.parse(data) as ClientMessage, this);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState >= 2) return;
    this.readyState = 2;
    // The server acknowledges the closing handshake asynchronously.
    queueMicrotask(() => this.finishClose(code ?? 1005, reason ?? ''));
  }

  // --- the server's side of the wire ---

  /** Complete the opening handshake. */
  accept(): void {
    this.readyState = 1;
    this.dispatch('open', { type: 'open' });
  }

  /** Deliver one server frame. Objects are JSON-encoded into a text frame. */
  push(message: unknown): void {
    const data =
      typeof message === 'string' ||
      message instanceof ArrayBuffer ||
      ArrayBuffer.isView(message) ||
      (typeof Blob !== 'undefined' && message instanceof Blob)
        ? message
        : JSON.stringify(message);
    this.dispatch('message', { type: 'message', data });
  }

  /** Server-initiated close. */
  drop(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.finishClose(code, reason);
  }

  /** A transport failure, reported the way browsers report it: no detail. */
  fail(): void {
    this.dispatch('error', { type: 'error' });
  }

  /** Every client message, parsed. */
  get messages(): ClientMessage[] {
    return this.sent.map((frame) => JSON.parse(frame) as ClientMessage);
  }

  private finishClose(code: number, reason: string): void {
    this.readyState = 3;
    this.dispatch('close', { type: 'close', code, reason, wasClean: code === 1000 });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

/**
 * A `deps.webSocket` factory over fake sockets. `script` runs once per created
 * socket (the place to wire a handshake); `socket` is the latest one.
 */
export function fakeRealtimeServer(script?: (socket: FakeRealtimeSocket) => void): {
  webSocket: RealtimeWebSocketFactory;
  sockets: FakeRealtimeSocket[];
  readonly socket: FakeRealtimeSocket;
} {
  const sockets: FakeRealtimeSocket[] = [];
  return {
    webSocket: (url, init) => {
      const socket = new FakeRealtimeSocket(url, init);
      sockets.push(socket);
      script?.(socket);
      return socket;
    },
    sockets,
    get socket() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket was opened');
      return socket;
    },
  };
}

/**
 * OpenAI Realtime handshake: accept, announce `session.created`, and answer the
 * client's `session.update` with `session.updated` (what the GA server does).
 */
export function openaiHandshake(socket: FakeRealtimeSocket, sessionId = 'sess_test'): void {
  const previous = socket.onClientMessage;
  socket.onClientMessage = (message, self) => {
    if (message.type === 'session.update') {
      self.push({
        type: 'session.updated',
        event_id: 'evt_updated',
        session: { id: sessionId, ...(message.session as object) },
      });
    }
    previous?.(message, self);
  };
  queueMicrotask(() => {
    socket.accept();
    socket.push({
      type: 'session.created',
      event_id: 'evt_created',
      session: { id: sessionId, type: 'realtime', object: 'realtime.session' },
    });
  });
}

/** Gemini Live handshake: accept, then answer `setup` with `setupComplete`. */
export function geminiHandshake(socket: FakeRealtimeSocket, sessionId = 'gemini-session'): void {
  const previous = socket.onClientMessage;
  socket.onClientMessage = (message, self) => {
    if ('setup' in message) self.push({ setupComplete: { sessionId } });
    previous?.(message, self);
  };
  queueMicrotask(() => socket.accept());
}

/** Let queued microtasks and zero-delay timers run. */
export async function flush(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
