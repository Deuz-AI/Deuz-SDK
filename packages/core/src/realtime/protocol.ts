/**
 * realtime/protocol.ts — the contract between the provider-neutral session
 * (`session.ts`) and one provider's mapping module (`openai.ts`, `gemini.ts`).
 *
 * A mapping module owns everything wire-shaped: the URL and handshake auth,
 * the setup message, the client-event builders and a TABLE from server events
 * to normalized ones. Provider turn state (which response is running, Gemini's
 * locally generated response ids, transcript accumulation) lives in its codec.
 * The session owns the socket, listeners, tool execution, pricing and totals —
 * so a provider protocol change stays inside its own module.
 */
import type { CallWarning } from '../types/methods';
import type { JSONSchema } from '../types/schema';
import type { RealtimeModelConfig } from './models';
import type {
  RealtimeAudioFormat,
  RealtimeEvent,
  RealtimeModel,
  RealtimeResponseStatus,
  RealtimeSessionConfig,
  RealtimeTokenBreakdown,
} from './types';

/** One client message, before JSON encoding. */
export type ProviderMessage = Record<string, unknown>;

/** A long-lived server key, or a browser-safe ephemeral token. */
export interface RealtimeCredential {
  kind: 'api-key' | 'ephemeral';
  value: string;
}

/** Where and how to dial. */
export interface RealtimeConnection {
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
}

/** A Deuz tool reduced to what a realtime wire declares. */
export interface WireTool {
  name: string;
  description?: string;
  parameters: JSONSchema;
}

/** A function call as decoded from the wire. */
export interface DecodedToolCall {
  toolCallId: string;
  toolName: string;
  /** Parsed arguments, or the raw text when they could not be parsed. */
  args: unknown;
  /** Why the arguments could not be parsed; the call is then answered with an error. */
  argsError?: string;
  /** The provider's own call id, when it sent one (Gemini may not). */
  wireId?: string;
}

/** A settled call, ready to go back on the wire. */
export interface ToolOutcome {
  call: DecodedToolCall;
  result: unknown;
  isError: boolean;
}

/** Token usage as one provider reported it, already split by modality. */
export interface DecodedUsage {
  tokens: RealtimeTokenBreakdown;
  /** The provider's own total, when it sent one. */
  totalTokens?: number;
  /** Reasoning/thought tokens — a subset of `tokens.text.output`. */
  reasoningTokens?: number;
}

/** What a codec reports while it decodes (implemented by the session). */
export interface CodecSink {
  /** The provider accepted the session configuration. */
  ready(sessionId: string | undefined): void;
  emit(event: RealtimeEvent): void;
  /** Send a message the codec decided on by itself (e.g. a deferred `response.create`). */
  send(message: ProviderMessage): void;
  providerError(error: { message: string; upstreamType?: string }): void;
  usage(usage: DecodedUsage, meta: { responseId?: string; status?: RealtimeResponseStatus }): void;
  toolCalls(calls: DecodedToolCall[], responseId: string | undefined): void;
  cancelToolCalls(ids: string[], reason: 'provider' | 'response-not-completed'): void;
  warn(warning: CallWarning): void;
  generateId(): string;
}

export interface CodecInit {
  model: RealtimeModel;
  config: RealtimeSessionConfig;
  tools: WireTool[];
  sink: CodecSink;
}

/** One session's provider state machine. Builders return the messages to send. */
export interface RealtimeCodec {
  /** Sent once the socket opens; the session is ready when the provider acknowledges. */
  setup(): ProviderMessage[];
  /** Decode one parsed server frame. */
  receive(message: Record<string, unknown>): void;
  appendAudio(base64: string): ProviderMessage[];
  commitAudio(): ProviderMessage[];
  sendText(text: string, respond: boolean): ProviderMessage[];
  createResponse(): ProviderMessage[];
  /** `undefined` when the provider has no client-side interrupt. */
  interrupt(playedMs: number | undefined): ProviderMessage[] | undefined;
  toolResults(outcomes: ToolOutcome[]): ProviderMessage[];
  /** The socket closed: flush whatever the codec still holds (e.g. usage). */
  closed(): void;
}

export interface RealtimeProtocol {
  /** Human-readable wire name for messages ("OpenAI Realtime"). */
  readonly label: string;
  connection(
    model: RealtimeModel,
    config: RealtimeModelConfig,
    credential: RealtimeCredential,
  ): RealtimeConnection;
  audioFormat(config: RealtimeSessionConfig): {
    input: RealtimeAudioFormat;
    output: RealtimeAudioFormat;
  };
  createCodec(init: CodecInit): RealtimeCodec;
}
