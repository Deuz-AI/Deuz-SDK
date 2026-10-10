/**
 * `@deuz-sdk/core/a2a` (2.3) — the A2A v1.0.0 client against a scripted fetch.
 *
 * Every request the client makes is captured and every answer is a literal
 * wire payload, so these tests pin the client's half of the wire contract:
 * the JSON-RPC method names and params, the HTTP+JSON routes, the `A2A-Version`
 * header, how answers and SSE events are unwrapped, and how each kind of
 * failure surfaces as an `A2AError` (or an `AbortError`). The shapes come from
 * `@a2a-js/sdk` 1.3.0 (A2A v1.0.0); the SDK itself is exercised in
 * `a2a-interop.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { A2AError, createA2AClient, type A2AStreamResponse } from '../src/a2a';
import { AbortError, InvalidRequestError } from '../src/errors';

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Answer = (request: Captured) => Response | Promise<Response>;

/** A fetch that records every request and answers with the next scripted answer. */
function scriptedFetch(...answers: Answer[]) {
  const requests: Captured[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const captured: Captured = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: text === '' ? undefined : JSON.parse(text),
    };
    requests.push(captured);
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request to ${request.url}`);
    return answer(captured);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

/** An SSE answer; each entry is one event (`event:` only when given). */
function sse(events: { event?: string; data: unknown }[]): Response {
  const text = events
    .map(
      ({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
    )
    .join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

/** JSON-RPC result envelope echoing the request's id. */
const rpcResult =
  (result: unknown): Answer =>
  (request) =>
    json({ jsonrpc: '2.0', id: (request.body as { id: unknown }).id, result });

const rpcError =
  (error: unknown, status = 200): Answer =>
  (request) =>
    json({ jsonrpc: '2.0', id: (request.body as { id: unknown }).id, error }, status);

const errorInfo = (reason: string) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'a2a-protocol.org',
});

const TASK = {
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-10T10:00:00.000Z' },
  artifacts: [{ artifactId: 'a-1', parts: [{ text: 'done' }] }],
  history: [{ messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'hello' }] }],
};

async function collect(stream: AsyncIterable<A2AStreamResponse>): Promise<A2AStreamResponse[]> {
  const events: A2AStreamResponse[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('A2A client — JSON-RPC binding', () => {
  const URL_ = 'https://agent.test/a2a/jsonrpc';

  function client(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
    let next = 0;
    return createA2AClient({
      url: URL_,
      deps: { fetch, generateId: () => `gen-${++next}` },
      ...extra,
    });
  }

  it('sends SendMessage with the A2A-Version header and returns the task', async () => {
    const { fetch, requests } = scriptedFetch(rpcResult({ task: TASK }));
    const result = await client(fetch).sendMessage('hello');

    expect(result).toEqual({ task: TASK });
    const [request] = requests;
    expect(request?.url).toBe(URL_);
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('a2a-version')).toBe('1.0');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'SendMessage',
      params: { message: { messageId: 'gen-1', role: 'ROLE_USER', parts: [{ text: 'hello' }] } },
    });
    const id = (request?.body as { id: unknown }).id;
    expect(typeof id === 'number' || typeof id === 'string').toBe(true);
  });

  it('returns a direct message answer', async () => {
    const answer = { messageId: 'r-1', role: 'ROLE_AGENT', parts: [{ text: 'hi there' }] };
    const { fetch } = scriptedFetch(rpcResult({ message: answer }));
    expect(await client(fetch).sendMessage('hello')).toEqual({ message: answer });
  });

  it('puts taskId, contextId, configuration and metadata into the request', async () => {
    const { fetch, requests } = scriptedFetch(rpcResult({ task: TASK }));
    await client(fetch).sendMessage(
      { parts: [{ text: 'yes' }], metadata: { from: 'test' } },
      {
        taskId: 'task-1',
        contextId: 'ctx-1',
        configuration: { historyLength: 2, returnImmediately: true },
        metadata: { trace: 't-1' },
      },
    );
    expect((requests[0]?.body as { params: unknown }).params).toEqual({
      message: {
        messageId: 'gen-1',
        role: 'ROLE_USER',
        parts: [{ text: 'yes' }],
        metadata: { from: 'test' },
        taskId: 'task-1',
        contextId: 'ctx-1',
      },
      configuration: { historyLength: 2, returnImmediately: true },
      metadata: { trace: 't-1' },
    });
  });

  it('accepts a list of parts as the message', async () => {
    const { fetch, requests } = scriptedFetch(rpcResult({ task: TASK }));
    await client(fetch).sendMessage([
      { data: { n: 1 } },
      { url: 'https://x/y.png', mediaType: 'image/png' },
    ]);
    expect((requests[0]?.body as { params: { message: unknown } }).params.message).toEqual({
      messageId: 'gen-1',
      role: 'ROLE_USER',
      parts: [{ data: { n: 1 } }, { url: 'https://x/y.png', mediaType: 'image/png' }],
    });
  });

  it('sends the tenant in the params and the requested extensions in A2A-Extensions', async () => {
    const { fetch, requests } = scriptedFetch(rpcResult(TASK));
    await client(fetch, { tenant: 'acme', extensions: ['urn:ext:a', 'urn:ext:b'] }).getTask(
      'task-1',
    );
    expect(requests[0]?.headers.get('a2a-extensions')).toBe('urn:ext:a,urn:ext:b');
    expect((requests[0]?.body as { params: unknown }).params).toEqual({
      id: 'task-1',
      tenant: 'acme',
    });
  });

  it('calls a headers function for every request', async () => {
    let calls = 0;
    const { fetch, requests } = scriptedFetch(rpcResult(TASK), rpcResult(TASK));
    const a2a = client(fetch, { headers: () => ({ authorization: `Bearer token-${++calls}` }) });
    await a2a.getTask('task-1');
    await a2a.getTask('task-1', { headers: { 'x-trace': 'abc' } });
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
    expect(requests[1]?.headers.get('x-trace')).toBe('abc');
  });

  it('sends GetTask with historyLength and CancelTask with metadata', async () => {
    const { fetch, requests } = scriptedFetch(rpcResult(TASK), rpcResult(TASK));
    const a2a = client(fetch);
    expect(await a2a.getTask('task-1', { historyLength: 0 })).toEqual(TASK);
    expect(await a2a.cancelTask('task-1', { metadata: { why: 'user' } })).toEqual(TASK);
    expect(requests.map((request) => request.body)).toMatchObject([
      { method: 'GetTask', params: { id: 'task-1', historyLength: 0 } },
      { method: 'CancelTask', params: { id: 'task-1', metadata: { why: 'user' } } },
    ]);
  });

  it('names numeric enum values the way ProtoJSON allows servers to send them', async () => {
    const { fetch } = scriptedFetch(
      rpcResult({
        ...TASK,
        status: {
          state: 6,
          message: { messageId: 'q', role: 2, parts: [{ text: 'which city?' }] },
        },
        history: [{ messageId: 'm-1', role: 1, parts: [{ text: 'hello' }] }],
      }),
    );
    const task = await client(fetch).getTask('task-1');
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task.status.message?.role).toBe('ROLE_AGENT');
    expect(task.history?.[0]?.role).toBe('ROLE_USER');
  });

  it('turns a JSON-RPC error into an A2AError carrying the ErrorInfo reason', async () => {
    const { fetch } = scriptedFetch(
      rpcError({
        code: -32001,
        message: 'Task not found: t-9',
        data: [errorInfo('TASK_NOT_FOUND')],
      }),
    );
    const error = await rejection(client(fetch).getTask('t-9'));
    expect(error).toBeInstanceOf(A2AError);
    expect(error).toMatchObject({
      kind: 'protocol',
      reason: 'TASK_NOT_FOUND',
      rpcCode: -32001,
      statusCode: 200,
      message: 'Task not found: t-9',
    });
  });

  it('derives the reason from the JSON-RPC code when the error has no ErrorInfo', async () => {
    const { fetch } = scriptedFetch(rpcError({ code: -32002, message: 'Task cannot be canceled' }));
    expect(await rejection(client(fetch).cancelTask('task-1'))).toMatchObject({
      kind: 'protocol',
      reason: 'TASK_NOT_CANCELABLE',
      rpcCode: -32002,
    });
  });

  it('reads a JSON-RPC error out of a non-2xx answer', async () => {
    const { fetch } = scriptedFetch(rpcError({ code: -32603, message: 'boom' }, 500));
    expect(await rejection(client(fetch).getTask('task-1'))).toMatchObject({
      kind: 'protocol',
      reason: 'INTERNAL_ERROR',
      rpcCode: -32603,
      statusCode: 500,
    });
  });

  it('reports a non-2xx answer without a JSON-RPC body as an http failure', async () => {
    const { fetch } = scriptedFetch(() => new Response('<h1>Bad gateway</h1>', { status: 502 }));
    expect(await rejection(client(fetch).getTask('task-1'))).toMatchObject({
      kind: 'http',
      statusCode: 502,
    });
  });

  it('rejects an answer that belongs to another request', async () => {
    const { fetch } = scriptedFetch(() =>
      json({ jsonrpc: '2.0', id: 'someone-else', result: TASK }),
    );
    expect(await rejection(client(fetch).getTask('task-1'))).toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects an answer that is not JSON-RPC 2.0', async () => {
    const { fetch } = scriptedFetch(() => json({ result: TASK }));
    expect(await rejection(client(fetch).getTask('task-1'))).toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects a SendMessage answer that is neither a task nor a message', async () => {
    const { fetch } = scriptedFetch(rpcResult({ something: 'else' }));
    expect(await rejection(client(fetch).sendMessage('hello'))).toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('reports a failed fetch as a network failure', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const error = await rejection(client(fetch).getTask('task-1'));
    expect(error).toBeInstanceOf(A2AError);
    expect(error).toMatchObject({ kind: 'network' });
  });

  it('rejects with AbortError when the caller aborts', async () => {
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as typeof globalThis.fetch;
    const controller = new AbortController();
    const pending = client(fetch).getTask('task-1', { signal: controller.signal });
    controller.abort();
    expect(await rejection(pending)).toBeInstanceOf(AbortError);
  });

  it('streams SendStreamingMessage events out of the SSE envelopes', async () => {
    const events = [
      { task: { ...TASK, status: { state: 'TASK_STATE_SUBMITTED' }, artifacts: [] } },
      {
        statusUpdate: {
          taskId: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_WORKING' },
        },
      },
      {
        artifactUpdate: {
          taskId: 'task-1',
          contextId: 'ctx-1',
          artifact: { artifactId: 'a-1', parts: [{ text: 'done' }] },
          lastChunk: true,
        },
      },
      {
        statusUpdate: {
          taskId: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED' },
        },
      },
    ];
    const { fetch, requests } = scriptedFetch((request) =>
      sse(
        events.map((result) => ({
          data: { jsonrpc: '2.0', id: (request.body as { id: unknown }).id, result },
        })),
      ),
    );
    expect(await collect(client(fetch).sendStreamingMessage('hello'))).toEqual(events);
    expect(requests[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(requests[0]?.body).toMatchObject({ method: 'SendStreamingMessage' });
  });

  it('streams SubscribeToTask', async () => {
    const { fetch, requests } = scriptedFetch((request) =>
      sse([
        {
          data: {
            jsonrpc: '2.0',
            id: (request.body as { id: unknown }).id,
            result: { task: TASK },
          },
        },
      ]),
    );
    expect(await collect(client(fetch).subscribeToTask('task-1'))).toEqual([{ task: TASK }]);
    expect(requests[0]?.body).toMatchObject({
      method: 'SubscribeToTask',
      params: { id: 'task-1' },
    });
  });

  it('throws the A2A error of an SSE error event', async () => {
    const { fetch } = scriptedFetch((request) => {
      const id = (request.body as { id: unknown }).id;
      return sse([
        { data: { jsonrpc: '2.0', id, result: { task: TASK } } },
        {
          event: 'error',
          data: { jsonrpc: '2.0', id, error: { code: -32603, message: 'store unavailable' } },
        },
      ]);
    });
    const seen: A2AStreamResponse[] = [];
    const error = await rejection(
      (async () => {
        for await (const event of client(fetch).subscribeToTask('task-1')) seen.push(event);
      })(),
    );
    expect(seen).toEqual([{ task: TASK }]);
    expect(error).toMatchObject({
      kind: 'protocol',
      reason: 'INTERNAL_ERROR',
      message: 'store unavailable',
    });
  });

  it('throws the A2A error a server answers a stream request with as plain JSON', async () => {
    const { fetch } = scriptedFetch(
      rpcError({
        code: -32009,
        message: "The requested A2A protocol version '0.3' is not supported.",
        data: [errorInfo('VERSION_NOT_SUPPORTED')],
      }),
    );
    expect(await rejection(collect(client(fetch).sendStreamingMessage('hello')))).toMatchObject({
      kind: 'protocol',
      reason: 'VERSION_NOT_SUPPORTED',
      rpcCode: -32009,
    });
  });

  it('rejects stream events that are not JSON-RPC envelopes of this request', async () => {
    const { fetch } = scriptedFetch(() =>
      sse([{ data: { jsonrpc: '2.0', id: 'not-mine', result: { task: TASK } } }]),
    );
    expect(await rejection(collect(client(fetch).subscribeToTask('task-1')))).toMatchObject({
      kind: 'invalid-response',
    });
  });
});

describe('A2A client — HTTP+JSON binding', () => {
  const BASE = 'https://agent.test/a2a/rest';

  function client(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
    let next = 0;
    return createA2AClient({
      url: `${BASE}/`,
      binding: 'HTTP+JSON',
      deps: { fetch, generateId: () => `gen-${++next}` },
      ...extra,
    });
  }

  const a2aJson =
    (body: unknown, status = 200): Answer =>
    () =>
      json(body, status, 'application/a2a+json');

  it('posts SendMessage params to /message:send', async () => {
    const { fetch, requests } = scriptedFetch(a2aJson({ task: TASK }));
    const result = await client(fetch).sendMessage('hello', {
      configuration: { historyLength: 1 },
    });
    expect(result).toEqual({ task: TASK });
    const [request] = requests;
    expect(request?.url).toBe(`${BASE}/message:send`);
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('a2a-version')).toBe('1.0');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.body).toEqual({
      message: { messageId: 'gen-1', role: 'ROLE_USER', parts: [{ text: 'hello' }] },
      configuration: { historyLength: 1 },
    });
  });

  it('returns a direct message answer', async () => {
    const answer = { messageId: 'r-1', role: 'ROLE_AGENT', parts: [{ text: 'hi there' }] };
    const { fetch } = scriptedFetch(a2aJson({ message: answer }));
    expect(await client(fetch).sendMessage('hello')).toEqual({ message: answer });
  });

  it('gets a task by its encoded id with historyLength in the query', async () => {
    const { fetch, requests } = scriptedFetch(a2aJson(TASK));
    expect(await client(fetch).getTask('task/1', { historyLength: 2 })).toEqual(TASK);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`${BASE}/tasks/task%2F1?historyLength=2`);
    expect(requests[0]?.body).toBeUndefined();
  });

  it('posts a cancel with its metadata as the body', async () => {
    const { fetch, requests } = scriptedFetch(a2aJson(TASK), a2aJson(TASK));
    const a2a = client(fetch);
    await a2a.cancelTask('task-1', { metadata: { why: 'user' } });
    await a2a.cancelTask('task-1');
    expect(requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: `${BASE}/tasks/task-1:cancel`, body: { metadata: { why: 'user' } } },
      { method: 'POST', url: `${BASE}/tasks/task-1:cancel`, body: {} },
    ]);
  });

  it('prefixes every route with the tenant', async () => {
    const { fetch, requests } = scriptedFetch(a2aJson({ task: TASK }), a2aJson(TASK), () =>
      sse([{ data: { task: TASK } }]),
    );
    const a2a = client(fetch, { tenant: 'acme' });
    await a2a.sendMessage('hello');
    await a2a.getTask('task-1');
    await collect(a2a.subscribeToTask('task-1'));
    expect(requests.map((request) => request.url)).toEqual([
      `${BASE}/acme/message:send`,
      `${BASE}/acme/tasks/task-1`,
      `${BASE}/acme/tasks/task-1:subscribe`,
    ]);
  });

  it('streams /message:stream events', async () => {
    const events = [
      { task: { ...TASK, status: { state: 'TASK_STATE_WORKING' } } },
      {
        statusUpdate: {
          taskId: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'TASK_STATE_COMPLETED' },
        },
      },
    ];
    const { fetch, requests } = scriptedFetch(() => sse(events.map((data) => ({ data }))));
    expect(await collect(client(fetch).sendStreamingMessage('hello'))).toEqual(events);
    expect(requests[0]?.url).toBe(`${BASE}/message:stream`);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(requests[0]?.body).toMatchObject({ message: { parts: [{ text: 'hello' }] } });
  });

  it('subscribes with a POST to /tasks/{id}:subscribe', async () => {
    const { fetch, requests } = scriptedFetch(() => sse([{ data: { task: TASK } }]));
    expect(await collect(client(fetch).subscribeToTask('task-1'))).toEqual([{ task: TASK }]);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(`${BASE}/tasks/task-1:subscribe`);
  });

  it('turns a REST error body into an A2AError carrying the ErrorInfo reason', async () => {
    const { fetch } = scriptedFetch(
      a2aJson(
        {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message: 'Task not found: t-9',
            details: [errorInfo('TASK_NOT_FOUND')],
          },
        },
        404,
      ),
    );
    const error = await rejection(client(fetch).getTask('t-9'));
    expect(error).toBeInstanceOf(A2AError);
    expect(error).toMatchObject({
      kind: 'protocol',
      reason: 'TASK_NOT_FOUND',
      rpcCode: -32001,
      statusCode: 404,
      message: 'Task not found: t-9',
    });
  });

  it('keeps a REST error without ErrorInfo as an unknown protocol error', async () => {
    const { fetch } = scriptedFetch(
      a2aJson({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad input' } }, 400),
    );
    expect(await rejection(client(fetch).sendMessage('hello'))).toMatchObject({
      kind: 'protocol',
      reason: 'UNKNOWN',
      statusCode: 400,
      message: 'bad input',
    });
  });

  it('reports a non-JSON error answer as an http failure', async () => {
    const { fetch } = scriptedFetch(() => new Response('Unauthorized', { status: 401 }));
    expect(await rejection(client(fetch).getTask('task-1'))).toMatchObject({
      kind: 'http',
      statusCode: 401,
    });
  });

  it('throws the error of an SSE error event', async () => {
    const { fetch } = scriptedFetch(() =>
      sse([
        { data: { task: TASK } },
        {
          event: 'error',
          data: {
            error: { code: 500, status: 'INTERNAL', message: 'store unavailable', details: [] },
          },
        },
      ]),
    );
    expect(await rejection(collect(client(fetch).subscribeToTask('task-1')))).toMatchObject({
      kind: 'protocol',
      message: 'store unavailable',
    });
  });

  it('throws the error a server answers a stream request with before streaming', async () => {
    const { fetch } = scriptedFetch(
      a2aJson(
        {
          error: {
            code: 400,
            status: 'FAILED_PRECONDITION',
            message: 'Streaming is not supported.',
            details: [errorInfo('UNSUPPORTED_OPERATION')],
          },
        },
        400,
      ),
    );
    expect(await rejection(collect(client(fetch).sendStreamingMessage('hello')))).toMatchObject({
      kind: 'protocol',
      reason: 'UNSUPPORTED_OPERATION',
      statusCode: 400,
    });
  });

  it('rejects a binding it does not speak', () => {
    expect(() => createA2AClient({ url: BASE, binding: 'GRPC' as unknown as 'JSONRPC' })).toThrow(
      InvalidRequestError,
    );
  });
});

describe('A2AError', () => {
  it('serializes kind, reason and codes for logs', () => {
    const error = new A2AError({
      reason: 'TASK_NOT_FOUND',
      message: 'Task not found',
      statusCode: 404,
    });
    expect(error.toJSON()).toEqual({
      name: 'A2AError',
      code: 'a2a_error',
      message: 'Task not found',
      details: { statusCode: 404, kind: 'protocol', reason: 'TASK_NOT_FOUND', rpcCode: -32001 },
    });
  });
});
