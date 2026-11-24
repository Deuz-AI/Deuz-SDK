/**
 * acp/peer.ts — `createAcpPeer`: a symmetric JSON-RPC 2.0 endpoint over an
 * {@link AcpTransport} (2.5). Both sides of ACP are one of these: each sends
 * requests and notifications and answers the other's. The agent and client
 * APIs (`serveAcpAgent`, `connectAcpAgent`) are handler tables on top of it;
 * use it directly for extension methods or a role this module does not model.
 *
 * - Requests are answered concurrently, in whatever order their handlers end.
 *   Notifications are handled one at a time, in arrival order, without holding
 *   up the reading of responses (a notification handler may itself await a
 *   request).
 * - Malformed input never kills the connection: a line that is not JSON is
 *   answered `-32700`, a message that is not a JSON-RPC 2.0 object `-32600`, an
 *   unknown method `-32601`; a response to no pending request is dropped
 *   (reported to `onError`, unless it answers a request this side cancelled).
 * - Cancellation is ACP's `$/cancel_request`, both ways: an aborted outgoing
 *   request sends it, and an incoming one aborts its handler's `signal`. A
 *   handler that ends after its signal aborted is answered `-32800`.
 *
 * Edge-safe.
 */
import { AcpError } from './errors';
import { ACP_CANCEL_REQUEST_METHOD, ACP_ERROR_CODES } from './protocol';
import { OVERSIZED_MESSAGE, type AcpTransport } from './transport';
import type { AcpErrorObject, AcpJsonRpcMessage, AcpRequestId } from './types';

/** What a request handler is told besides the params. */
export interface AcpRequestContext {
  readonly id: AcpRequestId;
  readonly method: string;
  /** Aborted when the peer sends `$/cancel_request` for this request, or the connection closes. */
  readonly signal: AbortSignal;
}

/**
 * Answers one request: return the result (`undefined` is sent as `null`), or
 * throw. An {@link AcpError} of kind `'rpc'` is sent as that error; anything
 * else as `-32603 Internal error`, its message kept on this side (`onError`).
 */
export type AcpRequestHandler = (params: unknown, context: AcpRequestContext) => unknown;

/** Handles one notification. A throw is reported to `onError` and otherwise ignored. */
export type AcpNotificationHandler = (
  params: unknown,
  context: { readonly method: string },
) => void | Promise<void>;

export interface AcpPeerOptions {
  transport: AcpTransport;
  /** Request handlers by method. A method without one is answered `-32601`. */
  requests?: Record<string, AcpRequestHandler>;
  /** Notification handlers by method. Others are ignored, as the spec asks. */
  notifications?: Record<string, AcpNotificationHandler>;
  /**
   * Called for a request no entry of `requests` handles, before it is
   * answered `-32601`: return `undefined` to decline, or a handler. This is
   * where extension methods (`_vendor/...`) go.
   */
  fallback?: (method: string) => AcpRequestHandler | undefined;
  /**
   * Gate every incoming request before its handler: throw an `AcpError` to
   * answer with it (an agent refuses requests before `initialize` here).
   */
  guard?: (method: string) => void;
  /** Everything the peer could not hand to anyone: handler crashes, malformed input, write failures. */
  onError?: (error: unknown) => void;
}

/** One end of a JSON-RPC connection. */
export interface AcpPeer {
  /**
   * Send a request and wait for its result. Rejects with an {@link AcpError}:
   * `rpc` for an error answer, `closed` when the connection ends first,
   * `cancelled` when `signal` aborts (the peer is sent `$/cancel_request`).
   */
  request<R = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
  /** Send a notification. Rejects only when it could not be written. */
  notify(method: string, params?: unknown): Promise<void>;
  /** Resolves once every notification received so far has been handled. */
  drain(): Promise<void>;
  /** Resolves when the connection has closed, from either side. */
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  /** Close the connection: pending requests reject (`closed`), in-flight handlers are aborted. */
  close(): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is AcpRequestId =>
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  value === null;

/** Open a JSON-RPC endpoint on `transport` and start reading from it at once. */
export function createAcpPeer(options: AcpPeerOptions): AcpPeer {
  const { transport } = options;
  if (
    !(transport?.readable instanceof ReadableStream) ||
    !(transport.writable instanceof WritableStream)
  ) {
    throw new TypeError('createAcpPeer: transport needs a readable and a writable web stream.');
  }
  const requests = options.requests ?? {};
  const notifications = options.notifications ?? {};
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // A reporting hook must never take the connection down.
    }
  };

  const writer = transport.writable.getWriter();
  const reader = transport.readable.getReader();
  const pending = new Map<string | number, Pending>();
  /**
   * Requests this side cancelled (`$/cancel_request`). The spec has the peer
   * still answer them (a result or -32800); that late answer is dropped quietly.
   */
  const abandoned = new Set<string | number>();
  const inflight = new Map<string, AbortController>();
  let nextId = 0;
  let closed = false;
  let notificationQueue: Promise<void> = Promise.resolve();
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => (resolveClosed = resolve));

  let writeQueue: Promise<void> = Promise.resolve();
  const send = (message: AcpJsonRpcMessage): Promise<void> => {
    if (closed) {
      return Promise.reject(
        new AcpError({ kind: 'closed', message: 'The ACP connection is closed.' }),
      );
    }
    const text = JSON.stringify(message);
    const write = writeQueue.then(() => writer.write(text));
    writeQueue = write.catch(() => undefined);
    return write.catch((error: unknown) => {
      throw new AcpError({
        kind: 'closed',
        message: 'The ACP message could not be written: the connection is closed.',
        cause: error,
      });
    });
  };
  const sendQuietly = (message: AcpJsonRpcMessage) => {
    send(message).catch((error: unknown) => {
      if (!closed) report(error);
    });
  };
  const sendError = (id: AcpRequestId, error: AcpErrorObject) =>
    sendQuietly({ jsonrpc: '2.0', id, error });

  const inflightKey = (id: AcpRequestId) => JSON.stringify(id);

  async function answer(id: AcpRequestId, method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    const key = inflightKey(id);
    inflight.set(key, controller);
    try {
      options.guard?.(method);
      const handler = requests[method] ?? options.fallback?.(method);
      if (!handler) {
        throw new AcpError({
          message: 'Method not found',
          rpcCode: ACP_ERROR_CODES.methodNotFound,
        });
      }
      const result = await handler(params, { id, method, signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      sendQuietly({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    } catch (error) {
      if (closed) return;
      if (error instanceof AcpError && error.kind === 'rpc') {
        sendError(id, {
          code: error.rpcCode ?? ACP_ERROR_CODES.internalError,
          message: error.message,
          ...(error.data !== undefined ? { data: error.data } : {}),
        });
      } else if (controller.signal.aborted) {
        sendError(id, { code: ACP_ERROR_CODES.requestCancelled, message: 'Request cancelled' });
      } else {
        report(error);
        sendError(id, { code: ACP_ERROR_CODES.internalError, message: 'Internal error' });
      }
    } finally {
      if (inflight.get(key) === controller) inflight.delete(key);
    }
  }

  function notified(method: string, params: unknown): void {
    if (method === ACP_CANCEL_REQUEST_METHOD) {
      if (isRecord(params) && isId(params.requestId)) {
        inflight
          .get(inflightKey(params.requestId))
          ?.abort(new AcpError({ kind: 'cancelled', message: 'The peer cancelled the request.' }));
      }
      return;
    }
    const handler = notifications[method];
    if (!handler) return;
    notificationQueue = notificationQueue.then(async () => {
      try {
        await handler(params, { method });
      } catch (error) {
        report(error);
      }
    });
  }

  function received(text: string): void {
    if (text === OVERSIZED_MESSAGE) {
      sendError(null, { code: ACP_ERROR_CODES.invalidRequest, message: 'Message too large' });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      sendError(null, { code: ACP_ERROR_CODES.parseError, message: 'Parse error' });
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      const id = isRecord(message) && isId(message.id) ? message.id : null;
      sendError(id, { code: ACP_ERROR_CODES.invalidRequest, message: 'Invalid request' });
      return;
    }
    if (typeof message.method === 'string') {
      if ('id' in message) {
        if (!isId(message.id)) {
          sendError(null, { code: ACP_ERROR_CODES.invalidRequest, message: 'Invalid request' });
          return;
        }
        void answer(message.id, message.method, message.params);
      } else {
        notified(message.method, message.params);
      }
      return;
    }
    if ('id' in message && ('result' in message || 'error' in message)) {
      const id = message.id;
      const waiter = typeof id === 'string' || typeof id === 'number' ? pending.get(id) : undefined;
      if (!waiter && (typeof id === 'string' || typeof id === 'number') && abandoned.delete(id)) {
        return;
      }
      if (!waiter) {
        report(
          new AcpError({
            kind: 'protocol',
            message: `A response to no pending request (id ${JSON.stringify(id)}).`,
          }),
        );
        return;
      }
      pending.delete(id as string | number);
      if ('error' in message) {
        const error = isRecord(message.error) ? message.error : {};
        waiter.reject(
          new AcpError({
            message:
              typeof error.message === 'string'
                ? error.message
                : 'The peer answered with an error.',
            rpcCode: typeof error.code === 'number' ? error.code : ACP_ERROR_CODES.internalError,
            data: error.data,
          }),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    const id = isId(message.id) ? message.id : null;
    sendError(id, { code: ACP_ERROR_CODES.invalidRequest, message: 'Invalid request' });
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    const error = new AcpError({ kind: 'closed', message: 'The ACP connection closed.' });
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    abandoned.clear();
    for (const controller of inflight.values()) controller.abort(error);
    inflight.clear();
    resolveClosed();
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (typeof value === 'string') received(value);
      }
    } catch (error) {
      if (!closed) report(error);
    } finally {
      shutdown();
      reader.releaseLock();
      await writeQueue;
      await writer.close().catch(() => undefined);
    }
  })();

  return {
    request<R>(
      method: string,
      params?: unknown,
      requestOptions?: { signal?: AbortSignal },
    ): Promise<R> {
      const signal = requestOptions?.signal;
      if (closed) {
        return Promise.reject(
          new AcpError({ kind: 'closed', message: 'The ACP connection is closed.' }),
        );
      }
      if (signal?.aborted) {
        return Promise.reject(
          new AcpError({
            kind: 'cancelled',
            message: `${method} was cancelled.`,
            cause: signal.reason,
          }),
        );
      }
      nextId += 1;
      const id = nextId;
      return new Promise<R>((resolve, reject) => {
        const onAbort = () => {
          if (!pending.delete(id)) return;
          abandoned.add(id);
          sendQuietly({
            jsonrpc: '2.0',
            method: ACP_CANCEL_REQUEST_METHOD,
            params: { requestId: id },
          });
          reject(
            new AcpError({
              kind: 'cancelled',
              message: `${method} was cancelled.`,
              cause: signal?.reason,
            }),
          );
        };
        pending.set(id, {
          resolve: (value) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(value as R);
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }).catch(
          (error: unknown) => {
            if (pending.delete(id)) {
              signal?.removeEventListener('abort', onAbort);
              reject(error);
            }
          },
        );
      });
    },
    notify(method: string, params?: unknown): Promise<void> {
      return send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    },
    drain: () => notificationQueue,
    closed: closedPromise,
    get isClosed() {
      return closed;
    },
    async close(): Promise<void> {
      if (closed) return;
      shutdown();
      await reader.cancel().catch(() => undefined);
      await writeQueue;
      await writer.close().catch(() => undefined);
    },
  };
}
