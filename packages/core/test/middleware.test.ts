import { describe, it, expect } from 'vitest';
import {
  wrapModel,
  logging,
  simpleCache,
  redactPII,
  promptInjectionGuard,
  type LanguageModelMiddleware,
} from '../src/middleware';
import { createAnthropic } from '../src/anthropic';
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
