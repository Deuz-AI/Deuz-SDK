/**
 * adapters/transcription.ts — the speech-to-text wires (2.0).
 *
 * Two providers, two radically different request shapes, one seam:
 *
 * - **OpenAI** (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`) —
 *   `POST {baseURL}/audio/transcriptions`, `multipart/form-data`, Bearer auth.
 * - **Deepgram** (`nova-3`, `nova-2`, …) — `POST {baseURL}/listen?model=…`, the
 *   audio as the RAW request body (or a `{ url }` JSON pointer), and a
 *   `Token`-scheme authorization header that is NOT `Bearer`.
 *
 * Like the embedding adapters these are pure of I/O: they build a request and
 * parse a response, nothing else. `transcription.ts` owns key resolution (G1),
 * the fetch, and observation.
 */
import type { AdapterRequest } from './types';
import type { DeuzError } from '../errors';
import { InvalidRequestError } from '../errors';
import { mapMediaError } from '../internal/media-http';

/**
 * Resolved transcription call — the STT analogue of `EmbeddingCall`, produced by
 * `resolveTranscriptionCall` in `transcription.ts`.
 */
export interface TranscriptionCall {
  provider: string;
  modelId: string;
  apiKey: string;
  /** Provider root URL (no trailing slash). */
  baseURL: string;
  headers: Record<string, string>;
}

/**
 * The audio payload, already normalized by `transcribe()` — exactly one of the
 * three fields is set. `url` is a Deepgram-only wire feature; the OpenAI wire
 * rejects it (see `openaiTranscription.buildRequest`).
 */
export interface TranscriptionAudio {
  /**
   * Raw audio bytes, guaranteed to be backed by a plain `ArrayBuffer` — that is
   * what `BodyInit`/`BlobPart` require since TS 5.7 made the typed arrays
   * generic over their buffer, and it is what `normalizeAudio` establishes.
   */
  bytes?: Uint8Array<ArrayBuffer>;
  /** A caller-supplied Blob, forwarded verbatim (no copy). */
  blob?: Blob;
  /** Remote audio URL — Deepgram fetches it server-side. */
  url?: string;
}

export interface TranscriptionBuildContext {
  call: TranscriptionCall;
  audio: TranscriptionAudio;
  /** IANA media type of the audio, e.g. `'audio/mpeg'`. */
  mediaType?: string;
  /** Overrides the filename derived from `mediaType` (OpenAI multipart only). */
  filename?: string;
  /** ISO-639-1 hint, e.g. `'tr'`. Omit to let the provider detect. */
  language?: string;
  /** Vocabulary/style hint (OpenAI only). */
  prompt?: string;
  /** Ask for segment + word timings. See the `verbose_json` gate below. */
  timestamps?: boolean;
  /** Per-provider escape hatch, keyed by provider name. Canonical fields win. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/** One timed chunk of transcript — a sentence/utterance, not a word. */
export interface TranscriptionSegment {
  /** Offset from the start of the audio, in seconds. */
  start: number;
  end: number;
  text: string;
}

/** One timed word of transcript. */
export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  /** Provider confidence in [0..1], when reported (Deepgram). */
  confidence?: number;
}

/**
 * Billing signal, normalized across the two very different meters: OpenAI's
 * newer models bill TOKENS, everything else bills audio SECONDS. Every field is
 * optional because a provider reports one meter or the other, never both.
 */
export interface TranscriptionUsage {
  /** Billed audio seconds, when the provider reports a duration. */
  seconds?: number;
  /** Prompt tokens (`gpt-4o-transcribe` and friends). */
  inputTokens?: number;
  outputTokens?: number;
  /** The audio-derived slice of `inputTokens`. */
  audioTokens?: number;
  totalTokens?: number;
}

export interface TranscriptionParseResult {
  text: string;
  /** Detected (or echoed) language, when the provider reports one. */
  language?: string;
  /** Audio length in seconds, when the provider reports one. */
  durationSeconds?: number;
  segments?: TranscriptionSegment[];
  words?: TranscriptionWord[];
  usage: TranscriptionUsage;
}

/**
 * The seam every transcription wire implements. Mirrors `EmbeddingAdapter`:
 * pure-JSON responses, no streaming, no orchestration.
 */
export interface TranscriptionAdapter {
  buildRequest(ctx: TranscriptionBuildContext): AdapterRequest;
  parseResponse(json: unknown): TranscriptionParseResult;
  mapError(status: number, body: unknown, headers: Headers): DeuzError;
}

// --- shared helpers ---

/**
 * Media type → upload filename. OpenAI does NOT read the multipart part's
 * `Content-Type`; it dispatches on the **file extension**, so `audio.bin` is a
 * 400 ("Invalid file format") no matter how correct the type is. Callers that
 * pass a `mediaType` (or a typed Blob) get the right extension for free; the
 * `audio.bin` fallback exists only so a missing type fails loudly upstream
 * rather than silently mislabelling the bytes as something they are not.
 */
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/webm': 'webm',
};

/** Strip `; codecs=…` parameters and case-fold — `audio/WAV; x=1` → `audio/wav`. */
function baseMediaType(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;
  const base = mediaType.split(';')[0]?.trim().toLowerCase();
  return base ? base : undefined;
}

function defaultFilename(mediaType: string | undefined): string {
  const ext = MEDIA_TYPE_EXTENSIONS[baseMediaType(mediaType) ?? ''];
  return ext ? `audio.${ext}` : 'audio.bin';
}

/** Wrap the normalized audio as a Blob for a multipart part. */
function toBlob(audio: TranscriptionAudio, mediaType: string | undefined): Blob {
  if (audio.blob) return audio.blob;
  const type = baseMediaType(mediaType) ?? 'application/octet-stream';
  return new Blob([audio.bytes ?? new Uint8Array(0)], { type });
}

// ===================================================================
// OpenAI — POST {baseURL}/audio/transcriptions, multipart, Bearer auth
// ===================================================================

/**
 * `verbose_json` (the only format that carries segment/word timings) is a
 * **whisper-only** response format: `gpt-4o-transcribe` and
 * `gpt-4o-mini-transcribe` reject it with a 400. So `timestamps: true` is gated
 * on the slug — asking a 4o model for timings degrades to plain `json` rather
 * than failing the call.
 */
function supportsVerboseJson(modelId: string): boolean {
  return modelId.startsWith('whisper');
}

export const openaiTranscription: TranscriptionAdapter = {
  buildRequest({
    call,
    audio,
    mediaType,
    filename,
    language,
    prompt,
    timestamps,
    providerOptions,
  }): AdapterRequest {
    if (audio.url !== undefined) {
      throw new InvalidRequestError({
        message:
          'Audio URL input is Deepgram-specific — the OpenAI transcription wire uploads bytes. Pass a Uint8Array, ArrayBuffer, or Blob (or fetch the URL yourself first).',
        provider: call.provider,
      });
    }

    const type = mediaType ?? audio.blob?.type;
    const form = new FormData();
    form.append('file', toBlob(audio, type), filename ?? defaultFilename(type));
    form.append('model', call.modelId);
    if (language !== undefined) form.append('language', language);
    if (prompt !== undefined) form.append('prompt', prompt);

    const verbose = timestamps === true && supportsVerboseJson(call.modelId);
    form.append('response_format', verbose ? 'verbose_json' : 'json');
    if (verbose) {
      // Array-valued multipart fields repeat the key — one append per value.
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
    }

    // Escape hatch, canonical-wins: a provider option never overwrites a field
    // this adapter already appended (FormData.has, not a hand-kept key list).
    for (const [key, value] of Object.entries(providerOptions?.openai ?? {})) {
      if (value === undefined || value === null) continue;
      if (form.has(key)) continue;
      form.append(key, String(value));
    }

    return {
      url: `${call.baseURL}/audio/transcriptions`,
      init: {
        method: 'POST',
        // NO content-type here — fetch writes `multipart/form-data; boundary=…`
        // itself, and a hand-set header would omit the boundary and 400.
        headers: {
          authorization: `Bearer ${call.apiKey}`,
          ...call.headers,
        },
        body: form,
      },
    };
  },
  parseResponse(json): TranscriptionParseResult {
    const j = (json ?? {}) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: { start?: number; end?: number; text?: string }[];
      words?: { word?: string; start?: number; end?: number }[];
      usage?: {
        type?: string;
        seconds?: number;
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_token_details?: { text_tokens?: number; audio_tokens?: number };
      };
    };

    const usage: TranscriptionUsage = {};
    // Two meters: `{ type: 'duration', seconds }` (whisper-1) and
    // `{ type: 'tokens', input_tokens, … }` (gpt-4o-transcribe).
    if (j.usage?.seconds !== undefined) usage.seconds = j.usage.seconds;
    if (j.usage?.input_tokens !== undefined) usage.inputTokens = j.usage.input_tokens;
    if (j.usage?.output_tokens !== undefined) usage.outputTokens = j.usage.output_tokens;
    if (j.usage?.input_token_details?.audio_tokens !== undefined) {
      usage.audioTokens = j.usage.input_token_details.audio_tokens;
    }
    if (j.usage?.total_tokens !== undefined) usage.totalTokens = j.usage.total_tokens;
    // verbose_json has no `usage` at all — the duration is the billed quantity.
    if (usage.seconds === undefined && j.duration !== undefined) usage.seconds = j.duration;

    const result: TranscriptionParseResult = { text: j.text ?? '', usage };
    if (j.language !== undefined) result.language = j.language;
    if (j.duration !== undefined) result.durationSeconds = j.duration;
    if (j.segments) {
      result.segments = j.segments.map((s) => ({
        start: s.start ?? 0,
        end: s.end ?? 0,
        text: s.text ?? '',
      }));
    }
    if (j.words) {
      result.words = j.words.map((w) => ({
        word: w.word ?? '',
        start: w.start ?? 0,
        end: w.end ?? 0,
      }));
    }
    return result;
  },
  mapError: (status, body, headers) =>
    mapMediaError(
      'openai',
      status,
      body,
      headers,
      `Transcription request failed (HTTP ${status}).`,
    ),
};

// ===================================================================
// Deepgram — POST {baseURL}/listen?model=…, `Token` auth, raw-byte body
// ===================================================================

interface DeepgramAlternative {
  transcript?: string;
  words?: {
    word?: string;
    punctuated_word?: string;
    start?: number;
    end?: number;
    confidence?: number;
  }[];
  paragraphs?: {
    paragraphs?: { sentences?: { text?: string; start?: number; end?: number }[] }[];
  };
}

export const deepgramTranscription: TranscriptionAdapter = {
  // `timestamps` is absent from this signature on purpose: Deepgram ALWAYS
  // returns word timings, so the flag needs no wire representation here.
  buildRequest({ call, audio, mediaType, language, providerOptions }): AdapterRequest {
    const query = new URLSearchParams();
    query.set('model', call.modelId);
    if (language !== undefined) query.set('language', language);

    const extras = providerOptions?.deepgram ?? {};
    // `smart_format` (punctuation, casing, paragraph grouping) is off by default
    // upstream; we turn it ON because it is what makes `paragraphs` — and hence
    // our `segments` — exist. Opt out with `providerOptions.deepgram`.
    if (extras.smart_format !== false) query.set('smart_format', 'true');
    for (const [key, value] of Object.entries(extras)) {
      if (key === 'smart_format') continue;
      if (value === undefined || value === null) continue;
      if (query.has(key)) continue; // canonical wins
      query.set(key, String(value));
    }
    const url = `${call.baseURL}/listen?${query.toString()}`;
    const authorization = `Token ${call.apiKey}`; // NOT Bearer — Deepgram's own scheme.

    if (audio.url !== undefined) {
      return {
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization, ...call.headers },
          body: JSON.stringify({ url: audio.url }),
        },
      };
    }

    const body = audio.blob ?? audio.bytes ?? new Uint8Array(0);
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'content-type':
            baseMediaType(mediaType) ?? audio.blob?.type ?? 'application/octet-stream',
          authorization,
          ...call.headers,
        },
        body,
      },
    };
  },
  parseResponse(json): TranscriptionParseResult {
    const j = (json ?? {}) as {
      metadata?: { duration?: number };
      results?: {
        channels?: { detected_language?: string; alternatives?: DeepgramAlternative[] }[];
      };
    };
    const channel = j.results?.channels?.[0];
    const alt = channel?.alternatives?.[0];

    const usage: TranscriptionUsage = {};
    if (j.metadata?.duration !== undefined) usage.seconds = j.metadata.duration;

    const result: TranscriptionParseResult = { text: alt?.transcript ?? '', usage };
    if (channel?.detected_language !== undefined) result.language = channel.detected_language;
    if (j.metadata?.duration !== undefined) result.durationSeconds = j.metadata.duration;

    if (alt?.words) {
      result.words = alt.words.map((w) => {
        // `punctuated_word` only exists with smart_format; fall back to the raw token.
        const word: TranscriptionWord = {
          word: w.punctuated_word ?? w.word ?? '',
          start: w.start ?? 0,
          end: w.end ?? 0,
        };
        if (w.confidence !== undefined) word.confidence = w.confidence;
        return word;
      });
    }

    // Deepgram has no "segments"; the closest canonical unit is the sentence
    // inside a smart_format paragraph.
    const paragraphs = alt?.paragraphs?.paragraphs;
    if (paragraphs) {
      const segments: TranscriptionSegment[] = [];
      for (const paragraph of paragraphs) {
        for (const sentence of paragraph.sentences ?? []) {
          segments.push({
            start: sentence.start ?? 0,
            end: sentence.end ?? 0,
            text: sentence.text ?? '',
          });
        }
      }
      result.segments = segments;
    }

    return result;
  },
  mapError(status, body, headers): DeuzError {
    // Deepgram envelope: `{ err_code, err_msg, request_id }` — normalize it onto
    // the OpenAI-shaped `{ error: { message, code } }` the media mapper reads.
    const j = (body ?? {}) as { err_code?: string; err_msg?: string; message?: string };
    const message = j.err_msg ?? j.message;
    const normalized =
      message !== undefined ? { error: { message, code: j.err_code } } : (body as unknown);
    return mapMediaError(
      'deepgram',
      status,
      normalized,
      headers,
      `Deepgram transcription request failed (HTTP ${status}).`,
    );
  },
};

/** Map a transcription surface to its adapter. */
export function getTranscriptionAdapter(surface: string): TranscriptionAdapter {
  switch (surface) {
    case 'openai-transcription':
      return openaiTranscription;
    case 'deepgram-transcription':
      return deepgramTranscription;
    default:
      throw new InvalidRequestError({ message: `Unknown transcription surface '${surface}'.` });
  }
}
