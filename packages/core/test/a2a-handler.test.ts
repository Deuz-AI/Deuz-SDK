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
