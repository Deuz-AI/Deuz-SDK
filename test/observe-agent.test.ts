/**
 * Observation E2E for the agentic loops: buffered (generateText) and
 * streaming (streamChat) must produce the SAME event semantics for the same
 * fixture. Golden-replay via injected fetch, deterministic mock streams.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, ObserveEvent, JSONSchema } from '../src/index';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

function fastClock(): Clock {
  let now = 0;
  return {
    now: () => (now += 5),
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const TOOL_CALL_STREAM = sseEvents([
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

const FINAL_STREAM = sseEvents([
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
      delta: { type: 'text_delta', text: 'Sunny.' },
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

/** The canonical 2-step tool-loop event order (§26). */
const TWO_STEP_ORDER = [
  'run.started',
  'step.started',
  'model.started',
  'model.first-content',
  'model.completed',
  'tool.started',
  'tool.completed',
  'step.completed',
  'step.started',
  'model.started',
  'model.first-content',
  'model.completed',
  'step.completed',
  'run.completed',
];

function weatherTools(): NonNullable<Parameters<typeof generateText>[0]['tools']> {
  return {
    getWeather: {
      description: 'Get weather',
      parameters: SCHEMA,
      execute: async (args: unknown) => ({ city: (args as { city: string }).city, temp: 22 }),
    },
  };
}

async function runBuffered(): Promise<ObserveEvent[]> {
  const mem = createMemoryObserver();
  const { fetch } = mockFetchSequence([
    () => sseResponse([TOOL_CALL_STREAM]),
    () => sseResponse([FINAL_STREAM]),
  ]);
  await generateText({
    model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: weatherTools(),
    maxSteps: 5,
    deps: { observer: mem, clock: fastClock() },
  });
  return [...mem.events()];
}

async function runStreaming(): Promise<ObserveEvent[]> {
  const mem = createMemoryObserver();
  const { fetch } = mockFetchSequence([
    () => sseResponse([TOOL_CALL_STREAM]),
    () => sseResponse([FINAL_STREAM]),
  ]);
  const result = streamChat({
    model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
    messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: weatherTools(),
    maxSteps: 5,
    deps: { observer: mem, clock: fastClock() },
  });
  await result.usage;
  return [...mem.events()];
}

describe('agentic loop observation — buffered/streaming parity', () => {
  it('buffered loop emits the canonical 2-step order', async () => {
    const events = await runBuffered();
    expect(events.map((e) => e.type)).toEqual(TWO_STEP_ORDER);
    const started = events[0] as Ev<'run.started'>;
    expect(started.operation).toBe('generate-text');
    expect(started.toolCount).toBe(1);
  });

  it('streaming loop emits the SAME semantic order (operation differs only)', async () => {
    const buffered = await runBuffered();
    const streaming = await runStreaming();
    expect(streaming.map((e) => e.type)).toEqual(buffered.map((e) => e.type));
    expect((streaming[0] as Ev<'run.started'>).operation).toBe('stream-chat');
    // same step indexing scheme
    const bSteps = buffered.filter((e) => e.type === 'step.started').map((e) => e.stepIndex);
    const sSteps = streaming.filter((e) => e.type === 'step.started').map((e) => e.stepIndex);
    expect(bSteps).toEqual([0, 1]);
    expect(sSteps).toEqual([0, 1]);
  });

  it('the loop owns the run: inner per-step pumps never emit a second run.started', async () => {
    const events = await runStreaming();
    expect(events.filter((e) => e.type === 'run.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.completed')).toHaveLength(1);
  });

  it('span hierarchy: model+tool events parent under their step span, steps under the run', async () => {
    const events = await runBuffered();
    const run = events[0] as Ev<'run.started'>;
    const step0 = events[1] as Ev<'step.started'>;
    const model0 = events[2] as Ev<'model.started'>;
    const tool0 = events.find((e) => e.type === 'tool.started') as Ev<'tool.started'>;
    expect(step0.parentSpanId).toBe(run.spanId);
    expect(model0.parentSpanId).toBe(step0.spanId);
    expect(tool0.parentSpanId).toBe(step0.spanId);
    expect(model0.stepIndex).toBe(0);
    expect(tool0.stepIndex).toBe(0);
  });

  it('step.completed carries per-step + cumulative usage; run.completed carries counters', async () => {
    const events = await runBuffered();
    const stepDone = events.filter((e) => e.type === 'step.completed') as Ev<'step.completed'>[];
    expect(stepDone[0]!.toolCallCount).toBe(1);
    expect(stepDone[0]!.usage.totalTokens).toBe(15); // step 1: in 10 + out 5 (delta replaces)
    expect(stepDone[1]!.cumulativeUsage.totalTokens).toBe(41); // 15 + 26
    const done = events.at(-1) as Ev<'run.completed'>;
    expect(done).toMatchObject({
      endReason: 'natural',
      stepCount: 2,
      modelCallCount: 2,
      toolCallCount: 1,
      toolErrorCount: 0,
    });
    expect(done.usage.totalTokens).toBe(41);
    expect(done.finishReason).toBe('stop');
  });

  it('no observer → zero events and zero generateId draws in the loop path', async () => {
    const ids: string[] = [];
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      tools: weatherTools(),
      maxSteps: 5,
      deps: {
        clock: fastClock(),
        generateId: () => {
          ids.push('x');
          return `id-${ids.length}`;
        },
      },
    });
    expect(ids).toHaveLength(0);
  });

  it('stop condition: endReason stop-condition + stoppedBy from shouldStop', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([TOOL_CALL_STREAM]),
    ]);
    const { stepCountIs } = await import('../src/index');
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: weatherTools(),
      maxSteps: 9,
      stopWhen: stepCountIs(1),
      deps: { observer: mem, clock: fastClock() },
    });
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.endReason).toBe('stop-condition');
    expect(done.stoppedBy).toBe('stepCountIs');
  });

  it('implicit maxSteps: endReason max-steps with NO stoppedBy', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([TOOL_CALL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: weatherTools(),
      maxSteps: 1,
      deps: { observer: mem, clock: fastClock() },
    });
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.endReason).toBe('max-steps');
    expect(done.stoppedBy).toBeUndefined();
  });

  it('client tool break → run.suspended{client-tool} with pendingToolCount', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      // no execute → client tool
      tools: { getWeather: { description: 'client-side', parameters: SCHEMA } },
      maxSteps: 5,
      deps: { observer: mem, clock: fastClock() },
    });
    const types = mem.events().map((e) => e.type);
    expect(types.at(-1)).toBe('run.suspended');
    const suspended = mem.events().at(-1) as Ev<'run.suspended'>;
    expect(suspended.reason).toBe('client-tool');
    expect(suspended.pendingApprovalCount).toBe(0); // legal: pure client-tool suspension
    expect(suspended.pendingToolCount).toBe(1);
    // no tool events fired — nothing from the batch executes on a break
    expect(types).not.toContain('tool.started');
  });

  it('mid-run model failure: model.failed then run.failed exactly once (streaming)', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: weatherTools(),
      maxSteps: 5,
      deps: { observer: mem, clock: fastClock() },
    });
    await expect(result.usage).rejects.toThrow();
    const types = mem.events().map((e) => e.type);
    expect(types.filter((t) => t === 'model.failed')).toHaveLength(1);
    expect(types.filter((t) => t === 'run.failed')).toHaveLength(1);
    expect(types.at(-1)).toBe('run.failed');
    const failed = mem.events().at(-1) as Ev<'run.failed'>;
    expect(failed.partialUsage?.totalTokens).toBe(15); // completed step 1 usage retained
  });
});
