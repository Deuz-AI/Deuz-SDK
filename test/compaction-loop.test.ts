import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import type { StreamPart } from '../src/types/stream';
import type { Message } from '../src/types/message';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

const TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
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
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

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
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

/** A summarize side-call: plain text, no tool. Usage 30 in / 8 out. */
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
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const search = vi.fn(async () => 'result');
const TOOLS = { search: { description: 'Search', parameters: SCHEMA, execute: search } };

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
    msgs.push({ role: 'tool', content: [{ type: 'tool_result', toolUseId: `old_${i}`, result: 'z'.repeat(400) }] });
  }
  msgs.push({ role: 'user', content: 'Current question.' });
  return msgs;
}

describe('compaction wired into the loop', () => {
  it('is byte-identical to no-compaction when disabled', async () => {
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 5,
    });
    expect(res.text).toBe('Done.');
    // Pre-existing loop contract: response.messages carries the appended
    // assistant tool turn + tool result; the final text-only assistant rides
    // res.text/res.steps, not response.messages.
    expect(res.response.messages).toHaveLength(2);
    expect(res.response.messages[0]!.role).toBe('assistant');
    expect(res.response.messages[1]!.role).toBe('tool');
  });

  it('prune layers compact the prior history before each step; question survives; response.messages stays correct', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: bigHistory(6),
      tools: TOOLS,
      maxSteps: 5,
      // Prune-only: no summarize side-call → deterministic 2 fetches.
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['prune-tool-results', 'prune-reasoning'] },
    });
    expect(res.text).toBe('Done.');
    expect(calls).toHaveLength(2);

    // The first model call received a COMPACTED history: old tool results pruned,
    // but the current question is untouched.
    const body0 = JSON.stringify(JSON.parse(String(calls[0]!.init!.body)).messages);
    expect(body0).toContain('[pruned');
    expect(body0).toContain('Current question.');

    // response.messages is unaffected by the history rewrite — only what this
    // call appended (assistant tool turn + tool result).
    expect(res.response.messages).toHaveLength(2);
    expect(res.response.messages[0]!.role).toBe('assistant');
    expect(res.response.messages[1]!.role).toBe('tool');
  });

  it('summarize side-call folds its usage into the total and compacts the wire', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([SUMMARY]), // compaction summarize side-call (before the step)
      () => sseResponse([FINAL]), // the model step (no tool → loop ends)
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: bigHistory(6),
      tools: TOOLS,
      maxSteps: 5,
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['summarize'] },
    });
    expect(res.text).toBe('Done.');
    expect(calls).toHaveLength(2);
    // Side-call 0 is the summarizer — and it is USER-FIRST (a raw assistant-led
    // slice would 400 on Anthropic). The transcript rides one user message.
    const summaryMessages = JSON.parse(String(calls[0]!.init!.body)).messages;
    expect(summaryMessages[0].role).toBe('user');
    expect(JSON.stringify(summaryMessages)).toContain('Summarize the conversation');
    // Model call 1 got the summarized history + the surviving question.
    const modelWire = JSON.stringify(JSON.parse(String(calls[1]!.init!.body)).messages);
    expect(modelWire).toContain('Earlier conversation summarized');
    expect(modelWire).toContain('Current question.');
    // Usage folds summary (30+8) + the FINAL step (20+6) = 64.
    expect(res.usage.totalTokens).toBe(64);
  });

  it('streaming: emits a compaction part after step-start, before finish', async () => {
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    const res = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: bigHistory(6),
      tools: TOOLS,
      // prune-reasoning only → no side-call, deterministic single fetch.
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['prune-reasoning'] },
    });
    const types: StreamPart['type'][] = [];
    for await (const part of res.fullStream) types.push(part.type);
    const firstStep = types.indexOf('step-start');
    const firstCompaction = types.indexOf('compaction');
    expect(firstCompaction).toBeGreaterThan(firstStep);
    expect(types.indexOf('finish')).toBeGreaterThan(firstCompaction);
    expect(types).not.toContain('error');
  });
});
