/**
 * `@deuz-sdk/core/mcp/server` tasks (2.5) — long-running served tools and
 * agents as MCP tasks.
 *
 * What this file pins:
 *
 * - MCP 2026-07-28 (the `io.modelcontextprotocol/tasks` extension), driven as
 *   raw JSON-RPC because no SDK client in the tree decodes `resultType: "task"`:
 *   a task-enabled call from a client that declares the extension answers a
 *   `CreateTaskResult`; `tasks/get` inlines the result; `tasks/update` and
 *   `tasks/cancel` acknowledge; a non-declaring client is refused (-32021) on
 *   `tasks/*` and gets a plain result from `tools/call`; another identity's
 *   task reads as not found; cancel aborts the run;
 * - guardrails and approval run before the task exists, and a blocked or
 *   denied call creates none;
 * - MCP 2025-11-25 through the v1 SDK's own experimental tasks client, over
 *   stateless HTTP and over stdio (where `notifications/tasks/status` is
 *   pushed): `execution.taskSupport`, `tasks/get`, `tasks/result`,
 *   `tasks/list`, `tasks/cancel`;
 * - TTL expiry, opt-in (nothing changes without `tasks`), the construction
 *   checks, and the in-memory store's contract.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1HttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  TaskStatusNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createInMemoryMcpTaskStore,
  createMcpServer,
  type DeuzMcpServer,
  type McpAuthInfo,
  type McpServerOptions,
  type McpTaskRecord,
} from '../src/mcp/server';
import { serveMcpStdio, type McpStdioServerHandle } from '../src/node/mcp-server';
import { InvalidRequestError } from '../src/errors';
import { createMockModel } from '../src/testing';
import { manualClock } from './fixtures/manual-clock';
import { stdioPipe } from './helpers/mcp-pipe-transport';
import type { Tool } from '../src/types/tool';

const servers: DeuzMcpServer[] = [];
const closers: Array<{ close(): Promise<void> }> = [];
const handles: McpStdioServerHandle[] = [];

afterEach(async () => {
  for (const client of closers.splice(0)) await client.close().catch(() => {});
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

const ENDPOINT = 'http://deuz-mcp.test/mcp';
const EXT = 'io.modelcontextprotocol/tasks';
const ALICE: McpAuthInfo = { token: 'a', clientId: 'alice', scopes: [] };
const BOB: McpAuthInfo = { token: 'b', clientId: 'bob', scopes: [] };

function serve(options: McpServerOptions): DeuzMcpServer {
  const server = createMcpServer(options);
  servers.push(server);
  return server;
}

/** A promise the test resolves by hand. */
function gate<T = void>(): { promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

/** Wait until `check` holds, letting the background run progress. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

type Rpc = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/** One raw MCP 2026-07-28 request, with the standard headers and envelope. */
async function modern(
  server: DeuzMcpServer,
  method: string,
  params: Record<string, unknown>,
  options: { authInfo?: McpAuthInfo; tasks?: boolean } = {},
): Promise<Rpc> {
  const capabilities = options.tasks === false ? {} : { extensions: { [EXT]: {} } };
  const name =
    typeof params.name === 'string'
      ? params.name
      : typeof params.taskId === 'string'
        ? params.taskId
        : undefined;
  const response = await server.fetch(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(name !== undefined ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': capabilities,
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
          },
        },
      }),
    }),
    options.authInfo ? { authInfo: options.authInfo } : undefined,
  );
  const text = await response.text();
  const json = text.startsWith('event:')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .pop()!
    : text;
  return JSON.parse(json) as Rpc;
}

const SLOW_SCHEMA = { type: 'object', properties: { value: { type: 'string' } } };

/** A tool whose run the test releases by hand, recording the signal it ran with. */
function slowTool(release: Promise<void>, seen: { signal?: AbortSignal; runs: number }): Tool {
  return {
    description: 'Takes a while.',
    parameters: SLOW_SCHEMA,
    execute: async (args, ctx) => {
      seen.runs += 1;
      seen.signal = ctx.signal;
      await Promise.race([
        release,
        new Promise((resolve) => ctx.signal?.addEventListener('abort', resolve)),
      ]);
      return `done:${(args as { value?: string }).value ?? ''}`;
    },
  };
}

describe('MCP 2026-07-28 — the Tasks extension', () => {
  it('a declaring client gets a task handle, polls tasks/get, and reads the inlined result', async () => {
    const release = gate();
    const seen = { runs: 0 } as { signal?: AbortSignal; runs: number };
    const server = serve({
      name: 't',
      tools: { slow: slowTool(release.promise, seen) },
      tasks: { tools: ['slow'], pollIntervalMs: 250, ttlMs: 60_000 },
    });

    const discovered = await modern(server, 'server/discover', {});
    expect(discovered.result?.capabilities).toMatchObject({ extensions: { [EXT]: {} } });

    const created = await modern(
      server,
      'tools/call',
      { name: 'slow', arguments: { value: 'x' } },
      { authInfo: ALICE },
    );
    expect(created.result).toMatchObject({
      resultType: 'task',
      status: 'working',
      ttlMs: 60_000,
      pollIntervalMs: 250,
    });
    const taskId = created.result!.taskId as string;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // Durable before the handle: the very next poll finds it.
    const working = await modern(server, 'tasks/get', { taskId }, { authInfo: ALICE });
    expect(working.result).toMatchObject({ resultType: 'complete', taskId, status: 'working' });
    expect(working.result).not.toHaveProperty('result');

    release.open();
    await until(async () => {
      const polled = await modern(server, 'tasks/get', { taskId }, { authInfo: ALICE });
      return polled.result?.status === 'completed';
    });
    const done = await modern(server, 'tasks/get', { taskId }, { authInfo: ALICE });
    expect(done.result).toMatchObject({
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done:x' }] },
    });
    // The run did not ride the (finished) HTTP request's signal.
    expect(seen.signal?.aborted).toBe(false);

    // tasks/update is acknowledged (nothing is ever outstanding); tasks/list
    // and tasks/result do not exist on this era.
    expect(
      (await modern(server, 'tasks/update', { taskId, inputResponses: {} }, { authInfo: ALICE }))
        .result,
    ).toMatchObject({ resultType: 'complete' });
    expect((await modern(server, 'tasks/list', {}, { authInfo: ALICE })).error?.code).toBe(-32601);
  });

  it('isolation: another identity, an anonymous caller and a non-declaring client never see the task', async () => {
    const release = gate();
    const server = serve({
      name: 't',
      tools: { slow: slowTool(release.promise, { runs: 0 }) },
      tasks: { tools: ['slow'] },
    });
    const created = await modern(
      server,
      'tools/call',
      { name: 'slow', arguments: {} },
      { authInfo: ALICE },
    );
    const taskId = created.result!.taskId as string;

    for (const authInfo of [BOB, undefined]) {
      const other = await modern(server, 'tasks/get', { taskId }, authInfo ? { authInfo } : {});
      expect(other.error).toMatchObject({ code: -32602 });
      const cancel = await modern(server, 'tasks/cancel', { taskId }, authInfo ? { authInfo } : {});
      expect(cancel.error).toMatchObject({ code: -32602 });
    }
    const undeclared = await modern(
      server,
      'tasks/get',
      { taskId },
      { authInfo: ALICE, tasks: false },
    );
    expect(undeclared.error).toMatchObject({
      code: -32021,
      data: { requiredCapabilities: { extensions: { [EXT]: {} } } },
    });
    expect(
      (await modern(server, 'tasks/get', { taskId: 'nope' }, { authInfo: ALICE })).error?.code,
    ).toBe(-32602);
    release.open();
  });

  it('a client without the extension gets the plain result; a tool not opted in is never a task', async () => {
    const server = serve({
      name: 't',
      tools: {
        slow: slowTool(Promise.resolve(), { runs: 0 }),
        plain: { parameters: SLOW_SCHEMA, execute: () => 'plain' },
      },
      tasks: { tools: ['slow'] },
    });
    const undeclared = await modern(
      server,
      'tools/call',
      { name: 'slow', arguments: { value: 'y' } },
      { tasks: false },
    );
    expect(undeclared.result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'done:y' }],
    });
    const plain = await modern(server, 'tools/call', { name: 'plain', arguments: {} });
    expect(plain.result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'plain' }],
    });
  });

  it('nothing changes for a server that does not opt in', async () => {
    const server = serve({ name: 't', tools: { slow: slowTool(Promise.resolve(), { runs: 0 }) } });
    const discovered = await modern(server, 'server/discover', {});
    expect(discovered.result?.capabilities).not.toHaveProperty('extensions');
    const called = await modern(server, 'tools/call', { name: 'slow', arguments: {} });
    expect(called.result).toMatchObject({ resultType: 'complete' });
    expect((await modern(server, 'tasks/get', { taskId: 'x' })).error?.code).toBe(-32601);
  });

  it('tasks/cancel acknowledges, marks the task cancelled and aborts the run; a late result is dropped', async () => {
    const seen = { runs: 0 } as { signal?: AbortSignal; runs: number };
    const server = serve({
      name: 't',
      tools: { slow: slowTool(new Promise(() => {}), seen) },
      tasks: { tools: ['slow'] },
    });
    const created = await modern(
      server,
      'tools/call',
      { name: 'slow', arguments: {} },
      { authInfo: ALICE },
    );
    const taskId = created.result!.taskId as string;
    await until(() => seen.runs === 1);

    const cancelled = await modern(server, 'tasks/cancel', { taskId }, { authInfo: ALICE });
    expect(cancelled.result).toMatchObject({ resultType: 'complete' });
    expect(seen.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const polled = await modern(server, 'tasks/get', { taskId }, { authInfo: ALICE });
    expect(polled.result).toMatchObject({ status: 'cancelled' });
    expect(polled.result).not.toHaveProperty('result');
    // Cancelling a terminal task is still acknowledged (cooperative).
    expect(
      (await modern(server, 'tasks/cancel', { taskId }, { authInfo: ALICE })).result,
    ).toBeDefined();
  });

  it('a served agent with task: true runs as a task, and cancelling it aborts the agent run', async () => {
    const seen = { runs: 0 } as { signal?: AbortSignal; runs: number };
    const server = serve({
      name: 't',
      agents: {
        researcher: {
          description: 'Researches.',
          task: true,
          agent: {
            model: createMockModel({
              responses: [{ toolCalls: [{ toolName: 'dig', args: {} }] }, { text: 'found it' }],
            }),
            tools: { dig: slowTool(new Promise(() => {}), seen) },
          },
        },
        quick: {
          description: 'Answers at once.',
          task: true,
          agent: { model: createMockModel({ responses: [{ text: 'The answer is 42.' }] }) },
        },
      },
    });

    const quick = await modern(server, 'tools/call', { name: 'quick', arguments: { prompt: 'q' } });
    const quickId = quick.result!.taskId as string;
    await until(
      async () =>
        (await modern(server, 'tasks/get', { taskId: quickId })).result?.status === 'completed',
    );
    expect((await modern(server, 'tasks/get', { taskId: quickId })).result).toMatchObject({
      result: { content: [{ type: 'text', text: 'The answer is 42.' }] },
    });

    const created = await modern(server, 'tools/call', {
      name: 'researcher',
      arguments: { prompt: 'go' },
    });
    const taskId = created.result!.taskId as string;
    await until(() => seen.runs === 1);
    await modern(server, 'tasks/cancel', { taskId });
    expect(seen.signal?.aborted).toBe(true);
    expect((await modern(server, 'tasks/get', { taskId })).result).toMatchObject({
      status: 'cancelled',
    });
  });

  it('guardrails and approval run before the task exists; a blocked or denied call creates none', async () => {
    const asked: string[] = [];
    const server = serve({
      name: 't',
      tools: {
        gated: {
          parameters: SLOW_SCHEMA,
          needsApproval: true,
          execute: (args) => `ran:${(args as { value: string }).value}`,
        },
      },
      tasks: { tools: ['gated'] },
      approve: ({ args }) => {
        asked.push((args as { value: string }).value);
        return (args as { value: string }).value !== 'no';
      },
      guardrails: {
        onToolCall: (ctx) =>
          (ctx.toolCall.args as { value?: string }).value === 'blocked'
            ? { action: 'block', reason: 'not this one' }
            : undefined,
        onToolResult: () => ({ action: 'rewrite', result: 'rewritten by the guardrail' }),
      },
    });

    const blocked = await modern(server, 'tools/call', {
      name: 'gated',
      arguments: { value: 'blocked' },
    });
    expect(blocked.result).toMatchObject({ resultType: 'complete', isError: true });
    const denied = await modern(server, 'tools/call', {
      name: 'gated',
      arguments: { value: 'no' },
    });
    expect(denied.result).toMatchObject({ resultType: 'complete', isError: true });
    expect(JSON.stringify(denied.result)).toContain('Tool call denied.');

    const approved = await modern(server, 'tools/call', {
      name: 'gated',
      arguments: { value: 'yes' },
    });
    expect(approved.result).toMatchObject({ resultType: 'task' });
    const taskId = approved.result!.taskId as string;
    await until(
      async () => (await modern(server, 'tasks/get', { taskId })).result?.status === 'completed',
    );
    expect((await modern(server, 'tasks/get', { taskId })).result).toMatchObject({
      result: { content: [{ type: 'text', text: 'rewritten by the guardrail' }] },
    });
    expect(asked).toEqual(['no', 'yes']);
  });

  it('a task expires ttlMs after creation and then reads as not found', async () => {
    const { clock, advance } = manualClock(Date.UTC(2026, 10, 24));
    const server = serve({
      name: 't',
      clock,
      tools: { quick: { parameters: SLOW_SCHEMA, execute: () => 'ok' } },
      tasks: { tools: ['quick'], ttlMs: 1_000 },
    });
    const created = await modern(server, 'tools/call', { name: 'quick', arguments: {} });
    const taskId = created.result!.taskId as string;
    expect(created.result).toMatchObject({ ttlMs: 1_000 });
    await advance(999);
    expect((await modern(server, 'tasks/get', { taskId })).result).toMatchObject({
      status: 'completed',
    });
    await advance(1);
    expect((await modern(server, 'tasks/get', { taskId })).error?.code).toBe(-32602);
  });
});

describe('MCP 2025-11-25 — core tasks, through the v1 SDK tasks client', () => {
  async function connectV1(server: DeuzMcpServer, authInfo?: McpAuthInfo): Promise<V1Client> {
    const client = new V1Client({ name: 'v1', version: '1.0.0' });
    closers.push(client);
    await client.connect(
      new V1HttpTransport(new URL(ENDPOINT), {
        fetch: (input, init) =>
          server.fetch(new Request(input, init), authInfo ? { authInfo } : undefined),
      }),
    );
    return client;
  }

  it('stateless HTTP: taskSupport is advertised, callToolStream drives tasks/get and tasks/result', async () => {
    const server = serve({
      name: 't',
      tools: {
        slow: slowTool(Promise.resolve(), { runs: 0 }),
        failing: {
          parameters: SLOW_SCHEMA,
          execute: () => {
            throw new Error('boom');
          },
        },
        plain: { parameters: SLOW_SCHEMA, execute: () => 'plain' },
      },
      tasks: { tools: ['slow', 'failing'], pollIntervalMs: 10 },
    });
    const client = await connectV1(server, ALICE);
    expect(client.getServerCapabilities()?.tasks).toMatchObject({
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });
    const listed = (await client.listTools()).tools;
    expect(listed.find((t) => t.name === 'slow')?.execution).toEqual({ taskSupport: 'optional' });
    expect(listed.find((t) => t.name === 'plain')?.execution).toBeUndefined();

    const kinds: string[] = [];
    let taskId = '';
    let final: unknown;
    for await (const message of client.experimental.tasks.callToolStream({
      name: 'slow',
      arguments: { value: 'v1' },
    })) {
      kinds.push(message.type);
      if (message.type === 'taskCreated') taskId = message.task.taskId;
      if (message.type === 'result') final = message.result;
    }
    expect(kinds[0]).toBe('taskCreated');
    expect(kinds.at(-1)).toBe('result');
    expect(final).toMatchObject({ content: [{ type: 'text', text: 'done:v1' }] });
    expect(await client.experimental.tasks.getTask(taskId)).toMatchObject({
      taskId,
      status: 'completed',
      ttl: 3_600_000,
    });

    // An isError result is a FAILED task on this era, and tasks/result still returns it.
    let failedId = '';
    for await (const message of client.experimental.tasks.callToolStream({
      name: 'failing',
      arguments: {},
    })) {
      if (message.type === 'taskCreated') failedId = message.task.taskId;
    }
    const failed = await client.experimental.tasks.getTask(failedId);
    expect(failed).toMatchObject({ status: 'failed', statusMessage: 'boom' });
    const failedResult = await client.experimental.tasks.getTaskResult(
      failedId,
      CallToolResultSchema,
    );
    expect(failedResult).toMatchObject({
      isError: true,
      _meta: { 'io.modelcontextprotocol/related-task': { taskId: failedId } },
    });

    // tasks/list: the caller's own tasks; cancelling a terminal task is refused.
    const page = await client.experimental.tasks.listTasks();
    expect(page.tasks.map((t) => t.taskId).sort()).toEqual([taskId, failedId].sort());
    await expect(client.experimental.tasks.cancelTask(taskId)).rejects.toThrow(
      /terminal status 'completed'/,
    );

    const bob = await connectV1(server, BOB);
    expect((await bob.experimental.tasks.listTasks()).tasks).toEqual([]);
    await expect(bob.experimental.tasks.getTask(taskId)).rejects.toThrow(/not found/);
  });

  it('tasks/cancel returns the cancelled task and aborts the run; a requested ttl is honoured when shorter', async () => {
    const seen = { runs: 0 } as { signal?: AbortSignal; runs: number };
    const server = serve({
      name: 't',
      tools: { slow: slowTool(new Promise(() => {}), seen) },
      tasks: { tools: ['slow'] },
    });
    const client = await connectV1(server, ALICE);
    await client.listTools();
    const stream = client.experimental.tasks.callToolStream(
      { name: 'slow', arguments: {} },
      undefined,
      { task: { ttl: 5_000 } },
    );
    const first = await stream.next();
    const created = (first.value as { task: { taskId: string; ttl: number } }).task;
    expect(created.ttl).toBe(5_000);
    await until(() => seen.runs === 1);
    const cancelled = await client.experimental.tasks.cancelTask(created.taskId);
    expect(cancelled).toMatchObject({ taskId: created.taskId, status: 'cancelled' });
    expect(seen.signal?.aborted).toBe(true);
    await stream.return(undefined);
  });

  it('stdio: a task call works and notifications/tasks/status is pushed to the creating session', async () => {
    const pipe = stdioPipe();
    const handle = await serveMcpStdio(
      createMcpServer({
        name: 't',
        tools: { slow: slowTool(Promise.resolve(), { runs: 0 }) },
        tasks: { tools: ['slow'], pollIntervalMs: 10 },
      }),
      { stdin: pipe.stdin, stdout: pipe.stdout },
    );
    handles.push(handle);
    const client = new V1Client({ name: 'v1', version: '1.0.0' });
    closers.push(client);
    const statuses: string[] = [];
    client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
      statuses.push(notification.params.status);
    });
    await client.connect(pipe.transport() as never);
    await client.listTools();

    let final: unknown;
    for await (const message of client.experimental.tasks.callToolStream({
      name: 'slow',
      arguments: { value: 's' },
    })) {
      if (message.type === 'result') final = message.result;
    }
    expect(final).toMatchObject({ content: [{ type: 'text', text: 'done:s' }] });
    await until(() => statuses.includes('completed'));
    expect(pipe.written.some((m) => m.method === 'notifications/tasks/status')).toBe(true);
  });
});

describe('MCP 2026-07-28 over stdio', () => {
  it('one connection creates and polls its task; no status notification is pushed', async () => {
    const pipe = stdioPipe();
    const handle = await serveMcpStdio(
      createMcpServer({
        name: 't',
        tools: { quick: { parameters: SLOW_SCHEMA, execute: () => 'ok' } },
        tasks: { tools: ['quick'] },
      }),
      { stdin: pipe.stdin, stdout: pipe.stdout },
    );
    handles.push(handle);
    const transport = pipe.transport();
    closers.push(transport);
    const replies = new Map<number, Rpc>();
    transport.onmessage = (message) => {
      if (typeof message.id === 'number') replies.set(message.id, message as Rpc);
    };
    await transport.start();
    let id = 0;
    const call = async (method: string, params: Record<string, unknown>): Promise<Rpc> => {
      const mine = ++id;
      await transport.send({
        jsonrpc: '2.0',
        id: mine,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': { extensions: { [EXT]: {} } },
          },
        },
      });
      await until(() => replies.has(mine));
      return replies.get(mine)!;
    };

    expect((await call('server/discover', {})).result?.capabilities).toMatchObject({
      extensions: { [EXT]: {} },
    });
    const created = await call('tools/call', { name: 'quick', arguments: {} });
    expect(created.result).toMatchObject({ resultType: 'task' });
    const taskId = created.result!.taskId as string;
    await until(async () => (await call('tasks/get', { taskId })).result?.status === 'completed');
    expect(pipe.written.some((m) => String(m.method).startsWith('notifications/tasks'))).toBe(
      false,
    );
  });
});

describe('construction and the store', () => {
  it('rejects a tasks.tools name that is not served, and a task tool with an outputSchema', async () => {
    expect(() => createMcpServer({ name: 't', tools: {}, tasks: { tools: ['ghost'] } })).toThrow(
      InvalidRequestError,
    );
    expect(() => createMcpServer({ name: 't', tasks: { ttlMs: 0 } })).toThrow(/ttlMs/);
    const typed = serve({
      name: 't',
      tools: {
        typed: {
          parameters: SLOW_SCHEMA,
          outputSchema: { type: 'object', properties: { n: { type: 'number' } } },
          execute: () => ({ n: 1 }),
        },
      },
      tasks: { tools: ['typed'] },
    });
    await expect(typed.ready()).rejects.toThrow(/outputSchema/);
  });

  it('the in-memory store: terminal states are final, pages are per owner, capacity evicts finished tasks', async () => {
    const store = createInMemoryMcpTaskStore({
      maxTasks: 2,
      clock: { now: () => Date.UTC(2026, 0, 1) },
    });
    const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const record = (taskId: string, owner: string): McpTaskRecord => ({
      taskId,
      owner,
      toolName: 't',
      status: 'working',
      createdAt: at,
      lastUpdatedAt: at,
      ttlMs: null,
    });
    await store.create(record('a', 'alice'));
    await store.create(record('b', 'bob'));
    await expect(store.create(record('c', 'alice'))).rejects.toThrow(/full/);

    expect(
      await store.update('a', { status: 'completed', lastUpdatedAt: at, result: { content: [] } }),
    ).toMatchObject({ status: 'completed' });
    expect(await store.update('a', { status: 'cancelled', lastUpdatedAt: at })).toBeUndefined();
    expect((await store.get('a'))?.status).toBe('completed');

    await store.create(record('c', 'alice')); // evicts the finished 'a'
    expect(await store.get('a')).toBeUndefined();
    expect((await store.list('alice', { limit: 10 }))?.tasks.map((t) => t.taskId)).toEqual(['c']);
    expect(await store.list('alice', { cursor: 'zzz', limit: 10 })).toBeNull();
  });
});
