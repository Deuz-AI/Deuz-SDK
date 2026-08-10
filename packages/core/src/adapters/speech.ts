/**
 * adapters/speech.ts — the text-to-speech wire seam (2.0).
 *
 * TTS providers agree on almost nothing: OpenAI POSTs a JSON body to one fixed
 * path with `Authorization: Bearer`, while ElevenLabs puts the voice in the
 * PATH, the audio format in the QUERY, authenticates with `xi-api-key`, and
 * wraps its errors in a `detail` envelope instead of OpenAI's `error`. The only
 * thing they share is the shape of the answer: raw audio bytes.
 *
 * So `speech.ts` owns the parts that are the same for every wire — key/baseURL
 * resolution (G1), observation, the fetch, the bytes — and delegates the three
 * things that differ to a `SpeechAdapter`, exactly the way `adapters/embeddings.ts`
 * splits the embedding wires. Adapters here are PURE: they build a request and
 * map an error; they never touch the network, the clock, or randomness.
 */
import type { AdapterRequest } from './types';
import type { SpeechAudioFormat } from '../speech';
import { InvalidRequestError, UnsupportedCapabilityError, type DeuzError } from '../errors';
import { mapMediaError } from '../internal/media-http';

/**
 * Resolved speech call — the TTS analogue of `EmbeddingCall`, produced by
 * `resolveSpeechCall` in `speech.ts` once the G1 precedence chain has run.
 */
export interface SpeechCall {
  provider: string;
  modelId: string;
  apiKey: string;
  /** Provider root URL (no trailing slash). */
  baseURL: string;
  headers: Record<string, string>;
}

export interface SpeechBuildContext {
  call: SpeechCall;
  /** The text to speak. */
  text: string;
  /** Provider voice id/name. Optional on OpenAI (defaulted), REQUIRED on ElevenLabs. */
  voice?: string;
  /** Already defaulted by `generateSpeech` — adapters never see `undefined`. */
  format: SpeechAudioFormat;
  speed?: number;
  instructions?: string;
  /** Raw wire escape hatch, shallow-merged into the request body. */
  providerOptions?: Record<string, unknown>;
}

/**
 * The seam every TTS wire implements. `fallbackMediaType` exists because a
 * response's `content-type` is the authority on what the bytes ARE — this is
 * only consulted when the provider omits the header.
 */
export interface SpeechAdapter {
  buildRequest(ctx: SpeechBuildContext): AdapterRequest;
  fallbackMediaType(format: SpeechAudioFormat): string;
  mapError(status: number, body: unknown, headers: Headers): DeuzError;
}

/** Canonical format → IANA media type, used only when the response omits one. */
const AUDIO_MEDIA_TYPES: Record<SpeechAudioFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

// ===================================================================
// OpenAI speech — POST {baseURL}/audio/speech, Bearer auth
// ===================================================================

/** OpenAI rejects a request with no `voice`, so the canonical default is theirs. */
const DEFAULT_OPENAI_VOICE = 'alloy';

export const openaiSpeech: SpeechAdapter = {
  buildRequest({
    call,
    text,
    voice,
    format,
    speed,
    instructions,
    providerOptions,
  }): AdapterRequest {
    // providerOptions is merged FIRST and every canonical field overwrites it:
    // the escape hatch may ADD wire fields the SDK does not model, but must not
    // silently redefine the ones the caller set through the typed options.
    const body: Record<string, unknown> = { ...providerOptions };
    body.model = call.modelId;
    body.input = text;
    body.voice = voice ?? DEFAULT_OPENAI_VOICE;
    body.response_format = format;
    if (speed !== undefined) body.speed = speed;
    if (instructions !== undefined) body.instructions = instructions;

    return {
      url: `${call.baseURL}/audio/speech`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${call.apiKey}`,
          ...call.headers,
        },
        body: JSON.stringify(body),
      },
    };
  },
  fallbackMediaType: (format) => AUDIO_MEDIA_TYPES[format],
  mapError: (status, body, headers) => mapMediaError('openai', status, body, headers),
};

// ===================================================================
// ElevenLabs — POST {baseURL}/text-to-speech/{voice}?output_format=…
// header `xi-api-key` (NOT Bearer); `detail` error envelope.
// ===================================================================

/**
 * Canonical format → ElevenLabs `output_format` codec string. ElevenLabs names
 * the container, sample rate, and bitrate in one token, so the mapping picks the
 * sensible default tier for each codec. `aac`/`flac`/`wav` have NO ElevenLabs
 * equivalent and are absent on purpose — see the `UnsupportedCapabilityError`
 * below. Callers who need another tier (`mp3_22050_32`, `ulaw_8000`, …) pass it
 * verbatim via `providerOptions.output_format`.
 */
const ELEVENLABS_OUTPUT_FORMATS: Partial<Record<SpeechAudioFormat, string>> = {
  mp3: 'mp3_44100_128',
  opus: 'opus_48000_128',
  pcm: 'pcm_44100',
};

export const elevenLabsSpeech: SpeechAdapter = {
  buildRequest({ call, text, voice, format, providerOptions }): AdapterRequest {
    // The voice is part of the PATH here, so there is nothing to default to —
    // fail before the fetch rather than let ElevenLabs 404 on `/undefined`.
    if (!voice) {
      throw new InvalidRequestError({
        message:
          "ElevenLabs requires a voice: pass generateSpeech({ voice: '<voice id>' }). Voice ids come from the ElevenLabs voice library or GET /v1/voices.",
        provider: call.provider,
      });
    }

    // `output_format` is a QUERY parameter on this wire, so it is consumed here
    // and deliberately NOT echoed into the body.
    const { output_format: formatOverride, ...restOptions } = providerOptions ?? {};
    let outputFormat: string;
    if (typeof formatOverride === 'string') {
      outputFormat = formatOverride;
    } else {
      const mapped = ELEVENLABS_OUTPUT_FORMATS[format];
      if (!mapped) {
        throw new UnsupportedCapabilityError({
          provider: call.provider,
          capability: `speech format '${format}'`,
          modelId: call.modelId,
          message: `ElevenLabs cannot return '${format}' audio — use 'mp3', 'opus', or 'pcm', or pass an exact ElevenLabs codec string via providerOptions.output_format.`,
        });
      }
      outputFormat = mapped;
    }

    // `speed`/`instructions` are OpenAI-shaped controls with no top-level
    // ElevenLabs equivalent; the wire exposes them under `voice_settings`, which
    // callers reach through providerOptions. Ignored here rather than guessed.
    const body: Record<string, unknown> = { text, model_id: call.modelId, ...restOptions };

    return {
      url: `${call.baseURL}/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(outputFormat)}`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'xi-api-key': call.apiKey,
          ...call.headers,
        },
        body: JSON.stringify(body),
      },
    };
  },
  fallbackMediaType: (format) => AUDIO_MEDIA_TYPES[format],
  mapError(status, body, headers): DeuzError {
    // ElevenLabs envelope: { detail: { status, message } } — or a bare
    // { detail: 'message' } on validation failures. Neither has OpenAI's
    // `error` key, so pull the message out and hand it to the shared mapper as
    // the fallback; the status→class table stays identical to every other wire.
    const envelope = (body ?? {}) as { detail?: { status?: string; message?: string } | string };
    const detail = envelope.detail;
    const message =
      typeof detail === 'string'
        ? detail
        : typeof detail === 'object' && detail !== null
          ? detail.message
          : undefined;
    return mapMediaError(
      'elevenlabs',
      status,
      body,
      headers,
      message ?? `ElevenLabs speech request failed (HTTP ${status}).`,
    );
  },
};

/** Map a speech surface to its adapter. */
export function getSpeechAdapter(surface: string): SpeechAdapter {
  switch (surface) {
    case 'openai-speech':
      return openaiSpeech;
    case 'elevenlabs-speech':
      return elevenLabsSpeech;
    default:
      throw new InvalidRequestError({ message: `Unknown speech surface '${surface}'.` });
  }
}
