/**
 * Compaction observation: per-layer events with ESTIMATE token counts and
 * message counts, summarize side-call as a tagged model event (usage counted
 * once), no-trigger silence, skip events, never-fails-the-run.
 */
import { describe, it, expect } from 'vitest';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, Message, ObserveEvent, JSONSchema } from '../src/index';

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

const SUMMARY = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1 } } },
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
      delta: { type: 'text_delta', text: 'CONDENSED.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 8 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const TOOLS = { search: { description: 'Search', parameters: SCHEMA, execute: async () => 'r' } };

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

describe('compaction observation', () => {
  it('below the threshold: NO compaction events at all', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'small' }],
      tools: TOOLS,
      maxSteps: 3,
      compaction: 'auto', // default threshold 0.92 — a tiny history never trips it
      deps: { observer: mem, clock: fastClock() },
    });
    expect(mem.events().some((e) => e.type === 'compaction')).toBe(false);
    expect(mem.events().some((e) => e.type === 'compaction.skipped')).toBe(false);
  });

  it('prune layers: one event per APPLIED layer with estimates + message counts, under the step span', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: bigHistory(6),
      tools: TOOLS,
      maxSteps: 3,
      compaction: {
        threshold: 0,
        keepRecentSteps: 1,
        layers: ['prune-tool-results', 'prune-reasoning'],
      },
      deps: { observer: mem, clock: fastClock() },
    });
    const compactions = mem.events().filter((e) => e.type === 'compaction') as Ev<'compaction'>[];
    expect(compactions.length).toBeGreaterThan(0);
    const first = compactions[0]!;
    expect(first).toMatchObject({
      layer: 'prune-tool-results',
      trigger: 'threshold',
      threshold: 0,
    });
    expect(first.tokensBefore).toBeGreaterThan(first.tokensAfter); // calibrated ESTIMATES
    expect(first.messageCountBefore).toBeGreaterThan(0);
    expect(first.contextWindow).toBeGreaterThan(0);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    // parents under the step span, tagged with the step index
    const step0 = mem.events().find((e) => e.type === 'step.started') as Ev<'step.started'>;
    expect(first.parentSpanId).toBe(step0.spanId);
    expect(first.stepIndex).toBe(0);
  });

  it('summarize side-call: tagged model events under the step, NO second run, usage counted once', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([SUMMARY]), // summarize side-call
      () => sseResponse([FINAL]), // the real step
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: bigHistory(6),
      tools: TOOLS,
      maxSteps: 3,
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['summarize'] },
      deps: { observer: mem, clock: fastClock() },
    });
    // two model.started: the tagged summary call + the real step call
    const models = mem.events().filter((e) => e.type === 'model.started') as Ev<'model.started'>[];
    expect(models).toHaveLength(2);
    expect(models[0]!.purpose).toBe('compaction-summary');
    expect(models[1]!.purpose).toBeUndefined();
    // exactly ONE run
    expect(mem.events().filter((e) => e.type === 'run.started')).toHaveLength(1);
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.modelCallCount).toBe(2); // side-call included
    // summarize usage (30+8) + step usage (20+6) — folded exactly once
    expect(done.usage.totalTokens).toBe(res.usage.totalTokens);
    expect(done.usage.totalTokens).toBe(64);
    // the compaction event itself fired for the summarize layer
    const compaction = mem.events().find((e) => e.type === 'compaction') as Ev<'compaction'>;
    expect(compaction.layer).toBe('summarize');
    expect(compaction.messageCountAfter).toBeLessThan(compaction.messageCountBefore);
  });

  it('a THROWING summarizer: compaction.skipped, run continues (never run.failed)', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }), // summarize side-call fails
      () => sseResponse([FINAL]), // the real step still runs
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: bigHistory(6),
      tools: TOOLS,
      maxSteps: 3,
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['summarize'] },
      deps: { observer: mem, clock: fastClock() },
    });
    expect(res.text).toBe('Done.');
    const skipped = mem
      .events()
      .find((e) => e.type === 'compaction.skipped') as Ev<'compaction.skipped'>;
    expect(skipped.layer).toBe('summarize');
    expect(skipped.reason.length).toBeGreaterThan(0);
    expect(mem.events().at(-1)!.type).toBe('run.completed');
    expect(mem.events().some((e) => e.type === 'compaction')).toBe(false); // nothing applied
  });
});
