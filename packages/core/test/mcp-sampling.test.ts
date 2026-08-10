/**
 * `sampling/createMessage` END TO END — the direction where the SERVER calls US.
 *
 * `test/mcp-sampling-unit.test.ts` pins the pure mappers in isolation; this file
 * proves the same contract over the real thing: a real `node:http` listener, the
 * real `@modelcontextprotocol/sdk` server transport, real SSE framing, our real
 * `createMcpClient`, and our real `generateText` pump driving a scripted
 * `createMockModel`. Nothing between the server's `sampling/createMessage` and
 * the provider wire is faked, so the assertions cover the whole round trip:
 *
 *   server params → canonical Message[] → provider request body
 *   provider SSE  → generateText result → MCP `CreateMessageResult`
 *
 * Two recorders make that visible without touching `src/`:
 *
 * - `scriptedModel()` wraps the mock model's OWN factory `fetch` (G1: a factory
 *   fetch wins over `deps.fetch`), so every provider request body is captured
 *   while `createMockModel` still synthesizes the response.
 * - `recordHttp()` swaps `globalThis.fetch`, which is what the SDK's
 *   `StreamableHTTPClientTransport` reaches for — the only way to read the
 *   `initialize` params, i.e. the capabilities we actually declared.
 *
 * Every server and client is torn down in `afterEach`; the fetch swap is undone
 * there too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMcpClient, type McpRootsClient, type McpSamplingRequest } from '../src/mcp';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { LanguageModel } from '../src/types/model';
import {
  startTestMcpServer,
  type TestMcpServerHandle,
  type TestMcpServerOptions,
} from './helpers/mcp-http-server';

// ===================================================================
// Harness plumbing
// ===================================================================

const servers: TestMcpServerHandle[] = [];
const clients: McpRootsClient[] = [];
let realFetch: typeof fetch | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      // A test may have closed it already, or killed the server under it.
    }
  }
  for (const server of servers.splice(0)) await server.close();
  if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = undefined;
  }
});

/** A tool-less server: sampling needs no catalog, and an empty one is one less variable. */
async function startServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServerHandle> {
  const server = await startTestMcpServer({ tools: [], ...opts });
  servers.push(server);
  return server;
}

/**
 * Connect and wait for the standalone GET SSE stream. Server→client requests
 * only exist once that stream is live, so every sampling test must await it.
 */
async function connect(
  server: TestMcpServerHandle,
  options: Omit<Parameters<typeof createMcpClient>[0], 'transport'> = {},
): Promise<McpRootsClient> {
  const client = await createMcpClient({
    transport: { type: 'http', url: server.url },
    ...options,
  });
  clients.push(client);
  await server.waitForClientStream();
  return client;
}

/** One recorded provider request body. */
type WireRequest = Record<string, unknown>;

/**
 * A `createMockModel` whose factory `fetch` is wrapped so the outgoing provider
 * request body is recorded. The descriptor is rebuilt (its config Symbol is
 * non-writable by design) with the same config plus the recording fetch.
 */
function scriptedModel(responses: MockResponse[]): {
  model: LanguageModel;
  requests: WireRequest[];
} {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const inner = config.fetch!;
  const requests: WireRequest[] = [];
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as WireRequest);
    return inner(input, init);
  }) as typeof fetch;

  const model: LanguageModel = {
    provider: base.provider,
    modelId: base.modelId,
    surface: base.surface,
  };
  return { model: attachConfig(model, { ...config, fetch: recording }), requests };
}

/** Record every JSON-RPC body the MCP transport POSTs (see the file header). */
function recordHttp(): string[] {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  realFetch = original;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    return original(input, init);
  }) as typeof fetch;
  return bodies;
}

/** `capabilities` from every `initialize` request, in connection order. */
function declaredCapabilities(bodies: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of bodies) {
    const msg = JSON.parse(raw) as {
      method?: string;
      params?: { capabilities?: Record<string, unknown> };
    };
    if (msg.method === 'initialize') out.push(msg.params?.capabilities ?? {});
  }
  return out;
}

const USER = (text: string) => ({ role: 'user' as const, content: { type: 'text', text } });

// ===================================================================
// The round trip
// ===================================================================

describe('sampling over a real MCP server', () => {
  it('runs our model for the server and answers in MCP shape', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'four' }]);
    await connect(server, { sampling: { model } });

    const result = await server.requestSampling({
      messages: [
        USER('what is 2+2?'),
        { role: 'assistant', content: { type: 'text', text: 'let me think' } },
        USER('go on'),
      ],
      systemPrompt: 'Be terse.',
      maxTokens: 256,
      temperature: 0.2,
      stopSequences: ['\n\n'],
      modelPreferences: { hints: [{ name: 'claude' }] },
    });

    // ← direction: our text + finish reason, in MCP's own result shape.
    expect(result).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'four' },
      model: 'mock-model',
      stopReason: 'endTurn',
    });

    // → direction: MCP params, canonicalized, on the provider wire.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'mock-model',
      messages: [
        // MCP has no system role — `systemPrompt` becomes the leading system turn.
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'what is 2+2?' },
        { role: 'assistant', content: 'let me think' },
        { role: 'user', content: 'go on' },
      ],
      max_tokens: 256,
      temperature: 0.2,
      stop: ['\n\n'],
    });
    // modelPreferences are hints only: the configured model always wins.
    expect(requests[0]!.model).toBe('mock-model');
  });

  it('carries an MCP image block onto the wire as a data: URL', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'a cat' }]);
    await connect(server, { sampling: { model } });

    await server.requestSampling({
      messages: [{ role: 'user', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } }],
      maxTokens: 64,
    });

    expect(requests[0]!.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }],
      },
    ]);
  });

  it('clamps the server ask to the configured ceiling and never raises it', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'ok' }]);
    await connect(server, { sampling: { model, maxTokens: 100 } });

    await server.requestSampling({ messages: [USER('big')], maxTokens: 5_000 });
    await server.requestSampling({ messages: [USER('small')], maxTokens: 32 });

    expect(requests.map((r) => r.max_tokens)).toEqual([100, 32]);
  });

  it('honours the server ask verbatim when no ceiling is configured', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'ok' }]);
    await connect(server, { sampling: { model } });

    await server.requestSampling({ messages: [USER('big')], maxTokens: 5_000 });

    expect(requests[0]!.max_tokens).toBe(5_000);
  });

  it('maps the finish reason onto the MCP stopReason, flooring the unknown ones', async () => {
    const server = await startServer();
    const { model } = scriptedModel([
      { text: 'cut off', finishReason: 'length' },
      { text: 'filtered', finishReason: 'content_filter' },
      { text: 'done', finishReason: 'stop' },
    ]);
    await connect(server, { sampling: { model } });

    const stopReasons: unknown[] = [];
    for (const _ of [0, 1, 2]) {
      const result = (await server.requestSampling({
        messages: [USER('go')],
        maxTokens: 16,
      })) as { stopReason: string };
      stopReasons.push(result.stopReason);
    }
    // MCP names three outcomes; `content_filter` has no vocabulary there.
    expect(stopReasons).toEqual(['maxTokens', 'endTurn', 'endTurn']);
  });
});

// ===================================================================
// approve — the HITL gate, over the wire
// ===================================================================

describe('sampling approval over a real MCP server', () => {
  it('gates on the canonical request with the clamped cap, before any provider call', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'allowed' }]);
    const seen: McpSamplingRequest[] = [];
    await connect(server, {
      sampling: {
        model,
        maxTokens: 200,
        approve: (req) => {
          seen.push(req);
          return true;
        },
      },
    });

    await server.requestSampling({
      messages: [USER('ping')],
      systemPrompt: 'sys',
      maxTokens: 900,
      temperature: 0.5,
      stopSequences: ['x'],
      modelPreferences: { costPriority: 1 },
    });

    expect(seen).toEqual([
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        systemPrompt: 'sys',
        maxTokens: 200,
        temperature: 0.5,
        stopSequences: ['x'],
        modelPreferences: { costPriority: 1 },
      },
    ]);
    expect(requests).toHaveLength(1);
  });

  it('turns a refusal into a JSON-RPC error for the server and never calls the model', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'never sent' }]);
    await connect(server, { sampling: { model, approve: () => false } });

    await expect(
      server.requestSampling({ messages: [USER('ping')], maxTokens: 16 }),
    ).rejects.toThrow(/MCP error -32603:.*declined by the client/);
    expect(requests).toHaveLength(0);
  });

  it('propagates a thrown approve verbatim as the JSON-RPC error message', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'never sent' }]);
    await connect(server, {
      sampling: {
        model,
        approve: async () => {
          throw new Error('no consent recorded');
        },
      },
    });

    await expect(
      server.requestSampling({ messages: [USER('ping')], maxTokens: 16 }),
    ).rejects.toThrow(/no consent recorded/);
    expect(requests).toHaveLength(0);
  });

  it('keeps serving the next request after a refusal (the session survives)', async () => {
    const server = await startServer();
    const { model, requests } = scriptedModel([{ text: 'second time lucky' }]);
    let allow = false;
    await connect(server, { sampling: { model, approve: () => allow } });

    await expect(
      server.requestSampling({ messages: [USER('ping')], maxTokens: 16 }),
    ).rejects.toThrow(/declined by the client/);

    allow = true;
    const result = (await server.requestSampling({
      messages: [USER('ping again')],
      maxTokens: 16,
    })) as { content: { text: string } };

    expect(result.content.text).toBe('second time lucky');
    expect(requests).toHaveLength(1);
  });
});

// ===================================================================
// Capability declaration — read off the real `initialize` params
// ===================================================================

describe('sampling capability declaration', () => {
  it('declares `sampling` only when the option is configured', async () => {
    const bodies = recordHttp();
    const plain = await startServer();
    const sampled = await startServer();
    const { model } = scriptedModel([{ text: 'ok' }]);

    await connect(plain, {});
    await connect(sampled, { sampling: { model } });

    // Declaring a capability we cannot serve would lie to the server, so the
    // first handshake advertises nothing at all.
    expect(declaredCapabilities(bodies)).toEqual([{}, { sampling: {} }]);
  });

  it('leaves the server unable to sample a client that declared nothing', async () => {
    const server = await startServer();
    await connect(server, {});

    // No capability AND no registered handler: the undeclared method is refused
    // with JSON-RPC -32601 rather than silently answered.
    await expect(
      server.requestSampling({ messages: [USER('ping')], maxTokens: 16 }),
    ).rejects.toThrow(/MCP error -32601: Method not found/);
  });

  it('does not declare sampling when only an unrelated handler is configured', async () => {
    const bodies = recordHttp();
    const server = await startServer();

    await connect(server, { onElicitationRequest: () => ({ action: 'decline' }) });

    expect(declaredCapabilities(bodies)).toEqual([{ elicitation: { form: {}, url: {} } }]);
    await expect(
      server.requestSampling({ messages: [USER('ping')], maxTokens: 16 }),
    ).rejects.toThrow(/MCP error -32601: Method not found/);
  });
});
