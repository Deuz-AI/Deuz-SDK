/**
 * Legacy tracer bridge — the FIRST span tests in the repo. The bridge is the
 * single span source: observation events drive the documented
 * invoke → step → execute_tool hierarchy onto Dependencies.tracer, preserving
 * the direct-span era's names, attribute keys and abort/denial contracts.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, Tracer, JSONSchema } from '../src/index';

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  parent?: RecordedSpan;
  exceptions: unknown[];
  ended: number;
}

function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const byHandle = new Map<unknown, RecordedSpan>();
  const tracer: Tracer = {
    startSpan(name, attributes, options) {
      const rec: RecordedSpan = {
        name,
        attributes: { ...attributes },
        exceptions: [],
        ended: 0,
      };
      if (options?.parent) rec.parent = byHandle.get(options.parent);
      const handle = {
        setAttribute(key: string, value: unknown) {
          rec.attributes[key] = value;
        },
        recordException(error: unknown) {
          rec.exceptions.push(error);
        },
        end() {
          rec.ended += 1;
        },
      };
      byHandle.set(handle, rec);
      spans.push(rec);
      return handle;
    },
  };
  return { tracer, spans };
}

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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
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

describe('tracer bridge — tracer-only mode (no observer)', () => {
  it('single-turn call: ONE invoke span with legacy attributes', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { tracer, clock: fastClock() },
    });
    const invokes = spans.filter((s) => s.name === 'invoke');
    expect(invokes).toHaveLength(1); // never double-spanned
    const invoke = invokes[0]!;
    expect(invoke.attributes).toMatchObject({
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-opus-4-8',
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 6,
      'gen_ai.response.finish_reasons': ['stop'],
      'deuz.step.count': 1, // legacy single-turn contract
    });
    expect(invoke.ended).toBe(1); // idempotent settle
    expect(invoke.exceptions).toHaveLength(0);
  });

  it('agentic loop: invoke → step → execute_tool hierarchy (finally wired)', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: async () => ({ temp: 22 }) },
      },
      maxSteps: 5,
      deps: { tracer, clock: fastClock() },
    });
    // exactly ONE invoke (1.5 produced N flat invokes), two steps, one tool
    const invoke = spans.filter((s) => s.name === 'invoke');
    const steps = spans.filter((s) => s.name === 'step');
    const tools = spans.filter((s) => s.name === 'execute_tool');
    expect(invoke).toHaveLength(1);
    expect(steps).toHaveLength(2);
    expect(tools).toHaveLength(1);
    // hierarchy
    expect(steps[0]!.parent).toBe(invoke[0]);
    expect(steps[1]!.parent).toBe(invoke[0]);
    expect(tools[0]!.parent).toBe(steps[0]);
    // legacy attribute keys
    expect(steps[0]!.attributes).toMatchObject({
      'deuz.step.index': 0,
      'gen_ai.request.model': 'claude-opus-4-8',
      'gen_ai.response.finish_reasons': ['tool_calls'],
    });
    expect(tools[0]!.attributes).toMatchObject({
      'gen_ai.tool.name': 'getWeather',
      'gen_ai.tool.call.id': 'toolu_1',
      'deuz.tool.is_error': false,
    });
    expect(invoke[0]!.attributes['deuz.step.count']).toBe(2); // real count now
    // every span settled exactly once
    for (const s of spans) expect(s.ended).toBe(1);
  });

  it('retry lands as deuz.retry.count on the invoke (single-turn legacy semantics)', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { tracer, clock: fastClock(), generateId: () => 'fixed' },
    });
    await result.usage;
    const invoke = spans.find((s) => s.name === 'invoke')!;
    expect(invoke.attributes['deuz.retry.count']).toBe(1);
  });

  it('user abort: invoke ends with aborted usage attrs and NO exception (a resolution)', async () => {
    const { tracer, spans } = recordingTracer();
    const controller = new AbortController();
    controller.abort();
    const abortingFetch = ((_url: unknown, init?: RequestInit) =>
      Promise.reject(
        (init?.signal as AbortSignal | undefined)?.reason ??
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
      )) as typeof fetch;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: abortingFetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      deps: { tracer, clock: fastClock() },
    });
    await expect(result.finishReason).resolves.toBe('aborted');
    const invoke = spans.find((s) => s.name === 'invoke')!;
    expect(invoke.attributes['gen_ai.response.finish_reasons']).toEqual(['aborted']);
    expect(invoke.exceptions).toHaveLength(0);
    expect(invoke.ended).toBe(1);
  });

  it('failure: invoke records the error exactly once and ends', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { tracer, clock: fastClock() },
    });
    await expect(result.usage).rejects.toThrow();
    const invoke = spans.find((s) => s.name === 'invoke')!;
    expect(invoke.exceptions).toHaveLength(1);
    expect(invoke.ended).toBe(1);
  });

  it('a THROWING tracer never affects the run', async () => {
    const explosive: Tracer = {
      startSpan: () => {
        throw new Error('tracer exploded');
      },
    };
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { tracer: explosive, clock: fastClock() },
    });
    expect(res.text).toBe('ok');
  });
});

describe('tracer bridge — alongside an observer', () => {
  it('both sinks receive the run; spans and events agree on the step count', async () => {
    const { tracer, spans } = recordingTracer();
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => 'r' } },
      maxSteps: 5,
      deps: { tracer, observer: mem, clock: fastClock() },
    });
    expect(spans.filter((s) => s.name === 'invoke')).toHaveLength(1);
    expect(spans.filter((s) => s.name === 'execute_tool')).toHaveLength(1); // never doubled
    const stepEvents = mem.events().filter((e) => e.type === 'step.completed');
    expect(spans.filter((s) => s.name === 'step')).toHaveLength(stepEvents.length);
  });

  it('denial: execute_tool marks is_error without an exception', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, needsApproval: true, execute: async () => 'r' },
      },
      approveToolCall: () => false,
      maxSteps: 5,
      deps: { tracer, clock: fastClock() },
    });
    const tool = spans.find((s) => s.name === 'execute_tool')!;
    expect(tool.attributes['deuz.tool.is_error']).toBe(true);
    expect(tool.exceptions).toHaveLength(0);
  });

  it('tool throw: execute_tool records the normalized error then settles is_error', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: {
          parameters: SCHEMA,
          execute: () => {
            throw new Error('boom');
          },
        },
      },
      maxSteps: 5,
      deps: { tracer, clock: fastClock() },
    });
    const tool = spans.find((s) => s.name === 'execute_tool')!;
    expect(tool.exceptions).toHaveLength(1);
    expect(tool.attributes['deuz.tool.is_error']).toBe(true);
    expect(tool.ended).toBe(1);
  });
});

describe('tracer bridge — tracerMode: legacy (1.6.1)', () => {
  it('agentic loop reproduces the 1.5 shape: N flat invokes, no children, step.count 1', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({ temp: 22 }) } },
      maxSteps: 5,
      deps: { tracer, tracerMode: 'legacy', clock: fastClock() },
    });
    const invokes = spans.filter((s) => s.name === 'invoke');
    expect(invokes).toHaveLength(2); // one per model call — the 1.5 topology
    expect(spans.filter((s) => s.name === 'step')).toHaveLength(0);
    expect(spans.filter((s) => s.name === 'execute_tool')).toHaveLength(0);
    for (const invoke of invokes) {
      expect(invoke.parent).toBeUndefined(); // FLAT
      expect(invoke.attributes['deuz.step.count']).toBe(1);
      expect(invoke.attributes['gen_ai.request.model']).toBe('claude-opus-4-8');
      expect(invoke.ended).toBe(1);
    }
    expect(invokes[0]!.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    expect(invokes[1]!.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it("legacy retry lands on the model call's own invoke", async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { tracer, tracerMode: 'legacy', clock: fastClock(), generateId: () => 'fixed' },
    });
    await result.usage;
    const invoke = spans.find((s) => s.name === 'invoke')!;
    expect(invoke.attributes['deuz.retry.count']).toBe(1);
    expect(invoke.ended).toBe(1);
  });

  it('legacy abort: clean end, no exception', async () => {
    const { tracer, spans } = recordingTracer();
    const controller = new AbortController();
    controller.abort();
    const abortingFetch = ((_url: unknown, init?: RequestInit) =>
      Promise.reject(
        (init?.signal as AbortSignal | undefined)?.reason ??
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
      )) as typeof fetch;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: abortingFetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      deps: { tracer, tracerMode: 'legacy', clock: fastClock() },
    });
    await expect(result.finishReason).resolves.toBe('aborted');
    const invoke = spans.find((s) => s.name === 'invoke')!;
    expect(invoke.attributes['gen_ai.response.finish_reasons']).toEqual(['aborted']);
    expect(invoke.exceptions).toHaveLength(0);
    expect(invoke.ended).toBe(1);
  });

  it('default stays hierarchical — legacy is opt-in only', async () => {
    const { tracer, spans } = recordingTracer();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => 'r' } },
      maxSteps: 5,
      deps: { tracer, clock: fastClock() },
    });
    expect(spans.filter((s) => s.name === 'invoke')).toHaveLength(1);
    expect(spans.filter((s) => s.name === 'step')).toHaveLength(2);
  });
});
