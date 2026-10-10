/**
 * `@deuz-sdk/core/realtime` (2.3): live speech-to-speech sessions over
 * WebSocket — OpenAI Realtime and Gemini Live behind one event model.
 *
 * - `createRealtimeSession` opens a session; `deps.webSocket` swaps the socket
 *   (default: the runtime's global `WebSocket`).
 * - `createOpenAIRealtime` / `createGeminiLive` build the model descriptors.
 * - `createOpenAIClientSecret` / `createGeminiAuthToken` mint browser-safe
 *   ephemeral tokens on your server.
 * - Tools are ordinary Deuz `tool()`s; usage is split by modality and priced
 *   through `deps.priceProvider` (`realtimePriceTable` builds the rows).
 *
 * Edge-safe (Web APIs only). NOT LIVE-VERIFIED: the wire protocols were
 * derived from the providers' official SDK types (`openai` 7.32,
 * `@google/genai` 2.28) and tested against a scripted fake socket. WebRTC is
 * not covered (planned for 2.4).
 */
export { createRealtimeSession } from './session';
export { createOpenAIRealtime, createGeminiLive } from './models';
export { createOpenAIClientSecret, createGeminiAuthToken } from './tokens';
export { realtimePriceTable } from './usage';
export { RealtimeError } from './errors';
export type { RealtimeErrorKind, RealtimeErrorOptions } from './errors';
export type {
  RealtimeSurface,
  RealtimeModel,
  OpenAIRealtimeSettings,
  GeminiLiveSettings,
  RealtimeWebSocketInit,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
  RealtimeDependencies,
  RealtimeInputTranscription,
  RealtimeSessionConfig,
  RealtimeSessionOptions,
  RealtimeModalityTokens,
  RealtimeTokenBreakdown,
  RealtimeUsageTotals,
  RealtimeModelPrice,
  RealtimeResponseStatus,
  RealtimeEvent,
  RealtimeEventType,
  RealtimeEventOf,
  RealtimeSessionStatus,
  RealtimeAudioFormat,
  RealtimeSession,
  RealtimeToken,
  CreateOpenAIClientSecretOptions,
  CreateGeminiAuthTokenOptions,
} from './types';
