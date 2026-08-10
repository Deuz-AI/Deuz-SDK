/**
 * mcp-loop.test.ts — zero-config MCP (2.0): `CommonCallOptions.mcp` wired into
 * both agentic loops.
 *
 * Before 2.0, using an MCP server meant `const tools = await client.listTools()`
 * followed by a manual spread and a manual `close()` — and nothing refreshed when
 * the server changed its catalog mid-run. This file pins the replacement:
 * `mcp: [{ url }]` connects, namespaces, merges, hot-refreshes and tears down by
 * itself.
 *
 * It runs against the REAL in-process server (`test/helpers/mcp-http-server.ts`):
 * a `node:http` listener, the real SDK transport, real SSE framing. The only
 * fakes are (a) the MODEL, which is the deterministic Anthropic golden-replay
 * used by `tool-loop.test.ts` — every assertion about "which tools did the model
 * see" reads the recorded request body — and (b) two hand-written `McpClient`s,
 * for the one case a real server cannot express: a client that exposes no
 * `serverInfo`, which is what the positional `mcp{N}` prefix exists for.
 *
 * Timing is deterministic without fake timers: the `tools/list_changed` push is
 * awaited through the loop's own subscription (a local tool blocks until the
 * notification lands), never slept on.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateText, streamChat, generateObject } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMcpClient } from '../src/mcp/index';
import {
  createMcpPool,
  resolveMcpForLoop,
  type McpConnectionPool,
  type McpPoolOptions,
} from '../src/mcp/resolve';
import type { McpClient } from '../src/mcp/shared';
import type { Logger } from '../src/types/deps';
import type { JSONSchema } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import type { ToolSet } from '../src/types/tool';
import { sseEvents, sseResponse, mockFetchSequence } from './fixtures/sse';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
  type TestMcpServerOptions,
} from './helpers/mcp-http-server';

const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {} };
const CITY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const servers: TestMcpServerHandle[] = [];
const clients: McpClient[] = [];
const pools: McpConnectionPool[] = [];

beforeAll(async () => {
  // Warm the optional peer's module graph once — see the note in mcp-http.test.ts.
  await import('@modelcontextprotocol/sdk/client/index.js');
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await import('@modelcontextprotocol/sdk/server/index.js');
  await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
}, 60_000);

afterEach(async () => {
  while (pools.length > 0) await pools.pop()!.close();
  // Clients first: closing one whose server is already gone still has to resolve.
  while (clients.length > 0) {
    await clients
      .pop()!
      .close()
      .catch(() => {
        /* the run may already have closed it — that is what some tests assert */
      });
  }
  while (servers.length > 0) await servers.pop()!.close();
});

async function startServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServerHandle> {
  const server = await startTestMcpServer(opts);
  servers.push(server);
  return server;
}

/** A live client the TEST owns — the loop must borrow it and never close it. */
async function connect(url: string): Promise<McpClient> {
  const client = await createMcpClient({ transport: { type: 'http', url } });
  clients.push(client);
  return client;
}

function pooled(options: McpPoolOptions = {}): McpConnectionPool {
  const pool = createMcpPool(options);
  pools.push(pool);
  return pool;
}

/** Poll until `pred` holds — the server pushes over SSE, so there is nothing to await. */
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

// --- the deterministic model ------------------------------------------------

/** One Anthropic turn that calls `name` with `input` and stops on tool_use. */
function toolCallTurn(name: string, input: unknown, id = 'toolu_1'): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

/** One plain-text Anthropic turn that ends the run. */
function textTurn(text: string): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

interface Scripted {
  model: ReturnType<ReturnType<typeof createAnthropic>>;
  calls: { url: string; init?: RequestInit }[];
  /** The tool NAMES the model was offered on request `index` — the wire, not our state. */
  offered(index: number): string[];
}

function scripted(turns: string[]): Scripted {
  const { fetch, calls } = mockFetchSequence(turns.map((turn) => () => sseResponse([turn])));
  return {
    model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
    calls,
    offered(index) {
      const body = JSON.parse(String(calls[index]!.init!.body)) as { tools?: { name: string }[] };
      return (body.tools ?? []).map((t) => t.name);
    },
  };
}

function captureLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warns.push(message);
      },
      error: () => {},
    },
  };
}

// --- a hand-written client (no serverInfo, no network) ----------------------

interface FakeMcpClient extends McpClient {
  closeCount: number;
  /**
   * Live `onToolListChanged` subscriptions. The run subscribes to EVERY client
   * (borrowed ones included) and releases them in `closeOwned()`, so a zero here
   * after a run is the observable proof that teardown ran — the one signal a
   * borrowed client can give, since it is never closed.
   */
  listenerCount(): number;
  /** Swap the catalog, then fire `tools/list_changed` at every subscriber. */
  publish(names: string[]): void;
}

function makeFakeClient(names: string[], options: { failListAfter?: number } = {}): FakeMcpClient {
  let current = [...names];
  let lists = 0;
  const listeners = new Set<() => void>();
  const unsupported = (): Promise<never> => Promise.reject(new Error('not supported'));
  const client: FakeMcpClient = {
    closeCount: 0,
    listenerCount: () => listeners.size,
    publish(next) {
      current = [...next];
      for (const listener of [...listeners]) listener();
    },
    listTools(namespace) {
      lists += 1;
      if (options.failListAfter !== undefined && lists > options.failListAfter) {
        return Promise.reject(new Error('tools/list blew up'));
      }
      const set: ToolSet = {};
      for (const name of current) {
        set[namespace ? `${namespace}_${name}` : name] = {
          parameters: EMPTY_SCHEMA,
          execute: () => Promise.resolve(`fake:${name}`),
        };
      }
      return Promise.resolve(set);
    },
    callTool: (name) => Promise.resolve(`fake:${name}`),
    listResources: unsupported,
    readResource: unsupported,
    listPrompts: unsupported,
    getPrompt: unsupported,
    status: () => 'connected',
    onToolListChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close() {
      client.closeCount += 1;
      return Promise.resolve();
    },
  };
  return client;
}

const USER = { role: 'user' as const, content: 'go' };

// ---------------------------------------------------------------------------

describe('options.mcp — generateText', () => {
  it('connects, offers the catalog unprefixed, and executes a tool', async () => {
    const server = await startServer();
    const { model, offered } = scripted([toolCallTurn('echo', { value: 'hi' }), textTurn('done')]);

    const res = await generateText({
      model,
      messages: [USER],
      // No `tools` of our own: the server's catalog IS the tool set, and a
      // tool-less call still has to route through the loop.
      mcp: [{ url: server.url }],
      maxSteps: 4,
    });

    // A SINGLE entry gets no prefix — that is the zero-config promise.
    expect(offered(0)).toEqual(['echo', 'add', 'boom']);
    expect(server.calls).toEqual([{ name: 'echo', args: { value: 'hi' } }]);
    expect(res.steps).toHaveLength(2);
    expect(res.steps![0]!.toolResults[0]!.result).toBe('echo:hi');
    expect(res.text).toBe('done');
    // ONE handshake for the whole run, not one per step.
    expect(server.sessionCount()).toBe(1);
  }, 20_000);

  it('a structured MCP result comes back verbatim through the loop', async () => {
    const server = await startServer();
    const { model } = scripted([toolCallTurn('add', { a: 2, b: 3 }), textTurn('five')]);

    const res = await generateText({
      model,
      messages: [USER],
      mcp: [{ url: server.url }],
      maxSteps: 4,
    });

    expect(res.steps![0]!.toolResults[0]!.result).toEqual({ sum: 5 });
    expect(res.text).toBe('five');
  }, 20_000);
});

describe('options.mcp — streamChat', () => {
  it('drives the same round-trip and emits the tool parts', async () => {
    const server = await startServer();
    const { model, offered } = scripted([
      toolCallTurn('echo', { value: 'stream' }),
      textTurn('ok'),
    ]);

    const res = streamChat({ model, messages: [USER], mcp: [{ url: server.url }], maxSteps: 4 });
    // G2: the shell is synchronous even though MCP setup is async.
    expect(res).not.toBeInstanceOf(Promise);

    const parts: StreamPart[] = [];
    for await (const part of res.fullStream) parts.push(part);

    expect(offered(0)).toEqual(['echo', 'add', 'boom']);
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'echo',
      input: { value: 'stream' },
    });
    expect(parts.find((p) => p.type === 'tool-result')).toMatchObject({
      toolName: 'echo',
      output: 'echo:stream',
    });
    expect(server.calls).toEqual([{ name: 'echo', args: { value: 'stream' } }]);
    expect(await res.finishReason).toBe('stop');
  }, 20_000);

  it('tears the MCP runtime down at the pump exit', async () => {
    const fake = makeFakeClient(['note']);
    const { model } = scripted([textTurn('done')]);

    const res = streamChat({ model, messages: [USER], mcp: [fake] });
    for await (const _part of res.fullStream) {
      /* drain */
    }

    expect(fake.listenerCount()).toBe(0); // closeOwned() ran at the pump's exit
    expect(fake.closeCount).toBe(0); // …and left the borrowed client alone
  });
});

describe('options.mcp — namespaces', () => {
  it('derives prefixes from serverInfo when several servers are combined', async () => {
    const alpha = await startServer({
      name: 'Alpha MCP',
      tools: [{ name: 'ping', handler: () => 'a' }],
    });
    const beta = await startServer({ name: 'beta', tools: [{ name: 'ping', handler: () => 'b' }] });
    const { model, offered } = scripted([toolCallTurn('beta_ping', {}), textTurn('done')]);

    const res = await generateText({
      model,
      messages: [USER],
      mcp: [{ url: alpha.url }, { url: beta.url }],
      maxSteps: 4,
    });

    // 'Alpha MCP' is not a legal tool-name prefix — the space is sanitized away.
    expect(offered(0)).toEqual(['Alpha_MCP_ping', 'beta_ping']);
    // The prefix is a LOCAL alias: the wire call carries the bare name, to the
    // second server only.
    expect(beta.calls).toEqual([{ name: 'ping', args: {} }]);
    expect(alpha.calls).toEqual([]);
    expect(res.steps![0]!.toolResults[0]!.result).toBe('b');
  }, 20_000);

  it('an explicit namespace wins over the derived one', async () => {
    const alpha = await startServer({
      name: 'Alpha MCP',
      tools: [{ name: 'ping', handler: () => 'a' }],
    });
    const beta = await startServer({ name: 'beta', tools: [{ name: 'ping', handler: () => 'b' }] });
    const { model, offered } = scripted([textTurn('done')]);

    await generateText({
      model,
      messages: [USER],
      mcp: [{ url: alpha.url, namespace: 'first' }, { url: beta.url }],
    });

    expect(offered(0)).toEqual(['first_ping', 'beta_ping']);
  }, 20_000);

  it('falls back to mcp{N} for a client that exposes no serverInfo', async () => {
    const a = makeFakeClient(['alpha']);
    const b = makeFakeClient(['beta']);
    const { model, offered } = scripted([textTurn('done')]);

    await generateText({ model, messages: [USER], mcp: [a, b] });

    expect(offered(0)).toEqual(['mcp0_alpha', 'mcp1_beta']);
    // Borrowed clients are never closed by the run.
    expect(a.closeCount).toBe(0);
    expect(b.closeCount).toBe(0);
  });

  it('accepts a bare client, a { client, namespace } entry and a url config together', async () => {
    const remote = await startServer({
      name: 'remote',
      tools: [{ name: 'ping', handler: () => 'r' }],
    });
    const liveServer = await startServer({
      name: 'live',
      tools: [{ name: 'ping', handler: () => 'l' }],
    });
    const live = await connect(liveServer.url);
    const fake = makeFakeClient(['note']);
    const { model, offered } = scripted([toolCallTurn('mine_ping', {}), textTurn('done')]);

    const res = await generateText({
      model,
      messages: [USER],
      mcp: [{ url: remote.url }, { client: live, namespace: 'mine' }, fake],
      maxSteps: 4,
    });

    expect(offered(0)).toEqual(['remote_ping', 'mine_ping', 'mcp2_note']);
    expect(liveServer.calls).toEqual([{ name: 'ping', args: {} }]);
    expect(res.steps![0]!.toolResults[0]!.result).toBe('l');
  }, 20_000);
});

describe('options.mcp — merge precedence', () => {
  it('warns on a duplicate key and lets the LATER server win', async () => {
    const first = await startServer({ tools: [{ name: 'ping', handler: () => 'first' }] });
    const second = await startServer({ tools: [{ name: 'ping', handler: () => 'second' }] });
    const { logger, warns } = captureLogger();
    const { model, offered } = scripted([toolCallTurn('dup_ping', {}), textTurn('done')]);

    const res = await generateText({
      model,
      messages: [USER],
      deps: { logger },
      // The SAME explicit namespace on both entries is the only way to collide.
      mcp: [
        { url: first.url, namespace: 'dup' },
        { url: second.url, namespace: 'dup' },
      ],
      maxSteps: 4,
    });

    expect(offered(0)).toEqual(['dup_ping']); // one key, not two
    expect(warns.some((w) => w.includes("duplicate tool name 'dup_ping'"))).toBe(true);
    expect(res.steps![0]!.toolResults[0]!.result).toBe('second');
    expect(first.calls).toEqual([]);
  }, 20_000);

  it("the caller's own tools always win a name collision", async () => {
    const server = await startServer({
      tools: [{ name: 'echo', handler: () => 'from the server' }],
    });
    const local = vi.fn(() => Promise.resolve('from the caller'));
    const { model, offered } = scripted([toolCallTurn('echo', { value: 'x' }), textTurn('done')]);

    const res = await generateText({
      model,
      messages: [USER],
      mcp: [{ url: server.url }],
      tools: { echo: { description: 'local echo', parameters: EMPTY_SCHEMA, execute: local } },
      maxSteps: 4,
    });

    expect(offered(0)).toEqual(['echo']);
    expect(local).toHaveBeenCalledTimes(1);
    expect(res.steps![0]!.toolResults[0]!.result).toBe('from the caller');
    // The remote tool was shadowed, so the server saw nothing.
    expect(server.calls).toEqual([]);
  }, 20_000);
});

describe('options.mcp — connection failure', () => {
  it('generateText rejects with an error naming the entry, before any model call', async () => {
    const dead = await startTestMcpServer();
    const url = dead.url;
    await dead.close();
    const { model, calls } = scripted([textTurn('never reached')]);

    const failure = await generateText({ model, messages: [USER], mcp: [{ url }] }).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^mcp: could not connect to /);
    expect((failure as Error).message).toContain(url);
    expect(failure).toMatchObject({ code: 'invalid_request' });
    // Fail fast: no model call was paid for.
    expect(calls).toHaveLength(0);
  }, 20_000);

  it('streamChat turns it into an error part, never a synchronous throw (G2)', async () => {
    const dead = await startTestMcpServer();
    const url = dead.url;
    await dead.close();
    const { model, calls } = scripted([textTurn('never reached')]);

    const res = streamChat({ model, messages: [USER], mcp: [{ url }] });
    expect(res).not.toBeInstanceOf(Promise);

    const parts: StreamPart[] = [];
    for await (const part of res.fullStream) parts.push(part);

    const errorPart = parts.find((p) => p.type === 'error') as { error: unknown } | undefined;
    expect((errorPart?.error as Error).message).toMatch(/^mcp: could not connect to /);
    await expect(res.usage).rejects.toThrow(/^mcp: could not connect to /);
    expect(calls).toHaveLength(0);
  }, 20_000);
});

describe('options.mcp — hot swap between steps', () => {
  it('a tool added mid-run is on the wire for the very next step', async () => {
    const server = await startServer({ tools: [{ name: 'ping', handler: () => 'pong' }] });
    const client = await connect(server.url);
    let invalidated = false;
    client.onToolListChanged(() => {
      invalidated = true;
    });
    // Notifications ride the standalone GET SSE stream, which opens after connect().
    await server.waitForClientStream();

    const { model, offered } = scripted([toolCallTurn('trigger', {}), textTurn('done')]);
    const res = await generateText({
      model,
      messages: [USER],
      mcp: [client],
      tools: {
        // A local tool is the synchronization point: the loop awaits it, so the
        // push has provably landed before the next step's wire is built.
        trigger: {
          parameters: EMPTY_SCHEMA,
          execute: async () => {
            server.addTool({
              name: 'freshTool',
              description: 'added mid-run',
              handler: () => 'new',
            });
            await waitFor(() => invalidated, 'tools/list_changed to reach the client');
            return 'added';
          },
        },
      },
      maxSteps: 4,
    });

    expect(offered(0)).toEqual(['ping', 'trigger']);
    expect(offered(1)).toEqual(['ping', 'freshTool', 'trigger']);
    expect(res.text).toBe('done');
    // Borrowed: the run must not have closed the caller's client.
    expect(client.status()).toBe('connected');
  }, 20_000);

  it('a failed refresh keeps the previous catalog instead of killing the run', async () => {
    // The first list succeeds (setup); every later one rejects — i.e. the server
    // announced a change and then could not serve the new catalog.
    const fake = makeFakeClient(['ping'], { failListAfter: 1 });
    const { logger, warns } = captureLogger();
    const { model, offered } = scripted([toolCallTurn('trigger', {}), textTurn('done')]);

    const res = await generateText({
      model,
      messages: [USER],
      deps: { logger },
      mcp: [fake],
      tools: {
        trigger: {
          parameters: EMPTY_SCHEMA,
          execute: () => {
            fake.publish(['ping', 'never-seen']);
            return Promise.resolve('ok');
          },
        },
      },
      maxSteps: 4,
    });

    expect(offered(0)).toEqual(['ping', 'trigger']);
    // Degraded, not dead: step 2 still runs, with the catalog that last worked.
    expect(offered(1)).toEqual(['ping', 'trigger']);
    expect(res.text).toBe('done');
    expect(warns.some((w) => w.includes('mcp: tool-list refresh failed'))).toBe(true);
  });
});

describe('options.mcp — ownership', () => {
  it('leaves a borrowed client connected and usable after the run', async () => {
    const owned = await startServer({
      name: 'owned',
      tools: [{ name: 'ping', handler: () => 'o' }],
    });
    const liveServer = await startServer({
      name: 'live',
      tools: [{ name: 'pong', handler: () => 'l' }],
    });
    const live = await connect(liveServer.url);
    const { model } = scripted([textTurn('done')]);

    await generateText({ model, messages: [USER], mcp: [{ url: owned.url }, live] });

    expect(live.status()).toBe('connected');
    expect(await live.callTool('pong', {})).toBe('l');
  }, 20_000);

  it('runs teardown even when the run throws (and still never closes a borrowed client)', async () => {
    const fake = makeFakeClient(['note']);
    const boom = new Error('prepareStep exploded');
    const { model } = scripted([textTurn('never')]);

    await expect(
      generateText({
        model,
        messages: [USER],
        mcp: [fake],
        prepareStep: () => {
          throw boom;
        },
      }),
    ).rejects.toThrow(boom);

    // The `finally` covers the throw path too: subscriptions released, borrowed
    // client untouched.
    expect(fake.listenerCount()).toBe(0);
    expect(fake.closeCount).toBe(0);
  });

  it('opens a fresh connection per run when no pool is injected', async () => {
    const server = await startServer({ tools: [{ name: 'ping', handler: () => 'pong' }] });

    for (let i = 0; i < 2; i++) {
      const { model } = scripted([textTurn('done')]);
      await generateText({ model, messages: [USER], mcp: [{ url: server.url }] });
    }

    // Two runs, two handshakes — the contrast that makes `deps.mcpPool` (one
    // handshake for both) a real optimization and not a coincidence.
    expect(server.sessionCount()).toBe(2);
  }, 20_000);
});

describe('resolveMcpForLoop — closeOwned()', () => {
  it('closes a connection it opened', async () => {
    const server = await startServer();
    const { logger } = captureLogger();

    const runtime = await resolveMcpForLoop([{ url: server.url }], { logger });
    expect(Object.keys(runtime.tools)).toEqual(['echo', 'add', 'boom']);
    expect(runtime.clients[0]!.status()).toBe('connected');

    await runtime.closeOwned();
    expect(runtime.clients[0]!.status()).toBe('closed');
    // Idempotent: a second teardown (loop finally + caller) must not throw.
    await expect(runtime.closeOwned()).resolves.toBeUndefined();
  }, 20_000);

  it('never closes a borrowed client, and releases its subscription', async () => {
    const liveServer = await startServer();
    const live = await connect(liveServer.url);
    const fake = makeFakeClient(['note']);
    const { logger } = captureLogger();

    const runtime = await resolveMcpForLoop([live, fake], { logger });
    expect(fake.listenerCount()).toBe(1);

    await runtime.closeOwned();
    expect(live.status()).toBe('connected');
    expect(fake.closeCount).toBe(0);
    expect(fake.listenerCount()).toBe(0);
  }, 20_000);

  it('refreshes the merged set only when a server invalidated it', async () => {
    const a = makeFakeClient(['alpha']);
    const b = makeFakeClient(['beta']);
    const { logger } = captureLogger();

    const runtime = await resolveMcpForLoop([a, b], { logger });
    expect(Object.keys(runtime.tools)).toEqual(['mcp0_alpha', 'mcp1_beta']);
    expect(runtime.changed()).toBe(false);

    b.publish(['beta', 'gamma']);
    expect(runtime.changed()).toBe(true);
    expect(Object.keys(await runtime.refresh())).toEqual(['mcp0_alpha', 'mcp1_beta', 'mcp1_gamma']);
    expect(runtime.changed()).toBe(false);
    await runtime.closeOwned();
  });

  it('rejects with an actionable message when a server is unreachable', async () => {
    const dead = await startTestMcpServer();
    const url = dead.url;
    await dead.close();
    const { logger } = captureLogger();

    await expect(resolveMcpForLoop([{ url }], { logger })).rejects.toThrow(
      /^mcp: could not connect to /,
    );
  }, 20_000);
});

describe('deps.mcpPool', () => {
  it('reuses one connection across calls and survives every run', async () => {
    const server = await startServer({ tools: [{ name: 'ping', handler: () => 'pong' }] });
    const pool = pooled();

    for (const label of ['first', 'second']) {
      const { model } = scripted([toolCallTurn('ping', {}), textTurn(label)]);
      const res = await generateText({
        model,
        messages: [USER],
        deps: { mcpPool: pool },
        mcp: [{ url: server.url }],
        maxSteps: 4,
      });
      expect(res.text).toBe(label);
    }

    expect(server.calls).toHaveLength(2);
    // ONE handshake for two runs, and it is still alive: the pool owns the
    // connection, so `closeOwned()` deliberately left it alone.
    expect(server.sessionCount()).toBe(1);
    const a = await pool.acquire({ url: server.url });
    const b = await pool.acquire({ url: server.url });
    expect(b).toBe(a); // structural key: a fresh config object hits the same entry
    expect(a.status()).toBe('connected');
    expect(server.sessionCount()).toBe(1);

    await pool.close();
    expect(a.status()).toBe('closed');
  }, 30_000);

  // `sessionCount()` is the handshake ledger: the SDK client's close() aborts its
  // sockets without sending the DELETE that would retire the session id, so a
  // session the pool abandoned still shows up. That is exactly what makes it able
  // to see a connection nobody holds a handle to any more.

  it('shares ONE connect between concurrent acquires of a cold server', async () => {
    const server = await startServer();
    const pool = pooled();

    const [a, b] = await Promise.all([
      pool.acquire({ url: server.url }),
      pool.acquire({ url: server.url }),
    ]);

    expect(b).toBe(a);
    expect(server.sessionCount()).toBe(1);
  }, 20_000);

  it('two acquires racing on a DEAD entry open ONE replacement, not one each', async () => {
    const server = await startServer();
    const pool = pooled();

    const dead = await pool.acquire({ url: server.url });
    await dead.close();
    expect(dead.status()).toBe('closed');

    const [a, b] = await Promise.all([
      pool.acquire({ url: server.url }),
      pool.acquire({ url: server.url }),
    ]);

    expect(a).toBe(b);
    expect(a.status()).toBe('connected');
    // The corpse plus ONE replacement. Both callers used to evict the same dead
    // entry and connect their own: the loser's client was overwritten in the map
    // milliseconds later, leaving a live session with no handle to close it.
    expect(server.sessionCount()).toBe(2);
  }, 20_000);

  it('keys on the connection: a different namespace shares, a different url does not', async () => {
    const one = await startServer();
    const two = await startServer();
    const pool = pooled();

    const a = await pool.acquire({ url: one.url, namespace: 'a' });
    const b = await pool.acquire({ url: one.url, namespace: 'b' });
    const c = await pool.acquire({ url: two.url });

    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(one.sessionCount()).toBe(1);
    expect(two.sessionCount()).toBe(1);
  }, 20_000);

  it('evicts and CLOSES the least recently used connection at maxSize', async () => {
    const one = await startServer();
    const two = await startServer();
    const three = await startServer();
    const pool = pooled({ maxSize: 2 });

    const a = await pool.acquire({ url: one.url });
    const b = await pool.acquire({ url: two.url });
    await pool.acquire({ url: one.url }); // touched again → `two` is now the oldest
    const c = await pool.acquire({ url: three.url });

    // Evicted AND closed: dropping the entry alone would leak the session, which
    // is the whole failure an unbounded pool was made of. `status()` is how a
    // holder of the evicted client finds out, so it is what this asserts.
    await waitFor(() => b.status() === 'closed', 'the evicted connection to be closed');
    expect(a.status()).toBe('connected');
    expect(c.status()).toBe('connected');
    expect(await pool.acquire({ url: one.url })).toBe(a); // survived, and still pooled
    expect(one.sessionCount()).toBe(1);
  }, 30_000);

  it('warns that a per-request handler cannot be pooled, and bounds what it costs', async () => {
    const server = await startServer();
    const { logger, warns } = captureLogger();
    const pool = pooled({ maxSize: 1, logger });

    // A closure rebuilt per request can only be keyed by its identity, so it
    // MISSES every time — the shape that used to add a live connection per
    // request, forever, with nothing left holding a reference to close it.
    const first = await pool.acquire({
      url: server.url,
      onElicitationRequest: () => ({ action: 'decline' }),
    });
    const second = await pool.acquire({
      url: server.url,
      onElicitationRequest: () => ({ action: 'decline' }),
    });

    expect(second).not.toBe(first);
    expect(warns.some((w) => w.includes('identity-keyed'))).toBe(true);
    await waitFor(() => first.status() === 'closed', 'the overflowing connection to be closed');
    expect(second.status()).toBe('connected');
  }, 20_000);
});

describe('structured output refuses options.mcp', () => {
  it('generateObject rejects before a single handshake', async () => {
    const server = await startServer();
    const { model, calls } = scripted([textTurn('{"city":"Paris"}')]);

    const failure = await generateObject({
      model,
      messages: [USER],
      schema: CITY_SCHEMA,
      mode: 'json',
      mcp: [{ url: server.url }],
    }).catch((err: unknown) => err);

    expect(failure).toMatchObject({ code: 'invalid_request' });
    expect((failure as Error).message).toContain('mcp');
    // Nothing connected and nothing was generated — the refusal is up front.
    expect(server.sessionCount()).toBe(0);
    expect(calls).toHaveLength(0);
  }, 20_000);
});
