/**
 * `@deuz-sdk/core/a2a` (2.3) — `createA2AClient` against `createA2AHandler`,
 * in-process over both bindings: the client discovers the handler's card and
 * talks through `deps.fetch` straight into the handler. What this adds to the
 * unit and SDK-interop tests is the two halves joined up: the card
 * interface's tenant reaching the executor through each binding, requested
 * extensions, a client abort in the middle of a stream, cancellation
 * reaching a running executor, and an executor that delegates to another
 * agent, whose errors fail the task instead of answering the request.
 */
import { describe, expect, it } from 'vitest';
import {
  A2AError,
  a2aText,
  createA2AClient,
  createA2AHandler,
  fetchAgentCard,
  type A2AAgentCard,
  type A2ABinding,
  type A2AClient,
  type A2AExecutionContext,
  type A2AExecutor,
  type A2AHandler,
  type A2AStreamResponse,
  type A2ATask,
} from '../src/a2a';
import { AbortError } from '../src/errors';

const ORIGIN = 'https://agent.test';

function agent() {
  const seen: A2AExecutionContext[] = [];
  const handler = createA2AHandler({
    card: {
      name: 'Round trip',
      description: 'Both halves of @deuz-sdk/core/a2a.',
      version: '1.0.0',
      supportedInterfaces: [
        {
          url: `${ORIGIN}/a2a/rpc`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
          tenant: 'acme',
        },
        {
          url: `${ORIGIN}/a2a/rest`,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
          tenant: 'acme',
        },
      ],
      capabilities: { streaming: true, extensions: [{ uri: 'urn:ext:trace' }] },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    },
    executor: async (ctx) => {
      seen.push(ctx);
      const text = a2aText(ctx.message);
      if (ctx.task) return ctx.complete(`Booked for ${text}.`);
      if (text === 'book a table') return ctx.requireInput('For how many?');
      if (text === 'long') {
        await ctx.working('started');
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
        return;
      }
      await ctx.artifact({ name: 'echo', parts: [{ text: `echo: ${text}` }] });
      await ctx.complete();
    },
  });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch;
  return { fetch, seen };
}

async function connect(binding: A2ABinding) {
  const { fetch, seen } = agent();
  const card = await fetchAgentCard(ORIGIN, { deps: { fetch } });
  const client = createA2AClient({ card, binding, extensions: ['urn:ext:trace'], deps: { fetch } });
  return { client, seen };
}

describe.each(['JSONRPC', 'HTTP+JSON'] as const)(
  'createA2AClient ↔ createA2AHandler (%s)',
  (binding) => {
    it('completes a task, with the card’s tenant and the requested extension reaching the executor', async () => {
      const { client, seen } = await connect(binding);
      const task = (await client.sendMessage('hello')).task as A2ATask;
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(a2aText(task.artifacts?.[0])).toBe('echo: hello');
      expect(seen[0]?.tenant).toBe('acme');
      expect(seen[0]?.extensions).toEqual(['urn:ext:trace']);
      expect(await client.getTask(task.id, { historyLength: 0 })).toMatchObject({
        id: task.id,
        history: [],
      });
    });

    it('asks for input and finishes the task on the next message', async () => {
      const { client } = await connect(binding);
      const asked = (await client.sendMessage('book a table')).task as A2ATask;
      expect(asked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      const events: A2AStreamResponse[] = [];
      for await (const event of client.sendStreamingMessage('four', { taskId: asked.id })) {
        events.push(event);
      }
      expect(events[0]?.task?.id).toBe(asked.id);
      expect(events.at(-1)?.statusUpdate?.status).toMatchObject({
        state: 'TASK_STATE_COMPLETED',
        message: { parts: [{ text: 'Booked for four.' }] },
      });
    });

    it('cancels a running task: the subscriber sees CANCELED and the executor its signal', async () => {
      const { client, seen } = await connect(binding);
      const started = (
        await client.sendMessage('long', { configuration: { returnImmediately: true } })
      ).task as A2ATask;
      const subscription = client.subscribeToTask(started.id)[Symbol.asyncIterator]();
      expect((await subscription.next()).value?.task?.status.state).toBe('TASK_STATE_WORKING');
      expect((await client.cancelTask(started.id)).status.state).toBe('TASK_STATE_CANCELED');
      expect((await subscription.next()).value?.statusUpdate?.status.state).toBe(
        'TASK_STATE_CANCELED',
      );
      expect((await subscription.next()).done).toBe(true);
      expect(seen[0]?.signal.aborted).toBe(true);
    });

    it('rejects with AbortError when the caller aborts a stream, and the task carries on', async () => {
      const { client } = await connect(binding);
      const controller = new AbortController();
      const stream = client
        .sendStreamingMessage('long', { signal: controller.signal })
        [Symbol.asyncIterator]();
      const first = (await stream.next()).value as A2AStreamResponse;
      controller.abort();
      await expect(stream.next()).rejects.toBeInstanceOf(AbortError);
      const task = await client.getTask(first.task?.id as string);
      expect(task.status.state).toBe('TASK_STATE_WORKING');
      await client.cancelTask(task.id);
    });
  },
);

/** ErrorInfo metadata the billing agent means for its own caller only. */
const BILLING_BACKEND = 'db.internal:5432';

function cardAt(origin: string, name: string): A2AAgentCard {
  return {
    name,
    description: `${name}, for the delegation tests.`,
    version: '1.0.0',
    supportedInterfaces: [
      { url: `${origin}/a2a/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${origin}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ],
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  };
}

function fetchInto(handler: A2AHandler): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch;
}

/**
 * An orchestrator whose executor delegates to a billing agent through
 * `createA2AClient`, over `binding` both ways. The billing agent refuses
 * every message, with ErrorInfo metadata, and knows none of the
 * orchestrator's tasks.
 */
function orchestrator(binding: A2ABinding, executorFor: (billing: A2AClient) => A2AExecutor) {
  const billingCard = cardAt('https://billing.test', 'Billing');
  const billingAgent = createA2AHandler({
    card: billingCard,
    executor: () => {
      throw new A2AError({
        reason: 'CONTENT_TYPE_NOT_SUPPORTED',
        message: 'Billing takes data parts only.',
        metadata: { backend: BILLING_BACKEND },
      });
    },
  });
  const billing = createA2AClient({
    card: billingCard,
    binding,
    deps: { fetch: fetchInto(billingAgent) },
  });
  const card = cardAt('https://orchestrator.test', 'Orchestrator');
  const errors: unknown[] = [];
  const handler = createA2AHandler({
    card,
    executor: executorFor(billing),
    onError: (error) => errors.push(error),
  });
  const client = createA2AClient({ card, binding, deps: { fetch: fetchInto(handler) } });
  return { client, errors };
}

/** The rejection of `promise`, or `undefined` when it resolves. */
const rejectionOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe.each(['JSONRPC', 'HTTP+JSON'] as const)(
  'an executor delegating through createA2AClient (%s)',
  (binding) => {
    it('fails its task when the sub-agent refuses, instead of answering with the sub-agent’s error', async () => {
      const { client } = orchestrator(binding, (billing) => ({
        execute: async (ctx) => {
          await billing.sendMessage('charge 20 EUR');
          await ctx.complete('Paid.');
        },
      }));
      const answer = await client.sendMessage('book and pay');
      const task = answer.task as A2ATask;
      expect(task.status).toMatchObject({
        state: 'TASK_STATE_FAILED',
        message: { parts: [{ text: 'Billing takes data parts only.' }] },
      });
      expect(JSON.stringify(answer)).not.toContain(BILLING_BACKEND);
      expect((await client.getTask(task.id)).status.state).toBe('TASK_STATE_FAILED');
    });

    it('fails a follow-up turn on the sub-agent’s TASK_NOT_FOUND instead of disowning the caller’s task', async () => {
      const { client } = orchestrator(binding, (billing) => ({
        execute: async (ctx) => {
          if (!ctx.task) return ctx.requireInput('Which booking?');
          await billing.getTask('internal-7');
          await ctx.complete();
        },
      }));
      const asked = (await client.sendMessage('cancel my booking')).task as A2ATask;
      const task = (await client.sendMessage('booking 7', { taskId: asked.id })).task as A2ATask;
      expect(task).toMatchObject({ id: asked.id, status: { state: 'TASK_STATE_FAILED' } });
      expect(task.history?.map((message) => a2aText(message))).toContain('booking 7');
    });

    it('streams the failure as a FAILED status update', async () => {
      const { client } = orchestrator(binding, (billing) => ({
        execute: async (ctx) => {
          await billing.getTask('internal-7');
          await ctx.complete();
        },
      }));
      const events: A2AStreamResponse[] = [];
      for await (const event of client.sendStreamingMessage('where is my refund?')) {
        events.push(event);
      }
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['task', 'statusUpdate']);
      expect(events[1]?.statusUpdate?.status.state).toBe('TASK_STATE_FAILED');
    });

    it('answers CancelTask with an internal error, not the sub-agent’s, and reports it', async () => {
      const { client, errors } = orchestrator(binding, (billing) => ({
        execute: (ctx) => ctx.requireInput('Which booking?'),
        cancel: async ({ task }) => {
          await billing.sendMessage(`refund ${task.id}`);
        },
      }));
      const asked = (await client.sendMessage('cancel my booking')).task as A2ATask;
      const failure = await rejectionOf(client.cancelTask(asked.id));
      expect(failure).toBeInstanceOf(A2AError);
      expect(failure).toMatchObject({ kind: 'protocol', statusCode: 500 });
      expect((failure as A2AError).reason).not.toBe('CONTENT_TYPE_NOT_SUPPORTED');
      expect((failure as A2AError).metadata).toBeUndefined();
      expect((await client.getTask(asked.id)).status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(errors).toEqual([
        expect.objectContaining({ kind: 'protocol', reason: 'CONTENT_TYPE_NOT_SUPPORTED' }),
      ]);
    });

    it('passes a sub-agent’s refusal on when the executor throws it as its own A2AError', async () => {
      const { client } = orchestrator(binding, (billing) => ({
        execute: async (ctx) => {
          try {
            await billing.sendMessage(ctx.message.parts);
          } catch (error) {
            // The caller's own parts went to billing as they were: its refusal is the caller's too.
            if (error instanceof A2AError && error.reason === 'CONTENT_TYPE_NOT_SUPPORTED') {
              throw new A2AError({ reason: error.reason, message: error.message });
            }
            throw error;
          }
          await ctx.complete();
        },
      }));
      const failure = await rejectionOf(client.sendMessage('a photo of the receipt'));
      expect(failure).toBeInstanceOf(A2AError);
      expect(failure).toMatchObject({
        kind: 'protocol',
        reason: 'CONTENT_TYPE_NOT_SUPPORTED',
        message: 'Billing takes data parts only.',
      });
      expect((failure as A2AError).metadata).toBeUndefined();
    });
  },
);
