/**
 * transcription.ts — speech-to-text (2.0).
 *
 * `transcribe()` is the STT twin of `generateImage`: one request, one response,
 * no streaming, no loop. It resolves the key through the G1 chain
 * (`deps.keyProvider` → factory config → `ClientConfig.apiKeys`), sends the
 * audio through the injected `deps.fetch`, and wraps the whole call in
 * `operation.*` observation events under the `'transcription'` subsystem.
 *
 * OpenAI's multipart `/audio/transcriptions` and Deepgram's raw-body `/listen`
 * use `src/adapters/transcription.ts`. Giggy's uploaded-recording SSE wire is
 * handled here because it streams cumulative transcript revisions.
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
import {
  AuthenticationError,
  APICallError,
  InvalidRequestError,
  UnsupportedCapabilityError,
} from './errors';
import { parseSSE } from './internal/sse';
import { mapMediaError } from './internal/media-http';
import { defaultWebSocketFactory } from './realtime/websocket';
import type { RealtimeWebSocket, RealtimeWebSocketFactory } from './realtime/types';

export type {
  TranscriptionSegment,
  TranscriptionUsage,
  TranscriptionWord,
} from './adapters/transcription';

/** The wires `transcribe()` knows how to drive. */
export type TranscriptionSurface =
  | 'openai-transcription'
  | 'deepgram-transcription'
  | 'giggy-transcription';

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
  'giggy-transcription': 'https://api.giggy.ai/v1',
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

/** Giggy.ai uploaded-recording transcription. Streaming uses WAV PCM16 mono at 16 kHz. */
export function createGiggyTranscription(
  settings: TranscriptionProviderSettings = {},
): TranscriptionProvider {
  return createTranscriptionProvider('giggy-transcription', 'giggy', settings);
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

/** One decoded event from Giggy's uploaded-recording SSE stream. */
export interface GiggyTranscriptionEvent {
  /** Provider SSE event name; e.g. generation_created, transcript_chunk, generation_updated. */
  type: string;
  /** Parsed JSON event payload, or the original string when it was not JSON. */
  data: unknown;
  /** `transcript_chunk` carries cumulative, revisable text; replace the prior draft. */
  text?: string;
  replace?: true;
  /** Marks the provider's terminal result/status event. */
  terminal?: true;
}

/** Options for Giggy's uploaded-recording streaming transcription API. */
export interface StreamTranscriptionOptions extends Omit<TranscribeOptions, 'providerOptions'> {
  /** Additional Giggy query fields (for example `client_request_id` or privacy flags). */
  providerOptions?: { giggy?: Record<string, unknown> };
}

/** Events from Giggy's live microphone WebSocket session. */
export type GiggyLiveTranscriptionEvent =
  | { type: 'session-ready'; generationUuid: string; attempt: number }
  | {
      type: 'transcript';
      text: string;
      replace: true;
      isFinal?: boolean;
      sequence?: number;
      source: 'websocket' | 'canonical-result';
      generationUuid: string;
      attempt: number;
      raw: unknown;
    }
  | { type: 'input-complete'; generationUuid: string; attempt: number; raw: unknown }
  | { type: 'generation-updated'; generationUuid: string; status: string; raw: unknown }
  | { type: 'error'; message: string; raw: unknown }
  | { type: 'session-closed'; code: number; reason: string };

/** A live microphone session using Giggy's binary PCM WebSocket protocol. */
export interface GiggyLiveTranscriptionSession {
  readonly status: 'idle' | 'connecting' | 'ready' | 'stopping' | 'completed' | 'closed' | 'failed';
  readonly transcript: string;
  readonly generationUuid: string | undefined;
  connect(): Promise<void>;
  /** Send one headerless PCM16LE mono frame at the session's configured rate. */
  sendAudio(frame: ArrayBuffer | ArrayBufferView): void;
  /** Send `stop` and resolve after authoritative completion and final transcript validation. */
  stop(): Promise<void>;
  close(): Promise<void>;
  events(): AsyncIterableIterator<GiggyLiveTranscriptionEvent>;
}

/** Options for Giggy's native live-microphone WebSocket STT session. */
export interface CreateGiggyLiveTranscriptionSessionOptions {
  model: TranscriptionModel;
  language?: string;
  sampleRateHz?: 8000 | 16000;
  /** Endpointing defaults to manual so caller-controlled `stop()` ends the turn. */
  endpointing?: 'external' | 'server';
  /** Readiness timeout in milliseconds. Defaults to 15 seconds. */
  connectTimeoutMs?: number;
  /** Final transcript/input_complete timeout after `stop()`. Defaults to 15 seconds. */
  stopTimeoutMs?: number;
  signal?: AbortSignal;
  deps?: Dependencies & { webSocket?: RealtimeWebSocketFactory };
}

function boundedSessionTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 100
    ? Math.min(value, 120_000)
    : fallback;
}

/**
 * Stream transcript revisions for one completed WAV recording through Giggy's
 * native HTTPS/SSE uploaded-recording endpoint. This is not live microphone
 * transcription; live input uses Giggy's WebSocket protocol.
 */
export async function streamTranscription(
  options: StreamTranscriptionOptions,
): Promise<ReadableStream<GiggyTranscriptionEvent>> {
  if (options.model.surface !== 'giggy-transcription') {
    throw new UnsupportedCapabilityError({
      provider: options.model.provider,
      capability: 'uploaded-recording transcription streaming',
      message: `Streaming transcription is not supported by '${options.model.provider}'.`,
    });
  }
  const audio = normalizeAudio(options.audio);
  if (audio.url) {
    throw new InvalidRequestError({
      message: 'Giggy streaming transcription requires an uploaded WAV recording, not a URL.',
      provider: options.model.provider,
    });
  }
  const mediaType = (options.mediaType ?? audio.blob?.type ?? 'audio/wav')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave'].includes(mediaType)) {
    throw new InvalidRequestError({
      message: 'Giggy streaming transcription requires WAV audio (PCM16 mono, 16 kHz).',
      provider: options.model.provider,
    });
  }

  const deps = resolveDependencies(options.deps);
  const clientContext = readClientContext(options);
  const {
    apiKey,
    baseURL,
    headers,
    fetch: fetchImpl,
  } = await resolveTranscriptionCall(options.model, deps, options.headers, clientContext);
  const url = new URL(`${baseURL}/audio/transcriptions`);
  for (const [key, value] of Object.entries(options.providerOptions?.giggy ?? {})) {
    if (key !== 'mode' && value !== undefined && value !== null)
      url.searchParams.set(key, String(value));
  }
  url.searchParams.set('mode', 'streaming');
  if (options.language) url.searchParams.set('language', options.language);

  const body: BodyInit = audio.blob ?? toPlainBytes(audio.bytes!);
  const streamAbort = new AbortController();
  const forwardAbort = () => streamAbort.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'xi-api-key': apiKey,
        ...headers,
      },
      body,
      signal: streamAbort.signal,
      redirect: 'error',
    });
  } catch (error) {
    options.signal?.removeEventListener('abort', forwardAbort);
    throw error;
  }
  if (!response.ok) {
    options.signal?.removeEventListener('abort', forwardAbort);
    throw mapMediaError(
      options.model.provider,
      response.status,
      await readErrorBody(response),
      response.headers,
      `Giggy.ai transcription request failed (HTTP ${response.status}).`,
    );
  }
  if (!response.body) {
    options.signal?.removeEventListener('abort', forwardAbort);
    throw new APICallError({
      message: 'Giggy.ai transcription response did not include an event stream.',
      provider: options.model.provider,
      statusCode: response.status,
      isRetryable: false,
    });
  }

  const events = parseSSE(response.body, streamAbort.signal)[Symbol.asyncIterator]();
  return new ReadableStream<GiggyTranscriptionEvent>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) {
          options.signal?.removeEventListener('abort', forwardAbort);
          if (options.signal?.aborted) {
            controller.error(
              options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
            );
            return;
          }
          // Uploaded SSE chunks are previews. A clean EOF is valid; buffered
          // transcribe() verifies completion from the canonical generation GET.
          controller.close();
          return;
        }
        if (next.value.data === '[DONE]') {
          streamAbort.abort();
          options.signal?.removeEventListener('abort', forwardAbort);
          controller.error(
            new APICallError({
              message:
                'Giggy transcription sent an undocumented [DONE] sentinel instead of a terminal event.',
              provider: options.model.provider,
              statusCode: 200,
              isRetryable: false,
            }),
          );
          return;
        }
        let data: unknown = next.value.data;
        try {
          data = JSON.parse(next.value.data) as unknown;
        } catch {
          // Keep non-JSON provider events visible to the caller.
        }
        const payload = data as Record<string, unknown> | null;
        const type =
          next.value.event ??
          (typeof payload?.type === 'string' ? payload.type : undefined) ??
          (typeof payload?.event === 'string' ? payload.event : undefined) ??
          'message';
        const terminalStatus =
          type === 'generation_updated' &&
          ['completed', 'failed', 'cancelled', 'stopped', 'error'].includes(
            String(payload?.status),
          );
        const terminalEvent =
          ['error', 'completed', 'failed', 'cancelled', 'stopped', 'generation_completed'].includes(
            type,
          ) || terminalStatus;
        const event: GiggyTranscriptionEvent = {
          type,
          data,
          ...(terminalEvent ? { terminal: true as const } : {}),
        };
        const revision =
          typeof payload?.text === 'string'
            ? payload.text
            : typeof payload?.transcript === 'string'
              ? payload.transcript
              : undefined;
        if (type === 'transcript_chunk' && revision !== undefined) {
          event.text = revision;
          event.replace = true;
        }
        controller.enqueue(event);
        if (terminalEvent) {
          streamAbort.abort();
          options.signal?.removeEventListener('abort', forwardAbort);
          controller.close();
        }
      } catch (error) {
        streamAbort.abort();
        options.signal?.removeEventListener('abort', forwardAbort);
        controller.error(error);
      }
    },
    async cancel() {
      streamAbort.abort();
      options.signal?.removeEventListener('abort', forwardAbort);
      await events.return?.(undefined);
    },
  });
}

async function fetchCanonicalUploadedResult(
  options: TranscribeOptions,
  deps: ResolvedDependencies,
  generationUuid: string,
): Promise<{ text: string; language?: string; durationSeconds?: number; raw: unknown }> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      generationUuid,
    )
  ) {
    throw new APICallError({
      message: 'Giggy uploaded transcription did not include a valid generation UUID.',
      provider: options.model.provider,
      statusCode: 200,
      isRetryable: false,
    });
  }
  const clientContext = readClientContext(options);
  const {
    apiKey,
    baseURL,
    headers,
    fetch: fetchImpl,
  } = await resolveTranscriptionCall(options.model, deps, options.headers, clientContext);
  const generationResponse = await fetchImpl(
    `${baseURL}/generations/${encodeURIComponent(generationUuid)}`,
    {
      method: 'GET',
      headers: { ...headers, 'xi-api-key': apiKey },
      signal: options.signal,
      redirect: 'error',
    },
  );
  if (!generationResponse.ok) {
    throw mapMediaError(
      options.model.provider,
      generationResponse.status,
      await readErrorBody(generationResponse),
      generationResponse.headers,
      `Giggy canonical generation lookup failed with HTTP ${generationResponse.status}.`,
    );
  }
  let generationPayload: unknown;
  try {
    generationPayload = await generationResponse.json();
  } catch {
    throw new APICallError({
      message: 'Giggy returned invalid canonical generation JSON.',
      provider: options.model.provider,
      statusCode: generationResponse.status,
      isRetryable: false,
    });
  }
  const envelope = generationPayload as {
    generation_uuid?: unknown;
    uuid?: unknown;
    status?: unknown;
    result?: { url?: unknown };
    generation?: {
      generation_uuid?: unknown;
      uuid?: unknown;
      status?: unknown;
      result?: { url?: unknown };
      generation?: { generation_uuid?: unknown; uuid?: unknown; status?: unknown };
    };
  } | null;
  const generation = envelope?.generation ?? envelope;
  const nestedGeneration = generation?.generation;
  const canonicalUuid =
    generation?.generation_uuid ??
    generation?.uuid ??
    nestedGeneration?.generation_uuid ??
    nestedGeneration?.uuid;
  const canonicalStatus = generation?.status ?? nestedGeneration?.status;
  if (canonicalUuid !== generationUuid || canonicalStatus !== 'completed') {
    throw new APICallError({
      message: 'Giggy canonical generation identity or completed status did not match the upload.',
      provider: options.model.provider,
      statusCode: generationResponse.status,
      isRetryable: false,
    });
  }
  if (typeof generation?.result?.url !== 'string') {
    throw new APICallError({
      message: 'Giggy completed upload did not include a canonical result URL.',
      provider: options.model.provider,
      statusCode: generationResponse.status,
      isRetryable: false,
    });
  }
  let artifactUrl: URL;
  try {
    artifactUrl = new URL(generation.result.url);
  } catch {
    throw new APICallError({
      message: 'Giggy canonical transcript URL was invalid.',
      provider: options.model.provider,
      statusCode: generationResponse.status,
      isRetryable: false,
    });
  }
  if (artifactUrl.protocol !== 'https:' || artifactUrl.username || artifactUrl.password) {
    throw new APICallError({
      message: 'Giggy canonical transcript URL must be credential-free HTTPS.',
      provider: options.model.provider,
      statusCode: generationResponse.status,
      isRetryable: false,
    });
  }
  const artifactResponse = await fetchImpl(artifactUrl, {
    method: 'GET',
    signal: options.signal,
    redirect: 'error',
  });
  if (!artifactResponse.ok) {
    throw mapMediaError(
      options.model.provider,
      artifactResponse.status,
      await readErrorBody(artifactResponse),
      artifactResponse.headers,
      `Giggy canonical transcript download failed with HTTP ${artifactResponse.status}.`,
    );
  }
  let artifact: unknown;
  try {
    artifact = await artifactResponse.json();
  } catch {
    throw new APICallError({
      message: 'Giggy returned invalid canonical transcript JSON.',
      provider: options.model.provider,
      statusCode: artifactResponse.status,
      isRetryable: false,
    });
  }
  const transcript = artifact as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
    duration_seconds?: unknown;
  } | null;
  if (!transcript || typeof transcript.text !== 'string') {
    throw new APICallError({
      message: 'Giggy canonical transcript artifact must include text.',
      provider: options.model.provider,
      statusCode: artifactResponse.status,
      isRetryable: false,
    });
  }
  const durationSeconds =
    typeof transcript.duration === 'number'
      ? transcript.duration
      : typeof transcript.duration_seconds === 'number'
        ? transcript.duration_seconds
        : undefined;
  return {
    text: transcript.text,
    ...(typeof transcript.language === 'string' ? { language: transcript.language } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    raw: artifact,
  };
}

/**
 * Open Giggy's native live-microphone STT session. Unlike
 * `streamTranscription`, this sends binary microphone PCM over one WebSocket;
 * it does not upload a completed WAV or use SSE.
 */
export function createGiggyLiveTranscriptionSession(
  options: CreateGiggyLiveTranscriptionSessionOptions,
): GiggyLiveTranscriptionSession {
  if (options.model.surface !== 'giggy-transcription') {
    throw new UnsupportedCapabilityError({
      provider: options.model.provider,
      capability: 'live microphone transcription',
      message: `Live microphone transcription is not supported by '${options.model.provider}'.`,
    });
  }
  const sampleRateHz = options.sampleRateHz ?? 16000;
  const endpointing = options.endpointing ?? 'external';
  const connectTimeoutMs = boundedSessionTimeout(options.connectTimeoutMs, 15_000);
  const stopTimeoutMs = boundedSessionTimeout(options.stopTimeoutMs, 15_000);
  const deps = resolveDependencies(options.deps);
  const openWebSocket = options.deps?.webSocket ?? defaultWebSocketFactory;
  let status: GiggyLiveTranscriptionSession['status'] = 'idle';
  let socket: RealtimeWebSocket | undefined;
  let generationUuid: string | undefined;
  let admittedAttempt: number | undefined;
  let transcript = '';
  let lastSequence = -1;
  let created = false;
  let ready = false;
  let readyIdentity: { generationUuid?: string; attempt?: number } | undefined;
  let sawFinalTranscript = false;
  let sawInputComplete = false;
  let sawCompletedStatus = false;
  let canonicalResultStarted = false;
  let canonicalTranscript: string | undefined;
  let sentPcmBytes = 0;
  let sentFrameCount = 0;
  let resultApiKey: string | undefined;
  let resultBaseUrl: string | undefined;
  let resultHeaders: Record<string, string> = {};
  let resultFetch: typeof fetch = deps.fetch;
  let canonicalAbort: AbortController | undefined;
  let socketClose: { code: number; reason: string } | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let connectPromise: Promise<void> | undefined;
  let resolveConnect: (() => void) | undefined;
  let rejectConnect: ((error: unknown) => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let resolveStop: (() => void) | undefined;
  let rejectStop: ((error: unknown) => void) | undefined;

  const queue: GiggyLiveTranscriptionEvent[] = [];
  let ended = false;
  let waiting: ((result: IteratorResult<GiggyLiveTranscriptionEvent>) => void) | undefined;
  const eventIterator: AsyncIterableIterator<GiggyLiveTranscriptionEvent> = {
    next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return() {
      endEvents();
      queue.length = 0;
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return eventIterator;
    },
  };
  function emit(event: GiggyLiveTranscriptionEvent): void {
    if (ended) return;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: event, done: false });
    } else queue.push(event);
  }
  function endEvents(): void {
    if (ended) return;
    ended = true;
    if (waiting && queue.length === 0) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }
  function cleanup(): void {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    connectTimer = undefined;
    stopTimer = undefined;
    options.signal?.removeEventListener('abort', onAbort);
  }
  function onAbort(): void {
    const error =
      options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    status = 'failed';
    canonicalAbort?.abort();
    rejectConnect?.(error);
    rejectStop?.(error);
    socket?.close(1000, 'aborted');
    emit({ type: 'error', message: 'The live transcription session was aborted.', raw: error });
    endEvents();
    cleanup();
  }
  function fail(error: unknown): void {
    if (status === 'failed' || status === 'closed' || status === 'completed') return;
    const message = error instanceof Error ? error.message : 'Giggy live transcription failed.';
    status = 'failed';
    canonicalAbort?.abort();
    rejectConnect?.(error);
    rejectStop?.(error);
    emit({ type: 'error', message, raw: error });
    endEvents();
    cleanup();
    socket?.close(1011, 'session failed');
  }
  function failProtocol(message: string): void {
    fail(
      new APICallError({
        message,
        provider: options.model.provider,
        statusCode: 200,
        isRetryable: false,
      }),
    );
  }
  function fields(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && 'data' in value) {
      value = (value as { data: unknown }).data;
    }
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw new APICallError({
          message: 'Giggy live transcription sent a non-JSON event.',
          provider: options.model.provider,
          statusCode: 200,
          isRetryable: false,
        });
      }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new APICallError({
        message: 'Giggy live transcription sent an invalid event.',
        provider: options.model.provider,
        statusCode: 200,
        isRetryable: false,
      });
    }
    return value as Record<string, unknown>;
  }
  function receive(message: unknown): void {
    if (status === 'closed' || status === 'failed' || status === 'completed') return;
    let payload: Record<string, unknown>;
    try {
      payload = fields(message);
    } catch (error) {
      fail(error);
      return;
    }
    const type = typeof payload.type === 'string' ? payload.type : '';
    const nestedGeneration =
      typeof payload.generation === 'object' && payload.generation !== null
        ? (payload.generation as Record<string, unknown>)
        : undefined;
    const uuid =
      typeof payload.generation_uuid === 'string'
        ? payload.generation_uuid
        : typeof payload.generationUuid === 'string'
          ? payload.generationUuid
          : typeof nestedGeneration?.generation_uuid === 'string'
            ? nestedGeneration.generation_uuid
            : typeof nestedGeneration?.uuid === 'string'
              ? nestedGeneration.uuid
              : undefined;
    const attempt =
      typeof payload.attempt === 'number'
        ? payload.attempt
        : typeof payload.attempt_number === 'number'
          ? payload.attempt_number
          : undefined;
    if (type === 'generation_created') {
      if (!uuid) {
        failProtocol('Giggy generation_created must include a generation UUID.');
        return;
      }
      if (created) {
        if (uuid !== generationUuid || (attempt !== undefined && attempt !== admittedAttempt))
          return;
      }
      generationUuid = uuid;
      if (attempt !== undefined) {
        if (!Number.isInteger(attempt) || attempt < 1) {
          failProtocol('Giggy generation_created included an invalid attempt.');
          return;
        }
      }
      admittedAttempt = attempt ?? readyIdentity?.attempt ?? admittedAttempt;
      created = true;
      if (ready) {
        if (
          (readyIdentity?.generationUuid && readyIdentity.generationUuid !== uuid) ||
          (attempt !== undefined && readyIdentity?.attempt !== attempt)
        ) {
          failProtocol('Giggy ready event did not match the admitted generation and attempt.');
          return;
        }
        markReady();
      }
      return;
    }
    if (type === 'ready' || type === 'microphone_ready') {
      if (!uuid || attempt === undefined || !Number.isInteger(attempt) || attempt < 1) {
        failProtocol('Giggy ready event must include a generation UUID and positive attempt.');
        return;
      }
      readyIdentity = { generationUuid: uuid, attempt };
      ready = true;
      if (created) {
        if (
          uuid !== generationUuid ||
          (admittedAttempt !== undefined && attempt !== admittedAttempt)
        ) {
          failProtocol('Giggy ready event did not match the admitted generation and attempt.');
          return;
        }
        admittedAttempt = attempt;
        markReady();
      }
      return;
    }
    if (type === 'transcription' || type === 'transcript' || type === 'transcript_chunk') {
      if (!created || !generationUuid || admittedAttempt === undefined) {
        failProtocol('Giggy sent a transcript before generation admission.');
        return;
      }
      if (!uuid || attempt === undefined) {
        failProtocol('Giggy transcript events must include generation UUID and attempt identity.');
        return;
      }
      if (uuid !== generationUuid || attempt !== admittedAttempt) return;
      const sequence =
        typeof payload.sequence === 'number'
          ? payload.sequence
          : typeof payload.seq === 'number'
            ? payload.seq
            : undefined;
      const isFinal =
        typeof payload.is_final === 'boolean'
          ? payload.is_final
          : typeof payload.isFinal === 'boolean'
            ? payload.isFinal
            : undefined;
      if (sequence === undefined || !Number.isInteger(sequence) || isFinal === undefined) {
        failProtocol('Giggy transcript events must include an integer sequence and is_final flag.');
        return;
      }
      if (sequence <= lastSequence) return;
      lastSequence = sequence;
      const alternatives = Array.isArray(payload.alternatives) ? payload.alternatives : undefined;
      const firstAlternative =
        alternatives?.[0] && typeof alternatives[0] === 'object'
          ? (alternatives[0] as Record<string, unknown>)
          : undefined;
      const text =
        typeof firstAlternative?.transcript === 'string'
          ? firstAlternative.transcript
          : typeof payload.transcript === 'string'
            ? payload.transcript
            : typeof payload.text === 'string'
              ? payload.text
              : undefined;
      if (text === undefined) {
        failProtocol('Giggy transcript events must include cumulative transcript text.');
        return;
      }
      transcript = text;
      if (isFinal) sawFinalTranscript = true;
      emit({
        type: 'transcript',
        text,
        replace: true,
        isFinal,
        sequence,
        source: 'websocket',
        generationUuid,
        attempt: admittedAttempt,
        raw: payload,
      });
      maybeComplete();
      return;
    }
    if (type === 'input_complete') {
      if (!created || !generationUuid) {
        failProtocol('Giggy sent input_complete before generation admission.');
        return;
      }
      if (!uuid) {
        failProtocol('Giggy input_complete must include generation UUID identity.');
        return;
      }
      if (uuid !== generationUuid || (attempt !== undefined && attempt !== admittedAttempt)) return;
      const sequence =
        typeof payload.sequence === 'number'
          ? payload.sequence
          : typeof payload.seq === 'number'
            ? payload.seq
            : undefined;
      if (sequence === undefined || !Number.isInteger(sequence)) {
        failProtocol('Giggy input_complete must include an integer sequence.');
        return;
      }
      if (status !== 'stopping') {
        failProtocol('Giggy input_complete arrived before the client stopped sending audio.');
        return;
      }
      if (sequence !== sentFrameCount) {
        failProtocol(
          'Giggy input_complete sequence did not match the number of binary audio frames sent.',
        );
        return;
      }
      if (sawInputComplete) {
        failProtocol('Giggy sent input_complete more than once.');
        return;
      }
      sawInputComplete = true;
      emit({ type: 'input-complete', generationUuid, attempt: admittedAttempt!, raw: payload });
      maybeFetchCanonicalResult();
      return;
    }
    if (type === 'generation_updated') {
      if (!created || !generationUuid) {
        failProtocol('Giggy sent generation_updated before generation admission.');
        return;
      }
      if (
        !uuid ||
        uuid !== generationUuid ||
        (attempt !== undefined && attempt !== admittedAttempt)
      )
        return;
      const statusValue =
        typeof payload.status === 'string'
          ? payload.status
          : typeof payload.generation_status === 'string'
            ? payload.generation_status
            : typeof nestedGeneration?.status === 'string'
              ? nestedGeneration.status
              : undefined;
      if (!statusValue) {
        failProtocol('Giggy generation_updated must include a status.');
        return;
      }
      const terminalStatus = statusValue.toLowerCase();
      emit({
        type: 'generation-updated',
        generationUuid,
        status: statusValue,
        raw: { type, generation_uuid: generationUuid, status: statusValue },
      });
      if (
        terminalStatus === 'failed' ||
        terminalStatus === 'cancelled' ||
        terminalStatus === 'canceled'
      ) {
        fail(
          new APICallError({
            message: `Giggy live transcription ended with status '${statusValue}'.`,
            provider: options.model.provider,
            statusCode: 200,
            isRetryable: false,
          }),
        );
        return;
      }
      if (terminalStatus === 'completed') sawCompletedStatus = true;
      maybeFetchCanonicalResult();
      return;
    }
    if (type === 'error') {
      fail(
        new APICallError({
          message:
            typeof payload.message === 'string'
              ? payload.message
              : 'Giggy live transcription returned an error event.',
          provider: options.model.provider,
          statusCode: 200,
          isRetryable: false,
        }),
      );
    }
  }
  function maybeFetchCanonicalResult(): void {
    if (!sawInputComplete || !sawCompletedStatus || canonicalResultStarted) return;
    if (!generationUuid || !resultApiKey || !resultBaseUrl) {
      failProtocol('Giggy completed the generation before canonical result access was ready.');
      return;
    }
    canonicalResultStarted = true;
    canonicalAbort = new AbortController();
    const canonicalErrors = new WeakSet<object>();
    const canonicalFailure = (message: string, statusCode: number, isRetryable: boolean) => {
      const error = new APICallError({
        message,
        provider: options.model.provider,
        statusCode,
        isRetryable,
      });
      canonicalErrors.add(error);
      return error;
    };
    void (async () => {
      try {
        const generationUrl = new URL(
          `${resultBaseUrl}/generations/${encodeURIComponent(generationUuid)}`,
        );
        const statusResponse = await resultFetch(generationUrl, {
          headers: { 'xi-api-key': resultApiKey!, ...resultHeaders },
          signal: canonicalAbort!.signal,
          redirect: 'error',
        });
        if (!statusResponse.ok) {
          throw canonicalFailure(
            `Giggy canonical generation lookup failed with HTTP ${statusResponse.status}.`,
            statusResponse.status,
            statusResponse.status >= 500,
          );
        }
        const statusBody = (await statusResponse.json()) as Record<string, unknown>;
        const generation =
          typeof statusBody.generation === 'object' && statusBody.generation !== null
            ? (statusBody.generation as Record<string, unknown>)
            : statusBody;
        const statusGeneration =
          typeof generation.generation === 'object' && generation.generation !== null
            ? (generation.generation as Record<string, unknown>)
            : undefined;
        const canonicalUuid =
          typeof generation.generation_uuid === 'string'
            ? generation.generation_uuid
            : typeof generation.uuid === 'string'
              ? generation.uuid
              : typeof statusGeneration?.generation_uuid === 'string'
                ? statusGeneration.generation_uuid
                : undefined;
        const canonicalStatus =
          typeof generation.status === 'string'
            ? generation.status
            : typeof statusGeneration?.status === 'string'
              ? statusGeneration.status
              : undefined;
        if (canonicalUuid !== generationUuid || canonicalStatus !== 'completed') {
          throw canonicalFailure(
            'Giggy canonical generation identity or status did not match the completed session.',
            200,
            false,
          );
        }
        const result =
          typeof generation.result === 'object' && generation.result !== null
            ? (generation.result as Record<string, unknown>)
            : undefined;
        const artifactUrl = typeof result?.url === 'string' ? result.url : undefined;
        if (!artifactUrl) {
          throw canonicalFailure(
            'Giggy completed generation did not include a canonical result URL.',
            200,
            false,
          );
        }
        let artifactTarget: URL;
        try {
          artifactTarget = new URL(artifactUrl);
        } catch {
          throw canonicalFailure('Giggy canonical result URL was invalid.', 200, false);
        }
        if (
          artifactTarget.protocol !== 'https:' ||
          artifactTarget.username ||
          artifactTarget.password
        ) {
          throw canonicalFailure(
            'Giggy canonical result URL must be a credential-free HTTPS URL.',
            200,
            false,
          );
        }
        // The signed artifact URL is its own capability: never forward the API key.
        const artifactResponse = await resultFetch(artifactTarget, {
          signal: canonicalAbort!.signal,
        });
        if (!artifactResponse.ok) {
          throw canonicalFailure(
            `Giggy canonical transcript download failed with HTTP ${artifactResponse.status}.`,
            artifactResponse.status,
            artifactResponse.status >= 500,
          );
        }
        const artifact = (await artifactResponse.json()) as Record<string, unknown>;
        const canonicalText = typeof artifact.text === 'string' ? artifact.text : undefined;
        const durationMs = artifact.audio_duration_ms;
        const expectedDurationMs = Math.ceil((sentPcmBytes * 1000) / (sampleRateHz * 2));
        if (
          canonicalText === undefined ||
          typeof durationMs !== 'number' ||
          durationMs !== expectedDurationMs
        ) {
          throw canonicalFailure(
            'Giggy canonical transcript or audio duration did not match the submitted PCM audio.',
            200,
            false,
          );
        }
        if (sawFinalTranscript && transcript !== canonicalText) {
          throw canonicalFailure(
            'Giggy canonical transcript did not match the final WebSocket transcript.',
            200,
            false,
          );
        }
        canonicalTranscript = canonicalText;
        if (!sawFinalTranscript) {
          transcript = canonicalText;
          sawFinalTranscript = true;
          lastSequence += 1;
          emit({
            type: 'transcript',
            text: canonicalText,
            replace: true,
            isFinal: true,
            sequence: lastSequence,
            source: 'canonical-result',
            generationUuid,
            attempt: admittedAttempt!,
            raw: { source: 'canonical-result' },
          });
        }
        maybeComplete();
      } catch (error) {
        if (status !== 'closed' && status !== 'failed' && status !== 'completed') {
          fail(
            typeof error === 'object' && error !== null && canonicalErrors.has(error)
              ? error
              : canonicalFailure('Giggy canonical result could not be verified.', 0, true),
          );
        }
      }
    })();
  }

  function maybeComplete(): void {
    if (!sawInputComplete || !sawCompletedStatus || canonicalTranscript === undefined) return;
    status = 'completed';
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    stopTimer = undefined;
    resolveStop?.();
    if (socketClose) {
      emit({ type: 'session-closed', ...socketClose });
    } else {
      socket?.close(1000, 'transcription complete');
      emit({ type: 'session-closed', code: 1000, reason: 'transcription complete' });
    }
    endEvents();
    cleanup();
  }
  function markReady(): void {
    if (status !== 'connecting' || !generationUuid || admittedAttempt === undefined) return;
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    connectTimer = undefined;
    status = 'ready';
    emit({ type: 'session-ready', generationUuid, attempt: admittedAttempt });
    resolveConnect?.();
  }
  function onMessage(event: unknown): void {
    try {
      const message = event as { data?: unknown } | null;
      receive(message && 'data' in message ? message.data : event);
    } catch (error) {
      fail(error);
    }
  }
  function onSocketError(): void {
    fail(
      new APICallError({
        message: 'Giggy live transcription WebSocket failed.',
        provider: options.model.provider,
        statusCode: 0,
        isRetryable: true,
      }),
    );
  }
  function onSocketClose(event: unknown): void {
    const close = (event as { code?: number; reason?: string } | null) ?? {};
    const beforeClose = status;
    if (
      beforeClose === 'stopping' &&
      sawInputComplete &&
      sawCompletedStatus &&
      canonicalResultStarted &&
      canonicalTranscript === undefined
    ) {
      socketClose = { code: close.code ?? 1000, reason: close.reason ?? '' };
      return;
    }
    if (status !== 'completed' && status !== 'failed') status = 'closed';
    if (beforeClose === 'connecting')
      rejectConnect?.(
        new APICallError({
          message: 'Giggy live transcription closed before it became ready.',
          provider: options.model.provider,
          statusCode: 0,
          isRetryable: true,
        }),
      );
    if (beforeClose === 'stopping')
      rejectStop?.(
        new APICallError({
          message: 'Giggy live transcription closed before final completion was validated.',
          provider: options.model.provider,
          statusCode: 0,
          isRetryable: true,
        }),
      );
    emit({ type: 'session-closed', code: close.code ?? 1000, reason: close.reason ?? '' });
    endEvents();
    cleanup();
  }

  return {
    get status() {
      return status;
    },
    get transcript() {
      return transcript;
    },
    get generationUuid() {
      return generationUuid;
    },
    connect() {
      if (connectPromise) return connectPromise;
      if (status !== 'idle')
        return Promise.reject(
          new InvalidRequestError({
            message: 'Giggy live transcription session can only connect once.',
          }),
        );
      status = 'connecting';
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = reject;
      });
      connectTimer = setTimeout(() => {
        fail(
          new APICallError({
            message: `Giggy live transcription did not become ready within ${connectTimeoutMs} ms.`,
            provider: options.model.provider,
            statusCode: 0,
            isRetryable: true,
          }),
        );
      }, connectTimeoutMs);
      void (async () => {
        try {
          if (options.signal?.aborted)
            throw (
              options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
            );
          const clientContext = readClientContext(options);
          const {
            apiKey,
            baseURL,
            headers,
            fetch: fetchImpl,
          } = await resolveTranscriptionCall(options.model, deps, undefined, clientContext);
          resultApiKey = apiKey;
          resultBaseUrl = baseURL;
          resultHeaders = headers;
          resultFetch = fetchImpl;
          if (status !== 'connecting') return;
          if (options.signal?.aborted)
            throw (
              options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
            );
          const url = new URL(`${baseURL}/audio/transcriptions`);
          url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
          socket = openWebSocket(url.toString(), {
            headers: { 'xi-api-key': apiKey, ...headers },
            followRedirects: false,
          });
          socket.binaryType = 'arraybuffer';
          socket.addEventListener('open', () => {
            try {
              socket!.send(
                JSON.stringify({
                  type: 'start',
                  format: 'raw',
                  encoding: 'LINEAR16',
                  sampleRateHz,
                  interimResults: true,
                  ...(options.language ? { language: options.language } : {}),
                  options: { endpointing },
                }),
              );
            } catch (error) {
              fail(error);
            }
          });
          socket.addEventListener('message', onMessage);
          socket.addEventListener('error', onSocketError);
          socket.addEventListener('close', onSocketClose);
          options.signal?.addEventListener('abort', onAbort, { once: true });
        } catch (error) {
          fail(error);
        }
      })();
      return connectPromise;
    },
    sendAudio(frame) {
      if (status !== 'ready' || !socket)
        throw new InvalidRequestError({
          message: 'Giggy live transcription is not ready for audio frames.',
        });
      const bytes =
        frame instanceof ArrayBuffer
          ? new Uint8Array(frame)
          : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
      if (bytes.byteLength === 0 || bytes.byteLength > 32_000 || bytes.byteLength % 2 !== 0) {
        throw new InvalidRequestError({
          message: 'Giggy live audio frames must contain 1–32,000 even-numbered PCM16 bytes.',
          provider: options.model.provider,
        });
      }
      const copy = bytes.slice().buffer;
      (socket as RealtimeWebSocket & { send(data: ArrayBuffer): void }).send(copy);
      sentPcmBytes += bytes.byteLength;
      sentFrameCount += 1;
    },
    stop() {
      if (status === 'completed') return Promise.resolve();
      if (status === 'stopping' && stopPromise) return stopPromise;
      if (status !== 'ready' || !socket)
        return Promise.reject(
          new InvalidRequestError({
            message: 'Giggy live transcription must be ready before stop().',
          }),
        );
      status = 'stopping';
      stopPromise = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      stopTimer = setTimeout(() => {
        fail(
          new APICallError({
            message: `Giggy live transcription did not deliver and validate final completion within ${stopTimeoutMs} ms.`,
            provider: options.model.provider,
            statusCode: 0,
            isRetryable: true,
          }),
        );
      }, stopTimeoutMs);
      try {
        socket.send(JSON.stringify({ type: 'stop' }));
      } catch (error) {
        fail(error);
      }
      return stopPromise;
    },
    async close() {
      cleanup();
      canonicalAbort?.abort();
      const previousStatus = status;
      if (status !== 'completed' && status !== 'failed') status = 'closed';
      const closedError = new DOMException(
        'The live transcription session was closed.',
        'AbortError',
      );
      if (previousStatus === 'connecting') rejectConnect?.(closedError);
      if (previousStatus === 'stopping') rejectStop?.(closedError);
      socket?.close(1000, 'client closed');
      emit({ type: 'session-closed', code: 1000, reason: 'client closed' });
      endEvents();
    },
    events() {
      return eventIterator;
    },
  };
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

/** Transcribe one audio input to text (+ optional timings) via OpenAI, Deepgram, or Giggy. */
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
  if (options.model.surface === 'giggy-transcription') {
    const stream = await streamTranscription({
      ...options,
      providerOptions: options.providerOptions?.giggy
        ? { giggy: options.providerOptions.giggy }
        : undefined,
      deps,
    });
    const reader = stream.getReader();
    let generationUuid: string | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'error') {
          const payload = value.data as {
            message?: unknown;
            error?: string | { message?: unknown };
          } | null;
          const message =
            typeof payload?.message === 'string'
              ? payload.message
              : typeof payload?.error === 'string'
                ? payload.error
                : typeof payload?.error === 'object' &&
                    payload.error !== null &&
                    typeof payload.error.message === 'string'
                  ? payload.error.message
                  : 'Giggy.ai transcription stream failed.';
          throw new APICallError({
            message,
            provider: options.model.provider,
            statusCode: 200,
            isRetryable: false,
          });
        }
        const payload = value.data as {
          generation_uuid?: unknown;
          generationUuid?: unknown;
          generation?: { generation_uuid?: unknown; uuid?: unknown; status?: unknown };
          status?: unknown;
        } | null;
        if (value.type === 'generation_created') {
          const admitted =
            payload?.generation_uuid ??
            payload?.generationUuid ??
            payload?.generation?.generation_uuid ??
            payload?.generation?.uuid;
          if (typeof admitted === 'string') generationUuid = admitted;
        }
        const payloadStatus = payload?.status ?? payload?.generation?.status;
        if (
          value.terminal &&
          (value.type === 'failed' ||
            value.type === 'stopped' ||
            value.type === 'cancelled' ||
            value.type === 'error' ||
            payloadStatus === 'error' ||
            payloadStatus === 'failed' ||
            payloadStatus === 'stopped' ||
            payloadStatus === 'cancelled')
        ) {
          throw new APICallError({
            message: `Giggy.ai transcription finished with status '${String(payloadStatus ?? value.type)}'.`,
            provider: options.model.provider,
            statusCode: 200,
            isRetryable: false,
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!generationUuid) {
      throw new APICallError({
        message: 'Giggy upload stream ended without an admitted generation UUID.',
        provider: options.model.provider,
        statusCode: 200,
        isRetryable: false,
      });
    }
    const canonical = await fetchCanonicalUploadedResult(options, deps, generationUuid);
    return {
      text: canonical.text,
      ...(canonical.language !== undefined ? { language: canonical.language } : {}),
      ...(canonical.durationSeconds !== undefined
        ? { durationSeconds: canonical.durationSeconds }
        : {}),
      usage: canonical.durationSeconds !== undefined ? { seconds: canonical.durationSeconds } : {},
      raw: canonical.raw,
    };
  }

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
