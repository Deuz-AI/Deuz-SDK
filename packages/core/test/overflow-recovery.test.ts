/**
 * Overflow auto-recovery (2.0): a provider that rejects the request as too long
 * force-compacts the history and retries the SAME step once — in both loops.
 *
 * The invariants under test:
 *  - ONE retry per step; a second overflow in the same step propagates verbatim.
 *  - The forced pass is labelled `trigger: 'overflow'` on the observation event
 *    and on the streaming `compaction` part.
 *  - It works with NO `compaction` option at all (a throwaway `'auto'` runner).
 *  - A pass that changes nothing (reference-equal) is NOT a recovery: the
 *    original `ContextOverflowError` propagates instead of a second doomed call.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { ContextOverflowError } from '../src/errors';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, JSONSchema, Message, ObserveEvent, StreamPart } from '../src/index';

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
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

const TOOLS = { search: { description: 'Search', parameters: SCHEMA, execute: async () => 'r' } };

const FINAL = sseEvents([
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
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

/**
 * Anthropic's over-long-prompt shape: a plain 400 whose MESSAGE is the only
 * signal (adapters/anthropic.ts maps it to ContextOverflowError, 2.0).
 */
const overflow = (): Response =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 210000 tokens > 200000 maximum',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

const final = (): Response => sseResponse([FINAL]);

/** [system, user, (assistant reasoning+tool_use, tool_result) × turns, user question]. */
function bigHistory(turns: number): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'Original task.' },
  ];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking '.repeat(20) },
        { type: 'tool_use', id: `old_${i}`, name: 'search', input: { q: `old ${i}` } },
      ],
    });
    msgs.push({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: `old_${i}`, result: 'z'.repeat(400) }],
    });
  }
  msgs.push({ role: 'user', content: 'Current question.' });
  return msgs;
}

/** Threshold 1 never trips on its own — only the FORCED pass can compact. */
const PRUNE_ONLY = {
  threshold: 1,
  keepRecentSteps: 1,
  layers: ['prune-tool-results'] as const,
};

const model = (fetch: typeof globalThis.fetch) =>
  createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');

describe('overflow auto-recovery — buffered loop', () => {
  it('force-compacts and retries the step once, tagging the pass as overflow', async () => {
    const mem = createMemoryObserver();
    const { fetch, calls } = mockFetchSequence([overflow, final]);
    const res = await generateText({
      model: model(fetch),
      messages: bigHistory(6),
      tools: TOOLS,
      compaction: { ...PRUNE_ONLY, layers: [...PRUNE_ONLY.layers] },
      deps: { observer: mem, clock: fastClock() },
    });

    expect(res.text).toBe('Done.');
    expect(calls).toHaveLength(2);
    // The FIRST attempt carried the raw history; the RETRY carried the pruned one.
    expect(String(calls[0]!.init!.body)).not.toContain('[pruned');
    expect(String(calls[1]!.init!.body)).toContain('[pruned');

    const compactions = mem.events().filter((e) => e.type === 'compaction') as Ev<'compaction'>[];
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.trigger).toBe('overflow');
    expect(compactions[0]!.layer).toBe('prune-tool-results');
    // The run completed — recovery is not a failure.
    expect(mem.events().at(-1)!.type).toBe('run.completed');
  });

  it('retries at most ONCE per step: a second overflow propagates', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, overflow]);
    await expect(
      generateText({
        model: model(fetch),
        messages: bigHistory(6),
        tools: TOOLS,
        compaction: { ...PRUNE_ONLY, layers: [...PRUNE_ONLY.layers] },
        deps: { clock: fastClock() },
      }),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(calls).toHaveLength(2); // one original + exactly one retry
  });

  it('recovers with NO compaction option at all (throwaway auto runner)', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, final]);
    const res = await generateText({
      model: model(fetch),
      messages: bigHistory(6),
      tools: TOOLS,
      deps: { clock: fastClock() },
    });
    expect(res.text).toBe('Done.');
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.init!.body)).toContain('[pruned');
  });

  it('propagates the ORIGINAL error when the forced pass changes nothing', async () => {
    // A single protected user turn: every layer declines, so the recovery
    // returns the input by reference and there is nothing to retry with.
    const { fetch, calls } = mockFetchSequence([overflow, final]);
    await expect(
      generateText({
        model: model(fetch),
        messages: [{ role: 'user', content: 'hi' }],
        tools: TOOLS,
        deps: { clock: fastClock() },
      }),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(calls).toHaveLength(1); // no doomed second call
  });

  it('a NON-overflow rejection is never retried', async () => {
    const authFail = (): Response =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const { fetch, calls } = mockFetchSequence([authFail, final]);
    await expect(
      generateText({
        model: model(fetch),
        messages: bigHistory(6),
        tools: TOOLS,
        deps: { clock: fastClock() },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('overflow auto-recovery — streaming loop', () => {
  it('force-compacts and retries, emitting an overflow-tagged compaction part and NO error', async () => {
    const mem = createMemoryObserver();
    const { fetch, calls } = mockFetchSequence([overflow, final]);
    const res = streamChat({
      model: model(fetch),
      messages: bigHistory(6),
      tools: TOOLS,
      compaction: { ...PRUNE_ONLY, layers: [...PRUNE_ONLY.layers] },
      deps: { observer: mem, clock: fastClock() },
    });
    const parts: StreamPart[] = [];
    for await (const p of res.fullStream) parts.push(p);

    expect(parts.some((p) => p.type === 'error')).toBe(false);
    expect(parts.filter((p) => p.type === 'step-start')).toHaveLength(1); // ONE step, retried
    const compaction = parts.find((p) => p.type === 'compaction');
    expect(compaction).toMatchObject({ layer: 'prune-tool-results', trigger: 'overflow' });
    expect(await res.finishReason).toBe('stop');
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.init!.body)).toContain('[pruned');

    const observed = mem.events().filter((e) => e.type === 'compaction') as Ev<'compaction'>[];
    expect(observed).toHaveLength(1);
    expect(observed[0]!.trigger).toBe('overflow');
  });

  it('retries at most ONCE per step: a second overflow becomes the error part', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, overflow]);
    const res = streamChat({
      model: model(fetch),
      messages: bigHistory(6),
      tools: TOOLS,
      compaction: { ...PRUNE_ONLY, layers: [...PRUNE_ONLY.layers] },
      deps: { clock: fastClock() },
    });
    const parts: StreamPart[] = [];
    for await (const p of res.fullStream) parts.push(p);
    const error = parts.at(-1);
    expect(error?.type).toBe('error');
    expect((error as { error: unknown }).error).toBeInstanceOf(ContextOverflowError);
    await expect(res.usage).rejects.toBeInstanceOf(ContextOverflowError);
    expect(calls).toHaveLength(2);
  });

  it('recovers with NO compaction option (throwaway auto runner)', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, final]);
    const res = streamChat({
      model: model(fetch),
      messages: bigHistory(6),
      tools: TOOLS,
      deps: { clock: fastClock() },
    });
    const text: string[] = [];
    for await (const t of res.textStream) text.push(t);
    expect(text.join('')).toBe('Done.');
    expect(calls).toHaveLength(2);
  });

  it('propagates the ORIGINAL error when the forced pass changes nothing', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, final]);
    const res = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      deps: { clock: fastClock() },
    });
    const parts: StreamPart[] = [];
    for await (const p of res.fullStream) parts.push(p);
    expect(parts.at(-1)?.type).toBe('error');
    expect(parts.some((p) => p.type === 'compaction')).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
