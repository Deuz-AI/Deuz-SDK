/**
 * realtime/types.ts — the public shapes of `@deuz-sdk/core/realtime` (2.3).
 *
 * One normalized event model over two speech-to-speech wires: OpenAI Realtime
 * and Gemini Live, both over WebSocket. The provider protocols are mapped in
 * `openai.ts` and `gemini.ts`; everything here is provider-neutral.
 *
 * NOT LIVE-VERIFIED: the wire shapes were derived from the official SDKs'
 * type definitions (`openai` 7.32, `@google/genai` 2.28) and exercised against
 * a scripted fake socket only. No request was made to either provider.
 */
import type { Usage } from '../types/usage';
import type { CallWarning } from '../types/methods';
import type { Dependencies } from '../types/deps';
import type { ToolCall, ToolChoice, ToolSet } from '../types/tool';
import type { ModelPrice } from '../pricing';
import type { RealtimeError } from './errors';

/** Which realtime wire a descriptor speaks. */
export type RealtimeSurface = 'openai-realtime' | 'gemini-live';

/**
 * A realtime model descriptor — its own kind, like `SpeechModel`: it cannot be
 * passed to `streamChat`. Build one with `createOpenAIRealtime` or
 * `createGeminiLive`; factory settings ride on a hidden symbol, never on an
 * enumerable property.
 */
export interface RealtimeModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: RealtimeSurface;
}

/** Settings for `createOpenAIRealtime`. */
export interface OpenAIRealtimeSettings {
  /**
   * Long-lived API key — SERVER SIDE ONLY. It goes out as an
   * `Authorization: Bearer` handshake header, which browsers cannot send; a
   * browser connects with `ephemeralToken` instead.
   */
  apiKey?: string;
  /** Default `https://api.openai.com/v1`. The socket dials `{baseURL}/realtime` over wss. */
  baseURL?: string;
  /** Extra handshake headers (server side only, like the key). */
  headers?: Record<string, string>;
  /** Logical provider id for `deps.keyProvider`. Default `'openai'`. */
  provider?: string;
}

/** Settings for `createGeminiLive` (Gemini Developer API; Vertex AI is not covered). */
export interface GeminiLiveSettings {
  /** Long-lived API key — SERVER SIDE ONLY. Browsers connect with `ephemeralToken`. */
  apiKey?: string;
  /** Default `https://generativelanguage.googleapis.com`. */
  baseURL?: string;
  /**
   * API version of the key-authenticated endpoint. Default `'v1beta'`.
   * Ephemeral tokens always use `'v1alpha'`, the only version that accepts them.
   */
  apiVersion?: string;
  /**
   * Where the API key travels: an `x-goog-api-key` handshake header (default)
   * or the `?key=` query string, for a socket that cannot send headers. The
   * query form puts the key in the URL, where proxies may log it.
   */
  apiKeyLocation?: 'header' | 'query';
  /** Extra handshake headers (server side only). */
  headers?: Record<string, string>;
  /** Logical provider id for `deps.keyProvider`. Default `'google'`. */
  provider?: string;
}

// --- the WebSocket seam -------------------------------------------------------

/** What the session asks of a socket factory. */
export interface RealtimeWebSocketInit {
  /** WebSocket subprotocols (the OpenAI browser path carries its secret here). */
  protocols?: string[];
  /**
   * Handshake headers (the server-side auth path). Browsers cannot send these;
   * Node >= 22, Deno, Bun and the `ws` package can.
   */
  headers?: Record<string, string>;
}

/**
 * The subset of the WHATWG `WebSocket` the session uses. The global
 * `WebSocket` of browsers, workers, Node >= 22, Deno and Bun satisfies it, and
 * so does an instance of the `ws` package.
 */
export interface RealtimeWebSocket {
  readonly readyState: number;
  /** Set to `'arraybuffer'` when present, so binary frames never arrive as a Blob. */
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void;
  removeEventListener?(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void;
}

/**
 * `deps.webSocket` — open a socket. Default: the runtime's global `WebSocket`.
 * Supply one to authenticate with headers where the global cannot, e.g.
 * `(url, { protocols, headers }) => new WebSocket(url, protocols, { headers })`
 * with the `ws` package.
 */
export type RealtimeWebSocketFactory = (
  url: string,
  init: RealtimeWebSocketInit,
) => RealtimeWebSocket;

/**
 * The injection seam for a realtime session: the core `Dependencies` (clock,
 * logger, keyProvider, priceProvider, generateId, onUsage, fetch) plus the
 * WebSocket factory.
 */
export type RealtimeDependencies = Dependencies & { webSocket?: RealtimeWebSocketFactory };

// --- configuration ------------------------------------------------------------

/** Input (user speech) transcription settings. */
export interface RealtimeInputTranscription {
  /** OpenAI transcription model. Default `'gpt-4o-mini-transcribe'`. Gemini has no choice. */
  model?: string;
  /** Language hint: ISO-639-1 on OpenAI, a BCP-47 code on Gemini. */
  language?: string;
  /** OpenAI only: free-text guidance for the transcription model. */
  prompt?: string;
}

/**
 * The provider-neutral session configuration. The same object configures a
 * session and the ephemeral token helpers, so a server can mint a token for
 * exactly the session the browser will open.
 */
export interface RealtimeSessionConfig {
  /** System instructions. */
  instructions?: string;
  /** Provider voice name (OpenAI `marin`, Gemini `Kore`, …). */
  voice?: string;
  /** What the model answers with. Provider default: audio. */
  outputModality?: 'audio' | 'text';
  /**
   * Deuz tools — the same `Tool` shape as everywhere in core. Tools with an
   * `execute` run in this process and their result goes back to the model;
   * tools without one are client tools, answered with `session.sendToolResult`.
   * Provider-executed tools (`type: 'provider'`) are not supported here.
   */
  tools?: ToolSet;
  /** OpenAI only (Gemini Live has no tool choice). */
  toolChoice?: ToolChoice;
  /** Transcribe the user's speech. `true` uses the provider default. */
  inputTranscription?: boolean | RealtimeInputTranscription;
  /**
   * Transcribe the model's speech (Gemini). OpenAI always sends a transcript
   * with audio output, so `true` is a no-op there and `false` cannot be honored.
   */
  outputTranscription?: boolean;
  /**
   * `'server'`: the provider detects the end of the user's turn (VAD) and
   * answers. `'manual'`: the app ends the turn with `commitAudio()` and, on
   * OpenAI, asks for an answer with `createResponse()`. Unset: provider default
   * (server-side detection on both).
   */
  turnDetection?: 'server' | 'manual';
  /**
   * Sample rate of the PCM16 audio you append. Gemini resamples any rate
   * (native 16 kHz); OpenAI accepts 24 kHz only.
   */
  inputSampleRate?: number;
  /** Cap on the tokens of one model answer. */
  maxOutputTokens?: number;
  /**
   * Raw wire escape hatch, deep-merged over the mapped configuration: the
   * OpenAI `session` object, or the Gemini `setup` message. Arrays and scalars
   * replace; `null` clears.
   */
  providerOptions?: Record<string, unknown>;
}

/** Options for `createRealtimeSession`. */
export interface RealtimeSessionOptions extends RealtimeSessionConfig {
  model: RealtimeModel;
  /**
   * A short-lived, browser-safe credential minted by your server — an OpenAI
   * client secret (`ek_…`, see `createOpenAIClientSecret`) or a Gemini auth
   * token (`auth_tokens/…`, see `createGeminiAuthToken`) — or a function that
   * fetches one when `connect()` runs. When set, no API key is used.
   */
  ephemeralToken?: string | (() => string | Promise<string>);
  /**
   * Server-side approver for tools marked `needsApproval`. Without it, such a
   * call is denied: the model hears "Tool call denied." and nothing runs.
   */
  approveToolCall?: (call: ToolCall) => boolean | Promise<boolean>;
  /** Forwarded untouched to every tool's `execute` context. */
  runtimeContext?: unknown;
  /**
   * How long `connect()` waits for the provider to accept the session, token
   * fetch included. Timed on `deps.clock`. Default 15 000 ms; `0` or
   * `Infinity` disables it.
   */
  connectTimeoutMs?: number;
  /** Aborting closes the session (and rejects a pending `connect()`). */
  signal?: AbortSignal;
  /** Also emit every parsed server frame as a `raw` event. Default `false`. */
  rawEvents?: boolean;
  deps?: RealtimeDependencies;
}

// --- usage ----------------------------------------------------------------------

/** Tokens of one modality. `input` excludes `cachedInput`, as `Usage.inputTokens` does. */
export interface RealtimeModalityTokens {
  input: number;
  cachedInput: number;
  /** Generated tokens (text output includes reasoning/thought tokens). */
  output: number;
}

/**
 * Usage split by modality — realtime providers bill audio several times
 * higher than text, so one aggregate count cannot be priced correctly.
 * `image` also carries video frames.
 */
export interface RealtimeTokenBreakdown {
  text: RealtimeModalityTokens;
  audio: RealtimeModalityTokens;
  image: RealtimeModalityTokens;
}

/** Running totals of a session. */
export interface RealtimeUsageTotals {
  /** The canonical core `Usage`, summed over every response. */
  usage: Usage;
  tokens: RealtimeTokenBreakdown;
  /**
   * USD of the responses that had a price — `undefined` while none had one, or
   * when no `deps.priceProvider` is set. An unpriced model is reported once by
   * an `unpriced-model` warning and the session keeps going.
   */
  costUsd: number | undefined;
}

/**
 * Per-modality prices for one realtime model (USD per 1M tokens). See
 * `realtimePriceTable`: text tokens price under the model id, audio under
 * `audio:<model>`, image under `image:<model>`.
 */
export interface RealtimeModelPrice {
  text: ModelPrice;
  audio: ModelPrice;
  image?: ModelPrice;
}

// --- events ---------------------------------------------------------------------

/** How a response (one model turn) ended. */
export type RealtimeResponseStatus = 'completed' | 'cancelled' | 'incomplete' | 'failed';

/**
 * The normalized event stream. Provider ids (`itemId`, `responseId`) are
 * passed through where the wire has them; Gemini has no item ids, and its
 * response ids are generated locally (`deps.generateId`).
 */
export type RealtimeEvent =
  /** The provider accepted the session configuration; sending is now allowed. */
  | { type: 'session-ready'; sessionId?: string }
  /**
   * The socket closed — always the last event. `initiator` says who started
   * the close; `code` and `reason` are the closing handshake's (on a client
   * close, whatever the server echoed back).
   */
  | { type: 'session-closed'; code: number; reason: string; initiator: 'client' | 'server' }
  /** Gemini: the server will end the connection soon. */
  | { type: 'go-away'; timeLeftMs?: number }
  /** Gemini (when `sessionResumption` is enabled): a handle to resume from. */
  | { type: 'session-resumption'; handle?: string; resumable: boolean }
  /** The provider detected the user starting to speak. Stop playback on OpenAI. */
  | { type: 'speech-started'; itemId?: string; audioStartMs?: number }
  | { type: 'speech-stopped'; itemId?: string; audioEndMs?: number }
  /** The appended audio became a user turn. Gemini has no acknowledgement: emitted on send. */
  | { type: 'input-audio-committed'; itemId?: string }
  | { type: 'input-transcript-delta'; itemId?: string; delta: string }
  | { type: 'input-transcript-done'; itemId?: string; transcript: string }
  /** A model turn began. */
  | { type: 'response-started'; responseId: string }
  /** Output audio — raw bytes in `session.audioFormat.output` (PCM16 24 kHz by default). */
  | { type: 'audio-delta'; responseId?: string; itemId?: string; audio: Uint8Array }
  | { type: 'audio-done'; responseId?: string; itemId?: string }
  /** What the model is saying, as text. */
  | { type: 'output-transcript-delta'; responseId?: string; itemId?: string; delta: string }
  | { type: 'output-transcript-done'; responseId?: string; itemId?: string; transcript: string }
  /** Text output (`outputModality: 'text'`). */
  | { type: 'text-delta'; responseId?: string; itemId?: string; delta: string }
  | { type: 'text-done'; responseId?: string; itemId?: string; text: string }
  /** The model called a tool. Executable tools run automatically. */
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown; responseId?: string }
  /** A tool call was answered; the result went back to the model. */
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  /**
   * Calls that will not run: the provider cancelled them (`'provider'`), or the
   * response that produced them did not complete (`'response-not-completed'`
   * — the 2.3 finish-reason gate, so a truncated call never executes).
   */
  | {
      type: 'tool-call-cancelled';
      toolCallIds: string[];
      reason: 'provider' | 'response-not-completed';
    }
  /** The user barged in and the provider cut the model's turn short: drop queued audio. */
  | { type: 'interrupted'; responseId?: string }
  /** A model turn ended. */
  | { type: 'response-done'; responseId?: string; status: RealtimeResponseStatus; reason?: string }
  /** Token usage of one response, priced when `deps.priceProvider` is set. */
  | {
      type: 'usage';
      responseId?: string;
      usage: Usage;
      tokens: RealtimeTokenBreakdown;
      costUsd?: number;
    }
  | { type: 'warning'; warning: CallWarning }
  /** `fatal: true` means the session is closing. */
  | { type: 'error'; error: RealtimeError; fatal: boolean }
  /** Every parsed server frame, when `rawEvents` is on. */
  | { type: 'raw'; message: unknown };

export type RealtimeEventType = RealtimeEvent['type'];

/** The event of one `type`. */
export type RealtimeEventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;

// --- the session ----------------------------------------------------------------

export type RealtimeSessionStatus = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

/** The audio a session expects (`input`) and produces (`output`). Always mono. */
export interface RealtimeAudioFormat {
  encoding: 'pcm16' | 'g711-ulaw' | 'g711-alaw';
  sampleRate: number;
  /** The provider's MIME type for it, e.g. `audio/pcm;rate=16000`. */
  mimeType: string;
}

/** A live realtime session. Single-use: create a new one to reconnect. */
export interface RealtimeSession {
  readonly model: RealtimeModel;
  readonly status: RealtimeSessionStatus;
  /** The provider's session id, once known. */
  readonly sessionId: string | undefined;
  readonly audioFormat: { input: RealtimeAudioFormat; output: RealtimeAudioFormat };
  /** Running totals (a snapshot). */
  readonly usage: RealtimeUsageTotals;
  /**
   * Open the socket and configure the session. Resolves on `session-ready`.
   * Rejects with a `RealtimeError` (or `AuthenticationError` without a
   * credential, `AbortError` on abort). Calling it again while connecting
   * shares the same attempt; once open it resolves at once; once closed it
   * rejects (`kind: 'closed'`). A failure after the socket was created is
   * also reported as a fatal `error` event, followed by `session-closed`; a
   * failure before that (no credential, no WebSocket) only rejects.
   */
  connect(): Promise<void>;
  /**
   * Close the socket. Resolves once `session-closed` was emitted (at once
   * when no socket was ever opened). Idempotent.
   */
  close(): Promise<void>;
  /** Subscribe to one event type (or `'*'`). Returns the unsubscribe function. */
  on<T extends RealtimeEventType>(
    type: T,
    listener: (event: RealtimeEventOf<T>) => void,
  ): () => void;
  on(type: '*', listener: (event: RealtimeEvent) => void): () => void;
  /** Every event from now on, buffered; ends after `session-closed`. */
  events(): AsyncIterableIterator<RealtimeEvent>;
  /** Append user audio in `audioFormat.input` (PCM16 little-endian by default). */
  appendAudio(audio: ArrayBuffer | ArrayBufferView): void;
  /** End the user's audio turn (needed with `turnDetection: 'manual'`). */
  commitAudio(): void;
  /** Add a user text turn; answers it unless `respond: false`. */
  sendText(text: string, options?: { respond?: boolean }): void;
  /** Ask the model to answer now (manual turn detection). */
  createResponse(): void;
  /**
   * Cut the model off. OpenAI: cancels the running response and, with
   * `playedMs`, truncates the assistant audio to what the user actually heard.
   * Gemini Live has no client-side cancel: nothing is sent and the first call
   * emits an `unsupported-setting` warning (Gemini stops on its own when the
   * user speaks).
   */
  interrupt(options?: { playedMs?: number }): void;
  /** Answer a pending client-tool call (a tool without `execute`). */
  sendToolResult(toolCallId: string, result: unknown, options?: { isError?: boolean }): void;
  /** Send a provider wire message as-is, for anything the normalized API does not map. */
  sendRaw(message: Record<string, unknown>): void;
}

// --- ephemeral credentials --------------------------------------------------------

/** A browser-safe credential minted server side. */
export interface RealtimeToken {
  /** Pass as `ephemeralToken` to `createRealtimeSession`. */
  token: string;
  /** Expiry in epoch milliseconds, when the provider reports one. */
  expiresAt: number | undefined;
  /** The provider's full response. */
  raw: unknown;
}

/** Options for `createOpenAIClientSecret` (server side). */
export interface CreateOpenAIClientSecretOptions extends RealtimeSessionConfig {
  /** A descriptor from `createOpenAIRealtime({ apiKey })`. */
  model: RealtimeModel;
  /** Secret lifetime, 10–7200 s. Provider default: 600 s. */
  expiresInSeconds?: number;
  signal?: AbortSignal;
  deps?: Dependencies;
}

/** Options for `createGeminiAuthToken` (server side). */
export interface CreateGeminiAuthTokenOptions extends RealtimeSessionConfig {
  /** A descriptor from `createGeminiLive({ apiKey })`. */
  model: RealtimeModel;
  /** How many sessions the token may open. Provider default: 1; 0 = unlimited. */
  uses?: number;
  /** When messages on sessions opened with the token stop being accepted. Provider default: 30 min. */
  expiresInSeconds?: number;
  /** When the token stops opening new sessions. Provider default: 60 s. */
  newSessionExpiresInSeconds?: number;
  /**
   * Lock the session configuration into the token. `true` (default): the
   * model and the configuration given here are fixed and a browser cannot
   * change any setup field. A list of setup field paths
   * (`'systemInstruction'`, `'generationConfig.temperature'`, …) locks only
   * those. `false`: no constraints — the browser configures the session.
   */
  lockConfig?: boolean | string[];
  signal?: AbortSignal;
  deps?: Dependencies;
}
