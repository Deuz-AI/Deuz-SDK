import { describe, it, expect, vi } from 'vitest';
import {
  createRealtimeSession,
  createGeminiLive,
  realtimePriceTable,
  RealtimeError,
  type RealtimeEvent,
  type RealtimeSessionOptions,
} from '../src/realtime';
import { createPriceProvider } from '../src/pricing';
import { tool } from '../src/tool';
import type { JSONSchema } from '../src/types/schema';
import {
  fakeRealtimeServer,
  geminiHandshake,
  flush,
  type FakeRealtimeSocket,
} from './fixtures/realtime-socket';

const MODEL = 'gemini-live-2.5-flash-preview';
const CITY: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

async function openSession(options: Partial<RealtimeSessionOptions> = {}): Promise<{
  session: ReturnType<typeof createRealtimeSession>;
  socket: FakeRealtimeSocket;
  events: RealtimeEvent[];
  sent: () => Record<string, unknown>[];
}> {
  const server = fakeRealtimeServer((socket) => geminiHandshake(socket));
  const session = createRealtimeSession({
    model: createGeminiLive({ apiKey: 'g-key' })(MODEL),
    ...options,
    deps: { webSocket: server.webSocket, ...options.deps },
  });
  const events: RealtimeEvent[] = [];
  session.on('*', (event) => events.push(event));
  await session.connect();
  const socket = server.socket;
  const baseline = socket.sent.length;
  return { session, socket, events, sent: () => socket.messages.slice(baseline) };
}

const ofType = <T extends RealtimeEvent['type']>(events: RealtimeEvent[], type: T) =>
  events.filter((event): event is Extract<RealtimeEvent, { type: T }> => event.type === type);

const audioPart = (data: string) => ({
  serverContent: {
    modelTurn: {
      role: 'model',
      parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }],
    },
  },
});

describe('Gemini Live — connect', () => {
  it('dials BidiGenerateContent with the key in a header and sends setup first', async () => {
    const server = fakeRealtimeServer((socket) => geminiHandshake(socket, 'live-1'));
    const session = createRealtimeSession({
      model: createGeminiLive({ apiKey: 'g-key' })(MODEL),
      instructions: 'Be brief.',
      voice: 'Kore',
      outputModality: 'audio',
      inputTranscription: { language: 'tr-TR' },
      outputTranscription: true,
      maxOutputTokens: 256,
      tools: { get_weather: tool({ description: 'Weather for a city', parameters: CITY }) },
      providerOptions: { realtimeInputConfig: { activityHandling: 'NO_INTERRUPTION' } },
      deps: { webSocket: server.webSocket },
    });
    const events: RealtimeEvent[] = [];
    session.on('*', (event) => events.push(event));
    await session.connect();

    const socket = server.socket;
    expect(socket.url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    );
    expect(socket.init.headers).toEqual({ 'x-goog-api-key': 'g-key' });
    expect(socket.messages[0]).toEqual({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          maxOutputTokens: 256,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Weather for a city',
                parameters: {
                  type: 'OBJECT',
                  properties: { city: { type: 'STRING' } },
                  propertyOrdering: ['city'],
                  required: ['city'],
                },
              },
            ],
          },
        ],
        inputAudioTranscription: { languageCodes: ['tr-TR'] },
        outputAudioTranscription: {},
        realtimeInputConfig: { activityHandling: 'NO_INTERRUPTION' },
      },
    });
    expect(session.sessionId).toBe('live-1');
    expect(events).toEqual([{ type: 'session-ready', sessionId: 'live-1' }]);
    expect(session.audioFormat.input).toMatchObject({ encoding: 'pcm16', sampleRate: 16000 });
    expect(session.audioFormat.output).toMatchObject({ encoding: 'pcm16', sampleRate: 24000 });
  });

  it('can carry the key in the query string for sockets that cannot send headers', async () => {
    const server = fakeRealtimeServer((socket) => geminiHandshake(socket));
    const session = createRealtimeSession({
      model: createGeminiLive({ apiKey: 'g key/1', apiKeyLocation: 'query' })(MODEL),
      deps: { webSocket: server.webSocket },
    });
    await session.connect();
    expect(server.socket.url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=g%20key%2F1',
    );
    expect(server.socket.init.headers).toBeUndefined();
  });

  it('uses the constrained v1alpha endpoint with an ephemeral auth token', async () => {
    const server = fakeRealtimeServer((socket) => geminiHandshake(socket));
    const session = createRealtimeSession({
      model: createGeminiLive()(MODEL),
      ephemeralToken: 'auth_tokens/abc123',
      deps: { webSocket: server.webSocket },
    });
    await session.connect();
    expect(server.socket.url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc123',
    );
    expect(server.socket.init.headers).toBeUndefined();
    expect(server.socket.init.protocols ?? []).toEqual([]);
  });

  it('turns a close before setupComplete into a rejected connect carrying the close reason', async () => {
    const server = fakeRealtimeServer((socket) => {
      queueMicrotask(() => socket.accept());
      socket.onClientMessage = (_message, self) =>
        self.drop(1008, 'API key not valid. Please pass a valid API key.');
    });
    const session = createRealtimeSession({
      model: createGeminiLive({ apiKey: 'bad' })(MODEL),
      deps: { webSocket: server.webSocket },
    });
    const failure = await session.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RealtimeError);
    expect(failure).toMatchObject({ kind: 'closed', closeCode: 1008 });
    expect((failure as Error).message).toContain('API key not valid');
    expect(session.status).toBe('closed');
  });
});

describe('Gemini Live — audio, transcripts and text', () => {
  it('streams PCM16 input with its rate and plays back 24 kHz output deltas', async () => {
    const { session, socket, events, sent } = await openSession({ inputSampleRate: 24000 });
    session.appendAudio(new Uint8Array([1, 2, 3, 250]));
    session.commitAudio();
    expect(sent()).toEqual([
      { realtimeInput: { audio: { data: 'AQID+g==', mimeType: 'audio/pcm;rate=24000' } } },
      { realtimeInput: { audioStreamEnd: true } },
    ]);

    socket.push(audioPart('BAUG'));
    socket.push(audioPart('Bwg='));
    socket.push({ serverContent: { generationComplete: true } });
    socket.push({ serverContent: { turnComplete: true } });
    await flush();

    const started = ofType(events, 'response-started');
    expect(started).toHaveLength(1);
    const responseId = started[0]!.responseId;
    expect(typeof responseId).toBe('string');
    expect(events.slice(1)).toEqual([
      { type: 'input-audio-committed' },
      { type: 'response-started', responseId },
      { type: 'audio-delta', responseId, audio: new Uint8Array([4, 5, 6]) },
      { type: 'audio-delta', responseId, audio: new Uint8Array([7, 8]) },
      { type: 'audio-done', responseId },
      { type: 'response-done', responseId, status: 'completed' },
    ]);
  });

  it('brackets audio with activityStart/activityEnd when turn detection is manual', async () => {
    const { session, socket, sent } = await openSession({ turnDetection: 'manual' });
    expect((socket.messages[0]!.setup as Record<string, unknown>).realtimeInputConfig).toEqual({
      automaticActivityDetection: { disabled: true },
    });
    const chunk = new Uint8Array([0, 0]);
    session.appendAudio(chunk);
    session.appendAudio(chunk);
    session.commitAudio();
    session.appendAudio(chunk);
    const audio = { realtimeInput: { audio: { data: 'AAA=', mimeType: 'audio/pcm;rate=16000' } } };
    expect(sent()).toEqual([
      { realtimeInput: { activityStart: {} } },
      audio,
      audio,
      { realtimeInput: { activityEnd: {} } },
      { realtimeInput: { activityStart: {} } },
      audio,
    ]);
  });

  it('maps input/output transcription and text parts, flushing open transcripts at turn end', async () => {
    const { socket, events } = await openSession();
    socket.push({ serverContent: { inputTranscription: { text: 'Mer' } } });
    socket.push({ serverContent: { inputTranscription: { text: 'haba', finished: true } } });
    socket.push({ serverContent: { outputTranscription: { text: 'Hi ' } } });
    socket.push({ serverContent: { outputTranscription: { text: 'there' } } });
    socket.push({
      serverContent: {
        modelTurn: { parts: [{ text: 'planning…', thought: true }, { text: 'Hey' }] },
      },
    });
    socket.push({ serverContent: { turnComplete: true } });
    await flush();

    const responseId = ofType(events, 'response-started')[0]!.responseId;
    expect(events.slice(1)).toEqual([
      { type: 'input-transcript-delta', delta: 'Mer' },
      { type: 'input-transcript-delta', delta: 'haba' },
      { type: 'input-transcript-done', transcript: 'Merhaba' },
      { type: 'response-started', responseId },
      { type: 'output-transcript-delta', responseId, delta: 'Hi ' },
      { type: 'output-transcript-delta', responseId, delta: 'there' },
      { type: 'text-delta', responseId, delta: 'Hey' },
      { type: 'output-transcript-done', responseId, transcript: 'Hi there' },
      { type: 'text-done', responseId, text: 'Hey' },
      { type: 'response-done', responseId, status: 'completed' },
    ]);
  });

  it('sends text as an ordered client turn', async () => {
    const { session, sent } = await openSession();
    session.sendText('Hello');
    session.sendText('Context only', { respond: false });
    session.createResponse();
    expect(sent()).toEqual([
      {
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'Hello' }] }],
          turnComplete: true,
        },
      },
      {
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'Context only' }] }],
          turnComplete: false,
        },
      },
      { clientContent: { turnComplete: true } },
    ]);
  });

  it('decodes binary frames, including Blobs, without reordering them', async () => {
    const { socket, events } = await openSession();
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    socket.push(new Blob([encode({ serverContent: { outputTranscription: { text: 'one ' } } })]));
    socket.push(encode({ serverContent: { outputTranscription: { text: 'two ' } } }).buffer);
    socket.push({ serverContent: { outputTranscription: { text: 'three' } } });
    await flush();
    expect(ofType(events, 'output-transcript-delta').map((event) => event.delta)).toEqual([
      'one ',
      'two ',
      'three',
    ]);
  });
});

describe('Gemini Live — tool calls', () => {
  it('executes a toolCall and answers with a matching functionResponse', async () => {
    const execute = vi.fn(async (args: unknown) => ({ ...(args as object), tempC: 21 }));
    const { socket, events, sent } = await openSession({
      tools: { get_weather: tool({ parameters: CITY, execute }) },
    });
    socket.push({
      toolCall: { functionCalls: [{ id: 'fc_1', name: 'get_weather', args: { city: 'Paris' } }] },
    });
    await flush();

    expect(execute.mock.calls[0]![0]).toEqual({ city: 'Paris' });
    expect(sent()).toEqual([
      {
        toolResponse: {
          functionResponses: [
            { id: 'fc_1', name: 'get_weather', response: { output: { city: 'Paris', tempC: 21 } } },
          ],
        },
      },
    ]);
    // A function call is the model's turn: it opens a response like audio would.
    const responseId = ofType(events, 'response-started')[0]!.responseId;
    expect(ofType(events, 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'fc_1',
        toolName: 'get_weather',
        args: { city: 'Paris' },
        responseId,
      },
    ]);
    expect(ofType(events, 'tool-result')).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'fc_1',
        toolName: 'get_weather',
        result: { city: 'Paris', tempC: 21 },
      },
    ]);
  });

  it('answers every call of a parallel batch in one toolResponse, errors under "error"', async () => {
    const { socket, sent } = await openSession({
      tools: {
        get_weather: tool({ parameters: CITY, execute: async () => 'sunny' }),
        broken: tool({
          parameters: { type: 'object' },
          execute: () => {
            throw new Error('boom');
          },
        }),
      },
    });
    socket.push({
      toolCall: {
        functionCalls: [
          { id: 'a', name: 'get_weather', args: { city: 'Rome' } },
          { id: 'b', name: 'broken', args: {} },
        ],
      },
    });
    await flush();
    expect(sent()).toEqual([
      {
        toolResponse: {
          functionResponses: [
            { id: 'a', name: 'get_weather', response: { output: 'sunny' } },
            { id: 'b', name: 'broken', response: { error: 'boom' } },
          ],
        },
      },
    ]);
  });

  it('aborts a call the server cancels and never answers it', async () => {
    let signal: AbortSignal | undefined;
    let finish: (value: string) => void = () => {};
    const { socket, events, sent } = await openSession({
      tools: {
        slow: tool({
          parameters: { type: 'object' },
          execute: (_args, ctx) => {
            signal = ctx.signal;
            return new Promise<string>((resolve) => (finish = resolve));
          },
        }),
      },
    });
    socket.push({ toolCall: { functionCalls: [{ id: 'fc_2', name: 'slow', args: {} }] } });
    await flush();
    socket.push({ toolCallCancellation: { ids: ['fc_2'] } });
    await flush();
    expect(signal?.aborted).toBe(true);
    finish('late');
    await flush();
    expect(sent()).toEqual([]);
    expect(ofType(events, 'tool-call-cancelled')).toEqual([
      { type: 'tool-call-cancelled', toolCallIds: ['fc_2'], reason: 'provider' },
    ]);
    expect(ofType(events, 'tool-result')).toEqual([]);
  });
});

describe('Gemini Live — interruption, lifecycle and errors', () => {
  it('surfaces barge-in and ends the turn as cancelled', async () => {
    const { session, socket, events, sent } = await openSession();
    socket.push(audioPart('AAA='));
    socket.push({ serverContent: { interrupted: true } });
    socket.push({ serverContent: { turnComplete: true } });
    await flush();
    const responseId = ofType(events, 'response-started')[0]!.responseId;
    expect(events.slice(2)).toEqual([
      { type: 'audio-delta', responseId, audio: new Uint8Array([0, 0]) },
      { type: 'interrupted', responseId },
      { type: 'audio-done', responseId },
      { type: 'response-done', responseId, status: 'cancelled', reason: 'interrupted' },
    ]);

    // Gemini Live has no client-side cancel: interrupt() warns and sends nothing.
    session.interrupt();
    await flush();
    expect(sent()).toEqual([]);
    expect(ofType(events, 'warning')[0]!.warning).toMatchObject({
      type: 'unsupported-setting',
      setting: 'interrupt',
    });
  });

  it('maps voice activity, goAway and session resumption updates', async () => {
    const { socket, events } = await openSession();
    socket.push({ voiceActivity: { voiceActivityType: 'ACTIVITY_START' } });
    socket.push({ voiceActivity: { voiceActivityType: 'ACTIVITY_END' } });
    socket.push({ goAway: { timeLeft: '9.5s' } });
    socket.push({ sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    await flush();
    expect(events.slice(1)).toEqual([
      { type: 'speech-started' },
      { type: 'speech-stopped' },
      { type: 'go-away', timeLeftMs: 9500 },
      { type: 'session-resumption', handle: 'h-1', resumable: true },
    ]);
  });

  it('reports an abnormal close after setup as a fatal error', async () => {
    const { session, socket, events } = await openSession();
    socket.drop(1011, 'Internal error encountered.');
    await flush();
    expect(events.slice(1)).toEqual([
      {
        type: 'error',
        fatal: true,
        error: expect.objectContaining({ kind: 'closed', closeCode: 1011 }),
      },
      {
        type: 'session-closed',
        code: 1011,
        reason: 'Internal error encountered.',
        initiator: 'server',
      },
    ]);
    expect(session.status).toBe('closed');
  });
});

describe('Gemini Live — usage and pricing', () => {
  const usageMetadata = {
    promptTokenCount: 1000,
    promptTokensDetails: [
      { modality: 'TEXT', tokenCount: 100 },
      { modality: 'AUDIO', tokenCount: 900 },
    ],
    responseTokenCount: 600,
    responseTokensDetails: [
      { modality: 'AUDIO', tokenCount: 500 },
      { modality: 'TEXT', tokenCount: 100 },
    ],
    thoughtsTokenCount: 50,
    totalTokenCount: 1650,
  };
  const priceProvider = createPriceProvider({
    table: realtimePriceTable({
      [MODEL]: { text: { input: 0.5, output: 2 }, audio: { input: 3, output: 12 } },
    }),
  });

  it('commits the last usageMetadata of a turn once, priced by modality', async () => {
    const { session, socket, events } = await openSession({ deps: { priceProvider } });
    socket.push(audioPart('AAA='));
    // An early, partial report in the same turn must not be double counted.
    socket.push({ usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } });
    socket.push({ serverContent: { turnComplete: true }, usageMetadata });
    await flush();

    const usage = ofType(events, 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      tokens: {
        text: { input: 100, cachedInput: 0, output: 150 },
        audio: { input: 900, cachedInput: 0, output: 500 },
        image: { input: 0, cachedInput: 0, output: 0 },
      },
      usage: {
        inputTokens: 1000,
        outputTokens: 650,
        reasoningTokens: 50,
        cachedReadTokens: 0,
        audioTokens: 1400,
        totalTokens: 1650,
      },
      // 100×0.5 + 150×2 (text, thoughts bill as output) + 900×3 + 500×12 (audio), per 1M.
      costUsd: 0.00905,
    });
    expect(usage[0]!.responseId).toBe(ofType(events, 'response-started')[0]!.responseId);
    expect(session.usage.costUsd).toBe(0.00905);
  });

  it('still counts usage that arrives after the turn completed', async () => {
    const { socket, events } = await openSession({ deps: { priceProvider } });
    socket.push(audioPart('AAA='));
    socket.push({ serverContent: { turnComplete: true } });
    socket.push({ usageMetadata });
    await flush();
    expect(ofType(events, 'usage')).toHaveLength(1);
    expect(ofType(events, 'usage')[0]!.costUsd).toBe(0.00905);
  });

  it('attributes cached and unspecified-modality tokens without losing any', async () => {
    const { socket, events } = await openSession();
    socket.push({
      usageMetadata: {
        promptTokenCount: 500,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 300 }],
        cachedContentTokenCount: 120,
        cacheTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
        responseTokenCount: 40,
        toolUsePromptTokenCount: 30,
        totalTokenCount: 570,
      },
    });
    socket.push({ serverContent: { turnComplete: true } });
    await flush();
    const [usage] = ofType(events, 'usage');
    // 200 unlabelled prompt tokens + 30 tool-result tokens are text; 20 of the 120
    // cached tokens carry no modality, so they are text too.
    expect(usage!.tokens.text).toEqual({ input: 210, cachedInput: 20, output: 40 });
    expect(usage!.tokens.audio).toEqual({ input: 200, cachedInput: 100, output: 0 });
    expect(usage!.usage).toMatchObject({
      inputTokens: 410,
      cachedReadTokens: 120,
      outputTokens: 40,
    });
    expect(usage!.costUsd).toBeUndefined();
  });
});
