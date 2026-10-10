/**
 * `@deuz-sdk/core/a2a` (2.3) — `createA2AClient` against `createA2AHandler`,
 * in-process over both bindings: the client discovers the handler's card and
 * talks through `deps.fetch` straight into the handler. What this adds to the
 * unit and SDK-interop tests is the two halves joined up: the card
 * interface's tenant reaching the executor through each binding, requested
 * extensions, a client abort in the middle of a stream, and cancellation
 * reaching a running executor.
 */
import { describe, expect, it } from 'vitest';
import {
  a2aText,
  createA2AClient,
  createA2AHandler,
  fetchAgentCard,
  type A2ABinding,
  type A2AExecutionContext,
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
