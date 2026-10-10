import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../src/adapters/anthropic';
import { googleNativeAdapter } from '../src/adapters/google-native';
import { openaiCompatibleAdapter } from '../src/adapters/openai-compatible';
import { openaiResponsesAdapter } from '../src/adapters/openai-responses';
import type { Adapter } from '../src/adapters/types';
import type { ModelCapabilities } from '../src/core/registry';
import { priceUsage } from '../src/pricing';
import type { Usage } from '../src/types/usage';
import { sseEvents } from './fixtures/sse';

// F02 / F18 (2.3): every adapter normalizes to one usage contract —
// outputTokens includes reasoning, reasoningTokens is a subset of it,
// inputTokens excludes cache reads, audioTokens is a subset of the prompt and
// completion buckets — so priceUsage bills each token exactly once.

/** One illustrative tariff for every fixture (USD / 1M tokens). */
const TARIFF = { m: { input: 2, output: 10, cachedRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 } };

function body(events: { event?: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sseEvents(events));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function finishUsage(
  adapter: Adapter,
  events: { event?: string; data: unknown }[],
): Promise<Usage> {
  const ctx = { provider: 'test', generateId: () => 'id', caps: {} as ModelCapabilities };
  for await (const part of adapter.parseStream(body(events), ctx)) {
    if (part.type === 'finish') {
      // The contract every adapter must honor, whatever the provider's buckets.
      expect(part.usage.reasoningTokens).toBeLessThanOrEqual(part.usage.outputTokens);
      return part.usage;
    }
  }
  throw new Error('stream ended without a finish part');
}

function price(usage: Usage): number | undefined {
  return priceUsage('m', usage, TARIFF);
}

describe('usage contract: OpenAI Responses', () => {
  it('prices reasoning once — the 2.2.0 repro costs $0.0102, not $0.0182', async () => {
    const usage = await finishUsage(openaiResponsesAdapter, [
      {
        data: {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 1000,
              output_tokens_details: { reasoning_tokens: 800 },
              total_tokens: 1100,
            },
          },
        },
      },
    ]);
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 1000,
      reasoningTokens: 800,
      totalTokens: 1100,
    });
    expect(priceUsage('m', usage, { m: { input: 2, output: 10 } })).toBe(0.0102);
  });

  it('splits cached reads out of input_tokens and keeps reasoning inside output', async () => {
    const usage = await finishUsage(openaiResponsesAdapter, [
      {
        data: {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 400 },
              output_tokens: 1000,
              output_tokens_details: { reasoning_tokens: 800 },
              total_tokens: 2000,
            },
          },
        },
      },
    ]);
    expect(usage).toEqual({
      inputTokens: 600,
      outputTokens: 1000,
      reasoningTokens: 800,
      cachedReadTokens: 400,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 2000,
    });
    expect(price(usage)).toBe(0.01128); // 600 × 2 + 400 × 0.2 + 1000 × 10 micro-dollars
  });
});

describe('usage contract: OpenAI-compatible Chat Completions', () => {
  const chat = (usage: Record<string, unknown>) => [
    { data: { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage } },
    { data: '[DONE]' },
  ];

  it('treats completion_tokens as inclusive of reasoning (OpenAI semantics)', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens: 1000,
        completion_tokens_details: { reasoning_tokens: 800 },
        total_tokens: 2000,
      }),
    );
    expect(usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 1000,
      reasoningTokens: 800,
      cachedReadTokens: 400,
      totalTokens: 2000,
    });
    expect(price(usage)).toBe(0.01128);
  });

  it('keeps audio inside the prompt and completion buckets instead of billing it again', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 1000,
        prompt_tokens_details: { audio_tokens: 300 },
        completion_tokens: 500,
        completion_tokens_details: { audio_tokens: 200 },
        total_tokens: 1500,
      }),
    );
    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, audioTokens: 500 });
    expect(price(usage)).toBe(0.007); // 1000 × 2 + 500 × 10
  });

  it('reads DeepSeek prompt_cache_hit_tokens as cached reads', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 400,
        prompt_cache_miss_tokens: 600,
        completion_tokens: 1000,
        completion_tokens_details: { reasoning_tokens: 800 },
        total_tokens: 2000,
      }),
    );
    expect(usage).toMatchObject({ inputTokens: 600, cachedReadTokens: 400, outputTokens: 1000 });
    expect(price(usage)).toBe(0.01128);
  });

  it('reads a top-level cached_tokens counter (Moonshot shape) as cached reads', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 1000,
        cached_tokens: 400,
        completion_tokens: 1000,
        total_tokens: 2000,
      }),
    );
    expect(usage).toMatchObject({ inputTokens: 600, cachedReadTokens: 400 });
    expect(price(usage)).toBe(0.01128);
  });

  it('does not count one cache hit twice when a host reports it in two fields', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 400 },
        prompt_cache_hit_tokens: 400,
        completion_tokens: 10,
        total_tokens: 1010,
      }),
    );
    expect(usage).toMatchObject({ inputTokens: 600, cachedReadTokens: 400 });
  });

  it('folds reasoning into output when the total shows it was reported separately (xAI shape)', async () => {
    // total 135 = prompt 32 + completion 9 + reasoning 94: completion excludes reasoning.
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 32,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 94 },
        total_tokens: 135,
      }),
    );
    expect(usage).toMatchObject({
      inputTokens: 26,
      cachedReadTokens: 6,
      outputTokens: 103,
      reasoningTokens: 94,
      totalTokens: 135,
    });
    expect(price(usage)).toBe(0.001083); // 26 × 2 + 6 × 0.2 + 103 × 10, rounded
  });

  it('folds reasoning into output when it exceeds the completion count and no total is sent', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 10,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 94 },
      }),
    );
    expect(usage).toMatchObject({ outputTokens: 103, reasoningTokens: 94, totalTokens: 113 });
  });

  it('leaves an inclusive count alone when the total matches prompt + completion', async () => {
    const usage = await finishUsage(
      openaiCompatibleAdapter,
      chat({
        prompt_tokens: 10,
        completion_tokens: 100,
        completion_tokens_details: { reasoning_tokens: 80 },
        total_tokens: 110,
      }),
    );
    expect(usage).toMatchObject({ outputTokens: 100, reasoningTokens: 80, totalTokens: 110 });
  });
});

describe('usage contract: Anthropic Messages', () => {
  it('does not add the thinking_tokens detail on top of output_tokens', async () => {
    const usage = await finishUsage(anthropicAdapter, [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 600,
              cache_read_input_tokens: 400,
              cache_creation_input_tokens: 300,
              cache_creation: { ephemeral_1h_input_tokens: 100 },
              output_tokens: 1,
            },
          },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1000, output_tokens_details: { thinking_tokens: 800 } },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    expect(usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 1000,
      reasoningTokens: 800,
      cachedReadTokens: 400,
      cacheWriteTokens: 200,
      cacheWrite1hTokens: 100,
    });
    expect(price(usage)).toBe(0.01218); // 600 × 2 + 400 × 0.2 + 200 × 2.5 + 100 × 4 + 1000 × 10
  });

  it('prices a turn without the thinking detail the same way', async () => {
    const usage = await finishUsage(anthropicAdapter, [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { usage: { input_tokens: 600, cache_read_input_tokens: 400, output_tokens: 1 } },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1000 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    expect(price(usage)).toBe(0.01128);
  });
});

describe('usage contract: Gemini native', () => {
  const gemini = (usageMetadata: Record<string, unknown>) => [
    {
      data: {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata,
      },
    },
  ];

  it('reports thoughts inside outputTokens (candidates + thoughts)', async () => {
    const usage = await finishUsage(
      googleNativeAdapter,
      gemini({
        promptTokenCount: 1000,
        cachedContentTokenCount: 400,
        candidatesTokenCount: 200,
        thoughtsTokenCount: 800,
        totalTokenCount: 2000,
      }),
    );
    expect(usage).toMatchObject({
      inputTokens: 600,
      cachedReadTokens: 400,
      outputTokens: 1000,
      reasoningTokens: 800,
      totalTokens: 2000,
    });
    expect(price(usage)).toBe(0.01128);
  });

  it('counts thoughts in the total when totalTokenCount is missing', async () => {
    const usage = await finishUsage(
      googleNativeAdapter,
      gemini({ promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 800 }),
    );
    expect(usage.totalTokens).toBe(2000);
  });

  it('keeps AUDIO modality tokens inside the prompt instead of billing them again', async () => {
    const usage = await finishUsage(
      googleNativeAdapter,
      gemini({
        promptTokenCount: 1000,
        promptTokensDetails: [
          { modality: 'AUDIO', tokenCount: 300 },
          { modality: 'TEXT', tokenCount: 700 },
        ],
        candidatesTokenCount: 200,
        totalTokenCount: 1200,
      }),
    );
    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, audioTokens: 300 });
    expect(price(usage)).toBe(0.004); // 1000 × 2 + 200 × 10
  });
});
