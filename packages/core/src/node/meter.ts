/**
 * `@deuz-sdk/core/meter/node` (2.5): deuz meter as a local `node:http`
 * server, plus a JSONL receipt file.
 *
 * ```ts
 * import { createMeterProxy, createJsonlReceiptSink } from '@deuz-sdk/core/meter/node';
 * import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';
 *
 * const proxy = createMeterProxy({
 *   budget: {
 *     store: createSqliteBudgetStore({ path: '.deuz/budget.sqlite' }),
 *     scopes: [{ key: 'dev:me', limits: { usd: 20 }, window: { ms: 86_400_000 } }],
 *   },
 *   receipts: createJsonlReceiptSink({ path: '.deuz/meter.jsonl' }),
 * });
 * const { url } = await proxy.listen({ port: 8787 });
 * // ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
 * // OPENAI_BASE_URL=http://127.0.0.1:8787/v1 codex
 * ```
 *
 * The server binds 127.0.0.1 unless told otherwise: the meter forwards the
 * caller's own credentials, and a wildcard bind would offer that relay to the
 * network. Request bodies are read once into the handler; response bodies
 * are written chunk by chunk with backpressure, never buffered whole. A client
 * that disconnects aborts the upstream request and its hold is settled
 * fail-closed. Node-only: built-ins are reached through a lazy
 * `await import('node:…')`.
 */
import { createMeterHandler } from '../meter/handler';
import { MeterError } from '../meter/errors';
import type { MeterHandler, MeterOptions, MeterReceipt, MeterStats } from '../meter/types';

export type * from '../meter/types';

// Minimal node builtin shapes; the `as string` specifiers keep tsup's dts
// builder from statically resolving node: (matches node/mcp.ts).
interface NodeIncoming extends AsyncIterable<Uint8Array> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  destroy(error?: Error): void;
}
interface NodeOutgoing {
  writeHead(status: number, headers: Record<string, string | string[]>): void;
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
  readonly writableEnded: boolean;
  readonly headersSent: boolean;
  on(event: 'close' | 'drain', listener: () => void): void;
  off(event: 'close' | 'drain', listener: () => void): void;
}
interface NodeServer {
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number; address: string } | string | null;
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
  on(event: 'error', listener: (err: Error) => void): void;
  off(event: 'error', listener: (err: Error) => void): void;
}
interface NodeHttp {
  createServer(handler: (req: NodeIncoming, res: NodeOutgoing) => void): NodeServer;
}
interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  appendFile(
    path: string,
    data: string,
    options: { encoding: string; mode: number },
  ): Promise<void>;
}

/** Options of `createMeterProxy`: the handler's, plus where to listen. */
export interface MeterProxyOptions extends MeterOptions {
  /** Bind address; default `127.0.0.1`. */
  readonly host?: string;
  /** Port; default 0 (the OS picks a free one). */
  readonly port?: number;
}

/** Where a proxy listens. */
export interface MeterProxyAddress {
  readonly host: string;
  readonly port: number;
  /** `http://<host>:<port>`: the value for `ANTHROPIC_BASE_URL` (append `/v1` for `OPENAI_BASE_URL`). */
  readonly url: string;
}

/** A local meter server. */
export interface MeterProxy {
  /** Start listening; resolves with the bound address. Rejects with `MeterError('listen_failed')`. */
  listen(options?: { host?: string; port?: number }): Promise<MeterProxyAddress>;
  /**
   * Stop accepting connections, let requests in flight finish (or, with
   * `force`, cut them, which settles their holds fail-closed), then wait for
   * every settlement and receipt. Idempotent.
   */
  close(options?: { force?: boolean }): Promise<void>;
  /** The handler's stats snapshot. */
  stats(): MeterStats;
  /** The bound address while listening. */
  readonly address: MeterProxyAddress | undefined;
  /** The fetch-style handler the server runs. */
  readonly handler: MeterHandler;
}

const NO_BODY = new Set(['GET', 'HEAD']);

function toRequest(req: NodeIncoming, origin: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = (req.method ?? 'GET').toUpperCase();
  let body: ReadableStream<Uint8Array> | undefined;
  if (!NO_BODY.has(method)) {
    const iterator = req[Symbol.asyncIterator]();
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        req.destroy();
      },
    });
  }
  // `duplex` is required by Node's fetch for a streamed body and missing from the DOM lib.
  const init = { method, headers, signal, ...(body ? { body, duplex: 'half' } : {}) };
  return new Request(`${origin}${req.url ?? '/'}`, init as RequestInit);
}

async function writeResponse(response: Response, res: NodeOutgoing, method: string): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body || method === 'HEAD') {
    await response.body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let gone = false;
  const onClose = () => {
    if (res.writableEnded) return;
    gone = true;
    void reader.cancel().catch(() => undefined);
  };
  res.on('close', onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || gone) break;
      if (!res.write(value))
        await new Promise<void>((resolve) => {
          const resume = () => {
            res.off('drain', resume);
            res.off('close', resume);
            resolve();
          };
          res.on('drain', resume);
          res.on('close', resume);
        });
    }
    if (!gone) res.end();
  } catch {
    // The upstream broke mid-body: cut the connection so the client sees it.
    if (!res.writableEnded) res.destroy();
  } finally {
    res.off('close', onClose);
  }
}

const formatHost = (host: string) => (host.includes(':') ? `[${host}]` : host);

/**
 * deuz meter on a local `node:http` server (2.5). `listen` binds
 * 127.0.0.1 by default (port 0 picks a free port); `close` drains it. All
 * metering happens in the fetch-style handler (`createMeterHandler`), whose
 * options this takes; inject `deps.fetch` and `deps.clock` there.
 */
export function createMeterProxy(options: MeterProxyOptions = {}): MeterProxy {
  const handler = createMeterHandler(options);
  let server: NodeServer | undefined;
  let address: MeterProxyAddress | undefined;
  let stopping: Promise<void> | undefined;
  const active = new Set<Promise<void>>();

  async function serve(req: NodeIncoming, res: NodeOutgoing, origin: string): Promise<void> {
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      const response = await handler.fetch(toRequest(req, origin, controller.signal));
      await writeResponse(response, res, method);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end();
      } else if (!res.writableEnded) res.destroy();
    } finally {
      res.off('close', onClose);
    }
  }

  return {
    get address() {
      return address;
    },
    handler,
    stats: () => handler.stats(),
    async listen(listenOptions = {}) {
      if (server) throw new MeterError('listen_failed', 'The meter proxy is already listening.');
      if (stopping) throw new MeterError('listen_failed', 'The meter proxy was closed.');
      const host = listenOptions.host ?? options.host ?? '127.0.0.1';
      const port = listenOptions.port ?? options.port ?? 0;
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
        throw new MeterError('invalid_options', 'port must be an integer from 0 to 65535.');
      const http = (await import('node:http' as string)) as unknown as NodeHttp;
      let origin = '';
      const created = http.createServer((req, res) => {
        const task = serve(req, res, origin);
        active.add(task);
        void task.finally(() => active.delete(task));
      });
      await new Promise<void>((resolve, reject) => {
        const fail = (err: Error) => {
          reject(
            Object.assign(
              new MeterError(
                'listen_failed',
                `Could not listen on ${host}:${port}: ${err.message}`,
              ),
              { cause: err },
            ),
          );
        };
        created.on('error', fail);
        created.listen(port, host, () => {
          created.off('error', fail);
          resolve();
        });
      });
      const bound = created.address();
      const boundPort = typeof bound === 'object' && bound ? bound.port : port;
      address = Object.freeze({
        host,
        port: boundPort,
        url: `http://${formatHost(host)}:${boundPort}`,
      });
      origin = address.url;
      server = created;
      return address;
    },
    close(closeOptions = {}) {
      stopping ??= (async () => {
        const current = server;
        if (current) {
          const closed = new Promise<void>((resolve) => current.close(() => resolve()));
          current.closeIdleConnections?.();
          if (closeOptions.force) current.closeAllConnections?.();
          await Promise.allSettled([...active]);
          current.closeAllConnections?.();
          await closed;
        }
        await handler.flush();
        server = undefined;
        address = undefined;
      })();
      return stopping;
    },
  };
}

/** Options of `createJsonlReceiptSink`. */
export interface JsonlReceiptSinkOptions {
  /** The file receipts are appended to, one JSON object per line. Parent directories are created. */
  readonly path: string;
}

/** A receipt sink that appends to a JSONL file. */
export interface JsonlReceiptSink {
  (receipt: MeterReceipt): Promise<void>;
  /** Resolves once every receipt handed to the sink so far is written. */
  flush(): Promise<void>;
  readonly path: string;
}

/**
 * Append each receipt as one JSON line (2.5), in the order received. The file
 * is created owner read/write only (0600). Receipts carry no credentials or
 * bodies, but they do show which models ran and what they cost. A failed
 * write rejects that call (the meter reports it to `onError`) and later
 * receipts are still written.
 */
export function createJsonlReceiptSink(options: JsonlReceiptSinkOptions): JsonlReceiptSink {
  if (options === null || typeof options !== 'object' || typeof options.path !== 'string')
    throw new MeterError('invalid_options', 'createJsonlReceiptSink needs a path.');
  const { path } = options;
  if (path === '') throw new MeterError('invalid_options', 'createJsonlReceiptSink needs a path.');
  let fs: Promise<NodeFs> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const parent = cut > 0 ? path.slice(0, cut) : undefined;
  const load = () =>
    (fs ??= (async () => {
      const mod = (await import('node:fs/promises' as string)) as unknown as NodeFs;
      if (parent) await mod.mkdir(parent, { recursive: true });
      return mod;
    })());
  const sink = (receipt: MeterReceipt): Promise<void> => {
    const line = `${JSON.stringify(receipt)}\n`;
    const write = chain.then(async () => {
      const mod = await load().catch((error: unknown) => {
        fs = undefined; // a failed mkdir or import is retried by the next receipt
        throw error;
      });
      await mod.appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    });
    chain = write.catch(() => undefined);
    return write;
  };
  return Object.assign(sink, { flush: () => chain, path });
}
