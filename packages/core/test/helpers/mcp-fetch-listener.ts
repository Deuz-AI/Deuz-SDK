/**
 * mcp-fetch-listener.ts — put a fetch-native handler (`(Request) => Response`,
 * e.g. `DeuzMcpServer.fetch`) on a real `node:http` port, so a client that knows
 * nothing about the handler talks to it through real sockets and real SSE
 * framing: what a Node host does with a framework adapter, minus the framework.
 *
 * A client that hangs up aborts the `Request`'s signal, which is how a
 * long-lived response stream (a `subscriptions/listen` SSE stream) learns to
 * end. `close()` destroys every socket so the vitest worker never keeps a port.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface FetchListener {
  /** The endpoint, e.g. `http://127.0.0.1:41234/mcp`. */
  url: string;
  close(): Promise<void>;
}

export async function listenFetch(
  handler: (request: Request) => Promise<Response>,
  path = '/mcp',
): Promise<FetchListener> {
  const sockets = new Set<Socket>();

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else if (value !== undefined) headers.set(key, value);
    }
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort();
    });
    const method = req.method ?? 'GET';
    try {
      const response = await handler(
        new Request(`http://127.0.0.1${req.url ?? '/'}`, {
          method,
          headers,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
          signal: aborter.signal,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  const server = createServer((req, res) => void serve(req, res));
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${path}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
