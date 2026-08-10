import { describe, it, expect } from 'vitest';
import {
  createVideoProvider,
  submitVideo,
  fetchVideoTask,
  waitForVideo,
  downloadVideo,
  generateVideo,
  type VideoTask,
} from '../src/video';
import { mockFetch, mockFetchSequence } from './fixtures/sse';
import {
  APICallError,
  AbortError,
  AuthenticationError,
  RateLimitError,
  TimeoutError,
} from '../src/errors';

/** A JSON response factory for `mockFetchSequence` (fresh body per call). */
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

/** A binary response factory (the `/content` download). */
const binary =
  (bytes: Uint8Array, mediaType = 'video/mp4') =>
  () =>
    new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': mediaType },
    });

/** Deterministic clock: setTimeout fires immediately; now() advances by `step` each read. */
function fakeClock(step = 1000) {
  let t = 0;
  return {
    now: () => (t += step),
    setTimeout: (fn: () => void) => {
      fn();
      return () => {};
    },
  };
}

/**
 * A real `AbortSignal` whose add/removeEventListener calls are counted, so a
 * test can assert that a long poll leaves no listener behind on the signal the
 * CALLER owns (`live` is the balance, `added` the total ever registered).
 */
function countingSignal(): {
  signal: AbortSignal;
  abort: () => void;
  readonly added: number;
  readonly live: number;
} {
  const controller = new AbortController();
  const inner = controller.signal;
  let added = 0;
  let removed = 0;
  const signal = {
    get aborted() {
      return inner.aborted;
    },
    addEventListener: (...args: Parameters<AbortSignal['addEventListener']>) => {
      added += 1;
      inner.addEventListener(...args);
    },
    removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => {
      removed += 1;
      inner.removeEventListener(...args);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort: () => controller.abort(),
    get added() {
      return added;
    },
    get live() {
      return added - removed;
    },
  };
}

const QUEUED = { id: 'vid_1', status: 'queued', model: 'sora-2' };
const RUNNING = { id: 'vid_1', status: 'in_progress', progress: 50 };
const DONE = {
  id: 'vid_1',
  status: 'completed',
  progress: 100,
  seconds: '8',
  size: '1280x720',
  url: 'https://cdn/vid_1.mp4',
};

describe('submitVideo', () => {
  it('POSTs to {baseURL}/videos with Bearer auth and the canonical body', async () => {
    const { fetch, calls } = mockFetch(() => json(QUEUED)());
    const model = createVideoProvider({ apiKey: 'sk-v', fetch })('sora-2');

    const task = await submitVideo({
      model,
      prompt: 'a tidy robot watering a fern',
      size: '1280x720',
      seconds: 8,
    });

    expect(task).toMatchObject({ id: 'vid_1', status: 'queued', model: 'sora-2' });
    expect(calls[0]!.url).toBe('https://yunwu.ai/v1/videos');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-v');
    expect(headers['content-type']).toBe('application/json');
    // `seconds` is coerced to a string — the OpenAI Videos wire shape.
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      model: 'sora-2',
      prompt: 'a tidy robot watering a fern',
      size: '1280x720',
      seconds: '8',
    });
  });

  it('merges providerOptions but the canonical fields always win', async () => {
    const { fetch, calls } = mockFetch(() => json(QUEUED)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('kling-2.6');

    await submitVideo({
      model,
      prompt: 'real prompt',
      size: '720x1280',
      providerOptions: { seed: 42, aspect_ratio: '9:16', model: 'hijacked', prompt: 'hijacked' },
    });

    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      seed: 42,
      aspect_ratio: '9:16',
      model: 'kling-2.6',
      prompt: 'real prompt',
      size: '720x1280',
    });
  });

  it('switches to multipart when an inputReference is given (no manual content-type)', async () => {
    const { fetch, calls } = mockFetch(() => json(QUEUED)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('veo3.1');

    await submitVideo({
      model,
      prompt: 'animate this',
      seconds: '4',
      inputReference: { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
    });

    const init = calls[0]!.init!;
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('veo3.1');
    expect(form.get('prompt')).toBe('animate this');
    expect(form.get('seconds')).toBe('4');
    const ref = form.get('input_reference') as File;
    expect(ref).toBeInstanceOf(Blob);
    expect(ref.name).toBe('input_reference.png');
    // fetch writes the multipart boundary — we must NOT set content-type ourselves.
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('accepts a bare Blob reference and keeps a File name', async () => {
    const { fetch, calls } = mockFetch(() => json(QUEUED)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');

    await submitVideo({
      model,
      prompt: 'p',
      inputReference: new File([new Uint8Array([9])], 'seed.jpg', { type: 'image/jpeg' }),
    });

    const ref = (calls[0]!.init!.body as FormData).get('input_reference') as File;
    expect(ref.name).toBe('seed.jpg');
  });

  it('throws AuthenticationError before any fetch when no key resolves', async () => {
    let fetched = false;
    const fetchImpl = (async () => ((fetched = true), new Response('{}'))) as typeof fetch;
    const model = createVideoProvider({ fetch: fetchImpl })('sora-2');
    await expect(submitVideo({ model, prompt: 'x' })).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetched).toBe(false);
  });

  it('throws APICallError when the relay accepts the job but names no id', async () => {
    const { fetch } = mockFetch(() => json({ status: 'queued' })());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    await expect(submitVideo({ model, prompt: 'x' })).rejects.toBeInstanceOf(APICallError);
  });
});

describe('task normalization', () => {
  async function fetchWith(body: unknown): Promise<VideoTask | null> {
    const { fetch } = mockFetch(() => json(body)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    return fetchVideoTask('vid_1', { model });
  }

  it.each([
    ['succeeded', 'completed'],
    ['success', 'completed'],
    ['processing', 'in_progress'],
    ['running', 'in_progress'],
    ['pending', 'queued'],
    ['cancelled', 'failed'],
    ['failure', 'failed'],
    // already canonical / unknown → verbatim
    ['completed', 'completed'],
    ['in_progress', 'in_progress'],
    ['moderation_hold', 'moderation_hold'],
  ])('normalizes status %s → %s', async (raw, expected) => {
    const task = await fetchWith({ id: 'vid_1', status: raw });
    expect(task!.status).toBe(expected);
  });

  it('parses progress from a number OR a percent string', async () => {
    expect((await fetchWith({ id: 'v', status: 'in_progress', progress: 42 }))!.progress).toBe(42);
    expect((await fetchWith({ id: 'v', status: 'in_progress', progress: '42%' }))!.progress).toBe(
      42,
    );
    expect((await fetchWith({ id: 'v', status: 'in_progress', progress: 'n/a' }))!.progress).toBe(
      undefined,
    );
  });

  it('finds the result URL under any of the four spellings', async () => {
    expect((await fetchWith({ id: 'v', status: 'completed', url: 'a' }))!.url).toBe('a');
    expect((await fetchWith({ id: 'v', status: 'completed', video_url: 'b' }))!.url).toBe('b');
    expect((await fetchWith({ id: 'v', status: 'completed', output: { url: 'c' } }))!.url).toBe(
      'c',
    );
    expect((await fetchWith({ id: 'v', status: 'completed', data: [{ url: 'd' }] }))!.url).toBe(
      'd',
    );
  });

  it('reads failReason from error.message or fail_reason, and keeps raw', async () => {
    const a = await fetchWith({ id: 'v', status: 'failed', error: { message: 'moderation' } });
    expect(a!.failReason).toBe('moderation');
    const b = await fetchWith({ id: 'v', status: 'failed', fail_reason: 'quota' });
    expect(b!.failReason).toBe('quota');
    expect(b!.raw).toMatchObject({ fail_reason: 'quota' });
  });

  it('accepts task_id and a `state` field', async () => {
    const task = await fetchWith({ task_id: 'alt-1', state: 'PROCESSING' });
    expect(task).toMatchObject({ id: 'alt-1', status: 'in_progress' });
  });
});

describe('fetchVideoTask', () => {
  it('GETs {baseURL}/videos/{id}', async () => {
    const { fetch, calls } = mockFetch(() => json(DONE)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    const task = await fetchVideoTask('vid_1', { model });
    expect(task).toMatchObject({ id: 'vid_1', status: 'completed', url: 'https://cdn/vid_1.mp4' });
    expect(calls[0]!.url).toBe('https://yunwu.ai/v1/videos/vid_1');
  });

  it('returns null on 404 (unknown job is "no", not an error)', async () => {
    const { fetch } = mockFetch(() => json({ error: { message: 'not found' } }, 404)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    expect(await fetchVideoTask('nope', { model })).toBeNull();
  });

  it('returns null for an id-less, status-less envelope', async () => {
    const { fetch } = mockFetch(() => json({ code: 4, description: 'no such task' })());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    expect(await fetchVideoTask('nope', { model })).toBeNull();
  });

  it('maps 401 → AuthenticationError and 429 → RateLimitError', async () => {
    const unauthorized = mockFetch(() => json({ error: { message: 'bad key' } }, 401)());
    const m1 = createVideoProvider({ apiKey: 'k', fetch: unauthorized.fetch })('sora-2');
    await expect(fetchVideoTask('v', { model: m1 })).rejects.toBeInstanceOf(AuthenticationError);

    const limited = mockFetch(() => json({ error: { message: 'slow down' } }, 429)());
    const m2 = createVideoProvider({ apiKey: 'k', fetch: limited.fetch })('sora-2');
    await expect(fetchVideoTask('v', { model: m2 })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('waitForVideo', () => {
  it('polls until completed and reports every snapshot', async () => {
    const { fetch } = mockFetchSequence([json(RUNNING), json(DONE)]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    const seen: VideoTask[] = [];

    const task = await waitForVideo('vid_1', {
      model,
      deps: { clock: fakeClock() },
      onProgress: (t) => seen.push(t),
    });

    expect(task).toMatchObject({ status: 'completed', url: 'https://cdn/vid_1.mp4', seconds: '8' });
    expect(seen.map((t) => t.status)).toEqual(['in_progress', 'completed']);
    expect(seen[0]!.progress).toBe(50);
  });

  it('RETURNS a failed job instead of throwing', async () => {
    const { fetch } = mockFetchSequence([
      json(RUNNING),
      json({ id: 'vid_1', status: 'failed', error: { message: 'content policy' } }),
    ]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');

    const task = await waitForVideo('vid_1', { model, deps: { clock: fakeClock() } });
    expect(task.status).toBe('failed');
    expect(task.failReason).toBe('content policy');
  });

  it('times out if the job never finishes', async () => {
    const { fetch } = mockFetch(() => json(RUNNING)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    await expect(
      waitForVideo('vid_1', { model, timeoutMs: 5000, deps: { clock: fakeClock(3000) } }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('rejects with AbortError when the signal fires mid-poll', async () => {
    const { fetch, calls } = mockFetch(() => json(RUNNING)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    const controller = new AbortController();

    await expect(
      waitForVideo('vid_1', {
        model,
        signal: controller.signal,
        deps: { clock: fakeClock() },
        onProgress: () => controller.abort(),
      }),
    ).rejects.toBeInstanceOf(AbortError);
    // aborted after the first poll — no further requests went out
    expect(calls.length).toBe(1);
  });

  it('does not accumulate an abort listener on the caller signal per poll turn', async () => {
    // 4 in-progress turns + a terminal one = 4 poll gaps, i.e. 4 listener adds.
    const { fetch } = mockFetchSequence([
      json(RUNNING),
      json(RUNNING),
      json(RUNNING),
      json(RUNNING),
      json(DONE),
    ]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    const counted = countingSignal();

    const task = await waitForVideo('vid_1', {
      model,
      signal: counted.signal,
      deps: { clock: fakeClock() },
    });

    expect(task.status).toBe('completed');
    // The listener count must be a constant, not a function of the poll count.
    expect(counted.added).toBe(4);
    expect(counted.live).toBe(0);
  });
});

describe('downloadVideo', () => {
  it('GETs {baseURL}/videos/{id}/content and returns bytes + mediaType', async () => {
    const bytes = new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]);
    const { fetch, calls } = mockFetch(() => binary(bytes)());
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');

    const { video, mediaType } = await downloadVideo('vid_1', { model });
    expect(Array.from(video)).toEqual(Array.from(bytes));
    expect(mediaType).toBe('video/mp4');
    expect(calls[0]!.url).toBe('https://yunwu.ai/v1/videos/vid_1/content');
  });

  it('strips content-type parameters and maps a 404', async () => {
    const withParams = mockFetch(
      () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/webm; x=1' } }),
    );
    const m1 = createVideoProvider({ apiKey: 'k', fetch: withParams.fetch })('sora-2');
    expect((await downloadVideo('v', { model: m1 })).mediaType).toBe('video/webm');

    const missing = mockFetch(() => json({ error: { message: 'gone' } }, 404)());
    const m2 = createVideoProvider({ apiKey: 'k', fetch: missing.fetch })('sora-2');
    await expect(downloadVideo('v', { model: m2 })).rejects.toThrow(/gone/);
  });
});

describe('generateVideo', () => {
  it('submits, polls to completion and does NOT download by default', async () => {
    const { fetch, calls } = mockFetchSequence([json(QUEUED), json(RUNNING), json(DONE)]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');

    const { task, video, mediaType } = await generateVideo({
      model,
      prompt: 'a robot',
      deps: { clock: fakeClock() },
    });

    expect(task).toMatchObject({ id: 'vid_1', status: 'completed', url: 'https://cdn/vid_1.mp4' });
    expect(video).toBeUndefined();
    expect(mediaType).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([
      'https://yunwu.ai/v1/videos',
      'https://yunwu.ai/v1/videos/vid_1',
      'https://yunwu.ai/v1/videos/vid_1',
    ]);
  });

  it('download: true fetches the clip bytes as a fourth request', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { fetch, calls } = mockFetchSequence([
      json(QUEUED),
      json(RUNNING),
      json(DONE),
      binary(bytes),
    ]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    const seen: string[] = [];

    const result = await generateVideo({
      model,
      prompt: 'a robot',
      download: true,
      deps: { clock: fakeClock() },
      onProgress: (t) => seen.push(t.status),
    });

    expect(seen).toEqual(['in_progress', 'completed']);
    expect(Array.from(result.video!)).toEqual([1, 2, 3, 4]);
    expect(result.mediaType).toBe('video/mp4');
    expect(calls.length).toBe(4);
    expect(calls[3]!.url).toBe('https://yunwu.ai/v1/videos/vid_1/content');
  });

  it('skips the download when the job failed', async () => {
    const { fetch, calls } = mockFetchSequence([
      json(QUEUED),
      json({ id: 'vid_1', status: 'failed', fail_reason: 'nsfw' }),
    ]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');

    const { task, video } = await generateVideo({
      model,
      prompt: 'x',
      download: true,
      deps: { clock: fakeClock() },
    });

    expect(task.status).toBe('failed');
    expect(task.failReason).toBe('nsfw');
    expect(video).toBeUndefined();
    expect(calls.length).toBe(2);
  });

  it('does not open a poll when submit already returns a terminal job', async () => {
    const { fetch, calls } = mockFetchSequence([json(DONE)]);
    const model = createVideoProvider({ apiKey: 'k', fetch })('sora-2');
    const { task } = await generateVideo({ model, prompt: 'x', deps: { clock: fakeClock() } });
    expect(task.status).toBe('completed');
    expect(calls.length).toBe(1);
  });
});

describe('createVideoProvider settings', () => {
  it('defaults to the Yunwu relay and honours a custom baseURL + provider id', async () => {
    const model = createVideoProvider({ apiKey: 'k' })('sora-2');
    expect(model).toMatchObject({ provider: 'yunwu', modelId: 'sora-2', surface: 'video' });
    // the key never leaks through enumeration (config lives on a private Symbol)
    expect(Object.keys(model)).toEqual(['provider', 'modelId', 'surface']);
    expect(JSON.stringify(model)).not.toContain('k');

    const { fetch, calls } = mockFetch(() => json(QUEUED)());
    const custom = createVideoProvider({
      provider: 'openai',
      apiKey: 'sk-o',
      baseURL: 'https://api.openai.com/v1/',
      fetch,
    })('sora-2');
    await submitVideo({ model: custom, prompt: 'p' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/videos');
  });

  it('deps.keyProvider outranks the factory key (G1)', async () => {
    const { fetch, calls } = mockFetch(() => json(QUEUED)());
    const model = createVideoProvider({ apiKey: 'factory-key', fetch })('sora-2');
    await submitVideo({
      model,
      prompt: 'p',
      deps: { keyProvider: { getKey: async () => 'provider-key' } },
    });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer provider-key',
    );
  });
});
