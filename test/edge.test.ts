import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import * as edgeEntry from '../src/edge';
import { createAnthropic } from '../src/anthropic';
import { redactHeaders } from '../src/internal/redact';
import { sseEvents, mockFetch } from './fixtures/sse';

/** Build a streaming Response from raw byte chunks (to force chunk-boundary splits). */
function byteSseResponse(byteChunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of byteChunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

describe('SSE chunk-boundary robustness', () => {
  it('reconstructs multibyte UTF-8 text split across single-byte chunks', async () => {
    const TEXT = 'café 🎉 ÿ — déjà vu';
    const wire = sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const bytes = new TextEncoder().encode(wire);
    const oneBytePerChunk = Array.from(bytes, (b) => new Uint8Array([b]));
    const { fetch } = mockFetch(() => byteSseResponse(oneBytePerChunk));

    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe(TEXT);
  });
});

describe('secret redaction (regression: key never logged)', () => {
  it('masks the api key in the real request headers', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response('', { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    const result = streamChat({
      model: createAnthropic({ apiKey: 'sk-ant-supersecretvalue' })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { fetch },
    });
    await (async () => {
      for await (const _ of result.fullStream) void _;
    })();
    await expect(result.usage).rejects.toBeDefined();

    const sentHeaders = calls[0]!.init!.headers as Record<string, string>;
    expect(sentHeaders['x-api-key']).toBe('sk-ant-supersecretvalue');
    // When that header bag is logged, redaction must mask it.
    const safe = redactHeaders(sentHeaders);
    expect(safe['x-api-key']).not.toContain('supersecret');
    expect(JSON.stringify(safe)).not.toContain('supersecret');
  });
});

describe('edge entry', () => {
  it('re-exports the web-safe surface', () => {
    expect(typeof edgeEntry.streamChat).toBe('function');
    expect(typeof edgeEntry.generateText).toBe('function');
    expect(typeof edgeEntry.createClient).toBe('function');
  });
});
