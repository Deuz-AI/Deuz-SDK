/**
 * The compaction SUMMARY is a loop-internal side call, not a run of its own.
 *
 * It goes out as an ordinary single-turn model call, which is exactly why the
 * pump that runs it used to fire the caller's `onFinish`: G12 gates that firing
 * on "a loop drives this call" (`internal.tools`), and the tool-free summarize
 * clone does not look like a loop step. The caller then received a terminal
 * event for a call it never made — and 2.0's overflow auto-recovery made the
 * side call reachable on runs that never opted into compaction at all.
 *
 * `onUsage` is deliberately NOT suppressed: it is per-MODEL-CALL by contract
 * (`core/metering.ts`, G10/G12) and the summary really does burn tokens, so a
 * credit system must keep seeing them.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, JSONSchema, Message } from '../src/index';

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

const turn = (text: string): string =>
  sseEvents([
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

const summary = (): Response => sseResponse([turn('Earlier: the user asked things.')]);
const final = (): Response => sseResponse([turn('Done.')]);

/** Anthropic's over-long-prompt shape (mapped to ContextOverflowError by the adapter). */
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

/** Long enough to leave ≥2 unprotected messages for the summarize layer. */
const HISTORY: Message[] = [
  { role: 'user', content: 'Original task.' },
  { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(400) }] },
  { role: 'user', content: 'y'.repeat(400) },
  { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(400) }] },
  { role: 'user', content: 'Current question.' },
];

const SUMMARIZE_ALWAYS = {
  threshold: 0.000_001,
  keepRecentSteps: 1,
  layers: ['summarize'] as const,
};
/** Threshold 1 never trips on its own — only the FORCED overflow pass compacts. */
const SUMMARIZE_ON_OVERFLOW = { threshold: 1, keepRecentSteps: 1, layers: ['summarize'] as const };

const model = (fetch: typeof globalThis.fetch) =>
  createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');

describe('compaction summary side call — buffered loop', () => {
  it('does not fire the caller’s onFinish (the caller never made that call)', async () => {
    const { fetch, calls } = mockFetchSequence([summary, final]);
    const finishes: unknown[] = [];
    const usages: unknown[] = [];

    const res = await generateText({
      model: model(fetch),
      messages: HISTORY,
      tools: TOOLS,
      compaction: { ...SUMMARIZE_ALWAYS, layers: [...SUMMARIZE_ALWAYS.layers] },
      onFinish: (meta) => finishes.push(meta),
      onUsage: (usage) => usages.push(usage),
      deps: { clock: fastClock() },
    });

    expect(calls).toHaveLength(2); // the summary, then the step
    expect(res.text).toBe('Done.');
    expect(finishes).toHaveLength(1);
    // The side call still METERS: usage fires per model call, and the summary's
    // tokens are folded into the run total.
    expect(usages).toHaveLength(2);
    expect(res.usage.totalTokens).toBe(52); // 26 per turn
  });

  it('fires onFinish exactly once on an overflow-recovered run', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, summary, final]);
    const finishes: unknown[] = [];

    const res = await generateText({
      model: model(fetch),
      messages: HISTORY,
      tools: TOOLS,
      compaction: { ...SUMMARIZE_ON_OVERFLOW, layers: [...SUMMARIZE_ON_OVERFLOW.layers] },
      onFinish: (meta) => finishes.push(meta),
      deps: { clock: fastClock() },
    });

    expect(calls).toHaveLength(3); // rejected attempt, summary, retry
    expect(res.text).toBe('Done.');
    expect(finishes).toHaveLength(1);
  });
});

describe('compaction summary side call — streaming loop', () => {
  it('does not fire the caller’s onFinish', async () => {
    const { fetch, calls } = mockFetchSequence([summary, final]);
    const finishes: unknown[] = [];

    const res = streamChat({
      model: model(fetch),
      messages: HISTORY,
      tools: TOOLS,
      compaction: { ...SUMMARIZE_ALWAYS, layers: [...SUMMARIZE_ALWAYS.layers] },
      onFinish: (meta) => finishes.push(meta),
      deps: { clock: fastClock() },
    });
    const text: string[] = [];
    for await (const t of res.textStream) text.push(t);
    await res.consume?.();

    expect(calls).toHaveLength(2);
    expect(text.join('')).toBe('Done.');
    expect(finishes).toHaveLength(1);
  });

  it('fires onFinish exactly once on an overflow-recovered run', async () => {
    const { fetch, calls } = mockFetchSequence([overflow, summary, final]);
    const finishes: unknown[] = [];

    const res = streamChat({
      model: model(fetch),
      messages: HISTORY,
      tools: TOOLS,
      compaction: { ...SUMMARIZE_ON_OVERFLOW, layers: [...SUMMARIZE_ON_OVERFLOW.layers] },
      onFinish: (meta) => finishes.push(meta),
      deps: { clock: fastClock() },
    });
    const text: string[] = [];
    for await (const t of res.textStream) text.push(t);
    await res.consume?.();

    expect(calls).toHaveLength(3);
    expect(text.join('')).toBe('Done.');
    expect(finishes).toHaveLength(1);
  });
});
