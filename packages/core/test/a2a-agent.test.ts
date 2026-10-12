/**
 * `@deuz-sdk/core/a2a` (2.3) — `createA2AAgentExecutor`: a native agent run
 * (`streamAgent` / `resumeStreamAgent` with a session store) served as an A2A
 * agent through `createA2AHandler`.
 *
 * A Deuz client talks to the handler in-process, so every test reads the
 * answers as an A2A client would, and checks the run store underneath: the
 * task id is the run id, a suspended run is an `INPUT_REQUIRED` task whose
 * data part lists the pending actions, a follow-up message answers them, and
 * a refused answer leaves both the task and the run as they were.
 * `a2a-agent-interop.test.ts` drives the same executor with the official SDK's
 * client.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  A2AError,
  a2aText,
  createA2AAgentExecutor,
  createA2AClient,
  createA2AHandler,
  createInMemoryA2ATaskStore,
  type A2AAgentAction,
  type A2AAgentExecutorOptions,
  type A2ABinding,
  type A2AHandlerOptions,
  type A2APart,
  type A2AStreamResponse,
  type A2ATask,
  type A2ATaskStore,
} from '../src/a2a';
import {
  createInMemoryAgentRunStore,
  resumeAgent,
  resumeStreamAgent,
  streamAgent,
  type AgentRunStore,
} from '../src/agent';
import { createApprovalSigner } from '../src/durable';
import { createOpenAI } from '../src/openai';
import { agentRunLeaseKey, createInMemoryLeaseProvider, type LeaseProvider } from '../src/ops';
import { createMockModel, type MockResponse } from '../src/testing';

const RPC_URL = 'https://agent.test/a2a/jsonrpc';
const REST_URL = 'https://agent.test/a2a/rest';

const CARD = {
  name: 'Publisher',
  description: 'Writes and publishes posts.',
  version: '1.0.0',
  supportedInterfaces: [
    { url: RPC_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    { url: REST_URL, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['text/plain', 'application/json'],
  skills: [{ id: 'publish', name: 'Publish', description: 'Publishes posts.', tags: ['posts'] }],
};

const BINDINGS: A2ABinding[] = ['JSONRPC', 'HTTP+JSON'];

const engine = { streamAgent, resumeStreamAgent };

/** The scope a run of a task without tenant and owner is stored under. */
const ANONYMOUS = JSON.stringify(['a2a', null, null]);

type Run = A2AAgentExecutorOptions<unknown>['run'];

/** A handler serving `run`, its run store, and a client of each binding. */
function serve(
  run: Run,
  options: Partial<A2AAgentExecutorOptions<unknown>> = {},
  handlerOptions: Partial<A2AHandlerOptions> = {},
) {
  const store: AgentRunStore = options.store ?? createInMemoryAgentRunStore();
  const errors: unknown[] = [];
  const handler = createA2AHandler({
    card: CARD,
    executor: createA2AAgentExecutor({ agent: engine, run, ...options, store }),
    onError: (error) => errors.push(error),
    ...handlerOptions,
  });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch;
  const clientOf = (binding: A2ABinding = 'JSONRPC', headers?: Record<string, string>) =>
    createA2AClient({
      url: binding === 'JSONRPC' ? RPC_URL : REST_URL,
      binding,
      deps: { fetch },
      ...(headers ? { headers } : {}),
    });
  return { handler, store, errors, client: clientOf(), clientOf };
}

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function collect(stream: AsyncIterable<A2AStreamResponse>): Promise<A2AStreamResponse[]> {
  const events: A2AStreamResponse[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The data part of a status message with this `type`. */
function dataOf(task: A2ATask, type: string): Record<string, unknown> | undefined {
  for (const part of task.status.message?.parts ?? []) {
    const data = part.data as { type?: unknown } | undefined;
    if (data?.type === type) return data as Record<string, unknown>;
  }
  return undefined;
}

const actionsOf = (task: A2ATask) =>
  (dataOf(task, 'pending-actions')?.actions ?? []) as A2AAgentAction[];

const approvalIdOf = (task: A2ATask) =>
  (actionsOf(task).find((action) => action.kind === 'approval') as { approvalId: string })
    .approvalId;

const parameters = {
  type: 'object' as const,
  properties: { text: { type: 'string' } },
  additionalProperties: true,
};

/** A run with an approval-gated `publish` tool and a client-side `browser` tool. */
function publisher(responses: MockResponse[], published: unknown[] = []) {
  return {
    model: createMockModel({ responses }),
    bindingId: 'publisher-v1',
    tools: {
      publish: {
        description: 'Publish a post.',
        parameters,
        needsApproval: true,
        execute: (args: unknown) => {
          published.push(args);
          return 'published';
        },
      },
      browser: { description: 'Read the page the user has open.', parameters },
    },
  };
}

/** A run whose `wait` tool holds the leg until `release` opens or the run is aborted. */
function waiting(responses: MockResponse[]) {
  const started = gate();
  const release = gate();
  const aborted: unknown[] = [];
  const run = {
    model: createMockModel({ responses }),
    tools: {
      wait: {
        description: 'Wait for the go-ahead.',
        parameters,
        execute: (_args: unknown, ctx: { signal?: AbortSignal }) =>
          new Promise<string>((resolve) => {
            started.open();
            void release.promise.then(() => resolve('ready'));
            ctx.signal?.addEventListener('abort', () => {
              aborted.push(ctx.signal?.reason);
              resolve('aborted');
            });
          }),
      },
    },
  };
  return { run, started, release, aborted };
}

const BOTH_CALLS: MockResponse = {
  toolCalls: [
    { toolName: 'publish', args: { text: 'hi' } },
    { toolName: 'browser', args: {} },
  ],
};

const typedOutput = {
  mode: 'json' as const,
  schema: {
    type: 'object' as const,
    properties: { answer: { type: 'number' } },
    required: ['answer'],
    additionalProperties: false,
  },
  validate(value: unknown) {
    const answer = (value as { answer?: unknown } | null)?.answer;
    if (typeof answer !== 'number') throw new Error('Expected a numeric answer');
    return { answer, validated: true };
  },
};

/** A model whose provider answers 400 with `message`. */
function failingModel(message: string) {
  return createOpenAI({
    apiKey: 'demo',
    fetch: async () =>
      new Response(JSON.stringify({ error: { message } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
  })('gpt-5.2');
}

describe('createA2AAgentExecutor — a new task', () => {
  it('runs the agent on the message and completes the task with its text as the output artifact', async () => {
    const { client, store, errors } = serve({
      model: createMockModel({ responses: [{ text: 'Paris.' }] }),
    });
    const task = (await client.sendMessage('What is the capital of France?')).task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts).toEqual([
      { artifactId: 'output', name: 'output', parts: [{ text: 'Paris.' }] },
    ]);
    // The task id is the run id; the run is kept under the task's scope.
    const run = await store.load(task.id);
    expect(run).toMatchObject({
      runId: task.id,
      scope: ANONYMOUS,
      phase: 'terminal',
      result: { status: 'completed', output: 'Paris.' },
    });
    expect(run?.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'What is the capital of France?' }],
    });
    expect(task.history?.map((message) => message.role)).toEqual(['ROLE_USER']);
    expect(errors).toEqual([]);
  });

  it('puts a typed output in a data part: the validated value only', async () => {
    const { client } = serve({
      model: createMockModel({ responses: [{ text: '{"answer":42}' }] }),
      output: typedOutput,
    });
    const task = (await client.sendMessage('Answer as JSON.')).task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts).toEqual([
      {
        artifactId: 'output',
        name: 'output',
        parts: [{ data: { answer: 42, validated: true }, mediaType: 'application/json' }],
      },
    ]);
  });

  it('names and describes the artifact as asked', async () => {
    const { client } = serve(
      { model: createMockModel({ responses: [{ text: 'Done.' }] }) },
      { artifact: { name: 'post', description: 'The published post.' } },
    );
    const task = (await client.sendMessage('Write a post.')).task as A2ATask;
    expect(task.artifacts).toEqual([
      {
        artifactId: 'output',
        name: 'post',
        description: 'The published post.',
        parts: [{ text: 'Done.' }],
      },
    ]);
  });

  it('gives the run the message’s text, data and images as one user message', async () => {
    const { client, store } = serve({ model: createMockModel({ responses: [{ text: 'ok' }] }) });
    const parts: A2APart[] = [
      { text: 'Compare these.' },
      { data: { city: 'Izmir' } },
      { raw: 'iVBORw0KGgo=', mediaType: 'image/png' },
      { url: 'https://example.test/izmir.jpg', mediaType: 'image/jpeg' },
    ];
    const task = (await client.sendMessage(parts)).task as A2ATask;
    expect((await store.load(task.id))?.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Compare these.' },
        { type: 'text', text: '{"city":"Izmir"}' },
        { type: 'image', image: 'iVBORw0KGgo=', mediaType: 'image/png' },
        { type: 'image', image: 'https://example.test/izmir.jpg', mediaType: 'image/jpeg' },
      ],
    });
  });

  it('refuses a file it cannot read before a task or a run exists', async () => {
    const { client, store } = serve({ model: createMockModel({ responses: [{ text: 'ok' }] }) });
    await expect(
      client.sendMessage([
        { text: 'Summarize this.' },
        { url: 'https://example.test/report.pdf', mediaType: 'application/pdf' },
      ]),
    ).rejects.toMatchObject({
      reason: 'CONTENT_TYPE_NOT_SUPPORTED',
      message: expect.stringContaining("'application/pdf'"),
    });
    await expect(client.sendMessage([])).rejects.toMatchObject({ reason: 'INVALID_PARAMS' });
    expect((await (store as Required<AgentRunStore>).list()).runs).toEqual([]);
  });

  it('calls run for every turn and lets it give the input itself', async () => {
    const seen: unknown[] = [];
    const { client, store } = serve(
      (context) => {
        seen.push({
          taskId: context.taskId,
          task: context.task?.id,
          text: a2aText(context.message),
        });
        return {
          model: createMockModel({ responses: [{ text: 'ok' }] }),
          prompt: `Answer briefly: ${a2aText(context.message)}`,
        };
      },
      {},
      { owner: () => 'ada' },
    );
    const task = (
      await client.sendMessage([
        { text: 'Read this.' },
        { url: 'https://example.test/report.pdf', mediaType: 'application/pdf' },
      ])
    ).task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(seen).toEqual([{ taskId: task.id, task: undefined, text: 'Read this.' }]);
    const run = await store.load(task.id);
    expect(run?.scope).toBe(JSON.stringify(['a2a', null, 'ada']));
    expect(run?.messages[0]).toEqual({ role: 'user', content: 'Answer briefly: Read this.' });
  });

  it('lets run refuse a message with an A2AError, before any task exists', async () => {
    const { client } = serve(() => {
      throw new A2AError({ reason: 'INVALID_PARAMS', message: 'Say what to publish.' });
    });
    await expect(client.sendMessage('hm')).rejects.toMatchObject({
      reason: 'INVALID_PARAMS',
      message: 'Say what to publish.',
    });
  });

  it('refuses run options it sets on every leg itself: at once for an object, per turn for a function', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'ok' }] });
    const session = { store, runId: 'mine', scope: 'mine' };
    expect(() =>
      createA2AAgentExecutor({ agent: engine, store, run: { model, session } as never }),
    ).toThrow(/run must not set session/);
    expect(() =>
      createA2AAgentExecutor({
        agent: engine,
        store,
        run: { model, signal: AbortSignal.timeout(1000), clientToolResults: [] } as never,
      }),
    ).toThrow(/run must not set signal, clientToolResults: the executor sets them/);

    const { client } = serve(() => ({ model, session }) as never, { store });
    const task = (await client.sendMessage('hello')).task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(a2aText(task.status.message)).toMatch(/run must not set session/);
  });

  it('checks its options when it is created', () => {
    const store = createInMemoryAgentRunStore();
    const run = { model: createMockModel({ responses: [] }) };
    expect(() => createA2AAgentExecutor({ agent: {} as never, store, run })).toThrow(/streamAgent/);
    expect(() => createA2AAgentExecutor({ agent: engine, store: {} as never, run })).toThrow(
      /store/,
    );
    expect(() => createA2AAgentExecutor({ agent: engine, store, run: undefined as never })).toThrow(
      /run/,
    );
    expect(() =>
      createA2AAgentExecutor({ agent: engine, store, run, lease: { provider: {} as never } }),
    ).toThrow(/lease\.provider/);
  });
});

describe('createA2AAgentExecutor — a suspended run', () => {
  it('asks for input with the pending actions in a data part', async () => {
    const { client, store } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]));
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    expect(asked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(a2aText(asked.status.message)).toBe(
      'The agent waits for 2 actions: approval of publish (call_1); a result of browser (call_2). ' +
        'Answer every action in one message, with a data part { approvalResponses, clientToolResults }.',
    );
    expect(dataOf(asked, 'pending-actions')).toEqual({
      type: 'pending-actions',
      actions: [
        {
          kind: 'approval',
          approvalId: expect.stringMatching(/^call_1@/),
          toolCallId: 'call_1',
          toolName: 'publish',
          input: { text: 'hi' },
        },
        { kind: 'client-tool', toolCallId: 'call_2', toolName: 'browser', input: {} },
      ],
    });
    expect(asked.status.message?.parts[1]?.mediaType).toBe('application/json');
    expect(asked.artifacts ?? []).toEqual([]);
    expect(await store.load(asked.id)).toMatchObject({
      runId: asked.id,
      result: { status: 'suspended' },
    });
  });

  it('resumes the run with the answers of a follow-up message and completes the task', async () => {
    const published: unknown[] = [];
    const { client, store } = serve(publisher([BOTH_CALLS, { text: 'Done.' }], published));
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const done = (
      await client.sendMessage(
        [
          { text: 'Go ahead.' },
          {
            data: {
              approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }],
              clientToolResults: [{ toolCallId: 'call_2', output: { title: 'Weather' } }],
            },
          },
        ],
        { taskId: asked.id },
      )
    ).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(done.artifacts).toEqual([
      { artifactId: 'output', name: 'output', parts: [{ text: 'Done.' }] },
    ]);
    expect(published).toEqual([{ text: 'hi' }]);
    const run = await store.load(asked.id);
    expect(run).toMatchObject({ phase: 'terminal', result: { status: 'completed' } });
    expect(JSON.stringify(run?.messages)).toContain('Weather');
    // The follow-up's text stays in the task's history; the run takes only the answers.
    expect(a2aText(done.history?.[2])).toBe('Go ahead.');
    expect(JSON.stringify(run?.messages)).not.toContain('Go ahead.');
  });

  it('passes a denial on to the run, which goes on without the call', async () => {
    const published: unknown[] = [];
    const { client } = serve(
      publisher(
        [{ toolCalls: [{ toolName: 'publish', args: {} }] }, { text: 'Not published.' }],
        published,
      ),
    );
    const asked = (await client.sendMessage('Publish.')).task as A2ATask;
    const done = (
      await client.sendMessage(
        [
          {
            data: {
              approvalResponses: [
                { approvalId: approvalIdOf(asked), approved: false, reason: 'Not today.' },
              ],
            },
          },
        ],
        { taskId: asked.id },
      )
    ).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(a2aText(done.artifacts?.[0])).toBe('Not published.');
    expect(published).toEqual([]);
  });

  it('asks again when the resumed run waits for more', async () => {
    const published: unknown[] = [];
    const { client } = serve(
      publisher(
        [
          { toolCalls: [{ toolName: 'publish', args: { text: 'one' } }] },
          { toolCalls: [{ toolName: 'publish', args: { text: 'two' } }] },
          { text: 'Both published.' },
        ],
        published,
      ),
    );
    const first = (await client.sendMessage('Publish two posts.')).task as A2ATask;
    const answer = (task: A2ATask) =>
      client.sendMessage(
        [{ data: { approvalResponses: [{ approvalId: approvalIdOf(task), approved: true }] } }],
        { taskId: task.id },
      );
    const second = (await answer(first)).task as A2ATask;
    expect(second.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(actionsOf(second)).toEqual([
      expect.objectContaining({ kind: 'approval', toolCallId: 'call_2', input: { text: 'two' } }),
    ]);
    const done = (await answer(second)).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(published).toEqual([{ text: 'one' }, { text: 'two' }]);
  });

  it('carries a signed approval’s token to the client and back', async () => {
    const published: unknown[] = [];
    const { client } = serve({
      ...publisher(
        [{ toolCalls: [{ toolName: 'publish', args: {} }] }, { text: 'Ok.' }],
        published,
      ),
      approvalSigner: createApprovalSigner({ secret: 'a2a-test-secret' }),
    });
    const asked = (await client.sendMessage('Publish.')).task as A2ATask;
    const [action] = actionsOf(asked) as Extract<A2AAgentAction, { kind: 'approval' }>[];
    expect(action?.token).toMatch(/^v1\./);
    const done = (
      await client.sendMessage(
        [
          {
            data: {
              approvalResponses: [
                { approvalId: action?.approvalId, approved: true, token: action?.token },
              ],
            },
          },
        ],
        { taskId: asked.id },
      )
    ).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(published).toEqual([{}]);
  });

  it('refuses answers that do not fit, leaving the task and the run as they were', async () => {
    const { client, store } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]));
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const approvalId = approvalIdOf(asked);
    const approve = { approvalId, approved: true };
    const browse = { toolCallId: 'call_2', output: { title: 'Weather' } };
    const before = await client.getTask(asked.id);
    const run = await store.load(asked.id);

    const refusals: [string, A2APart[], RegExp][] = [
      ['text alone', [{ text: 'Yes, publish it.' }], /waits for 2 actions/],
      [
        'a missing answer',
        [{ data: { approvalResponses: [approve] } }],
        /every action in one message.*browser \(call_2\)/s,
      ],
      [
        'an unknown approval',
        [
          {
            data: {
              approvalResponses: [{ ...approve, approvalId: 'nope' }],
              clientToolResults: [browse],
            },
          },
        ],
        /'nope'/,
      ],
      [
        'an approval named by its tool call id',
        [
          {
            data: {
              approvalResponses: [{ ...approve, approvalId: 'call_1' }],
              clientToolResults: [browse],
            },
          },
        ],
        /approvalId/,
      ],
      [
        'a result for an approval',
        [
          {
            data: {
              approvalResponses: [approve],
              clientToolResults: [browse, { toolCallId: 'call_1', output: 'ok' }],
            },
          },
        ],
        /call_1.*approval/,
      ],
      [
        'an approval for a client tool',
        [
          {
            data: {
              approvalResponses: [approve, { approvalId: 'call_2', approved: true }],
              clientToolResults: [browse],
            },
          },
        ],
        /call_2.*result/,
      ],
      [
        'an action answered twice',
        [{ data: { approvalResponses: [approve, approve], clientToolResults: [browse] } }],
        /twice/,
      ],
      ['a data part that is not an object', [{ data: [approve] }], /approvalResponses/],
      [
        'an unknown field',
        [{ data: { approvals: [approve], clientToolResults: [browse] } }],
        /'approvals'/,
      ],
      [
        'a list that is not a list',
        [{ data: { approvalResponses: approve, clientToolResults: [browse] } }],
        /approvalResponses must be a list/,
      ],
      [
        'a verdict that is not a boolean',
        [
          {
            data: {
              approvalResponses: [{ approvalId, approved: 'yes' }],
              clientToolResults: [browse],
            },
          },
        ],
        /approved/,
      ],
      [
        'a result without its output',
        [{ data: { approvalResponses: [approve], clientToolResults: [{ toolCallId: 'call_2' }] } }],
        /output/,
      ],
      [
        'a file',
        [
          { data: { approvalResponses: [approve], clientToolResults: [browse] } },
          { url: 'https://example.test/page.png', mediaType: 'image/png' },
        ],
        /file/,
      ],
    ];
    for (const [label, parts, message] of refusals) {
      await expect(client.sendMessage(parts, { taskId: asked.id }), label).rejects.toMatchObject({
        reason: 'INVALID_PARAMS',
        message: expect.stringMatching(message),
      });
    }
    expect(await client.getTask(asked.id)).toEqual(before);
    expect(await store.load(asked.id)).toEqual(run);

    const done = (
      await client.sendMessage(
        [{ data: { approvalResponses: [approve], clientToolResults: [browse] } }],
        { taskId: asked.id },
      )
    ).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('takes the answers in several data parts of one message', async () => {
    const { client } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]));
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const done = (
      await client.sendMessage(
        [
          { data: { approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }] } },
          {
            data: {
              clientToolResults: [{ toolCallId: 'call_2', output: 'page', isError: false }],
            },
          },
        ],
        { taskId: asked.id },
      )
    ).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('createA2AAgentExecutor — stopped and failed runs', () => {
  it('asks for a person when the run stops, and refuses messages while it stays stopped', async () => {
    const { client, store } = serve({
      model: createMockModel({
        responses: [{ text: 'I cannot help.', finishReason: 'content_filter' }],
      }),
    });
    const stopped = (await client.sendMessage('Help me.')).task as A2ATask;
    expect(stopped.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(a2aText(stopped.status.message)).toBe(
      'The run stopped (refusal): a person must look at it. The run cannot go on; cancel the task or start a new one.',
    );
    expect(dataOf(stopped, 'stopped')).toEqual({ type: 'stopped', reason: 'refusal' });
    expect(stopped.artifacts ?? []).toEqual([]);
    expect(await store.load(stopped.id)).toMatchObject({
      phase: 'terminal',
      result: { status: 'stopped', reason: 'refusal' },
    });

    await expect(client.sendMessage('Please?', { taskId: stopped.id })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_OPERATION',
      message: expect.stringMatching(/stopped \(refusal\) and cannot go on/),
    });
    expect(await client.getTask(stopped.id)).toEqual(stopped);
    await expect(
      client.sendMessage([{ data: { approvalResponses: [] } }], { taskId: stopped.id }),
    ).rejects.toMatchObject({ reason: 'UNSUPPORTED_OPERATION' });
  });

  it('lists the effects to reconcile, and picks the run up once a person settled them', async () => {
    const published: unknown[] = [];
    const options = publisher(
      [{ toolCalls: [{ toolName: 'publish', args: { text: 'hi' } }] }, { text: 'Published.' }],
      published,
    );
    const { client, store, errors } = serve(options);
    const asked = (await client.sendMessage('Publish "hi".')).task as A2ATask;
    const session = { store, runId: asked.id, scope: ANONYMOUS };

    // A process dies between the effect and its receipt: the save that records it fails.
    let saves = 0;
    const dying: AgentRunStore = {
      load: (runId) => store.load(runId),
      save: async (envelope) => {
        const receipt = Object.values(envelope.toolResults ?? {})[0];
        if (receipt?.stage === 'completed' || receipt?.stage === 'executed') {
          throw new Error('the process died');
        }
        saves++;
        await store.save(envelope);
      },
    };
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: dying },
      approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }],
    });
    expect(crashed.status).toBe('failed');
    expect(saves).toBeGreaterThan(0);
    expect(published).toEqual([{ text: 'hi' }]);

    // The task still shows the question, but the run needs a person now.
    const stopped = (await client.sendMessage('Is it done?', { taskId: asked.id })).task as A2ATask;
    expect(stopped.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(a2aText(stopped.status.message)).toBe(
      'The run stopped (tool-reconciliation-required): the outcome of publish (call_1) is unknown. ' +
        'A person must settle it before the run can go on; send a message once that is done.',
    );
    expect(dataOf(stopped, 'stopped')).toEqual({
      type: 'stopped',
      reason: 'tool-reconciliation-required',
      unknownEffects: [
        { toolCallId: 'call_1', toolName: 'publish', modelStep: expect.any(Number) },
      ],
    });

    // Not settled yet: the next message finds it stopped again.
    const again = (await client.sendMessage('Now?', { taskId: asked.id })).task as A2ATask;
    expect(dataOf(again, 'stopped')).toMatchObject({ reason: 'tool-reconciliation-required' });

    // A person checks the effect and records it; the next message picks the run up.
    await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'call_1', output: 'published' }],
    });
    // That leg only reports the stored outcome: it takes the message up, then completes.
    const events = await collect(client.sendStreamingMessage('And now?', { taskId: asked.id }));
    expect(
      events.map((event) =>
        event.statusUpdate ? event.statusUpdate.status.state : Object.keys(event)[0],
      ),
    ).toEqual(['task', 'TASK_STATE_WORKING', 'artifactUpdate', 'TASK_STATE_COMPLETED']);
    const done = await client.getTask(asked.id);
    expect(a2aText(done.artifacts?.[0])).toBe('Published.');
    expect(done.history?.map((message) => a2aText(message).slice(0, 20))).toEqual([
      'Publish "hi".',
      'The agent waits for ',
      'Is it done?',
      'The run stopped (too',
      'Now?',
      'The run stopped (too',
      'And now?',
    ]);
    expect(published).toEqual([{ text: 'hi' }]);
    expect(errors).toEqual([]);
  });

  it('fails the task with a safe message when the run fails', async () => {
    const secret = 'sk-ant-api03-SECRETSECRETSECRET';
    const { client, store } = serve({
      model: failingModel(`Bad request (key ${secret})`),
      maxRetries: 0,
    });
    const task = (await client.sendMessage('hello')).task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    const text = a2aText(task.status.message);
    expect(text).toMatch(/^The agent run failed: /);
    expect(text).not.toContain(secret);
    expect(JSON.stringify(task)).not.toContain(secret);
    const run = await store.load(task.id);
    expect(run?.result?.status).toBe('failed');
    const error = run?.result?.status === 'failed' ? run.result.error : undefined;
    expect(dataOf(task, 'failed')).toEqual({
      type: 'failed',
      error: { name: error?.name, ...(error?.code !== undefined ? { code: error.code } : {}) },
    });
  });

  it('lets failureMessage word what the client sees', async () => {
    const { client } = serve(
      { model: failingModel('internal detail'), maxRetries: 0 },
      { failureMessage: (error) => `Sorry, that did not work (${error.name}).` },
    );
    const task = (await client.sendMessage('hello')).task as A2ATask;
    expect(task.status.message?.parts[0]).toEqual({
      text: expect.stringMatching(/^Sorry, that did not work \(.+\)\.$/),
    });
    expect(JSON.stringify(task)).not.toContain('internal detail');
  });

  it('refuses a message whose resume another executor holds, and keeps the task waiting', async () => {
    const leases = createInMemoryLeaseProvider();
    const { client, store } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]), {
      lease: { provider: leases },
    });
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const answers: A2APart[] = [
      {
        data: {
          approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }],
          clientToolResults: [{ toolCallId: 'call_2', output: 'page' }],
        },
      },
    ];
    const run = await store.load(asked.id);
    // Another process drives the run right now.
    const held = await leases.acquire({
      key: agentRunLeaseKey({ scope: ANONYMOUS, runId: asked.id }),
      owner: 'another-process',
      ttlMs: 60_000,
    });
    await expect(client.sendMessage(answers, { taskId: asked.id })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_OPERATION',
      message: expect.stringMatching(
        /could not be resumed: Another executor holds this native run/,
      ),
    });
    expect(await client.getTask(asked.id)).toEqual(asked);
    expect(await store.load(asked.id)).toEqual(run);

    await leases.release(held!);
    const done = (await client.sendMessage(answers, { taskId: asked.id })).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses a message whose run changed its definition, and keeps the task waiting', async () => {
    const original = publisher([BOTH_CALLS, { text: 'Done.' }]);
    const { client, store } = serve((context) =>
      context.task ? { ...original, bindingId: 'publisher-v2' } : original,
    );
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const run = await store.load(asked.id);
    await expect(
      client.sendMessage(
        [
          {
            data: {
              approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }],
              clientToolResults: [{ toolCallId: 'call_2', output: 'page' }],
            },
          },
        ],
        { taskId: asked.id },
      ),
    ).rejects.toMatchObject({
      reason: 'INTERNAL_ERROR',
      message: expect.stringMatching(/could not be resumed: Native agent binding changed/),
    });
    expect(await client.getTask(asked.id)).toEqual(asked);
    expect(await store.load(asked.id)).toEqual(run);
  });
});

describe.each(BINDINGS)('createA2AAgentExecutor — streaming (%s)', (binding) => {
  it('streams WORKING, the text as unstored drafts, then the output artifact', async () => {
    const { clientOf } = serve({ model: createMockModel({ responses: [{ text: 'Paris.' }] }) });
    const client = clientOf(binding);
    const events = await collect(client.sendStreamingMessage('Capital of France?'));
    const task = events[0]?.task as A2ATask;
    const ids = { taskId: task.id, contextId: task.contextId };
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(events.slice(1)).toEqual([
      {
        statusUpdate: {
          ...ids,
          status: { state: 'TASK_STATE_WORKING', timestamp: expect.any(String) },
        },
      },
      {
        artifactUpdate: {
          ...ids,
          artifact: { artifactId: 'output', name: 'output', parts: [{ text: 'Par' }] },
        },
      },
      {
        artifactUpdate: {
          ...ids,
          artifact: { artifactId: 'output', parts: [{ text: 'is.' }] },
          append: true,
        },
      },
      {
        artifactUpdate: {
          ...ids,
          artifact: { artifactId: 'output', name: 'output', parts: [{ text: 'Paris.' }] },
          lastChunk: true,
        },
      },
      {
        statusUpdate: {
          ...ids,
          status: { state: 'TASK_STATE_COMPLETED', timestamp: expect.any(String) },
        },
      },
    ]);
    // The drafts were never stored: the task holds the final artifact alone.
    expect((await client.getTask(task.id)).artifacts).toEqual([
      { artifactId: 'output', name: 'output', parts: [{ text: 'Paris.' }] },
    ]);
  });

  it('streams the answering follow-up through to the end of the resumed leg', async () => {
    const { clientOf } = serve(
      publisher([{ toolCalls: [{ toolName: 'publish', args: {} }] }, { text: 'Done.' }]),
    );
    const client = clientOf(binding);
    const asked = (await client.sendMessage('Publish.')).task as A2ATask;
    const events = await collect(
      client.sendStreamingMessage(
        [{ data: { approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }] } }],
        { taskId: asked.id },
      ),
    );
    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    expect(events[0]?.task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(events[1]?.statusUpdate?.status.state).toBe('TASK_STATE_WORKING');
    expect(events.at(-2)?.artifactUpdate).toMatchObject({
      artifact: { parts: [{ text: 'Done.' }] },
      lastChunk: true,
    });
    expect(events.at(-1)?.statusUpdate?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses answers that do not fit after the snapshot, and keeps the task as it was', async () => {
    const { clientOf } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]));
    const client = clientOf(binding);
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const events: A2AStreamResponse[] = [];
    await expect(async () => {
      for await (const event of client.sendStreamingMessage('Yes.', { taskId: asked.id })) {
        events.push(event);
      }
    }).rejects.toMatchObject({ reason: 'INVALID_PARAMS', message: /waits for 2 actions/ });
    expect(events.map((event) => Object.keys(event)[0])).toEqual(['task']);
    expect(await client.getTask(asked.id)).toEqual(asked);
  });
});

describe('createA2AAgentExecutor — drafts of the output', () => {
  it('restarts the draft at every model step', async () => {
    const { client } = serve({
      model: createMockModel({
        responses: [
          { text: 'Let me wait.', toolCalls: [{ toolName: 'wait', args: {} }] },
          { text: 'Ready now.' },
        ],
      }),
      tools: { wait: { description: 'Wait.', parameters, execute: () => 'ready' } },
    });
    const events = await collect(client.sendStreamingMessage('Wait, then answer.'));
    const drafts = events
      .filter((event) => event.artifactUpdate !== undefined && !event.artifactUpdate.lastChunk)
      .map(({ artifactUpdate }) => [
        artifactUpdate?.append ?? false,
        a2aText(artifactUpdate?.artifact),
      ]);
    expect(drafts).toEqual([
      [false, 'Let me'],
      [true, ' wait.'],
      [false, 'Ready'],
      [true, ' now.'],
    ]);
    expect(a2aText(events.at(-2)?.artifactUpdate?.artifact)).toBe('Ready now.');
  });

  it('never streams a typed output in part: only the validated artifact', async () => {
    const { client } = serve({
      model: createMockModel({ responses: [{ text: '{"answer":42}' }] }),
      output: typedOutput,
    });
    const events = await collect(client.sendStreamingMessage('Answer as JSON.'));
    const artifacts = events.flatMap((event) =>
      event.artifactUpdate ? [event.artifactUpdate] : [],
    );
    expect(artifacts).toEqual([
      expect.objectContaining({
        artifact: {
          artifactId: 'output',
          name: 'output',
          parts: [{ data: { answer: 42, validated: true }, mediaType: 'application/json' }],
        },
        lastChunk: true,
      }),
    ]);
  });

  it('leaves no artifact when the run does not complete, whatever it previewed', async () => {
    const { client } = serve({
      model: createMockModel({
        responses: [{ text: 'I cannot help.', finishReason: 'content_filter' }],
      }),
    });
    const events = await collect(client.sendStreamingMessage('Help me.'));
    expect(events.some((event) => event.artifactUpdate !== undefined)).toBe(true);
    const task = await client.getTask(events[0]?.task?.id as string);
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task.artifacts ?? []).toEqual([]);
  });
});

describe('createA2AAgentExecutor — SubscribeToTask', () => {
  it('re-attaches to a running task and follows it to the end', async () => {
    const { run, started, release } = waiting([
      { toolCalls: [{ toolName: 'wait', args: {} }] },
      { text: 'All set.' },
    ]);
    const { client } = serve(run);
    const task = (
      await client.sendMessage('Wait for me.', { configuration: { returnImmediately: true } })
    ).task as A2ATask;
    expect(task.status.state).toBe('TASK_STATE_WORKING');
    await started.promise;
    const subscription = client.subscribeToTask(task.id);
    const snapshot = await subscription.next();
    expect(snapshot.value?.task?.status.state).toBe('TASK_STATE_WORKING');
    release.open();
    const rest = await collect({ [Symbol.asyncIterator]: () => subscription });
    expect(rest.map((event) => Object.keys(event)[0])).toEqual([
      'artifactUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    expect(a2aText(rest[2]?.artifactUpdate?.artifact)).toBe('All set.');
    expect(rest[3]?.statusUpdate?.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('createA2AAgentExecutor — cancellation', () => {
  it('aborts the run of a task it cancels; the run records the stop', async () => {
    const { run, started, aborted } = waiting([{ toolCalls: [{ toolName: 'wait', args: {} }] }]);
    const { client, store, errors } = serve(run);
    const task = (
      await client.sendMessage('Wait for me.', { configuration: { returnImmediately: true } })
    ).task as A2ATask;
    await started.promise;
    const canceled = await client.cancelTask(task.id);
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');
    await vi.waitFor(async () =>
      expect(await store.load(task.id)).toMatchObject({
        phase: 'terminal',
        result: { status: 'stopped', reason: 'aborted' },
      }),
    );
    expect(aborted).toHaveLength(1);
    expect(await client.getTask(task.id)).toEqual(canceled);
    expect(errors).toEqual([]);
  });

  it('cancels a task waiting for input; the run stays as it was and no message resumes it', async () => {
    const { client, store } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]));
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const run = await store.load(asked.id);
    expect((await client.cancelTask(asked.id)).status.state).toBe('TASK_STATE_CANCELED');
    expect(await store.load(asked.id)).toEqual(run);
    await expect(
      client.sendMessage(
        [{ data: { approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }] } }],
        { taskId: asked.id },
      ),
    ).rejects.toMatchObject({ reason: 'UNSUPPORTED_OPERATION' });
  });

  it('with a lease, reaches a run another instance drives', async () => {
    const leases = createInMemoryLeaseProvider();
    const runs = createInMemoryAgentRunStore();
    const tasks = createInMemoryA2ATaskStore();
    const { run, started, aborted } = waiting([{ toolCalls: [{ toolName: 'wait', args: {} }] }]);
    const options = { store: runs, lease: { provider: leases, ttlMs: 30 } };
    // Two instances share the task store, the run store and the lease provider.
    const a = serve(run, options, { taskStore: tasks });
    const b = serve(run, options, { taskStore: tasks });
    const task = (
      await a.client.sendMessage('Wait for me.', { configuration: { returnImmediately: true } })
    ).task as A2ATask;
    await started.promise;
    expect((await b.client.cancelTask(task.id)).status.state).toBe('TASK_STATE_CANCELED');
    await vi.waitFor(
      async () =>
        expect(await runs.load(task.id)).toMatchObject({
          phase: 'terminal',
          result: { status: 'stopped', reason: 'cancelled' },
        }),
      { timeout: 5000 },
    );
    expect(aborted).toHaveLength(1);
    expect((await a.client.getTask(task.id)).status.state).toBe('TASK_STATE_CANCELED');
    expect([...a.errors, ...b.errors]).toEqual([]);
  });

  it('cancels the task when the run’s lease is cancelled outside A2A', async () => {
    const leases = createInMemoryLeaseProvider();
    const { run, started } = waiting([{ toolCalls: [{ toolName: 'wait', args: {} }] }]);
    const { client, store } = serve(run, { lease: { provider: leases, ttlMs: 30 } });
    const task = (
      await client.sendMessage('Wait for me.', { configuration: { returnImmediately: true } })
    ).task as A2ATask;
    await started.promise;
    // An operator cancels the run through its lease key.
    expect(
      await leases.signal(agentRunLeaseKey({ scope: ANONYMOUS, runId: task.id }), 'cancel'),
    ).toBe(true);
    await vi.waitFor(
      async () => expect((await client.getTask(task.id)).status.state).toBe('TASK_STATE_CANCELED'),
      { timeout: 5000 },
    );
    const canceled = await client.getTask(task.id);
    expect(a2aText(canceled.status.message)).toBe('The run was cancelled.');
    expect((await store.load(task.id))?.result).toMatchObject({
      status: 'stopped',
      reason: 'cancelled',
    });
  });

  it('signals the lease only for a task whose turn does not run here', async () => {
    const signals: string[] = [];
    const inner = createInMemoryLeaseProvider();
    const leases: LeaseProvider = {
      ...inner,
      signal: async (key, signal) => {
        signals.push(`${signal} ${key}`);
        return inner.signal(key, signal);
      },
    };
    const { run, started } = waiting([{ toolCalls: [{ toolName: 'wait', args: {} }] }]);
    const { client } = serve(
      (context) => (a2aText(context.message) === 'wait' ? run : publisher([BOTH_CALLS])),
      { lease: { provider: leases } },
    );
    const running = (
      await client.sendMessage('wait', { configuration: { returnImmediately: true } })
    ).task as A2ATask;
    await started.promise;
    expect((await client.cancelTask(running.id)).status.state).toBe('TASK_STATE_CANCELED');
    expect(signals).toEqual([]);

    const asked = (await client.sendMessage('publish')).task as A2ATask;
    expect((await client.cancelTask(asked.id)).status.state).toBe('TASK_STATE_CANCELED');
    expect(signals).toEqual([`cancel ${agentRunLeaseKey({ scope: ANONYMOUS, runId: asked.id })}`]);
  });
});

describe('createA2AAgentExecutor — identity', () => {
  /** A handler whose owner is the `x-user` header (verified upstream, in a real app). */
  function owned(taskStore?: A2ATaskStore, scope?: A2AAgentExecutorOptions<unknown>['scope']) {
    const served = serve(publisher([BOTH_CALLS, { text: 'Done.' }]), scope ? { scope } : {}, {
      owner: (request) => request.headers.get('x-user') ?? undefined,
      ...(taskStore ? { taskStore } : {}),
    });
    return {
      ...served,
      ada: served.clientOf('JSONRPC', { 'x-user': 'ada' }),
      bob: served.clientOf('JSONRPC', { 'x-user': 'bob' }),
    };
  }

  const answersFor = (task: A2ATask): A2APart[] => [
    {
      data: {
        approvalResponses: [{ approvalId: approvalIdOf(task), approved: true }],
        clientToolResults: [{ toolCallId: 'call_2', output: 'page' }],
      },
    },
  ];

  it('keeps each caller’s runs under its own scope, so another caller finds no task', async () => {
    const { ada, bob, store } = owned(undefined, ({ owner }) => `user:${owner}`);
    const asked = (await ada.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    expect((await store.load(asked.id))?.scope).toBe('user:ada');
    await expect(bob.sendMessage(answersFor(asked), { taskId: asked.id })).rejects.toMatchObject({
      reason: 'TASK_NOT_FOUND',
    });
    const done = (await ada.sendMessage(answersFor(asked), { taskId: asked.id })).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses another caller’s follow-up by the run’s scope, even when the task store does not', async () => {
    // A task store keyed by the task id alone, which A2ATaskStore forbids.
    const tasks = new Map<string, A2ATask>();
    const unscoped: A2ATaskStore = {
      load: (taskId) => structuredClone(tasks.get(taskId)),
      save: (task) => void tasks.set(task.id, structuredClone(task)),
    };
    const { ada, bob, store } = owned(unscoped);
    const asked = (await ada.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const run = await store.load(asked.id);
    await expect(bob.sendMessage(answersFor(asked), { taskId: asked.id })).rejects.toMatchObject({
      reason: 'TASK_NOT_FOUND',
    });
    expect(await ada.getTask(asked.id)).toEqual(asked);
    expect(await store.load(asked.id)).toEqual(run);
  });
});

describe.each(BINDINGS)('createA2AAgentExecutor — returnImmediately (%s)', (binding) => {
  it('answers a follow-up once the resumed leg runs, and its refusal with the error', async () => {
    const { clientOf } = serve(publisher([BOTH_CALLS, { text: 'Done.' }]));
    const client = clientOf(binding);
    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const now = { configuration: { returnImmediately: true }, taskId: asked.id };

    await expect(client.sendMessage('Yes.', now)).rejects.toMatchObject({
      reason: 'INVALID_PARAMS',
      ...(binding === 'HTTP+JSON' ? { statusCode: 400 } : { rpcCode: -32602 }),
    });
    expect(await client.getTask(asked.id)).toEqual(asked);

    const taken = (
      await client.sendMessage(
        [
          {
            data: {
              approvalResponses: [{ approvalId: approvalIdOf(asked), approved: true }],
              clientToolResults: [{ toolCallId: 'call_2', output: 'page' }],
            },
          },
        ],
        now,
      )
    ).task as A2ATask;
    expect(taken.status.state).toBe('TASK_STATE_WORKING');
    await vi.waitFor(async () =>
      expect((await client.getTask(asked.id)).status.state).toBe('TASK_STATE_COMPLETED'),
    );
  });
});
