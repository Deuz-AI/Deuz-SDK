/**
 * transcribe (STT) — golden-replay over the two wires.
 *
 * OpenAI is multipart (and the boundary MUST come from fetch, not from us);
 * Deepgram is a raw-byte POST with a `Token` auth scheme and a query-string API.
 * The tests below pin both wires byte-for-byte plus the shared G1/error paths.
 */
import { describe, it, expect } from 'vitest';
import {
  transcribe,
  createOpenAITranscription,
  createDeepgram,
  type TranscribeResult,
} from '../src/transcription';
import { createMemoryObserver } from '../src/observe';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  RateLimitError,
} from '../src/errors';

/** A fetch double that returns a JSON Response and records each request. */
function jsonFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    calls.push({ url: String(input), init });
    const { status = 200, body, headers } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function formOf(init: RequestInit | undefined): FormData {
  expect(init!.body).toBeInstanceOf(FormData);
  return init!.body as FormData;
}

const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00]);

const OPENAI_JSON = { text: 'Merhaba dünya.' };

const OPENAI_VERBOSE = {
  task: 'transcribe',
  language: 'turkish',
  duration: 4.2,
  text: 'Merhaba dünya.',
  segments: [{ id: 0, seek: 0, start: 0, end: 4.2, text: ' Merhaba dünya.' }],
  words: [
    { word: 'Merhaba', start: 0, end: 0.8 },
    { word: 'dünya', start: 0.9, end: 1.4 },
  ],
};

const OPENAI_TOKEN_USAGE = {
  text: 'Merhaba dünya.',
  usage: {
    type: 'tokens',
    input_tokens: 23,
    input_token_details: { text_tokens: 9, audio_tokens: 14 },
    output_tokens: 6,
    total_tokens: 29,
  },
};

const DEEPGRAM_NOVA3 = {
  metadata: { request_id: 'req-1', duration: 12.5, channels: 1, models: ['nova-3'] },
  results: {
    channels: [
      {
        detected_language: 'en',
        alternatives: [
          {
            transcript: 'Hello world. How are you?',
            confidence: 0.99,
            words: [
              { word: 'hello', start: 0.1, end: 0.5, confidence: 0.98, punctuated_word: 'Hello' },
              { word: 'world', start: 0.5, end: 0.9, confidence: 0.97, punctuated_word: 'world.' },
              { word: 'how', start: 1.2, end: 1.4, confidence: 0.95, punctuated_word: 'How' },
              { word: 'are', start: 1.4, end: 1.6, confidence: 0.96 },
              { word: 'you', start: 1.6, end: 1.9, confidence: 0.94, punctuated_word: 'you?' },
            ],
            paragraphs: {
              transcript: 'Hello world. How are you?',
              paragraphs: [
                {
                  start: 0.1,
                  end: 1.9,
                  num_words: 5,
                  sentences: [
                    { text: 'Hello world.', start: 0.1, end: 0.9 },
                    { text: 'How are you?', start: 1.2, end: 1.9 },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

// ===================================================================
// OpenAI — multipart /audio/transcriptions
// ===================================================================

describe('transcribe (OpenAI /audio/transcriptions)', () => {
  it('POSTs multipart FormData with the canonical fields and Bearer auth', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'sk-test', fetch })('gpt-4o-transcribe');

    const res = await transcribe({
      model,
      audio: AUDIO,
      mediaType: 'audio/mpeg',
      language: 'tr',
      prompt: 'Deuz SDK',
    });

    expect(res.text).toBe('Merhaba dünya.');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0]!.init!.method).toBe('POST');

    const form = formOf(calls[0]!.init);
    expect(form.get('model')).toBe('gpt-4o-transcribe');
    expect(form.get('language')).toBe('tr');
    expect(form.get('prompt')).toBe('Deuz SDK');
    expect(form.get('response_format')).toBe('json');

    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('audio.mp3');
    expect((file as Blob).type).toBe('audio/mpeg');
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(AUDIO);

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  it('never hand-sets content-type — fetch owns the multipart boundary', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    await transcribe({ model, audio: AUDIO, mediaType: 'audio/wav' });

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('keeps response_format=json for gpt-4o-transcribe even with timestamps:true', async () => {
    // verbose_json is whisper-only; a 4o model 400s on it, so the gate is a hard
    // requirement, not a nicety.
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('gpt-4o-transcribe');
    await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg', timestamps: true });

    const form = formOf(calls[0]!.init);
    expect(form.get('response_format')).toBe('json');
    expect(form.getAll('timestamp_granularities[]')).toEqual([]);
  });

  it('whisper-1 + timestamps:true asks for verbose_json with both granularities', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_VERBOSE }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    const res = await transcribe({
      model,
      audio: AUDIO,
      mediaType: 'audio/mpeg',
      timestamps: true,
    });

    const form = formOf(calls[0]!.init);
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);

    expect(res.language).toBe('turkish');
    expect(res.durationSeconds).toBe(4.2);
    expect(res.segments).toEqual([{ start: 0, end: 4.2, text: ' Merhaba dünya.' }]);
    expect(res.words).toEqual([
      { word: 'Merhaba', start: 0, end: 0.8 },
      { word: 'dünya', start: 0.9, end: 1.4 },
    ]);
    // verbose_json carries no `usage` — duration is the billed quantity.
    expect(res.usage).toEqual({ seconds: 4.2 });
  });

  it('maps gpt-4o-transcribe token usage (incl. the audio slice)', async () => {
    const { fetch } = jsonFetch(() => ({ body: OPENAI_TOKEN_USAGE }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('gpt-4o-transcribe');
    const res = await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg' });

    expect(res.usage).toEqual({
      inputTokens: 23,
      outputTokens: 6,
      audioTokens: 14,
      totalTokens: 29,
    });
    expect(res.durationSeconds).toBeUndefined();
    expect(res.segments).toBeUndefined();
    expect(res.raw).toEqual(OPENAI_TOKEN_USAGE);
  });

  it('derives the upload filename from mediaType, and lets `filename` override it', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');

    await transcribe({ model, audio: AUDIO, mediaType: 'audio/wav' });
    await transcribe({ model, audio: AUDIO, mediaType: 'audio/x-m4a; codecs=mp4a.40.2' });
    await transcribe({ model, audio: AUDIO }); // no mediaType at all
    await transcribe({ model, audio: AUDIO, mediaType: 'audio/wav', filename: 'meeting.wav' });

    const names = calls.map((c) => (formOf(c.init).get('file') as File).name);
    expect(names).toEqual(['audio.wav', 'audio.m4a', 'audio.bin', 'meeting.wav']);
  });

  it('accepts a Blob (type reused) and an ArrayBuffer', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');

    await transcribe({ model, audio: new Blob([AUDIO], { type: 'audio/flac' }) });
    await transcribe({ model, audio: AUDIO.buffer as ArrayBuffer, mediaType: 'audio/ogg' });

    const first = formOf(calls[0]!.init).get('file') as File;
    expect(first.name).toBe('audio.flac');
    expect(first.type).toBe('audio/flac');
    expect((formOf(calls[1]!.init).get('file') as File).name).toBe('audio.ogg');
  });

  it('appends providerOptions.openai as extra form fields, canonical wins', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    await transcribe({
      model,
      audio: AUDIO,
      mediaType: 'audio/mpeg',
      language: 'tr',
      providerOptions: {
        openai: { temperature: 0, chunking_strategy: 'auto', language: 'de', dropped: undefined },
      },
    });

    const form = formOf(calls[0]!.init);
    expect(form.get('temperature')).toBe('0');
    expect(form.get('chunking_strategy')).toBe('auto');
    expect(form.getAll('language')).toEqual(['tr']); // canonical wins, no duplicate part
    expect(form.has('dropped')).toBe(false);
  });
});

// ===================================================================
// Deepgram — /listen?model=…
// ===================================================================

describe('transcribe (Deepgram /listen)', () => {
  it('pins the query string, the Token auth scheme, and the raw-byte body', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: DEEPGRAM_NOVA3 }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-3');
    await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg', language: 'en' });

    expect(calls[0]!.url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true',
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Token k'); // NOT Bearer
    expect(headers['content-type']).toBe('audio/mpeg');
    expect(calls[0]!.init!.body).toBeInstanceOf(Uint8Array);
    expect(calls[0]!.init!.body).toEqual(AUDIO);
  });

  it('omits `language` when unset', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: DEEPGRAM_NOVA3 }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-2');
    await transcribe({ model, audio: AUDIO, mediaType: 'audio/wav' });
    expect(calls[0]!.url).toBe('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true');
  });

  it('sends { url } as a JSON body with a JSON content-type', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: DEEPGRAM_NOVA3 }));
    const model = createDeepgram({ apiKey: 'dg', fetch })('nova-3');
    await transcribe({ model, audio: { url: 'https://cdn.example/talk.mp3' } });

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Token dg');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      url: 'https://cdn.example/talk.mp3',
    });
  });

  it('routes providerOptions.deepgram into the query and can disable smart_format', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: DEEPGRAM_NOVA3 }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-3');

    await transcribe({
      model,
      audio: AUDIO,
      mediaType: 'audio/mpeg',
      providerOptions: { deepgram: { diarize: true, utterances: true, model: 'ignored' } },
    });
    await transcribe({
      model,
      audio: AUDIO,
      mediaType: 'audio/mpeg',
      providerOptions: { deepgram: { smart_format: false, punctuate: true } },
    });

    expect(calls[0]!.url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&utterances=true',
    );
    expect(calls[1]!.url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true');
  });

  it('parses words, paragraph sentences, duration and detected language', async () => {
    const { fetch } = jsonFetch(() => ({ body: DEEPGRAM_NOVA3 }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-3');
    const res = await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg' });

    expect(res.text).toBe('Hello world. How are you?');
    expect(res.language).toBe('en');
    expect(res.durationSeconds).toBe(12.5);
    expect(res.usage).toEqual({ seconds: 12.5 });
    // `punctuated_word` wins; the raw token is the fallback ('are' has none).
    expect(res.words?.map((w) => w.word)).toEqual(['Hello', 'world.', 'How', 'are', 'you?']);
    expect(res.words?.[0]).toEqual({ word: 'Hello', start: 0.1, end: 0.5, confidence: 0.98 });
    expect(res.segments).toEqual([
      { start: 0.1, end: 0.9, text: 'Hello world.' },
      { start: 1.2, end: 1.9, text: 'How are you?' },
    ]);
  });

  it('tolerates an empty results envelope', async () => {
    const { fetch } = jsonFetch(() => ({ body: { metadata: {}, results: { channels: [] } } }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-3');
    const res = await transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg' });
    expect(res).toMatchObject({ text: '', usage: {} });
    expect(res.words).toBeUndefined();
  });
});

// ===================================================================
// Cross-wire: input validation, key resolution, errors, abort
// ===================================================================

describe('transcribe (shared behavior)', () => {
  it('rejects a { url } input on the OpenAI wire before any fetch', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch;
    const model = createOpenAITranscription({ apiKey: 'k', fetch: fetchImpl })('whisper-1');

    await expect(
      transcribe({ model, audio: { url: 'https://cdn.example/talk.mp3' } }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      transcribe({ model, audio: { url: 'https://cdn.example/talk.mp3' } }),
    ).rejects.toThrow(/Deepgram-specific/);
    expect(fetched).toBe(false);
  });

  it('rejects an unsupported audio input shape', async () => {
    const { fetch } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    await expect(
      transcribe({ model, audio: 'not audio' as unknown as Uint8Array }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('throws AuthenticationError before any fetch when no key is resolvable', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch;
    const model = createDeepgram({ fetch: fetchImpl })('nova-3');
    await expect(transcribe({ model, audio: AUDIO })).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetched).toBe(false);
  });

  it('resolves the key from deps.keyProvider (G1 top link)', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: DEEPGRAM_NOVA3 }));
    const model = createDeepgram({ apiKey: 'factory', fetch })('nova-3');
    await transcribe({
      model,
      audio: AUDIO,
      deps: { keyProvider: { getKey: () => 'dg-from-provider' } },
    });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe(
      'Token dg-from-provider',
    );
  });

  it('honors a factory baseURL and per-call headers', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({
      apiKey: 'k',
      baseURL: 'https://relay.example/v1/',
      headers: { 'x-factory': 'yes' },
      fetch,
    })('whisper-1');
    await transcribe({ model, audio: AUDIO, headers: { 'x-call': 'also' } });

    expect(calls[0]!.url).toBe('https://relay.example/v1/audio/transcriptions');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-factory']).toBe('yes');
    expect(headers['x-call']).toBe('also');
  });

  it('maps 401 / 429 / 5xx onto the canonical error classes', async () => {
    const model = (status: number, body: unknown, headers?: Record<string, string>) => {
      const { fetch } = jsonFetch(() => ({ status, body, headers }));
      return createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    };

    await expect(
      transcribe({ model: model(401, { error: { message: 'bad key' } }), audio: AUDIO }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const rate = transcribe({
      model: model(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }),
      audio: AUDIO,
    });
    await expect(rate).rejects.toBeInstanceOf(RateLimitError);
    await rate.catch((err: RateLimitError) => {
      expect(err.retryAfterMs).toBe(2000);
      expect(err.message).toBe('slow down');
    });

    const server = transcribe({ model: model(503, 'upstream unavailable'), audio: AUDIO });
    await expect(server).rejects.toBeInstanceOf(APICallError);
    await server.catch((err: APICallError) => expect(err.isRetryable).toBe(true));
  });

  it('surfaces the Deepgram { err_code, err_msg } envelope as the message', async () => {
    const { fetch } = jsonFetch(() => ({
      status: 400,
      body: { err_code: 'Bad Request', err_msg: 'Content-type was unsupported.', request_id: 'r1' },
    }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-3');
    const call = transcribe({ model, audio: AUDIO, mediaType: 'audio/mpeg' });
    await expect(call).rejects.toBeInstanceOf(InvalidRequestError);
    await call.catch((err: InvalidRequestError) => {
      expect(err.message).toBe('Content-type was unsupported.');
      expect(err.upstreamType).toBe('Bad Request');
      expect(err.provider).toBe('deepgram');
    });
  });

  it('forwards the abort signal to fetch', async () => {
    const { fetch, calls } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');

    const live = new AbortController();
    await transcribe({ model, audio: AUDIO, signal: live.signal });
    expect(calls[0]!.init!.signal).toBe(live.signal);

    const aborted = new AbortController();
    aborted.abort();
    await expect(transcribe({ model, audio: AUDIO, signal: aborted.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(calls).toHaveLength(1); // the aborted call never reached the recorder
  });

  it('emits operation.started/completed under the transcription subsystem', async () => {
    const mem = createMemoryObserver();
    const { fetch } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    await transcribe({ model, audio: AUDIO, deps: { observer: mem } });

    const events = mem.events();
    expect(events.map((e) => e.type)).toEqual(['operation.started', 'operation.completed']);
    expect(events[0]).toMatchObject({
      subsystem: 'transcription',
      operation: 'transcription.transcribe',
      itemCount: 1,
    });
  });

  it('emits operation.failed and rethrows', async () => {
    const mem = createMemoryObserver();
    const { fetch } = jsonFetch(() => ({ status: 429, body: { error: { message: 'nope' } } }));
    const model = createDeepgram({ apiKey: 'k', fetch })('nova-3');
    await expect(
      transcribe({ model, audio: AUDIO, deps: { observer: mem } }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(mem.events().at(-1)).toMatchObject({
      type: 'operation.failed',
      subsystem: 'transcription',
    });
  });

  it('keeps the result shape narrow: no undefined keys leak in', async () => {
    const { fetch } = jsonFetch(() => ({ body: OPENAI_JSON }));
    const model = createOpenAITranscription({ apiKey: 'k', fetch })('whisper-1');
    const res: TranscribeResult = await transcribe({ model, audio: AUDIO });
    expect(Object.keys(res).sort()).toEqual(['raw', 'text', 'usage']);
  });
});
