/**
 * `@deuz-sdk/core/a2a` (2.3) — interop with `@a2a-js/sdk` 1.3.0, the official
 * A2A v1.0.0 SDK, in both directions and over both bindings.
 *
 * - The SDK's client (`ClientFactory` with its JSON-RPC and REST transports
 *   and its card resolver) drives `createA2AHandler` in-process through
 *   `fetchImpl`.
 * - `createA2AClient` drives the SDK's server. Over JSON-RPC that is the SDK's
 *   transport-independent pieces (`DefaultRequestHandler`, `InMemoryTaskStore`,
 *   `JsonRpcTransportHandler`) behind a fetch adapter that does what the SDK's
 *   express `jsonRpcHandler` does. Over HTTP+JSON it is the SDK's express
 *   `restHandler` itself (its REST transport handler is not exported) on a
 *   127.0.0.1 listener.
 *
 * Both agents behave alike — an echo with an artifact, a direct reply, a
 * question (`INPUT_REQUIRED`) and a slow task to subscribe to and cancel — so
 * every scenario runs against each side. Offline: only loopback traffic.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentCard as SdkAgentCard,
  CancelTaskRequest as SdkCancelTaskRequest,
  Extensions as SdkExtensions,
  GetTaskRequest as SdkGetTaskRequest,
  Message as SdkMessage,
  SSE_HEADERS,
  SendMessageRequest as SdkSendMessageRequest,
  SubscribeToTaskRequest as SdkSubscribeToTaskRequest,
  Task as SdkTask,
  TaskState,
  formatSSEErrorEvent,
  formatSSEEvent,
  taskStateFromJSON,
  type StreamResponse as SdkStreamResponse,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client as SdkClient,
} from '@a2a-js/sdk/client';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, restHandler } from '@a2a-js/sdk/server/express';
import { TaskNotCancelableError, TaskNotFoundError } from '@a2a-js/sdk/errors';
import {
  A2AError,
  createA2AClient,
  createA2AHandler,
  fetchAgentCard,
  type A2ABinding,
  type A2AClient,
  type A2AExecuteFunction,
  type A2AStreamResponse,
  type A2ATask,
} from '../src/a2a';

type Fetch = typeof globalThis.fetch;

const BINDINGS: A2ABinding[] = ['JSONRPC', 'HTTP+JSON'];

const textOf = (parts: readonly { text?: string }[] | undefined) =>
  (parts ?? []).map((part) => part.text ?? '').join('');

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

// --- the SDK's client against createA2AHandler --------------------------------

const DEUZ_ORIGIN = 'https://deuz-agent.test';

const deuzExecutor: A2AExecuteFunction = async (ctx) => {
  const text = textOf(ctx.message.parts);
  if (ctx.task) return ctx.complete(`Sunny in ${text}`);
  if (text === 'ping') return ctx.reply('pong');
  if (text === 'weather?') return ctx.requireInput('Which city?');
  if (text === 'slow') {
    await ctx.working();
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
    return;
  }
  await ctx.working('on it');
  await ctx.artifact({ artifactId: 'answer', name: 'answer', parts: [{ text: `echo: ${text}` }] });
  await ctx.complete();
};

function deuzHandler() {
  return createA2AHandler({
    card: {
      name: 'Deuz echo',
      description: 'Echoes, asks and waits.',
      version: '1.0.0',
      supportedInterfaces: [
        { url: `${DEUZ_ORIGIN}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: `${DEUZ_ORIGIN}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      ],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo', name: 'Echo', description: 'Echoes.', tags: ['echo'] }],
    },
    executor: deuzExecutor,
  });
}

let messages = 0;
const sdkSend = (text: string, extra: Record<string, unknown> = {}, configuration?: unknown) =>
  SdkSendMessageRequest.fromJSON({
    message: { messageId: `sdk-${++messages}`, role: 'ROLE_USER', parts: [{ text }], ...extra },
    ...(configuration ? { configuration } : {}),
  });

async function sdkClientOf(
  handler: (request: Request) => Promise<Response>,
  binding: A2ABinding,
): Promise<SdkClient> {
  const fetchImpl: Fetch = (input, init) => handler(new Request(input, init));
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl }),
        new RestTransportFactory({ fetchImpl }),
      ],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      preferredTransports: [binding],
    }),
  );
  return factory.createFromUrl(DEUZ_ORIGIN);
}

const sdkText = (parts: readonly { content?: { $case: string; value?: unknown } }[] | undefined) =>
  (parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? String(part.content.value) : ''))
    .join('');

async function sdkEvents(stream: AsyncIterable<SdkStreamResponse>): Promise<SdkStreamResponse[]> {
  const events: SdkStreamResponse[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe.each(BINDINGS)('the @a2a-js/sdk client against createA2AHandler (%s)', (binding) => {
  it('discovers the card and talks over the binding asked for', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    expect((await client.getAgentCard()).name).toBe('Deuz echo');
    expect(client.transport.protocolName).toBe(binding);
    expect(client.protocolVersion).toBe('1.0');
  });

  it('sends a message and gets the completed task with its artifact', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    const result = await client.sendMessage(sdkSend('hello'));
    if (!('status' in result)) throw new Error('expected a task');
    expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(sdkText(result.artifacts[0]?.parts)).toBe('echo: hello');
    expect(result.history.map((message) => sdkText(message.parts))).toEqual(['hello', 'on it']);
  });

  it('gets a direct message answer', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    const result = await client.sendMessage(sdkSend('ping'));
    if (!('messageId' in result)) throw new Error('expected a message');
    expect(sdkText(result.parts)).toBe('pong');
  });

  it('streams the task lifecycle', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    const events = await sdkEvents(client.sendMessageStream(sdkSend('hello')));
    expect(events.map((event) => event.payload?.$case)).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    const last = events.at(-1)?.payload;
    expect(last?.$case === 'statusUpdate' && last.value.status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
  });

  it('answers a question and continues the task with the next message', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    const asked = await client.sendMessage(sdkSend('weather?'));
    if (!('status' in asked)) throw new Error('expected a task');
    expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(sdkText(asked.status?.message?.parts)).toBe('Which city?');

    const done = await client.sendMessage(
      sdkSend('Izmir', { taskId: asked.id, contextId: asked.contextId }),
    );
    if (!('status' in done)) throw new Error('expected a task');
    expect(done.id).toBe(asked.id);
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(sdkText(done.status?.message?.parts)).toBe('Sunny in Izmir');
  });

  it('gets a task with historyLength and maps errors onto the SDK’s classes', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    const created = await client.sendMessage(sdkSend('hello'));
    if (!('status' in created)) throw new Error('expected a task');
    const task = await client.getTask(
      SdkGetTaskRequest.fromJSON({ id: created.id, historyLength: 1 }),
    );
    expect(task.history.map((message) => sdkText(message.parts))).toEqual(['on it']);

    await expect(
      client.getTask(SdkGetTaskRequest.fromJSON({ id: 'missing' })),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      client.cancelTask(SdkCancelTaskRequest.fromJSON({ id: created.id })),
    ).rejects.toBeInstanceOf(TaskNotCancelableError);
  });

  it('resubscribes to a running task and sees it canceled', async () => {
    const client = await sdkClientOf(deuzHandler(), binding);
    const started = await client.sendMessage(sdkSend('slow', {}, { returnImmediately: true }));
    if (!('status' in started)) throw new Error('expected a task');

    const subscription = client
      .resubscribeTask(SdkSubscribeToTaskRequest.fromJSON({ id: started.id }))
      [Symbol.asyncIterator]();
    const snapshot = await subscription.next();
    expect(snapshot.value?.payload?.$case).toBe('task');

    const canceled = await client.cancelTask(SdkCancelTaskRequest.fromJSON({ id: started.id }));
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);

    const rest: SdkStreamResponse[] = [];
    for (let next = await subscription.next(); !next.done; next = await subscription.next()) {
      rest.push(next.value);
    }
    expect(rest.map((event) => event.payload?.$case)).toEqual(['statusUpdate']);
    const update = rest[0]?.payload;
    expect(update?.$case === 'statusUpdate' && update.value.status?.state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
  });
});

// --- createA2AClient against the SDK's server -----------------------------------

/** The SDK side of the scenarios, written the way the SDK's samples write agents. */
function sdkExecutor(released: Set<() => void>): AgentExecutor {
  const contexts = new Map<string, string>();
  const now = () => new Date().toISOString();
  const status = (taskId: string, contextId: string, state: string, text?: string) =>
    AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: taskStateFromJSON(state),
        message: text
          ? SdkMessage.fromJSON({
              messageId: `${taskId}-${state}`,
              role: 'ROLE_AGENT',
              taskId,
              contextId,
              parts: [{ text }],
            })
          : undefined,
        timestamp: now(),
      },
      metadata: undefined,
    });
  return {
    async execute(context: RequestContext, bus: ExecutionEventBus) {
      const { taskId, contextId } = context;
      contexts.set(taskId, contextId);
      const text = sdkText(context.userMessage.parts);
      if (!context.task && text === 'ping') {
        bus.publish(
          AgentEvent.message(
            SdkMessage.fromJSON({
              messageId: `reply-${taskId}`,
              role: 'ROLE_AGENT',
              contextId,
              parts: [{ text: 'pong' }],
            }),
          ),
        );
        bus.finished();
        return;
      }
      bus.publish(
        AgentEvent.task(
          context.task ??
            SdkTask.fromJSON({
              id: taskId,
              contextId,
              status: { state: 'TASK_STATE_SUBMITTED', timestamp: now() },
              history: [SdkMessage.toJSON(context.userMessage)],
            }),
        ),
      );
      if (context.task) {
        bus.publish(status(taskId, contextId, 'TASK_STATE_COMPLETED', `Sunny in ${text}`));
        bus.finished();
        return;
      }
      if (text === 'weather?') {
        bus.publish(status(taskId, contextId, 'TASK_STATE_INPUT_REQUIRED', 'Which city?'));
        bus.finished();
        return;
      }
      bus.publish(status(taskId, contextId, 'TASK_STATE_WORKING', 'on it'));
      if (text === 'slow') {
        const release = gate();
        released.add(release.open);
        await release.promise;
        return;
      }
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: 'answer',
            name: 'answer',
            description: '',
            parts: SdkMessage.fromJSON({ parts: [{ text: `echo: ${text}` }] }).parts,
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      bus.publish(status(taskId, contextId, 'TASK_STATE_COMPLETED'));
      bus.finished();
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus) {
      bus.publish(status(taskId, contexts.get(taskId) ?? '', 'TASK_STATE_CANCELED'));
      bus.finished();
    },
  };
}

function sdkCard(base: string) {
  return SdkAgentCard.fromJSON({
    name: 'SDK echo',
    description: 'Echoes, asks and waits.',
    version: '1.0.0',
    supportedInterfaces: [
      { url: `${base}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${base}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ],
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes.', tags: ['echo'] }],
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The SDK's JSON-RPC server without express: what `jsonRpcHandler` from
 * `@a2a-js/sdk/server/express` does around `JsonRpcTransportHandler` — the
 * version check, the first event awaited before the stream starts (an error
 * there is plain JSON-RPC), `formatSSEEvent` per event and `formatSSEErrorEvent`
 * for a failure after it — plus the card endpoint (`agentCardHandler` sends
 * the card as the SDK holds it).
 */
function sdkJsonRpcFetch(requestHandler: DefaultRequestHandler): Fetch {
  const transport = new JsonRpcTransportHandler(requestHandler);
  const encoder = new TextEncoder();
  return async (input, init) => {
    const request = new Request(input, init);
    if (
      request.method === 'GET' &&
      new URL(request.url).pathname === '/.well-known/agent-card.json'
    ) {
      return json(await requestHandler.getAgentCard());
    }
    const body = (await request.json()) as Record<string, unknown>;
    const id = (body.id as string | number | undefined) ?? null;
    const failure = (error: unknown) => ({
      jsonrpc: '2.0',
      id,
      error: JsonRpcTransportHandler.mapToJSONRPCError(error),
    });
    try {
      const context = new ServerCallContext({
        requestedExtensions: SdkExtensions.parseServiceParameter(
          request.headers.get('A2A-Extensions') ?? undefined,
        ),
        user: new UnauthenticatedUser(),
        requestedVersion: request.headers.get('A2A-Version') || undefined,
      });
      validateVersion(context.requestedVersion, await requestHandler.getAgentCard(), 'JSONRPC');
      const result = await transport.handle(body, context);
      if (!(Symbol.asyncIterator in result)) return json(result);
      const iterator = result[Symbol.asyncIterator]();
      let first: IteratorResult<unknown>;
      try {
        first = await iterator.next();
      } catch (error) {
        return json(failure(error));
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            if (!first.done) controller.enqueue(encoder.encode(formatSSEEvent(first.value)));
            for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
              controller.enqueue(encoder.encode(formatSSEEvent(next.value)));
            }
          } catch (error) {
            controller.enqueue(encoder.encode(formatSSEErrorEvent(failure(error))));
          } finally {
            controller.close();
          }
        },
        cancel() {
          void iterator.return?.(undefined);
        },
      });
      return new Response(stream, { headers: SSE_HEADERS });
    } catch (error) {
      const answer = failure(error);
      return json(answer, answer.error.code === -32603 ? 500 : 200);
    }
  };
}

interface SdkServer {
  base: string;
  fetch: Fetch;
  close(): Promise<void>;
}

const releases = new Set<() => void>();

/** The SDK server over JSON-RPC, in-process. */
async function sdkJsonRpcServer(): Promise<SdkServer> {
  const base = 'https://sdk-agent.test';
  const requestHandler = new DefaultRequestHandler(
    sdkCard(base),
    new InMemoryTaskStore(),
    sdkExecutor(releases),
  );
  return { base, fetch: sdkJsonRpcFetch(requestHandler), close: async () => {} };
}

/** The part of an express application this file uses. */
interface ExpressApp {
  (request: IncomingMessage, response: ServerResponse): void;
  use(path: string, handler: unknown): void;
}

/** The SDK server over HTTP+JSON: its express handlers on 127.0.0.1. */
async function sdkRestServer(): Promise<SdkServer> {
  // express ships no types and is only needed here; load it by name.
  const expressName = 'express';
  const express = ((await import(expressName)) as { default: () => ExpressApp }).default;
  const listener: { app?: ExpressApp } = {};
  const server: Server = createServer((request, response) => listener.app?.(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requestHandler = new DefaultRequestHandler(
    sdkCard(base),
    new InMemoryTaskStore(),
    sdkExecutor(releases),
  );
  const app = express();
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  listener.app = app;
  return {
    base,
    fetch: (input, init) => globalThis.fetch(input, init),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

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

describe.each(BINDINGS)('createA2AClient against the @a2a-js/sdk server (%s)', (binding) => {
  let server: SdkServer;
  let client: A2AClient;

  beforeAll(async () => {
    server = binding === 'JSONRPC' ? await sdkJsonRpcServer() : await sdkRestServer();
    const card = await fetchAgentCard(server.base, { deps: { fetch: server.fetch } });
    client = createA2AClient({ card, binding, deps: { fetch: server.fetch } });
  });

  afterEach(() => {
    for (const open of releases) open();
    releases.clear();
  });

  afterAll(async () => {
    await server.close();
  });

  it('reads the SDK’s agent card and picks the binding', () => {
    expect(client.card?.name).toBe('SDK echo');
    expect(client.binding).toBe(binding);
    expect(client.url).toBe(`${server.base}/a2a/${binding === 'JSONRPC' ? 'jsonrpc' : 'rest'}`);
  });

  it('sends a message and gets the completed task with its artifact', async () => {
    const answer = await client.sendMessage('hello');
    const task = answer.task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(textOf(task.artifacts?.[0]?.parts)).toBe('echo: hello');
    expect(task.history?.map((message) => [message.role, textOf(message.parts)])).toEqual([
      ['ROLE_USER', 'hello'],
      ['ROLE_AGENT', 'on it'],
    ]);
  });

  it('gets a direct message answer', async () => {
    const answer = await client.sendMessage('ping');
    expect(answer.message).toMatchObject({ role: 'ROLE_AGENT', parts: [{ text: 'pong' }] });
  });

  it('streams the task lifecycle with named states', async () => {
    const events = await collect(client.sendStreamingMessage('hello'));
    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    expect(events.at(-1)?.statusUpdate?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(textOf(events[2]?.artifactUpdate?.artifact.parts)).toBe('echo: hello');
  });

  it('answers a question and continues the task with the next message', async () => {
    const asked = (await client.sendMessage('weather?')).task as A2ATask;
    expect(asked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(textOf(asked.status.message?.parts)).toBe('Which city?');
    const done = (
      await client.sendMessage('Izmir', { taskId: asked.id, contextId: asked.contextId })
    ).task as A2ATask;
    expect(done.id).toBe(asked.id);
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(textOf(done.status.message?.parts)).toBe('Sunny in Izmir');
  });

  it('gets a task with historyLength and reads the SDK’s errors', async () => {
    const created = (await client.sendMessage('hello')).task as A2ATask;
    const task = await client.getTask(created.id, { historyLength: 1 });
    expect(task.history?.map((message) => textOf(message.parts))).toEqual(['on it']);

    const missing = await rejection(client.getTask('missing'));
    expect(missing).toBeInstanceOf(A2AError);
    expect(missing).toMatchObject({
      kind: 'protocol',
      reason: 'TASK_NOT_FOUND',
      rpcCode: -32001,
      ...(binding === 'HTTP+JSON' ? { statusCode: 404 } : {}),
    });
    expect(await rejection(client.cancelTask(created.id))).toMatchObject({
      kind: 'protocol',
      reason: 'TASK_NOT_CANCELABLE',
    });
  });

  it('subscribes to a running task and sees it canceled', async () => {
    const started = (
      await client.sendMessage('slow', { configuration: { returnImmediately: true } })
    ).task as A2ATask;
    const subscription = client.subscribeToTask(started.id)[Symbol.asyncIterator]();
    const snapshot = await subscription.next();
    expect(snapshot.value?.task?.id).toBe(started.id);

    const canceled = await client.cancelTask(started.id);
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');

    const rest: A2AStreamResponse[] = [];
    for (let next = await subscription.next(); !next.done; next = await subscription.next()) {
      rest.push(next.value);
    }
    expect(rest.map((event) => event.statusUpdate?.status.state)).toEqual(['TASK_STATE_CANCELED']);
  });
});
