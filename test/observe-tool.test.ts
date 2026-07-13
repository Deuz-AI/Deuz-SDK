/**
 * Tool-level observation: parallel ordering/parents, timing, failure capture,
 * denial causes, runaway guard, capture opt-in, provider-tool exclusion.
 */
import { describe, it, expect } from 'vitest';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, ObserveEvent, JSONSchema, ToolSet } from '../src/index';

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

/** One assistant turn calling `names` in parallel (distinct tool_use blocks). */
function parallelToolStream(names: [string, string]): string {
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
        content_block: { type: 'tool_use', id: 'toolu_a', name: names[0] },
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
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: names[1] },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
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

function singleToolStream(name: string): string {
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
        content_block: { type: 'tool_use', id: 'toolu_1', name },
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
}

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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
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

describe('tool observation — parallel execution', () => {
  it('parallel tools: separate spans, same step parent, REAL completion order', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([parallelToolStream(['slow', 'fast'])]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const tools: ToolSet = {
      slow: {
        parameters: SCHEMA,
        execute: () => new Promise((r) => setTimeout(() => r('slow-done'), 30)),
      },
      fast: {
        parameters: SCHEMA,
        execute: () => new Promise((r) => setTimeout(() => r('fast-done'), 1)),
      },
    };
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools,
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    const startsInOrder = mem
      .events()
      .filter((e) => e.type === 'tool.started') as Ev<'tool.started'>[];
    const completions = mem
      .events()
      .filter((e) => e.type === 'tool.completed') as Ev<'tool.completed'>[];
    expect(startsInOrder.map((e) => e.toolName)).toEqual(['slow', 'fast']);
    // real completion order: fast before slow
    expect(completions.map((e) => e.toolName)).toEqual(['fast', 'slow']);
    // distinct spans, same step parent
    const [a, b] = startsInOrder;
    expect(a!.spanId).not.toBe(b!.spanId);
    expect(a!.parentSpanId).toBe(b!.parentSpanId);
    expect(a!.parallel).toBe(true);
    expect(b!.executionMode).toBe('server');
    // completion correlates by spanId to its start
    for (const done of completions) {
      const start = startsInOrder.find((s) => s.toolCallId === done.toolCallId)!;
      expect(done.spanId).toBe(start.spanId);
      expect(done.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('tool observation — failures and the runaway guard', () => {
  it('a thrown execute → tool.failed with the ORIGINAL error class/message, selfHealed', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([singleToolStream('boom')]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        boom: {
          parameters: SCHEMA,
          execute: () => {
            throw new RangeError('File not found');
          },
        },
      },
      maxSteps: 3,
      deps: {
        observer: {
          options: { capture: { errorMessages: true } },
          emit: (e) => mem.emit(e),
        },
        clock: fastClock(),
      },
    });
    const failed = mem.events().find((e) => e.type === 'tool.failed') as Ev<'tool.failed'>;
    expect(failed).toMatchObject({
      toolName: 'boom',
      selfHealed: true,
      consecutiveFailureCount: 1,
    });
    // the ORIGINAL cause was captured at the catch site (nothing downstream has it)
    expect(failed.error.name).toBe('RangeError');
    expect(failed.error.message).toBe('File not found');
    // run still completes — self-healing preserved
    expect(mem.events().at(-1)!.type).toBe('run.completed');
  });

  it('runaway guard: 3 consecutive failures → endReason runaway-tool-errors', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([singleToolStream('flaky')]),
      () => sseResponse([singleToolStream('flaky')]),
      () => sseResponse([singleToolStream('flaky')]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        flaky: {
          parameters: SCHEMA,
          execute: () => {
            throw new Error('always fails');
          },
        },
      },
      maxSteps: 10,
      deps: { observer: mem, clock: fastClock() },
    });
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.endReason).toBe('runaway-tool-errors');
    expect(done.toolErrorCount).toBe(3);
    const failures = mem.events().filter((e) => e.type === 'tool.failed') as Ev<'tool.failed'>[];
    expect(failures.map((f) => f.consecutiveFailureCount)).toEqual([1, 2, 3]);
  });

  it('server denial → tool.denied{server-denied}, excluded from error counters', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([singleToolStream('guarded')]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        guarded: { parameters: SCHEMA, needsApproval: true, execute: async () => 'never runs' },
      },
      approveToolCall: () => false,
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    const types = mem.events().map((e) => e.type);
    const denied = mem.events().find((e) => e.type === 'tool.denied') as Ev<'tool.denied'>;
    expect(denied.cause).toBe('server-denied');
    expect(denied.reason).toBeUndefined();
    expect(types).not.toContain('tool.failed');
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.deniedToolCount).toBe(1);
    expect(done.toolErrorCount).toBe(0);
  });
});

describe('tool observation — capture and provider tools', () => {
  it('capture off: no input/output payloads; capture on: redacted payloads present', async () => {
    const run = async (capture: boolean): Promise<Ev<'tool.completed'>> => {
      const mem = createMemoryObserver();
      const { fetch } = mockFetchSequence([
        () => sseResponse([singleToolStream('echo')]),
        () => sseResponse([FINAL_STREAM]),
      ]);
      await generateText({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'go' }],
        tools: {
          echo: {
            parameters: SCHEMA,
            execute: async () => ({ secretly: { api_key: 'sk-should-never-leak' }, ok: true }),
          },
        },
        maxSteps: 3,
        deps: {
          observer: {
            options: capture ? { capture: { toolInputs: true, toolOutputs: true } } : {},
            emit: (e) => mem.emit(e),
          },
          clock: fastClock(),
        },
      });
      return mem.events().find((e) => e.type === 'tool.completed') as Ev<'tool.completed'>;
    };

    const off = await run(false);
    expect(off.capturedOutput).toBeUndefined();
    expect(off.outputType).toBe('object');

    const on = await run(true);
    const captured = on.capturedOutput as { secretly: { api_key: string }; ok: boolean };
    expect(captured.ok).toBe(true);
    // default observe redaction masks the secret key wholesale
    expect(captured.secretly.api_key).toBe('[REDACTED]');
  });

  it('circular tool output degrades, never throws', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([singleToolStream('cyc')])]);
    // maxSteps 1: the circular result is captured but never re-serialized to a wire
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        cyc: {
          parameters: SCHEMA,
          execute: async () => {
            const o: Record<string, unknown> = { a: 1 };
            o.self = o;
            return o;
          },
        },
      },
      maxSteps: 1,
      deps: {
        observer: { options: { capture: { toolOutputs: true } }, emit: (e) => mem.emit(e) },
        clock: fastClock(),
      },
    });
    expect(res.steps).toHaveLength(1);
    const done = mem.events().find((e) => e.type === 'tool.completed') as Ev<'tool.completed'>;
    expect((done.capturedOutput as Record<string, unknown>).self).toBe('[Unserializable]');
  });

  it('provider-executed tools emit NO tool events (they never enter executeTools)', async () => {
    const mem = createMemoryObserver();
    // model answers with text; the provider tool rides in the request only
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    const { anthropicWebSearch } = await import('../src/index');
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'search something' }],
      tools: { web_search: anthropicWebSearch() },
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    const types = mem.events().map((e) => e.type);
    expect(types).not.toContain('tool.started');
    expect(types).not.toContain('tool.completed');
    expect(types.at(-1)).toBe('run.completed');
  });
});
