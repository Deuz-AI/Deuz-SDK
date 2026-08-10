/**
 * transcription.ts — speech-to-text (2.0).
 *
 * `transcribe()` is the STT twin of `generateImage`: one request, one response,
 * no streaming, no loop. It resolves the key through the G1 chain
 * (`deps.keyProvider` → factory config → `ClientConfig.apiKeys`), sends the
 * audio through the injected `deps.fetch`, and wraps the whole call in
 * `operation.*` observation events under the `'transcription'` subsystem.
 *
 * Two wires ship (`src/adapters/transcription.ts`): OpenAI's multipart
 * `/audio/transcriptions` and Deepgram's raw-body `/listen`. They differ enough
 * that the differences are worth knowing before you pick — see the module docs.
 *
 * PURE + edge-safe: no clock, no randomness, no environment reads.
 */
import type { LanguageModel } from './types/model';
import type { Dependencies, ResolvedDependencies } from './types/deps';
import type {
  TranscriptionAudio,
  TranscriptionSegment,
  TranscriptionUsage,
  TranscriptionWord,
} from './adapters/transcription';
import { getTranscriptionAdapter } from './adapters/transcription';
import { attachConfig, readConfig } from './internal/config-symbol';
import { readClientContext, type ClientContext } from './internal/client-context';
import { resolveDependencies } from './internal/resolve-deps';
import { observeOperation } from './internal/observe-runtime';
import { readErrorBody } from './internal/media-http';
import { AuthenticationError, InvalidRequestError } from './errors';

export type {
  TranscriptionSegment,
  TranscriptionUsage,
  TranscriptionWord,
} from './adapters/transcription';

/** The wires `transcribe()` knows how to drive. */
export type TranscriptionSurface = 'openai-transcription' | 'deepgram-transcription';

/** A transcription model descriptor — its own kind, like `ImageModel`. */
export interface TranscriptionModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: TranscriptionSurface;
}

export type TranscriptionProvider = (modelId: string) => TranscriptionModel;

export interface TranscriptionProviderSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Logical provider id used for key/baseURL resolution. Defaults per factory. */
  provider?: string;
}

const DEFAULT_BASE_URLS: Record<TranscriptionSurface, string> = {
  'openai-transcription': 'https://api.openai.com/v1',
  'deepgram-transcription': 'https://api.deepgram.com/v1',
};

function createTranscriptionProvider(
  surface: TranscriptionSurface,
  defaultProvider: string,
  settings: TranscriptionProviderSettings,
): TranscriptionProvider {
  const provider = settings.provider ?? defaultProvider;
  return (modelId: string): TranscriptionModel =>
    attachConfig({ provider, modelId, surface } as unknown as LanguageModel, {
      provider,
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      fetch: settings.fetch,
      headers: settings.headers,
    }) as unknown as TranscriptionModel;
}

/**
 * OpenAI transcription factory — `whisper-1`, `gpt-4o-transcribe`,
 * `gpt-4o-mini-transcribe`. Default base URL `https://api.openai.com/v1`; point
 * `baseURL` at any relay that mirrors `/audio/transcriptions`.
 */
export function createOpenAITranscription(
  settings: TranscriptionProviderSettings = {},
): TranscriptionProvider {
  return createTranscriptionProvider('openai-transcription', 'openai', settings);
}

/**
 * Deepgram factory — `nova-3`, `nova-2`, `whisper-large`, …. Default base URL
 * `https://api.deepgram.com/v1`. Deepgram authenticates with its own
 * `Authorization: Token <key>` scheme, not Bearer; the adapter handles that.
 */
export function createDeepgram(
  settings: TranscriptionProviderSettings = {},
): TranscriptionProvider {
  return createTranscriptionProvider('deepgram-transcription', 'deepgram', settings);
}

/** Accepted audio inputs. `{ url }` is Deepgram-only — OpenAI rejects it. */
export type TranscriptionInput = Uint8Array | ArrayBuffer | Blob | { url: string };

export interface TranscribeOptions {
  model: TranscriptionModel;
  /**
   * The audio. Bytes are uploaded; `{ url: '…' }` hands the URL to the provider
   * to fetch server-side and is supported by Deepgram ONLY.
   */
  audio: TranscriptionInput;
  /**
   * IANA media type of the audio, e.g. `'audio/mpeg'`. Strongly recommended:
   * OpenAI dispatches on the multipart FILENAME extension, which is derived
   * from this, and Deepgram receives it as the request `Content-Type`.
   * Defaulted from a `Blob`'s own `type` when one is given.
   */
  mediaType?: string;
  /** Override the derived multipart filename (OpenAI only). */
  filename?: string;
  /** ISO-639-1 language hint, e.g. `'tr'`. Omit to let the provider detect. */
  language?: string;
  /** Vocabulary/style hint prepended to the decode (OpenAI only). */
  prompt?: string;
  /**
   * Ask for `segments` + `words`. On Deepgram word timings come back regardless.
   * On OpenAI this needs the `verbose_json` response format, which only
   * `whisper-*` models accept — see `TranscribeResult.segments`.
   */
  timestamps?: boolean;
  /**
   * Per-provider escape hatch, keyed by provider name — extra multipart fields
   * (`openai`) or query params (`deepgram`). Canonical fields always win.
   */
  providerOptions?: {
    openai?: Record<string, unknown>;
    deepgram?: Record<string, unknown>;
  } & Record<string, Record<string, unknown>>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  deps?: Dependencies;
}

export interface TranscribeResult {
  text: string;
  /** Detected (or echoed) language, when the provider reports one. */
  language?: string;
  /** Audio length in seconds, when the provider reports one. */
  durationSeconds?: number;
  /** Sentence/utterance timings — present only when the wire produced them. */
  segments?: TranscriptionSegment[];
  /** Word timings — present only when the wire produced them. */
  words?: TranscriptionWord[];
  /** Normalized billing signal (seconds OR tokens, depending on the provider). */
  usage: TranscriptionUsage;
  /** The raw provider response (for provider-specific extras). */
  raw: unknown;
}

async function resolveTranscriptionCall(
  model: TranscriptionModel,
  deps: ResolvedDependencies,
  headers: Record<string, string> | undefined,
  clientContext: ClientContext | undefined,
): Promise<{
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
}> {
  const config = readConfig(model as never) as
    | { apiKey?: string; baseURL?: string; fetch?: typeof fetch; headers?: Record<string, string> }
    | undefined;

  // G1 precedence: keyProvider → factory config → ClientConfig.apiKeys → throw.
  let apiKey: string | undefined;
  if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(model.provider)) ?? undefined;
  if (!apiKey) apiKey = config?.apiKey;
  if (!apiKey) apiKey = clientContext?.apiKeys?.[model.provider];
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for transcription provider '${model.provider}'. Pass it to the factory, ClientConfig.apiKeys, or a deps.keyProvider.`,
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

/**
 * Re-view a `Uint8Array` over a plain `ArrayBuffer`, which is what `BodyInit`
 * and `BlobPart` demand (TS 5.7 made the typed arrays generic over their backing
 * buffer, and `SharedArrayBuffer` is the one member `fetch` will not take). The
 * common path is a zero-copy re-view; only a genuinely shared buffer — which the
 * platform would reject anyway — pays for a copy.
 */
function toPlainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer, byteOffset, byteLength);
  const copy = new Uint8Array(byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Normalize the four accepted input shapes into the single `TranscriptionAudio`
 * the adapters read. A `Blob` is forwarded verbatim (no copy); an `ArrayBuffer`
 * is viewed, not cloned.
 */
function normalizeAudio(audio: TranscriptionInput): TranscriptionAudio {
  if (audio instanceof Uint8Array) return { bytes: toPlainBytes(audio) };
  if (audio instanceof ArrayBuffer) return { bytes: new Uint8Array(audio) };
  if (typeof Blob !== 'undefined' && audio instanceof Blob) return { blob: audio };
  const url = (audio as { url?: unknown } | null)?.url;
  if (typeof url === 'string') return { url };
  throw new InvalidRequestError({
    message:
      'transcribe: `audio` must be a Uint8Array, ArrayBuffer, Blob, or { url } (Deepgram only).',
  });
}

/** Transcribe one audio input to text (+ optional timings) via OpenAI or Deepgram. */
export async function transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
  const deps = resolveDependencies(options.deps);
  // Observation (1.6): operation.* events (no run — media calls are aux ops).
  return observeOperation(
    deps,
    'transcription',
    'transcription.transcribe',
    { itemCount: 1, resultCount: () => 1 },
    () => transcribeCore(options, deps),
  );
}

async function transcribeCore(
  options: TranscribeOptions,
  deps: ResolvedDependencies,
): Promise<TranscribeResult> {
  const clientContext = readClientContext(options);
  const {
    apiKey,
    baseURL,
    headers,
    fetch: fetchImpl,
  } = await resolveTranscriptionCall(options.model, deps, options.headers, clientContext);

  const adapter = getTranscriptionAdapter(options.model.surface);
  const audio = normalizeAudio(options.audio);
  const { url, init } = adapter.buildRequest({
    call: {
      provider: options.model.provider,
      modelId: options.model.modelId,
      apiKey,
      baseURL,
      headers,
    },
    audio,
    ...(options.mediaType !== undefined ? { mediaType: options.mediaType } : {}),
    ...(options.filename !== undefined ? { filename: options.filename } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.timestamps !== undefined ? { timestamps: options.timestamps } : {}),
    ...(options.providerOptions !== undefined ? { providerOptions: options.providerOptions } : {}),
  });

  const response = await fetchImpl(url, { ...init, signal: options.signal });
  if (!response.ok) {
    throw adapter.mapError(response.status, await readErrorBody(response), response.headers);
  }

  const json: unknown = await response.json();
  const parsed = adapter.parseResponse(json);
  return {
    text: parsed.text,
    ...(parsed.language !== undefined ? { language: parsed.language } : {}),
    ...(parsed.durationSeconds !== undefined ? { durationSeconds: parsed.durationSeconds } : {}),
    ...(parsed.segments !== undefined ? { segments: parsed.segments } : {}),
    ...(parsed.words !== undefined ? { words: parsed.words } : {}),
    usage: parsed.usage,
    raw: json,
  };
}
