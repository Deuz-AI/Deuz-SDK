/**
 * `@deuz-sdk/core/a2a` (2.3) — `createA2AHandler`, the A2A v1.0.0 server side.
 *
 * Requests go straight into the handler (`Request` in, `Response` out) and the
 * answers are read as the wire defines them, so these tests pin the handler's
 * contract: the routes it derives from the agent card, the JSON-RPC envelope
 * and its error codes, the `A2A-Version` check, and the task lifecycle an
 * executor drives — lazy task creation, turns, interrupted and terminal
 * states, what a throwing executor does. Error codes, reasons and HTTP
 * statuses mirror `@a2a-js/sdk` 1.3.0 (A2A v1.0.0); `a2a-interop.test.ts`
 * runs that SDK's client against this handler.
 */
import { describe, it, expect } from 'vitest';
import {
  A2AError,
  createA2AHandler,
  createInMemoryA2ATaskStore,
  type A2AAgentCard,
  type A2AExecuteFunction,
  type A2AExecutionContext,
  type A2AHandlerOptions,
  type A2ATask,
} from '../src/a2a';
import { InvalidRequestError } from '../src/errors';
import { parseSSE } from '../src/internal/sse';

const NOW = '2026-10-10T10:00:00.000Z';
const RPC_URL = 'https://agent.test/a2a/jsonrpc';
const REST_URL = 'https://agent.test/a2a/rest';

const CARD: A2AAgentCard = {
  name: 'Echo',
  description: 'Echoes what it is told.',
  version: '1.0.0',
  supportedInterfaces: [
    { url: RPC_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    { url: REST_URL, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'echo', name: 'Echo', description: 'Echoes.', tags: ['echo'] }],
};

function deps() {
  let next = 0;
  return {
    generateId: () => `id-${++next}`,
    clock: { now: () => Date.parse(NOW), setTimeout: () => () => {} },
  };
}

function handlerWith(executor: A2AExecuteFunction, extra: Partial<A2AHandlerOptions> = {}) {
  const errors: unknown[] = [];
  const handler = createA2AHandler({
    card: CARD,
    executor,
    deps: deps(),
    onError: (error) => errors.push(error),
    ...extra,
  });
  return { handler, errors };
}

let rpcId = 0;

/** A POST whose body stream fails after the first chunk, as a dropped connection does. */
function brokenBodyRequest(url: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
      controller.error(new Error('connection reset'));
    },
  });
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body,
    duplex: 'half',
  } as RequestInit);
}

/** POST one JSON-RPC request; the parsed body and the HTTP status. */
async function rpc(
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: unknown,
  headers: Record<string, string> = { 'A2A-Version': '1.0' },
) {
  const id = ++rpcId;
  const response = await handler(
    new Request(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.jsonrpc).toBe('2.0');
  expect(body.id).toBe(id);
  return { status: response.status, body, headers: response.headers };
}

const userMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  messageId: `user-${text}`,
  role: 'ROLE_USER',
  parts: [{ text }],
  ...extra,
});

async function send(
  handler: (request: Request) => Promise<Response>,
  text: string,
  extra: Record<string, unknown> = {},
  configuration?: Record<string, unknown>,
) {
  const { body } = await rpc(handler, 'SendMessage', {
    message: userMessage(text, extra),
    ...(configuration ? { configuration } : {}),
  });
  return body;
}

const errorInfo = (reason: string) => [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' },
];

/** A promise the test resolves by hand. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

describe('createA2AHandler — card and routing', () => {
  it('serves the agent card at /.well-known/agent-card.json', async () => {
    const { handler } = handlerWith(() => {});
    const response = await handler(new Request('https://agent.test/.well-known/agent-card.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(CARD);
  });

  it('serves the card at cardPath', async () => {
    const { handler } = handlerWith(() => {}, { cardPath: '/agents/echo.json' });
    const response = await handler(new Request('https://agent.test/agents/echo.json'));
    expect(await response.json()).toEqual(CARD);
  });

  it('answers a path the card does not declare with 404', async () => {
    const { handler } = handlerWith(() => {});
    const response = await handler(new Request('https://agent.test/elsewhere', { method: 'POST' }));
    expect(response.status).toBe(404);
  });

  it('answers anything but POST on the JSON-RPC endpoint with 405', async () => {
    const { handler } = handlerWith(() => {});
    const response = await handler(new Request(RPC_URL));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('matches the endpoints by path, whatever host the request came in on', async () => {
    const { handler } = handlerWith((ctx) => ctx.reply('pong'));
    const response = await handler(
      new Request('http://127.0.0.1:8080/a2a/jsonrpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: userMessage('ping') },
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      result: { message: { parts: [{ text: 'pong' }] } },
    });
  });

  it('rejects a card without an A2A 1.0 JSON-RPC or HTTP+JSON interface', () => {
    const card = {
      ...CARD,
      supportedInterfaces: [
        { url: 'https://agent.test/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
        { url: 'https://agent.test/old', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
      ],
    };
    expect(() => createA2AHandler({ card, executor: () => {} })).toThrow(InvalidRequestError);
  });

  it('needs an executor', () => {
    expect(() =>
      createA2AHandler({ card: CARD, executor: undefined as unknown as A2AExecuteFunction }),
    ).toThrow(InvalidRequestError);
  });
});

describe('createA2AHandler — JSON-RPC envelope', () => {
  const { handler } = handlerWith((ctx) => ctx.reply('pong'));

  async function raw(body: string, headers: Record<string, string> = {}) {
    const response = await handler(
      new Request(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', ...headers },
        body,
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('answers malformed JSON with -32700 and a null id', async () => {
    expect(await raw('{not json')).toMatchObject({
      status: 200,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700 } },
    });
  });

  it('answers a request that is not JSON-RPC 2.0 with -32600', async () => {
    expect(await raw(JSON.stringify({ jsonrpc: '1.0', id: 7, method: 'GetTask' }))).toMatchObject({
      body: { id: 7, error: { code: -32600 } },
    });
    expect(await raw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'GetTask' }]))).toMatchObject(
      {
        body: { id: null, error: { code: -32600 } },
      },
    );
  });

  it('answers an unknown method with -32601', async () => {
    const { body } = await rpc(handler, 'tasks/get', { id: 'x' });
    expect(body.error).toMatchObject({ code: -32601 });
  });

  it('answers params that are not an object with -32602 INVALID_PARAMS', async () => {
    const { body } = await rpc(handler, 'GetTask', ['x']);
    expect(body.error).toMatchObject({ code: -32602, data: errorInfo('INVALID_PARAMS') });
  });

  it('answers a body that is not JSON with -32005 CONTENT_TYPE_NOT_SUPPORTED', async () => {
    expect(await raw('hello', { 'Content-Type': 'text/plain' })).toMatchObject({
      status: 200,
      body: { error: { code: -32005, data: errorInfo('CONTENT_TYPE_NOT_SUPPORTED') } },
    });
  });

  it('refuses a request without A2A-Version 1.0 with -32009 VERSION_NOT_SUPPORTED', async () => {
    const missing = await rpc(handler, 'GetTask', { id: 'x' }, {});
    expect(missing.status).toBe(200);
    expect(missing.body.error).toMatchObject({
      code: -32009,
      data: errorInfo('VERSION_NOT_SUPPORTED'),
    });
    const legacy = await rpc(handler, 'GetTask', { id: 'x' }, { 'A2A-Version': '0.3' });
    expect(legacy.body.error).toMatchObject({ code: -32009 });
  });

  it('answers the A2A methods it does not serve with their A2A errors', async () => {
    expect((await rpc(handler, 'ListTasks', {})).body.error).toMatchObject({
      code: -32004,
      data: errorInfo('UNSUPPORTED_OPERATION'),
    });
    expect(
      (await rpc(handler, 'CreateTaskPushNotificationConfig', { taskId: 'x', url: 'https://h' }))
        .body.error,
    ).toMatchObject({ code: -32003, data: errorInfo('PUSH_NOTIFICATION_NOT_SUPPORTED') });
    expect((await rpc(handler, 'GetExtendedAgentCard', {})).body.error).toMatchObject({
      code: -32004,
    });
  });

  it('refuses a SendMessage without a message id as INVALID_PARAMS', async () => {
    const { body } = await rpc(handler, 'SendMessage', {
      message: { role: 'ROLE_USER', parts: [{ text: 'hi' }] },
    });
    expect(body.error).toMatchObject({ code: -32602 });
  });

  it('refuses a request body over the limit with 413', async () => {
    const { handler: small } = handlerWith((ctx) => ctx.reply('pong'), { maxRequestBodyBytes: 64 });
    const response = await small(
      new Request(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: userMessage('x'.repeat(200)) },
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('answers a body that breaks off while being read with 400 and -32600', async () => {
    const { handler, errors } = handlerWith((ctx) => ctx.reply('pong'));
    const response = await handler(brokenBodyRequest(RPC_URL));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32600 } });
    expect(errors).toEqual([]);
  });
});

describe('createA2AHandler — SendMessage and the task lifecycle', () => {
  it('answers with a direct message when the executor replies', async () => {
    const { handler } = handlerWith((ctx) => ctx.reply('pong'));
    const body = await send(handler, 'ping');
    const message = (body.result as { message: Record<string, unknown> }).message;
    expect(message).toMatchObject({ role: 'ROLE_AGENT', parts: [{ text: 'pong' }] });
    expect(typeof message.messageId).toBe('string');
    expect(typeof message.contextId).toBe('string');
    expect(message.taskId).toBeUndefined();
  });

  it('creates the task at the first update and returns it once completed', async () => {
    let seen: A2AExecutionContext | undefined;
    const { handler } = handlerWith(async (ctx) => {
      seen = ctx;
      await ctx.working('on it');
      const artifactId = await ctx.artifact({ name: 'echo', parts: [{ text: 'hello' }] });
      expect(typeof artifactId).toBe('string');
      await ctx.complete();
    });
    const body = await send(handler, 'hello');
    const task = (body.result as { task: A2ATask }).task;
    expect(seen?.task).toBeUndefined();
    expect(task.id).toBe(seen?.taskId);
    expect(task.contextId).toBe(seen?.contextId);
    expect(task.status).toEqual({ state: 'TASK_STATE_COMPLETED', timestamp: NOW });
    expect(task.artifacts).toEqual([
      { artifactId: expect.any(String), name: 'echo', parts: [{ text: 'hello' }] },
    ]);
    expect(task.history).toEqual([
      { ...userMessage('hello'), taskId: task.id, contextId: task.contextId },
      {
        messageId: expect.any(String),
        role: 'ROLE_AGENT',
        parts: [{ text: 'on it' }],
        taskId: task.id,
        contextId: task.contextId,
      },
    ]);
  });

  it('keeps the context the message names', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const body = await send(handler, 'hello', { contextId: 'ctx-given' });
    expect((body.result as { task: A2ATask }).task.contextId).toBe('ctx-given');
  });

  it('completes a task whose executor returns while it is still working', async () => {
    const { handler } = handlerWith((ctx) => ctx.working());
    const body = await send(handler, 'hello');
    expect((body.result as { task: A2ATask }).task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('fails the task with the error message when the executor throws', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      throw new Error('the model is down');
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(task.status.message).toMatchObject({
      role: 'ROLE_AGENT',
      parts: [{ text: 'the model is down' }],
    });
  });

  it('creates a failed task when the executor throws before any update', async () => {
    const { handler } = handlerWith(() => {
      throw new Error('boom');
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(task.history?.[0]).toMatchObject({ messageId: 'user-hello' });
  });

  it('answers with the A2AError an executor throws before changing the task', async () => {
    const { handler } = handlerWith(() => {
      throw new A2AError({ reason: 'CONTENT_TYPE_NOT_SUPPORTED', message: 'Text only, please.' });
    });
    const body = await send(handler, 'hello');
    expect(body.error).toEqual({
      code: -32005,
      message: 'Text only, please.',
      data: errorInfo('CONTENT_TYPE_NOT_SUPPORTED'),
    });
  });

  it('answers INVALID_AGENT_RESPONSE when the executor neither replies nor updates', async () => {
    const { handler } = handlerWith(() => {});
    const body = await send(handler, 'hello');
    expect(body.error).toMatchObject({ code: -32006, data: errorInfo('INVALID_AGENT_RESPONSE') });
  });

  it('refuses a reply once the task exists', async () => {
    let failure: unknown;
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      try {
        await ctx.reply('too late');
      } catch (error) {
        failure = error;
      }
      await ctx.complete();
    });
    await send(handler, 'hello');
    expect(failure).toBeInstanceOf(A2AError);
  });

  it('rejects updates after the turn ended and reports what the executor does with that', async () => {
    let failure: unknown;
    const { handler } = handlerWith(async (ctx) => {
      await ctx.complete('done');
      try {
        await ctx.working('more?');
      } catch (error) {
        failure = error;
      }
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(failure).toBeInstanceOf(A2AError);
  });

  it('reports an executor that throws after its turn ended', async () => {
    const { handler, errors } = handlerWith(async (ctx) => {
      await ctx.complete();
      throw new Error('cleanup failed');
    });
    await send(handler, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([expect.objectContaining({ message: 'cleanup failed' })]);
  });

  it('merges status metadata into the task metadata', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working(undefined, { metadata: { runId: 'run-1' } });
      await ctx.complete(undefined, { metadata: { tokens: 12 } });
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(task.metadata).toEqual({ runId: 'run-1', tokens: 12 });
  });

  it('refuses an agent message without parts', async () => {
    let failure: unknown;
    const { handler } = handlerWith(async (ctx) => {
      try {
        await ctx.working({ metadata: { note: 'no parts' } } as unknown as string);
      } catch (error) {
        failure = error;
      }
      await ctx.complete('done');
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(failure).toBeInstanceOf(InvalidRequestError);
    expect(task.history?.every((message) => Array.isArray(message.parts))).toBe(true);
  });

  it('appends to an artifact or replaces it', async () => {
    const { handler } = handlerWith(async (ctx) => {
      const id = await ctx.artifact({ parts: [{ text: 'Hel' }] });
      await ctx.artifact(
        { artifactId: id, parts: [{ text: 'lo' }] },
        { append: true, lastChunk: true },
      );
      await ctx.artifact({ artifactId: 'fixed', parts: [{ text: 'v1' }] });
      await ctx.artifact({ artifactId: 'fixed', name: 'final', parts: [{ text: 'v2' }] });
      await ctx.complete();
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(
      task.artifacts?.map(({ artifactId, name, parts }) => ({ artifactId, name, parts })),
    ).toEqual([
      { artifactId: expect.any(String), name: undefined, parts: [{ text: 'Hel' }, { text: 'lo' }] },
      { artifactId: 'fixed', name: 'final', parts: [{ text: 'v2' }] },
    ]);
  });

  it('returns the task as soon as it exists with returnImmediately', async () => {
    const release = gate();
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      await release.promise;
      await ctx.complete();
    });
    const body = await send(handler, 'hello', {}, { returnImmediately: true });
    const task = (body.result as { task: A2ATask }).task;
    expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(task.status.state);
    release.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = await rpc(handler, 'GetTask', { id: task.id });
    expect((later.body.result as A2ATask).status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('applies historyLength to the returned task', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working('step 1');
      await ctx.complete('step 2');
    });
    const none = ((await send(handler, 'a', {}, { historyLength: 0 })).result as { task: A2ATask })
      .task;
    expect(none.history ?? []).toEqual([]);
    const last = ((await send(handler, 'b', {}, { historyLength: 1 })).result as { task: A2ATask })
      .task;
    expect(last.history?.map((message) => message.parts)).toEqual([[{ text: 'step 2' }]]);
  });
});

describe('createA2AHandler — turns of one task', () => {
  it('continues an INPUT_REQUIRED task with the next message', async () => {
    const turns: (A2ATask | undefined)[] = [];
    const { handler } = handlerWith(async (ctx) => {
      turns.push(ctx.task);
      if (!ctx.task) return ctx.requireInput('Which city?');
      await ctx.complete(`Sunny in ${ctx.message.parts[0]?.text}`);
    });
    const first = ((await send(handler, 'weather?')).result as { task: A2ATask }).task;
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(first.status.message?.parts).toEqual([{ text: 'Which city?' }]);

    const second = (
      (await send(handler, 'Izmir', { taskId: first.id, contextId: first.contextId })).result as {
        task: A2ATask;
      }
    ).task;
    expect(second.id).toBe(first.id);
    expect(second.status.state).toBe('TASK_STATE_COMPLETED');
    expect(turns[1]?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(second.history?.map((message) => [message.role, message.parts[0]?.text])).toEqual([
      ['ROLE_USER', 'weather?'],
      ['ROLE_AGENT', 'Which city?'],
      ['ROLE_USER', 'Izmir'],
      ['ROLE_AGENT', 'Sunny in Izmir'],
    ]);
  });

  it('refuses a message to an unknown task with TASK_NOT_FOUND', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const body = await send(handler, 'hi', { taskId: 'missing' });
    expect(body.error).toMatchObject({ code: -32001, data: errorInfo('TASK_NOT_FOUND') });
  });

  it('refuses a message to a finished task with UNSUPPORTED_OPERATION', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const task = ((await send(handler, 'a')).result as { task: A2ATask }).task;
    const body = await send(handler, 'b', { taskId: task.id });
    expect(body.error).toMatchObject({ code: -32004 });
  });

  it('refuses a message whose contextId is not the task’s', async () => {
    const { handler } = handlerWith((ctx) => (ctx.task ? ctx.complete() : ctx.requireInput('?')));
    const task = ((await send(handler, 'a')).result as { task: A2ATask }).task;
    const body = await send(handler, 'b', { taskId: task.id, contextId: 'another' });
    expect(body.error).toMatchObject({ code: -32602 });
  });

  it('refuses a message to a task whose turn is still running', async () => {
    const release = gate();
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      await release.promise;
      await ctx.complete();
    });
    const task = (
      (await send(handler, 'a', {}, { returnImmediately: true })).result as { task: A2ATask }
    ).task;
    const body = await send(handler, 'b', { taskId: task.id });
    expect(body.error).toMatchObject({ code: -32004 });
    release.open();
  });
});

describe('createA2AHandler — GetTask and scopes', () => {
  it('returns a stored task and trims its history to historyLength', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working('thinking');
      await ctx.complete('done');
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    const full = (await rpc(handler, 'GetTask', { id: task.id })).body.result as A2ATask;
    expect(full).toEqual(task);
    const trimmed = (await rpc(handler, 'GetTask', { id: task.id, historyLength: 1 })).body
      .result as A2ATask;
    expect(trimmed.history?.map((message) => message.parts)).toEqual([[{ text: 'done' }]]);
  });

  it('answers an unknown task with -32001 TASK_NOT_FOUND', async () => {
    const { handler } = handlerWith(() => {});
    const { status, body } = await rpc(handler, 'GetTask', { id: 'nope' });
    expect(status).toBe(200);
    expect(body.error).toMatchObject({ code: -32001, data: errorInfo('TASK_NOT_FOUND') });
  });

  it('keeps the tasks of different tenants apart', async () => {
    const store = createInMemoryA2ATaskStore();
    const { handler } = handlerWith((ctx) => ctx.complete(), { taskStore: store });
    const created = await rpc(handler, 'SendMessage', {
      tenant: 'acme',
      message: userMessage('a'),
    });
    const id = (created.body.result as { task: A2ATask }).task.id;
    expect((await rpc(handler, 'GetTask', { id, tenant: 'acme' })).body.result).toMatchObject({
      id,
    });
    expect((await rpc(handler, 'GetTask', { id, tenant: 'globex' })).body.error).toMatchObject({
      code: -32001,
    });
    expect((await rpc(handler, 'GetTask', { id })).body.error).toMatchObject({ code: -32001 });
    expect(await store.load(id, { tenant: 'acme' })).toMatchObject({ id });
  });

  it('keeps the tasks of different owners apart', async () => {
    const store = createInMemoryA2ATaskStore();
    const owners: (string | undefined)[] = [];
    const cancelOwners: (string | undefined)[] = [];
    const { handler } = handlerWith(() => {}, {
      taskStore: store,
      // A test stand-in: a real deployment returns an identity it verified.
      owner: (request) => request.headers.get('x-test-user') ?? undefined,
      executor: {
        execute: (ctx) => {
          owners.push(ctx.owner);
          return ctx.task ? ctx.complete() : ctx.requireInput('?');
        },
        cancel: (cancel) => {
          cancelOwners.push(cancel.owner);
        },
      },
    });
    const as = (user: string) => ({ 'A2A-Version': '1.0', 'x-test-user': user });
    const created = await rpc(handler, 'SendMessage', { message: userMessage('a') }, as('alice'));
    const id = (created.body.result as { task: A2ATask }).task.id;
    expect(owners).toEqual(['alice']);
    expect(await store.load(id, { owner: 'alice' })).toMatchObject({ id });

    for (const [method, params] of [
      ['GetTask', { id }],
      ['CancelTask', { id }],
      ['SubscribeToTask', { id }],
      ['SendMessage', { message: userMessage('b', { taskId: id }) }],
    ] as const) {
      const { body } = await rpc(handler, method, params, as('bob'));
      expect(body.error, method).toMatchObject({ code: -32001 });
    }
    expect((await rpc(handler, 'GetTask', { id })).body.error).toMatchObject({ code: -32001 });

    expect((await rpc(handler, 'GetTask', { id }, as('alice'))).body.result).toMatchObject({ id });
    await rpc(handler, 'CancelTask', { id }, as('alice'));
    expect(cancelOwners).toEqual(['alice']);
  });

  it('gives the executor the tenant, the request and the requested extensions it declares', async () => {
    let seen: A2AExecutionContext | undefined;
    const card: A2AAgentCard = {
      ...CARD,
      capabilities: { streaming: true, extensions: [{ uri: 'urn:ext:a' }] },
    };
    const { handler } = handlerWith(
      (ctx) => {
        seen = ctx;
        return ctx.reply('ok');
      },
      { card },
    );
    await rpc(
      handler,
      'SendMessage',
      { tenant: 'acme', message: userMessage('a'), metadata: { trace: 't' } },
      { 'A2A-Version': '1.0', 'A2A-Extensions': 'urn:ext:a, urn:ext:b' },
    );
    expect(seen?.tenant).toBe('acme');
    expect(seen?.request.metadata).toEqual({ trace: 't' });
    expect(seen?.extensions).toEqual(['urn:ext:a']);
    expect(seen?.httpRequest.url).toBe(RPC_URL);
  });

  it('refuses a client that does not request a required extension', async () => {
    const card: A2AAgentCard = {
      ...CARD,
      capabilities: { streaming: true, extensions: [{ uri: 'urn:ext:must', required: true }] },
    };
    const { handler } = handlerWith((ctx) => ctx.reply('ok'), { card });
    const refused = await send(handler, 'a');
    expect(refused.error).toMatchObject({
      code: -32008,
      data: errorInfo('EXTENSION_SUPPORT_REQUIRED'),
    });
    const served = await rpc(
      handler,
      'SendMessage',
      { message: userMessage('b') },
      { 'A2A-Version': '1.0', 'A2A-Extensions': 'urn:ext:must' },
    );
    expect(served.body.result).toMatchObject({ message: { parts: [{ text: 'ok' }] } });
  });
});

/** POST a streaming JSON-RPC request; the raw response. */
async function rpcStream(
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: unknown,
) {
  const id = ++rpcId;
  const response = await handler(
    new Request(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'A2A-Version': '1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
  );
  return { id, response };
}

/** Reads an SSE response one event at a time; `data` is parsed JSON. */
function sseReader(response: Response) {
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const iterator = parseSSE(response.body as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
  async function next(): Promise<{ event?: string; data: Record<string, unknown> } | undefined> {
    const { done, value } = await iterator.next();
    if (done) return undefined;
    return {
      ...(value.event ? { event: value.event } : {}),
      data: JSON.parse(value.data) as Record<string, unknown>,
    };
  }
  return {
    next,
    async rest() {
      const events: { event?: string; data: Record<string, unknown> }[] = [];
      for (let event = await next(); event; event = await next()) events.push(event);
      return events;
    },
    close: () => iterator.return?.(undefined),
  };
}

/** The `result` of each JSON-RPC envelope of a stream, checked against the request id. */
async function results(id: number, response: Response): Promise<Record<string, unknown>[]> {
  const events = await sseReader(response).rest();
  for (const { data } of events) expect(data).toMatchObject({ jsonrpc: '2.0', id });
  return events.map(({ data }) => data.result as Record<string, unknown>);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createA2AHandler — SendStreamingMessage', () => {
  it('streams the task lifecycle as JSON-RPC responses over SSE', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working('on it');
      await ctx.artifact({ artifactId: 'answer', parts: [{ text: 'hello' }] }, { lastChunk: true });
      await ctx.complete();
    });
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello'),
    });
    const events = await results(id, response);
    const task = (events[0] as { task: A2ATask }).task;
    expect(events).toEqual([
      {
        task: {
          id: task.id,
          contextId: task.contextId,
          status: { state: 'TASK_STATE_SUBMITTED', timestamp: NOW },
          artifacts: [],
          history: [{ ...userMessage('hello'), taskId: task.id, contextId: task.contextId }],
        },
      },
      {
        statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status: {
            state: 'TASK_STATE_WORKING',
            message: {
              messageId: expect.any(String),
              role: 'ROLE_AGENT',
              parts: [{ text: 'on it' }],
              taskId: task.id,
              contextId: task.contextId,
            },
            timestamp: NOW,
          },
        },
      },
      {
        artifactUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          artifact: { artifactId: 'answer', parts: [{ text: 'hello' }] },
          lastChunk: true,
        },
      },
      {
        statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status: { state: 'TASK_STATE_COMPLETED', timestamp: NOW },
        },
      },
    ]);
  });

  it('streams a direct reply as one message event', async () => {
    const { handler } = handlerWith((ctx) => ctx.reply('pong'));
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('ping'),
    });
    const events = await results(id, response);
    expect(events).toEqual([{ message: expect.objectContaining({ parts: [{ text: 'pong' }] }) }]);
  });

  it('applies historyLength to the streamed task snapshot', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello'),
      configuration: { historyLength: 0 },
    });
    const [first] = await results(id, response);
    expect((first as { task: A2ATask }).task.history).toEqual([]);
  });

  it('answers a refused stream request with a plain JSON-RPC error', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello', { taskId: 'missing' }),
    });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({ id, error: { code: -32001 } });
  });

  it('answers an A2AError the executor throws before any event as plain JSON-RPC', async () => {
    const { handler } = handlerWith(() => {
      throw new A2AError({ reason: 'CONTENT_TYPE_NOT_SUPPORTED', message: 'Text only.' });
    });
    const { response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello'),
    });
    expect(await response.json()).toMatchObject({ error: { code: -32005, message: 'Text only.' } });
  });

  it('refuses streams when the card does not declare streaming', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete(), {
      card: { ...CARD, capabilities: {} },
    });
    const sent = await rpcStream(handler, 'SendStreamingMessage', { message: userMessage('a') });
    expect(await sent.response.json()).toMatchObject({ error: { code: -32004 } });
    const subscribed = await rpcStream(handler, 'SubscribeToTask', { id: 'x' });
    expect(await subscribed.response.json()).toMatchObject({ error: { code: -32004 } });
  });

  it('streams a failure after the first event as a FAILED status update', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      throw new Error('the model is down');
    });
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello'),
    });
    const events = await results(id, response);
    expect(events.at(-1)).toMatchObject({
      statusUpdate: {
        status: { state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'the model is down' }] } },
      },
    });
  });

  it('ends a stream whose turn is refused after the snapshot with an SSE error event', async () => {
    const { handler } = handlerWith((ctx) => {
      if (!ctx.task) return ctx.requireInput('Which city?');
      throw new A2AError({ reason: 'CONTENT_TYPE_NOT_SUPPORTED', message: 'Text only.' });
    });
    const task = ((await send(handler, 'weather?')).result as { task: A2ATask }).task;
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: { ...userMessage('a picture'), taskId: task.id },
    });
    const events = await sseReader(response).rest();
    expect(events.map(({ event }) => event)).toEqual([undefined, 'error']);
    expect(events[0]?.data).toMatchObject({ id, result: { task: { id: task.id } } });
    expect(events[1]?.data).toMatchObject({
      jsonrpc: '2.0',
      id,
      error: { code: -32005, message: 'Text only.' },
    });
    const stored = (await rpc(handler, 'GetTask', { id: task.id })).body.result as A2ATask;
    expect(stored.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('keeps the task running when the client leaves the stream', async () => {
    const release = gate();
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      await release.promise;
      await ctx.complete();
    });
    const { response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello'),
    });
    const reader = sseReader(response);
    const first = (await reader.next())?.data.result as { task: A2ATask };
    await reader.close();
    release.open();
    await tick();
    const stored = (await rpc(handler, 'GetTask', { id: first.task.id })).body.result as A2ATask;
    expect(stored.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('createA2AHandler — SubscribeToTask', () => {
  it('streams a running task from a snapshot to the end of its turn', async () => {
    const release = gate();
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      await release.promise;
      await ctx.artifact({ artifactId: 'a', parts: [{ text: 'late' }] });
      await ctx.complete();
    });
    const task = (
      (await send(handler, 'hello', {}, { returnImmediately: true })).result as { task: A2ATask }
    ).task;
    const { id, response } = await rpcStream(handler, 'SubscribeToTask', { id: task.id });
    const reader = sseReader(response);
    const snapshot = await reader.next();
    expect(snapshot?.data).toMatchObject({
      id,
      result: { task: { id: task.id, status: { state: 'TASK_STATE_WORKING' } } },
    });
    release.open();
    const rest = (await reader.rest()).map(({ data }) => data.result);
    expect(rest).toEqual([
      {
        artifactUpdate: expect.objectContaining({
          artifact: { artifactId: 'a', parts: [{ text: 'late' }] },
        }),
      },
      {
        statusUpdate: expect.objectContaining({
          status: { state: 'TASK_STATE_COMPLETED', timestamp: NOW },
        }),
      },
    ]);
  });

  it('yields the snapshot of a task waiting for input and ends', async () => {
    const { handler } = handlerWith((ctx) => ctx.requireInput('Which city?'));
    const task = ((await send(handler, 'weather?')).result as { task: A2ATask }).task;
    const { id, response } = await rpcStream(handler, 'SubscribeToTask', { id: task.id });
    expect(await results(id, response)).toEqual([{ task }]);
  });

  it('refuses an unknown task and a finished one', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const missing = await rpcStream(handler, 'SubscribeToTask', { id: 'missing' });
    expect(await missing.response.json()).toMatchObject({ error: { code: -32001 } });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    const finished = await rpcStream(handler, 'SubscribeToTask', { id: task.id });
    expect(await finished.response.json()).toMatchObject({
      error: { code: -32004, data: errorInfo('UNSUPPORTED_OPERATION') },
    });
  });
});

describe('createA2AHandler — CancelTask', () => {
  it('aborts the running turn, ends its streams and returns the canceled task', async () => {
    let signal: AbortSignal | undefined;
    let lateUpdate: unknown;
    const stopped = gate();
    const { handler, errors } = handlerWith(async (ctx) => {
      signal = ctx.signal;
      await ctx.working();
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
      try {
        await ctx.working('still here?');
      } catch (error) {
        lateUpdate = error;
      }
      stopped.open();
    });
    const { id, response } = await rpcStream(handler, 'SendStreamingMessage', {
      message: userMessage('hello'),
    });
    const reader = sseReader(response);
    const task = ((await reader.next())?.data.result as { task: A2ATask }).task;
    expect((await reader.next())?.data.result).toMatchObject({
      statusUpdate: { status: { state: 'TASK_STATE_WORKING' } },
    });

    const canceled = (await rpc(handler, 'CancelTask', { id: task.id })).body.result as A2ATask;
    expect(canceled.status).toEqual({ state: 'TASK_STATE_CANCELED', timestamp: NOW });
    expect((await reader.rest()).map(({ data }) => data)).toEqual([
      {
        jsonrpc: '2.0',
        id,
        result: {
          statusUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            status: { state: 'TASK_STATE_CANCELED', timestamp: NOW },
          },
        },
      },
    ]);
    await stopped.promise;
    expect(signal?.aborted).toBe(true);
    expect(lateUpdate).toBeInstanceOf(A2AError);
    expect(errors).toEqual([]);
  });

  it('returns a canceled task again and refuses a finished or unknown one', async () => {
    const { handler } = handlerWith((ctx) => (ctx.task ? ctx.complete() : ctx.requireInput('?')));
    const waiting = ((await send(handler, 'a')).result as { task: A2ATask }).task;
    const first = (await rpc(handler, 'CancelTask', { id: waiting.id })).body.result;
    expect((await rpc(handler, 'CancelTask', { id: waiting.id })).body.result).toEqual(first);

    const { handler: done } = handlerWith((ctx) => ctx.complete());
    const finished = ((await send(done, 'b')).result as { task: A2ATask }).task;
    expect((await rpc(done, 'CancelTask', { id: finished.id })).body.error).toMatchObject({
      code: -32002,
      data: errorInfo('TASK_NOT_CANCELABLE'),
    });
    expect((await rpc(done, 'CancelTask', { id: 'missing' })).body.error).toMatchObject({
      code: -32001,
    });
  });

  it('cancels a task waiting for input after telling executor.cancel, which no message can resume', async () => {
    const told: { running: boolean; state: string; metadata: unknown }[] = [];
    const { handler } = handlerWith(() => {}, {
      executor: {
        execute: (ctx) => (ctx.task ? ctx.complete() : ctx.requireInput('Which city?')),
        cancel: (cancel) => {
          told.push({
            running: cancel.running,
            state: cancel.task.status.state,
            metadata: cancel.request.metadata,
          });
        },
      },
    });
    const task = ((await send(handler, 'weather?')).result as { task: A2ATask }).task;
    const canceled = await rpc(handler, 'CancelTask', { id: task.id, metadata: { why: 'user' } });
    expect((canceled.body.result as A2ATask).status.state).toBe('TASK_STATE_CANCELED');
    expect(told).toEqual([
      { running: false, state: 'TASK_STATE_INPUT_REQUIRED', metadata: { why: 'user' } },
    ]);
    expect((await send(handler, 'Izmir', { taskId: task.id })).error).toMatchObject({
      code: -32004,
    });
  });

  it('does not report the auto-complete a concurrent cancel made pointless', async () => {
    const finish = gate();
    const allowCancel = gate();
    const { handler, errors } = handlerWith(() => {}, {
      executor: {
        // Resolves while WORKING, so the handler completes the task itself.
        execute: async (ctx) => {
          await ctx.working();
          await finish.promise;
        },
        cancel: () => allowCancel.promise,
      },
    });
    const task = (
      (await send(handler, 'a', {}, { returnImmediately: true })).result as { task: A2ATask }
    ).task;
    const canceling = rpc(handler, 'CancelTask', { id: task.id });
    await tick();
    finish.open(); // the auto-complete now waits behind the cancel
    await tick();
    allowCancel.open();
    expect(((await canceling).body.result as A2ATask).status.state).toBe('TASK_STATE_CANCELED');
    await tick();
    expect(errors).toEqual([]);
  });

  it('lets executor.cancel refuse with TASK_NOT_CANCELABLE', async () => {
    const { handler } = handlerWith(() => {}, {
      executor: {
        execute: (ctx) => ctx.requireInput('?'),
        cancel: () => {
          throw new A2AError({ reason: 'TASK_NOT_CANCELABLE', message: 'Payment already sent.' });
        },
      },
    });
    const task = ((await send(handler, 'pay')).result as { task: A2ATask }).task;
    expect((await rpc(handler, 'CancelTask', { id: task.id })).body.error).toMatchObject({
      code: -32002,
      message: 'Payment already sent.',
    });
    const stored = (await rpc(handler, 'GetTask', { id: task.id })).body.result as A2ATask;
    expect(stored.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  });
});

describe('createA2AHandler — AUTH_REQUIRED', () => {
  it('answers a blocking call at AUTH_REQUIRED and keeps the turn open', async () => {
    const authorized = gate();
    const { handler } = handlerWith(async (ctx) => {
      await ctx.requireAuth('Sign in at https://auth.test');
      await authorized.promise;
      await ctx.complete('Signed in and done.');
    });
    const task = ((await send(handler, 'hello')).result as { task: A2ATask }).task;
    expect(task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');

    expect((await send(handler, 'again', { taskId: task.id })).error).toMatchObject({
      code: -32004,
    });

    const { id, response } = await rpcStream(handler, 'SubscribeToTask', { id: task.id });
    const reader = sseReader(response);
    expect((await reader.next())?.data).toMatchObject({
      id,
      result: { task: { status: { state: 'TASK_STATE_AUTH_REQUIRED' } } },
    });
    authorized.open();
    expect((await reader.rest()).map(({ data }) => data.result)).toEqual([
      {
        statusUpdate: expect.objectContaining({
          status: expect.objectContaining({ state: 'TASK_STATE_COMPLETED' }),
        }),
      },
    ]);
  });
});

/** One HTTP+JSON request; `body` is sent as JSON. */
async function rest(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request(`${REST_URL}${path}`, {
      method,
      headers: {
        'A2A-Version': '1.0',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    }),
  );
}

/** A google.rpc.Status error body as the HTTP+JSON binding writes it. */
const restErrorBody = (code: number, status: string, reason?: string) => ({
  error: {
    code,
    status,
    message: expect.any(String),
    details: reason ? errorInfo(reason) : [],
  },
});

describe('createA2AHandler — HTTP+JSON binding', () => {
  it('runs a turn for POST /message:send and answers the task as application/a2a+json', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.artifact({ parts: [{ text: 'hello' }] });
      await ctx.complete();
    });
    const response = await rest(handler, 'POST', '/message:send', {
      message: userMessage('hello'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/a2a+json');
    const body = (await response.json()) as { task: A2ATask };
    expect(body.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(body.task.artifacts?.[0]?.parts).toEqual([{ text: 'hello' }]);
  });

  it('answers a direct reply as { message }', async () => {
    const { handler } = handlerWith((ctx) => ctx.reply('pong'));
    const response = await rest(handler, 'POST', '/message:send', { message: userMessage('ping') });
    expect(await response.json()).toMatchObject({ message: { parts: [{ text: 'pong' }] } });
  });

  it('gets a task with GET /tasks/{id}, honouring historyLength', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete('done'));
    const created = (await (
      await rest(handler, 'POST', '/message:send', { message: userMessage('hello') })
    ).json()) as { task: A2ATask };
    const full = (await (
      await rest(handler, 'GET', `/tasks/${created.task.id}`)
    ).json()) as A2ATask;
    expect(full).toEqual(created.task);
    const trimmed = (await (
      await rest(handler, 'GET', `/tasks/${created.task.id}?historyLength=1`)
    ).json()) as A2ATask;
    expect(trimmed.history?.map((message) => message.parts)).toEqual([[{ text: 'done' }]]);
  });

  it('cancels with POST /tasks/{id}:cancel and no body', async () => {
    const { handler } = handlerWith((ctx) => ctx.requireInput('Which city?'));
    const created = (await (
      await rest(handler, 'POST', '/message:send', { message: userMessage('weather?') })
    ).json()) as { task: A2ATask };
    const response = await handler(
      new Request(`${REST_URL}/tasks/${created.task.id}:cancel`, {
        method: 'POST',
        headers: { 'A2A-Version': '1.0', 'Content-Type': 'application/json' },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as A2ATask).status.state).toBe('TASK_STATE_CANCELED');
  });

  it('round-trips a task id that needs encoding', async () => {
    let next = 0;
    const { handler } = handlerWith((ctx) => ctx.requireInput('?'), {
      deps: {
        generateId: () => (++next === 1 ? 'urn:task/1' : `id-${next}`),
        clock: { now: () => Date.parse(NOW), setTimeout: () => () => {} },
      },
    });
    await rest(handler, 'POST', '/message:send', { message: userMessage('a') });
    const id = encodeURIComponent('urn:task/1');
    expect(await (await rest(handler, 'GET', `/tasks/${id}`)).json()).toMatchObject({
      id: 'urn:task/1',
    });
    expect(await (await rest(handler, 'POST', `/tasks/${id}:cancel`, {})).json()).toMatchObject({
      id: 'urn:task/1',
      status: { state: 'TASK_STATE_CANCELED' },
    });
  });

  it('streams POST /message:stream as bare StreamResponse events', async () => {
    const { handler } = handlerWith(async (ctx) => {
      await ctx.working();
      await ctx.complete();
    });
    const response = await rest(handler, 'POST', '/message:stream', {
      message: userMessage('hello'),
    });
    const events = (await sseReader(response).rest()).map(({ data }) => data);
    expect(events.map((event) => Object.keys(event))).toEqual([
      ['task'],
      ['statusUpdate'],
      ['statusUpdate'],
    ]);
    expect(events[2]).toMatchObject({
      statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } },
    });
  });

  it('subscribes with GET or POST /tasks/{id}:subscribe', async () => {
    const { handler } = handlerWith((ctx) => ctx.requireInput('?'));
    const created = (await (
      await rest(handler, 'POST', '/message:send', { message: userMessage('a') })
    ).json()) as { task: A2ATask };
    for (const method of ['GET', 'POST']) {
      const response = await rest(handler, method, `/tasks/${created.task.id}:subscribe`);
      expect((await sseReader(response).rest()).map(({ data }) => data)).toEqual([
        { task: created.task },
      ]);
    }
  });

  it('scopes tasks by the tenant path segment', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const created = (await (
      await rest(handler, 'POST', '/acme/message:send', { message: userMessage('a') })
    ).json()) as { task: A2ATask };
    expect((await rest(handler, 'GET', `/acme/tasks/${created.task.id}`)).status).toBe(200);
    expect((await rest(handler, 'GET', `/tasks/${created.task.id}`)).status).toBe(404);
  });

  it('writes errors as google.rpc.Status bodies with the binding’s HTTP status', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const missing = await rest(handler, 'GET', '/tasks/missing');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/a2a+json');
    expect(await missing.json()).toEqual(restErrorBody(404, 'NOT_FOUND', 'TASK_NOT_FOUND'));

    const created = (await (
      await rest(handler, 'POST', '/message:send', { message: userMessage('a') })
    ).json()) as { task: A2ATask };
    const notCancelable = await rest(handler, 'POST', `/tasks/${created.task.id}:cancel`, {});
    expect(notCancelable.status).toBe(400);
    expect(await notCancelable.json()).toEqual(
      restErrorBody(400, 'FAILED_PRECONDITION', 'TASK_NOT_CANCELABLE'),
    );
  });

  it('refuses a request without A2A-Version 1.0', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const response = await rest(handler, 'GET', '/tasks/x', undefined, { 'A2A-Version': '' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      restErrorBody(400, 'FAILED_PRECONDITION', 'VERSION_NOT_SUPPORTED'),
    );
  });

  it('refuses malformed JSON and other content types', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const malformed = await rest(handler, 'POST', '/message:send', '{not json');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(
      restErrorBody(400, 'INVALID_ARGUMENT', 'INVALID_PARAMS'),
    );
    const text = await rest(handler, 'POST', '/message:send', 'hello', {
      'Content-Type': 'text/plain',
    });
    expect(await text.json()).toEqual(
      restErrorBody(400, 'INVALID_ARGUMENT', 'CONTENT_TYPE_NOT_SUPPORTED'),
    );
    const a2aJson = await rest(
      handler,
      'POST',
      '/message:send',
      { message: userMessage('a') },
      {
        'Content-Type': 'application/a2a+json',
      },
    );
    expect(a2aJson.status).toBe(200);
  });

  it('answers the routes it does not serve with their A2A errors', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    expect(await (await rest(handler, 'GET', '/tasks')).json()).toEqual(
      restErrorBody(400, 'FAILED_PRECONDITION', 'UNSUPPORTED_OPERATION'),
    );
    for (const [method, path] of [
      ['POST', '/tasks/t1/pushNotificationConfigs'],
      ['GET', '/tasks/t1/pushNotificationConfigs'],
      ['GET', '/tasks/t1/pushNotificationConfigs/c1'],
      ['DELETE', '/tasks/t1/pushNotificationConfigs/c1'],
    ] as const) {
      expect(await (await rest(handler, method, path)).json()).toEqual(
        restErrorBody(400, 'FAILED_PRECONDITION', 'PUSH_NOTIFICATION_NOT_SUPPORTED'),
      );
    }
    expect(await (await rest(handler, 'GET', '/extendedAgentCard')).json()).toEqual(
      restErrorBody(400, 'FAILED_PRECONDITION', 'UNSUPPORTED_OPERATION'),
    );
  });

  it('answers a body that breaks off while being read with 400', async () => {
    const { handler, errors } = handlerWith((ctx) => ctx.reply('pong'));
    const response = await handler(brokenBodyRequest(`${REST_URL}/message:send`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(restErrorBody(400, 'INVALID_ARGUMENT', 'INVALID_PARAMS'));
    expect(errors).toEqual([]);
  });

  it('answers an unknown route with 404 and a wrong method with 405', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    expect((await rest(handler, 'GET', '/messages')).status).toBe(404);
    const wrong = await rest(handler, 'GET', '/message:send');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
  });

  it('answers a stream refused before its first event with an error body', async () => {
    const { handler } = handlerWith((ctx) => ctx.complete());
    const response = await rest(handler, 'POST', '/message:stream', {
      message: userMessage('a', { taskId: 'missing' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(restErrorBody(404, 'NOT_FOUND', 'TASK_NOT_FOUND'));
  });

  it('ends a stream refused after the snapshot with an `event: error` status body', async () => {
    const { handler } = handlerWith((ctx) => {
      if (!ctx.task) return ctx.requireInput('Which city?');
      throw new A2AError({ reason: 'CONTENT_TYPE_NOT_SUPPORTED', message: 'Text only.' });
    });
    const created = (await (
      await rest(handler, 'POST', '/message:send', { message: userMessage('weather?') })
    ).json()) as { task: A2ATask };
    const response = await rest(handler, 'POST', '/message:stream', {
      message: { ...userMessage('a picture'), taskId: created.task.id },
    });
    const events = await sseReader(response).rest();
    expect(events.map(({ event }) => event)).toEqual([undefined, 'error']);
    expect(events[1]?.data).toEqual({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Text only.',
        details: errorInfo('CONTENT_TYPE_NOT_SUPPORTED'),
      },
    });
  });
});
