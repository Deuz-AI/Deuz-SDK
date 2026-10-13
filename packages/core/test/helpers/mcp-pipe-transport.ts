/**
 * mcp-pipe-transport.ts — an MCP client transport over two in-process streams,
 * speaking the stdio binding's framing (one JSON-RPC message per line).
 *
 * `stdioPipe()` returns the server's ends (`stdin`/`stdout`, for
 * `serveMcpStdio`) and a `transport()` factory for the client's ends. The
 * transport satisfies the structural `Transport` both SDK lines accept (`start`,
 * `send`, `close`, `onmessage`/`onclose`/`onerror`), so a v1 and a v2 `Client`
 * can drive a stdio server with no child process. It is "stdio-shaped" from the
 * v2 client's point of view: a `server/discover` probe runs in place on it.
 */
import { PassThrough } from 'node:stream';

type JsonRpcMessage = Record<string, unknown>;

export interface PipeTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

export interface StdioPipe {
  /** What the server reads — hand to `serveMcpStdio({ stdin })`. */
  stdin: PassThrough;
  /** What the server writes — hand to `serveMcpStdio({ stdout })`. */
  stdout: PassThrough;
  /** Every line the server wrote, parsed — for asserting what went on the wire. */
  written: JsonRpcMessage[];
  /** The client side. One transport per pipe: it owns the stream listeners. */
  transport(): PipeTransport;
}

export function stdioPipe(): StdioPipe {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: JsonRpcMessage[] = [];

  const transport = (): PipeTransport => {
    let buffer = '';
    let closed = false;
    const t: PipeTransport = {
      async start() {
        stdout.setEncoding('utf8');
        stdout.on('data', (chunk: string) => {
          buffer += chunk;
          for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            try {
              const message = JSON.parse(line) as JsonRpcMessage;
              written.push(message);
              t.onmessage?.(message);
            } catch (error) {
              t.onerror?.(error as Error);
            }
          }
        });
        stdout.on('end', () => {
          if (!closed) {
            closed = true;
            t.onclose?.();
          }
        });
      },
      async send(message) {
        stdin.write(`${JSON.stringify(message)}\n`);
      },
      async close() {
        if (closed) return;
        closed = true;
        stdin.end();
        t.onclose?.();
      },
    };
    return t;
  };

  return { stdin, stdout, written, transport };
}
