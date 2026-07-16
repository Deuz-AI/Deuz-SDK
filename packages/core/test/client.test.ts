import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index';
import { anthropic } from '../src/anthropic';
import { openaiEmbedding } from '../src/openai';
import type { JSONSchema } from '../src/types/schema';
import type { ToolExecuteContext } from '../src/types/tool';
import { sseResponse, sseEvents, mockFetch, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

/** Plain JSON Response (embeddings wire is not SSE). */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Anthropic json-mode SSE streaming the object text across the given deltas. */
function anthropicJsonStream(deltas: string[]): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    ...deltas.map((text) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
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

// --- Anthropic tool-loop fixtures (same shape as tool-loop.test.ts) ---
const ANTHROPIC_TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'getWeather' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
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
const ANTHROPIC_FINAL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Sunny in Paris.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('createClient parity (1.6): streamObject / embed / embedMany', () => {
  it('client.embed routes the client-level apiKey via clientContext (G1 lowest precedence)', async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        data: [{ index: 0, embedding: [1, 2, 3] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    );
    // No keyProvider, no factory key — the ClientConfig.apiKeys table is the
    // only (and lowest-precedence) source.
    const client = createClient({ apiKeys: { openai: 'sk-client-table' }, deps: { fetch } });

    const { embedding, usage } = await client.embed({
      model: openaiEmbedding('text-embedding-3-small'),
      value: 'hello',
    });

    expect(embedding).toEqual([1, 2, 3]);
    expect(usage.inputTokens).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-client-table');
  });

  it('client.embedMany routes the same client context (key + shared fetch)', async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1] },
          { index: 1, embedding: [2] },
        ],
        usage: { total_tokens: 2 },
      }),
    );
    const client = createClient({ apiKeys: { openai: 'sk-client-table' }, deps: { fetch } });

    const { embeddings } = await client.embedMany({
      model: openaiEmbedding('text-embedding-3-small'),
      values: ['a', 'b'],
    });

    expect(embeddings).toEqual([[1], [2]]);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-client-table');
  });

  it('client.streamObject returns synchronously (G2) and streams end-to-end with the client key (G1)', async () => {
    const { fetch, calls } = mockFetch(() =>
      sseResponse([anthropicJsonStream(['{"city":', '"Paris"}'])]),
    );
    const client = createClient({ apiKeys: { anthropic: 'sk-client-table' }, deps: { fetch } });

    const result = client.streamObject({
      model: anthropic('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'capital of France?' }],
      schema: SCHEMA,
    });

    // Synchronous return, lazy pump: nothing on the wire yet.
    expect(calls).toHaveLength(0);
    expect(typeof result.partialObjectStream[Symbol.asyncIterator]).toBe('function');

    const partials: unknown[] = [];
    for await (const p of result.partialObjectStream) partials.push(p);
    expect(partials).toEqual([{}, { city: 'Paris' }]);
    expect(await result.object).toEqual({ city: 'Paris' });
    expect((await result.usage).totalTokens).toBeGreaterThan(0);

    // The client-level apiKey rode the wire (clientContext, G1).
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-client-table');
  });

  it('shared circuit-breaker store is resolved ONCE per client, not per call (G11)', async () => {
    const seen: unknown[] = [];
    const weather = vi.fn(async (_args: unknown, ctx: ToolExecuteContext) => {
      seen.push(ctx.deps?.breakerStore);
      return { temp: 22 };
    });
    const { fetch } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const client = createClient({ apiKeys: { anthropic: 'k' }, deps: { fetch } });
    const call = () =>
      client.generateText({
        model: anthropic('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'weather?' }],
        tools: { getWeather: { parameters: SCHEMA, execute: weather } },
        maxSteps: 5,
      });

    await call();
    await call();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    // Same instance across two separate client calls — resolved once (G11).
    expect(seen[1]).toBe(seen[0]);
  });
});
