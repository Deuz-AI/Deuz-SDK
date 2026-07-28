/**
 * OpenTelemetry bridge (1.9) — `createOtelTracer` / `createOtelObserver`.
 *
 * No real OTel install is needed: a FAKE tracer shaped like `@opentelemetry/api`'s
 * `Tracer` is injected through `options.tracer`, so the peer is never required.
 * Because the adapter still probes the (absent) peer for `trace.setSpan` +
 * `context.active()`, spans buffer until that probe settles — every test awaits
 * `otelReady()` before asserting, which is also the documented boot-time
 * "fail loudly" hook.
 *
 * The security property under test is the negative one: with the default
 * `captureContent: false` NO prompt/completion/tool text reaches a span.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createOtelObserver, createOtelTracer, otelReady } from '../src/otel';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, JSONSchema, StreamPart } from '../src/index';
import type { ObserveEvent, RunCompletedEvent, RunStartedEvent } from '../src/types/observe';

// ---------------------------------------------------------------------------
// Fake OTel tracer
// ---------------------------------------------------------------------------

interface FakeSpan {
  name: string;
  kind?: number;
  attributes: Record<string, unknown>;
  events: { name: string; attributes?: Record<string, unknown> }[];
  exceptions: { name?: string; message?: string; code?: string }[];
  status?: { code: number; message?: string };
  /** The OTel `Context` passed as the 3rd startSpan arg (needs the real peer). */
  parentContext: unknown;
  ended: number;
}

function fakeOtel(): { tracer: unknown; spans: FakeSpan[] } {
  const spans: FakeSpan[] = [];
  const tracer = {
    startSpan(
      name: string,
      options?: { kind?: number; attributes?: Record<string, unknown> },
      context?: unknown,
    ) {
      const rec: FakeSpan = {
        name,
        ...(options?.kind !== undefined ? { kind: options.kind } : {}),
        attributes: { ...options?.attributes },
        events: [],
        exceptions: [],
        parentContext: context,
        ended: 0,
      };
      spans.push(rec);
      return {
        setAttribute(key: string, value: unknown) {
          rec.attributes[key] = value;
        },
        setAttributes(values: Record<string, unknown>) {
          Object.assign(rec.attributes, values);
        },
        addEvent(eventName: string, attributes?: Record<string, unknown>) {
          rec.events.push({ name: eventName, ...(attributes ? { attributes } : {}) });
        },
        recordException(exception: { name?: string; message?: string; code?: string }) {
          rec.exceptions.push(exception);
        },
        setStatus(status: { code: number; message?: string }) {
          rec.status = status;
        },
        end() {
          rec.ended += 1;
        },
      };
    },
  };
  return { tracer, spans };
}

/** Every string that reached the collector — for negative (leak) assertions. */
function allText(spans: FakeSpan[]): string {
  return JSON.stringify(spans);
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

/** Deterministic clock/ids so two runs can be compared byte-for-byte. */
function frozenDeps(): { clock: Clock; generateId: () => string } {
  return {
    clock: { now: () => 1000, setTimeout: () => () => {} },
    generateId: () => 'id',
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const SECRET_PROMPT = 'ROSEBUD-PROMPT my key is sk-ant-api03-AAAABBBBCCCCDDDD1234';

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
    data: {
      type: 'message_start',
      message: { usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 7 } },
    },
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
      delta: { type: 'text_delta', text: 'ROSEBUD-OUT' },
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

const ERROR_RESPONSE = (): Response =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

// Hand-built events: the observer's real contract is the ObserveEvent protocol,
// so mappings with no cheap end-to-end fixture (embeddings) and the adapter's
// OWN redaction barrier are driven directly.
const BASE = {
  schemaVersion: 1 as const,
  eventId: 'e0',
  sequence: 0,
  timestamp: 0,
  runId: 'run-1',
  executionId: 'exec-1',
};

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
};

function runStarted(over: Partial<RunStartedEvent> = {}): ObserveEvent {
  return {
    ...BASE,
    type: 'run.started',
    spanId: 'root',
    operation: 'stream-chat',
    provider: 'xai',
    model: 'grok-4',
    surface: 'chat_completions',
    durable: false,
    resumed: false,
    ...over,
  };
}

function runCompleted(over: Partial<RunCompletedEvent> = {}): ObserveEvent {
  return {
    ...BASE,
    sequence: 1,
    type: 'run.completed',
    spanId: 'root',
    status: 'completed',
    durationMs: 12,
    finishReason: 'stop',
    endReason: 'natural',
    stepCount: 1,
    modelCallCount: 1,
    toolCallCount: 0,
    toolErrorCount: 0,
    deniedToolCount: 0,
    retryCount: 0,
    approvalCount: 0,
    checkpointCount: 0,
    subAgentCount: 0,
    usage: { ...ZERO_USAGE, inputTokens: 11, outputTokens: 3, totalTokens: 14 },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// createOtelObserver — GenAI semconv (default naming)
// ---------------------------------------------------------------------------

describe('createOtelObserver — gen-ai naming', () => {
  it('full streamChat run: invoke_agent root + chat {model} with semconv attributes', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);

    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer, clock: fastClock() },
    });
    const chunks: string[] = [];
    for await (const delta of result.textStream) chunks.push(delta);
    await result.usage;
    await otelReady(observer);

    expect(chunks.join('')).toBe('ROSEBUD-OUT');
    expect(spans.map((s) => s.name)).toEqual(['invoke_agent', 'chat claude-opus-4-8']);

    const [root, chat] = spans as [FakeSpan, FakeSpan];
    expect(root.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.system': 'anthropic', // deprecated alias, deliberate
      'gen_ai.request.model': 'claude-opus-4-8',
      'gen_ai.response.finish_reasons': ['stop'],
      'deuz.operation': 'stream-chat',
      'deuz.surface': 'anthropic',
      'deuz.run.status': 'completed',
      'deuz.end_reason': 'natural',
      // run TOTALS stay deuz.* so summing gen_ai.usage.* never double counts
      'deuz.usage.input_tokens': 20,
      'deuz.usage.output_tokens': 6,
    });
    expect(root.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(root.kind).toBe(0); // INTERNAL

    expect(chat.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-opus-4-8',
      'gen_ai.response.model': 'claude-opus-4-8',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 20,
      'gen_ai.usage.output_tokens': 6,
      'gen_ai.usage.cache_read.input_tokens': 7,
      'deuz.retry.count': 0,
    });
    expect(chat.kind).toBe(2); // CLIENT
    // time_to_first_chunk is a double in SECONDS per semconv
    expect(typeof chat.attributes['gen_ai.response.time_to_first_chunk']).toBe('number');
    for (const span of spans) {
      expect(span.ended).toBe(1); // idempotent settle
      expect(span.exceptions).toHaveLength(0);
      expect(span.status).toBeUndefined();
    }
    // Context propagation needs the real peer; with a hand-passed tracer and no
    // `@opentelemetry/api` installed the adapter emits flat spans (documented).
    expect(spans.every((s) => s.parentContext === undefined)).toBe(true);
  });

  it('agentic loop: one chat span per model call + execute_tool {name}', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);

    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({ temp: 22 }) } },
      maxSteps: 5,
      deps: { observer, clock: fastClock() },
    });
    await otelReady(observer);

    expect(spans.map((s) => s.name)).toEqual([
      'invoke_agent',
      'chat claude-opus-4-8',
      'execute_tool getWeather',
      'chat claude-opus-4-8',
    ]);
    const tool = spans.find((s) => s.name === 'execute_tool getWeather')!;
    expect(tool.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'getWeather',
      'gen_ai.tool.call.id': 'toolu_1',
      'gen_ai.tool.type': 'function',
      'deuz.tool.execution_mode': 'server',
      'deuz.tool.is_error': false,
      'deuz.step.index': 0,
    });
    expect(tool.kind).toBe(0); // INTERNAL
    // step boundaries are attributes, not spans, under gen-ai naming
    const chats = spans.filter((s) => s.name === 'chat claude-opus-4-8');
    expect(chats.map((s) => s.attributes['deuz.step.index'])).toEqual([0, 1]);
    // usage lands once per model REQUEST (10/5 then 20/6) — never aggregated here
    expect(chats.map((s) => s.attributes['gen_ai.usage.output_tokens'])).toEqual([5, 6]);
    const root = spans[0]!;
    expect(root.attributes).toMatchObject({
      'deuz.step.count': 2,
      'deuz.tool.call.count': 1,
      'deuz.usage.output_tokens': 11,
    });
    for (const span of spans) expect(span.ended).toBe(1);
  });

  it('failure: error.type + ERROR status, and NO error message by default', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    const { fetch } = mockFetchSequence([ERROR_RESPONSE]);

    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer, clock: fastClock() },
    });
    await expect(result.usage).rejects.toThrow();
    await otelReady(observer);

    const root = spans.find((s) => s.name === 'invoke_agent')!;
    const chat = spans.find((s) => s.name.startsWith('chat '))!;
    for (const span of [root, chat]) {
      expect(span.attributes['error.type']).toBe('invalid_request');
      expect(span.status?.code).toBe(2); // SpanStatusCode.ERROR
      expect(span.status?.message).toBeUndefined(); // messages are content
      expect(span.exceptions).toHaveLength(1);
      expect(span.exceptions[0]!.message).toBeUndefined();
      expect(span.exceptions[0]!.code).toBe('invalid_request');
      expect(span.ended).toBe(1);
    }
    expect(root.attributes['deuz.run.status']).toBe('failed');
  });

  it('user abort: run span settles as aborted with NO exception (a resolution)', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
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
      deps: { observer, clock: fastClock() },
    });
    await expect(result.finishReason).resolves.toBe('aborted');
    await otelReady(observer);

    const root = spans.find((s) => s.name === 'invoke_agent')!;
    expect(root.attributes['deuz.run.status']).toBe('aborted');
    expect(root.exceptions).toHaveLength(0);
    expect(root.status).toBeUndefined();
    expect(root.ended).toBe(1);
  });

  it('embed runs map to `embeddings {model}` and carry gen_ai.usage.* (no chat child)', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    observer.emit(
      runStarted({ operation: 'embed-many', provider: 'openai', model: 'text-embedding-3-small' }),
    );
    observer.emit(runCompleted());
    await otelReady(observer);

    expect(spans.map((s) => s.name)).toEqual(['embeddings text-embedding-3-small']);
    expect(spans[0]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.provider.name': 'openai',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 3,
    });
    expect(spans[0]!.kind).toBe(2); // CLIENT
    expect(spans[0]!.ended).toBe(1);
  });

  it('deuz provider ids map to registry-recognized gen_ai.provider.name values', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    observer.emit(runStarted()); // provider 'xai'
    observer.emit(
      runStarted({ executionId: 'exec-2', provider: 'vertex-google', model: 'gemini-3-pro' }),
    );
    await otelReady(observer);

    expect(spans[0]!.attributes['gen_ai.provider.name']).toBe('x_ai');
    expect(spans[0]!.attributes['deuz.provider']).toBe('xai');
    expect(spans[1]!.attributes['gen_ai.provider.name']).toBe('gcp.vertex_ai');
  });
});

// ---------------------------------------------------------------------------
// Content capture — the security property
// ---------------------------------------------------------------------------

describe('createOtelObserver — content capture', () => {
  it('captureContent defaults to FALSE: no prompt/completion/tool text on any span', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer });
    expect(observer.options?.capture).toBeUndefined(); // never asks the runtime for content
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);

    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: SECRET_PROMPT }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => 'ROSEBUD-TOOL-OUT' } },
      maxSteps: 5,
      deps: { observer, clock: fastClock() },
    });
    await otelReady(observer);

    const text = allText(spans);
    expect(text).not.toContain('ROSEBUD-PROMPT');
    expect(text).not.toContain('ROSEBUD-OUT');
    expect(text).not.toContain('ROSEBUD-TOOL-OUT');
    expect(text).not.toContain('Paris'); // tool arguments
    expect(text).not.toContain('sk-ant-');
    for (const span of spans) {
      expect(span.attributes['gen_ai.input.messages']).toBeUndefined();
      expect(span.attributes['gen_ai.output.messages']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined();
    }
    // …while the safe skeleton is still fully there
    expect(spans.map((s) => s.name)).toContain('execute_tool getWeather');
  });

  it('captureContent: true records semconv messages — with secrets redacted', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer, captureContent: true });
    expect(observer.options?.capture?.messages).toBe(true); // asks the runtime for payloads
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);

    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: SECRET_PROMPT }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => 'ROSEBUD-TOOL-OUT' } },
      maxSteps: 5,
      deps: { observer, clock: fastClock() },
    });
    await otelReady(observer);

    const chat = spans.find((s) => s.name.startsWith('chat '))!;
    const input = chat.attributes['gen_ai.input.messages'] as string;
    expect(typeof input).toBe('string');
    // semconv shape: [{ role, parts: [{ type: 'text', content }] }]
    const parsed = JSON.parse(input) as {
      role: string;
      parts: { type: string; content: string }[];
    }[];
    expect(parsed[0]!.role).toBe('user');
    expect(parsed[0]!.parts[0]).toMatchObject({ type: 'text' });
    expect(parsed[0]!.parts[0]!.content).toContain('ROSEBUD-PROMPT'); // opted in
    // P0: the api key inside that same message never reaches the collector
    expect(input).toContain('[REDACTED]');
    expect(allText(spans)).not.toContain('sk-ant-');

    const final = spans.filter((s) => s.name.startsWith('chat ')).at(-1)!;
    const output = JSON.parse(final.attributes['gen_ai.output.messages'] as string) as {
      role: string;
      parts: { type: string; content: string }[];
      finish_reason: string;
    }[];
    expect(output[0]).toMatchObject({ role: 'assistant', finish_reason: 'stop' });
    expect(output[0]!.parts[0]!.content).toBe('ROSEBUD-OUT');

    const tool = spans.find((s) => s.name === 'execute_tool getWeather')!;
    expect(tool.attributes['gen_ai.tool.call.arguments']).toContain('Paris');
    expect(tool.attributes['gen_ai.tool.call.result']).toContain('ROSEBUD-TOOL-OUT');
  });

  it('the adapter redacts on its OWN (second barrier, independent of the runtime)', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer, captureContent: true });
    // A hand-built event with a RAW key — as if the runtime barrier were absent.
    observer.emit(
      runStarted({
        operation: 'embed',
        capturedMessages: [{ role: 'user', content: 'key sk-ant-api03-RAWRAWRAWRAW9999' }],
      }),
    );
    await otelReady(observer);

    const captured = spans[0]!.attributes['gen_ai.input.messages'] as string;
    expect(captured).toContain('[REDACTED]');
    expect(allText(spans)).not.toContain('sk-ant-');
  });

  it('image bytes are never inlined: non-text parts report their kind only', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer, captureContent: true });
    observer.emit(
      runStarted({
        operation: 'embed',
        capturedMessages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', image: 'AAAABBBBCCCC-base64-bytes', mediaType: 'image/png' },
            ],
          },
        ],
      }),
    );
    await otelReady(observer);

    const captured = spans[0]!.attributes['gen_ai.input.messages'] as string;
    expect(captured).toContain('"type":"image"');
    expect(captured).not.toContain('base64-bytes');
  });
});

// ---------------------------------------------------------------------------
// createOtelTracer — the deps.tracer seam
// ---------------------------------------------------------------------------

describe('createOtelTracer', () => {
  it('gen-ai naming renames the bridge lifecycle onto semconv spans', async () => {
    const { tracer: fake, spans } = fakeOtel();
    const tracer = createOtelTracer({ tracer: fake });
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
    await otelReady(tracer);

    // bridge topology (invoke → step ×2 → execute_tool), semconv names
    expect(spans.map((s) => s.name)).toEqual([
      'chat claude-opus-4-8', // the bridge's `invoke`
      'chat claude-opus-4-8', // step 0
      'execute_tool getWeather',
      'chat claude-opus-4-8', // step 1
    ]);
    expect(spans[0]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-opus-4-8',
      // The bridge's invoke span reports the run's ACCUMULATED usage (10+20),
      // and its steps report theirs — the documented double-count of the tracer
      // path. `createOtelObserver` is the exact-per-request alternative.
      'gen_ai.usage.input_tokens': 30,
      'gen_ai.response.finish_reasons': ['stop'],
      'deuz.step.count': 2,
    });
    expect(spans[1]!.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(spans[2]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'getWeather',
      'gen_ai.tool.call.id': 'toolu_1',
      'deuz.tool.is_error': false,
    });
    expect(spans[2]!.kind).toBe(0);
    expect(spans[0]!.kind).toBe(2);
    for (const span of spans) expect(span.ended).toBe(1);
  });

  it("naming: 'deuz' keeps today's span names and attribute keys verbatim", async () => {
    const { tracer: fake, spans } = fakeOtel();
    const tracer = createOtelTracer({ tracer: fake, naming: 'deuz' });
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
    await otelReady(tracer);

    expect(spans.map((s) => s.name)).toEqual(['invoke', 'step', 'execute_tool', 'step']);
    expect(spans[0]!.attributes['gen_ai.operation.name']).toBeUndefined(); // no renaming
    expect(spans[0]!.attributes['gen_ai.provider.name']).toBe('anthropic'); // raw deuz id
    expect(spans[1]!.attributes).toMatchObject({ 'deuz.step.index': 0 });
  });

  it('a throwing collector never affects the run (G2)', async () => {
    const explosive = {
      startSpan: () => {
        throw new Error('exporter exploded');
      },
    };
    const tracer = createOtelTracer({ tracer: explosive });
    const observer = createOtelObserver({ tracer: explosive });
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);

    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { tracer, observer, clock: fastClock() },
    });
    expect(res.text).toBe('ROSEBUD-OUT');
  });
});

// ---------------------------------------------------------------------------
// createOtelObserver — naming: 'deuz' (drives the legacy bridge)
// ---------------------------------------------------------------------------

describe("createOtelObserver — naming: 'deuz'", () => {
  it('reproduces the bridge shape and isolates CONCURRENT runs per execution leg', async () => {
    const { tracer, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer, naming: 'deuz' });
    const model = (): ReturnType<ReturnType<typeof createAnthropic>> => {
      const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
      return createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    };

    await Promise.all([
      generateText({
        model: model(),
        messages: [{ role: 'user', content: 'a' }],
        deps: { observer, clock: fastClock() },
      }),
      generateText({
        model: model(),
        messages: [{ role: 'user', content: 'b' }],
        deps: { observer, clock: fastClock() },
      }),
    ]);
    await otelReady(observer);

    expect(spans.map((s) => s.name)).toEqual(['invoke', 'invoke']);
    // A single shared bridge would have clobbered one run's span state.
    for (const span of spans) {
      expect(span.ended).toBe(1);
      expect(span.attributes['gen_ai.usage.output_tokens']).toBe(6);
      expect(span.attributes['deuz.step.count']).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Missing peer
// ---------------------------------------------------------------------------

describe('missing @opentelemetry/api peer', () => {
  it('surfaces the actionable install error, not a bare module-not-found', async () => {
    const observer = createOtelObserver();
    await expect(observer.flush!()).rejects.toThrow(
      /optional peer "@opentelemetry\/api" — install it: npm i @opentelemetry\/api/,
    );
    const tracer = createOtelTracer();
    await expect(otelReady(tracer)).rejects.toThrow(/@opentelemetry\/api/);
    // the underlying resolution failure is preserved as the cause
    const err = await otelReady(tracer).then(
      () => undefined,
      (e: unknown) => e as Error & { cause?: unknown },
    );
    expect(err).toBeDefined();
    expect(err!.cause).toBeDefined();
    expect(err!.message).not.toMatch(/^Cannot find (module|package)/);
  });

  it('a missing peer never affects the run — spans are simply dropped', async () => {
    const observer = createOtelObserver();
    const tracer = createOtelTracer();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer, tracer, clock: fastClock() },
    });
    expect(res.text).toBe('ROSEBUD-OUT');
    await expect(otelReady(observer)).rejects.toThrow();
  });

  it('a passed tracer makes the peer optional: readiness resolves, spans flow', async () => {
    const { tracer: fake, spans } = fakeOtel();
    const observer = createOtelObserver({ tracer: fake });
    observer.emit(runStarted());
    observer.emit(runCompleted());
    await expect(otelReady(observer)).resolves.toBeUndefined();
    expect(spans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// It observes, never alters
// ---------------------------------------------------------------------------

describe('the canonical stream is unchanged with the adapter attached', () => {
  const run = async (deps: Parameters<typeof streamChat>[0]['deps']): Promise<StreamPart[]> => {
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => 'r' } },
      maxSteps: 5,
      deps,
    });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    await result.finishReason;
    return parts;
  };

  it('produces byte-identical stream parts with and without the OTel adapter', async () => {
    const frozen = frozenDeps();
    const bare = await run({ ...frozen });
    const { tracer } = fakeOtel();
    const observed = await run({
      ...frozen,
      observer: createOtelObserver({ tracer, captureContent: true }),
      tracer: createOtelTracer({ tracer }),
    });
    expect(bare.length).toBeGreaterThan(5); // not a vacuous comparison
    expect(observed.map((p) => p.type)).toContain('tool-state'); // the loop really ran
    expect(JSON.stringify(observed)).toBe(JSON.stringify(bare));
  });
});

// ---------------------------------------------------------------------------
// Fast path (unchanged by this module)
// ---------------------------------------------------------------------------

describe('zero-observer fast path stays free', () => {
  it('an unattached adapter draws no ids and opens no spans', async () => {
    const { tracer, spans } = fakeOtel();
    createOtelObserver({ tracer });
    createOtelTracer({ tracer });
    const ids: string[] = [];
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: {
        clock: fastClock(),
        generateId: () => {
          ids.push('draw');
          return `id-${ids.length}`;
        },
      },
    });
    expect(ids).toHaveLength(0); // no observer + noop tracer => no runtime, no ids
    expect(spans).toHaveLength(0);
  });
});
