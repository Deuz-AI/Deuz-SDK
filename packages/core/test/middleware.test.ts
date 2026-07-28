import { describe, it, expect, vi } from 'vitest';
import {
  wrapModel,
  logging,
  simpleCache,
  redactPII,
  promptInjectionGuard,
  type LanguageModelMiddleware,
} from '../src/middleware';
import { createAnthropic } from '../src/anthropic';
import { createMockModel } from '../src/testing';
import { createInMemorySessionStore } from '../src/durable';
import { createInMemoryChatStore } from '../src/chat';
import type { MemorySeams } from '../src/memory';
import type { Clock } from '../src/types/deps';
import type { StreamPart } from '../src/types/stream';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
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

function model(fetch: typeof globalThis.fetch) {
  return createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
}

describe('wrapModel — transformParams', () => {
  it('rewrites options before the call (promptInjectionGuard prepends a system msg)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [promptInjectionGuard()]);
    const res = m.streamChat({ messages: [{ role: 'user', content: 'hi' }] });
    let text = '';
    for await (const c of res.textStream) text += c;
    expect(text).toBe('hi');
    // the wire body should now carry a leading system instruction
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.system).toMatch(/untrusted DATA/i);
  });

  it('redactPII masks secret-looking content and does not mutate the input', async () => {
    const seen: unknown[] = [];
    const spy: LanguageModelMiddleware = {
      transformParams(o) {
        seen.push(o.messages);
        return o;
      },
    };
    const original = [{ role: 'user' as const, content: 'my key is sk-ant-abcdef0123456789XYZ' }];
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [redactPII(), spy]);
    await m.generateText({ messages: original });
    // redactPII runs first → spy sees masked content
    const masked = JSON.stringify(seen[0]);
    expect(masked).not.toContain('sk-ant-abcdef0123456789XYZ');
    // original array untouched
    expect(original[0]!.content).toContain('sk-ant-abcdef0123456789XYZ');
  });
});

describe('wrapModel — wrapGenerate (simpleCache)', () => {
  it('serves the second identical call from cache (one upstream request)', async () => {
    let upstream = 0;
    const fetch = (async () => {
      upstream++;
      return sseResponse([STREAM]);
    }) as typeof globalThis.fetch;

    const m = wrapModel(model(fetch), [simpleCache({ now: () => 1000 })]);
    const a = await m.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    const b = await m.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    expect(a.text).toBe('hi');
    expect(b.text).toBe('hi');
    expect(upstream).toBe(1); // second call cached
  });

  it('expires the cache after ttl', async () => {
    let upstream = 0;
    const fetch = (async () => {
      upstream++;
      return sseResponse([STREAM]);
    }) as typeof globalThis.fetch;
    let t = 0;
    const m = wrapModel(model(fetch), [simpleCache({ ttlMs: 100, now: () => t })]);
    await m.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    t = 500; // past ttl
    await m.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    expect(upstream).toBe(2);
  });
});

describe('wrapModel — logging', () => {
  it('emits through an injected logger', async () => {
    const logs: string[] = [];
    const logger = {
      debug: (m: string) => logs.push('debug:' + m),
      info: (m: string) => logs.push('info:' + m),
      warn: () => {},
      error: () => {},
    };
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [logging({ logger })]);
    await m.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    expect(logs.some((l) => l.startsWith('debug:'))).toBe(true);
    expect(logs.some((l) => l.startsWith('info:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1.9: `deferStream` used to build a StreamChatResult with ONLY
// { textStream, fullStream, usage, finishReason } — so ONE logging middleware
// silently dropped runId (breaking durable sessions), observation and memory.
// ---------------------------------------------------------------------------

/** Never fires the long ttft/total timers; the mock model answers instantly. */
function idleClock(): Clock {
  return { now: () => 0, setTimeout: () => () => {} };
}

describe('wrapModel — deferStream forwards the FULL result shape (1.9)', () => {
  it('preserves runId / observation / memory / consume / warnings through the round-trip', async () => {
    const sessions = createInMemorySessionStore();
    const chats = createInMemoryChatStore();
    const events: string[] = [];
    let ids = 0;
    const m = wrapModel(createMockModel({ responses: [{ text: 'hi' }] }), [logging()]);

    const res = m.streamChat({
      messages: [{ role: 'user', content: 'yo' }],
      // `chat` routes even a tool-less call through the agentic loop, which is
      // what produces runId/memory/observation in the first place.
      session: { store: sessions },
      chat: { store: chats, chatId: 'c1', scope: { userId: 'u1' } },
      // Deliberately unusable seams: extraction fails INSIDE the loop, logs, and
      // still settles `memory` with [] — enough to prove the field survived.
      memory: { seams: {} as MemorySeams, scope: { userId: 'u1' } },
      deps: {
        clock: idleClock(),
        generateId: () => `id-${++ids}`,
        observer: {
          emit: (event) => {
            events.push(event.type);
          },
        },
      },
    });

    // Known SYNCHRONOUSLY, before anything is pulled (G2 lazy start).
    expect(res.runId).toBeDefined();
    expect(res.observation).toBeDefined();
    expect(res.memory).toBeDefined();
    expect(res.warnings).toBeDefined();
    expect(typeof res.consume).toBe('function');

    const parts: StreamPart[] = [];
    for await (const part of res.fullStream) parts.push(part);
    expect(await res.finishReason).toBe('stop');
    expect(parts.some((p) => p.type === 'step-start')).toBe(true);

    // runId is the one the INNER loop actually checkpointed under.
    expect(await sessions.load(res.runId!)).toBeDefined();
    expect(await res.memory).toEqual([]);
    // The test model's slug is not in the registry, so the conservative fallback
    // row now produces a real warning. Asserting the CONTENT (not `[]`) is what
    // proves deferStream forwards the channel rather than dropping it — `[]` used
    // to pass only because nothing ever emitted.
    expect((await res.warnings)?.map((w) => w.type)).toEqual(['unknown-model']);
    await expect(res.observation!.settled).resolves.toBeUndefined();
    expect(events).toContain('run.started');
  });

  it('omits the conditional fields when the call did not ask for them', () => {
    const m = wrapModel(createMockModel({ responses: [{ text: 'hi' }] }), [logging()]);
    const res = m.streamChat({
      messages: [{ role: 'user', content: 'yo' }],
      deps: { clock: idleClock(), generateId: () => 'fixed' },
    });
    expect(res.runId).toBeUndefined();
    expect(res.memory).toBeUndefined();
    expect(res.observation).toBeUndefined(); // no observer, no tracer
    expect(typeof res.consume).toBe('function'); // unconditional
  });

  it('consume() through a wrapped model runs the terminal effects with no iteration', async () => {
    const onFinish = vi.fn();
    const chats = createInMemoryChatStore();
    const m = wrapModel(createMockModel({ responses: [{ text: 'hi' }] }), [simpleCache()]);
    const res = m.streamChat({
      messages: [{ role: 'user', content: 'yo' }],
      chat: { store: chats, chatId: 'c9', scope: { userId: 'u1' } },
      onFinish,
      deps: { clock: idleClock(), generateId: () => 'fixed' },
    });
    expect(onFinish).not.toHaveBeenCalled();
    await expect(res.consume?.()).resolves.toBeUndefined();
    // G12 (1.9): EXACTLY once. This call routes through the agentic loop (`chat`),
    // which used to fire onFinish for the step's model call AND for the loop.
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(await chats.loadChat('c9')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 1.9: `wrapModel(m).streamChat({ prompt })` worked at RUNTIME (it forwards into
// the free functions, which own the fold) but did not TYPECHECK — WrappedModel's
// methods were typed against shapes that require `messages`. The prompt-shorthand
// overloads now mirror the free functions'. The compile-time half of these tests
// is `npm run typecheck` (vitest transpiles without checking); the runtime half is
// below.
// ---------------------------------------------------------------------------

describe('wrapModel — the prompt shorthand (1.9)', () => {
  it('generateText({ prompt }) compiles and reaches the wire as one user turn', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [logging()]);
    const res = await m.generateText({ prompt: 'Explain SSE in one sentence.' });
    expect(res.text).toBe('hi');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Explain SSE in one sentence.' }] },
    ]);
  });

  it('streamChat({ prompt, instructions }) compiles and folds both', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [logging()]);
    const res = m.streamChat({ prompt: 'hi there', instructions: 'You are terse.' });
    let text = '';
    for await (const c of res.textStream) text += c;
    expect(text).toBe('hi');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.system).toBe('You are terse.');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  it('folds BEFORE the chain, so a messages-reading middleware never sees the shorthand', async () => {
    // Both bundled middlewares below read `options.messages` directly — with the
    // fold left to the base function they would have thrown on `undefined`.
    const seen: unknown[] = [];
    const spy: LanguageModelMiddleware = {
      transformParams(o) {
        seen.push(o.messages);
        return o;
      },
    };
    const { fetch, calls } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [redactPII(), promptInjectionGuard(), spy]);
    const res = await m.generateText({ prompt: 'my key is sk-ant-abcdef0123456789XYZ' });
    expect(res.text).toBe('hi');
    expect(Array.isArray(seen[0])).toBe(true);
    expect(JSON.stringify(seen[0])).not.toContain('sk-ant-abcdef0123456789XYZ');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.system).toMatch(/untrusted DATA/i);
  });

  it('an invalid shape (prompt AND messages) still reports through the base function (G2)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [logging()]);
    // Deliberately illegal: the overloads reject this at compile time, so the
    // runtime guard is exercised through a widened value.
    const res = m.streamChat({
      prompt: 'hi',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as Parameters<typeof m.streamChat>[0]);
    const parts: StreamPart[] = [];
    for await (const part of res.fullStream) parts.push(part);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('error');
    expect(calls).toHaveLength(0); // never dialed
    // Awaiting ONLY `usage` (never `finishReason`) is the pin for `deferStream`'s
    // pre-attached no-op catch: without it the derived sibling promise rejects
    // unhandled and vitest fails the run with an unhandled rejection.
    await expect(res.usage).rejects.toBeDefined();
  });
});

describe('wrapModel — chain order', () => {
  it('runs transformParams first-listed → last (outermost first)', async () => {
    const order: string[] = [];
    const mk = (name: string): LanguageModelMiddleware => ({
      transformParams(o) {
        order.push(name);
        return o;
      },
    });
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    const m = wrapModel(model(fetch), [mk('a'), mk('b'), mk('c')]);
    await m.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
