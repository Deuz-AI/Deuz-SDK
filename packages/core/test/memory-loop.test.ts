import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import {
  createInMemoryMemoryStore,
  type MemoryRecord,
  type MemorySeams,
  type MemoryCallOptions,
} from '../src/memory';
import type { ObserveEvent } from '../src/index';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

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

/** Assistant turn that suspends on a client-mode approval. */
const approvalTurn = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'rememberSecret' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
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

const NOW = 1_700_000_000_000;

/** A stored fact, ready to `upsert`. */
function rec(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text,
    hash: `h:${id}`,
    kind: 'semantic',
    scope: { userId: 'u1' },
    createdAt: NOW,
    updatedAt: NOW,
    validAt: NOW,
    ...over,
  };
}

/** The `system` block the Anthropic wire received, flattened to a string. */
function systemOf(call: { init?: RequestInit }): string {
  const body = JSON.parse(String(call.init!.body)) as { system?: Array<{ text: string }> | string };
  return Array.isArray(body.system)
    ? body.system.map((s) => s.text).join('\n')
    : (body.system ?? '');
}

/** Run one buffered turn with the given memory options and return the wire system block. */
async function recallBlockFor(
  shared: MemorySeams,
  recall: MemoryCallOptions['recall'],
): Promise<string> {
  const { fetch, calls } = mockFetch(() => sseResponse([finalTurn('ok')]));
  await generateText({
    model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
    messages: [{ role: 'user', content: 'coffee please' }],
    memory: { seams: shared, scope: { userId: 'u1' }, recall, extract: false },
    deps: { clock: fixedClock },
  });
  return systemOf(calls[0]!);
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
    const memoryLlm = vi.fn(async ({ system }: { system: string; user: string }) =>
      system.includes('extract durable')
        ? '{"facts":["User is allergic to peanuts"]}'
        : '{"memory":[{"text":"User is allergic to peanuts","event":"ADD"}]}',
    );
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'I am allergic to peanuts.' }],
      memory: {
        seams: {
          ...shared,
          llm: memoryLlm,
        },
        scope: { userId: 'u1' },
      },
      deps: { clock: fixedClock },
    });
    expect(result.text).toBe('Got it.');
    expect(result.response.messages).toHaveLength(1);
    expect(result.response.messages[0]).toMatchObject({ role: 'assistant' });
    const mutations = await result.memory!;
    expect(mutations[0]).toMatchObject({ op: 'upsert', event: 'ADD' });
    const extraction = memoryLlm.mock.calls.find(([prompt]) =>
      prompt.system.includes('extract durable'),
    )![0];
    expect(extraction.user.match(/Got it\./g)).toHaveLength(1);
  });

  it('buffered suspension exposes a settled empty memory promise unless extraction is disabled', async () => {
    const shared = seams();
    const execute = vi.fn(async () => 'done');
    const { fetch } = mockFetch(() => sseResponse([approvalTurn]));
    const common = {
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user' as const, content: 'save this' }],
      tools: {
        rememberSecret: {
          parameters: { type: 'object' as const, additionalProperties: false },
          execute,
          needsApproval: true,
        },
      },
      deps: { clock: fixedClock },
    };

    const suspended = await generateText({
      ...common,
      memory: { seams: shared, scope: { userId: 'u1' } },
    });
    expect(suspended.pendingApprovals).toHaveLength(1);
    expect(suspended.memory).toBeInstanceOf(Promise);
    expect(await suspended.memory).toEqual([]);
    expect(execute).not.toHaveBeenCalled();

    const disabled = await generateText({
      ...common,
      memory: { seams: shared, scope: { userId: 'u1' }, extract: false },
    });
    expect(disabled.pendingApprovals).toHaveLength(1);
    expect(disabled.memory).toBeUndefined();
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

describe('review fixes (adversarial pass 2)', () => {
  it('streamChat({ memory }) stays LAZY — no network until an output is consumed (G2)', async () => {
    const shared = seams();
    const { fetch, calls } = mockFetch(() => sseResponse([finalTurn('lazy')]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      memory: { seams: shared, scope: { userId: 'u1' } },
      deps: { clock: fixedClock },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0); // constructing the result must not start the pump
    for await (const _ of result.fullStream) void _;
    expect(calls).toHaveLength(1);
  });

  it('a mid-stream provider error still settles result.memory (never hangs)', async () => {
    const shared = seams();
    const errStream = sseEvents([
      {
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: 'boom' } },
      },
    ]);
    const { fetch } = mockFetch(() => sseResponse([errStream]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      memory: { seams: shared, scope: { userId: 'u1' } },
      deps: { clock: fixedClock },
    });
    const parts: Array<{ type: string }> = [];
    for await (const p of result.fullStream) parts.push(p);
    expect(parts.at(-1)?.type).toBe('error');
    expect(await result.memory!).toEqual([]); // settled, not hung
  });

  it('the recall block reaches the MODEL but never the persisted history', async () => {
    const { createInMemoryChatStore } = await import('../src/chat');
    const shared = seams();
    await shared.store.upsert([
      {
        id: 'm-0',
        text: 'User prefers dark roast coffee',
        hash: 'h:coffee',
        kind: 'semantic',
        scope: { userId: 'u1' },
        createdAt: 1,
        updatedAt: 1,
        validAt: 1,
      },
    ]);
    const chatStore = createInMemoryChatStore();
    const { fetch, calls } = mockFetch(() => sseResponse([finalTurn('Dark roast!')]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'Order me a coffee.' }],
      memory: { seams: shared, scope: { userId: 'u1' } },
      chat: { store: chatStore, chatId: 'c1', scope: { userId: 'u1', chatId: 'c1' } },
      deps: { clock: fixedClock },
    });
    for await (const _ of result.fullStream) void _;

    const body = JSON.parse(String(calls[0]!.init!.body)) as { system?: unknown };
    expect(JSON.stringify(body.system ?? '')).toContain('dark roast'); // model saw it
    const saved = (await chatStore.loadChat('c1'))!;
    expect(JSON.stringify(saved.messages)).not.toContain('Relevant memories'); // history clean
    expect(saved.messages.some((m) => m.role === 'system')).toBe(false);
  });
});

describe('recall options reach the pipeline (2.0)', () => {
  it("scorer: 'default' reranks the hits; omitting it keeps the raw store order", async () => {
    const shared = seams();
    // Both match the query text, so the store scores them identically and
    // returns them in insertion order. Only importance separates them.
    await shared.store.upsert([
      rec('m-a', 'coffee note ALPHA', { importance: 0 }),
      rec('m-b', 'coffee note BETA', { importance: 1 }),
    ]);

    const raw = await recallBlockFor(shared, undefined);
    expect(raw.indexOf('ALPHA')).toBeLessThan(raw.indexOf('BETA'));

    const scored = await recallBlockFor(shared, { scorer: 'default' });
    // recency + relevance are equal, so the importance term decides.
    expect(scored.indexOf('BETA')).toBeLessThan(scored.indexOf('ALPHA'));
  });

  it('scorer accepts a MemoryScorer instance verbatim', async () => {
    const shared = seams();
    await shared.store.upsert([rec('m-a', 'coffee ALPHA'), rec('m-b', 'coffee BETA')]);
    const score = vi.fn((record: MemoryRecord) => (record.id === 'm-b' ? 10 : 1));
    const block = await recallBlockFor(shared, { scorer: { score } });
    expect(score).toHaveBeenCalledTimes(2);
    expect(block.indexOf('BETA')).toBeLessThan(block.indexOf('ALPHA'));
  });

  it('maxChars caps the rendered block (unbounded without it)', async () => {
    const shared = seams();
    await shared.store.upsert([
      rec('m-a', `coffee ${'A'.repeat(200)}`),
      rec('m-b', `coffee ${'B'.repeat(200)}`),
    ]);

    const unbounded = await recallBlockFor(shared, undefined);
    expect(unbounded).toContain('A'.repeat(200));
    expect(unbounded).toContain('B'.repeat(200));

    const capped = await recallBlockFor(shared, { maxChars: 60 });
    expect(capped).toContain('Relevant memories:');
    expect(capped).not.toContain('B'.repeat(200));
    // The block itself is ≤ maxChars; the wire system string carries nothing else.
    expect(capped.length).toBeLessThanOrEqual(60);
  });

  it('expandLinks walks the graph into the block', async () => {
    const shared = seams();
    await shared.store.upsert([
      rec('m-a', 'coffee is the topic', { metadata: { links: ['m-b'] } }),
      // Deliberately does NOT match the query text — only the link can pull it in.
      rec('m-b', 'the neighbour fact'),
    ]);

    // topK 1 keeps the store's own answer to a single record, so anything else
    // in the block can only have arrived through the graph.
    const flat = await recallBlockFor(shared, { topK: 1 });
    expect(flat).toContain('coffee is the topic');
    expect(flat).not.toContain('the neighbour fact');

    const expanded = await recallBlockFor(shared, { topK: 1, expandLinks: 1 });
    expect(expanded).toContain('coffee is the topic');
    expect(expanded).toContain('the neighbour fact');
    // Linked records are APPENDED — the primaries keep the head of the block.
    expect(expanded.indexOf('coffee is the topic')).toBeLessThan(
      expanded.indexOf('the neighbour fact'),
    );
  });

  it('header still applies alongside the new options', async () => {
    const shared = seams();
    await shared.store.upsert([rec('m-a', 'coffee ALPHA')]);
    const block = await recallBlockFor(shared, { header: 'What I know:', scorer: 'default' });
    expect(block).toContain('What I know:');
    expect(block).not.toContain('Relevant memories:');
  });
});

describe('writePolicy + sweep (2.0)', () => {
  const stored = (shared: MemorySeams) => shared.store.list({ userId: 'u1' });

  it.each(['session-end', 'manual'] as const)(
    "writePolicy: '%s' suppresses the loop's auto-extract (no result.memory, no writes)",
    async (writePolicy) => {
      const shared = seams();
      const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
      const result = await generateText({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'I only drink dark roast.' }],
        memory: { seams: shared, scope: { userId: 'u1' }, writePolicy },
        deps: { clock: fixedClock },
      });
      expect(result.text).toBe('Got it.');
      expect(result.memory).toBeUndefined();
      expect(await stored(shared)).toEqual([]);
    },
  );

  it("writePolicy: 'each-turn' is the pre-2.0 behavior", async () => {
    const shared = seams();
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'I only drink dark roast.' }],
      memory: { seams: shared, scope: { userId: 'u1' }, writePolicy: 'each-turn' },
      deps: { clock: fixedClock },
    });
    expect(await result.memory!).toHaveLength(1);
    expect(await stored(shared)).toHaveLength(1);
  });

  it('streaming keeps result.memory as a SETTLED empty promise under a suppressing policy', async () => {
    const shared = seams();
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'I only drink dark roast.' }],
      memory: { seams: shared, scope: { userId: 'u1' }, writePolicy: 'manual' },
      deps: { clock: fixedClock },
    });
    for await (const _ of result.fullStream) void _;
    // `extract` was not disabled, so the field still exists (stream parity) —
    // it just resolves empty, and nothing was written.
    expect(await result.memory!).toEqual([]);
    expect(await stored(shared)).toEqual([]);
  });

  it("sweep: 'on-extract' garbage-collects expired records after the extraction settles", async () => {
    const shared = seams();
    await shared.store.upsert([
      rec('m-dead', 'stale fact', { expiresAt: NOW - 1 }),
      rec('m-live', 'living fact', { expiresAt: NOW + 60_000 }),
    ]);
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'I only drink dark roast.' }],
      memory: { seams: shared, scope: { userId: 'u1' }, sweep: 'on-extract' },
      deps: { clock: fixedClock },
    });
    // The sweep is chained AFTER the extraction and never joins result.memory.
    await result.memory!;
    await new Promise((r) => setTimeout(r, 0));
    const ids = (await stored(shared)).map((r) => r.id);
    expect(ids).not.toContain('m-dead');
    expect(ids).toContain('m-live');
  });

  it("sweep defaults to 'never' — an expired record survives the turn", async () => {
    const shared = seams();
    await shared.store.upsert([rec('m-dead', 'stale fact', { expiresAt: NOW - 1 })]);
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'I only drink dark roast.' }],
      memory: { seams: shared, scope: { userId: 'u1' } },
      deps: { clock: fixedClock },
    });
    await result.memory!;
    await new Promise((r) => setTimeout(r, 0));
    expect((await stored(shared)).map((r) => r.id)).toContain('m-dead');
  });
});

describe('memory observability (2.0)', () => {
  const opsOf = (events: readonly ObserveEvent[], operation: string) =>
    events.filter(
      (e) =>
        (e.type === 'operation.started' ||
          e.type === 'operation.completed' ||
          e.type === 'operation.failed') &&
        e.operation === operation,
    );

  it('emits operation.started/completed for recall and extract, under the run span', async () => {
    const mem = createMemoryObserver();
    const shared = seams();
    await shared.store.upsert([rec('m-a', 'coffee ALPHA'), rec('m-b', 'coffee BETA')]);
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'coffee please' }],
      memory: { seams: shared, scope: { userId: 'u1' } },
      deps: { clock: fixedClock, observer: mem },
    });
    await result.memory!;

    const run = mem.events().find((e) => e.type === 'run.started') as Ev<'run.started'>;
    const recall = opsOf(mem.events(), 'memory.recall');
    expect(recall.map((e) => e.type)).toEqual(['operation.started', 'operation.completed']);
    expect(recall[0]).toMatchObject({ subsystem: 'memory', parentSpanId: run.spanId });
    expect(recall[1]).toMatchObject({ subsystem: 'memory', resultCount: 2 });
    expect((recall[1] as Ev<'operation.completed'>).durationMs).toBeGreaterThanOrEqual(0);
    // Both halves of one operation share a span.
    expect(recall[1]!.spanId).toBe(recall[0]!.spanId);

    const extract = opsOf(mem.events(), 'memory.extract');
    expect(extract.map((e) => e.type)).toEqual(['operation.started', 'operation.completed']);
    expect(extract[1]).toMatchObject({ subsystem: 'memory', resultCount: 1 });
    expect(extract[0]).toMatchObject({ parentSpanId: run.spanId });
  });

  it('a failing store reports operation.failed and the run still completes', async () => {
    const mem = createMemoryObserver();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const broken = seams({
      store: {
        ...createInMemoryMemoryStore(),
        search: () => {
          throw new Error('store down');
        },
      },
    });
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Still fine.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'coffee please' }],
      memory: { seams: broken, scope: { userId: 'u1' }, extract: false },
      deps: { clock: fixedClock, observer: mem, logger },
    });
    expect(result.text).toBe('Still fine.');
    const recall = opsOf(mem.events(), 'memory.recall');
    expect(recall.map((e) => e.type)).toEqual(['operation.started', 'operation.failed']);
    expect(mem.events().at(-1)!.type).toBe('run.completed');
  });

  it('the recall block is counted into the step estimate (compaction accounting)', async () => {
    // A constant tokenizer makes the arithmetic exact: the history counts 1000
    // and so does the spliced recall block, so a step that carries one must
    // report 2000 — otherwise the block is invisible to both the compaction
    // threshold and the EMA calibration.
    const countTokens = () => 1000;
    const step0 = async (recallOn: boolean): Promise<number | undefined> => {
      const mem = createMemoryObserver();
      const shared = seams();
      await shared.store.upsert([rec('m-a', 'coffee ALPHA')]);
      const { fetch } = mockFetch(() => sseResponse([finalTurn('ok')]));
      await generateText({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'coffee please' }],
        memory: {
          seams: shared,
          scope: { userId: 'u1' },
          extract: false,
          ...(recallOn ? {} : { recall: false as const }),
        },
        compaction: { countTokens },
        deps: { clock: fixedClock, observer: mem },
      });
      const started = mem.events().find((e) => e.type === 'step.started') as Ev<'step.started'>;
      return started.estimatedInputTokens;
    };

    expect(await step0(false)).toBe(1000);
    expect(await step0(true)).toBe(2000);
  });

  it('WITHOUT an observer nothing is emitted and no ids are drawn (fast path)', async () => {
    const shared = seams();
    await shared.store.upsert([rec('m-a', 'coffee ALPHA')]);
    const generateId = vi.fn(() => 'fixed-id');
    const { fetch } = mockFetch(() => sseResponse([finalTurn('Got it.')]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'coffee please' }],
      memory: { seams: shared, scope: { userId: 'u1' } },
      deps: { clock: fixedClock, generateId },
    });
    await result.memory!;
    expect(generateId).not.toHaveBeenCalled();
    expect(result.observation).toBeUndefined();
  });
});
