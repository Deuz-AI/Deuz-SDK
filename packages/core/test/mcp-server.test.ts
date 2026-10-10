/**
 * `@deuz-sdk/core/mcp/server` (2.3) — Deuz tools served over MCP.
 *
 * `createMcpServer` publishes a `ToolSet`, a native `AgentToolSet` and agents
 * (`runAgent` behind a tool) on the v2 SDK (`@modelcontextprotocol/server`), so
 * one definition answers MCP 2026-07-28 clients and, through the SDK's stateless
 * fallback, 2025-11-25 ones. What this file pins is the Deuz half of that
 * contract — the parts the SDK cannot know about:
 *
 * - a served call runs the SAME pipeline a loop call runs: `onToolCall`
 *   guardrails, the approval gate, argument validation (a Standard Schema
 *   transforms exactly once), `execute`, `onToolResult` guardrails;
 * - `needsApproval` maps to a server-side `approve` callback or, by default, to
 *   an elicitation the client's user answers — and is DENIED whenever nobody
 *   can be asked, never silently run;
 * - results and failures map onto `CallToolResult` so a Deuz client gets back
 *   exactly what the tool returned (structured values included).
 *
 * Every client is the Deuz client wired into `server.fetch` through
 * `McpHttpTransport.fetch`: no socket, so nothing here depends on timing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { Client as V2Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpServer,
  type DeuzMcpServer,
  type McpAuthInfo,
  type McpServerOptions,
} from '../src/mcp/server';
import {
  createMcpClient,
  type McpClientOptions,
  type McpElicitationRequest,
  type McpRootsClient,
} from '../src/mcp/index';
import { InvalidRequestError } from '../src/errors';
import { generateText } from '../src/generate';
import { createMockModel } from '../src/testing';
import { readConfig } from '../src/internal/config-symbol';
import { manualClock } from './fixtures/manual-clock';
import type { Tool, ToolExecuteContext } from '../src/types/tool';
import type { AgentToolSet } from '../src/types/agent-run';

const servers: DeuzMcpServer[] = [];
const clients: McpRootsClient[] = [];
const rawClients: V2Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const client of rawClients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
});

const ENDPOINT = 'http://deuz-mcp.test/mcp';

function serve(options: McpServerOptions): DeuzMcpServer {
  const server = createMcpServer(options);
  servers.push(server);
  return server;
}

/** `server.fetch` as a client-side `fetch`, optionally stamping verified auth info. */
function fetchInto(server: DeuzMcpServer, authInfo?: McpAuthInfo) {
  return (input: string | URL, init?: RequestInit): Promise<Response> =>
    server.fetch(new Request(input, init), authInfo ? { authInfo } : undefined);
}

/** A Deuz client (v2 line unless overridden) talking straight into the handler. */
async function connect(
  server: DeuzMcpServer,
  over: Omit<McpClientOptions, 'transport'> & { authInfo?: McpAuthInfo } = {},
): Promise<McpRootsClient> {
  const { authInfo, ...options } = over;
  const client = await createMcpClient({
    sdk: 'v2',
    ...options,
    transport: { type: 'http', url: ENDPOINT, fetch: fetchInto(server, authInfo) },
  });
  clients.push(client);
  return client;
}

/** The raw v2 SDK client, for the wire fields a Deuz `ToolSet` does not carry. */
async function connectRaw(server: DeuzMcpServer): Promise<V2Client> {
  const client = new V2Client(
    { name: 'raw', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: fetchInto(server) }),
  );
  rawClients.push(client);
  return client;
}

const CTX: ToolExecuteContext = { toolCallId: 'call_1', messages: [] };

const ECHO_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'string', description: 'Text to echo.' } },
  required: ['value'],
  additionalProperties: false,
};
const ADD_SCHEMA = {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
};

function basicTools(): { echo: Tool; add: Tool } {
  return {
    echo: {
      description: 'Echo a value back.',
      parameters: ECHO_SCHEMA,
      execute: (args) => `echo:${(args as { value: string }).value}`,
    },
    add: {
      description: 'Add two numbers.',
      parameters: ADD_SCHEMA,
      execute: (args) => {
        const { a, b } = args as { a: number; b: number };
        return { sum: a + b };
      },
    },
  };
}

describe('createMcpServer — serving a ToolSet', () => {
  it('lists every tool with its JSON Schema verbatim and serves calls on 2026-07-28', async () => {
    const server = serve({ name: 'deuz-tools', version: '1.2.3', tools: basicTools() });
    const client = await connect(server);

    expect(client.protocolVersion?.()).toBe('2026-07-28');
    expect(client.serverInfo?.()).toEqual({ name: 'deuz-tools', version: '1.2.3' });

    const tools = await client.listTools();
    expect(Object.keys(tools)).toEqual(['echo', 'add']);
    expect(tools.echo!.description).toBe('Echo a value back.');
    expect(tools.echo!.parameters).toEqual(ECHO_SCHEMA);
    expect(await tools.echo!.execute!({ value: 'hi' }, CTX)).toBe('echo:hi');
    // An object result travels as structuredContent, so it comes back as the
    // same value — not as its JSON text.
    expect(await client.callTool('add', { a: 2, b: 2 })).toEqual({ sum: 4 });
  });

  it('serves the same definition to a 2025-11-25 client through the stateless fallback', async () => {
    const server = serve({ name: 'deuz-tools', tools: basicTools() });
    const client = await connect(server, { sdk: 'v1' });

    expect(client.protocolVersion?.()).toBe('2025-11-25');
    expect(Object.keys(await client.listTools())).toEqual(['echo', 'add']);
    expect(await client.callTool('echo', { value: 'old' })).toBe('echo:old');
    expect(await client.callTool('add', { a: 1, b: 2 })).toEqual({ sum: 3 });
  });

  it("legacy: 'reject' makes a 2026-07-28-only endpoint", async () => {
    const server = serve({ name: 'modern-only', legacy: 'reject', tools: basicTools() });

    await expect(connect(server, { sdk: 'v1' })).rejects.toThrow();
    const modern = await connect(server);
    expect(modern.protocolVersion?.()).toBe('2026-07-28');
    expect(await modern.callTool('echo', { value: 'new' })).toBe('echo:new');
  });

  it('carries outputSchema and annotations onto the wire', async () => {
    const outputSchema = {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
    };
    const tools = basicTools();
    const server = serve({
      name: 'deuz-tools',
      tools: { ...tools, add: { ...tools.add, outputSchema } },
      toolAnnotations: { add: { readOnlyHint: true, idempotentHint: true } },
    });
    const raw = await connectRaw(server);

    const listed = (await raw.listTools()).tools;
    const add = listed.find((t) => t.name === 'add')!;
    expect(add.outputSchema).toEqual(outputSchema);
    expect(add.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
    expect(listed.find((t) => t.name === 'echo')!.outputSchema).toBeUndefined();

    const client = await connect(server);
    expect((await client.listTools()).add!.outputSchema).toEqual(outputSchema);
    expect(await client.callTool('add', { a: 3, b: 4 })).toEqual({ sum: 7 });
  });

  it('a result that breaks the advertised outputSchema is an error, not a silent pass', async () => {
    const server = serve({
      name: 'deuz-tools',
      tools: {
        broken: {
          parameters: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
          execute: () => ({ n: 'not a number' }),
        },
      },
    });
    const client = await connect(server);

    await expect(client.callTool('broken', {})).rejects.toThrow(/output/i);
  });
});

describe('createMcpServer — arguments, results and failures', () => {
  it('a raw JSON Schema is enforced before execute ever runs', async () => {
    const execute = vi.fn((args: unknown) => `echo:${(args as { value: string }).value}`);
    const server = serve({
      name: 't',
      tools: { echo: { parameters: ECHO_SCHEMA, execute } },
    });
    const client = await connect(server);

    await expect(client.callTool('echo', { value: 3 })).rejects.toThrow(/value/);
    await expect(client.callTool('echo', {})).rejects.toThrow(/value/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a Standard Schema is listed as JSON Schema and validates by itself, its transform applied once', async () => {
    const execute = vi.fn((args: unknown) => args);
    const parameters = z
      .object({ n: z.number().describe('A number.') })
      .transform(({ n }) => ({ n: n * 10 }));
    const server = serve({ name: 't', tools: { scale: { parameters, execute } } });
    const client = await connect(server);

    const listed = (await client.listTools()).scale!.parameters as {
      properties: Record<string, unknown>;
    };
    expect(listed.properties.n).toMatchObject({ type: 'number', description: 'A number.' });

    expect(await client.callTool('scale', { n: 2 })).toEqual({ n: 20 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ n: 20 });
    await expect(client.callTool('scale', { n: 'x' })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a throwing tool becomes an isError result carrying its message', async () => {
    const server = serve({
      name: 't',
      tools: {
        boom: {
          parameters: { type: 'object', properties: {} },
          execute: () => {
            throw new Error('kaboom: disk full');
          },
        },
      },
    });
    const raw = await connectRaw(server);

    const result = await raw.callTool({ name: 'boom', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'kaboom: disk full' }]);

    const client = await connect(server);
    await expect(client.callTool('boom', {})).rejects.toThrow('kaboom: disk full');
  });

  it('non-object results travel as JSON text; undefined as no content', async () => {
    const server = serve({
      name: 't',
      tools: {
        list: { parameters: { type: 'object' }, execute: () => [1, 2, 3] },
        count: { parameters: { type: 'object' }, execute: () => 42 },
        nothing: { parameters: { type: 'object' }, execute: () => undefined },
      },
    });
    const raw = await connectRaw(server);

    const list = await raw.callTool({ name: 'list', arguments: {} });
    expect(list.content).toEqual([{ type: 'text', text: '[1,2,3]' }]);
    expect(list.structuredContent).toBeUndefined();
    const count = await raw.callTool({ name: 'count', arguments: {} });
    expect(count.content).toEqual([{ type: 'text', text: '42' }]);
    const nothing = await raw.callTool({ name: 'nothing', arguments: {} });
    expect(nothing.content).toEqual([]);
    expect(nothing.isError).toBeFalsy();
  });

  it("a tool's timeoutMs abandons the call: its signal aborts and the client gets an error result", async () => {
    const { clock, advance } = manualClock();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let abortedWith: unknown;
    const server = serve({
      name: 't',
      clock,
      tools: {
        slow: {
          parameters: { type: 'object' },
          timeoutMs: 50,
          execute: (_args, ctx) =>
            new Promise((_resolve, reject) => {
              started();
              ctx.signal!.addEventListener('abort', () => {
                abortedWith = ctx.signal!.reason;
                reject(ctx.signal!.reason);
              });
            }),
        },
      },
    });
    const client = await connect(server);

    // The assertion is attached BEFORE the clock moves: the call rejects inside
    // `advance`, and an unobserved rejection would be reported as unhandled.
    const outcome = expect(client.callTool('slow', {})).rejects.toThrow(
      "Tool 'slow' timed out after 50ms and was abandoned.",
    );
    await running;
    await advance(50);
    await outcome;
    expect(abortedWith).toBeInstanceOf(Error);
  });

  it('timeoutMs: Infinity arms no timer, as in the loop — a slow call completes', async () => {
    let abortedWhileRunning: boolean | undefined;
    // No `clock` option: the host clock is the one that clamps Infinity to 1 ms.
    const server = serve({
      name: 't',
      tools: {
        slow: {
          parameters: { type: 'object' },
          timeoutMs: Infinity,
          execute: (_args, ctx) =>
            new Promise((resolve) => {
              setTimeout(() => {
                // Read before resolving: once the response is on its way the SDK
                // aborts the request's signal itself.
                abortedWhileRunning = ctx.signal!.aborted;
                resolve('done');
              }, 40);
            }),
        },
      },
    });
    const client = await connect(server);

    expect(await client.callTool('slow', {})).toBe('done');
    expect(abortedWhileRunning).toBe(false);
  });

  it('execute gets a call context: toolCallId, signal, and the runtimeContext built from the request', async () => {
    let seen: ToolExecuteContext | undefined;
    const server = serve({
      name: 't',
      runtimeContext: (request) => ({
        tenant: request.authInfo?.extra?.tenant,
        era: request.era,
        transport: request.transport,
        hasRequest: request.request instanceof Request,
      }),
      tools: {
        whoami: {
          parameters: { type: 'object' },
          execute: (_args, ctx) => {
            seen = ctx;
            return 'ok';
          },
        },
      },
    });
    const authInfo: McpAuthInfo = {
      token: 'tok',
      clientId: 'client-1',
      scopes: ['tools'],
      extra: { tenant: 'acme' },
    };
    const client = await connect(server, { authInfo });

    expect(await client.callTool('whoami', {})).toBe('ok');
    expect(seen!.toolCallId).toMatch(/^mcp-/);
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    expect(seen!.messages).toEqual([]);
    expect(seen!.runtimeContext).toEqual({
      tenant: 'acme',
      era: 'modern',
      transport: 'http',
      hasRequest: true,
    });
  });
});

describe('createMcpServer — construction errors', () => {
  it('rejects a client tool, a provider tool, a name served twice and annotations for nothing', () => {
    const parameters = { type: 'object', properties: {} };
    expect(() => createMcpServer({ name: 't', tools: { confirm: { parameters } } })).toThrow(
      InvalidRequestError,
    );
    expect(() => createMcpServer({ name: 't', tools: { confirm: { parameters } } })).toThrow(
      /confirm/,
    );
    expect(() =>
      createMcpServer({
        name: 't',
        tools: { search: { parameters, type: 'provider', providerTool: { type: 'web_search' } } },
      }),
    ).toThrow(/search/);
    expect(() =>
      createMcpServer({
        name: 't',
        tools: { lookup: { parameters, execute: () => 1 } },
        agentTools: { lookup: { parameters, execute: () => 2 } },
      }),
    ).toThrow(/lookup/);
    expect(() =>
      createMcpServer({
        name: 't',
        tools: { echo: { parameters, execute: () => 1 } },
        toolAnnotations: { ehco: { readOnlyHint: true } },
      }),
    ).toThrow(/ehco/);
  });
});

describe('createMcpServer — approval', () => {
  it('a server-side approve callback decides; a refusal never executes', async () => {
    const execute = vi.fn(() => 'wiped');
    const asked: unknown[] = [];
    const server = serve({
      name: 't',
      tools: {
        wipe: {
          parameters: { type: 'object', properties: { target: { type: 'string' } } },
          needsApproval: true,
          execute,
        },
      },
      approve: (request) => {
        asked.push({
          toolName: request.toolName,
          args: request.args,
          clientId: request.request.authInfo?.clientId,
        });
        return (request.args as { target: string }).target !== 'prod';
      },
    });
    const client = await connect(server, {
      authInfo: { token: 't', clientId: 'ops-bot', scopes: [] },
    });

    await expect(client.callTool('wipe', { target: 'prod' })).rejects.toThrow('Tool call denied.');
    expect(execute).not.toHaveBeenCalled();
    expect(await client.callTool('wipe', { target: 'dev' })).toBe('wiped');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([
      { toolName: 'wipe', args: { target: 'prod' }, clientId: 'ops-bot' },
      { toolName: 'wipe', args: { target: 'dev' }, clientId: 'ops-bot' },
    ]);
  });

  it("by default the client's user is asked through elicitation: approve runs, decline denies", async () => {
    const execute = vi.fn(() => 'deployed');
    const server = serve({
      name: 't',
      tools: {
        deploy: {
          description: 'Deploy the app.',
          parameters: { type: 'object', properties: { env: { type: 'string' } } },
          needsApproval: true,
          execute,
        },
      },
    });
    const prompts: McpElicitationRequest[] = [];
    const answers = [
      { action: 'accept' as const, content: { approve: true } },
      { action: 'decline' as const },
      { action: 'accept' as const, content: { approve: false } },
    ];
    const client = await connect(server, {
      onElicitationRequest: (request) => {
        prompts.push(request);
        return answers.shift()!;
      },
    });

    expect(await client.callTool('deploy', { env: 'staging' })).toBe('deployed');
    await expect(client.callTool('deploy', { env: 'prod' })).rejects.toThrow(/denied/);
    await expect(client.callTool('deploy', { env: 'prod' })).rejects.toThrow(/denied/);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(prompts).toHaveLength(3);
    const first = prompts[0]!;
    expect(first.mode).toBe('form');
    expect(first.message).toContain('deploy');
    expect(first.message).toContain('"env":"staging"');
    expect(first.mode === 'form' && first.requestedSchema).toMatchObject({
      type: 'object',
      properties: { approve: { type: 'boolean' } },
      required: ['approve'],
    });
  });

  it('a client that cannot be asked is denied — the tool never runs', async () => {
    const execute = vi.fn(() => 'ran');
    const server = serve({
      name: 't',
      tools: { risky: { parameters: { type: 'object' }, needsApproval: true, execute } },
    });
    const noElicitation = await connect(server);
    // A 2025-11-25 client over stateless HTTP cannot be asked either: there is
    // no session to carry an elicitation request back to it.
    const legacy = await connect(server, {
      sdk: 'v1',
      onElicitationRequest: () => ({ action: 'accept', content: { approve: true } }),
    });

    await expect(noElicitation.callTool('risky', {})).rejects.toThrow(/cannot be asked/);
    await expect(legacy.callTool('risky', {})).rejects.toThrow(/cannot be asked/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a needsApproval predicate gates only the calls it matches', async () => {
    const execute = vi.fn((args: unknown) => `paid ${(args as { amount: number }).amount}`);
    const server = serve({
      name: 't',
      tools: {
        pay: {
          parameters: { type: 'object', properties: { amount: { type: 'number' } } },
          needsApproval: (args) => (args as { amount: number }).amount > 100,
          execute,
        },
      },
      approve: () => false,
    });
    const client = await connect(server);

    expect(await client.callTool('pay', { amount: 5 })).toBe('paid 5');
    await expect(client.callTool('pay', { amount: 500 })).rejects.toThrow('Tool call denied.');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // Outside the declared `boolean | predicate` type, which is exactly what an
  // unchecked JSON/YAML tool config or plain JS produces. The loop calls it, the
  // call throws, and an exploding predicate gates the call: fail closed.
  describe.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
  ] as const)('a truthy needsApproval that is neither true nor a function (%s)', (_l, gate) => {
    const gatedTool = (ran: { count: number }): Tool => ({
      parameters: { type: 'object', properties: {} },
      needsApproval: gate as unknown as Tool['needsApproval'],
      execute: () => {
        ran.count += 1;
        return 'ran';
      },
    });

    it('the loop gates it: nobody approves, so it never runs', async () => {
      const ran = { count: 0 };
      await generateText({
        model: createMockModel({
          responses: [{ toolCalls: [{ toolName: 'danger', args: {} }] }, { text: 'done' }],
        }),
        prompt: 'go',
        tools: { danger: gatedTool(ran) },
        approveToolCall: () => false,
      });
      expect(ran.count).toBe(0);
    });

    it('a served call is gated the same way: approve is asked, says no, the tool never runs', async () => {
      const ran = { count: 0 };
      const asked: string[] = [];
      const server = serve({
        name: 't',
        tools: { danger: gatedTool(ran) },
        approve: ({ toolName }) => {
          asked.push(toolName);
          return false;
        },
      });
      const client = await connect(server);

      await expect(client.callTool('danger', {})).rejects.toThrow('Tool call denied.');
      expect(asked).toEqual(['danger']);
      expect(ran.count).toBe(0);
    });
  });
});

describe('createMcpServer — guardrails', () => {
  it('onToolCall: a block denies with the rule name, a rewrite changes what execute receives', async () => {
    const execute = vi.fn((args: unknown) => args);
    const noProd = Object.assign(
      (ctx: { toolCall: { args: unknown } }) =>
        (ctx.toolCall.args as { env?: string }).env === 'prod'
          ? { action: 'block' as const, reason: 'production is off-limits' }
          : undefined,
      {},
    );
    Object.defineProperty(noProd, 'name', { value: 'noProd' });
    const server = serve({
      name: 't',
      tools: {
        run: {
          parameters: z.object({ env: z.string(), dryRun: z.boolean().optional() }),
          execute,
        },
      },
      guardrails: {
        onToolCall: [
          noProd,
          (ctx) => ({
            action: 'rewrite',
            args: { ...(ctx.toolCall.args as object), dryRun: true },
          }),
        ],
      },
    });
    const client = await connect(server);

    await expect(client.callTool('run', { env: 'prod' })).rejects.toThrow(
      "Blocked by guardrail 'noProd': production is off-limits",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await client.callTool('run', { env: 'dev' })).toEqual({ env: 'dev', dryRun: true });
  });

  it('onToolResult: a rewrite redacts what the client sees, a block withholds it', async () => {
    const seen: Array<{ result: unknown; isError: boolean }> = [];
    const server = serve({
      name: 't',
      tools: {
        secret: { parameters: { type: 'object' }, execute: () => 'token=abc123' },
        hidden: { parameters: { type: 'object' }, execute: () => 'classified' },
        boom: {
          parameters: { type: 'object' },
          execute: () => {
            throw new Error('exploded');
          },
        },
      },
      guardrails: {
        onToolResult: (ctx) => {
          seen.push({ result: ctx.result, isError: ctx.isError });
          if (ctx.toolCall.toolName === 'hidden') return { action: 'block', reason: 'withheld' };
          if (typeof ctx.result === 'string' && ctx.result.includes('token='))
            return { action: 'rewrite', result: 'token=[redacted]' };
          return undefined;
        },
      },
    });
    const client = await connect(server);

    expect(await client.callTool('secret', {})).toBe('token=[redacted]');
    await expect(client.callTool('hidden', {})).rejects.toThrow(/withheld/);
    await expect(client.callTool('boom', {})).rejects.toThrow('exploded');
    expect(seen).toEqual([
      { result: 'token=abc123', isError: false },
      { result: 'classified', isError: false },
      { result: 'exploded', isError: true },
    ]);
  });
});

describe('createMcpServer — a native AgentToolSet', () => {
  it('validates the tool context from toolsContext and serves the toModelOutput projection', async () => {
    const agentTools: AgentToolSet = {
      lookup: {
        description: 'Find an order.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        contextSchema: { type: 'object', properties: { tenant: { type: 'string' } } },
        validateContext: (value) => {
          const tenant = (value as { tenant?: unknown } | undefined)?.tenant;
          if (typeof tenant !== 'string') throw new Error('tenant is required');
          return { tenant };
        },
        execute: (args: { id: string }, ctx) => ({
          id: args.id,
          tenant: (ctx.context as { tenant: string }).tenant,
        }),
        toModelOutput: (result: { id: string; tenant: string }) =>
          `order ${result.id} belongs to ${result.tenant}`,
      },
    };
    const server = serve({
      name: 't',
      agentTools,
      toolsContext: (request) => ({ lookup: { tenant: request.authInfo?.clientId } }),
    });

    const client = await connect(server, {
      authInfo: { token: 't', clientId: 'acme', scopes: [] },
    });
    expect(await client.callTool('lookup', { id: 'o-7' })).toBe('order o-7 belongs to acme');

    // No verified identity → the context fails its own validation → error result.
    const anonymous = await connect(server);
    await expect(anonymous.callTool('lookup', { id: 'o-7' })).rejects.toThrow(/tenant/);
  });

  it("advertises and enforces an AgentTool's outputSchema when no projection replaces the result", async () => {
    const outputSchema = {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
    };
    const server = serve({
      name: 't',
      agentTools: {
        total: {
          parameters: { type: 'object' },
          outputSchema,
          validateResult: (value) => value as { total: number },
          execute: () => ({ total: 12 }),
        },
      },
    });
    const client = await connect(server);

    expect((await client.listTools()).total!.outputSchema).toEqual(outputSchema);
    expect(await client.callTool('total', {})).toEqual({ total: 12 });
  });
});

describe('createMcpServer — an agent behind a tool', () => {
  it('runs runAgent with the caller prompt as the user turn and answers with its text', async () => {
    const model = createMockModel({ responses: [{ text: 'The answer is 42.' }] });
    const config = readConfig(model)!;
    const modelFetch = vi.fn(config.fetch!);
    config.fetch = modelFetch;
    const server = serve({
      name: 't',
      agents: {
        researcher: { description: 'Answers research questions.', agent: { model } },
      },
    });
    const client = await connect(server);

    const listed = (await client.listTools()).researcher!;
    expect(listed.description).toBe('Answers research questions.');
    expect(listed.parameters).toMatchObject({ required: ['prompt'] });

    expect(await client.callTool('researcher', { prompt: 'What is the answer?' })).toBe(
      'The answer is 42.',
    );
    const body = JSON.parse(String(modelFetch.mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(body.messages)).toContain('What is the answer?');
  });

  it('a structured output comes back as the value; options can be built per call', async () => {
    const builds: unknown[] = [];
    const server = serve({
      name: 't',
      agents: {
        scorer: {
          description: 'Scores an essay.',
          agent: (input, request) => {
            builds.push({ prompt: input.prompt, era: request.era });
            return {
              model: createMockModel({ responses: [{ text: '{"score":7}' }] }),
              output: {
                schema: {
                  type: 'object',
                  properties: { score: { type: 'number' } },
                  required: ['score'],
                },
                mode: 'json',
                validate: (value: unknown) => value as { score: number },
              },
            };
          },
        },
      },
    });
    const client = await connect(server);

    expect(await client.callTool('scorer', { prompt: 'essay text' })).toEqual({ score: 7 });
    expect(builds).toEqual([{ prompt: 'essay text', era: 'modern' }]);
  });

  it('a run that does not complete is an error result naming why', async () => {
    const server = serve({
      name: 't',
      agents: {
        broken: {
          description: 'Always fails.',
          agent: () => {
            throw new Error('no model configured for this tenant');
          },
        },
      },
    });
    const client = await connect(server);

    await expect(client.callTool('broken', { prompt: 'x' })).rejects.toThrow(
      'no model configured for this tenant',
    );
  });
});

describe('createMcpServer — lifecycle', () => {
  it('ready() resolves once the SDK is loaded and every tool is prepared; close() is idempotent', async () => {
    const server = serve({
      name: 't',
      tools: { scale: { parameters: z.object({ n: z.number() }), execute: () => 1 } },
    });
    await expect(server.ready()).resolves.toBeUndefined();
    await server.close();
    await server.close();
  });

  it('fetch is a detachable function', async () => {
    const { fetch } = serve({ name: 't', tools: basicTools() });
    const client = await createMcpClient({
      sdk: 'v2',
      transport: {
        type: 'http',
        url: ENDPOINT,
        fetch: (input, init) => fetch(new Request(input, init)),
      },
    });
    clients.push(client);
    expect(await client.callTool('echo', { value: 'detached' })).toBe('echo:detached');
  });
});

describe('createMcpServer — the optional peer is missing', () => {
  const notInstalled = (name: string) => (): never => {
    throw new Error(`Cannot find module '${name}'`);
  };

  afterEach(() => {
    vi.doUnmock('@modelcontextprotocol/server');
    vi.doUnmock('@standard-community/standard-json');
    vi.resetModules();
  });

  it('a Standard Schema that cannot be listed as JSON Schema fails ready(), naming the tool', async () => {
    vi.doMock(
      '@standard-community/standard-json',
      notInstalled('@standard-community/standard-json'),
    );
    vi.resetModules();
    const { createMcpServer: fresh } = await import('../src/mcp/server');

    const input = fresh({
      name: 't',
      tools: { scale: { parameters: z.object({ n: z.number() }), execute: () => 1 } },
    });
    await expect(input.ready()).rejects.toThrow(/'scale'.*standard-json/);

    const output = fresh({
      name: 't',
      agentTools: {
        total: {
          parameters: { type: 'object' },
          outputSchema: z.object({ total: z.number() }),
          execute: () => ({ total: 1 }),
        },
      },
    });
    await expect(output.ready()).rejects.toThrow(/'total'.*standard-json/);
  });

  it('ready() rejects with the install hint and fetch answers a JSON-RPC error', async () => {
    vi.doMock('@modelcontextprotocol/server', notInstalled('@modelcontextprotocol/server'));
    vi.resetModules();
    const { createMcpServer: fresh } = await import('../src/mcp/server');
    const errors: Error[] = [];
    const server = fresh({ name: 't', tools: basicTools(), onError: (e) => errors.push(e) });

    await expect(server.ready()).rejects.toThrow(/npm i @modelcontextprotocol\/server/);
    await expect(server.ready()).rejects.toMatchObject({ name: 'InvalidRequestError' });
    const response = await server.fetch(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/@modelcontextprotocol\/server/);
    expect(errors.length).toBeGreaterThan(0);
  });
});
