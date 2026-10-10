/**
 * a2a/handler.ts — `createA2AHandler`: an A2A v1.0.0 agent as a fetch-style
 * handler (2.3). Edge-safe: `Request`, `Response`, `URL`, `ReadableStream`.
 *
 * Error codes, reasons and HTTP statuses follow `@a2a-js/sdk` 1.3.0's server.
 * NOT LIVE-VERIFIED against third-party clients beyond that SDK's.
 */
import { InvalidRequestError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { A2AError } from './errors';
import {
  A2A_ERROR_DOMAIN,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
  ERROR_INFO_TYPE,
  JSON_CONTENT_TYPE,
  REASON_WIRE,
  isRecord,
  roleName,
  type A2AErrorReason,
} from './protocol';
import { createTaskRuntime, protocolError, withHistory, type TurnInfo } from './runtime';
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
} from './types';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

type JsonRpcId = string | number | null;

class BodyTooLargeError extends Error {}

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
    const { done, value } = await reader.read();
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

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
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
  const cardPath = normalizePath(options.cardPath ?? AGENT_CARD_PATH);
  const cardJson = JSON.stringify(card);
  const maxBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declaredExtensions = new Set(
    (card.capabilities?.extensions ?? []).map((extension) => extension.uri),
  );
  const requiredExtensions = (card.capabilities?.extensions ?? [])
    .filter((extension) => extension.required)
    .map((extension) => extension.uri);

  /** A protocol error as itself; anything else is reported and answered as an internal error. */
  function asProtocolError(error: unknown): A2AError {
    if (error instanceof A2AError && error.kind === 'protocol') return error;
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

  function turnInfo(request: Request, tenant: string | undefined): TurnInfo {
    const requested = parseExtensions(request.headers.get(A2A_EXTENSIONS_HEADER));
    const missing = requiredExtensions.filter((uri) => !requested.includes(uri));
    if (missing.length > 0) {
      throw protocolError(
        'EXTENSION_SUPPORT_REQUIRED',
        `Client must declare support for required extensions: ${missing.join(', ')}`,
      );
    }
    return {
      scope: tenant !== undefined ? { tenant } : {},
      extensions: requested.filter((uri) => declaredExtensions.has(uri)),
      httpRequest: request,
    };
  }

  async function sendMessage(
    params: Record<string, unknown>,
    request: Request,
    tenant: string | undefined,
  ): Promise<A2ASendMessageResponse> {
    const sendRequest = parseSendMessageRequest(params, tenant);
    const turn = await runtime.start(sendRequest, turnInfo(request, tenant));
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
    switch (method) {
      case 'SendMessage':
        return rpcResult(id, await sendMessage(params, request, tenant));
      case 'GetTask': {
        const taskId = requiredString(params.id, 'id');
        const historyLength = optionalHistoryLength(params.historyLength);
        const scope = tenant !== undefined ? { tenant } : {};
        return rpcResult(id, await runtime.getTask(taskId, scope, historyLength));
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
      if (!(error instanceof BodyTooLargeError)) throw error;
      return rpcError(
        null,
        protocolError('INVALID_REQUEST', `The request body exceeds ${maxBodyBytes} bytes.`),
        413,
      );
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
    return notFound(path);
  };
}
