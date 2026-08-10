import { describe, it, expect } from 'vitest';
import {
  generateSpeech,
  createOpenAISpeech,
  createElevenLabs,
  type SpeechModel,
} from '../src/speech';
import { getSpeechAdapter } from '../src/adapters/speech';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  RateLimitError,
  UnsupportedCapabilityError,
} from '../src/errors';

/** A fetch double that returns audio bytes and records each request. */
function audioFetch(
  bytes: number[] = [0xff, 0xfb, 0x90, 0x00],
  headers?: Record<string, string>,
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    // A BufferSource body sets NO content-type unless we pass one — which is
    // exactly the "provider omitted the header" case the fallback covers.
    return new Response(new Uint8Array(bytes), headers ? { headers } : undefined);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A fetch double that fails with a JSON error envelope. */
function errorFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function bodyOf(call: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init!.body)) as Record<string, unknown>;
}

function headersOf(call: { init?: RequestInit }): Record<string, string> {
  return call.init!.headers as Record<string, string>;
}

describe('generateSpeech — OpenAI wire (POST /audio/speech)', () => {
  it('sends the golden request: URL, Bearer auth, default voice, response_format', async () => {
    const { fetch, calls } = audioFetch();
    const model = createOpenAISpeech({ apiKey: 'sk-test', fetch })('tts-1');

    await generateSpeech({ model, text: 'Merhaba dünya' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(calls[0]!.init!.method).toBe('POST');
    const headers = headersOf(calls[0]!);
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['content-type']).toBe('application/json');
    expect(bodyOf(calls[0]!)).toEqual({
      model: 'tts-1',
      input: 'Merhaba dünya',
      voice: 'alloy', // OpenAI has no server-side default — we supply one
      response_format: 'mp3', // the canonical default format
    });
  });

  it('forwards voice, format, speed and instructions', async () => {
    const { fetch, calls } = audioFetch();
    const model = createOpenAISpeech({ apiKey: 'k', fetch })('gpt-4o-mini-tts');

    await generateSpeech({
      model,
      text: 'hi',
      voice: 'nova',
      format: 'wav',
      speed: 1.25,
      instructions: 'Speak like a calm librarian.',
    });

    expect(bodyOf(calls[0]!)).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'hi',
      voice: 'nova',
      response_format: 'wav',
      speed: 1.25,
      instructions: 'Speak like a calm librarian.',
    });
  });

  it('merges providerOptions FIRST — canonical fields overwrite it', async () => {
    const { fetch, calls } = audioFetch();
    const model = createOpenAISpeech({ apiKey: 'k', fetch })('tts-1-hd');

    await generateSpeech({
      model,
      text: 'hi',
      format: 'opus',
      voice: 'echo',
      providerOptions: {
        // an unmodelled wire field survives …
        stream_format: 'audio',
        // … but the escape hatch may NOT redefine what the typed options set
        response_format: 'flac',
        voice: 'shimmer',
      },
    });

    expect(bodyOf(calls[0]!)).toEqual({
      stream_format: 'audio',
      model: 'tts-1-hd',
      input: 'hi',
      voice: 'echo',
      response_format: 'opus',
    });
  });

  it('honors a factory baseURL and per-call headers', async () => {
    const { fetch, calls } = audioFetch();
    const model = createOpenAISpeech({
      apiKey: 'k',
      baseURL: 'https://relay.example/v1/',
      headers: { 'x-factory': 'yes' },
      fetch,
    })('tts-1');

    await generateSpeech({ model, text: 'hi', headers: { 'x-call': 'yes' } });

    expect(calls[0]!.url).toBe('https://relay.example/v1/audio/speech');
    const headers = headersOf(calls[0]!);
    expect(headers['x-factory']).toBe('yes');
    expect(headers['x-call']).toBe('yes');
  });
});

describe('generateSpeech — ElevenLabs wire (POST /text-to-speech/{voice})', () => {
  it('sends the golden request: voice in the path, format in the query, xi-api-key', async () => {
    const { fetch, calls } = audioFetch();
    const model = createElevenLabs({ apiKey: 'xi-key', fetch })('eleven_multilingual_v2');

    await generateSpeech({ model, text: 'selam', voice: 'Rachel v2' });

    expect(calls[0]!.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/Rachel%20v2?output_format=mp3_44100_128',
    );
    const headers = headersOf(calls[0]!);
    expect(headers['xi-api-key']).toBe('xi-key');
    expect(headers.authorization).toBeUndefined(); // NOT a Bearer wire
    expect(bodyOf(calls[0]!)).toEqual({ text: 'selam', model_id: 'eleven_multilingual_v2' });
  });

  it('maps opus and pcm onto ElevenLabs codec strings', async () => {
    const { fetch, calls } = audioFetch();
    const model = createElevenLabs({ apiKey: 'k', fetch })('eleven_turbo_v2_5');

    await generateSpeech({ model, text: 'a', voice: 'v', format: 'opus' });
    await generateSpeech({ model, text: 'a', voice: 'v', format: 'pcm' });

    expect(calls[0]!.url).toContain('output_format=opus_48000_128');
    expect(calls[1]!.url).toContain('output_format=pcm_44100');
  });

  it('rejects a missing voice with InvalidRequestError before any fetch', async () => {
    const { fetch, calls } = audioFetch();
    const model = createElevenLabs({ apiKey: 'k', fetch })('eleven_multilingual_v2');

    await expect(generateSpeech({ model, text: 'hi' })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a format ElevenLabs cannot produce with UnsupportedCapabilityError', async () => {
    const { fetch, calls } = audioFetch();
    const model = createElevenLabs({ apiKey: 'k', fetch })('eleven_multilingual_v2');

    await expect(
      generateSpeech({ model, text: 'hi', voice: 'v', format: 'wav' }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(
      generateSpeech({ model, text: 'hi', voice: 'v', format: 'aac' }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(
      generateSpeech({ model, text: 'hi', voice: 'v', format: 'flac' }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(calls).toHaveLength(0);
  });

  it('passes providerOptions.output_format through verbatim and keeps it out of the body', async () => {
    const { fetch, calls } = audioFetch();
    const model = createElevenLabs({ apiKey: 'k', fetch })('eleven_flash_v2_5');

    await generateSpeech({
      model,
      text: 'hi',
      voice: 'v',
      // canonical format says wav — which ElevenLabs cannot do — but an explicit
      // codec string bypasses the mapping entirely.
      format: 'wav',
      providerOptions: { output_format: 'ulaw_8000', voice_settings: { stability: 0.4 } },
    });

    expect(calls[0]!.url).toContain('output_format=ulaw_8000');
    expect(bodyOf(calls[0]!)).toEqual({
      text: 'hi',
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.4 },
    });
  });
});

describe('generateSpeech — result round-trip', () => {
  it('returns the raw bytes, the mediaType from the response header, and character usage', async () => {
    const bytes = [1, 2, 3, 4, 5, 6, 7];
    const { fetch } = audioFetch(bytes, { 'content-type': 'audio/wav; charset=binary' });
    const model = createOpenAISpeech({ apiKey: 'k', fetch })('tts-1');

    const result = await generateSpeech({ model, text: 'yedi bayt', format: 'wav' });

    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect([...result.audio]).toEqual(bytes);
    expect(result.mediaType).toBe('audio/wav'); // parameters stripped
    expect(result.format).toBe('wav');
    expect(result.usage).toEqual({ characters: 'yedi bayt'.length });
  });

  it('falls back to the adapter media type when the response omits content-type', async () => {
    const model = (f: typeof fetch): SpeechModel =>
      createOpenAISpeech({ apiKey: 'k', fetch: f })('tts-1');

    const mp3 = audioFetch();
    expect((await generateSpeech({ model: model(mp3.fetch), text: 'x' })).mediaType).toBe(
      'audio/mpeg',
    );

    const flac = audioFetch();
    expect(
      (await generateSpeech({ model: model(flac.fetch), text: 'x', format: 'flac' })).mediaType,
    ).toBe('audio/flac');

    const el = audioFetch();
    const elevenLabs = createElevenLabs({ apiKey: 'k', fetch: el.fetch })('eleven_turbo_v2_5');
    expect(
      (await generateSpeech({ model: elevenLabs, text: 'x', voice: 'v', format: 'pcm' })).mediaType,
    ).toBe('audio/pcm');
  });
});

describe('generateSpeech — errors', () => {
  it('maps 401 to AuthenticationError with the provider message', async () => {
    const { fetch } = errorFetch(401, { error: { message: 'Incorrect API key provided.' } });
    const model = createOpenAISpeech({ apiKey: 'bad', fetch })('tts-1');

    await expect(generateSpeech({ model, text: 'x' })).rejects.toMatchObject({
      name: 'AuthenticationError',
      message: 'Incorrect API key provided.',
    });
  });

  it('maps 429 to RateLimitError and parses Retry-After seconds', async () => {
    const { fetch } = errorFetch(429, { error: { message: 'slow down' } }, { 'retry-after': '7' });
    const model = createOpenAISpeech({ apiKey: 'k', fetch })('tts-1');

    const err = await generateSpeech({ model, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7000);
  });

  it('maps 500 to a retryable APICallError', async () => {
    const { fetch } = errorFetch(500, 'upstream exploded'); // non-JSON-envelope body
    const model = createOpenAISpeech({ apiKey: 'k', fetch })('tts-1');

    const err = await generateSpeech({ model, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APICallError);
    expect((err as APICallError).statusCode).toBe(500);
    expect((err as APICallError).isRetryable).toBe(true);
  });

  it('extracts the ElevenLabs `detail` envelope in both of its shapes', async () => {
    const nested = errorFetch(422, {
      detail: { status: 'voice_not_found', message: 'A voice with voice_id v was not found.' },
    });
    const model = createElevenLabs({ apiKey: 'k', fetch: nested.fetch })('eleven_multilingual_v2');
    await expect(generateSpeech({ model, text: 'x', voice: 'v' })).rejects.toMatchObject({
      name: 'InvalidRequestError',
      message: 'A voice with voice_id v was not found.',
      provider: 'elevenlabs',
    });

    const flat = errorFetch(400, { detail: 'Invalid output format.' });
    const model2 = createElevenLabs({ apiKey: 'k', fetch: flat.fetch })('eleven_multilingual_v2');
    await expect(generateSpeech({ model: model2, text: 'x', voice: 'v' })).rejects.toMatchObject({
      message: 'Invalid output format.',
    });
  });

  it('throws AuthenticationError before any fetch when no key is resolvable (G1)', async () => {
    const { fetch, calls } = audioFetch();
    const model = createOpenAISpeech({ fetch })('tts-1'); // no apiKey anywhere

    await expect(generateSpeech({ model, text: 'x' })).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(0);
  });

  it('resolves the key from deps.keyProvider ahead of the factory config (G1)', async () => {
    const { fetch, calls } = audioFetch();
    const model = createOpenAISpeech({ apiKey: 'sk-factory', fetch })('tts-1');

    await generateSpeech({
      model,
      text: 'x',
      deps: { keyProvider: { getKey: () => 'sk-from-provider' } },
    });

    expect(headersOf(calls[0]!).authorization).toBe('Bearer sk-from-provider');
  });

  it('rejects an unknown speech surface before any request is built', () => {
    expect(() => getSpeechAdapter('whisper-speech')).toThrow(InvalidRequestError);
  });
});

describe('generateSpeech — cancellation', () => {
  it('forwards the caller signal to fetch and rejects when it is already aborted', async () => {
    const calls: { signal?: AbortSignal | null }[] = [];
    const abortingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ signal: init?.signal });
      // Mirror the platform: a pre-aborted signal never reaches the network.
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return new Response(new Uint8Array([0]));
    }) as typeof fetch;

    const model = createOpenAISpeech({ apiKey: 'k', fetch: abortingFetch })('tts-1');
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateSpeech({ model, text: 'x', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0]!.signal).toBe(controller.signal);
  });
});
