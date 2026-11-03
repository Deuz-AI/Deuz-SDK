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
  streamTranscription,
  createGiggyLiveTranscriptionSession,
  createOpenAITranscription,
  createDeepgram,
  createGiggyTranscription,
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

function sseFetch(frames: string[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
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

describe('Giggy uploaded-recording transcription stream', () => {
  const model = (fetch: typeof globalThis.fetch) =>
    createGiggyTranscription({ apiKey: 'giggy-key', fetch })('giggy-stt');

  it('posts raw WAV to native streaming mode and emits SSE events incrementally', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
          controller.enqueue(
            new TextEncoder().encode(
              'event: generation_created\ndata: {"generation_uuid":"g-1"}\n\n',
            ),
          );
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const wav = new Uint8Array([82, 73, 70, 70, 1, 2]);
    const output = await streamTranscription({
      model: model(fetch),
      audio: wav,
      language: 'English',
      providerOptions: { giggy: { mode: 'fast', client_request_id: 'request-1' } },
    });
    const reader = output.getReader();

    const first = await reader.read();
    expect(first.value).toMatchObject({
      type: 'generation_created',
      data: { generation_uuid: 'g-1' },
    });
    expect(calls[0]!.url).toContain(
      '/audio/transcriptions?client_request_id=request-1&mode=streaming&language=English',
    );
    expect(calls[0]!.init!.method).toBe('POST');
    expect((calls[0]!.init!.headers as Record<string, string>)['content-type']).toBe('audio/wav');
    expect((calls[0]!.init!.headers as Record<string, string>)['xi-api-key']).toBe('giggy-key');
    expect(calls[0]!.init!.body).toBeInstanceOf(Uint8Array);
    expect([...(calls[0]!.init!.body as Uint8Array)]).toEqual([...wav]);

    upstream.enqueue(
      new TextEncoder().encode(
        'event: transcript_chunk\ndata: {"text":"Hello","replace":true}\n\n',
      ),
    );
    const second = await reader.read();
    expect(second.value).toMatchObject({ type: 'transcript_chunk', text: 'Hello', replace: true });
    await reader.cancel();
  });

  it('preserves cumulative revisions and uses the last revision in buffered transcribe', async () => {
    const frames = [
      'event: generation_created\ndata: {"generation_uuid":"g-2"}\n\n',
      'event: transcript_chunk\ndata: {"text":"hel","replace":true}\n\n',
      'event: transcript_chunk\ndata: {"text":"hello world","replace":true}\n\n',
      'event: generation_updated\ndata: {"status":"completed","duration":1.2}\n\n',
    ];
    const { fetch, calls } = sseFetch(frames);
    const events = await streamTranscription({
      model: model(fetch),
      audio: AUDIO,
      mediaType: 'audio/wav',
    });
    const reader = events.getReader();
    const received = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value!);
    }
    expect(received.filter((e) => e.type === 'transcript_chunk').map((e) => e.text)).toEqual([
      'hel',
      'hello world',
    ]);
    expect(received.at(-1)).toMatchObject({ type: 'generation_updated' });

    const result = await transcribe({ model: model(fetch), audio: AUDIO, mediaType: 'audio/wav' });
    expect(result).toMatchObject({
      text: 'hello world',
      durationSeconds: 1.2,
      usage: { seconds: 1.2 },
    });
    expect(calls).toHaveLength(2);
  });

  it('surfaces a provider error event and maps it to an error for buffered transcribe', async () => {
    const { fetch } = sseFetch(['event: error\ndata: {"message":"Recording rejected"}\n\n']);
    const events = await streamTranscription({ model: model(fetch), audio: AUDIO });
    const reader = events.getReader();
    expect(await reader.read()).toMatchObject({
      done: false,
      value: { type: 'error', data: { message: 'Recording rejected' } },
    });
    expect((await reader.read()).done).toBe(true);
    await expect(transcribe({ model: model(fetch), audio: AUDIO })).rejects.toMatchObject({
      name: 'APICallError',
      message: 'Recording rejected',
    });
  });

  it('cancels the underlying SSE body when the caller cancels its reader', async () => {
    let canceled = false;
    const fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const events = await streamTranscription({ model: model(fetch), audio: AUDIO });
    const reader = events.getReader();
    await reader.cancel();
    expect(canceled).toBe(true);
  });
});

describe('Giggy live transcription WebSocket session', () => {
  function canonicalFetch(generationUuid: string, text: string, audioDurationMs: number) {
    return jsonFetch((url) =>
      url.includes('/generations/')
        ? {
            body: {
              generation_uuid: generationUuid,
              status: 'completed',
              result: { url: 'https://signed.example.test/result.json?sig=redacted' },
            },
          }
        : { body: { text, audio_duration_ms: audioDurationMs } },
    );
  }

  it('waits for ready, sends binary PCM, and validates canonical completion after input_complete', async () => {
    const resultFetch = canonicalFetch('live-1', 'final text', 1);
    const model = createGiggyTranscription({ apiKey: 'giggy-key', fetch: resultFetch.fetch })(
      'giggy-stt',
    );
    const listeners = new Map<string, (event: unknown) => void>();
    const sent: unknown[] = [];
    const socket = {
      readyState: 0,
      binaryType: 'blob',
      send(data: string) {
        sent.push(data);
      },
      close() {},
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
      removeEventListener() {},
    };
    let socketUrl = '';
    let authHeader = '';
    let followRedirects: false | undefined;
    const session = createGiggyLiveTranscriptionSession({
      model,
      language: 'English',
      deps: {
        webSocket(url, init) {
          socketUrl = url;
          authHeader = init.headers?.['xi-api-key'] ?? '';
          followRedirects = init.followRedirects;
          return socket;
        },
      },
    });
    const events = session.events();
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socketUrl).toBe('wss://api.giggy.ai/v1/audio/transcriptions');
    expect(authHeader).toBe('giggy-key');
    expect(followRedirects).toBe(false);
    listeners.get('open')?.({});
    expect(JSON.parse(sent[0] as string)).toEqual({
      type: 'start',
      format: 'raw',
      encoding: 'LINEAR16',
      sampleRateHz: 16000,
      interimResults: true,
      language: 'English',
      options: { endpointing: 'external' },
    });
    listeners.get('message')?.({
      data: JSON.stringify({ type: 'generation_created', generation: { uuid: 'live-1' } }),
    });
    listeners.get('message')?.({
      data: JSON.stringify({ type: 'ready', generation_uuid: 'live-1', attempt: 2 }),
    });
    await connected;
    expect((await events.next()).value).toEqual({
      type: 'session-ready',
      generationUuid: 'live-1',
      attempt: 2,
    });

    session.sendAudio(new Uint8Array([9, 8, 7]).subarray(1));
    expect(sent[1]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(sent[1] as ArrayBuffer)]).toEqual([8, 7]);
    const stopped = session.stop();
    expect(sent[2]).toBe(JSON.stringify({ type: 'stop' }));
    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'transcription',
        generation_uuid: 'live-1',
        attempt: 2,
        sequence: 1,
        alternatives: [{ transcript: 'draft' }],
        is_final: false,
      }),
    });
    // Replayed frames from another generation/attempt and nonmonotonic frames are fenced out.
    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'transcription',
        generation_uuid: 'old-generation',
        attempt: 2,
        sequence: 9,
        text: 'stale',
        is_final: false,
      }),
    });
    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'transcription',
        generation_uuid: 'live-1',
        attempt: 2,
        sequence: 1,
        text: 'replayed',
        is_final: false,
      }),
    });
    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'transcription',
        generation_uuid: 'live-1',
        attempt: 2,
        sequence: 2,
        alternatives: [{ transcript: 'final text' }],
        is_final: true,
      }),
    });
    listeners.get('message')?.({
      data: JSON.stringify({ type: 'input_complete', generation_uuid: 'live-1', sequence: 3 }),
    });
    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'generation_updated',
        generation: { generation_uuid: 'live-1', status: 'completed' },
      }),
    });
    await stopped;
    expect(session.status).toBe('completed');
    expect(session.transcript).toBe('final text');
    expect((await events.next()).value).toMatchObject({
      type: 'transcript',
      text: 'draft',
      replace: true,
    });
    expect((await events.next()).value).toMatchObject({
      type: 'transcript',
      text: 'final text',
      isFinal: true,
    });
    expect((await events.next()).value).toMatchObject({
      type: 'input-complete',
      generationUuid: 'live-1',
    });
    expect((await events.next()).value).toMatchObject({
      type: 'generation-updated',
      status: 'completed',
    });
    expect(resultFetch.calls).toHaveLength(2);
    expect((resultFetch.calls[0]!.init?.headers as Record<string, string>)['xi-api-key']).toBe(
      'giggy-key',
    );
    expect(resultFetch.calls[1]!.init?.headers).toBeUndefined();
  });

  it('closes the socket and ends the event iterator on abort', async () => {
    const model = createGiggyTranscription({ apiKey: 'k' })('giggy-stt');
    const listeners = new Map<string, (event: unknown) => void>();
    let closed = false;
    const controller = new AbortController();
    const session = createGiggyLiveTranscriptionSession({
      model,
      signal: controller.signal,
      deps: {
        webSocket: () => ({
          readyState: 0,
          send() {},
          close() {
            closed = true;
          },
          addEventListener(type, listener) {
            listeners.set(type, listener);
          },
        }),
      },
    });
    const events = session.events();
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('open')?.({});
    controller.abort();
    await expect(connected).rejects.toBeTruthy();
    expect(closed).toBe(true);
    expect((await events.next()).value).toMatchObject({ type: 'error' });
  });

  it('waits for both final transcript and input_complete, in either order', async () => {
    const resultFetch = canonicalFetch('g-final', 'final', 1000);
    const model = createGiggyTranscription({ apiKey: 'k', fetch: resultFetch.fetch })('giggy-stt');
    const listeners = new Map<string, (event: unknown) => void>();
    const socket = {
      readyState: 0,
      send() {},
      close() {},
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
    };
    const session = createGiggyLiveTranscriptionSession({
      model,
      deps: { webSocket: () => socket },
    });
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('open')?.({});
    const send = (payload: unknown) =>
      listeners.get('message')?.({ data: JSON.stringify(payload) });
    send({ type: 'generation_created', generation_uuid: 'g-final' });
    send({ type: 'ready', generation_uuid: 'g-final', attempt: 1 });
    await connected;
    session.sendAudio(new Uint8Array(32_000));
    const stopped = session.stop();
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    send({ type: 'input_complete', generation_uuid: 'g-final', sequence: 1 });
    await Promise.resolve();
    expect(settled).toBe(false);
    send({
      type: 'transcription',
      generation_uuid: 'g-final',
      attempt: 1,
      sequence: 2,
      alternatives: [{ transcript: 'final' }],
      is_final: true,
    });
    send({ type: 'generation_updated', generation_uuid: 'g-final', status: 'completed' });
    await stopped;
    expect(settled).toBe(true);
  });

  it('uses the canonical completed result as final when the socket sends no final marker', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let releaseArtifact!: () => void;
    const artifactGate = new Promise<void>((resolve) => {
      releaseArtifact = resolve;
    });
    const fetchResult = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/generations/')) {
        return new Response(
          JSON.stringify({
            generation_uuid: 'g-canonical',
            status: 'completed',
            result: { url: 'https://signed.example.test/result.json?sig=redacted' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      await artifactGate;
      return new Response(JSON.stringify({ text: 'authoritative text', audio_duration_ms: 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const model = createGiggyTranscription({ apiKey: 'k', fetch: fetchResult })('giggy-stt');
    const listeners = new Map<string, (event: unknown) => void>();
    const socket = {
      readyState: 0,
      send() {},
      close() {},
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
    };
    const session = createGiggyLiveTranscriptionSession({
      model,
      deps: { webSocket: () => socket },
    });
    const events = session.events();
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('open')?.({});
    const send = (payload: unknown) =>
      listeners.get('message')?.({ data: JSON.stringify(payload) });
    send({ type: 'generation_created', generation_uuid: 'g-canonical' });
    send({ type: 'ready', generation_uuid: 'g-canonical', attempt: 1 });
    await connected;
    session.sendAudio(new Uint8Array(32_000));
    const stopped = session.stop();
    send({
      type: 'transcription',
      generation_uuid: 'g-canonical',
      attempt: 1,
      sequence: 1,
      alternatives: [{ transcript: 'provisional text' }],
      replace: true,
      is_final: false,
    });
    send({ type: 'input_complete', generation_uuid: 'g-canonical', sequence: 2 });
    send({
      type: 'generation_updated',
      generation: { generation_uuid: 'g-canonical', status: 'completed' },
    });
    listeners.get('close')?.({ code: 1000, reason: 'completed' });
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.status).toBe('stopping');
    expect(settled).toBe(false);
    expect(calls).toHaveLength(2);
    releaseArtifact();
    await stopped;

    expect(session.status).toBe('completed');
    expect(session.transcript).toBe('authoritative text');
    const received = [];
    for (;;) {
      const next = await events.next();
      if (next.done) break;
      received.push(next.value);
    }
    expect(received.filter((event) => event.type === 'transcript')).toEqual([
      expect.objectContaining({ text: 'provisional text', isFinal: false, source: 'websocket' }),
      expect.objectContaining({
        text: 'authoritative text',
        replace: true,
        isFinal: true,
        source: 'canonical-result',
      }),
    ]);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.init?.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect(calls[1]!.init?.headers).toBeUndefined();
  });

  it('rejects stale generation status and failed signed artifact fetches', async () => {
    const run = async (
      fetchHandler: ReturnType<typeof jsonFetch>['fetch'],
      expectedMessage: string,
    ) => {
      const model = createGiggyTranscription({ apiKey: 'k', fetch: fetchHandler })('giggy-stt');
      const listeners = new Map<string, (event: unknown) => void>();
      const session = createGiggyLiveTranscriptionSession({
        model,
        deps: {
          webSocket: () => ({
            readyState: 0,
            send() {},
            close() {},
            addEventListener(type: string, listener: (event: unknown) => void) {
              listeners.set(type, listener);
            },
          }),
        },
      });
      const connected = session.connect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      listeners.get('open')?.({});
      const send = (payload: unknown) =>
        listeners.get('message')?.({ data: JSON.stringify(payload) });
      send({ type: 'generation_created', generation_uuid: 'g-error' });
      send({ type: 'ready', generation_uuid: 'g-error', attempt: 1 });
      await connected;
      session.sendAudio(new Uint8Array(32_000));
      const stopped = session.stop();
      send({ type: 'input_complete', generation_uuid: 'g-error', sequence: 1 });
      send({ type: 'generation_updated', generation_uuid: 'g-error', status: 'completed' });
      await expect(stopped).rejects.toMatchObject({
        name: 'APICallError',
        message: expect.stringContaining(expectedMessage),
      });
    };

    await run(
      jsonFetch((url) => ({
        body: url.includes('/generations/')
          ? {
              generation_uuid: 'stale-id',
              status: 'completed',
              result: { url: 'https://signed.example.test/result' },
            }
          : { text: 'ignored', audio_duration_ms: 1000 },
      })).fetch,
      'identity or status did not match',
    );
    await run(
      jsonFetch((url) =>
        url.includes('/generations/')
          ? {
              body: {
                generation_uuid: 'g-error',
                status: 'completed',
                result: { url: 'https://signed.example.test/result' },
              },
            }
          : { status: 403, body: { error: 'expired' } },
      ).fetch,
      'download failed with HTTP 403',
    );
  });

  it('rejects a ready event for a different generation and bounds readiness/stop waits', async () => {
    const model = createGiggyTranscription({ apiKey: 'k' })('giggy-stt');
    const listeners = new Map<string, (event: unknown) => void>();
    const socket = {
      readyState: 0,
      send() {},
      close() {},
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
    };
    const mismatch = createGiggyLiveTranscriptionSession({
      model,
      connectTimeoutMs: 500,
      deps: { webSocket: () => socket },
    });
    const connecting = mismatch.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('open')?.({});
    const send = (payload: unknown) =>
      listeners.get('message')?.({ data: JSON.stringify(payload) });
    send({ type: 'generation_created', generation_uuid: 'admitted' });
    send({ type: 'ready', generation_uuid: 'another', attempt: 1 });
    await expect(connecting).rejects.toMatchObject({
      name: 'APICallError',
      message: expect.stringContaining('did not match'),
    });

    const waitingForReady = createGiggyLiveTranscriptionSession({
      model,
      connectTimeoutMs: 100,
      deps: {
        webSocket: () => ({
          ...socket,
          addEventListener(type: string, listener: (event: unknown) => void) {
            listeners.set(type, listener);
          },
        }),
      },
    });
    await expect(waitingForReady.connect()).rejects.toMatchObject({
      name: 'APICallError',
      message: expect.stringContaining('did not become ready'),
    });

    const stopping = createGiggyLiveTranscriptionSession({
      model,
      stopTimeoutMs: 100,
      deps: {
        webSocket: () => ({
          ...socket,
          addEventListener(type: string, listener: (event: unknown) => void) {
            listeners.set(type, listener);
          },
        }),
      },
    });
    const stopped = stopping.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('open')?.({});
    send({ type: 'generation_created', generation_uuid: 'timeout' });
    send({ type: 'ready', generation_uuid: 'timeout', attempt: 1 });
    await stopped;
    await expect(stopping.stop()).rejects.toMatchObject({
      name: 'APICallError',
      message: expect.stringContaining('did not deliver'),
    });
  });

  it('rejects an undocumented [DONE] SSE sentinel instead of treating it as terminal', async () => {
    const { fetch } = sseFetch(['data: [DONE]\n\n']);
    const events = await streamTranscription({
      model: createGiggyTranscription({ apiKey: 'k', fetch })('giggy-stt'),
      audio: AUDIO,
    });
    await expect(events.getReader().read()).rejects.toMatchObject({
      name: 'APICallError',
      message: expect.stringContaining('undocumented [DONE]'),
    });
  });
});
