import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import { createVertexGoogleNative } from '../src/vertex';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const TEXT = sseEvents([
  { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Mer' }] } }] } },
  { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'haba' }] } }] } },
  {
    data: {
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
    },
  },
]);

describe('createVertexGoogleNative — native generateContent over Vertex transport', () => {
  it('builds the Vertex URL + Bearer auth (not x-goog-api-key)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([TEXT]));
    const model = createVertexGoogleNative({
      project: 'deuz-ai',
      location: 'us-central1',
      accessToken: 'ya29.fake-token',
      fetch,
    })('gemini-2.5-flash');

    const res = streamChat({ model, messages: [{ role: 'user', content: 'selam' }] });
    let text = '';
    for await (const c of res.textStream) text += c;
    expect(text).toBe('Merhaba');

    const url = calls[0]!.url;
    // Vertex publisher-model path + region host + streamGenerateContent + alt=sse
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/deuz-ai/locations/us-central1' +
        '/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ya29.fake-token');
    expect(headers['x-goog-api-key']).toBeUndefined(); // Vertex uses Bearer, not the API-key header
  });

  it('uses the global host when location is "global"', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([TEXT]));
    const model = createVertexGoogleNative({
      project: 'deuz-ai',
      location: 'global',
      accessToken: 't',
      fetch,
    })('gemini-2.5-pro');
    const res = streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    for await (const _ of res.textStream) void _;
    expect(calls[0]!.url).toContain(
      'https://aiplatform.googleapis.com/v1/projects/deuz-ai/locations/global',
    );
  });

  it('resolves the OAuth token from deps.keyProvider (refreshable)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([TEXT]));
    const model = createVertexGoogleNative({ project: 'deuz-ai', location: 'us-central1', fetch })(
      'gemini-2.5-flash',
    );
    const res = streamChat({
      model,
      deps: { keyProvider: { getKey: () => 'ya29.from-provider' } },
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _ of res.textStream) void _;
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ya29.from-provider');
  });
});
