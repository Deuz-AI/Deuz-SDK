import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { Usage } from '../src/types/usage';
import type { UsageMeta } from '../src/types/deps';
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
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

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) void _;
  })();
}

describe('metering', () => {
  it('fires onUsage exactly once with reason "finished" + ttftMs', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    let calls = 0;
    let usage: Usage | undefined;
    let meta: UsageMeta | undefined;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      onUsage: (u, m) => {
        calls++;
        usage = u;
        meta = m;
      },
    });
    await drain(result.fullStream);
    expect(calls).toBe(1);
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(meta).toMatchObject({ model: 'claude-opus-4-8', reason: 'finished' });
    expect(typeof meta!.ttftMs).toBe('number');
    expect(meta!.ttftMs!).toBeGreaterThanOrEqual(0);
  });

  it('call-level onUsage overrides deps.onUsage — never both (G10)', async () => {
    const { fetch } = mockFetch(() => sseResponse([STREAM]));
    let optCalls = 0;
    let depsCalls = 0;
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      onUsage: () => {
        optCalls++;
      },
      deps: {
        onUsage: () => {
          depsCalls++;
        },
      },
    });
    await drain(result.fullStream);
    expect(optCalls).toBe(1);
    expect(depsCalls).toBe(0);
  });
});
