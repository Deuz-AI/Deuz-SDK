/**
 * usage-iterations.test.ts (2.3) — Anthropic usage that carries `iterations`.
 *
 * Server-side fallbacks, compaction and server tool loops report per-attempt
 * token counters in `usage.iterations`, and the adapter sums them. The entries
 * carry token counters only (@anthropic-ai/sdk 0.133.0, `BetaIterationsUsage`):
 * the server tool request counts (`server_tool_use`) and the thinking-token
 * detail (`output_tokens_details`) are reported at the top level alone. The sum
 * used to drop both, so a response with iterations reported no server tool uses
 * and no reasoning share. Shapes from the SDK types; not live-verified.
 */
import { describe, expect, it } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

/** One answer whose final `message_delta` usage is `usage`. */
function streamWithUsage(usage: Record<string, unknown>): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function claude(usage: Record<string, unknown>) {
  const { fetch } = mockFetch(() => sseResponse([streamWithUsage(usage)]));
  return createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5');
}

const ITERATIONS = [
  { type: 'compaction', input_tokens: 900, output_tokens: 100 },
  { type: 'message', input_tokens: 40, output_tokens: 30 },
];

describe('Anthropic usage with iterations', () => {
  it('keeps the server tool requests reported at the top level', async () => {
    const result = streamChat({
      model: claude({
        output_tokens: 30,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
        iterations: ITERATIONS,
      }),
      prompt: 'Search twice.',
    });
    const usage = await result.usage;
    expect(usage.serverToolUses).toBe(2);
    // The token counters are still the sum of the iterations.
    expect(usage).toMatchObject({ inputTokens: 940, outputTokens: 130, totalTokens: 1070 });
  });

  it('keeps the thinking-token share reported at the top level', async () => {
    const result = streamChat({
      model: claude({
        output_tokens: 30,
        output_tokens_details: { thinking_tokens: 12 },
        iterations: ITERATIONS,
      }),
      prompt: 'Think.',
    });
    const usage = await result.usage;
    expect(usage.reasoningTokens).toBe(12);
    expect(usage.outputTokens).toBe(130);
  });

  it('never reports a reasoning share above the summed output', async () => {
    const result = streamChat({
      model: claude({
        output_tokens: 30,
        output_tokens_details: { thinking_tokens: 500 },
        iterations: [{ type: 'message', input_tokens: 40, output_tokens: 30 }],
      }),
      prompt: 'Think.',
    });
    expect((await result.usage).reasoningTokens).toBe(30);
  });

  it('hands the server tool requests to a priceProvider that bills per call', async () => {
    const result = streamChat({
      model: claude({
        output_tokens: 30,
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
        iterations: ITERATIONS,
      }),
      prompt: 'Search three times.',
      deps: { priceProvider: { priceUsage: (_id, usage) => (usage.serverToolUses ?? 0) * 0.01 } },
    });
    let cost: number | undefined;
    for await (const part of result.fullStream) if (part.type === 'cost') cost = part.costUsd;
    expect(cost).toBe(0.03);
  });
});
