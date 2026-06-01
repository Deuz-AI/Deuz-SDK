import { describe, it, expect } from 'vitest';
import {
  createGeminiCache,
  getGeminiCache,
  deleteGeminiCache,
  uploadFile,
  waitForFileActive,
} from '../src/google-extras';
import { AuthenticationError, InvalidRequestError } from '../src/errors';

/** JSON fetch double over a per-(url,method) handler; records requests. */
function jsonFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const { status = 200, body, headers } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe('createGeminiCache (AI Studio)', () => {
  it('POSTs /cachedContents with model resource + ttl, returns the name', async () => {
    const { fetch, calls } = jsonFetch(() => ({
      body: {
        name: 'cachedContents/abc123',
        model: 'models/gemini-2.5-flash',
        expireTime: '2026-01-01T00:00:00Z',
      },
    }));
    const cache = await createGeminiCache({
      apiKey: 'AIza-k',
      fetch,
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'long shared prefix…' }] }],
      ttl: '3600s',
      displayName: 'manual',
    });
    expect(cache.name).toBe('cachedContents/abc123');
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/cachedContents');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza-k');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.model).toBe('models/gemini-2.5-flash'); // normalized to resource form
    expect(body.ttl).toBe('3600s');
    expect(body.displayName).toBe('manual');
  });

  it('Vertex target → /projects/…/locations/… path + Bearer auth', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: { name: 'x', model: 'm' } }));
    await createGeminiCache({
      accessToken: 'ya29.t',
      vertex: { project: 'deuz-ai', location: 'us-central1' },
      fetch,
      model: 'gemini-2.5-flash',
      contents: [{ parts: [{ text: 'hi' }] }],
    });
    expect(calls[0]!.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/deuz-ai/locations/us-central1/cachedContents',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ya29.t');
    const body = JSON.parse(String(calls[0]!.init!.body));
    // Vertex wants the full publisher-model resource (live-verified).
    expect(body.model).toBe(
      'projects/deuz-ai/locations/us-central1/publishers/google/models/gemini-2.5-flash',
    );
  });

  it('get + delete hit the cache resource by name', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: { name: 'cachedContents/x', model: 'm' } }));
    await getGeminiCache('cachedContents/x', { apiKey: 'k', fetch });
    await deleteGeminiCache('cachedContents/x', { apiKey: 'k', fetch });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/cachedContents/x');
    expect(calls[1]!.init!.method).toBe('DELETE');
  });

  it('requires a credential', async () => {
    await expect(
      createGeminiCache({ model: 'gemini-2.5-flash', contents: [{ parts: [{ text: 'x' }] }] }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('uploadFile (Files API, AI Studio)', () => {
  it('does a resumable start → upload+finalize and returns the file uri', async () => {
    let phase = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (phase === 0) {
        phase++;
        // start: return the resumable upload URL in the header
        expect(url).toContain('/upload/v1beta/files');
        expect((init!.headers as Record<string, string>)['x-goog-upload-command']).toBe('start');
        return new Response('{}', {
          headers: { 'x-goog-upload-url': 'https://upload.example/session-123' },
        });
      }
      // upload+finalize
      expect(url).toBe('https://upload.example/session-123');
      expect((init!.headers as Record<string, string>)['x-goog-upload-command']).toBe(
        'upload, finalize',
      );
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/abc',
            uri: 'https://gen.../files/abc',
            mimeType: 'application/pdf',
            state: 'ACTIVE',
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const file = await uploadFile({
      apiKey: 'AIza-k',
      fetch: fetchImpl,
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'application/pdf',
      displayName: 'report.pdf',
    });
    expect(file.uri).toBe('https://gen.../files/abc');
    expect(file.mimeType).toBe('application/pdf');
  });

  it('rejects Vertex (no Files API → use GCS)', async () => {
    await expect(
      uploadFile({
        accessToken: 't',
        vertex: { project: 'p', location: 'us-central1' },
        bytes: new Uint8Array([1]),
        mimeType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe('waitForFileActive', () => {
  it('polls until ACTIVE (deterministic clock)', async () => {
    const states = ['PROCESSING', 'PROCESSING', 'ACTIVE'];
    let i = 0;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          name: 'files/x',
          uri: 'u',
          mimeType: 'application/pdf',
          state: states[Math.min(i++, 2)],
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      )) as typeof fetch;
    const file = await waitForFileActive('files/x', {
      apiKey: 'k',
      fetch: fetchImpl,
      deps: { clock: { now: () => 0, setTimeout: (fn) => (fn(), () => {}) } },
    });
    expect(file.state).toBe('ACTIVE');
    expect(i).toBe(3);
  });
});
