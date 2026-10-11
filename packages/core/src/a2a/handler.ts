/**
 * a2a/handler.ts — `createA2AHandler`: an A2A v1.0.0 agent as a fetch-style
 * handler (2.3). Edge-safe: `Request`, `Response`, `URL`, `ReadableStream`.
 *
 * Error codes, reasons and HTTP statuses follow `@a2a-js/sdk` 1.3.0's server.
 * NOT LIVE-VERIFIED against third-party clients beyond that SDK's.
 */
import { InvalidRequestError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { isOwnProtocolError, type A2AError } from './errors';
import {
  A2A_CONTENT_TYPE,
  A2A_ERROR_DOMAIN,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
  ERROR_INFO_TYPE,
  JSON_CONTENT_TYPE,
  REASON_WIRE,
  SSE_CONTENT_TYPE,
  isRecord,
  roleName,
  type A2AErrorReason,
} from './protocol';
import {
  createTaskRuntime,
  protocolError,
  withHistory,
  type TurnInfo,
  type TurnSink,
} from './runtime';
import { createInMemoryA2ATaskStore } from './task-store';
import type {
  A2AAgentCard,
  A2AExecutor,
  A2AHandler,
  A2AHandlerOptions,
  A2AMessage,
  A2ASendMessageConfiguration,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2AStreamResponse,
  A2ATaskScope,
} from './types';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

type JsonRpcId = string | number | null;

class BodyTooLargeError extends Error {}

/** The request body broke off (the client went away mid-upload). */
class BodyReadError extends Error {}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

function pathOf(url: string): string {
  return normalizePath(new URL(url, 'http://agent.invalid').pathname);
}

/** The media type of a `Content-Type` header, lower-cased, without parameters. */
function mediaType(header: string | null): string | undefined {
  if (header === null) return undefined;
  return header.split(';', 1)[0]?.trim().toLowerCase();
}

async function readBody(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      throw new BodyReadError('The request body could not be read.', { cause: error });
    }
    const { done, value } = next;
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function json(body: unknown, status = 200, contentType = JSON_CONTENT_TYPE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  });
}

/** The `ErrorInfo` detail of an A2A error, for the reasons that carry one. */
function errorInfo(error: A2AError): Record<string, unknown>[] {
  const reason = error.reason ?? 'INTERNAL_ERROR';
  if (REASON_WIRE[reason as A2AErrorReason]?.info === false) return [];
  return [
    {
      '@type': ERROR_INFO_TYPE,
      reason,
      domain: A2A_ERROR_DOMAIN,
      ...(error.metadata ? { metadata: error.metadata } : {}),
    },
  ];
}

function rpcErrorObject(error: A2AError): Record<string, unknown> {
  const data = errorInfo(error);
  return {
    code: error.rpcCode ?? REASON_WIRE.INTERNAL_ERROR.rpc,
    message: error.message,
    ...(data.length > 0 ? { data } : {}),
  };
}

function rpcError(id: JsonRpcId, error: A2AError, status?: number): Response {
  const body = { jsonrpc: '2.0', id, error: rpcErrorObject(error) };
  const code = body.error.code;
  return json(body, status ?? (code === REASON_WIRE.INTERNAL_ERROR.rpc ? 500 : 200));
}

type QueueItem =
  | { kind: 'event'; event: A2AStreamResponse }
  | { kind: 'error'; error: A2AError }
  | { kind: 'end' };

/** Holds a turn's events until the response stream pulls them. */
function eventQueue() {
  const items: QueueItem[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (item: QueueItem) => {
    if (closed) return;
    items.push(item);
    wake?.();
    wake = undefined;
  };
  const sink: TurnSink = {
    event: (event) => push({ kind: 'event', event }),
    end: () => push({ kind: 'end' }),
    error: (error) => push({ kind: 'error', error }),
    get closed() {
      return closed;
    },
  };
  return {
    sink,
    async next(): Promise<QueueItem> {
      while (items.length === 0) {
        if (closed) return { kind: 'end' };
        await new Promise<void>((resolve) => (wake = resolve));
      }
      return items.shift() as QueueItem;
    },
    /** The response is done (or the client went away): drop the rest. */
    close() {
      closed = true;
      items.length = 0;
      wake?.();
      wake = undefined;
    },
  };
}

const SSE_HEADERS = {
  'Content-Type': SSE_CONTENT_TYPE,
  'Cache-Control': 'no-cache',
  'X-Accel-Buffering': 'no',
};

/** How one binding writes a stream. */
interface StreamFraming {
  /** The `data:` JSON of an event. */
  event(event: A2AStreamResponse): unknown;
  /** The `data:` JSON of an `event: error`. */
  error(error: A2AError): unknown;
  /** The answer to a stream refused before its first event. */
  errorResponse(error: A2AError): Response;
}

/**
 * Answers a streaming request. `open` attaches the stream's sink (or refuses
 * the request); a refusal or an error before the first event is answered as
 * a plain error, anything later as SSE, ending with `event: error` when the
 * turn fails.
 */
async function streamResponse(
  open: (sink: TurnSink) => Promise<void>,
  framing: StreamFraming,
  asError: (error: unknown) => A2AError,
): Promise<Response> {
  const queue = eventQueue();
  try {
    await open(queue.sink);
  } catch (error) {
    queue.close();
    return framing.errorResponse(asError(error));
  }
  let pending: QueueItem | undefined = await queue.next();
  if (pending.kind === 'error') {
    queue.close();
    return framing.errorResponse(pending.error);
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = pending ?? (await queue.next());
      pending = undefined;
      if (item.kind === 'event') {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(framing.event(item.event))}\n\n`),
        );
        return;
      }
      if (item.kind === 'error') {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify(framing.error(item.error))}\n\n`),
        );
      }
      queue.close();
      controller.close();
    },
    cancel() {
      queue.close();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

/** JSON-RPC streams: every event is a response to the request's id. */
function rpcFraming(id: JsonRpcId, historyLength: number | undefined): StreamFraming {
  return {
    event: (event) => ({
      jsonrpc: '2.0',
      id,
      result: event.task ? { task: withHistory(event.task, historyLength) } : event,
    }),
    error: (error) => ({ jsonrpc: '2.0', id, error: rpcErrorObject(error) }),
    errorResponse: (error) => rpcError(id, error),
  };
}

/** An A2A error as an HTTP+JSON error: the HTTP status and a `google.rpc.Status` body. */
function restErrorBody(error: A2AError): { status: number; body: unknown } {
  const wire = REASON_WIRE[(error.reason ?? 'INTERNAL_ERROR') as A2AErrorReason];
  const status = wire?.http ?? 500;
  return {
    status,
    body: {
      error: {
        code: status,
        status: wire?.status ?? 'UNKNOWN',
        message: error.message,
        details: errorInfo(error),
      },
    },
  };
}

function restError(error: A2AError): Response {
  const { status, body } = restErrorBody(error);
  return json(body, status, A2A_CONTENT_TYPE);
}

function restResult(body: unknown): Response {
  return json(body, 200, A2A_CONTENT_TYPE);
}

/** HTTP+JSON streams: every event is a bare `StreamResponse`. */
function restFraming(historyLength: number | undefined): StreamFraming {
  return {
    event: (event) => (event.task ? { task: withHistory(event.task, historyLength) } : event),
    error: (error) => restErrorBody(error).body,
    errorResponse: restError,
  };
}

/** A route of the HTTP+JSON binding, below the interface's path. */
type RestRoute =
  | { kind: 'send' | 'stream' | 'list' | 'push' | 'extendedCard' }
  | { kind: 'get' | 'cancel' | 'subscribe'; taskId: string };

const ROUTE_STARTS = new Set(['message:send', 'message:stream', 'tasks', 'extendedAgentCard']);

/**
 * The route, its allowed methods and the tenant of a path below an HTTP+JSON
 * interface: `/message:send`, `/tasks/{id}:cancel`, ... with an optional
 * `/{tenant}` first segment.
 */
function parseRestPath(
  remainder: string,
): { route: RestRoute; allow: string[]; tenant: string | undefined } | undefined {
  const parts: string[] = [];
  for (const segment of remainder.split('/')) {
    if (segment === '') continue;
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  const tenant =
    parts.length > 0 && !ROUTE_STARTS.has(parts[0] as string) ? parts.shift() : undefined;
  const [first, second, third] = parts;
  const at = (route: RestRoute, ...allow: string[]) => ({ route, allow, tenant });
  if (parts.length === 1 && first === 'message:send') return at({ kind: 'send' }, 'POST');
  if (parts.length === 1 && first === 'message:stream') return at({ kind: 'stream' }, 'POST');
  if (parts.length === 1 && first === 'extendedAgentCard') {
    return at({ kind: 'extendedCard' }, 'GET');
  }
  if (first !== 'tasks') return undefined;
  if (parts.length === 1) return at({ kind: 'list' }, 'GET');
  if (third === 'pushNotificationConfigs' && parts.length <= 4) {
    return at({ kind: 'push' }, 'GET', 'POST', 'DELETE');
  }
  if (parts.length !== 2 || second === undefined) return undefined;
  if (second.endsWith(':cancel')) {
    return at({ kind: 'cancel', taskId: second.slice(0, -':cancel'.length) }, 'POST');
  }
  if (second.endsWith(':subscribe')) {
    return at({ kind: 'subscribe', taskId: second.slice(0, -':subscribe'.length) }, 'GET', 'POST');
  }
  return at({ kind: 'get', taskId: second }, 'GET');
}

/** The path below `base`, or `undefined` when `path` is not under it. */
function below(base: string, path: string): string | undefined {
  if (base === '/') return path;
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length) : undefined;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isInteger(value))
  );
}

function invalidParams(message: string): A2AError {
  return protocolError('INVALID_PARAMS', message);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalidParams(`${field} must be a string.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value, field);
  if (text === undefined || text.trim() === '') throw invalidParams(`${field} is required.`);
  return text;
}

function optionalHistoryLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidParams('historyLength must be a non-negative integer.');
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidParams(`${field} must be an object.`);
  return value;
}

/** The message of a SendMessage request, checked and with its role named. */
function parseMessage(value: unknown): A2AMessage {
  if (!isRecord(value)) throw invalidParams('message is required.');
  const messageId = requiredString(value.messageId, 'message.messageId');
  const parts = value.parts ?? [];
  if (!Array.isArray(parts)) throw invalidParams('message.parts must be a list.');
  for (const part of parts) {
    const kinds = isRecord(part)
      ? ['text', 'raw', 'url', 'data'].filter((kind) => part[kind] !== undefined)
      : [];
    if (kinds.length !== 1) {
      throw invalidParams('Each message part needs exactly one of text, raw, url or data.');
    }
  }
  const { taskId: _taskId, contextId: _contextId, ...rest } = value;
  const taskId = optionalString(value.taskId, 'message.taskId');
  const contextId = optionalString(value.contextId, 'message.contextId');
  return {
    ...(rest as unknown as A2AMessage),
    messageId,
    role: value.role === undefined ? 'ROLE_USER' : roleName(value.role),
    parts,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(contextId !== undefined ? { contextId } : {}),
  };
}

function parseSendMessageRequest(
  params: Record<string, unknown>,
  tenant: string | undefined,
): A2ASendMessageRequest {
  const message = parseMessage(params.message);
  const configuration = optionalRecord(params.configuration, 'configuration') as
    | A2ASendMessageConfiguration
    | undefined;
  optionalHistoryLength(configuration?.historyLength);
  const metadata = optionalRecord(params.metadata, 'metadata');
  return {
    ...(tenant !== undefined ? { tenant } : {}),
    message,
    ...(configuration !== undefined ? { configuration } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Comma-separated extension URIs, de-duplicated. */
function parseExtensions(header: string | null): string[] {
  if (!header) return [];
  return [
    ...new Set(
      header
        .split(',')
        .map((uri) => uri.trim())
        .filter((uri) => uri !== ''),
    ),
  ];
}

function resolveExecutor(executor: A2AHandlerOptions['executor']): A2AExecutor {
  if (typeof executor === 'function') return { execute: executor };
  if (isRecord(executor) && typeof executor.execute === 'function') return executor;
  throw new InvalidRequestError({
    message: 'createA2AHandler needs an executor: a function or { execute, cancel? }.',
  });
}

/** The paths the card's A2A 1.0 interfaces are served at. */
function endpointsOf(card: A2AAgentCard): { jsonrpc: Set<string>; rest: string[] } {
  const jsonrpc = new Set<string>();
  const rest: string[] = [];
  for (const candidate of card.supportedInterfaces) {
    if (!isRecord(candidate) || typeof candidate.url !== 'string') continue;
    if (String(candidate.protocolVersion ?? '').trim() !== A2A_PROTOCOL_VERSION) continue;
    const binding = String(candidate.protocolBinding).toUpperCase();
    let path: string;
    try {
      path = pathOf(candidate.url);
    } catch {
      continue;
    }
    if (binding === 'JSONRPC') jsonrpc.add(path);
    else if (binding === 'HTTP+JSON') rest.push(path);
  }
  return { jsonrpc, rest };
}

/**
 * Serve an A2A agent: the agent card, and the endpoints the card declares.
 *
 * ```ts
 * const handler = createA2AHandler({
 *   card,
 *   executor: async (ctx) => {
 *     await ctx.working();
 *     await ctx.artifact({ parts: [{ text: `You said: ${ctx.message.parts[0]?.text}` }] });
 *     await ctx.complete();
 *   },
 * });
 * export default { fetch: handler };
 * ```
 *
 * Each `JSONRPC` or `HTTP+JSON` interface of the card with
 * `protocolVersion: '1.0'` is served at its URL's path (the host is not
 * matched, so the same card works behind a proxy or on localhost); the card
 * itself is served at `cardPath`. Requests must carry `A2A-Version: 1.0`.
 */
export function createA2AHandler(options: A2AHandlerOptions): A2AHandler {
  const card = options?.card;
  if (
    !isRecord(card) ||
    typeof card.name !== 'string' ||
    !Array.isArray(card.supportedInterfaces)
  ) {
    throw new InvalidRequestError({
      message: 'createA2AHandler needs an agent card with a name and supportedInterfaces.',
    });
  }
  const executor = resolveExecutor(options.executor);
  const endpoints = endpointsOf(card);
  if (endpoints.jsonrpc.size === 0 && endpoints.rest.length === 0) {
    throw new InvalidRequestError({
      message:
        `The agent card of '${card.name}' declares no interface this handler serves: add a ` +
        `supportedInterfaces entry with protocolBinding 'JSONRPC' or 'HTTP+JSON' and protocolVersion '1.0'.`,
    });
  }
  const deps = resolveDependencies(options.deps);
  const report =
    options.onError ??
    ((error: unknown) =>
      deps.logger.error('A2A handler error', {
        error: error instanceof Error ? error.message : String(error),
      }));
  const runtime = createTaskRuntime({
    store: options.taskStore ?? createInMemoryA2ATaskStore(),
    executor,
    deps,
    report,
  });
  // The most specific HTTP+JSON base first, should two be nested.
  const restBases = [...endpoints.rest].sort((left, right) => right.length - left.length);
  const cardPath = normalizePath(options.cardPath ?? AGENT_CARD_PATH);
  const cardJson = JSON.stringify(card);
  const maxBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declaredExtensions = new Set(
    (card.capabilities?.extensions ?? []).map((extension) => extension.uri),
  );
  const requiredExtensions = (card.capabilities?.extensions ?? [])
    .filter((extension) => extension.required)
    .map((extension) => extension.uri);

  /**
   * A protocol error raised here as itself; anything else (another agent's
   * error, say from `executor.cancel`) is reported and answered as an internal error.
   */
  function asProtocolError(error: unknown): A2AError {
    if (isOwnProtocolError(error)) return error;
    report(error);
    return protocolError('INTERNAL_ERROR', 'The agent could not process the request.');
  }

  function versionError(request: Request): A2AError | undefined {
    const requested = request.headers.get(A2A_VERSION_HEADER)?.trim() || '0.3';
    if (requested === A2A_PROTOCOL_VERSION) return undefined;
    return protocolError(
      'VERSION_NOT_SUPPORTED',
      `The requested A2A protocol version '${requested}' is not supported. Supported versions: ` +
        `${A2A_PROTOCOL_VERSION} (send the ${A2A_VERSION_HEADER}: ${A2A_PROTOCOL_VERSION} header).`,
    );
  }

  /** The tenant the request names and the owner `options.owner` sees in it. */
  async function scopeFor(request: Request, tenant: string | undefined): Promise<A2ATaskScope> {
    const owner = options.owner ? await options.owner(request) : undefined;
    return {
      ...(tenant !== undefined ? { tenant } : {}),
      ...(owner !== undefined && owner !== '' ? { owner } : {}),
    };
  }

  function turnInfo(request: Request, scope: A2ATaskScope): TurnInfo {
    const requested = parseExtensions(request.headers.get(A2A_EXTENSIONS_HEADER));
    const missing = requiredExtensions.filter((uri) => !requested.includes(uri));
    if (missing.length > 0) {
      throw protocolError(
        'EXTENSION_SUPPORT_REQUIRED',
        `Client must declare support for required extensions: ${missing.join(', ')}`,
      );
    }
    return {
      scope,
      extensions: requested.filter((uri) => declaredExtensions.has(uri)),
      httpRequest: request,
    };
  }

  function requireStreaming(): void {
    if (card.capabilities?.streaming !== true) {
      throw protocolError('UNSUPPORTED_OPERATION', 'Streaming is not supported by this agent.');
    }
  }

  /** The params of CancelTask, from the binding's parts. */
  function cancelRequest(
    taskId: string,
    tenant: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ) {
    return {
      ...(tenant !== undefined ? { tenant } : {}),
      id: taskId,
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  async function sendMessage(
    params: Record<string, unknown>,
    request: Request,
    scope: A2ATaskScope,
  ): Promise<A2ASendMessageResponse> {
    const sendRequest = parseSendMessageRequest(params, scope.tenant);
    const turn = await runtime.start(sendRequest, turnInfo(request, scope));
    const configuration = sendRequest.configuration;
    const answer = configuration?.returnImmediately
      ? await turn.first.promise
      : await turn.outcome.promise;
    return answer.task ? { task: withHistory(answer.task, configuration?.historyLength) } : answer;
  }

  async function dispatchRpc(
    method: string,
    params: Record<string, unknown>,
    id: JsonRpcId,
    request: Request,
  ): Promise<Response> {
    const tenant = optionalString(params.tenant, 'tenant');
    const scope = await scopeFor(request, tenant);
    switch (method) {
      case 'SendMessage':
        return rpcResult(id, await sendMessage(params, request, scope));
      case 'SendStreamingMessage': {
        requireStreaming();
        const sendRequest = parseSendMessageRequest(params, tenant);
        const info = turnInfo(request, scope);
        return streamResponse(
          async (sink) => {
            await runtime.start(sendRequest, info, sink);
          },
          rpcFraming(id, sendRequest.configuration?.historyLength),
          asProtocolError,
        );
      }
      case 'GetTask': {
        const taskId = requiredString(params.id, 'id');
        const historyLength = optionalHistoryLength(params.historyLength);
        return rpcResult(id, await runtime.getTask(taskId, scope, historyLength));
      }
      case 'CancelTask': {
        const taskId = requiredString(params.id, 'id');
        const metadata = optionalRecord(params.metadata, 'metadata');
        return rpcResult(
          id,
          await runtime.cancel(cancelRequest(taskId, tenant, metadata), scope, request),
        );
      }
      case 'SubscribeToTask': {
        requireStreaming();
        const taskId = requiredString(params.id, 'id');
        return streamResponse(
          (sink) => runtime.subscribe(taskId, scope, sink),
          rpcFraming(id, undefined),
          asProtocolError,
        );
      }
      case 'ListTasks':
        throw protocolError('UNSUPPORTED_OPERATION', 'ListTasks is not supported by this agent.');
      case 'CreateTaskPushNotificationConfig':
      case 'GetTaskPushNotificationConfig':
      case 'ListTaskPushNotificationConfigs':
      case 'DeleteTaskPushNotificationConfig':
        throw protocolError(
          'PUSH_NOTIFICATION_NOT_SUPPORTED',
          'Push notifications are not supported by this agent.',
        );
      case 'GetExtendedAgentCard':
        throw protocolError('UNSUPPORTED_OPERATION', 'This agent has no extended agent card.');
      default:
        throw protocolError('METHOD_NOT_FOUND', `Unknown method '${method}'.`);
    }
  }

  async function handleJsonRpc(request: Request): Promise<Response> {
    const contentType = mediaType(request.headers.get('content-type'));
    if (contentType !== undefined && contentType !== JSON_CONTENT_TYPE) {
      return rpcError(
        null,
        protocolError(
          'CONTENT_TYPE_NOT_SUPPORTED',
          `Unsupported Content-Type '${contentType}'; expected ${JSON_CONTENT_TYPE}.`,
        ),
      );
    }
    let text: string;
    try {
      text = await readBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return rpcError(
          null,
          protocolError('INVALID_REQUEST', `The request body exceeds ${maxBodyBytes} bytes.`),
          413,
        );
      }
      if (error instanceof BodyReadError) {
        return rpcError(null, protocolError('INVALID_REQUEST', error.message), 400);
      }
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcError(null, protocolError('PARSE_ERROR', 'Invalid JSON payload.'));
    }
    const id = isRecord(body) && isJsonRpcId(body.id) ? body.id : null;
    const unsupportedVersion = versionError(request);
    if (unsupportedVersion) return rpcError(id, unsupportedVersion);
    if (
      !isRecord(body) ||
      body.jsonrpc !== '2.0' ||
      typeof body.method !== 'string' ||
      body.method === '' ||
      ('id' in body && !isJsonRpcId(body.id))
    ) {
      return rpcError(id, protocolError('INVALID_REQUEST', 'Invalid JSON-RPC request.'));
    }
    const params = body.params ?? {};
    if (!isRecord(params)) {
      return rpcError(id, invalidParams('params must be an object.'));
    }
    try {
      return await dispatchRpc(body.method, params, id, request);
    } catch (error) {
      return rpcError(id, asProtocolError(error));
    }
  }

  /** The JSON object of an HTTP+JSON request body; an empty body is `{}`. */
  async function restBody(request: Request): Promise<Record<string, unknown>> {
    const text = await readBody(request, maxBodyBytes);
    if (text.trim() === '') return {};
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw invalidParams('Invalid JSON payload.');
    }
    if (!isRecord(body)) throw invalidParams('The request body must be a JSON object.');
    return body;
  }

  function historyLengthQuery(request: Request): number | undefined {
    const value = new URL(request.url).searchParams.get('historyLength');
    if (value === null || value === '') return undefined;
    if (!/^[0-9]+$/.test(value)) {
      throw invalidParams('historyLength must be a non-negative integer.');
    }
    return Number(value);
  }

  async function dispatchRest(
    route: RestRoute,
    tenant: string | undefined,
    request: Request,
  ): Promise<Response> {
    const scope = await scopeFor(request, tenant);
    switch (route.kind) {
      case 'send':
        return restResult(await sendMessage(await restBody(request), request, scope));
      case 'stream': {
        requireStreaming();
        const sendRequest = parseSendMessageRequest(await restBody(request), tenant);
        const info = turnInfo(request, scope);
        return streamResponse(
          async (sink) => {
            await runtime.start(sendRequest, info, sink);
          },
          restFraming(sendRequest.configuration?.historyLength),
          asProtocolError,
        );
      }
      case 'get':
        return restResult(await runtime.getTask(route.taskId, scope, historyLengthQuery(request)));
      case 'cancel': {
        const metadata = optionalRecord((await restBody(request)).metadata, 'metadata');
        return restResult(
          await runtime.cancel(cancelRequest(route.taskId, tenant, metadata), scope, request),
        );
      }
      case 'subscribe': {
        requireStreaming();
        const taskId = route.taskId;
        return streamResponse(
          (sink) => runtime.subscribe(taskId, scope, sink),
          restFraming(undefined),
          asProtocolError,
        );
      }
      case 'list':
        throw protocolError('UNSUPPORTED_OPERATION', 'ListTasks is not supported by this agent.');
      case 'push':
        throw protocolError(
          'PUSH_NOTIFICATION_NOT_SUPPORTED',
          'Push notifications are not supported by this agent.',
        );
      case 'extendedCard':
        throw protocolError('UNSUPPORTED_OPERATION', 'This agent has no extended agent card.');
    }
  }

  async function handleRest(request: Request, remainder: string, path: string): Promise<Response> {
    const parsed = parseRestPath(remainder);
    if (!parsed) return notFound(path);
    if (!parsed.allow.includes(request.method)) return methodNotAllowed(parsed.allow.join(', '));
    try {
      const unsupportedVersion = versionError(request);
      if (unsupportedVersion) throw unsupportedVersion;
      const contentType = mediaType(request.headers.get('content-type'));
      if (
        contentType !== undefined &&
        contentType !== JSON_CONTENT_TYPE &&
        contentType !== A2A_CONTENT_TYPE
      ) {
        throw protocolError(
          'CONTENT_TYPE_NOT_SUPPORTED',
          `Unsupported Content-Type '${contentType}'; expected ${JSON_CONTENT_TYPE} or ${A2A_CONTENT_TYPE}.`,
        );
      }
      return await dispatchRest(parsed.route, parsed.tenant, request);
    } catch (error) {
      if (error instanceof BodyReadError) {
        const { body } = restErrorBody(invalidParams(error.message));
        return json(body, 400, A2A_CONTENT_TYPE);
      }
      if (error instanceof BodyTooLargeError) {
        return json(
          {
            error: {
              code: 413,
              status: 'INVALID_ARGUMENT',
              message: `The request body exceeds ${maxBodyBytes} bytes.`,
              details: [],
            },
          },
          413,
          A2A_CONTENT_TYPE,
        );
      }
      return restError(asProtocolError(error));
    }
  }

  function notFound(path: string): Response {
    return json(
      { error: { code: 404, status: 'NOT_FOUND', message: `No A2A endpoint at '${path}'.` } },
      404,
    );
  }

  function methodNotAllowed(allow: string): Response {
    const response = json(
      { error: { code: 405, status: 'UNIMPLEMENTED', message: `Use ${allow}.` } },
      405,
    );
    response.headers.set('Allow', allow);
    return response;
  }

  return async function handle(request: Request): Promise<Response> {
    const path = normalizePath(new URL(request.url).pathname);
    if (path === cardPath) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return new Response(cardJson, { headers: { 'Content-Type': JSON_CONTENT_TYPE } });
    }
    if (endpoints.jsonrpc.has(path)) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      return handleJsonRpc(request);
    }
    for (const base of restBases) {
      const remainder = below(base, path);
      if (remainder !== undefined) return handleRest(request, remainder, path);
    }
    return notFound(path);
  };
}
