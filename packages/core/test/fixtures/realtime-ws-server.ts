/**
 * realtime-ws-server.ts — a minimal RFC 6455 WebSocket server on 127.0.0.1.
 *
 * `fixtures/realtime-socket.ts` scripts the WHATWG socket surface; this is the
 * other half of the bargain: the session talks to a real listener through the
 * runtime's own global `WebSocket` (undici in Node >= 22), so the default
 * socket factory, handshake headers, subprotocol negotiation, real
 * `MessageEvent`/`CloseEvent` objects, binary frames and the closing handshake
 * are all exercised for real. Only what a realtime test needs is implemented:
 * unfragmented text/binary frames, ping/pong and close. No dependency beyond
 * `node:http` and `node:crypto`.
 *
 * Every server owns one listener; `stop()` MUST run in a `finally`/`afterEach`
 * or the vitest worker keeps the port.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

/** One accepted client connection, from the server's side. */
export interface WsConnection {
  /** The request target (`/v1/realtime?model=…`). */
  readonly url: string;
  /** Handshake headers, lower-cased by node:http. */
  readonly headers: IncomingMessage['headers'];
  /** Every JSON message the client sent, parsed. */
  readonly received: Record<string, unknown>[];
  /** Scripted reaction to each client message. */
  onMessage?: (message: Record<string, unknown>) => void;
  /** Send JSON in a text frame. */
  sendText(value: unknown): void;
  /** Send JSON in a BINARY frame (how Gemini Live delivers its messages). */
  sendBinary(value: unknown): void;
  /** Start the closing handshake from the server. */
  close(code: number, reason?: string): void;
  /** Settles once the TCP socket is gone. */
  readonly ended: Promise<void>;
}

export interface LocalWsServer {
  /** `http://127.0.0.1:<port>` — a provider `baseURL`; the session swaps in `ws:`. */
  readonly origin: string;
  readonly connections: WsConnection[];
  stop(): Promise<void>;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return payload;
}

function accept(request: IncomingMessage, socket: Socket): WsConnection {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const digest = createHash('sha1')
    .update(key + ACCEPT_GUID)
    .digest('base64');
  // Select the client's first subprotocol, the way OpenAI selects `realtime`.
  const offered = String(request.headers['sec-websocket-protocol'] ?? '');
  const protocol = offered.split(',')[0]?.trim();
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${digest}\r\n` +
      (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
      '\r\n',
  );

  let closeSent = false;
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  socket.on('close', () => resolveEnded());
  socket.on('error', () => resolveEnded());

  const write = (opcode: number, payload: Buffer) => {
    if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
  };

  const connection: WsConnection = {
    url: request.url ?? '',
    headers: request.headers,
    received: [],
    sendText: (value) => write(TEXT, Buffer.from(JSON.stringify(value))),
    sendBinary: (value) => write(BINARY, Buffer.from(JSON.stringify(value))),
    close(code, reason = '') {
      if (closeSent) return;
      closeSent = true;
      write(CLOSE, closePayload(code, reason));
    },
    ended,
  };

  // Client frames are always masked (RFC 6455 §5.3).
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0]! & 0x0f;
      const masked = (pending[1]! & 0x80) !== 0;
      let length = pending[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (pending.length < offset + length) return;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] = payload[index]! ^ pending[maskAt + (index % 4)]!;
        }
      }
      pending = pending.subarray(offset + length);

      if (opcode === TEXT || opcode === BINARY) {
        const message = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
        connection.received.push(message);
        connection.onMessage?.(message);
      } else if (opcode === PING) {
        write(PONG, payload);
      } else if (opcode === CLOSE) {
        // Echo the client's close — code AND reason, as the `ws` library does —
        // or finish ours, then drop the TCP socket. The client's CloseEvent
        // reports whatever this echo carries.
        if (!closeSent) {
          closeSent = true;
          write(CLOSE, payload);
        }
        socket.end();
      }
    }
  });
  return connection;
}

/** Listen on an ephemeral 127.0.0.1 port; `onConnection` scripts each accepted client. */
export async function startLocalWsServer(
  onConnection: (connection: WsConnection) => void,
): Promise<LocalWsServer> {
  const connections: WsConnection[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(426).end();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const connection = accept(request, socket);
    connections.push(connection);
    onConnection(connection);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    connections,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
