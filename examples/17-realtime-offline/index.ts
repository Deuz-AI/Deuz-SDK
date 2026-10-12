/**
 * 17 — Realtime voice, offline: a speech-to-speech session on a scripted socket (2.3).
 *
 * `createRealtimeSession` keeps one WebSocket open to a speech-to-speech model:
 * your audio goes in, the model's audio and its transcript stream back, and the
 * model can call your Deuz tools in the middle of the conversation. The socket
 * is a seam (`deps.webSocket`), so this example plugs in a scripted stand-in for
 * the OpenAI Realtime endpoint: no key, no network. A spoken question becomes a
 * tool call, the tool runs in this process, the spoken answer streams back, and
 * every response is priced per modality.
 */
import { tool } from '@deuz-sdk/core';
import { createPriceProvider } from '@deuz-sdk/core/pricing';
import {
  createOpenAIRealtime,
  createRealtimeSession,
  realtimePriceTable,
} from '@deuz-sdk/core/realtime';
import type {
  RealtimeEvent,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
} from '@deuz-sdk/core/realtime';

const RATE = 24_000; // OpenAI Realtime audio: PCM16, 24 kHz, mono, in both directions
const samples = (ms: number) => (RATE * ms) / 1000;
const msOf = (bytes: number) => (bytes / 2 / RATE) * 1000; // 2 bytes per sample

// --- THE SCRIPTED SERVER ------------------------------------------------------
// A stand-in for the OpenAI Realtime endpoint. It has the part of the WHATWG
// WebSocket the session uses (`send`, `close`, `addEventListener`) and answers
// each client event the way the wire does. Each `response.create` plays the
// next model turn below, one frame at a time.

/** A spoken answer: transcript and audio chunks, then `response.done` with its usage. */
function speech(id: string, chunks: string[], usage: object): object[] {
  const part = { response_id: id, item_id: `item_${id}`, output_index: 0, content_index: 0 };
  const audio = Buffer.alloc(samples(400) * 2).toString('base64'); // 400 ms of PCM16 per chunk
  return [
    { type: 'response.created', response: { id } },
    ...chunks.flatMap((delta) => [
      { type: 'response.output_audio_transcript.delta', ...part, delta },
      { type: 'response.output_audio.delta', ...part, delta: audio },
    ]),
    { type: 'response.output_audio.done', ...part },
    { type: 'response.output_audio_transcript.done', ...part, transcript: chunks.join('') },
    { type: 'response.done', response: { id, status: 'completed', output: [], usage } },
  ];
}

/** The model's turns, one per `response.create`, in order. Usage is OpenAI's shape. */
const TURNS: ((id: string) => object[])[] = [
  // 1. The spoken question is answered with a function call.
  (id) => [
    { type: 'response.created', response: { id } },
    {
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"Istanbul"}',
          },
        ],
        usage: {
          input_tokens: 150,
          output_tokens: 20,
          input_token_details: { text_tokens: 50, audio_tokens: 100 },
          output_token_details: { text_tokens: 20, audio_tokens: 0 },
        },
      },
    },
  ],
  // 2. With the tool's result in the conversation, the model speaks.
  (id) =>
    speech(id, ['Sunny and 24 degrees ', 'in Istanbul.'], {
      input_tokens: 220,
      output_tokens: 60,
      input_token_details: { text_tokens: 120, audio_tokens: 100 },
      output_token_details: { text_tokens: 15, audio_tokens: 45 },
    }),
  // 3. The typed follow-up gets a short spoken answer.
  (id) =>
    speech(id, ['You are welcome!'], {
      input_tokens: 285,
      output_tokens: 40,
      input_token_details: { text_tokens: 140, audio_tokens: 145 },
      output_token_details: { text_tokens: 10, audio_tokens: 30 },
    }),
];

/** Print what the session put on the wire. */
function sent(message: { type: string; audio?: string; item?: { type: string } }): void {
  const detail = message.audio
    ? ` (${Buffer.from(message.audio, 'base64').length} bytes)`
    : message.item
      ? ` (${message.item.type})`
      : '';
  console.log(`   [sent] ${message.type}${detail}`);
}

const scriptedServer: RealtimeWebSocketFactory = (url, init) => {
  console.log(`   [dial] ${url} (headers: ${Object.keys(init.headers ?? {}).join(', ')})`);
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const fire = (type: string, event: unknown) => listeners[type]?.forEach((fn) => fn(event));
  // Every frame arrives on a later tick, as it would from a network.
  const reply = (...messages: object[]) => {
    for (const message of messages) {
      setTimeout(() => fire('message', { data: JSON.stringify(message) }));
    }
  };
  let turn = 0;
  const socket: RealtimeWebSocket = {
    readyState: 1,
    addEventListener: (type, fn) => void (listeners[type] ??= []).push(fn),
    send(data) {
      const message = JSON.parse(data) as { type: string; audio?: string; item?: { type: string } };
      sent(message);
      if (message.type === 'session.update') {
        reply({ type: 'session.updated', session: { id: 'sess_offline' } });
      } else if (message.type === 'input_audio_buffer.commit') {
        reply(
          { type: 'input_audio_buffer.committed', item_id: 'item_user_1' },
          {
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'item_user_1',
            content_index: 0,
            transcript: 'What is the weather in Istanbul?',
          },
        );
      } else if (message.type === 'response.create') {
        turn += 1;
        reply(...TURNS[turn - 1]!(`resp_${turn}`));
      }
    },
    close: (code = 1000, reason = '') => void setTimeout(() => fire('close', { code, reason })),
  };
  setTimeout(() => fire('open', {}));
  return socket;
};

// --- THE TOOL -----------------------------------------------------------------
// An ordinary Deuz tool: the same `tool()` shape as in the chat loop.
const getWeather = tool({
  description: 'Current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  execute: async (args) => {
    const { city } = args as { city: string };
    console.log(`   [tool] get_weather(${city}) runs in this process`);
    return { city, sky: 'sunny', tempC: 24 };
  },
});

// --- THE SESSION ----------------------------------------------------------------
// REAL PROVIDER: delete `webSocket: scriptedServer` from `deps` and pass a key:
//   model: createOpenAIRealtime({ apiKey: process.env.OPENAI_API_KEY })('gpt-realtime'),
// Node >= 22 sends it as a handshake header. A browser connects with an
// `ephemeralToken` minted on your server instead (see the README).
const session = createRealtimeSession({
  model: createOpenAIRealtime({ apiKey: 'offline' })('gpt-realtime'), // the scripted server ignores it
  instructions: 'You are a terse weather assistant.',
  voice: 'marin',
  inputTranscription: true, // also transcribe what the user says
  turnDetection: 'manual', // the app ends each turn (commitAudio) instead of server-side VAD
  tools: { get_weather: getWeather },
  deps: {
    webSocket: scriptedServer,
    // No realtime prices ship with Deuz: these rates (USD per 1M tokens) are
    // illustrative. Take yours from the provider's price page.
    priceProvider: createPriceProvider({
      table: realtimePriceTable({
        'gpt-realtime': { text: { input: 4, output: 16 }, audio: { input: 32, output: 64 } },
      }),
    }),
  },
});

/** One line per event the app receives. */
function describe(event: RealtimeEvent): string {
  switch (event.type) {
    case 'session-ready':
      return `session-ready (${event.sessionId})`;
    case 'input-audio-committed':
      return `input-audio-committed (${event.itemId})`;
    case 'input-transcript-done':
      return `input-transcript-done: "${event.transcript}"`;
    case 'response-started':
      return `response-started (${event.responseId})`;
    case 'output-transcript-delta':
      return `output-transcript-delta: "${event.delta}"`;
    case 'audio-delta':
      return `audio-delta: ${event.audio.byteLength} bytes (${msOf(event.audio.byteLength)} ms)`;
    case 'output-transcript-done':
      return `output-transcript-done: "${event.transcript}"`;
    case 'tool-call':
      return `tool-call: ${event.toolName}(${JSON.stringify(event.args)})`;
    case 'tool-result':
      return `tool-result: ${JSON.stringify(event.result)}`;
    case 'usage': {
      const { text, audio } = event.tokens;
      return (
        `usage (${event.responseId}): text ${text.input} in / ${text.output} out, ` +
        `audio ${audio.input} in / ${audio.output} out = $${event.costUsd}`
      );
    }
    case 'response-done':
      return `response-done (${event.responseId}, ${event.status})`;
    case 'session-closed':
      return `session-closed (${event.code} ${event.reason}, closed by the ${event.initiator})`;
    case 'warning':
      return `warning: ${event.warning.type}: ${event.warning.message}`;
    case 'error':
      return `error: ${event.error.kind}: ${event.error.message}`;
    default:
      return event.type;
  }
}
session.on('*', (event) => console.log(`   ${describe(event)}`));

/** Resolves on the first event `stop` accepts (or when the session closes). Start it before you send. */
async function until(stop: (event: RealtimeEvent) => boolean): Promise<void> {
  for await (const event of session.events()) if (stop(event)) return;
}
const responseDone = (id: string) =>
  until((event) => event.type === 'response-done' && event.responseId === id);

console.log('1) connect: the session dials the socket and configures the model');
await session.connect();

console.log('\n2) the user asks out loud: 1.2 s of audio, then commitAudio() and createResponse()');
const answered = responseDone('resp_2'); // the tool round trip, then the spoken answer
// A real app streams microphone chunks as they arrive (PCM16, 24 kHz, mono).
for (let chunk = 0; chunk < 3; chunk++) session.appendAudio(new Int16Array(samples(400)));
session.commitAudio(); // manual turn detection: the app says when the user is done
session.createResponse();
await answered;

console.log('\n3) the user types a follow-up: sendText() adds a user turn and asks for an answer');
const thanked = responseDone('resp_3');
session.sendText('Thanks, that is all.');
await thanked;

console.log('\n4) close the session');
await session.close();
const totals = session.usage;
console.log(
  `   session total: ${totals.usage.totalTokens} tokens (${totals.usage.audioTokens} audio), ` +
    `$${totals.costUsd}`,
);
