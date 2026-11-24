/**
 * acp/transport.ts — the transport seam of an ACP connection (2.5), built on
 * web streams so a connection runs anywhere: in memory (tests, an in-process
 * agent), over a child process's pipes, over a socket. ACP's stdio transport
 * is newline-delimited JSON, which {@link createNdjsonTransport} frames; the
 * Node adapters in `@deuz-sdk/core/acp/stdio` only turn process streams into
 * web streams. Edge-safe.
 */

/**
 * One end of an ACP connection: a stream of incoming messages and a sink for
 * outgoing ones, ONE JSON-RPC message per chunk, as JSON text. A peer writes
 * text that never contains a newline (`JSON.stringify` output), and reads a
 * chunk that is not JSON as a parse error, which it answers.
 */
export interface AcpTransport {
  /** Incoming messages, one JSON text per chunk. */
  readonly readable: ReadableStream<string>;
  /** Outgoing messages, one JSON text per chunk. */
  readonly writable: WritableStream<string>;
}

/**
 * The text a framing layer hands on in place of a line longer than its limit,
 * so the peer answers it as an invalid request instead of buffering it.
 * @internal
 */
export const OVERSIZED_MESSAGE = '\u0000acp:oversized-message';

/** Default {@link NdjsonTransportOptions.maxMessageBytes}: 64 MiB. */
const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;

/**
 * Two connected in-memory transports: what one end writes, the other reads.
 * Serve an agent on one and connect a client on the other to run both in one
 * process, as the tests do.
 *
 * ```ts
 * const [agentSide, clientSide] = createInMemoryAcpTransportPair();
 * serveAcpAgent({ transport: agentSide, ... });
 * const client = await connectAcpAgent({ transport: clientSide });
 * ```
 */
export function createInMemoryAcpTransportPair(): [AcpTransport, AcpTransport] {
  const toB = new TransformStream<string, string>();
  const toA = new TransformStream<string, string>();
  return [
    { readable: toA.readable, writable: toB.writable },
    { readable: toB.readable, writable: toA.writable },
  ];
}

export interface NdjsonTransportOptions {
  /** Bytes in: a process's stdout (client side) or stdin (agent side), a socket. */
  readable: ReadableStream<Uint8Array | string>;
  /** Bytes out: a process's stdin (client side) or stdout (agent side), a socket. */
  writable: WritableStream<Uint8Array>;
  /**
   * The longest line read, in UTF-16 code units of decoded text. A longer one
   * is dropped up to its newline and answered as an invalid request, so a
   * peer that never sends a newline cannot grow the buffer without bound.
   * Default 64 MiB.
   */
  maxMessageBytes?: number;
}

/**
 * ACP's stdio framing over byte streams: each message is one UTF-8 line,
 * delimited by `\n` (a `\r` before it is dropped, blank lines are skipped).
 * Closing the transport's `writable` closes `options.writable`.
 */
export function createNdjsonTransport(options: NdjsonTransportOptions): AcpTransport {
  const max = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new TypeError('createNdjsonTransport: maxMessageBytes must be a positive integer.');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let discarding = false;
  const emit = (line: string, controller: TransformStreamDefaultController<string>) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() !== '') controller.enqueue(text);
  };
  const lines = new TransformStream<Uint8Array | string, string>({
    transform(chunk, controller) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) {
          discarding = false;
          controller.enqueue(OVERSIZED_MESSAGE);
        } else if (line.length > max) {
          controller.enqueue(OVERSIZED_MESSAGE);
        } else {
          emit(line, controller);
        }
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > max) {
        discarding = true;
        buffer = '';
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (discarding) controller.enqueue(OVERSIZED_MESSAGE);
      else if (buffer !== '') emit(buffer, controller);
      buffer = '';
    },
  });
  const encoder = new TextEncoder();
  const out = options.writable.getWriter();
  const writable = new WritableStream<string>({
    write: (message) => out.write(encoder.encode(`${message}\n`)),
    close: () => out.close(),
    abort: (reason) => out.abort(reason),
  });
  return { readable: options.readable.pipeThrough(lines), writable };
}
