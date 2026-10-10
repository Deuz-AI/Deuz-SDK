/**
 * a2a/client.ts — the A2A v1.0.0 client (2.3). Zero dependencies, Web APIs
 * only: `fetch` (through `deps.fetch`), `Headers`, `ReadableStream`.
 *
 * NOT LIVE-VERIFIED against third-party agents: the wire was derived from
 * `@a2a-js/sdk` 1.3.0 and is tested in-process against that SDK's server.
 */
import { AbortError, InvalidRequestError } from '../errors';
import { parseSSE } from '../internal/sse';
import { resolveDependencies } from '../internal/resolve-deps';
import { A2AError } from './errors';
import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  ERROR_INFO_TYPE,
  JSON_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  isRecord,
  normalizeMessage,
  normalizeStreamResponse,
  normalizeTask,
  reasonForRpcCode,
  toMessage,
} from './protocol';
import type {
  A2AAgentCard,
  A2AAgentInterface,
  A2ABinding,
  A2ACallOptions,
  A2AClient,
  A2AClientOptions,
  A2AFetchAgentCardOptions,
  A2ASendMessageOptions,
  A2ASendMessageResponse,
  A2AStreamResponse,
  A2ATask,
} from './types';

type Params = Record<string, unknown>;

/** The unary and streaming calls of one binding. */
interface Transport {
  call(method: string, params: Params, options: A2ACallOptions | undefined): Promise<unknown>;
  stream(
    method: string,
    params: Params,
    options: A2ACallOptions | undefined,
  ): AsyncGenerator<unknown, void, undefined>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `promise`, or an `AbortError` as soon as `signal` aborts — whether or not
 * whatever produces `promise` (a custom `fetch`, an in-process handler)
 * honours the signal itself.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** A failure while `signal` is aborted is the abort; anything else is `otherwise(error)`. */
function asAbort(
  error: unknown,
  signal: AbortSignal | undefined,
  otherwise: (error: unknown) => unknown,
): unknown {
  if (!signal?.aborted) return otherwise(error);
  return error instanceof AbortError ? error : new AbortError(undefined, { cause: error });
}

function invalidResponse(message: string, statusCode?: number): A2AError {
  return new A2AError({
    kind: 'invalid-response',
    message,
    ...(statusCode !== undefined ? { statusCode } : {}),
  });
}

/** The `ErrorInfo` detail of an error's detail list (`data` in JSON-RPC, `details` in REST). */
function errorInfo(details: unknown): { reason?: string; metadata?: Record<string, string> } {
  if (!Array.isArray(details)) return {};
  for (const detail of details) {
    if (isRecord(detail) && detail['@type'] === ERROR_INFO_TYPE) {
      return {
        ...(typeof detail.reason === 'string' ? { reason: detail.reason } : {}),
        ...(isRecord(detail.metadata)
          ? { metadata: detail.metadata as Record<string, string> }
          : {}),
      };
    }
  }
  return {};
}

function errorMessage(error: Record<string, unknown>): string {
  return typeof error.message === 'string' ? error.message : 'A2A error';
}

/** A JSON-RPC `error` member as an `A2AError`. */
function rpcError(error: Record<string, unknown>, statusCode: number): A2AError {
  const code = typeof error.code === 'number' ? error.code : undefined;
  const info = errorInfo(error.data);
  return new A2AError({
    kind: 'protocol',
    message: errorMessage(error),
    reason: info.reason ?? (code !== undefined ? reasonForRpcCode(code) : undefined) ?? 'UNKNOWN',
    ...(code !== undefined ? { rpcCode: code } : {}),
    statusCode,
    ...(info.metadata ? { metadata: info.metadata } : {}),
  });
}

/** The `error` member of an HTTP+JSON error body (`google.rpc.Status`) as an `A2AError`. */
function restError(error: Record<string, unknown>, statusCode: number): A2AError {
  const info = errorInfo(error.details);
  return new A2AError({
    kind: 'protocol',
    message: errorMessage(error),
    reason: info.reason ?? 'UNKNOWN',
    statusCode,
    ...(info.metadata ? { metadata: info.metadata } : {}),
  });
}

function isRpcErrorEnvelope(body: unknown): body is { error: Record<string, unknown> } {
  return isRecord(body) && body.jsonrpc === '2.0' && isRecord(body.error);
}

function isRestErrorBody(body: unknown): body is { error: Record<string, unknown> } {
  return isRecord(body) && isRecord(body.error);
}

function httpError(statusCode: number): A2AError {
  return new A2AError({
    kind: 'http',
    message: `The A2A agent answered HTTP ${statusCode}.`,
    statusCode,
  });
}

function createClientCore(options: A2AClientOptions) {
  const deps = resolveDependencies(options.deps);

  async function headers(
    fixed: Record<string, string>,
    call: A2ACallOptions | undefined,
  ): Promise<Headers> {
    const result = new Headers();
    const shared =
      typeof options.headers === 'function' ? await options.headers() : options.headers;
    for (const [name, value] of Object.entries(shared ?? {})) result.set(name, value);
    for (const [name, value] of Object.entries(call?.headers ?? {})) result.set(name, value);
    result.set(A2A_VERSION_HEADER, A2A_PROTOCOL_VERSION);
    if (options.extensions && options.extensions.length > 0) {
      result.set(A2A_EXTENSIONS_HEADER, options.extensions.join(','));
    }
    for (const [name, value] of Object.entries(fixed)) result.set(name, value);
    return result;
  }

  async function send(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    if (signal?.aborted) throw new AbortError();
    try {
      return await abortable(deps.fetch(url, { ...init, ...(signal ? { signal } : {}) }), signal);
    } catch (error) {
      throw asAbort(
        error,
        signal,
        (cause) =>
          new A2AError({
            kind: 'network',
            message: `A2A request failed: ${describe(cause)}`,
            cause,
          }),
      );
    }
  }

  /** The body as JSON, or `undefined` when it is not JSON. */
  async function readJson(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
    let text: string;
    try {
      text = await abortable(response.text(), signal);
    } catch (error) {
      throw asAbort(
        error,
        signal,
        (cause) =>
          new A2AError({
            kind: 'network',
            message: `A2A response could not be read: ${describe(cause)}`,
            cause,
          }),
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * Iterates an SSE response. A caller abort ends it with `AbortError` at once,
   * even while a read is pending; a connection that breaks off is a `network`
   * failure.
   */
  async function* events(
    response: Response,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<{ event?: string; data: unknown }, void, undefined> {
    if (!response.body) throw invalidResponse('The A2A stream response has no body.');
    const iterator = parseSSE(response.body)[Symbol.asyncIterator]();
    let drained = false;
    try {
      for (;;) {
        let step: IteratorResult<{ event?: string; data: string }>;
        try {
          step = await abortable(iterator.next(), signal);
        } catch (error) {
          throw asAbort(
            error,
            signal,
            (cause) =>
              new A2AError({
                kind: 'network',
                message: `The A2A stream broke off: ${describe(cause)}`,
                cause,
              }),
          );
        }
        if (step.done) {
          drained = true;
          return;
        }
        if (signal?.aborted) throw new AbortError();
        let data: unknown;
        try {
          data = JSON.parse(step.value.data) as unknown;
        } catch {
          throw invalidResponse('An A2A stream event is not JSON.');
        }
        yield { ...(step.value.event !== undefined ? { event: step.value.event } : {}), data };
      }
    } finally {
      // Releases the connection; a read still pending finishes first, so do not wait.
      if (!drained) void iterator.return?.(undefined);
    }
  }

  function isEventStream(response: Response): boolean {
    return (response.headers.get('content-type') ?? '').toLowerCase().startsWith(SSE_CONTENT_TYPE);
  }

  return { deps, headers, send, readJson, events, isEventStream };
}

type ClientCore = ReturnType<typeof createClientCore>;

function jsonRpcTransport(url: string, core: ClientCore): Transport {
  let nextId = 0;

  function request(method: string, params: Params) {
    const id = ++nextId;
    return { id, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) };
  }

  return {
    async call(method, params, options) {
      const { id, body } = request(method, params);
      const response = await core.send(
        url,
        {
          method: 'POST',
          headers: await core.headers(
            { 'Content-Type': JSON_CONTENT_TYPE, Accept: JSON_CONTENT_TYPE },
            options,
          ),
          body,
        },
        options?.signal,
      );
      const json = await core.readJson(response, options?.signal);
      if (isRpcErrorEnvelope(json)) throw rpcError(json.error, response.status);
      if (!response.ok) throw httpError(response.status);
      if (!isRecord(json) || json.jsonrpc !== '2.0') {
        throw invalidResponse(
          `${method}: the answer is not a JSON-RPC 2.0 response.`,
          response.status,
        );
      }
      if (json.id !== id) {
        throw invalidResponse(`${method}: the answer belongs to another request.`, response.status);
      }
      if (!('result' in json)) {
        throw invalidResponse(`${method}: the answer has no result.`, response.status);
      }
      return json.result;
    },

    async *stream(method, params, options) {
      const { id, body } = request(method, params);
      const response = await core.send(
        url,
        {
          method: 'POST',
          headers: await core.headers(
            { 'Content-Type': JSON_CONTENT_TYPE, Accept: SSE_CONTENT_TYPE },
            options,
          ),
          body,
        },
        options?.signal,
      );
      if (!core.isEventStream(response)) {
        // A server answers an error found before the stream starts as plain JSON-RPC.
        const json = await core.readJson(response, options?.signal);
        if (isRpcErrorEnvelope(json)) throw rpcError(json.error, response.status);
        if (!response.ok) throw httpError(response.status);
        throw invalidResponse(`${method}: expected an event stream.`, response.status);
      }
      for await (const { event, data } of core.events(response, options?.signal)) {
        if (isRpcErrorEnvelope(data)) throw rpcError(data.error, response.status);
        if (event === 'error') throw invalidResponse(`${method}: the stream failed.`);
        if (!isRecord(data) || data.jsonrpc !== '2.0' || data.id !== id || !('result' in data)) {
          throw invalidResponse(`${method}: a stream event is not a response to this request.`);
        }
        yield data.result;
      }
    },
  };
}

/** One HTTP+JSON request: the route of a method and what goes in the body. */
function restRoute(
  method: string,
  params: Params,
): { verb: 'GET' | 'POST'; path: string; body?: Params } {
  const { tenant: _tenant, ...rest } = params;
  const id = encodeURIComponent(String(params.id));
  switch (method) {
    case 'SendMessage':
      return { verb: 'POST', path: '/message:send', body: rest };
    case 'SendStreamingMessage':
      return { verb: 'POST', path: '/message:stream', body: rest };
    case 'GetTask': {
      const query =
        params.historyLength !== undefined ? `?historyLength=${params.historyLength}` : '';
      return { verb: 'GET', path: `/tasks/${id}${query}` };
    }
    case 'CancelTask':
      return {
        verb: 'POST',
        path: `/tasks/${id}:cancel`,
        body: params.metadata !== undefined ? { metadata: params.metadata } : {},
      };
    case 'SubscribeToTask':
      return { verb: 'POST', path: `/tasks/${id}:subscribe` };
    default:
      throw new InvalidRequestError({
        message: `The HTTP+JSON binding has no route for ${method}.`,
      });
  }
}

function restTransport(baseUrl: string, core: ClientCore): Transport {
  const base = baseUrl.replace(/\/+$/, '');

  function target(method: string, params: Params) {
    const route = restRoute(method, params);
    const tenant = typeof params.tenant === 'string' ? `/${encodeURIComponent(params.tenant)}` : '';
    return { ...route, url: `${base}${tenant}${route.path}` };
  }

  async function open(method: string, params: Params, accept: string, options?: A2ACallOptions) {
    const { verb, url, body } = target(method, params);
    const fixed: Record<string, string> = { Accept: accept };
    if (body !== undefined) fixed['Content-Type'] = JSON_CONTENT_TYPE;
    return core.send(
      url,
      {
        method: verb,
        headers: await core.headers(fixed, options),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      options?.signal,
    );
  }

  return {
    async call(method, params, options) {
      const response = await open(
        method,
        params,
        `${A2A_CONTENT_TYPE}, ${JSON_CONTENT_TYPE}`,
        options,
      );
      const json = await core.readJson(response, options?.signal);
      if (!response.ok) {
        if (isRestErrorBody(json)) throw restError(json.error, response.status);
        throw httpError(response.status);
      }
      if (json === undefined) {
        throw invalidResponse(`${method}: the answer is not JSON.`, response.status);
      }
      return json;
    },

    async *stream(method, params, options) {
      const response = await open(method, params, SSE_CONTENT_TYPE, options);
      if (!core.isEventStream(response)) {
        const json = await core.readJson(response, options?.signal);
        if (isRestErrorBody(json)) throw restError(json.error, response.status);
        if (!response.ok) throw httpError(response.status);
        throw invalidResponse(`${method}: expected an event stream.`, response.status);
      }
      for await (const { event, data } of core.events(response, options?.signal)) {
        if (isRestErrorBody(data)) throw restError(data.error, response.status);
        if (event === 'error') throw invalidResponse(`${method}: the stream failed.`);
        yield data;
      }
    },
  };
}

function toTask(value: unknown, method: string): A2ATask {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw invalidResponse(`${method}: the answer is not a task.`);
  }
  return normalizeTask(value);
}

function toStreamResponse(value: unknown, method: string): A2AStreamResponse {
  const event = normalizeStreamResponse(value);
  if (!event) throw invalidResponse(`${method}: a stream event is not a task, message or update.`);
  return event;
}

/** Leaves out `undefined` fields, so the JSON a server sees carries only what was set. */
function compact(record: Record<string, unknown>): Params {
  const result: Params = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) result[key] = value;
  return result;
}

/**
 * Fetch an agent's card. The card is read from `/.well-known/agent-card.json`
 * at the URL's origin, from the URL itself when it ends in `.json`, or from
 * `path` resolved against the URL.
 */
export async function fetchAgentCard(
  url: string,
  options: A2AFetchAgentCardOptions = {},
): Promise<A2AAgentCard> {
  let target: URL;
  try {
    target =
      options.path !== undefined
        ? new URL(options.path, url)
        : new URL(url).pathname.endsWith('.json')
          ? new URL(url)
          : new URL(AGENT_CARD_PATH, url);
  } catch (error) {
    throw new InvalidRequestError({ message: `Not a URL: '${url}'.`, cause: error });
  }
  const core = createClientCore({ ...(options.deps ? { deps: options.deps } : {}) });
  const response = await core.send(
    target.href,
    { method: 'GET', headers: await core.headers({ Accept: JSON_CONTENT_TYPE }, options) },
    options.signal,
  );
  const json = await core.readJson(response, options.signal);
  if (!response.ok) throw httpError(response.status);
  if (!isRecord(json) || typeof json.name !== 'string') {
    throw invalidResponse('The document is not an A2A agent card.', response.status);
  }
  return json as unknown as A2AAgentCard;
}

function canonicalBinding(value: unknown): A2ABinding | undefined {
  const upper = typeof value === 'string' ? value.toUpperCase() : '';
  return upper === 'JSONRPC' || upper === 'HTTP+JSON' ? upper : undefined;
}

/** A 1.x version, or none declared (accepted only when no 1.x interface exists). */
function versionRank(version: unknown): number {
  if (version === undefined || version === '') return 1;
  return typeof version === 'string' && /^1(?:\.|$)/.test(version.trim()) ? 2 : 0;
}

/** The interface the client uses: the first 1.x one of a binding it speaks (or the one asked for). */
function pickInterface(card: A2AAgentCard, binding: A2ABinding | undefined): A2AAgentInterface {
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const usable = interfaces.filter((candidate) => {
    const speaks = canonicalBinding(candidate.protocolBinding);
    return (
      typeof candidate.url === 'string' &&
      speaks !== undefined &&
      (binding === undefined || speaks === binding)
    );
  });
  const chosen =
    usable.find((candidate) => versionRank(candidate.protocolVersion) === 2) ??
    usable.find((candidate) => versionRank(candidate.protocolVersion) === 1);
  if (chosen) return chosen;
  const offered = interfaces
    .map((candidate) => `${candidate.protocolBinding} ${candidate.protocolVersion ?? '?'}`)
    .join(', ');
  throw new InvalidRequestError({
    message:
      `The agent card of '${card.name}' declares no A2A 1.x ${binding ?? 'JSONRPC or HTTP+JSON'} ` +
      `interface (it offers: ${offered || 'none'}).`,
  });
}

/**
 * Connect to an A2A agent — from its card, or straight to an endpoint:
 *
 * ```ts
 * const client = createA2AClient({ card: await fetchAgentCard('https://agent.example.com') });
 * const answer = await client.sendMessage('What is the weather in Izmir?');
 * ```
 *
 * `url` wins over the card's interfaces (a proxy, a test server); `binding`
 * then names the endpoint's binding (default `'JSONRPC'`). Every request
 * carries `A2A-Version: 1.0`.
 */
export function createA2AClient(options: A2AClientOptions): A2AClient {
  let url: string;
  let binding: A2ABinding;
  let tenant = options.tenant;
  if (typeof options.url === 'string' && options.url !== '') {
    url = options.url;
    binding = options.binding ?? 'JSONRPC';
    if (canonicalBinding(binding) !== binding) {
      throw new InvalidRequestError({
        message: `createA2AClient speaks the 'JSONRPC' and 'HTTP+JSON' bindings, not '${String(binding)}'.`,
      });
    }
  } else if (options.card) {
    const chosen = pickInterface(options.card, options.binding);
    url = chosen.url;
    binding = canonicalBinding(chosen.protocolBinding) as A2ABinding;
    if (tenant === undefined && chosen.tenant) tenant = chosen.tenant;
  } else {
    throw new InvalidRequestError({ message: 'createA2AClient needs a card or a url.' });
  }
  const core = createClientCore(options);
  const transport = binding === 'JSONRPC' ? jsonRpcTransport(url, core) : restTransport(url, core);

  function sendParams(
    input: Parameters<A2AClient['sendMessage']>[0],
    call?: A2ASendMessageOptions,
  ) {
    const message = toMessage(input, { role: 'ROLE_USER', generateId: core.deps.generateId });
    return compact({
      tenant,
      message: compact({
        ...message,
        taskId: call?.taskId ?? message.taskId,
        contextId: call?.contextId ?? message.contextId,
      }),
      configuration: call?.configuration,
      metadata: call?.metadata,
    });
  }

  return {
    url,
    binding,
    card: options.card,

    async sendMessage(input, call) {
      const result = await transport.call('SendMessage', sendParams(input, call), call);
      if (isRecord(result) && isRecord(result.task)) return { task: normalizeTask(result.task) };
      if (isRecord(result) && isRecord(result.message)) {
        return { message: normalizeMessage(result.message) } satisfies A2ASendMessageResponse;
      }
      throw invalidResponse('SendMessage: the answer is neither a task nor a message.');
    },

    async *sendStreamingMessage(input, call) {
      for await (const value of transport.stream(
        'SendStreamingMessage',
        sendParams(input, call),
        call,
      )) {
        yield toStreamResponse(value, 'SendStreamingMessage');
      }
    },

    async getTask(taskId, call) {
      const params = compact({ tenant, id: taskId, historyLength: call?.historyLength });
      return toTask(await transport.call('GetTask', params, call), 'GetTask');
    },

    async cancelTask(taskId, call) {
      const params = compact({ tenant, id: taskId, metadata: call?.metadata });
      return toTask(await transport.call('CancelTask', params, call), 'CancelTask');
    },

    async *subscribeToTask(taskId, call) {
      for await (const value of transport.stream(
        'SubscribeToTask',
        compact({ tenant, id: taskId }),
        call,
      )) {
        yield toStreamResponse(value, 'SubscribeToTask');
      }
    },
  };
}
