import { describe, it, expect } from 'vitest';
import { generateImage, createImageProvider } from '../src/image';
import { createYunwuImage } from '../src/yunwu';
import { AuthenticationError, APICallError, RateLimitError } from '../src/errors';

/** A fetch double that returns a JSON Response and records each request. */
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

describe('generateImage (OpenAI-compatible /images/generations)', () => {
  it('sends the right body + auth + URL, returns url images', async () => {
    const { fetch, calls } = jsonFetch(() => ({
      body: { data: [{ url: 'https://img/1.png', revised_prompt: 'a tidy robot' }] },
    }));
    const model = createImageProvider({ apiKey: 'sk-test', fetch })('dall-e-3');
    const res = await generateImage({ model, prompt: 'a robot', size: '1024x1024', quality: 'hd' });

    expect(res.images).toEqual([{ url: 'https://img/1.png', revisedPrompt: 'a tidy robot' }]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({
      model: 'dall-e-3',
      prompt: 'a robot',
      n: 1,
      size: '1024x1024',
      quality: 'hd',
    });
  });

  it('decodes b64_json images', async () => {
    const { fetch } = jsonFetch(() => ({ body: { data: [{ b64_json: 'AAAA' }] } }));
    const model = createImageProvider({ apiKey: 'k', fetch })('gpt-image-1');
    const res = await generateImage({ model, prompt: 'x', responseFormat: 'b64_json' });
    expect(res.images[0]).toEqual({ b64Json: 'AAAA' });
  });

  it('Yunwu factory targets the relay base URL', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: { data: [{ url: 'https://y/x.png' }] } }));
    const model = createYunwuImage({ apiKey: 'sk-y', fetch })('flux-1.1-pro');
    await generateImage({ model, prompt: 'hi' });
    expect(calls[0]!.url).toBe('https://yunwu.ai/v1/images/generations');
  });

  it('maps a 500 "saturated" relay error to a retryable APICallError', async () => {
    const { fetch } = jsonFetch(() => ({
      status: 500,
      body: { detail: '该令牌分组 default 下无可用渠道', type: 'yunwu_api_error' },
    }));
    const model = createYunwuImage({ apiKey: 'k', fetch })('dall-e-3');
    await expect(generateImage({ model, prompt: 'x' })).rejects.toBeInstanceOf(APICallError);
  });

  it('maps 429 to RateLimitError', async () => {
    const { fetch } = jsonFetch(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
    const model = createImageProvider({ apiKey: 'k', fetch })('dall-e-3');
    await expect(generateImage({ model, prompt: 'x' })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws AuthenticationError before any fetch when no key is resolvable', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch;
    const model = createImageProvider({ fetch: fetchImpl })('dall-e-3'); // no apiKey anywhere
    await expect(generateImage({ model, prompt: 'x' })).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetched).toBe(false);
  });

  it('resolves the key from deps.keyProvider', async () => {
    let seenAuth: string | undefined;
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = (init!.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ data: [{ url: 'u' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const model = createImageProvider({ provider: 'openai', fetch: fetchImpl })('dall-e-3');
    await generateImage({ model, prompt: 'x', deps: { keyProvider: { getKey: () => 'sk-kp' } } });
    expect(seenAuth).toBe('Bearer sk-kp');
  });
});
