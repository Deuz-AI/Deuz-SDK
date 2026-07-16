import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { durationExceeds } from '../src/inference/stop';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import type { Clock } from '../src/types/deps';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

/** Tool-calling turn (usage 15). Repeats forever via mockFetchSequence. */
const TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
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

/**
 * Deterministic manual clock: time moves ONLY via `advance` (called from the
 * mock tool). Timers never fire — nothing on the mocked path needs them, and
 * an immediately-firing timer would trip the ttft/total timeout aborts.
 */
function manualClock(): { clock: Clock; advance: (ms: number) => void } {
  let t = 0;
  return {
    clock: { now: () => t, setTimeout: () => () => {} },
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('durationExceeds (generateText)', () => {
  it('stops the loop once elapsed clock time passes the threshold; marks stoppedBy', async () => {
    const { clock, advance } = manualClock();
    // Each tool run "takes" 6s of injected-clock time.
    const search = vi.fn(async () => {
      advance(6000);
      return 'result';
    });
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { search: { description: 'Search', parameters: SCHEMA, execute: search } },
      maxSteps: 10,
      stopWhen: durationExceeds(5000), // step 1 ends at t=6000 ≥ 5000 → stop
      deps: { clock },
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // stopped after step 1 — 9 budgeted steps unused
    expect(res.steps).toHaveLength(1);
    expect(res.finishReason).toBe('tool_calls'); // FinishReason lock: no invented reason
    expect(res.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'durationExceeds' });
  });

  it('stays inert below the threshold — loop runs to the maxSteps bound, no stoppedBy', async () => {
    const { clock, advance } = manualClock();
    const search = vi.fn(async () => {
      advance(1000);
      return 'result';
    });
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { search: { description: 'Search', parameters: SCHEMA, execute: search } },
      maxSteps: 2,
      stopWhen: durationExceeds(60_000), // 2 steps × 1s — never reached
      deps: { clock },
    });

    expect(calls).toHaveLength(2);
    expect(res.providerMetadata).toBeUndefined(); // implicit maxSteps bound is never reported
  });
});

describe('durationExceeds (streamChat parity)', () => {
  it('finish part carries providerMetadata.deuz.stoppedBy === "durationExceeds"', async () => {
    const { clock, advance } = manualClock();
    const search = vi.fn(async () => {
      advance(6000);
      return 'result';
    });
    const { fetch, calls } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { search: { description: 'Search', parameters: SCHEMA, execute: search } },
      maxSteps: 10,
      stopWhen: durationExceeds(5000),
      deps: { clock },
    });

    let finishMeta: Record<string, unknown> | undefined;
    for await (const part of res.fullStream) {
      if (part.type === 'finish') finishMeta = part.providerMetadata;
    }

    expect(search).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(finishMeta?.deuz).toMatchObject({ stoppedBy: 'durationExceeds' });
  });
});
