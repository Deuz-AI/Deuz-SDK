/**
 * Loopback Streamable HTTP for the ledger: a `node:http` listener on 127.0.0.1
 * that hands each request on `/mcp` to `server.fetch`. It refuses any request
 * whose `Host` is not a loopback name, and any browser request whose `Origin`
 * is not loopback, so a web page cannot reach the ledger through DNS
 * rebinding. There is no authentication: every local process can call it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DeuzMcpServer } from '@deuz-sdk/core/mcp/server';
import { McpLedgerError } from './errors';

/** Options of {@link serveMcpLedgerHttp}. */
export interface LedgerHttpOptions {
  /** TCP port; 0 picks a free one. */
  port: number;
  /** A loopback address: `'127.0.0.1'` (default), `'::1'` or `'localhost'`. */
  host?: '127.0.0.1' | '::1' | 'localhost';
  /** The endpoint path. Default `'/mcp'`. */
  path?: string;
}

/** A running listener. */
export interface LedgerHttpHandle {
  /** The endpoint URL, e.g. `http://127.0.0.1:3741/mcp`. */
  readonly url: string;
  readonly port: number;
  /** Stop listening and drop open connections. Does not close the MCP server. */
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function toRequest(
  req: IncomingMessage,
  base: string,
  signal: AbortSignal,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  let body: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk as Uint8Array);
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(new URL(req.url ?? '/', base), {
    method,
    headers,
    signal,
    ...(body !== undefined ? { body } : {}),
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.();
  if (cookies && cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

/**
 * Serve `server` over Streamable HTTP on a loopback address. Resolves once
 * listening.
 *
 * @throws McpLedgerError `invalid_option` for a host that is not loopback.
 */
export async function serveMcpLedgerHttp(
  server: DeuzMcpServer,
  options: LedgerHttpOptions,
): Promise<LedgerHttpHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new McpLedgerError(
      'invalid_option',
      `The ledger only listens on loopback, not '${String(host)}'.`,
    );
  }
  const path = options.path ?? '/mcp';
  const urlHost = host === '::1' ? '[::1]' : host;

  const listener = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    void (async () => {
      try {
        const hostname = hostnameOf(req.headers.host);
        if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
          res
            .writeHead(403, { 'content-type': 'text/plain' })
            .end('Forbidden: loopback Host only.');
          return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !isLoopbackOrigin(origin)) {
          res
            .writeHead(403, { 'content-type': 'text/plain' })
            .end('Forbidden: cross-origin request.');
          return;
        }
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== path) {
          res
            .writeHead(404, { 'content-type': 'text/plain' })
            .end(`Not found. The MCP endpoint is ${path}.`);
          return;
        }
        const request = await toRequest(req, `http://${req.headers.host}`, controller.signal);
        await writeResponse(res, await server.fetch(request));
      } catch {
        if (res.headersSent) res.end();
        else res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal error.');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(options.port, host, () => {
      listener.off('error', reject);
      resolve();
    });
  });
  const address = listener.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    url: `http://${urlHost}:${port}${path}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.closeAllConnections?.();
        listener.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
