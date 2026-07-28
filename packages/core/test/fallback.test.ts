import { describe, it, expect, vi } from 'vitest';
import { streamChat, wrapModel, withFallback, BreakerOpenError, TimeoutError } from '../src/index';
import { defaultShouldFallback } from '../src/internal/fallback';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import { createInMemoryChatStore } from '../src/chat';
import { createInMemorySessionStore } from '../src/durable';
import { BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS } from '../src/core/resilience';
import type { StreamPart } from '../src/types/stream';
import type { BreakerState } from '../src/types/deps';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

/** Anthropic-wire success turn. */
const ANTHROPIC_OK = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
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
      delta: { type: 'text_delta', text: 'Answer from provider B.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

/** OpenAI Chat Completions success turn (provider B uses a different wire). */
const OPENAI_OK = sseEvents([
  {
    data: {
      choices: [{ index: 0, delta: { content: 'Answer from provider B.' }, finish_reason: null }],
    },
  },
  { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } },
  { data: '[DONE]' },
]);

const overloaded = (): Response =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    {
      status: 529,
      headers: { 'content-type': 'application/json' },
    },
  );

function makeMemoryBreakerStore(): {
  store: { get(k: string): BreakerState | undefined; set(k: string, s: BreakerState): void };
  states: Map<string, BreakerState>;
} {
  const states = new Map<string, BreakerState>();
  return {
    store: { get: (k) => states.get(k), set: (k, s) => void states.set(k, s) },
    states,
  };
}

describe('fallbackModels — cross-provider fail-over (D6)', () => {
  it('provider-A 529 (after retries) → provider-B completes the SAME canonical history', async () => {
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([OPENAI_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'hop providers, keep my history' }],
      maxRetries: 1,
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);

    expect(a.calls.length).toBe(2); // initial + 1 retry on A, then hop
    expect(b.calls.length).toBe(1);
    // The identical canonical history reached provider B (different wire).
    const bBody = JSON.parse(String(b.calls[0]!.init!.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(bBody.messages.at(-1)).toMatchObject({ content: 'hop providers, keep my history' });

    const text = parts
      .filter((p): p is Extract<StreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('Answer from provider B.');
    const finish = parts.at(-1) as Extract<StreamPart, { type: 'finish' }>;
    expect(finish.type).toBe('finish');
    expect(finish.providerMetadata?.deuz).toMatchObject({
      failedOver: { from: 'anthropic:claude-opus-4-8', to: 'openai:gpt-5.2', reason: 'overloaded' },
    });
    expect(await result.finishReason).toBe('stop');
  });

  it('buffered generateText hops too and marks failedOver metadata', async () => {
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const onFallback = vi.fn();
    const wrapped = wrapModel(
      createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      [
        withFallback([createAnthropic({ apiKey: 'kb', fetch: b.fetch })('claude-sonnet-5')], {
          onFallback,
        }),
      ],
    );
    const result = await wrapped.generateText({
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
    });
    expect(result.text).toBe('Answer from provider B.');
    expect(result.providerMetadata?.deuz).toMatchObject({
      failedOver: { from: 'anthropic:claude-opus-4-8', to: 'anthropic:claude-sonnet-5' },
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('a post-first-content error NEVER fails over (mid-stream errors stay final)', async () => {
    const midStreamError = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
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
          delta: { type: 'text_delta', text: 'Half an ans' },
        },
      },
      {
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: 'died mid-stream' } },
      },
    ]);
    const a = mockFetch(() => sseResponse([midStreamError]));
    const b = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createAnthropic({ apiKey: 'kb', fetch: b.fetch })('claude-sonnet-5')],
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    expect(b.calls.length).toBe(0); // no hop after first content
    expect(parts.some((p) => p.type === 'text-delta')).toBe(true);
    expect(parts.at(-1)!.type).toBe('error');
    await expect(result.usage).rejects.toBeDefined();
  });

  it('non-fallback errors (4xx auth) surface immediately without hopping', async () => {
    const a = mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'bad key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const b = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'bad', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createAnthropic({ apiKey: 'kb', fetch: b.fetch })('claude-sonnet-5')],
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    expect(parts.at(-1)!.type).toBe('error');
    expect(b.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1.9: the fail-over shell (`src/internal/fallback.ts`) built its own PARTIAL
// StreamChatResult, so `consume()`, `warnings` and `observation` were missing on
// exactly the paths they exist for — `res.consume?.()` was a silent no-op and a
// serverless handler that returned the response without iterating never reached
// its terminal boundary (no chat persistence, no checkpoint, no onFinish).
// ---------------------------------------------------------------------------

describe('fail-over result shape (1.9): consume / warnings / observation', () => {
  it('consume() runs the terminal effects after a hop with NOTHING iterating', async () => {
    const chats = createInMemoryChatStore();
    const sessions = createInMemorySessionStore();
    const onFinish = vi.fn();
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([OPENAI_OK]));

    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'hop and still persist' }],
      // `chat` + `session` route the call through the agentic loop, whose
      // terminal effects run AFTER the stream closes — the exact bookkeeping a
      // drain has to await.
      chat: { store: chats, chatId: 'fo-1', scope: { userId: 'u1' } },
      session: { store: sessions },
      onFinish,
      maxRetries: 0,
    });

    // Durable identity is known synchronously even on the fail-over path (G2).
    expect(result.runId).toBeDefined();
    expect(typeof result.consume).toBe('function');
    expect(onFinish).not.toHaveBeenCalled(); // lazy: nothing accessed yet

    await expect(result.consume?.()).resolves.toBeUndefined();

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    // The WINNER's terminal effects ran, without a single iteration.
    const record = await chats.loadChat('fo-1');
    expect(JSON.stringify(record?.messages)).toContain('Answer from provider B.');
    const checkpoint = await sessions.load(result.runId!);
    expect(checkpoint?.status).toBe('completed');
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(await result.finishReason).toBe('stop');
  });

  it('consume() twice is safe — the terminal effects fire once', async () => {
    const chats = createInMemoryChatStore();
    const saveChat = vi.fn(chats.saveChat);
    const onFinish = vi.fn();
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([OPENAI_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'go' }],
      chat: { store: { ...chats, saveChat }, chatId: 'fo-2', scope: { userId: 'u1' } },
      onFinish,
      maxRetries: 0,
    });

    await Promise.all([result.consume?.(), result.consume?.()]);
    await result.consume?.(); // and again, sequentially

    expect(b.calls).toHaveLength(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    // The failed attempt persists its own (user-only) history on the way out, so
    // the drain being memoized is asserted on the callback + request counts.
    expect(saveChat.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('consume() and a fullStream iteration BOTH see every part', async () => {
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([OPENAI_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
    });
    const drained = result.consume?.();
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    await expect(drained).resolves.toBeUndefined();
    const text = parts
      .filter((p): p is Extract<StreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('Answer from provider B.');
  });

  it('never rejects when EVERY candidate fails — the error reaches onError', async () => {
    const a = mockFetch(overloaded);
    const b = mockFetch(overloaded);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createAnthropic({ apiKey: 'kb', fetch: b.fetch })('claude-sonnet-5')],
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
    });
    const onError = vi.fn();
    await expect(result.consume?.({ onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(result.usage).rejects.toBeDefined();
  });

  it('forwards warnings (always) and observation (only when an observer is active)', async () => {
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([OPENAI_OK]));
    const bare = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
    });
    expect(bare.observation).toBeUndefined(); // no observer, no tracer
    await bare.consume?.();
    // The winning candidate is the UNKNOWN slug `gpt-5.2`, so the fail-over shell
    // forwards a real warning now that emitters exist (1.9). Before, this was []
    // only because nothing ever produced one.
    expect((await bare.warnings)?.map((w) => w.type)).toEqual(['unknown-model']);

    const events: string[] = [];
    const a2 = mockFetch(overloaded);
    const b2 = mockFetch(() => sseResponse([OPENAI_OK]));
    const observed = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a2.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b2.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'go' }],
      maxRetries: 0,
      deps: { observer: { emit: (event) => void events.push(event.type) } },
    });
    expect(observed.observation).toBeDefined();
    await observed.consume?.();
    await expect(observed.observation!.settled).resolves.toBeUndefined();
    // Both attempts' runs are covered by the shell's settlement.
    expect(events.filter((e) => e === 'run.started')).toHaveLength(2);
  });

  it('settles observation for a LOOP-routed fail-over (the handle appears MID-pump)', async () => {
    // The streaming loop assigns its observation handle INSIDE the pump (after the
    // chat-store await), so a shell that reads `attempt.observation` at
    // construction still sees `undefined` and would resolve its own `settled` too
    // early. The async priceProvider below emits `cost.calculated` a macrotask
    // AFTER the loop's pump finishes, which is what makes this a real pin.
    const events: string[] = [];
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createAnthropic({ apiKey: 'kb', fetch: b.fetch })('claude-sonnet-5')],
      messages: [{ role: 'user', content: 'go' }],
      chat: { store: createInMemoryChatStore(), chatId: 'fo-4', scope: { userId: 'u1' } },
      maxRetries: 0,
      deps: {
        observer: { emit: (event) => void events.push(event.type) },
        priceProvider: {
          priceUsage: () => new Promise<number>((r) => setTimeout(() => r(0.42), 5)),
        },
      },
    });
    await result.consume?.();
    await expect(result.observation!.settled).resolves.toBeUndefined();
    expect(events.filter((e) => e === 'run.started')).toHaveLength(2);
    expect(events).toContain('run.completed');
    expect(events).toContain('run.failed');
    // Only reachable if the WINNER's own settlement was awaited by the shell.
    expect(events).toContain('cost.calculated');
  });

  it('the withFallback middleware forwards consume() too', async () => {
    const chats = createInMemoryChatStore();
    const onFinish = vi.fn();
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const m = wrapModel(createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'), [
      withFallback([createAnthropic({ apiKey: 'kb', fetch: b.fetch })('claude-sonnet-5')]),
    ]);
    const result = m.streamChat({
      messages: [{ role: 'user', content: 'go' }],
      chat: { store: chats, chatId: 'fo-3', scope: { userId: 'u1' } },
      onFinish,
      maxRetries: 0,
    });
    await expect(result.consume?.()).resolves.toBeUndefined();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await chats.loadChat('fo-3'))?.messages)).toContain(
      'Answer from provider B.',
    );
  });
});

describe('circuit breaker wiring (D6)', () => {
  it('opens after the threshold of countable failures, fails fast, and resets on success', async () => {
    const { store, states } = makeMemoryBreakerStore();
    let now = 1_000_000;
    const clock = {
      now: () => now,
      setTimeout: (fn: () => void, _ms: number) => (setTimeout(fn, 0), () => {}),
    };
    const a = mockFetch(overloaded);
    const model = createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8');

    // Drive `threshold` consecutive final failures (maxRetries 0 → 1 fetch each).
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      const r = streamChat({
        model,
        messages: [{ role: 'user', content: 'x' }],
        maxRetries: 0,
        deps: { breakerStore: store, clock },
      });
      for await (const _ of r.fullStream) void _;
    }
    const key = 'anthropic:claude-opus-4-8';
    expect(states.get(key)!.failures).toBe(BREAKER_THRESHOLD);
    expect(states.get(key)!.cooldownUntil).toBe(now + BREAKER_COOLDOWN_MS);
    const callsBefore = a.calls.length;

    // OPEN: the next call fails fast — no fetch happens at all.
    const fast = streamChat({
      model,
      messages: [{ role: 'user', content: 'x' }],
      deps: { breakerStore: store, clock },
    });
    const fastParts: StreamPart[] = [];
    for await (const p of fast.fullStream) fastParts.push(p);
    expect(a.calls.length).toBe(callsBefore);
    const err = fastParts.at(-1) as Extract<StreamPart, { type: 'error' }>;
    expect(err.error).toBeInstanceOf(BreakerOpenError);

    // Cooldown expires → probe goes out; a success resets the breaker.
    now += BREAKER_COOLDOWN_MS + 1;
    const ok = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const healthy = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: ok.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'x' }],
      deps: { breakerStore: store, clock },
    });
    for await (const _ of healthy.fullStream) void _;
    expect(states.get(key)!.failures).toBe(0);
  });

  it('an OPEN breaker on A hops straight to B (breaker × fallback)', async () => {
    const { store } = makeMemoryBreakerStore();
    const now = 1_000_000;
    const clock = {
      now: () => now,
      setTimeout: (fn: () => void, _ms: number) => (setTimeout(fn, 0), () => {}),
    };
    store.set('anthropic:claude-opus-4-8', {
      failures: BREAKER_THRESHOLD,
      openedAt: now - 1,
      cooldownUntil: now + 10_000,
    });
    const a = mockFetch(overloaded);
    const b = mockFetch(() => sseResponse([OPENAI_OK]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'ka', fetch: a.fetch })('claude-opus-4-8'),
      fallbackModels: [createOpenAI({ apiKey: 'kb', fetch: b.fetch })('gpt-5.2')],
      messages: [{ role: 'user', content: 'go' }],
      deps: { breakerStore: store, clock },
    });
    const parts: StreamPart[] = [];
    for await (const p of result.fullStream) parts.push(p);
    expect(a.calls.length).toBe(0); // A never even dialed
    expect(b.calls.length).toBe(1);
    const finish = parts.at(-1) as Extract<StreamPart, { type: 'finish' }>;
    expect(finish.providerMetadata?.deuz).toMatchObject({
      failedOver: { reason: 'breaker_open' },
    });
  });
});

describe('defaultShouldFallback — timeout layers (1.9)', () => {
  it('hops on a transport timeout but NOT on a caller-imposed step/tool budget', () => {
    // A step/tool deadline is the caller's budget, not a provider failure: another
    // model cannot make it fit, and re-running the loop would repeat the side
    // effects of tools that already executed in this step.
    expect(defaultShouldFallback(new TimeoutError('connect', 'x'))).toBe(true);
    expect(defaultShouldFallback(new TimeoutError('ttft', 'x'))).toBe(true);
    expect(defaultShouldFallback(new TimeoutError('total', 'x'))).toBe(true);
    expect(defaultShouldFallback(new TimeoutError('step', 'x'))).toBe(false);
    expect(defaultShouldFallback(new TimeoutError('tool', 'x'))).toBe(false);
  });
});
