import { describe, it, expect } from 'vitest';
import {
  createManagedConnection,
  wrapMcpClient,
  mcpToolsToToolSet,
  extractContent,
  buildElicitationHandler,
  type McpClientHooks,
  type McpConnectionStatus,
  type McpLifecycleOptions,
  type McpToolDef,
  type RawMcpClient,
  type McpElicitationRequest,
} from '../src/mcp/shared';
import type { Clock } from '../src/types/deps';

const fakeRaw: RawMcpClient = {
  connect: async () => {},
  listTools: async () => ({
    tools: [
      {
        name: 'scrape',
        description: 'Scrape a URL',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
    ],
  }),
  callTool: async (req) => ({
    content: [{ type: 'text', text: `scraped:${(req.arguments as { url: string }).url}` }],
  }),
  close: async () => {},
};

describe('MCP → ToolSet mapping', () => {
  it('maps MCP tools to a ToolSet whose execute calls callTool', async () => {
    const client = wrapMcpClient(fakeRaw);
    const tools = await client.listTools();
    expect(Object.keys(tools)).toEqual(['scrape']);
    expect(tools.scrape!.parameters).toMatchObject({ type: 'object' });

    const out = await tools.scrape!.execute!(
      { url: 'https://x.com' },
      { toolCallId: '1', messages: [] },
    );
    expect(out).toBe('scraped:https://x.com');
  });

  it('namespaces tool names when combining servers', () => {
    const tools = mcpToolsToToolSet(fakeRaw, [{ name: 'scrape' }], 'firecrawl');
    expect(Object.keys(tools)).toEqual(['firecrawl_scrape']);
  });

  it('extractContent joins text and throws on isError (self-heal)', () => {
    expect(extractContent({ content: [{ type: 'text', text: 'ok' }] })).toBe('ok');
    expect(() =>
      extractContent({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    ).toThrow('boom');
  });
});

describe('structuredContent + outputSchema (MCP 2025-11-25)', () => {
  it('prefers structuredContent verbatim over the text join', () => {
    expect(
      extractContent({
        content: [{ type: 'text', text: '{"temp":22}' }], // redundant serialization per spec
        structuredContent: { temp: 22 },
      }),
    ).toEqual({ temp: 22 });
    expect(extractContent({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it('isError wins: throws even when structuredContent is present', () => {
    expect(() =>
      extractContent({
        content: [{ type: 'text', text: 'bad input' }],
        isError: true,
        structuredContent: { code: 42 },
      }),
    ).toThrow('bad input');
    // No text blocks → the error message falls back to the structured JSON.
    expect(() => extractContent({ isError: true, structuredContent: { code: 42 } })).toThrow(
      '{"code":42}',
    );
  });

  it('copies outputSchema through to Tool.outputSchema (metadata only)', () => {
    const out = { type: 'object', properties: { temp: { type: 'number' } } };
    const tools = mcpToolsToToolSet(fakeRaw, [{ name: 'weather', outputSchema: out }]);
    expect(tools.weather!.outputSchema).toEqual(out);
    const bare = mcpToolsToToolSet(fakeRaw, [{ name: 'plain' }]);
    expect('outputSchema' in bare.plain!).toBe(false);
  });
});

describe('resources + prompts', () => {
  it('listResources auto-paginates (cursor forwarded, pages merged)', async () => {
    const cursors: Array<string | undefined> = [];
    const raw: RawMcpClient = {
      ...fakeRaw,
      listResources: async (params) => {
        cursors.push(params?.cursor);
        return params?.cursor === 'c1'
          ? { resources: [{ uri: 'file://b', name: 'b' }] }
          : { resources: [{ uri: 'file://a', name: 'a' }], nextCursor: 'c1' };
      },
    };
    const resources = await wrapMcpClient(raw).listResources();
    expect(resources.map((r) => r.uri)).toEqual(['file://a', 'file://b']);
    expect(cursors).toEqual([undefined, 'c1']);
  });

  it('pagination stops at the safety cap on an endless cursor', async () => {
    let pages = 0;
    const raw: RawMcpClient = {
      ...fakeRaw,
      listPrompts: async () => {
        pages++;
        return { prompts: [{ name: `p${pages}` }], nextCursor: 'again' };
      },
    };
    const prompts = await wrapMcpClient(raw).listPrompts();
    expect(pages).toBe(100);
    expect(prompts).toHaveLength(100);
  });

  it('readResource unwraps contents; getPrompt passes args verbatim', async () => {
    const raw: RawMcpClient = {
      ...fakeRaw,
      readResource: async ({ uri }) => ({
        contents: [{ uri, text: 'hello', mimeType: 'text/plain' }],
      }),
      getPrompt: async (params) => ({
        description: 'greeting prompt',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `hi ${params.arguments?.name ?? '?'}` },
          },
        ],
      }),
    };
    const client = wrapMcpClient(raw);
    expect(await client.readResource('file://x')).toEqual([
      { uri: 'file://x', text: 'hello', mimeType: 'text/plain' },
    ]);
    const prompt = await client.getPrompt('greet', { name: 'umut' });
    expect(prompt.description).toBe('greeting prompt');
    expect(prompt.messages[0]).toMatchObject({ role: 'user' });
  });

  it('rejects with an actionable upgrade error when the SDK lacks a method', async () => {
    await expect(wrapMcpClient(fakeRaw).listResources()).rejects.toThrow(/\^1\.29\.0/);
    await expect(wrapMcpClient(fakeRaw).getPrompt('x')).rejects.toThrow(/\^1\.29\.0/);
  });
});

describe('elicitation (MCP 2025-11-25, form + url)', () => {
  it('normalizes mode-less params to a form request; result passes verbatim', async () => {
    const seen: McpElicitationRequest[] = [];
    const handler = buildElicitationHandler(async (req) => {
      seen.push(req);
      return { action: 'accept', content: { name: 'octocat' } };
    });
    const result = await handler({
      params: {
        message: 'Your GitHub username?',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    });
    expect(seen[0]).toEqual({
      mode: 'form', // servers MAY omit mode for form (back-compat)
      message: 'Your GitHub username?',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect(result).toEqual({ action: 'accept', content: { name: 'octocat' } });
  });

  it('passes url-mode requests through; decline result passes verbatim', async () => {
    const handler = buildElicitationHandler((req) => {
      expect(req).toEqual({
        mode: 'url',
        message: 'Authorize the connector.',
        url: 'https://mcp.example.com/connect',
        elicitationId: 'e-1',
      });
      return { action: 'decline' };
    });
    const result = await handler({
      params: {
        mode: 'url',
        message: 'Authorize the connector.',
        url: 'https://mcp.example.com/connect',
        elicitationId: 'e-1',
      },
    });
    expect(result).toEqual({ action: 'decline' });
  });
});

// --- Lifecycle: status, reconnect, listChanged, keepalive (2.0) -------------
//
// Every timer runs on an injected clock, so nothing here needs (or wants) fake
// timers: `fire()` advances one scheduled callback and lets the async chain
// settle on real microtasks.

/** Let the queued microtasks/turns settle — no `vi.useFakeTimers()` in sight. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

interface FakeClock extends Clock {
  /** Every delay handed to `setTimeout`, in call order — the backoff assertion. */
  delays: number[];
  pending(): number;
  /** Fire the earliest pending timer, then settle. */
  fire(): Promise<void>;
}

function makeFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  let timers: FakeTimer[] = [];
  const delays: number[] = [];
  return {
    delays,
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      delays.push(ms);
      timers.push({ id, at: now + ms, fn });
      return () => {
        timers = timers.filter((t) => t.id !== id);
      };
    },
    pending: () => timers.length,
    async fire() {
      const next = timers.reduce<FakeTimer | undefined>(
        (earliest, t) => (!earliest || t.at < earliest.at ? t : earliest),
        undefined,
      );
      if (!next) return;
      timers = timers.filter((t) => t.id !== next.id);
      now = next.at;
      next.fn();
      await settle();
    },
  };
}

interface FakeMcp {
  client: RawMcpClient;
  tools: McpToolDef[];
  listToolsCalls: number;
  closeCalls: number;
  pingRejects: boolean;
  /** What the SDK does when a session dies under us. */
  drop(): void;
  /** What a server's `notifications/tools/list_changed` does. */
  notifyToolListChanged(): void;
}

function makeFakeMcp(tools: McpToolDef[] = [{ name: 'a' }]): FakeMcp {
  let onNotify: (() => void) | undefined;
  const fake: FakeMcp = {
    tools,
    listToolsCalls: 0,
    closeCalls: 0,
    pingRejects: false,
    drop: () => fake.client.onclose?.(),
    notifyToolListChanged: () => onNotify?.(),
    client: {
      connect: async () => {},
      listTools: async () => {
        fake.listToolsCalls++;
        return { tools: fake.tools };
      },
      callTool: async (req) => ({ content: [{ type: 'text', text: `ok:${req.name}` }] }),
      close: async () => {
        fake.closeCalls++;
      },
      // Mirrors `registerToolListChanged` — one handler, schema ignored.
      setNotificationHandler: (_schema, handler) => {
        onNotify = () => handler({});
      },
      ping: async () => {
        if (fake.pingRejects) throw new Error('ping timed out');
        return {};
      },
    },
  };
  return fake;
}

/** Serve `fakes` in order; running out of them IS a refused connect attempt. */
function factories(fakes: FakeMcp[]): {
  makeClient(hooks: McpClientHooks): Promise<RawMcpClient>;
  makeTransport(): Promise<unknown>;
} {
  let n = 0;
  return {
    makeClient: async (hooks) => {
      const fake = fakes[n++];
      if (!fake) throw new Error('connect refused');
      fake.client.setNotificationHandler?.(null, () => hooks.toolListChanged());
      return fake.client;
    },
    makeTransport: async () => ({}),
  };
}

function trackStatus(): {
  seen: Array<[McpConnectionStatus, number | undefined]>;
  onStatusChange: NonNullable<McpLifecycleOptions['onStatusChange']>;
} {
  const seen: Array<[McpConnectionStatus, number | undefined]> = [];
  return { seen, onStatusChange: (status, info) => seen.push([status, info?.attempt]) };
}

describe('managed connection — the unmanaged wrapper stays 1.x', () => {
  it('reports connected and hands back a no-op tool-change unsubscribe', async () => {
    const client = wrapMcpClient(fakeRaw);
    expect(client.status()).toBe('connected');
    const off = client.onToolListChanged(() => {
      throw new Error('an unmanaged client has nothing to notify');
    });
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
    // ...and the 1.x pass-through still works, cache layer or not.
    expect(Object.keys(await client.listTools())).toEqual(['scrape']);
  });

  it('closes the raw client directly when there is no connection to manage', async () => {
    const fake = makeFakeMcp();
    await wrapMcpClient(fake.client).close();
    expect(fake.closeCalls).toBe(1);
  });
});

describe('managed connection — tool cache', () => {
  it('serves listTools from cache until the list is marked dirty', async () => {
    const fake = makeFakeMcp([{ name: 'a' }]);
    const managed = await createManagedConnection({
      ...factories([fake]),
      lifecycle: { clock: makeFakeClock() },
    });
    const client = wrapMcpClient(managed.raw(), managed);

    await client.listTools();
    await client.listTools();
    expect(fake.listToolsCalls).toBe(1);

    fake.tools = [{ name: 'a' }, { name: 'b' }];
    expect(Object.keys(await client.listTools())).toEqual(['a']); // still the cache

    managed.markToolsDirty();
    expect(Object.keys(await client.listTools())).toEqual(['a', 'b']);
    expect(fake.listToolsCalls).toBe(2);
  });

  it('a tools/list_changed notification invalidates the cache and notifies subscribers', async () => {
    const fake = makeFakeMcp([{ name: 'a' }]);
    const managed = await createManagedConnection({
      ...factories([fake]),
      lifecycle: { clock: makeFakeClock() },
    });
    const client = wrapMcpClient(managed.raw(), managed);
    const notified: number[] = [];
    const off = client.onToolListChanged(() => notified.push(1));

    await client.listTools();
    fake.tools = [{ name: 'b' }];
    fake.notifyToolListChanged();
    expect(notified).toHaveLength(1);
    expect(Object.keys(await client.listTools())).toEqual(['b']);

    off();
    fake.notifyToolListChanged();
    expect(notified).toHaveLength(1); // unsubscribed
  });

  it('mapped tools follow the session across a reconnect', async () => {
    const clock = makeFakeClock();
    const first = makeFakeMcp();
    const second = makeFakeMcp();
    const managed = await createManagedConnection({
      ...factories([first, second]),
      lifecycle: { clock, reconnect: { jitter: 0 } },
    });
    const tools = await wrapMcpClient(managed.raw(), managed).listTools();

    first.drop();
    await clock.fire();
    expect(managed.raw()).toBe(second.client);

    // The ToolSet was built against the DEAD client — it must still land on the live one.
    let sawName = '';
    second.client.callTool = async (req) => {
      sawName = req.name;
      return { content: [{ type: 'text', text: 'from the new session' }] };
    };
    expect(await tools.a!.execute!({}, { toolCallId: '1', messages: [] })).toBe(
      'from the new session',
    );
    expect(sawName).toBe('a');
  });
});

describe('managed connection — reconnect', () => {
  it('is off by default: a drop is terminal (1.x behavior)', async () => {
    const clock = makeFakeClock();
    const fake = makeFakeMcp();
    const managed = await createManagedConnection({
      ...factories([fake]),
      lifecycle: { clock },
    });
    expect(managed.status()).toBe('connected');

    fake.drop();
    await settle();
    expect(managed.status()).toBe('closed');
    expect(clock.pending()).toBe(0);
  });

  it('walks connecting → connected → reconnecting → connected with exponential backoff', async () => {
    const clock = makeFakeClock();
    const { seen, onStatusChange } = trackStatus();
    const fakes = [makeFakeMcp(), makeFakeMcp(), makeFakeMcp()];
    const managed = await createManagedConnection({
      ...factories(fakes),
      lifecycle: {
        clock,
        onStatusChange,
        // jitter 0 makes the delays exact; the spread has its own test below.
        reconnect: { jitter: 0, initialDelayMs: 500, factor: 2 },
      },
    });
    expect(managed.status()).toBe('connected');

    fakes[0]!.drop();
    expect(managed.status()).toBe('reconnecting');
    expect(clock.delays).toEqual([500]);

    await clock.fire();
    expect(managed.status()).toBe('connected');
    expect(managed.raw()).toBe(fakes[1]!.client);

    fakes[1]!.drop();
    // Each drop restarts the attempt counter — attempt 1 waits `initialDelayMs` again.
    expect(clock.delays).toEqual([500, 500]);
    await clock.fire();
    expect(managed.raw()).toBe(fakes[2]!.client);

    expect(seen).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
      ['reconnecting', 1],
      ['connected', undefined],
      ['reconnecting', 1],
      ['connected', undefined],
    ]);
  });

  it('re-marks the tool list dirty after a reconnect (the server may have moved)', async () => {
    const clock = makeFakeClock();
    const first = makeFakeMcp([{ name: 'a' }]);
    const second = makeFakeMcp([{ name: 'b' }]);
    const managed = await createManagedConnection({
      ...factories([first, second]),
      lifecycle: { clock, reconnect: true },
    });
    const client = wrapMcpClient(managed.raw(), managed);
    expect(Object.keys(await client.listTools())).toEqual(['a']);

    first.drop();
    await clock.fire();
    expect(Object.keys(await client.listTools())).toEqual(['b']);
  });

  it('grows the delay per attempt, caps it, and ends in error when attempts run out', async () => {
    const clock = makeFakeClock();
    const { seen, onStatusChange } = trackStatus();
    const fake = makeFakeMcp();
    const managed = await createManagedConnection({
      // Only one fake → every reconnect attempt is refused.
      ...factories([fake]),
      lifecycle: {
        clock,
        onStatusChange,
        reconnect: { jitter: 0, maxAttempts: 3, initialDelayMs: 100, factor: 3, maxDelayMs: 500 },
      },
    });

    fake.drop();
    expect(clock.delays).toEqual([100]);
    await clock.fire();
    expect(managed.status()).toBe('reconnecting');
    await clock.fire();
    // 100 → 300 → min(500, 900) = 500
    expect(clock.delays).toEqual([100, 300, 500]);
    await clock.fire();

    expect(managed.status()).toBe('error');
    expect(clock.pending()).toBe(0);
    expect(seen.map(([s]) => s)).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'error',
    ]);
  });

  it('carries the failure onto the error transition', async () => {
    const clock = makeFakeClock();
    let lastError: unknown;
    const fake = makeFakeMcp();
    await createManagedConnection({
      ...factories([fake]),
      lifecycle: {
        clock,
        reconnect: { jitter: 0, maxAttempts: 1 },
        onStatusChange: (status, info) => {
          if (status === 'error') lastError = info?.error;
        },
      },
    });
    fake.drop();
    await clock.fire();
    expect((lastError as Error).message).toBe('connect refused');
  });

  it('spreads the delay by ±jitter without touching Math.random', async () => {
    const clock = makeFakeClock();
    const fake = makeFakeMcp();
    await createManagedConnection({
      ...factories([fake]),
      // Default policy: 500ms base, 0.25 jitter → [375, 625].
      lifecycle: { clock, reconnect: true },
    });
    fake.drop();
    expect(clock.delays).toHaveLength(1);
    expect(clock.delays[0]).toBeGreaterThanOrEqual(375);
    expect(clock.delays[0]).toBeLessThanOrEqual(625);
  });

  it('does not retry the FIRST connect — it rejects like 1.x', async () => {
    await expect(
      createManagedConnection({
        ...factories([]),
        lifecycle: { clock: makeFakeClock(), reconnect: true },
      }),
    ).rejects.toThrow('connect refused');
  });

  it('a throwing onStatusChange never takes the connection down', async () => {
    const clock = makeFakeClock();
    const fakes = [makeFakeMcp(), makeFakeMcp()];
    const managed = await createManagedConnection({
      ...factories(fakes),
      lifecycle: {
        clock,
        reconnect: { jitter: 0 },
        onStatusChange: () => {
          throw new Error('observer blew up');
        },
      },
    });
    fakes[0]!.drop();
    await clock.fire();
    expect(managed.status()).toBe('connected');
  });
});

describe('managed connection — close', () => {
  it('is idempotent and silences reconnect + keepalive', async () => {
    const clock = makeFakeClock();
    const fake = makeFakeMcp();
    const managed = await createManagedConnection({
      ...factories([fake, makeFakeMcp()]),
      lifecycle: { clock, reconnect: true, keepAliveMs: 1000 },
    });
    expect(clock.pending()).toBe(1); // the keepalive timer

    await managed.close();
    expect(managed.status()).toBe('closed');
    expect(fake.closeCalls).toBe(1);
    expect(clock.pending()).toBe(0);

    await managed.close();
    expect(fake.closeCalls).toBe(1); // second call is a no-op

    // The SDK fires onclose as part of close() — that must not look like a drop.
    fake.drop();
    await settle();
    expect(managed.status()).toBe('closed');
    expect(clock.pending()).toBe(0);
  });

  it('lands mid-backoff: the pending retry is abandoned', async () => {
    const clock = makeFakeClock();
    const fakes = [makeFakeMcp(), makeFakeMcp()];
    const managed = await createManagedConnection({
      ...factories(fakes),
      lifecycle: { clock, reconnect: { jitter: 0 } },
    });
    fakes[0]!.drop();
    expect(managed.status()).toBe('reconnecting');

    await managed.close();
    await settle();
    expect(managed.status()).toBe('closed');
    expect(managed.raw()).toBe(fakes[0]!.client); // never swapped in the second
    expect(clock.pending()).toBe(0);
  });

  it('swallows a close() that the transport rejects', async () => {
    const fake = makeFakeMcp();
    fake.client.close = async () => {
      throw new Error('socket already gone');
    };
    const managed = await createManagedConnection({
      ...factories([fake]),
      lifecycle: { clock: makeFakeClock() },
    });
    await expect(managed.close()).resolves.toBeUndefined();
    expect(managed.status()).toBe('closed');
  });
});

describe('managed connection — keepalive', () => {
  it('chains pings while they succeed', async () => {
    const clock = makeFakeClock();
    const fake = makeFakeMcp();
    const managed = await createManagedConnection({
      ...factories([fake]),
      lifecycle: { clock, keepAliveMs: 1000 },
    });
    expect(clock.delays).toEqual([1000]);

    await clock.fire();
    expect(managed.status()).toBe('connected');
    expect(clock.delays).toEqual([1000, 1000]); // the next beat is scheduled
  });

  it('is off by default', async () => {
    const clock = makeFakeClock();
    await createManagedConnection({
      ...factories([makeFakeMcp()]),
      lifecycle: { clock },
    });
    expect(clock.pending()).toBe(0);
  });

  it('treats a rejected ping as a drop and reconnects', async () => {
    const clock = makeFakeClock();
    const fakes = [makeFakeMcp(), makeFakeMcp()];
    const managed = await createManagedConnection({
      ...factories(fakes),
      lifecycle: { clock, keepAliveMs: 1000, reconnect: { jitter: 0, initialDelayMs: 500 } },
    });
    fakes[0]!.pingRejects = true;

    await clock.fire(); // the ping fires and rejects
    expect(managed.status()).toBe('reconnecting');
    expect(clock.delays).toEqual([1000, 500]);

    await clock.fire(); // the backoff elapses
    expect(managed.status()).toBe('connected');
    expect(managed.raw()).toBe(fakes[1]!.client);
    // The heartbeat restarts on the new session, and only there.
    expect(clock.delays).toEqual([1000, 500, 1000]);
    expect(clock.pending()).toBe(1);
  });
});
