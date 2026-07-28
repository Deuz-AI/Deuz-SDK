import { describe, it, expect, vi } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createInMemoryChatStore } from '../src/chat';
import type { Usage } from '../src/types/usage';
import type { JSONSchema } from '../src/types/schema';
import type { UsageMeta, FinishMeta } from '../src/types/deps';
import { sseResponse, sseEvents, mockFetch, mockFetchSequence } from './fixtures/sse';

const STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

/** Two-step agentic fixtures: a tool call, then the final answer. */
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
const FINAL = sseEvents([
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sunny.' } },
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

const CITY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) void _;
  })();
}

describe('metering', () => {
  it('fires onUsage exactly once with reason "finished" + ttftMs', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    let calls = 0;
    let usage: Usage | undefined;
    let meta: UsageMeta | undefined;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      onUsage: (u, m) => {
        calls++;
        usage = u;
        meta = m;
      },
    });
    await drain(result.fullStream);
    expect(calls).toBe(1);
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(meta).toMatchObject({ model: 'claude-opus-4-8', reason: 'finished' });
    expect(typeof meta!.ttftMs).toBe('number');
    expect(meta!.ttftMs!).toBeGreaterThanOrEqual(0);
  });

  it('call-level onUsage overrides deps.onUsage — never both (G10)', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    let optCalls = 0;
    let depsCalls = 0;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      onUsage: () => {
        optCalls++;
      },
      deps: {
        onUsage: () => {
          depsCalls++;
        },
      },
    });
    await drain(result.fullStream);
    expect(optCalls).toBe(1);
    expect(depsCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1.9 (G12): `onFinish` is the RUN's terminal callback. A loop-routed call used
// to fire it once per STEP inside the pump AND once more for the loop itself, so
// anything billing or persisting on it double-counted. The pump is now silent
// whenever a loop owns the call; the run's owner fires exactly one event, with
// the finishReason of the whole run.
// ---------------------------------------------------------------------------

describe('onFinish fires exactly once per run (G12)', () => {
  const tools = { getWeather: { parameters: CITY_SCHEMA, execute: () => ({ temp: 22 }) } };

  it('a loop-routed streamChat (2 steps) fires onFinish ONCE with the run finishReason', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const onFinish = vi.fn<(meta: FinishMeta) => void>();
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      maxSteps: 5,
      onFinish,
    });
    await drain(result.fullStream);
    expect(calls).toHaveLength(2); // two model calls really happened
    expect(onFinish).toHaveBeenCalledTimes(1);
    // The RUN's reason, not the tool step's 'tool_calls'.
    expect(onFinish.mock.calls[0]![0]).toEqual({
      model: 'claude-opus-4-8',
      finishReason: 'stop',
    });
  });

  it('a tool-less call routed through the loop by `chat` also fires ONCE', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    const onFinish = vi.fn();
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      chat: { store: createInMemoryChatStore(), chatId: 'c1', scope: { userId: 'u1' } },
      onFinish,
    });
    await drain(result.fullStream);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('a single-turn streamChat still fires onFinish exactly once', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    const onFinish = vi.fn<(meta: FinishMeta) => void>();
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      onFinish,
    });
    await drain(result.fullStream);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]![0]).toEqual({
      model: 'claude-opus-4-8',
      finishReason: 'stop',
    });
  });

  it('the buffered loop (generateText + tools, 2 steps) fires onFinish ONCE', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const onFinish = vi.fn<(meta: FinishMeta) => void>();
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      maxSteps: 5,
      onFinish,
    });
    expect(calls).toHaveLength(2);
    expect(result.steps).toHaveLength(2);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]![0]).toEqual({
      model: 'claude-opus-4-8',
      finishReason: 'stop',
    });
  });

  it('a single-turn generateText still fires onFinish exactly once (deps-level too)', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    const onFinish = vi.fn();
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { onFinish },
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('onUsage stays PER MODEL CALL in a loop (2 steps → 2 events)', async () => {
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const onUsage = vi.fn<(usage: Usage, meta: UsageMeta) => void>();
    const onFinish = vi.fn();
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      maxSteps: 5,
      onUsage,
      onFinish,
    });
    await drain(result.fullStream);
    // Deliberate asymmetry (G12): UsageMeta is per-call (ttftMs), so collapsing
    // it to one event per run would under-report a multi-step agent's tokens.
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
