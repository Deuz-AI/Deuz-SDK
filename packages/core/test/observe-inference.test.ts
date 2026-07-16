/**
 * E2E observation tests for the instrumented single-model pumps (runStream /
 * streamObject / embed) — golden-replay via injected fetch, no network.
 */
import { describe, it, expect } from 'vitest';
import { streamChat, generateText, streamObject } from '../src/index';
import { embed, embedMany } from '../src/inference/embed';
import { createAnthropic } from '../src/anthropic';
import { createOpenAIEmbedding } from '../src/openai';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents } from './fixtures/sse';
import type { Clock, ObserveEvent } from '../src/index';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

/** Fire short (backoff) timers fast; never fire the long ttft/total timers. */
function fastClock(): Clock {
  return {
    now: () => 0,
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

const TEXT_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const TOOL_FIRST_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'search' },
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
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function anthropicError(status: number, type: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: type } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sequenceFetch(responses: (() => Response | Promise<Response>)[]): typeof fetch {
  let i = 0;
  return (async () => {
    const make = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return make();
  }) as typeof fetch;
}

describe('instrumented single-model pump (E2E)', () => {
  it('emits the canonical order and stays lazy (G2)', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock() },
    });
    // synchronous shell: NOTHING emitted before the pump starts
    expect(mem.events()).toHaveLength(0);
    await result.usage;
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual([
      'run.started',
      'model.started',
      'model.first-content',
      'model.completed',
      'run.completed',
    ]);
    const started = mem.events()[0] as Ev<'run.started'>;
    const modelStarted = mem.events()[1] as Ev<'model.started'>;
    expect(started.operation).toBe('stream-chat');
    expect(started.provider).toBe('anthropic');
    expect(modelStarted.parentSpanId).toBe(started.spanId);
    mem.events().forEach((e, i) => expect(e.sequence).toBe(i));
    expect(new Set(mem.events().map((e) => e.runId)).size).toBe(1);
    const completed = mem.events().at(-1) as Ev<'run.completed'>;
    expect(completed.finishReason).toBe('stop');
    expect(completed.usage.totalTokens).toBeGreaterThan(0);
    const modelCompleted = mem.events()[3] as Ev<'model.completed'>;
    expect(modelCompleted.outputTextLength).toBe('hello'.length);
    expect(modelCompleted.retryCount).toBe(0);
  });

  it('no observer → zero generateId draws for a clean text run (fixture stability)', async () => {
    const ids: string[] = [];
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: {
        clock: fastClock(),
        generateId: () => {
          ids.push('drawn');
          return `id-${ids.length}`;
        },
      },
    });
    await result.usage;
    expect(ids).toHaveLength(0);
  });

  it('tool-call-first response clears TTFT and reports contentType tool-call', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TOOL_FIRST_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock() },
    });
    await result.usage;
    const first = mem.events().find((e) => e.type === 'model.first-content') as
      | Ev<'model.first-content'>
      | undefined;
    expect(first?.contentType).toBe('tool-call');
    const modelCompleted = mem.events().find((e) => e.type === 'model.completed') as
      | Ev<'model.completed'>
      | undefined;
    expect(modelCompleted?.toolCallCount).toBe(1);
  });

  it('529 then success: model.retry{overloaded} before backoff, retryCount 1', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([
          () => anthropicError(529, 'overloaded_error'),
          () => sseResponse([TEXT_STREAM]),
        ]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock(), generateId: () => 'fixed' },
    });
    await result.usage;
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual([
      'run.started',
      'model.started',
      'model.retry',
      'model.first-content',
      'model.completed',
      'run.completed',
    ]);
    const retry = mem.events()[2] as Ev<'model.retry'>;
    expect(retry).toMatchObject({
      reason: 'overloaded',
      statusCode: 529,
      errorCode: 'overloaded',
      failedAttempt: 0,
      nextAttempt: 1,
    });
    expect(retry.delayMs).toBeGreaterThanOrEqual(0);
    const modelCompleted = mem.events()[4] as Ev<'model.completed'>;
    expect(modelCompleted.retryCount).toBe(1);
  });

  it('429 with Retry-After: retryAfterMs lands on the event and drives delayMs', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([
          () => anthropicError(429, 'rate_limit_error', { 'retry-after': '1' }),
          () => sseResponse([TEXT_STREAM]),
        ]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock(), generateId: () => 'fixed' },
    });
    await result.usage;
    const retry = mem.events().find((e) => e.type === 'model.retry') as Ev<'model.retry'>;
    expect(retry.reason).toBe('rate-limit');
    expect(retry.retryAfterMs).toBe(1000);
    expect(retry.delayMs).toBe(1000); // Retry-After takes precedence over jitter
  });

  it('network throw then success: reason network', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([
          () => Promise.reject(new TypeError('fetch failed')),
          () => sseResponse([TEXT_STREAM]),
        ]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock(), generateId: () => 'fixed' },
    });
    await result.usage;
    const retry = mem.events().find((e) => e.type === 'model.retry') as Ev<'model.retry'>;
    expect(retry.reason).toBe('network');
    expect(retry.errorCode).toBe('network_error');
  });

  it('exhausted retries: model.failed then run.failed (single failure report)', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => anthropicError(529, 'overloaded_error')]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 1,
      deps: { observer: mem, clock: fastClock(), generateId: () => 'fixed' },
    });
    await expect(result.usage).rejects.toThrow();
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual([
      'run.started',
      'model.started',
      'model.retry',
      'model.failed',
      'run.failed',
    ]);
    const failed = mem.events().at(-1) as Ev<'run.failed'>;
    expect(failed.error.category).toBe('overloaded');
    expect(failed.error.message).toBeUndefined(); // capture off by default
  });

  it('pre-start user abort: model.completed{aborted} + run.aborted (never a failure)', async () => {
    const mem = createMemoryObserver();
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
      deps: { observer: mem, clock: fastClock() },
    });
    await expect(result.finishReason).resolves.toBe('aborted');
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual(['run.started', 'model.started', 'model.completed', 'run.aborted']);
    const modelDone = mem.events()[2] as Ev<'model.completed'>;
    expect(modelDone.finishReason).toBe('aborted');
    expect(types).not.toContain('model.failed');
    expect(types).not.toContain('run.failed');
  });

  it('generateText (no tools) labels the run generate-text', async () => {
    const mem = createMemoryObserver();
    await generateText({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock() },
    });
    const started = mem.events()[0] as Ev<'run.started'>;
    expect(started.operation).toBe('generate-text');
  });

  it('streamObject labels the run stream-object (single run, still lazy)', async () => {
    const mem = createMemoryObserver();
    const jsonStream = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
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
          delta: { type: 'text_delta', text: '{"name":"deuz"}' },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const result = streamObject({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([jsonStream])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      deps: { observer: mem, clock: fastClock() },
    });
    expect(mem.events()).toHaveLength(0); // still lazy
    await expect(result.object).resolves.toEqual({ name: 'deuz' });
    const runStarts = mem.events().filter((e) => e.type === 'run.started');
    expect(runStarts).toHaveLength(1);
    expect((runStarts[0] as Ev<'run.started'>).operation).toBe('stream-object');
  });

  it('sync priceProvider lands costUsd on run.completed; async arrives as cost.calculated', async () => {
    const memSync = createMemoryObserver();
    const model = () =>
      createAnthropic({ apiKey: 'k', fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]) })(
        'claude-opus-4-8',
      );
    await generateText({
      model: model(),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: memSync, clock: fastClock(), priceProvider: { priceUsage: () => 0.01 } },
    });
    const completed = memSync
      .events()
      .find((e) => e.type === 'run.completed') as Ev<'run.completed'>;
    expect(completed.costUsd).toBe(0.01);

    const memAsync = createMemoryObserver();
    await generateText({
      model: model(),
      messages: [{ role: 'user', content: 'hi' }],
      deps: {
        observer: memAsync,
        clock: fastClock(),
        priceProvider: { priceUsage: () => Promise.resolve(0.02) },
      },
    });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget settle
    const cost = memAsync
      .events()
      .find((e) => e.type === 'cost.calculated') as Ev<'cost.calculated'>;
    expect(cost.costUsd).toBe(0.02);
    const asyncCompleted = memAsync
      .events()
      .find((e) => e.type === 'run.completed') as Ev<'run.completed'>;
    expect(asyncCompleted.costUsd).toBeUndefined();
  });
});

describe('instrumented embed runs (E2E)', () => {
  const okEmbedding = (): Response =>
    new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('embedMany emits one run with operation embed-many + usage', async () => {
    const mem = createMemoryObserver();
    await embedMany({
      model: createOpenAIEmbedding({ apiKey: 'sk-test', fetch: sequenceFetch([okEmbedding]) })(
        'text-embedding-3-small',
      ),
      values: ['hello'],
      deps: { observer: mem, clock: fastClock() },
    });
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual(['run.started', 'run.completed']);
    const started = mem.events()[0] as Ev<'run.started'>;
    expect(started.operation).toBe('embed-many');
    const completed = mem.events()[1] as Ev<'run.completed'>;
    expect(completed.usage.inputTokens).toBe(4);
  });

  it('embed delegates to embedMany but emits exactly ONE run labeled embed', async () => {
    const mem = createMemoryObserver();
    await embed({
      model: createOpenAIEmbedding({ apiKey: 'sk-test', fetch: sequenceFetch([okEmbedding]) })(
        'text-embedding-3-small',
      ),
      value: 'hello',
      deps: { observer: mem, clock: fastClock() },
    });
    const runStarts = mem.events().filter((e) => e.type === 'run.started');
    expect(runStarts).toHaveLength(1);
    expect((runStarts[0] as Ev<'run.started'>).operation).toBe('embed');
  });

  it('embed retry surfaces as model.retry; failure ends in run.failed', async () => {
    const mem = createMemoryObserver();
    await expect(
      embedMany({
        model: createOpenAIEmbedding({
          apiKey: 'sk-test',
          fetch: sequenceFetch([
            () =>
              new Response(JSON.stringify({ error: { message: 'rate' } }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
              }),
          ]),
        })('text-embedding-3-small'),
        values: ['hello'],
        maxRetries: 1,
        deps: { observer: mem, clock: fastClock(), generateId: () => 'fixed' },
      }),
    ).rejects.toThrow();
    const types = mem.events().map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types).toContain('model.retry');
    expect(types.at(-1)).toBe('run.failed');
    const retry = mem.events().find((e) => e.type === 'model.retry') as Ev<'model.retry'>;
    expect(retry.reason).toBe('rate-limit');
  });
});

describe('observation.settled (1.6.1)', () => {
  it('async priceProvider: settled drains the cost event BEFORE a JSONL close', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createJsonlObserver } = await import('../src/node/observe');

    const file = join(mkdtempSync(join(tmpdir(), 'deuz-settled-')), 'runs.jsonl');
    const jsonl = createJsonlObserver({ file });
    const res = await generateText({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: {
        observer: jsonl,
        clock: fastClock(),
        // resolves on a later tick — the exact scenario that used to lose the event
        priceProvider: { priceUsage: () => new Promise((r) => setTimeout(() => r(0.03), 10)) },
      },
    });
    expect(res.observation).toBeDefined();
    await res.observation!.settled;
    await jsonl.close();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('cost.calculated');
    expect(jsonl.droppedCount).toBe(0);
  });

  it('streaming shell exposes settled; sync provider settles immediately', async () => {
    const mem = createMemoryObserver();
    const result = streamChat({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { observer: mem, clock: fastClock(), priceProvider: { priceUsage: () => 0.01 } },
    });
    await result.usage;
    expect(result.observation).toBeDefined();
    await expect(result.observation!.settled).resolves.toBeUndefined();
    const completed = mem.events().find((e) => e.type === 'run.completed') as Ev<'run.completed'>;
    expect(completed.costUsd).toBe(0.01);
  });

  it('no observer → no observation field (fast path unchanged)', async () => {
    const res = await generateText({
      model: createAnthropic({
        apiKey: 'k',
        fetch: sequenceFetch([() => sseResponse([TEXT_STREAM])]),
      })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { clock: fastClock() },
    });
    expect(res.observation).toBeUndefined();
  });

  it('embed results carry settled too (async cost drained)', async () => {
    const mem = createMemoryObserver();
    const okEmbedding = (): Response =>
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const res = await embed({
      model: createOpenAIEmbedding({ apiKey: 'sk-test', fetch: sequenceFetch([okEmbedding]) })(
        'text-embedding-3-small',
      ),
      value: 'hello',
      deps: {
        observer: mem,
        clock: fastClock(),
        priceProvider: { priceUsage: () => Promise.resolve(0.0001) },
      },
    });
    expect(res.observation).toBeDefined();
    await res.observation!.settled;
    expect(mem.events().some((e) => e.type === 'cost.calculated')).toBe(true);
  });
});
