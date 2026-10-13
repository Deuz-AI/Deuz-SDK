/**
 * `@deuz-sdk/core/a2a` (2.3) — `createA2AAgentExecutor` driven by the client
 * of `@a2a-js/sdk` 1.3.0, the official A2A v1.0.0 SDK, in-process over both
 * bindings: a native run asks for an approval (`INPUT_REQUIRED` with a
 * `pending-actions` data part), the SDK client answers it in a data part, and
 * the typed output arrives as a data artifact; a run streams; a run is
 * canceled. The client reaches the handler through `fetchImpl`, so nothing
 * leaves the process.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CancelTaskRequest as SdkCancelTaskRequest,
  GetTaskRequest as SdkGetTaskRequest,
  SendMessageRequest as SdkSendMessageRequest,
  TaskState,
  type StreamResponse as SdkStreamResponse,
  type Task as SdkTask,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client as SdkClient,
} from '@a2a-js/sdk/client';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  a2aText,
  createA2AAgentExecutor,
  createA2AHandler,
  type A2AAgentExecutorOptions,
  type A2ABinding,
} from '../src/a2a';
import { createInMemoryAgentRunStore, resumeStreamAgent, streamAgent } from '../src/agent';
import { createMockModel } from '../src/testing';

const ORIGIN = 'https://native-agent.test';
const BINDINGS: A2ABinding[] = ['JSONRPC', 'HTTP+JSON'];

const parameters = {
  type: 'object' as const,
  properties: { guests: { type: 'number' } },
  additionalProperties: true,
};

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * A booking agent: `book` needs an approval, `wait` holds the run until it is
 * aborted, and a typed output gives the booking reference.
 */
function bookingAgent() {
  const store = createInMemoryAgentRunStore();
  const booked: unknown[] = [];
  const waiting = gate();
  // One model per conversation: a scripted model answers in order across turns.
  const booking = createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'book', args: { guests: 2 } }] },
      { text: '{"booking":"B-42"}' },
    ],
  });
  const holding = createMockModel({ responses: [{ toolCalls: [{ toolName: 'wait', args: {} }] }] });
  const run: A2AAgentExecutorOptions<{ booking: string }>['run'] = (context) => {
    const slow = a2aText(context.message) === 'Hold on.';
    return {
      model: slow ? holding : booking,
      bindingId: 'booking-v1',
      tools: {
        book: {
          description: 'Book a table.',
          parameters,
          needsApproval: true,
          execute: (args: unknown) => {
            booked.push(args);
            return 'booked';
          },
        },
        wait: {
          description: 'Wait.',
          parameters,
          execute: (_args: unknown, ctx: { signal?: AbortSignal }) =>
            new Promise<string>((resolve) => {
              waiting.open();
              ctx.signal?.addEventListener('abort', () => resolve('aborted'));
            }),
        },
      },
      output: {
        mode: 'json',
        schema: {
          type: 'object',
          properties: { booking: { type: 'string' } },
          required: ['booking'],
          additionalProperties: false,
        },
        validate: (value: unknown) => {
          const booking = (value as { booking?: unknown } | null)?.booking;
          if (typeof booking !== 'string') throw new Error('Expected a booking reference');
          return { booking };
        },
      },
    };
  };
  const handler = createA2AHandler({
    card: {
      name: 'Bookings',
      description: 'Books tables, with your approval.',
      version: '1.0.0',
      supportedInterfaces: [
        { url: `${ORIGIN}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: `${ORIGIN}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      ],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['application/json'],
      skills: [{ id: 'book', name: 'Book', description: 'Books a table.', tags: ['booking'] }],
    },
    executor: createA2AAgentExecutor({ agent: { streamAgent, resumeStreamAgent }, store, run }),
  });
  return { handler, store, booked, waiting };
}

async function sdkClientOf(
  handler: (request: Request) => Promise<Response>,
  binding: A2ABinding,
): Promise<SdkClient> {
  const fetchImpl: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));
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
  return factory.createFromUrl(ORIGIN);
}

let messages = 0;
const sdkSend = (
  parts: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  configuration?: Record<string, unknown>,
) =>
  SdkSendMessageRequest.fromJSON({
    message: { messageId: `sdk-${++messages}`, role: 'ROLE_USER', parts, ...extra },
    ...(configuration ? { configuration } : {}),
  });

type SdkParts = SdkTask['artifacts'][number]['parts'];

const sdkData = (parts: SdkParts | undefined) =>
  (parts ?? []).flatMap((part) => (part.content?.$case === 'data' ? [part.content.value] : []));

const sdkText = (parts: SdkParts | undefined) =>
  (parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? String(part.content.value) : ''))
    .join('');

function taskOf(result: Awaited<ReturnType<SdkClient['sendMessage']>>): SdkTask {
  if (!('status' in result)) throw new Error('expected a task');
  return result;
}

describe.each(BINDINGS)('the @a2a-js/sdk client against a native agent (%s)', (binding) => {
  it('answers the approval the run asks for and gets the typed output as a data artifact', async () => {
    const { handler, store, booked } = bookingAgent();
    const client = await sdkClientOf(handler, binding);
    expect(client.transport.protocolName).toBe(binding);

    const asked = taskOf(await client.sendMessage(sdkSend([{ text: 'A table for two.' }])));
    expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(sdkText(asked.status?.message?.parts)).toMatch(/waits for approval of book/);
    const [pending] = sdkData(asked.status?.message?.parts) as {
      type: string;
      actions: { kind: string; approvalId: string; toolName: string; input: unknown }[];
    }[];
    expect(pending?.type).toBe('pending-actions');
    expect(pending?.actions).toEqual([
      expect.objectContaining({ kind: 'approval', toolName: 'book', input: { guests: 2 } }),
    ]);
    expect(booked).toEqual([]);

    // An answer that does not fit is refused with the SDK's own error class.
    await expect(
      client.sendMessage(
        sdkSend([{ text: 'Yes.' }], { taskId: asked.id, contextId: asked.contextId }),
      ),
    ).rejects.toBeInstanceOf(RequestMalformedError);

    const approvalId = pending?.actions[0]?.approvalId;
    const done = taskOf(
      await client.sendMessage(
        sdkSend([{ data: { approvalResponses: [{ approvalId, approved: true }] } }], {
          taskId: asked.id,
          contextId: asked.contextId,
        }),
      ),
    );
    expect(done.id).toBe(asked.id);
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(done.artifacts.map((artifact) => artifact.artifactId)).toEqual(['output']);
    expect(sdkData(done.artifacts[0]?.parts)).toEqual([{ booking: 'B-42' }]);
    expect(booked).toEqual([{ guests: 2 }]);
    expect((await store.load(asked.id))?.result).toMatchObject({
      status: 'completed',
      output: { booking: 'B-42' },
    });
  });

  it('streams the answering turn: the snapshot, WORKING, the artifact, COMPLETED', async () => {
    const { handler } = bookingAgent();
    const client = await sdkClientOf(handler, binding);
    const asked = taskOf(await client.sendMessage(sdkSend([{ text: 'A table for two.' }])));
    const [pending] = sdkData(asked.status?.message?.parts) as {
      actions: { approvalId: string }[];
    }[];
    const events: SdkStreamResponse[] = [];
    for await (const event of client.sendMessageStream(
      sdkSend(
        [
          {
            data: {
              approvalResponses: [{ approvalId: pending?.actions[0]?.approvalId, approved: true }],
            },
          },
        ],
        { taskId: asked.id, contextId: asked.contextId },
      ),
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.payload?.$case)).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    const working = events[1]?.payload;
    expect(working?.$case === 'statusUpdate' && working.value.status?.state).toBe(
      TaskState.TASK_STATE_WORKING,
    );
    const artifact = events[2]?.payload;
    expect(artifact?.$case === 'artifactUpdate' && sdkData(artifact.value.artifact?.parts)).toEqual(
      [{ booking: 'B-42' }],
    );
    expect(artifact?.$case === 'artifactUpdate' && artifact.value.lastChunk).toBe(true);
    const last = events[3]?.payload;
    expect(last?.$case === 'statusUpdate' && last.value.status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
  });

  it('cancels a running task, which aborts the run', async () => {
    const { handler, store, waiting } = bookingAgent();
    const client = await sdkClientOf(handler, binding);
    const started = taskOf(
      await client.sendMessage(sdkSend([{ text: 'Hold on.' }], {}, { returnImmediately: true })),
    );
    expect(started.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    await waiting.promise;
    const canceled = await client.cancelTask(SdkCancelTaskRequest.fromJSON({ id: started.id }));
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    await vi.waitFor(async () =>
      expect((await store.load(started.id))?.result).toMatchObject({
        status: 'stopped',
        reason: 'aborted',
      }),
    );
    const task = await client.getTask(SdkGetTaskRequest.fromJSON({ id: started.id }));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
});
