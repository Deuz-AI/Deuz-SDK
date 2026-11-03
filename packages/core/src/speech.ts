/**
 * speech.ts — text-to-speech (2.0).
 *
 * `generateSpeech` is the audio sibling of `generateImage`: one request, one
 * answer, no streaming and no canonical delta stream — a TTS endpoint returns
 * a finished audio file, not a token sequence. Two wires ship: OpenAI's
 * `POST /audio/speech` and ElevenLabs' `POST /text-to-speech/{voice}`; both sit
 * behind the `SpeechAdapter` seam in `adapters/speech.ts`.
 *
 * PURE + edge-safe: HTTP goes through the injected `deps.fetch` and the API key
 * through `deps.keyProvider` / factory config / `ClientConfig.apiKeys` (the G1
 * precedence chain) — never read from the environment, never hardcoded.
 *
 * Audio does NOT enter the `Part` union. A speech model is its own kind, the way
 * `ImageModel` is, and audio you want a CHAT model to hear travels as
 * `filePart({ mediaType: 'audio/…' })` — the 5-member `Part` union is unchanged.
 */
import type { LanguageModel } from './types/model';
import type { Dependencies, ResolvedDependencies } from './types/deps';
import { attachConfig, readConfig } from './internal/config-symbol';
import { readClientContext, type ClientContext } from './internal/client-context';
import { resolveDependencies } from './internal/resolve-deps';
import { observeOperation } from './internal/observe-runtime';
import { readErrorBody } from './internal/media-http';
import { getSpeechAdapter } from './adapters/speech';
import { AuthenticationError, APICallError, UnsupportedCapabilityError } from './errors';

/** Which TTS wire a descriptor speaks — the key `getSpeechAdapter` switches on. */
export type SpeechModelSurface = 'openai-speech' | 'elevenlabs-speech' | 'giggy-speech';

/** A speech model descriptor — a separate kind from chat `LanguageModel`. */
export interface SpeechModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: SpeechModelSurface;
}

export type SpeechProvider = (modelId: string) => SpeechModel;

export interface SpeechProviderSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Logical provider id used for key/baseURL resolution. */
  provider?: string;
}

/** The audio containers `generateSpeech` speaks in canonical terms. */
export type SpeechAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface GenerateSpeechOptions {
  model: SpeechModel;
  /** The text to speak. Its length is reported as `usage.characters`. */
  text: string;
  /**
   * Provider voice id/name. OpenAI defaults to `'alloy'`; ElevenLabs has no
   * default (the voice is part of its URL) and rejects the call without one.
   */
  voice?: string;
  /** Audio container. Default `'mp3'`. */
  format?: SpeechAudioFormat;
  /** Playback rate, where supported (OpenAI: 0.25–4.0). */
  speed?: number;
  /** Delivery/tone steering, where supported (OpenAI `gpt-4o-mini-tts`). */
  instructions?: string;
  /**
   * Raw wire escape hatch, shallow-merged into the request body. Canonical
   * fields always win on OpenAI; on ElevenLabs `output_format` is lifted into
   * the query string verbatim, bypassing the canonical `format` mapping.
   */
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  deps?: Dependencies;
}

export interface GenerateSpeechResult {
  /** The generated audio bytes. */
  audio: Uint8Array;
  /** From the response `content-type`, else the adapter's per-format default. */
  mediaType: string;
  /** The format that was requested (echoed so callers can pick a file extension). */
  format: SpeechAudioFormat;
  /**
   * TTS providers bill by characters, not tokens, and none of them report the
   * count back — so this is the input length, which is what they meter.
   */
  usage: { characters: number };
}

/** Options for native audio streaming. Currently supported by Giggy.ai only. */
export type StreamSpeechOptions = Omit<GenerateSpeechOptions, 'format'>;

/** Progressive speech result; `audio` yields PCM16LE mono chunks at 24 kHz. */
export interface StreamSpeechResult {
  audio: ReadableStream<Uint8Array>;
  mediaType: 'audio/pcm';
  format: 'pcm';
  usage: { characters: number };
}

/** Wire defaults, applied only when neither the factory nor `createClient` set one. */
const DEFAULT_BASE_URLS: Record<SpeechModelSurface, string> = {
  'openai-speech': 'https://api.openai.com/v1',
  'elevenlabs-speech': 'https://api.elevenlabs.io/v1',
  'giggy-speech': 'https://api.giggy.ai/v1',
};

const DEFAULT_FORMAT: SpeechAudioFormat = 'mp3';

/**
 * Build a speech provider factory. The descriptor carries the factory settings
 * on a private symbol (same trick as the chat providers) so the public
 * `SpeechModel` shape stays clean and the key never leaks via enumeration.
 */
function createSpeechProvider(
  surface: SpeechModelSurface,
  defaultProvider: string,
  settings: SpeechProviderSettings,
): SpeechProvider {
  const provider = settings.provider ?? defaultProvider;
  return (modelId: string): SpeechModel =>
    attachConfig({ provider, modelId, surface } as unknown as LanguageModel, {
      provider,
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      fetch: settings.fetch,
      headers: settings.headers,
    }) as unknown as SpeechModel;
}

/**
 * OpenAI text-to-speech (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`) — and any
 * OpenAI-compatible relay, by pointing `baseURL` at it.
 */
export function createOpenAISpeech(settings: SpeechProviderSettings = {}): SpeechProvider {
  return createSpeechProvider('openai-speech', 'openai', settings);
}

/**
 * ElevenLabs text-to-speech (`eleven_multilingual_v2`, `eleven_turbo_v2_5`, …).
 * Every call needs a `voice` — see `GenerateSpeechOptions.voice`.
 */
export function createElevenLabs(settings: SpeechProviderSettings = {}): SpeechProvider {
  return createSpeechProvider('elevenlabs-speech', 'elevenlabs', settings);
}

/** Giggy.ai text-to-speech. Pass the voice UUID with `voice`; Giggy requests always use progressive PCM streaming. */
export function createGiggy(settings: SpeechProviderSettings = {}): SpeechProvider {
  return createSpeechProvider('giggy-speech', 'giggy', settings);
}

/**
 * G1: `deps.keyProvider` (highest) → factory config (Symbol) → `createClient`'s
 * `apiKeys`/`baseUrls` (lowest) → else `AuthenticationError`. Factory `fetch`
 * wins over `deps.fetch`. Identical to `resolveImageCall` by design — the media
 * modules must not each invent their own precedence.
 */
async function resolveSpeechCall(
  model: SpeechModel,
  deps: ResolvedDependencies,
  headers: Record<string, string> | undefined,
  clientContext: ClientContext | undefined,
): Promise<{
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
}> {
  const config = readConfig(model as never);

  let apiKey: string | undefined;
  if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(model.provider)) ?? undefined;
  if (!apiKey) apiKey = config?.apiKey;
  if (!apiKey) apiKey = clientContext?.apiKeys?.[model.provider];
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for speech provider '${model.provider}'. Pass it to the factory, ClientConfig.apiKeys, or a deps.keyProvider.`,
      provider: model.provider,
    });
  }

  const baseURLRaw =
    config?.baseURL ??
    clientContext?.baseUrls?.[model.provider] ??
    DEFAULT_BASE_URLS[model.surface];

  return {
    apiKey,
    baseURL: baseURLRaw.replace(/\/+$/, ''),
    headers: { ...config?.headers, ...headers },
    fetch: config?.fetch ?? deps.fetch,
  };
}

/** Synthesize speech from text. Returns the finished audio bytes — no streaming. */
export async function generateSpeech(
  options: GenerateSpeechOptions,
): Promise<GenerateSpeechResult> {
  const deps = resolveDependencies(options.deps);
  // Observation (1.6): operation.* events (no run — media calls are aux ops).
  // itemCount = input characters, resultCount = audio bytes: the two numbers a
  // TTS call is actually judged by.
  return observeOperation(
    deps,
    'speech',
    'speech.generate',
    { itemCount: options.text.length, resultCount: (r) => r.audio.byteLength },
    () => generateSpeechCore(options, deps),
  );
}

/**
 * Stream native speech audio from a provider that supports incremental output.
 * Giggy.ai is the only native TTS streaming wire currently supported. Its
 * endpoint progressively returns raw PCM; no full-audio buffer is assembled.
 */
export async function streamSpeech(options: StreamSpeechOptions): Promise<StreamSpeechResult> {
  if (options.model.surface !== 'giggy-speech') {
    throw new UnsupportedCapabilityError({
      provider: options.model.provider,
      modelId: options.model.modelId,
      capability: 'native speech streaming',
      message: `Speech streaming is not supported by '${options.model.provider}'.`,
    });
  }

  const adapter = getSpeechAdapter(options.model.surface);
  if (!adapter.buildStreamRequest) {
    throw new UnsupportedCapabilityError({
      provider: options.model.provider,
      modelId: options.model.modelId,
      capability: 'native speech streaming',
    });
  }
  const deps = resolveDependencies(options.deps);
  const clientContext = readClientContext(options);
  const {
    apiKey,
    baseURL,
    headers,
    fetch: fetchImpl,
  } = await resolveSpeechCall(options.model, deps, options.headers, clientContext);
  const { url, init } = adapter.buildStreamRequest({
    call: {
      provider: options.model.provider,
      modelId: options.model.modelId,
      apiKey,
      baseURL,
      headers,
    },
    text: options.text,
    voice: options.voice,
    format: 'pcm',
    speed: options.speed,
    instructions: options.instructions,
    providerOptions: options.providerOptions,
  });
  const response = await fetchImpl(url, { ...init, signal: options.signal });
  if (!response.ok) {
    throw adapter.mapError(response.status, await readErrorBody(response), response.headers);
  }
  if (!response.body) {
    throw new APICallError({
      message: 'Giggy.ai speech response did not include an audio stream.',
      provider: options.model.provider,
      statusCode: response.status,
      isRetryable: false,
    });
  }
  return {
    audio: response.body,
    mediaType: 'audio/pcm',
    format: 'pcm',
    usage: { characters: options.text.length },
  };
}

async function generateSpeechCore(
  options: GenerateSpeechOptions,
  deps: ResolvedDependencies,
): Promise<GenerateSpeechResult> {
  if (options.model.surface === 'giggy-speech') {
    // `generateSpeech` remains a buffered compatibility API, but Giggy itself
    // is always called through its native progressive PCM endpoint.
    const streamed = await streamSpeech({ ...options, deps });
    const reader = streamed.audio.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        byteLength += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const audio = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      audio,
      mediaType: streamed.mediaType,
      format: 'pcm',
      usage: streamed.usage,
    };
  }

  const adapter = getSpeechAdapter(options.model.surface);
  const clientContext = readClientContext(options);
  const {
    apiKey,
    baseURL,
    headers,
    fetch: fetchImpl,
  } = await resolveSpeechCall(options.model, deps, options.headers, clientContext);

  const format = options.format ?? DEFAULT_FORMAT;
  const { url, init } = adapter.buildRequest({
    call: {
      provider: options.model.provider,
      modelId: options.model.modelId,
      apiKey,
      baseURL,
      headers,
    },
    text: options.text,
    voice: options.voice,
    format,
    speed: options.speed,
    instructions: options.instructions,
    providerOptions: options.providerOptions,
  });

  const response = await fetchImpl(url, { ...init, signal: options.signal });

  if (!response.ok) {
    throw adapter.mapError(response.status, await readErrorBody(response), response.headers);
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  // The response header is the authority on what the bytes are; parameters
  // (`; charset=…`) are dropped so the value is directly comparable.
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  const mediaType = contentType ? contentType : adapter.fallbackMediaType(format);

  return { audio, mediaType, format, usage: { characters: options.text.length } };
}
