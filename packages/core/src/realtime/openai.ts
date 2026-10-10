/**
 * realtime/openai.ts — the OpenAI Realtime (GA) wire, over WebSocket.
 *
 * Everything OpenAI-shaped lives here: the URL and handshake auth, the
 * `session.update` that configures a session, the client-event builders and
 * `SERVER_EVENTS`, the table from server event `type` to normalized events.
 * A protocol change is a row change in that table.
 *
 * NOT LIVE-VERIFIED: shapes come from the `openai` 7.32 SDK's type definitions
 * (`resources/realtime/realtime.ts`, `realtime/websocket.ts`, `realtime/ws.ts`)
 * and are exercised against a scripted fake socket only.
 */
import type { CallWarning } from '../types/methods';
import type { ToolChoice } from '../types/tool';
import { RealtimeError } from './errors';
import { count, decodeBase64, deepMerge, list, obj, str } from './encoding';
import type { RealtimeModelConfig } from './models';
import type {
  CodecInit,
  CodecSink,
  DecodedToolCall,
  DecodedUsage,
  ProviderMessage,
  RealtimeCodec,
  RealtimeConnection,
  RealtimeCredential,
  RealtimeProtocol,
  ToolOutcome,
  WireTool,
} from './protocol';
import type {
  RealtimeAudioFormat,
  RealtimeModel,
  RealtimeResponseStatus,
  RealtimeSessionConfig,
} from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Used when `inputTranscription: true` (OpenAI has no transcription unless a model is named). */
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
/** OpenAI's PCM is 24 kHz only, in and out. */
const PCM_RATE = 24_000;

// --- connection -------------------------------------------------------------------

/** `{baseURL}/realtime?model=…` over ws(s), the way the SDK's `buildRealtimeURL` builds it. */
export function openaiRealtimeURL(modelId: string, config: RealtimeModelConfig): string {
  const url = new URL(config.baseURL ?? DEFAULT_BASE_URL);
  url.pathname += url.pathname.endsWith('/') ? 'realtime' : '/realtime';
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.hash = '';
  url.searchParams.set('model', modelId);
  return url.toString();
}

/**
 * Server side: the key goes out as `Authorization: Bearer` (what the SDK's `ws`
 * client sends). Browser: an ephemeral `ek_` secret rides on the subprotocol
 * list (what the SDK's native-WebSocket client sends), so no header is needed.
 */
function connection(
  model: RealtimeModel,
  config: RealtimeModelConfig,
  credential: RealtimeCredential,
): RealtimeConnection {
  const url = openaiRealtimeURL(model.modelId, config);
  const extra =
    config.headers && Object.keys(config.headers).length > 0 ? config.headers : undefined;
  if (credential.kind === 'ephemeral') {
    return {
      url,
      protocols: ['realtime', `openai-insecure-api-key.${credential.value}`],
      ...(extra ? { headers: { ...extra } } : {}),
    };
  }
  return { url, headers: { Authorization: `Bearer ${credential.value}`, ...extra } };
}

function formatOf(value: unknown): RealtimeAudioFormat {
  const type = str(obj(value).type);
  if (type === 'audio/pcmu') return { encoding: 'g711-ulaw', sampleRate: 8000, mimeType: type };
  if (type === 'audio/pcma') return { encoding: 'g711-alaw', sampleRate: 8000, mimeType: type };
  return { encoding: 'pcm16', sampleRate: PCM_RATE, mimeType: `audio/pcm;rate=${PCM_RATE}` };
}

/** PCM16 24 kHz both ways, unless `providerOptions.audio.*.format` picks G.711. */
function audioFormat(config: RealtimeSessionConfig): {
  input: RealtimeAudioFormat;
  output: RealtimeAudioFormat;
} {
  const audio = obj(obj(config.providerOptions).audio);
  return { input: formatOf(obj(audio.input).format), output: formatOf(obj(audio.output).format) };
}

// --- session configuration ----------------------------------------------------------

function toolChoiceWire(choice: ToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', name: choice.toolName };
}

/**
 * The GA `session` object for a provider-neutral config (without `model`, which
 * the URL carries; the client-secret helper adds it). `providerOptions` is
 * deep-merged last, so it can set or clear (`null`) any mapped field.
 */
export function openaiSessionConfig(
  config: RealtimeSessionConfig,
  tools: WireTool[],
  warn: (warning: CallWarning) => void,
): Record<string, unknown> {
  const session: Record<string, unknown> = { type: 'realtime' };
  if (config.instructions !== undefined) session.instructions = config.instructions;
  if (config.outputModality) session.output_modalities = [config.outputModality];
  if (config.maxOutputTokens !== undefined) session.max_output_tokens = config.maxOutputTokens;
  if (tools.length > 0) {
    session.tools = tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    }));
    if (config.toolChoice) session.tool_choice = toolChoiceWire(config.toolChoice);
  }

  const input: Record<string, unknown> = {};
  const transcription = config.inputTranscription;
  if (transcription) {
    const options = transcription === true ? {} : transcription;
    input.transcription = {
      model: options.model ?? DEFAULT_TRANSCRIPTION_MODEL,
      ...(options.language ? { language: options.language } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    };
  }
  if (config.turnDetection === 'manual') input.turn_detection = null;
  else if (config.turnDetection === 'server') input.turn_detection = { type: 'server_vad' };
  if (config.inputSampleRate !== undefined && config.inputSampleRate !== PCM_RATE) {
    warn({
      type: 'unsupported-setting',
      setting: 'inputSampleRate',
      message: `OpenAI Realtime takes PCM16 at ${PCM_RATE} Hz only; resample the audio you append (inputSampleRate ${config.inputSampleRate} was ignored).`,
    });
  }
  if (config.outputTranscription === false) {
    warn({
      type: 'unsupported-setting',
      setting: 'outputTranscription',
      message:
        'OpenAI Realtime always sends a transcript with audio output; it cannot be turned off.',
    });
  }

  const output: Record<string, unknown> = {};
  if (config.voice) output.voice = config.voice;

  const audio: Record<string, unknown> = {};
  if (Object.keys(input).length > 0) audio.input = input;
  if (Object.keys(output).length > 0) audio.output = output;
  if (Object.keys(audio).length > 0) session.audio = audio;

  return deepMerge(session, config.providerOptions);
}

// --- decoding helpers -----------------------------------------------------------------

/** `responseId` / `itemId` of an event, omitting the ones it does not carry. */
function ids(event: Record<string, unknown>): { responseId?: string; itemId?: string } {
  const responseId = str(event.response_id);
  const itemId = str(event.item_id);
  return { ...(responseId ? { responseId } : {}), ...(itemId ? { itemId } : {}) };
}

function itemOnly(event: Record<string, unknown>): { itemId?: string } {
  const itemId = str(event.item_id);
  return itemId ? { itemId } : {};
}

const STATUSES = new Set<RealtimeResponseStatus>([
  'completed',
  'cancelled',
  'incomplete',
  'failed',
]);

/** A status the gate can trust; anything unexpected reads as `incomplete`, never `completed`. */
function statusOf(value: unknown): RealtimeResponseStatus {
  return STATUSES.has(value as RealtimeResponseStatus)
    ? (value as RealtimeResponseStatus)
    : 'incomplete';
}

/**
 * Split OpenAI usage by modality. Input counts INCLUDE cached tokens, so the
 * cached share of each modality is moved out of `input`. Tokens the provider
 * reports without a modality are attributed to text, so the per-modality sum
 * always equals the reported totals.
 */
export function decodeOpenAIUsage(raw: unknown): DecodedUsage {
  const usage = obj(raw);
  const inDetails = obj(usage.input_token_details);
  const cachedDetails = obj(inDetails.cached_tokens_details);
  const outDetails = obj(usage.output_token_details);

  const inAudio = count(inDetails.audio_tokens);
  const inImage = count(inDetails.image_tokens);
  let inText = count(inDetails.text_tokens);
  inText += Math.max(0, count(usage.input_tokens) - inText - inAudio - inImage);

  const cachedAudio = count(cachedDetails.audio_tokens);
  const cachedImage = count(cachedDetails.image_tokens);
  let cachedText = count(cachedDetails.text_tokens);
  cachedText += Math.max(
    0,
    count(inDetails.cached_tokens) - cachedText - cachedAudio - cachedImage,
  );

  const outAudio = count(outDetails.audio_tokens);
  let outText = count(outDetails.text_tokens);
  outText += Math.max(0, count(usage.output_tokens) - outText - outAudio);

  const decoded: DecodedUsage = {
    tokens: {
      text: { input: Math.max(0, inText - cachedText), cachedInput: cachedText, output: outText },
      audio: {
        input: Math.max(0, inAudio - cachedAudio),
        cachedInput: cachedAudio,
        output: outAudio,
      },
      image: { input: Math.max(0, inImage - cachedImage), cachedInput: cachedImage, output: 0 },
    },
  };
  if (typeof usage.total_tokens === 'number') decoded.totalTokens = count(usage.total_tokens);
  return decoded;
}

/** Arguments arrive as a JSON string; a parse failure is answered to the model, not thrown. */
function decodeCall(item: Record<string, unknown>, sink: CodecSink): DecodedToolCall {
  const wireId = str(item.call_id);
  const raw = str(item.arguments) ?? '';
  const call: DecodedToolCall = {
    toolCallId: wireId ?? str(item.id) ?? sink.generateId(),
    toolName: str(item.name) ?? '',
    args: {},
    ...(wireId ? { wireId } : {}),
  };
  if (raw.trim() === '') return call;
  try {
    call.args = JSON.parse(raw) as unknown;
  } catch (cause) {
    call.args = raw;
    call.argsError = cause instanceof Error ? cause.message : 'the arguments are not valid JSON';
  }
  return call;
}

/** A tool result as `function_call_output.output`, which is free text. */
function outputText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result);
  }
}

// --- the codec ---------------------------------------------------------------------

interface OpenAIContext {
  readonly sink: CodecSink;
  readonly model: RealtimeModel;
  ready: boolean;
  sessionId: string | undefined;
  /** The response the server is generating, between `response.created` and `response.done`. */
  activeResponseId: string | undefined;
  /** A `response.create` waiting for the active response to finish. */
  responseRequested: boolean;
  /** The assistant audio the user may still be hearing — what `interrupt({ playedMs })` truncates. */
  lastAudio: { itemId: string; contentIndex: number } | undefined;
  /** Whether server VAD cancels a running response when the user starts talking. */
  interruptsOnSpeech: boolean;
  /** Responses whose barge-in was already reported, so it is reported once. */
  interrupted: Set<string>;
}

type ServerEventHandler = (ctx: OpenAIContext, event: Record<string, unknown>) => void;

function reportInterruption(ctx: OpenAIContext, responseId: string): void {
  if (ctx.interrupted.has(responseId)) return;
  ctx.interrupted.add(responseId);
  ctx.sink.emit({ type: 'interrupted', responseId });
}

/** Server event `type` → normalized events. Unlisted types are ignored (see `rawEvents`). */
const SERVER_EVENTS: Readonly<Record<string, ServerEventHandler>> = {
  'session.created': (ctx, event) => {
    ctx.sessionId ??= str(obj(event.session).id);
  },
  // The answer to our `session.update`: the configuration is in effect.
  'session.updated': (ctx, event) => {
    if (ctx.ready) return;
    ctx.ready = true;
    ctx.sessionId = str(obj(event.session).id) ?? ctx.sessionId;
    ctx.sink.ready(ctx.sessionId);
  },
  error: (ctx, event) => {
    const error = obj(event.error);
    const upstreamType = str(error.code) ?? str(error.type);
    ctx.sink.providerError({
      message: str(error.message) ?? 'OpenAI Realtime reported an error.',
      ...(upstreamType ? { upstreamType } : {}),
    });
  },
  'input_audio_buffer.committed': (ctx, event) => {
    ctx.sink.emit({ type: 'input-audio-committed', ...itemOnly(event) });
  },
  'input_audio_buffer.speech_started': (ctx, event) => {
    const audioStartMs = event.audio_start_ms;
    ctx.sink.emit({
      type: 'speech-started',
      ...itemOnly(event),
      ...(typeof audioStartMs === 'number' ? { audioStartMs } : {}),
    });
    // Barge-in: server VAD cancels the running response. Report it now, so
    // playback can stop before `response.done` arrives.
    if (ctx.activeResponseId && ctx.interruptsOnSpeech) {
      reportInterruption(ctx, ctx.activeResponseId);
    }
  },
  'input_audio_buffer.speech_stopped': (ctx, event) => {
    const audioEndMs = event.audio_end_ms;
    ctx.sink.emit({
      type: 'speech-stopped',
      ...itemOnly(event),
      ...(typeof audioEndMs === 'number' ? { audioEndMs } : {}),
    });
  },
  'conversation.item.input_audio_transcription.delta': (ctx, event) => {
    const delta = str(event.delta);
    if (delta) ctx.sink.emit({ type: 'input-transcript-delta', ...itemOnly(event), delta });
  },
  'conversation.item.input_audio_transcription.completed': (ctx, event) => {
    ctx.sink.emit({
      type: 'input-transcript-done',
      ...itemOnly(event),
      transcript: str(event.transcript) ?? '',
    });
  },
  // Transcription runs beside the model: its failure does not affect the session.
  'conversation.item.input_audio_transcription.failed': (ctx, event) => {
    const error = obj(event.error);
    const upstreamType = str(error.code) ?? str(error.type);
    ctx.sink.emit({
      type: 'error',
      fatal: false,
      error: new RealtimeError({
        kind: 'provider',
        message: `Input audio transcription failed: ${str(error.message) ?? 'no reason given'}`,
        provider: ctx.model.provider,
        ...(upstreamType ? { upstreamType } : {}),
      }),
    });
  },
  'response.created': (ctx, event) => {
    const responseId = str(obj(event.response).id) ?? ctx.sink.generateId();
    ctx.activeResponseId = responseId;
    ctx.sink.emit({ type: 'response-started', responseId });
  },
  'response.output_audio.delta': (ctx, event) => {
    const itemId = str(event.item_id);
    if (itemId) ctx.lastAudio = { itemId, contentIndex: count(event.content_index) };
    ctx.sink.emit({
      type: 'audio-delta',
      ...ids(event),
      audio: decodeBase64(str(event.delta) ?? ''),
    });
  },
  'response.output_audio.done': (ctx, event) => {
    ctx.sink.emit({ type: 'audio-done', ...ids(event) });
  },
  'response.output_audio_transcript.delta': (ctx, event) => {
    ctx.sink.emit({
      type: 'output-transcript-delta',
      ...ids(event),
      delta: str(event.delta) ?? '',
    });
  },
  'response.output_audio_transcript.done': (ctx, event) => {
    ctx.sink.emit({
      type: 'output-transcript-done',
      ...ids(event),
      transcript: str(event.transcript) ?? '',
    });
  },
  'response.output_text.delta': (ctx, event) => {
    ctx.sink.emit({ type: 'text-delta', ...ids(event), delta: str(event.delta) ?? '' });
  },
  'response.output_text.done': (ctx, event) => {
    ctx.sink.emit({ type: 'text-done', ...ids(event), text: str(event.text) ?? '' });
  },
  'response.done': (ctx, event) => {
    const response = obj(event.response);
    const responseId = str(response.id);
    const status = statusOf(response.status);
    const details = obj(response.status_details);
    const failure = obj(details.error);
    const reason = str(details.reason) ?? str(failure.code) ?? str(failure.type);
    if (!responseId || ctx.activeResponseId === responseId) ctx.activeResponseId = undefined;

    if (responseId) {
      if (status === 'cancelled' && reason === 'turn_detected') reportInterruption(ctx, responseId);
      ctx.interrupted.delete(responseId);
    }
    if (response.usage !== undefined && response.usage !== null) {
      ctx.sink.usage(decodeOpenAIUsage(response.usage), {
        ...(responseId ? { responseId } : {}),
        status,
      });
    }
    // The finish-reason gate: only a COMPLETED response's calls run. A cancelled,
    // truncated or failed response may carry half-written arguments.
    const calls = list(response.output)
      .map(obj)
      .filter((item) => item.type === 'function_call')
      .map((item) => decodeCall(item, ctx.sink));
    if (calls.length > 0) {
      if (status === 'completed') ctx.sink.toolCalls(calls, responseId);
      else {
        ctx.sink.cancelToolCalls(
          calls.map((call) => call.toolCallId),
          'response-not-completed',
        );
      }
    }
    ctx.sink.emit({
      type: 'response-done',
      ...(responseId ? { responseId } : {}),
      status,
      ...(reason ? { reason } : {}),
    });
    if (ctx.responseRequested && !ctx.activeResponseId) {
      ctx.responseRequested = false;
      ctx.sink.send({ type: 'response.create' });
    }
  },
};

/** Whether the effective turn detection cancels a running response on user speech. */
function interruptsOnSpeech(session: Record<string, unknown>): boolean {
  const input = obj(obj(session.audio).input);
  if (!('turn_detection' in input)) return true; // provider default: server VAD that interrupts
  const detection = input.turn_detection;
  if (detection === null) return false;
  return obj(detection).interrupt_response !== false;
}

function createCodec(init: CodecInit): RealtimeCodec {
  const { sink, config, tools, model } = init;
  const ctx: OpenAIContext = {
    sink,
    model,
    ready: false,
    sessionId: undefined,
    activeResponseId: undefined,
    responseRequested: false,
    lastAudio: undefined,
    interruptsOnSpeech: true,
    interrupted: new Set(),
  };

  /** `response.create` now, or once the running response is done (one at a time). */
  function requestResponse(): ProviderMessage[] {
    if (ctx.activeResponseId) {
      ctx.responseRequested = true;
      return [];
    }
    return [{ type: 'response.create' }];
  }

  return {
    setup() {
      const session = openaiSessionConfig(config, tools, (warning) => sink.warn(warning));
      ctx.interruptsOnSpeech = interruptsOnSpeech(session);
      // The event id lets an `error` about the configuration be matched to it.
      return [{ type: 'session.update', event_id: sink.generateId(), session }];
    },

    receive(message) {
      const type = str(message.type);
      if (type) SERVER_EVENTS[type]?.(ctx, message);
    },

    appendAudio: (audio) => [{ type: 'input_audio_buffer.append', audio }],

    commitAudio: () => [{ type: 'input_audio_buffer.commit' }],

    sendText(text, respond) {
      const item = {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      };
      return [item, ...(respond ? requestResponse() : [])];
    },

    createResponse: requestResponse,

    interrupt(playedMs) {
      const messages: ProviderMessage[] = [];
      if (ctx.activeResponseId) messages.push({ type: 'response.cancel' });
      if (playedMs !== undefined && ctx.lastAudio) {
        messages.push({
          type: 'conversation.item.truncate',
          item_id: ctx.lastAudio.itemId,
          content_index: ctx.lastAudio.contentIndex,
          audio_end_ms: Math.max(0, Math.floor(playedMs)),
        });
        ctx.lastAudio = undefined;
      }
      return messages;
    },

    toolResults(outcomes: ToolOutcome[]) {
      const outputs = outcomes.map((outcome) => ({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: outcome.call.wireId ?? outcome.call.toolCallId,
          output: outputText(outcome.result),
        },
      }));
      return [...outputs, ...requestResponse()];
    },

    closed() {},
  };
}

export const openaiRealtimeProtocol: RealtimeProtocol = {
  label: 'OpenAI Realtime',
  connection,
  audioFormat,
  createCodec,
};
