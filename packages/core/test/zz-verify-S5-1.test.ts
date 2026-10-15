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
const toolCall = (id: string) =>
  sseEvents([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'search' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
const instantClock = {
  setTimeout: (fn: () => void, _ms: number) => {
    const id = globalThis.setTimeout(fn, 0);
    return () => globalThis.clearTimeout(id);
  },
};

describe('verify-S5-1: a refused durable continuation leg', () => {
  it('does not call the model, run a tool, or write a checkpoint while the quiet producer holds the lease', async () => {
    const sessionStore = createInMemorySessionStore();
    const store = createInMemoryDurableStreamStateStore();
    const provider = createInMemoryLeaseProvider();
    // Producer A: step 1 tool completes quickly; step 2 is a LONG tool call (alive, quiet).
    let aCalls = 0;
    const executeA = vi.fn(async () => {
      aCalls++;
      if (aCalls === 1) return 'found-1';
      return new Promise<string>(() => {}); // long-running tool at step 2
    });
    const leg1 = mockFetchSequence([() => sseResponse([toolCall('toolu_1')]), () => sseResponse([toolCall('toolu_2')])]);
    const result1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'find x' }],
      tools: { search: { parameters: SCHEMA, execute: executeA } },
      maxSteps: 5,
      session: { store: sessionStore, runId: 'run-v1' },
    });
    const live = toDeuzStreamResponse(result1, {
      durable: { store, lease: { provider, owner: 'a' }, batch: { maxDelayMs: 0 } },
      streamId: 'run-v1',
      messageId: 'm1',
    });
    const reader = live.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    // keep reading until A is inside its second (long) tool call
    while (executeA.mock.calls.length < 2) {
      const r = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array }>((res) => setTimeout(() => res({}), 20))]);
      if ((r as { value?: Uint8Array }).value) seen += dec.decode((r as { value: Uint8Array }).value);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(leg1.calls.length).toBe(2);
    const before = await sessionStore.load('run-v1');
    expect(before).toBeTruthy();
    const beforeJson = JSON.stringify(before);

    // B: the leg's model asks for the same tool again (as A's step 2 did).
    const leg2 = mockFetchSequence([() => sseResponse([toolCall('toolu_B')]), () => new Promise<Response>(() => {}) as never]);
    const executeB = vi.fn(async () => 'found-by-B');
    const text = await resumeDeuzChatResponse({
      sessionStore,
      streamStateStore: store,
      durable: { store, lease: { provider, owner: 'resumer' } },
      runId: 'run-v1',
      streamId: 'run-v1',
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
    const after = await sessionStore.load('run-v1');
    console.log('leg2 model calls:', leg2.calls.length, 'executeB calls:', executeB.mock.calls.length);
    console.log('checkpoint changed:', JSON.stringify(after) !== beforeJson, 'has B result:', JSON.stringify(after).includes('found-by-B'), 'stepId', (after as { stepId?: string }).stepId);
    expect(leg2.calls.length).toBe(0);
    expect(executeB).not.toHaveBeenCalled();
    expect(JSON.stringify(after)).toBe(beforeJson);
  });
});
