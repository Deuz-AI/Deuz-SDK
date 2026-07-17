import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createInMemoryMemoryStore, type MemorySeams, type MemoryCallOptions } from '../src/memory';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const fixedClock = {
  now: () => 1_700_000_000_000,
  setTimeout: (fn: () => void, _ms: number) => (setTimeout(fn, 0), () => {}),
};

/** Assistant reply fixture. */
function finalTurn(text: string): string {
  return sseEvents([
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
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
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
}

/**
 * Scripted mem0 LLM: the EXTRACTION prompt yields one durable fact; the
 * RECONCILE prompt ADDs every new fact (no id → ADD, mem0 protocol).
 */
const scriptedLlm = async ({ system }: { system: string; user: string }): Promise<string> => {
  if (system.includes('extract durable')) {
    return '{"facts": ["User prefers dark roast coffee"]}';
  }
  return '{"memory": [{"text": "User prefers dark roast coffee", "event": "ADD"}]}';
};

function seams(over: Partial<MemorySeams> = {}): MemorySeams {
  let id = 0;
  return {
    store: createInMemoryMemoryStore(),
    llm: scriptedLlm,
    clock: fixedClock,
    generateId: () => `mem-${id++}`,
    hashFn: async (t: string) => `h:${t}`,
    ...over,
  };
}

describe('useChat-grade memory × loop (D1)', () => {
  it('session A extracts; session B recalls into the system context (E2E)', async () => {
    const shared = seams();
    const memory: MemoryCallOptions = { seams: shared, scope: { userId: 'u1', chatId: 'c1' } };

    // --- Session A: the model learns something about the user. ---
    const a = mockFetch(() => sseResponse([finalTurn('Noted — dark roast it is.')]));
    const resultA = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'Remember: I only drink dark roast coffee.' }],
      memory,
      deps: { clock: fixedClock },
    });
    for await (const _ of resultA.fullStream) void _;
    const mutations = await resultA.memory!;
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ op: 'upsert', event: 'ADD' });

    // The fact landed in the store, scoped.
    const stored = await shared.store.list({ userId: 'u1', chatId: 'c1' });
    expect(stored.some((r) => r.text.includes('dark roast'))).toBe(true);

    // --- Session B (fresh history): recall feeds the system context. ---
    const b = mockFetch(() => sseResponse([finalTurn('A dark roast for you!')]));
    const resultB = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: b.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'Order me a coffee.' }],
      memory,
      deps: { clock: fixedClock },
    });
    for await (const _ of resultB.fullStream) void _;

    const body = JSON.parse(String(b.calls[0]!.init!.body)) as {
      system?: Array<{ text: string }> | string;
    };
    const systemText = Array.isArray(body.system)
      ? body.system.map((s) => s.text).join('\n')
      : (body.system ?? '');
    expect(systemText).toContain('Relevant memories:');
    expect(systemText).toContain('dark roast');
  });

  it('buffered generateText exposes result.memory the same way', async () => {
    const shared = seams();
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'I am allergic to peanuts.' }],
      memory: {
        seams: {
          ...shared,
          llm: async ({ system }) =>
            system.includes('extract durable')
              ? '{"facts":["User is allergic to peanuts"]}'
              : '{"memory":[{"text":"User is allergic to peanuts","event":"ADD"}]}',
        },
        scope: { userId: 'u1' },
      },
      deps: { clock: fixedClock },
    });
    expect(result.text).toBe('Got it.');
    const mutations = await result.memory!;
    expect(mutations[0]).toMatchObject({ op: 'upsert', event: 'ADD' });
  });

  it('recall failure degrades to a bare call; extraction failure resolves []', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const broken = seams({
      store: {
        ...createInMemoryMemoryStore(),
        search: () => {
          throw new Error('store down');
        },
        upsert: () => {
          throw new Error('store down');
        },
      },
      llm: async () => '{"facts":["x"]}',
    });
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Still fine.')]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      memory: { seams: broken, scope: { userId: 'u1' } },
      deps: { clock: fixedClock, logger },
    });
    const text: string[] = [];
    for await (const t of result.textStream) text.push(t);
    expect(text.join('')).toBe('Still fine.');
    expect(await result.memory!).toEqual([]); // never rejects
    expect(logger.error).toHaveBeenCalled();
  });

  it('without the memory option nothing changes (no loop routing, no field)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([finalTurn('plain')]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: Array<{ type: string }> = [];
    for await (const p of result.fullStream) parts.push(p);
    expect(result.memory).toBeUndefined();
    expect(parts.some((p) => p.type === 'step-start')).toBe(false); // single-turn path
    const body = JSON.parse(String(calls[0]!.init!.body)) as { system?: unknown };
    expect(body.system).toBeUndefined();
  });
});
