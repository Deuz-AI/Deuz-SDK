import { expectTypeOf, test } from 'vitest';
import {
  A2AError,
  createA2AClient,
  createA2AHandler,
  type A2AAgentCard,
  type A2AClient,
  type A2AExecutionContext,
  type A2AHandler,
  type A2AMessage,
  type A2APart,
  type A2ASendMessageResponse,
  type A2AStreamResponse,
  type A2ATask,
  type A2ATaskScope,
  type A2ATaskState,
  type A2ATaskStore,
} from '../src/a2a';

declare const card: A2AAgentCard;
declare const client: A2AClient;

test('a stream event and a SendMessage answer narrow by the member they carry', () => {
  const read = (event: A2AStreamResponse) => {
    if (event.statusUpdate)
      expectTypeOf(event.statusUpdate.status.state).toEqualTypeOf<A2ATaskState>();
    else if (event.artifactUpdate)
      expectTypeOf(event.artifactUpdate.artifact.parts).toEqualTypeOf<A2APart[]>();
    else if (event.task) expectTypeOf(event.task).toEqualTypeOf<A2ATask>();
    else expectTypeOf(event.message).toEqualTypeOf<A2AMessage>();
  };
  void read;
  const answer = (response: A2ASendMessageResponse) =>
    response.task ? response.task.status.state : response.message.parts;
  void answer;
});

test('a part carries exactly one kind of content', () => {
  const parts: A2APart[] = [
    { text: 'hello' },
    { raw: 'aGk=', mediaType: 'text/plain', filename: 'hi.txt' },
    { url: 'https://example.com/a.png', mediaType: 'image/png' },
    { data: { highC: 24 } },
  ];
  void parts;
  // @ts-expect-error text and data at once
  const both: A2APart = { text: 'a', data: 1 };
  void both;
});

test('the client takes text, parts or a draft and streams typed events', () => {
  createA2AClient({ card });
  createA2AClient({ url: 'https://agent.example.com/a2a', binding: 'HTTP+JSON' });
  // @ts-expect-error gRPC is not a binding the client speaks
  createA2AClient({ url: 'https://agent.example.com/a2a', binding: 'GRPC' });
  void client.sendMessage('hi');
  void client.sendMessage([{ data: { n: 1 } }]);
  void client.sendMessage({ parts: [{ text: 'hi' }], metadata: { from: 'test' } }, { taskId: 't' });
  expectTypeOf(client.sendStreamingMessage('hi')).toEqualTypeOf<
    AsyncGenerator<A2AStreamResponse, void, undefined>
  >();
  expectTypeOf(client.getTask('t')).toEqualTypeOf<Promise<A2ATask>>();
});

test('an executor is a function or an object with execute and cancel', () => {
  expectTypeOf(
    createA2AHandler({ card, executor: (ctx) => ctx.reply('pong') }),
  ).toEqualTypeOf<A2AHandler>();
  createA2AHandler({
    card,
    executor: {
      execute: async (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<A2AExecutionContext>();
        expectTypeOf(ctx.task).toEqualTypeOf<A2ATask | undefined>();
        expectTypeOf(ctx.artifact({ parts: [{ text: 'x' }] })).toEqualTypeOf<Promise<string>>();
        await ctx.working('on it', { metadata: { step: 1 } });
        await ctx.complete();
      },
      cancel: (cancel) => {
        expectTypeOf(cancel.running).toEqualTypeOf<boolean>();
        expectTypeOf(cancel.task).toEqualTypeOf<A2ATask>();
      },
    },
    owner: (request) => request.headers.get('x-verified-user') ?? undefined,
  });
  // @ts-expect-error an executor is required
  createA2AHandler({ card });
});

test('a task store loads and saves plain tasks by scope, synchronously or not', () => {
  const tasks = new Map<string, A2ATask>();
  // Keyed by scope and task id: tenant and owner isolation rest on the store.
  const key = (taskId: string, scope: A2ATaskScope) =>
    JSON.stringify([scope.tenant ?? null, scope.owner ?? null, taskId]);
  const store: A2ATaskStore = {
    load: (taskId, scope) => tasks.get(key(taskId, scope)),
    save: async (task, scope) => {
      expectTypeOf(scope.owner).toEqualTypeOf<string | undefined>();
      tasks.set(key(task.id, scope), task);
    },
  };
  void store;
});

test('A2AError names the A2A reasons and keeps unknown ones as strings', () => {
  const error = new A2AError({ reason: 'TASK_NOT_CANCELABLE', message: 'Already shipped.' });
  if (error.reason === 'TASK_NOT_FOUND')
    expectTypeOf(error.kind).toEqualTypeOf<'protocol' | 'http' | 'network' | 'invalid-response'>();
  new A2AError({ reason: 'QUOTA_EXCEEDED', rpcCode: -32050, message: 'Out of credits.' });
});
