/**
 * `ClientConfig.apiKeys` / `baseUrls` reaching the MODALITY entry points.
 *
 * `apiKeys` is typed — and documented — as the lowest link of the G1 chain for
 * every provider, the modality ones (`elevenlabs`, `deepgram`, `yunwu`, …)
 * included. Those entry points are free functions on their own subpaths, so the
 * client has no method that forwards to them; `DeuzClient.bind` is the seam that
 * hands them the client context (a private Symbol they already read).
 */
import { describe, it, expect } from 'vitest';
import { createClient } from '../src/index';
import { generateSpeech, createElevenLabs } from '../src/speech';
import { transcribe, createDeepgram } from '../src/transcription';
import { generateVideo, createVideoProvider } from '../src/video';
import { generateImage, createImageProvider } from '../src/image';
import { AuthenticationError } from '../src/errors';

/** Records every request and answers with the body the caller names. */
function recordingFetch(respond: () => Response): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const audio = (): Response => new Response(new Uint8Array([0xff, 0xfb]));
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function headersOf(call: { init?: RequestInit }): Record<string, string> {
  return call.init!.headers as Record<string, string>;
}

describe('ClientConfig.apiKeys and the modality entry points', () => {
  it('never reaches generateSpeech when the options are not bound to the client', async () => {
    const { fetch, calls } = recordingFetch(audio);
    createClient({ apiKeys: { elevenlabs: 'client-key' } });
    const model = createElevenLabs({ fetch })('eleven_turbo_v2_5');

    // A client the call was never bound to cannot contribute a key — the chain
    // ends in AuthenticationError, before any request goes out.
    await expect(generateSpeech({ model, text: 'hi', voice: 'rachel' })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(calls.length).toBe(0);
  });

  it('reaches generateSpeech through client.bind (elevenlabs)', async () => {
    const { fetch, calls } = recordingFetch(audio);
    const client = createClient({ apiKeys: { elevenlabs: 'client-key' } });
    const model = createElevenLabs({ fetch })('eleven_turbo_v2_5');

    const result = await generateSpeech(client.bind({ model, text: 'hi', voice: 'rachel' }));

    expect(result.usage.characters).toBe(2);
    // ElevenLabs authenticates with `xi-api-key`, not Bearer.
    expect(headersOf(calls[0]!)['xi-api-key']).toBe('client-key');
  });

  it('reaches transcribe through client.bind (deepgram)', async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({ results: { channels: [{ alternatives: [{ transcript: 'merhaba' }] }] } }),
    );
    const client = createClient({ apiKeys: { deepgram: 'dg-key' } });
    const model = createDeepgram({ fetch })('nova-3');

    const result = await transcribe(
      client.bind({ model, audio: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' }),
    );

    expect(result.text).toBe('merhaba');
    expect(headersOf(calls[0]!).authorization).toBe('Token dg-key');
  });

  it('reaches generateVideo through client.bind (yunwu)', async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({ id: 'vid_1', status: 'completed', url: 'https://cdn/vid_1.mp4' }),
    );
    const client = createClient({ apiKeys: { yunwu: 'yw-key' } });
    const model = createVideoProvider({ fetch })('sora-2');

    const { task } = await generateVideo(client.bind({ model, prompt: 'a robot' }));

    expect(task.url).toBe('https://cdn/vid_1.mp4');
    expect(headersOf(calls[0]!).authorization).toBe('Bearer yw-key');
  });

  it('reaches generateImage through client.bind, and baseUrls travels with it', async () => {
    const { fetch, calls } = recordingFetch(() => json({ data: [{ url: 'https://cdn/img.png' }] }));
    const client = createClient({
      apiKeys: { openai: 'sk-client' },
      baseUrls: { openai: 'https://relay.example/v1' },
    });
    const model = createImageProvider({ fetch })('dall-e-3');

    const { images } = await generateImage(client.bind({ model, prompt: 'a fern' }));

    expect(images[0]!.url).toBe('https://cdn/img.png');
    expect(calls[0]!.url).toBe('https://relay.example/v1/images/generations');
    expect(headersOf(calls[0]!).authorization).toBe('Bearer sk-client');
  });

  it('binds a COPY — the caller keeps an untouched options object', async () => {
    const { fetch } = recordingFetch(audio);
    const client = createClient({ apiKeys: { elevenlabs: 'client-key' } });
    const model = createElevenLabs({ fetch })('eleven_turbo_v2_5');
    const options = { model, text: 'hi', voice: 'rachel' };

    const bound = client.bind(options);
    expect(bound).not.toBe(options);
    expect(Object.keys(options)).toEqual(['model', 'text', 'voice']);
    await expect(generateSpeech(options)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(generateSpeech(bound)).resolves.toBeTruthy();
  });

  it('keeps the G1 order: a factory key still outranks the client table', async () => {
    const { fetch, calls } = recordingFetch(audio);
    const client = createClient({ apiKeys: { elevenlabs: 'client-key' } });
    const model = createElevenLabs({ apiKey: 'factory-key', fetch })('eleven_turbo_v2_5');

    await generateSpeech(client.bind({ model, text: 'hi', voice: 'rachel' }));

    expect(headersOf(calls[0]!)['xi-api-key']).toBe('factory-key');
  });
});
