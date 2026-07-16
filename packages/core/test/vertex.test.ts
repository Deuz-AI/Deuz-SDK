import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import { createVertexAnthropic, createVertexGoogle } from '../src/vertex';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const ANTHROPIC_OK = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1 } } },
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
      delta: { type: 'text_delta', text: 'vertex ok' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const CC_OK = sseEvents([
  { data: { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
  { data: '[DONE]' },
]);

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) void _;
  })();
}

describe('Vertex AI — Claude on Vertex (reuses Anthropic wire)', () => {
  it('builds the Vertex rawPredict URL + Bearer + anthropic_version, no model in body', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const vertexAnthropic = createVertexAnthropic({
      project: 'my-proj',
      location: 'us-east5',
      accessToken: 'ya29.token',
      fetch,
    });
    const result = streamChat({
      model: vertexAnthropic('claude-sonnet-4-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('vertex ok'); // parse path is reused

    const { url, init } = calls[0]!;
    expect(url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict',
    );
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ya29.token');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBeUndefined();

    const body = JSON.parse(String(init!.body));
    expect(body.anthropic_version).toBe('vertex-2023-10-16');
    expect(body.model).toBeUndefined(); // model lives in the URL on Vertex
    expect(body.max_tokens).toBeDefined();
  });

  it('uses the global host when location is "global"', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const v = createVertexAnthropic({ project: 'p', location: 'global', accessToken: 't', fetch });
    await drain(
      streamChat({ model: v('claude-opus-4-1'), messages: [{ role: 'user', content: 'hi' }] })
        .fullStream,
    );
    expect(calls[0]!.url).toContain(
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/',
    );
  });
});

describe('Vertex AI — Gemini on Vertex (reuses Chat Completions wire)', () => {
  it('builds the openapi chat/completions URL + Bearer', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const vertexGoogle = createVertexGoogle({
      project: 'my-proj',
      location: 'us-central1',
      accessToken: 'ya29.token',
      fetch,
    });
    const result = streamChat({
      model: vertexGoogle('google/gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('hi');

    const { url, init } = calls[0]!;
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/us-central1/endpoints/openapi/chat/completions',
    );
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe('google/gemini-2.5-flash');
  });
});
