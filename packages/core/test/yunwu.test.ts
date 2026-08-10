import { describe, it, expect } from 'vitest';
import {
  createYunwu,
  createYunwuChat,
  createYunwuImage,
  createYunwuVideo,
  createYunwuEmbedding,
  YUNWU_MODELS,
  YUNWU_CHAT_MODELS,
  YUNWU_IMAGE_MODELS,
  YUNWU_VIDEO_MODELS,
  YUNWU_DEFAULT_BASE_URL,
} from '../src/yunwu';
import { generateImage } from '../src/image';
import { submitVideo } from '../src/video';

/** Records the URL a model/factory resolves to by intercepting the fetch. */
function urlSpy(body: unknown) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe('Yunwu 2026 catalog', () => {
  it('exposes curated 2026 chat/image/video model lists', () => {
    expect(YUNWU_CHAT_MODELS).toContain('gpt-5.2');
    expect(YUNWU_CHAT_MODELS).toContain('gemini-3-pro-preview');
    expect(YUNWU_CHAT_MODELS).toContain('claude-opus-4-5');
    expect(YUNWU_IMAGE_MODELS).toContain('flux-2-pro');
    expect(YUNWU_IMAGE_MODELS).toContain('gpt-image-2');
    expect(YUNWU_MODELS.video).toContain('sora-2');
    expect(YUNWU_MODELS.video).toContain('veo3.1');
    // the video list is no longer a dead constant — it has a producer (2.0)
    expect(YUNWU_VIDEO_MODELS).toBe(YUNWU_MODELS.video);
  });
});

describe('createYunwu unified client — one base URL, every surface', () => {
  it('chat/image/embedding descriptors carry the right provider + surface', () => {
    const y = createYunwu({ apiKey: 'sk-y' });
    expect(y.baseURL).toBe(YUNWU_DEFAULT_BASE_URL);
    expect(y.chat('gpt-5.2')).toMatchObject({
      provider: 'yunwu',
      modelId: 'gpt-5.2',
      surface: 'chat_completions',
    });
    expect(y.image('flux-2-pro')).toMatchObject({
      provider: 'yunwu',
      modelId: 'flux-2-pro',
      surface: 'images',
    });
    expect(y.video('sora-2')).toMatchObject({
      provider: 'yunwu',
      modelId: 'sora-2',
      surface: 'video',
    });
    expect(y.embedding('text-embedding-3-large')).toMatchObject({
      provider: 'yunwu',
      surface: 'openai-embeddings',
    });
  });

  it('video surface hits {root}/v1/videos', async () => {
    const { fetch, calls } = urlSpy({ id: 'vid_1', status: 'queued' });
    const y = createYunwu({ apiKey: 'sk-y', fetch });
    await submitVideo({ model: y.video('sora-2'), prompt: 'a robot', seconds: 8 });
    expect(calls[0]).toBe('https://yunwu.ai/v1/videos');
  });

  it('image surface hits {root}/v1/images/generations', async () => {
    const { fetch, calls } = urlSpy({ data: [{ url: 'https://y/x.png' }] });
    const y = createYunwu({ apiKey: 'sk-y', fetch });
    await generateImage({ model: y.image('gpt-image-2'), prompt: 'a robot' });
    expect(calls[0]).toBe('https://yunwu.ai/v1/images/generations');
  });

  it('mj() binds the bare host root (NOT /v1)', () => {
    const y = createYunwu({ apiKey: 'sk-y' });
    expect(y.mj()).toMatchObject({
      provider: 'yunwu',
      apiKey: 'sk-y',
      baseURL: 'https://yunwu.ai',
    });
  });

  it('CREATIVE base URL: a custom host drives every surface (with or without trailing /v1)', async () => {
    const { fetch, calls } = urlSpy({ data: [{ url: 'u' }] });
    // pass a host WITH a trailing /v1 — it should be normalized, not doubled
    const y = createYunwu({ apiKey: 'sk-y', baseURL: 'https://my-mirror.example.com/v1/', fetch });
    expect(y.baseURL).toBe('https://my-mirror.example.com');
    await generateImage({ model: y.image('flux-2-pro'), prompt: 'x' });
    expect(calls[0]).toBe('https://my-mirror.example.com/v1/images/generations'); // no /v1/v1
    expect(y.mj().baseURL).toBe('https://my-mirror.example.com');
  });

  it('CREATIVE base URL also drives the video surface', async () => {
    const { fetch, calls } = urlSpy({ id: 'vid_1', status: 'queued' });
    const y = createYunwu({ apiKey: 'sk-y', baseURL: 'https://my-mirror.example.com/v1/', fetch });
    await submitVideo({ model: y.video('kling-2.6'), prompt: 'x' });
    expect(calls[0]).toBe('https://my-mirror.example.com/v1/videos');
  });
});

describe('standalone Yunwu factories', () => {
  it('createYunwuChat → chat_completions on /v1', () => {
    const m = createYunwuChat({ apiKey: 'k' })('claude-opus-4-5');
    expect(m).toMatchObject({ provider: 'yunwu', surface: 'chat_completions' });
  });
  it('createYunwuImage default + custom base URL', async () => {
    const { fetch, calls } = urlSpy({ data: [{ url: 'u' }] });
    await generateImage({
      model: createYunwuImage({ apiKey: 'k', fetch })('nano-banana'),
      prompt: 'x',
    });
    expect(calls[0]).toBe('https://yunwu.ai/v1/images/generations');
  });
  it('createYunwuVideo default base URL → /v1/videos', async () => {
    const { fetch, calls } = urlSpy({ id: 'vid_1', status: 'queued' });
    await submitVideo({
      model: createYunwuVideo({ apiKey: 'k', fetch })('veo3.1'),
      prompt: 'x',
    });
    expect(calls[0]).toBe('https://yunwu.ai/v1/videos');
  });
  it('createYunwuEmbedding → openai-embeddings surface', () => {
    const m = createYunwuEmbedding({ apiKey: 'k' })('text-embedding-3-small');
    expect(m).toMatchObject({ provider: 'yunwu', surface: 'openai-embeddings' });
  });
});
