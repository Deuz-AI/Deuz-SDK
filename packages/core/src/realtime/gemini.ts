/**
 * realtime/gemini.ts — the Gemini Live wire (Gemini Developer API,
 * `BidiGenerateContent`), over WebSocket.
 *
 * Everything Gemini-shaped lives here: the endpoint and its two auth forms,
 * the `setup` message, the client-message builders and `MESSAGE_FIELDS`, the
 * ordered table from server message fields to normalized events. Gemini has
 * no response ids, so a model turn gets a local one (`deps.generateId`).
 *
 * NOT LIVE-VERIFIED: shapes come from the `@google/genai` 2.28 SDK
 * (`Live.connect`, `liveConnectConfigToMldev`, `LiveServerMessage`,
 * `UsageMetadata`) and are exercised against a scripted fake socket only.
 * Vertex AI's Live endpoint is not covered.
 */
import type { CallWarning } from '../types/methods';
import { toGeminiSchema } from '../schema/gemini';
import { count, decodeBase64, deepMerge, isPlainObject, list, obj, str } from './encoding';
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
  RealtimeModalityTokens,
  RealtimeModel,
  RealtimeResponseStatus,
  RealtimeSessionConfig,
  RealtimeTokenBreakdown,
} from './types';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_API_VERSION = 'v1beta';
/** Ephemeral tokens are accepted by the constrained v1alpha endpoint only. */
const EPHEMERAL_API_VERSION = 'v1alpha';
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;

// --- connection ---------------------------------------------------------------------

export function geminiBaseURL(config: RealtimeModelConfig): string {
  return (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** `models/<id>`, unless the id is already a resource name. */
export function geminiModelName(modelId: string): string {
  return modelId.startsWith('models/') || modelId.startsWith('tunedModels/')
    ? modelId
    : `models/${modelId}`;
}

/**
 * A server key goes in an `x-goog-api-key` handshake header (or, with
 * `apiKeyLocation: 'query'`, in `?key=` as the JS SDK sends it). An ephemeral
 * `auth_tokens/…` token goes in `?access_token=` on the constrained endpoint —
 * the browser form, which needs no header at all.
 */
function connection(
  _model: RealtimeModel,
  config: RealtimeModelConfig,
  credential: RealtimeCredential,
): RealtimeConnection {
  const origin = geminiBaseURL(config).replace(/^http(s?):/i, (_match, secure: string) =>
    secure ? 'wss:' : 'ws:',
  );
  const extra =
    config.headers && Object.keys(config.headers).length > 0 ? config.headers : undefined;
  const service = (version: string, method: string) =>
    `${origin}/ws/google.ai.generativelanguage.${version}.GenerativeService.${method}`;

  if (credential.kind === 'ephemeral') {
    const url = `${service(EPHEMERAL_API_VERSION, 'BidiGenerateContentConstrained')}?access_token=${encodeURIComponent(credential.value)}`;
    return { url, ...(extra ? { headers: { ...extra } } : {}) };
  }
  const url = service(config.apiVersion ?? DEFAULT_API_VERSION, 'BidiGenerateContent');
  if (config.apiKeyLocation === 'query') {
    return {
      url: `${url}?key=${encodeURIComponent(credential.value)}`,
      ...(extra ? { headers: { ...extra } } : {}),
    };
  }
  return { url, headers: { 'x-goog-api-key': credential.value, ...extra } };
}

const pcm = (sampleRate: number): RealtimeAudioFormat => ({
  encoding: 'pcm16',
  sampleRate,
  mimeType: `audio/pcm;rate=${sampleRate}`,
});

/** PCM16 in at `inputSampleRate` (Gemini resamples; native 16 kHz), PCM16 24 kHz out. */
function audioFormat(config: RealtimeSessionConfig): {
  input: RealtimeAudioFormat;
  output: RealtimeAudioFormat;
} {
  return { input: pcm(config.inputSampleRate ?? INPUT_RATE), output: pcm(OUTPUT_RATE) };
}

// --- setup ---------------------------------------------------------------------------

/**
 * The `setup` (`BidiGenerateContentSetup`) for a provider-neutral config — the
 * same object an auth token locks. `providerOptions` is deep-merged last.
 */
export function geminiSetup(
  model: RealtimeModel,
  config: RealtimeSessionConfig,
  tools: WireTool[],
  warn: (warning: CallWarning) => void,
): Record<string, unknown> {
  const setup: Record<string, unknown> = { model: geminiModelName(model.modelId) };

  const generationConfig: Record<string, unknown> = {};
  if (config.outputModality) {
    generationConfig.responseModalities = [config.outputModality === 'text' ? 'TEXT' : 'AUDIO'];
  }
  if (config.maxOutputTokens !== undefined)
    generationConfig.maxOutputTokens = config.maxOutputTokens;
  if (config.voice) {
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
    };
  }
  if (Object.keys(generationConfig).length > 0) setup.generationConfig = generationConfig;

  if (config.instructions) setup.systemInstruction = { parts: [{ text: config.instructions }] };
  if (tools.length > 0) {
    setup.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: toGeminiSchema(tool.parameters),
        })),
      },
    ];
  }
  if (config.toolChoice) {
    warn({
      type: 'unsupported-setting',
      setting: 'toolChoice',
      message: 'Gemini Live has no tool choice; the model decides when to call tools.',
    });
  }

  const transcription = config.inputTranscription;
  if (transcription) {
    const options = transcription === true ? {} : transcription;
    if (options.model !== undefined || options.prompt !== undefined) {
      warn({
        type: 'unsupported-setting',
        setting: 'inputTranscription',
        message: 'Gemini Live transcribes with its own model; `model` and `prompt` were ignored.',
      });
    }
    setup.inputAudioTranscription = options.language ? { languageCodes: [options.language] } : {};
  }
  if (config.outputTranscription) setup.outputAudioTranscription = {};
  if (config.turnDetection) {
    setup.realtimeInputConfig = {
      automaticActivityDetection: { disabled: config.turnDetection === 'manual' },
    };
  }
  return deepMerge(setup, config.providerOptions);
}

// --- decoding helpers ------------------------------------------------------------------

type Modality = keyof RealtimeTokenBreakdown;

/** Gemini modality → the price bucket. Text, documents and unlabelled tokens bill as text. */
const MODALITY: Readonly<Record<string, Modality>> = {
  AUDIO: 'audio',
  IMAGE: 'image',
  VIDEO: 'image',
};

/** A count split by modality; whatever the details do not label is text, so nothing is lost. */
function byModality(details: unknown, total: number): Record<Modality, number> {
  const split: Record<Modality, number> = { text: 0, audio: 0, image: 0 };
  for (const entry of list(details).map(obj)) {
    split[MODALITY[str(entry.modality) ?? ''] ?? 'text'] += count(entry.tokenCount);
  }
  split.text += Math.max(0, total - split.text - split.audio - split.image);
  return split;
}

/**
 * Split Gemini usage by modality. `promptTokenCount` includes the cached
 * tokens, which move to `cachedInput`; tool results are input; thoughts are a
 * separate count that bills as text output (and is `reasoningTokens`).
 */
export function decodeGeminiUsage(raw: unknown): DecodedUsage {
  const usage = obj(raw);
  const prompt = byModality(usage.promptTokensDetails, count(usage.promptTokenCount));
  const cached = byModality(usage.cacheTokensDetails, count(usage.cachedContentTokenCount));
  const toolUse = byModality(
    usage.toolUsePromptTokensDetails,
    count(usage.toolUsePromptTokenCount),
  );
  const response = byModality(usage.responseTokensDetails, count(usage.responseTokenCount));
  const thoughts = count(usage.thoughtsTokenCount);
  const modality = (key: Modality, extraOutput = 0): RealtimeModalityTokens => ({
    input: Math.max(0, prompt[key] - cached[key]) + toolUse[key],
    cachedInput: cached[key],
    output: response[key] + extraOutput,
  });
  const decoded: DecodedUsage = {
    tokens: {
      text: modality('text', thoughts),
      audio: modality('audio'),
      image: modality('image'),
    },
  };
  if (thoughts > 0) decoded.reasoningTokens = thoughts;
  if (typeof usage.totalTokenCount === 'number') decoded.totalTokens = count(usage.totalTokenCount);
  return decoded;
}

/** What `next` adds over `previous` (a later cumulative report); `undefined` when nothing. */
function usageGrowth(next: DecodedUsage, previous: DecodedUsage): DecodedUsage | undefined {
  const grow = (key: Modality): RealtimeModalityTokens => ({
    input: Math.max(0, next.tokens[key].input - previous.tokens[key].input),
    cachedInput: Math.max(0, next.tokens[key].cachedInput - previous.tokens[key].cachedInput),
    output: Math.max(0, next.tokens[key].output - previous.tokens[key].output),
  });
  const tokens = { text: grow('text'), audio: grow('audio'), image: grow('image') };
  const any = Object.values(tokens).some((t) => t.input + t.cachedInput + t.output > 0);
  if (!any) return undefined;
  const growth: DecodedUsage = { tokens };
  const reasoning = Math.max(0, (next.reasoningTokens ?? 0) - (previous.reasoningTokens ?? 0));
  if (reasoning > 0) growth.reasoningTokens = reasoning;
  return growth;
}

/** A protobuf JSON duration (`"9.5s"`) in milliseconds. */
function durationMs(value: unknown): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(str(value) ?? '');
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function decodeCall(raw: Record<string, unknown>, sink: CodecSink): DecodedToolCall {
  const wireId = str(raw.id);
  return {
    toolCallId: wireId ?? sink.generateId(),
    toolName: str(raw.name) ?? '',
    args: isPlainObject(raw.args) ? raw.args : {},
    ...(wireId ? { wireId } : {}),
  };
}

// --- the codec ------------------------------------------------------------------------

/** One model turn: from its first output to `turnComplete`. */
interface Turn {
  responseId: string;
  audio: boolean;
  transcript: string | undefined;
  /** The provider marked the output transcript finished, so turn end does not repeat it. */
  transcriptDone: boolean;
  text: string | undefined;
  interrupted: boolean;
  /** The latest usage report of the turn: reports are taken as cumulative. */
  usage: DecodedUsage | undefined;
}

interface GeminiContext {
  readonly sink: CodecSink;
  ready: boolean;
  /** `turnDetection: 'manual'`: the client brackets speech with activity signals. */
  readonly manual: boolean;
  activityOpen: boolean;
  readonly inputMime: string;
  turn: Turn | undefined;
  /** The last finished turn, for a usage report that arrives after `turnComplete`. */
  lastTurn:
    | {
        responseId: string | undefined;
        status: RealtimeResponseStatus;
        committed: DecodedUsage | undefined;
      }
    | undefined;
  inputTranscript: string | undefined;
}

function openTurn(ctx: GeminiContext): Turn {
  if (ctx.turn) return ctx.turn;
  const turn: Turn = {
    responseId: ctx.sink.generateId(),
    audio: false,
    transcript: undefined,
    transcriptDone: false,
    text: undefined,
    interrupted: false,
    usage: undefined,
  };
  ctx.turn = turn;
  ctx.sink.emit({ type: 'response-started', responseId: turn.responseId });
  return turn;
}

function commitUsage(
  ctx: GeminiContext,
  usage: DecodedUsage,
  responseId: string | undefined,
  status: RealtimeResponseStatus,
): void {
  ctx.sink.usage(usage, { ...(responseId ? { responseId } : {}), status });
}

function flushInputTranscript(ctx: GeminiContext): void {
  if (ctx.inputTranscript === undefined) return;
  ctx.sink.emit({ type: 'input-transcript-done', transcript: ctx.inputTranscript });
  ctx.inputTranscript = undefined;
}

function turnOutcome(
  turn: Turn,
  reason: string | undefined,
): { status: RealtimeResponseStatus; reason?: string } {
  if (turn.interrupted) return { status: 'cancelled', reason: 'interrupted' };
  if (!reason || reason === 'TURN_COMPLETE_REASON_UNSPECIFIED') return { status: 'completed' };
  // A rejected or blocked turn did not finish its answer.
  return reason === 'NEED_MORE_INPUT'
    ? { status: 'completed', reason }
    : { status: 'incomplete', reason };
}

type FieldHandler = (ctx: GeminiContext, value: Record<string, unknown>) => void;

/**
 * Server message field → normalized events, in this order. Usage sits between
 * the content and the turn end, so a report that rides in the same frame as
 * `turnComplete` is part of that turn.
 */
const MESSAGE_FIELDS: ReadonlyArray<readonly [string, FieldHandler]> = [
  [
    'setupComplete',
    (ctx, value) => {
      if (ctx.ready) return;
      ctx.ready = true;
      ctx.sink.ready(str(value.sessionId));
    },
  ],
  [
    'toolCallCancellation',
    (ctx, value) => {
      const ids = list(value.ids)
        .map(str)
        .filter((id): id is string => id !== undefined);
      if (ids.length > 0) ctx.sink.cancelToolCalls(ids, 'provider');
    },
  ],
  [
    'serverContent',
    (ctx, content) => {
      const input = obj(content.inputTranscription);
      const inputText = str(input.text);
      if (inputText) {
        ctx.inputTranscript = (ctx.inputTranscript ?? '') + inputText;
        ctx.sink.emit({ type: 'input-transcript-delta', delta: inputText });
      }
      if (input.finished === true) flushInputTranscript(ctx);

      const output = obj(content.outputTranscription);
      const outputText = str(output.text);
      if (outputText) {
        const turn = openTurn(ctx);
        turn.transcript = (turn.transcript ?? '') + outputText;
        ctx.sink.emit({
          type: 'output-transcript-delta',
          responseId: turn.responseId,
          delta: outputText,
        });
      }
      if (
        output.finished === true &&
        ctx.turn?.transcript !== undefined &&
        !ctx.turn.transcriptDone
      ) {
        ctx.turn.transcriptDone = true;
        ctx.sink.emit({
          type: 'output-transcript-done',
          responseId: ctx.turn.responseId,
          transcript: ctx.turn.transcript,
        });
      }

      for (const part of list(obj(content.modelTurn).parts).map(obj)) {
        const inline = obj(part.inlineData);
        const data = str(inline.data);
        if (data !== undefined && (str(inline.mimeType) ?? '').startsWith('audio/')) {
          const turn = openTurn(ctx);
          turn.audio = true;
          ctx.sink.emit({
            type: 'audio-delta',
            responseId: turn.responseId,
            audio: decodeBase64(data),
          });
          continue;
        }
        const text = str(part.text);
        if (text && part.thought !== true) {
          const turn = openTurn(ctx);
          turn.text = (turn.text ?? '') + text;
          ctx.sink.emit({ type: 'text-delta', responseId: turn.responseId, delta: text });
        }
      }

      // Once per turn, like OpenAI's once per response; outside a turn it is
      // still worth a signal: buffered audio may be playing.
      if (content.interrupted === true && !ctx.turn?.interrupted) {
        if (ctx.turn) ctx.turn.interrupted = true;
        ctx.sink.emit({
          type: 'interrupted',
          ...(ctx.turn ? { responseId: ctx.turn.responseId } : {}),
        });
      }
    },
  ],
  [
    'toolCall',
    (ctx, value) => {
      const calls = list(value.functionCalls)
        .map(obj)
        .map((raw) => decodeCall(raw, ctx.sink));
      // A function call is the model's turn, the way speech would be.
      if (calls.length > 0) ctx.sink.toolCalls(calls, openTurn(ctx).responseId);
    },
  ],
  [
    'usageMetadata',
    (ctx, value) => {
      const report = decodeGeminiUsage(value);
      if (ctx.turn) {
        ctx.turn.usage = report;
        return;
      }
      // After the turn ended: it belongs to the last turn. A report for a turn
      // that already committed one only adds what grew since.
      const last = ctx.lastTurn;
      if (!last?.committed) {
        commitUsage(ctx, report, last?.responseId, last?.status ?? 'completed');
        ctx.lastTurn = {
          responseId: last?.responseId,
          status: last?.status ?? 'completed',
          committed: report,
        };
        return;
      }
      const growth = usageGrowth(report, last.committed);
      last.committed = report;
      if (growth) commitUsage(ctx, growth, last.responseId, last.status);
    },
  ],
  [
    'serverContent',
    (ctx, content) => {
      if (content.turnComplete !== true) return;
      flushInputTranscript(ctx);
      const turn = ctx.turn;
      if (!turn) return;
      ctx.turn = undefined;
      const { responseId } = turn;
      const outcome = turnOutcome(turn, str(content.turnCompleteReason));
      if (turn.audio) ctx.sink.emit({ type: 'audio-done', responseId });
      if (turn.transcript !== undefined && !turn.transcriptDone) {
        ctx.sink.emit({ type: 'output-transcript-done', responseId, transcript: turn.transcript });
      }
      if (turn.text !== undefined)
        ctx.sink.emit({ type: 'text-done', responseId, text: turn.text });
      if (turn.usage) commitUsage(ctx, turn.usage, responseId, outcome.status);
      ctx.sink.emit({ type: 'response-done', responseId, ...outcome });
      ctx.lastTurn = { responseId, status: outcome.status, committed: turn.usage };
    },
  ],
  [
    'voiceActivity',
    (ctx, value) => {
      const type = str(value.voiceActivityType);
      if (type === 'ACTIVITY_START') ctx.sink.emit({ type: 'speech-started' });
      else if (type === 'ACTIVITY_END') ctx.sink.emit({ type: 'speech-stopped' });
    },
  ],
  [
    'goAway',
    (ctx, value) => {
      const timeLeftMs = durationMs(value.timeLeft);
      ctx.sink.emit({ type: 'go-away', ...(timeLeftMs !== undefined ? { timeLeftMs } : {}) });
    },
  ],
  [
    'sessionResumptionUpdate',
    (ctx, value) => {
      const handle = str(value.newHandle);
      ctx.sink.emit({
        type: 'session-resumption',
        ...(handle ? { handle } : {}),
        resumable: value.resumable === true,
      });
    },
  ],
];

function createCodec(init: CodecInit): RealtimeCodec {
  const { sink, config, tools, model } = init;
  const ctx: GeminiContext = {
    sink,
    ready: false,
    manual: config.turnDetection === 'manual',
    activityOpen: false,
    inputMime: audioFormat(config).input.mimeType,
    turn: undefined,
    lastTurn: undefined,
    inputTranscript: undefined,
  };

  return {
    setup: () => [{ setup: geminiSetup(model, config, tools, (warning) => sink.warn(warning)) }],

    receive(message) {
      for (const [field, handle] of MESSAGE_FIELDS) {
        const value = message[field];
        if (value !== undefined && value !== null) handle(ctx, obj(value));
      }
    },

    appendAudio(audio) {
      const messages: ProviderMessage[] = [];
      if (ctx.manual && !ctx.activityOpen) {
        ctx.activityOpen = true;
        messages.push({ realtimeInput: { activityStart: {} } });
      }
      messages.push({ realtimeInput: { audio: { data: audio, mimeType: ctx.inputMime } } });
      return messages;
    },

    // No acknowledgement comes back for either form, so the event is emitted here.
    commitAudio() {
      if (ctx.manual) {
        if (!ctx.activityOpen) return [];
        ctx.activityOpen = false;
        sink.emit({ type: 'input-audio-committed' });
        return [{ realtimeInput: { activityEnd: {} } }];
      }
      sink.emit({ type: 'input-audio-committed' });
      return [{ realtimeInput: { audioStreamEnd: true } }];
    },

    sendText: (text, respond) => [
      { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: respond } },
    ],

    createResponse: () => [{ clientContent: { turnComplete: true } }],

    // Gemini stops on its own when the user speaks; there is no client-side cancel.
    interrupt: () => undefined,

    toolResults(outcomes: ToolOutcome[]) {
      return [
        {
          toolResponse: {
            functionResponses: outcomes.map((outcome) => ({
              ...(outcome.call.wireId ? { id: outcome.call.wireId } : {}),
              name: outcome.call.toolName,
              response: outcome.isError ? { error: outcome.result } : { output: outcome.result },
            })),
          },
        },
      ];
    },

    // A report of a turn the close cut short is still billed.
    closed() {
      const turn = ctx.turn;
      ctx.turn = undefined;
      if (turn?.usage) commitUsage(ctx, turn.usage, turn.responseId, 'cancelled');
    },
  };
}

export const geminiLiveProtocol: RealtimeProtocol = {
  label: 'Gemini Live',
  connection,
  audioFormat,
  createCodec,
};
