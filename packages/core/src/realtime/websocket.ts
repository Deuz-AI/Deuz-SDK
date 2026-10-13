/**
 * realtime/websocket.ts — the default `deps.webSocket` factory and frame decoding.
 *
 * The default is the runtime's global `WebSocket` (browsers, workers,
 * Node >= 22, Deno, Bun). Handshake headers are passed with the non-standard
 * `WebSocketInit` form `new WebSocket(url, { protocols, headers })`, which
 * Node's undici, Deno and Bun accept; a browser cannot send headers at all and
 * rejects that form, which `session.ts` turns into a pointer at ephemeral tokens.
 */
import { RealtimeError } from './errors';
import type { RealtimeWebSocket, RealtimeWebSocketFactory } from './types';

type WebSocketConstructor = new (url: string, protocolsOrInit?: unknown) => RealtimeWebSocket;

export const defaultWebSocketFactory: RealtimeWebSocketFactory = (url, init) => {
  const WebSocketCtor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (typeof WebSocketCtor !== 'function') {
    throw new RealtimeError({
      kind: 'no-websocket',
      message:
        'This runtime has no global WebSocket (browsers, workers, Node >= 22, Deno and Bun have one). ' +
        'Pass deps.webSocket, e.g. (url, { protocols, headers }) => new WebSocket(url, protocols, { headers }) ' +
        'with the "ws" package.',
    });
  }
  const protocols = init.protocols ?? [];
  if (init.headers && Object.keys(init.headers).length > 0) {
    return new WebSocketCtor(url, { protocols, headers: init.headers });
  }
  return protocols.length > 0 ? new WebSocketCtor(url, protocols) : new WebSocketCtor(url);
};

const decoder = new TextDecoder();

/**
 * The text of one frame. Gemini sends its JSON in BINARY frames: an
 * ArrayBuffer (`binaryType = 'arraybuffer'`), a typed-array view (a Node `ws`
 * Buffer) or, from a socket that ignores `binaryType`, a Blob — the only
 * asynchronous case.
 */
export function frameText(data: unknown): string | Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  if (ArrayBuffer.isView(data)) return decoder.decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return String(data);
}
