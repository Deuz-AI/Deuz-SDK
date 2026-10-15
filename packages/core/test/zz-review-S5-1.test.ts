import { describe, it, expect, vi } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createInMemorySessionStore, resumeDeuzChatResponse } from '../src/durable';
import { toDeuzStreamResponse, createInMemoryDurableStreamStateStore } from '../src/ui';
import { createInMemoryLeaseProvider } from '../src/ops';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};
const TOOL_CALL = sseEvents([
  { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const FINAL = sseEvents([
  { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'RESUMER ANSWER' } } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const instantClock = {
  setTimeout: (fn: () => void, _ms: number) => {
    const id = globalThis.setTimeout(fn, 0);
    return () => globalThis.clearTimeout(id);
  },
};

describe('S5 probe: refused durable continuation leg', () => {
  it('a refused leg (live quiet producer holds the lease) does not re-drive the run', async () => {
    const sessionStore = createInMemorySessionStore();
    const store = createInMemoryDurableStreamStateStore();
    const provider = createInMemoryLeaseProvider();
    const executeA = vi.fn(async () => 'found');
    // Producer A: step 1 (tool) completes and is checkpointed; step 2's model call is slow (alive, quiet).
    const slow = new Promise<Response>(() => {});
    const leg1 = mockFetchSequence([() => sseResponse([TOOL_CALL]), () => slow as never]);
    const result1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'find x' }],
      tools: { search: { parameters: SCHEMA, execute: executeA } },
      maxSteps: 5,
      session: { store: sessionStore, runId: 'run-5' },
    });
    const live = toDeuzStreamResponse(result1, {
      durable: { store, lease: { provider, owner: 'a' }, batch: { maxDelayMs: 0 } },
      streamId: 'run-5',
      messageId: 'm1',
    });
    const reader = live.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('tool-result')) {
      const { value } = await reader.read();
      seen += dec.decode(value);
    }
    // let A's checkpoint land and A reach its slow model call
    await new Promise((r) => setTimeout(r, 50));
    expect(leg1.calls.length).toBe(2);
    const before = await sessionStore.load('run-5');
    expect(before).toBeTruthy();

    const leg2 = mockFetchSequence([() => sseResponse([FINAL])]);
    const executeB = vi.fn(async () => 'found');
    const text = await resumeDeuzChatResponse({
      sessionStore,
      streamStateStore: store,
      durable: { store, lease: { provider, owner: 'resumer' } },
      runId: 'run-5',
      streamId: 'run-5',
      lastEventId: '1',
      call: {
        model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
        tools: { search: { parameters: SCHEMA, execute: executeB } },
      },
      liveProbeMs: 10,
      pollIntervalMs: 2,
      clock: instantClock,
    }).text();
    expect(text).toContain('another producer holds this stream');
    await new Promise((r) => setTimeout(r, 200));
    const after = await sessionStore.load('run-5');
    console.log('leg2 model calls after the refused leg:', leg2.calls.length);
    console.log('checkpoint messages before:', JSON.stringify(before!.messages).length, 'after:', JSON.stringify(after!.messages).includes('RESUMER ANSWER'));
    // The claim: a refused leg does nothing while A is alive.
    expect(leg2.calls.length).toBe(0);
    expect(JSON.stringify(after!.messages)).not.toContain('RESUMER ANSWER');
  });
});
