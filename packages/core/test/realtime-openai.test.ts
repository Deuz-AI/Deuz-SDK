import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createRealtimeSession,
  createOpenAIRealtime,
  realtimePriceTable,
  RealtimeError,
  type RealtimeEvent,
  type RealtimeSessionOptions,
} from '../src/realtime';
import { createPriceProvider } from '../src/pricing';
import { tool } from '../src/tool';
import { AuthenticationError } from '../src/errors';
import type { JSONSchema } from '../src/types/schema';
import type { ToolExecuteContext } from '../src/types/tool';
import {
  fakeRealtimeServer,
  openaiHandshake,
  flush,
  type FakeRealtimeSocket,
} from './fixtures/realtime-socket';
import { manualClock } from './fixtures/manual-clock';

const CITY: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

/** Open an OpenAI session over a fake socket and collect every event. */
async function openSession(
  options: Partial<RealtimeSessionOptions> = {},
  modelId = 'gpt-realtime',
): Promise<{
  session: ReturnType<typeof createRealtimeSession>;
  socket: FakeRealtimeSocket;
  events: RealtimeEvent[];
  sent: () => Record<string, unknown>[];
}> {
  const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
  let ids = 0;
  const session = createRealtimeSession({
    model: createOpenAIRealtime({ apiKey: 'sk-test' })(modelId),
    ...options,
    deps: { webSocket: server.webSocket, generateId: () => `id_${++ids}`, ...options.deps },
  });
  const events: RealtimeEvent[] = [];
  session.on('*', (event) => events.push(event));
  await session.connect();
  const socket = server.socket;
  // Everything after the handshake is what the test is about.
  const baseline = socket.sent.length;
  return {
    session,
    socket,
    events,
    sent: () => socket.messages.slice(baseline),
  };
}

const ofType = <T extends RealtimeEvent['type']>(events: RealtimeEvent[], type: T) =>
  events.filter((event): event is Extract<RealtimeEvent, { type: T }> => event.type === type);

describe('OpenAI Realtime — connect', () => {
  it('dials /realtime with Bearer auth from the factory key and configures the session', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket, 'sess_42'));
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk-test' })('gpt-realtime'),
      instructions: 'Be brief.',
      voice: 'marin',
      outputModality: 'audio',
      maxOutputTokens: 512,
      inputTranscription: { model: 'gpt-4o-transcribe', language: 'tr' },
      turnDetection: 'manual',
      providerOptions: { audio: { input: { noise_reduction: { type: 'near_field' } } } },
      deps: { webSocket: server.webSocket, generateId: () => 'evt_setup' },
    });
    const events: RealtimeEvent[] = [];
    session.on('*', (event) => events.push(event));

    expect(session.status).toBe('idle');
    await session.connect();

    const socket = server.socket;
    expect(socket.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(socket.init.headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect(socket.init.protocols ?? []).toEqual([]);
    expect(socket.messages[0]).toEqual({
      type: 'session.update',
      event_id: 'evt_setup',
      session: {
        type: 'realtime',
        instructions: 'Be brief.',
        output_modalities: ['audio'],
        max_output_tokens: 512,
        audio: {
          input: {
            transcription: { model: 'gpt-4o-transcribe', language: 'tr' },
            turn_detection: null,
            noise_reduction: { type: 'near_field' },
          },
          output: { voice: 'marin' },
        },
      },
    });
    expect(session.status).toBe('open');
    expect(session.sessionId).toBe('sess_42');
    expect(events).toEqual([{ type: 'session-ready', sessionId: 'sess_42' }]);
    expect(session.audioFormat.input).toMatchObject({ encoding: 'pcm16', sampleRate: 24000 });
    expect(session.audioFormat.output).toMatchObject({ encoding: 'pcm16', sampleRate: 24000 });
  });

  it('declares Deuz tools in the session (same Tool shape as the rest of core)', async () => {
    const { socket } = await openSession({
      tools: {
        get_weather: tool({ description: 'Weather for a city', parameters: CITY }),
        lookup: tool({ parameters: z.object({ id: z.string() }) }),
      },
      toolChoice: 'required',
    });
    const update = socket.messages[0] as { session: Record<string, unknown> };
    expect(update.session.tool_choice).toBe('required');
    expect(update.session.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Weather for a city',
        parameters: CITY,
      },
      {
        type: 'function',
        name: 'lookup',
        parameters: expect.objectContaining({
          type: 'object',
          properties: { id: { type: 'string' } },
        }),
      },
    ]);
  });

  it('authenticates a browser with an ephemeral client secret over the subprotocol, never a header', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const ephemeralToken = vi.fn(async () => 'ek_live_123');
    const session = createRealtimeSession({
      // No apiKey anywhere: the browser only ever holds the short-lived secret.
      model: createOpenAIRealtime()('gpt-realtime'),
      ephemeralToken,
      deps: { webSocket: server.webSocket },
    });
    await session.connect();
    expect(ephemeralToken).toHaveBeenCalledTimes(1);
    expect(server.socket.init.protocols).toEqual([
      'realtime',
      'openai-insecure-api-key.ek_live_123',
    ]);
    expect(server.socket.init.headers).toBeUndefined();
  });

  it('honours a custom baseURL and the deps.keyProvider precedence', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk-factory', baseURL: 'https://gateway.example/v1/' })(
        'gpt-realtime-mini',
      ),
      deps: {
        webSocket: server.webSocket,
        keyProvider: { getKey: (provider) => (provider === 'openai' ? 'sk-provider' : undefined) },
      },
    });
    await session.connect();
    expect(server.socket.url).toBe('wss://gateway.example/v1/realtime?model=gpt-realtime-mini');
    expect(server.socket.init.headers).toEqual({ Authorization: 'Bearer sk-provider' });
  });

  it('keeps a plain ws:// or http:// base URL unencrypted (local proxies)', async () => {
    for (const baseURL of ['ws://localhost:8080/v1', 'http://localhost:8080/v1']) {
      const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
      const session = createRealtimeSession({
        model: createOpenAIRealtime({ apiKey: 'sk', baseURL })('gpt-realtime'),
        deps: { webSocket: server.webSocket },
      });
      await session.connect();
      expect(server.socket.url).toBe('ws://localhost:8080/v1/realtime?model=gpt-realtime');
      await session.close();
    }
  });

  it('refuses to dial without a credential', async () => {
    const server = fakeRealtimeServer((socket) => openaiHandshake(socket));
    const session = createRealtimeSession({
      model: createOpenAIRealtime()('gpt-realtime'),
      deps: { webSocket: server.webSocket },
    });
    await expect(session.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(server.sockets).toHaveLength(0);
    expect(session.status).toBe('closed');
  });

  it('rejects connect when the server answers the session.update with an error', async () => {
    const server = fakeRealtimeServer((socket) => {
      queueMicrotask(() => socket.accept());
      socket.onClientMessage = (message, self) => {
        if (message.type === 'session.update') {
          self.push({
            type: 'error',
            event_id: 'evt_err',
            error: {
              type: 'invalid_request_error',
              code: 'invalid_value',
              message: "Invalid value: 'robot'. Supported values are: 'alloy', 'marin'.",
              param: 'session.audio.output.voice',
              event_id: message.event_id,
            },
          });
        }
      };
    });
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk-test' })('gpt-realtime'),
      voice: 'robot',
      deps: { webSocket: server.webSocket },
    });
    const events: RealtimeEvent[] = [];
    session.on('*', (event) => events.push(event));

    const failure = await session.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RealtimeError);
    expect(failure).toMatchObject({ kind: 'provider', upstreamType: 'invalid_value' });
    expect((failure as Error).message).toContain("Invalid value: 'robot'");

    await flush();
    expect(server.socket.closeCalls).toHaveLength(1);
    expect(session.status).toBe('closed');
    expect(ofType(events, 'error')).toEqual([{ type: 'error', error: failure, fatal: true }]);
    expect(ofType(events, 'session-closed')).toHaveLength(1);
    expect(ofType(events, 'session-ready')).toHaveLength(0);
  });

  it('times out a handshake that never completes, on the injected clock', async () => {
    const { clock, advance } = manualClock();
    const server = fakeRealtimeServer(); // never accepts
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk-test' })('gpt-realtime'),
      connectTimeoutMs: 1_000,
      deps: { webSocket: server.webSocket, clock },
    });
    const pending = session.connect().catch((error: unknown) => error);
    await advance(999);
    expect(session.status).toBe('connecting');
    await advance(1);
    const failure = await pending;
    expect(failure).toBeInstanceOf(RealtimeError);
    expect(failure).toMatchObject({ kind: 'connect-timeout' });
    expect(server.socket.closeCalls).toHaveLength(1);
  });

  it('closes the socket and rejects when the signal aborts mid-handshake', async () => {
    const server = fakeRealtimeServer(); // never accepts
    const controller = new AbortController();
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk-test' })('gpt-realtime'),
      signal: controller.signal,
      deps: { webSocket: server.webSocket },
    });
    const pending = session.connect().catch((error: unknown) => error);
    await flush();
    controller.abort();
    const failure = await pending;
    expect(failure).toMatchObject({ code: 'aborted' });
    expect(server.socket.closeCalls).toHaveLength(1);
  });
});

describe('OpenAI Realtime — audio, transcripts and text', () => {
  it('round-trips audio: append/commit go out base64, output deltas come back as bytes', async () => {
    const { session, socket, events, sent } = await openSession();

    session.appendAudio(new Uint8Array([1, 2, 3, 250]));
    session.appendAudio(new Int16Array([1, -1]));
    session.commitAudio();
    session.createResponse();
    expect(sent()).toEqual([
      { type: 'input_audio_buffer.append', audio: 'AQID+g==' },
      { type: 'input_audio_buffer.append', audio: 'AQD//w==' },
      { type: 'input_audio_buffer.commit' },
      { type: 'response.create', event_id: expect.any(String) },
    ]);

    socket.push({ type: 'input_audio_buffer.committed', event_id: 'e1', item_id: 'item_u1' });
    socket.push({
      type: 'response.created',
      event_id: 'e2',
      response: { id: 'resp_1', status: 'in_progress', output: [] },
    });
    const delta = {
      event_id: 'e3',
      response_id: 'resp_1',
      item_id: 'item_a1',
      output_index: 0,
      content_index: 0,
    };
    socket.push({ ...delta, type: 'response.output_audio.delta', delta: 'BAUG' });
    socket.push({ ...delta, type: 'response.output_audio.done' });
    socket.push({
      type: 'response.done',
      event_id: 'e4',
      response: { id: 'resp_1', status: 'completed', output: [] },
    });
    await flush();

    expect(events.slice(1)).toEqual([
      { type: 'input-audio-committed', itemId: 'item_u1' },
      { type: 'response-started', responseId: 'resp_1' },
      {
        type: 'audio-delta',
        responseId: 'resp_1',
        itemId: 'item_a1',
        audio: new Uint8Array([4, 5, 6]),
      },
      { type: 'audio-done', responseId: 'resp_1', itemId: 'item_a1' },
      { type: 'response-done', responseId: 'resp_1', status: 'completed' },
    ]);
  });

  it('maps input transcription, output transcript and text deltas', async () => {
    const { socket, events } = await openSession();
    const item = { event_id: 'e', item_id: 'item_u1', content_index: 0 };
    socket.push({
      ...item,
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'Mer',
    });
    socket.push({
      ...item,
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'haba',
    });
    socket.push({
      ...item,
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Merhaba',
      usage: { type: 'duration', seconds: 1 },
    });
    const out = { event_id: 'e', response_id: 'resp_1', item_id: 'item_a1', output_index: 0 };
    socket.push({
      ...out,
      content_index: 0,
      type: 'response.output_audio_transcript.delta',
      delta: 'Hi',
    });
    socket.push({
      ...out,
      content_index: 0,
      type: 'response.output_audio_transcript.done',
      transcript: 'Hi there',
    });
    socket.push({ ...out, content_index: 1, type: 'response.output_text.delta', delta: 'Hey' });
    socket.push({ ...out, content_index: 1, type: 'response.output_text.done', text: 'Hey' });
    await flush();

    const ids = { responseId: 'resp_1', itemId: 'item_a1' };
    expect(events.slice(1)).toEqual([
      { type: 'input-transcript-delta', itemId: 'item_u1', delta: 'Mer' },
      { type: 'input-transcript-delta', itemId: 'item_u1', delta: 'haba' },
      { type: 'input-transcript-done', itemId: 'item_u1', transcript: 'Merhaba' },
      { type: 'output-transcript-delta', ...ids, delta: 'Hi' },
      { type: 'output-transcript-done', ...ids, transcript: 'Hi there' },
      { type: 'text-delta', ...ids, delta: 'Hey' },
      { type: 'text-done', ...ids, text: 'Hey' },
    ]);
  });

  it('sends a text turn and asks for a response unless told not to', async () => {
    const { session, sent } = await openSession();
    session.sendText('Hello');
    session.sendText('Context only', { respond: false });
    expect(sent()).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      },
      { type: 'response.create', event_id: expect.any(String) },
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Context only' }],
        },
      },
    ]);
  });

  it('reports a failed input transcription as a non-fatal error', async () => {
    const { session, socket, events } = await openSession();
    socket.push({
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'e',
      item_id: 'item_u1',
      content_index: 0,
      error: { type: 'transcription_error', code: 'audio_unintelligible', message: 'No speech' },
    });
    await flush();
    const [error] = ofType(events, 'error');
    expect(error).toMatchObject({ fatal: false, error: { kind: 'provider' } });
    expect(error!.error.message).toContain('No speech');
    expect(session.status).toBe('open');
  });
});

describe('OpenAI Realtime — tool calls', () => {
  const doneWithCall = (status: string, args = '{"city":"Paris"}', name = 'get_weather') => ({
    type: 'response.done',
    event_id: 'e_done',
    response: {
      id: 'resp_2',
      status,
      ...(status === 'completed' ? {} : { status_details: { type: status, reason: 'x' } }),
      output: [
        {
          id: 'item_fc',
          type: 'function_call',
          call_id: 'call_1',
          name,
          arguments: args,
          status: 'completed',
        },
      ],
    },
  });

  it('runs a completed function call through the Deuz tool and sends the output back', async () => {
    const execute = vi.fn(async (args: unknown, _ctx: ToolExecuteContext) => ({
      ...(args as object),
      tempC: 21,
    }));
    const { socket, events, sent } = await openSession({
      tools: { get_weather: tool({ parameters: CITY, execute }) },
      runtimeContext: { tenant: 't1' },
    });

    socket.push({
      type: 'response.created',
      event_id: 'e',
      response: { id: 'resp_2', status: 'in_progress' },
    });
    socket.push(doneWithCall('completed'));
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ city: 'Paris' });
    expect(execute.mock.calls[0]![1]).toMatchObject({
      toolCallId: 'call_1',
      messages: [],
      runtimeContext: { tenant: 't1' },
    });
    expect(sent()).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"city":"Paris","tempC":21}',
        },
      },
      { type: 'response.create', event_id: expect.any(String) },
    ]);
    expect(ofType(events, 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        args: { city: 'Paris' },
        responseId: 'resp_2',
      },
    ]);
    expect(ofType(events, 'tool-result')).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        result: { city: 'Paris', tempC: 21 },
      },
    ]);
  });

  it.each(['cancelled', 'incomplete', 'failed'])(
    'never dispatches a function call from a %s response (finish-reason gate)',
    async (status) => {
      const execute = vi.fn(() => 'should not run');
      const { socket, events, sent } = await openSession({
        tools: { get_weather: tool({ parameters: CITY, execute }) },
      });
      socket.push(doneWithCall(status, '{"city":"Par'));
      await flush();
      expect(execute).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
      expect(ofType(events, 'tool-call-cancelled')).toEqual([
        { type: 'tool-call-cancelled', toolCallIds: ['call_1'], reason: 'response-not-completed' },
      ]);
    },
  );

  it('answers an unknown tool, unparsable arguments and schema failures with error outputs', async () => {
    const execute = vi.fn(() => 'never');
    const { socket, events, sent } = await openSession({
      tools: { lookup: tool({ parameters: z.object({ id: z.string() }), execute }) },
    });

    socket.push(doneWithCall('completed', '{}', 'nope'));
    await flush();
    socket.push(doneWithCall('completed', '{not json', 'lookup'));
    await flush();
    socket.push(doneWithCall('completed', '{"id":5}', 'lookup'));
    await flush();

    expect(execute).not.toHaveBeenCalled();
    const outputs = sent()
      .filter((message) => message.type === 'conversation.item.create')
      .map((message) => (message.item as { output: string }).output);
    expect(outputs[0]).toBe('No such tool: "nope". Available tools: lookup.');
    expect(outputs[1]).toMatch(/^Invalid arguments: /);
    expect(outputs[2]).toMatch(/^Invalid arguments: /);
    expect(ofType(events, 'tool-result').every((event) => event.isError === true)).toBe(true);
    // The model still gets a turn after each answered call.
    expect(sent().filter((message) => message.type === 'response.create')).toHaveLength(3);
  });

  it('feeds a thrown tool error back to the model instead of failing the session', async () => {
    const { socket, session, sent } = await openSession({
      tools: {
        get_weather: tool({
          parameters: CITY,
          execute: () => {
            throw new Error('Weather service down');
          },
        }),
      },
    });
    socket.push(doneWithCall('completed'));
    await flush();
    expect(sent()[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: 'Weather service down' },
    });
    expect(session.status).toBe('open');
  });

  it('gates needsApproval tools behind approveToolCall, denying when none is configured', async () => {
    const execute = vi.fn(() => 'done');
    const denied = await openSession({
      tools: { get_weather: tool({ parameters: CITY, needsApproval: true, execute }) },
    });
    denied.socket.push(doneWithCall('completed'));
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect((denied.sent()[0]!.item as { output: string }).output).toMatch(/^Tool call denied\./);

    const approveToolCall = vi.fn(async () => true);
    const approved = await openSession({
      tools: { get_weather: tool({ parameters: CITY, needsApproval: true, execute }) },
      approveToolCall,
    });
    approved.socket.push(doneWithCall('completed'));
    await flush();
    expect(approveToolCall).toHaveBeenCalledWith({
      toolCallId: 'call_1',
      toolName: 'get_weather',
      args: { city: 'Paris' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('waits for the app to answer a client tool (no execute) via sendToolResult', async () => {
    const { session, socket, events, sent } = await openSession({
      tools: { get_weather: tool({ parameters: CITY }) },
    });
    socket.push(doneWithCall('completed'));
    await flush();
    expect(ofType(events, 'tool-call')).toHaveLength(1);
    expect(sent()).toEqual([]);

    session.sendToolResult('call_1', { tempC: 19 });
    expect(sent()).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'call_1', output: '{"tempC":19}' },
      },
      { type: 'response.create', event_id: expect.any(String) },
    ]);
    expect(() => session.sendToolResult('call_1', 'again')).toThrow(RealtimeError);
  });

  it('holds response.create until a response that is still running finishes', async () => {
    const { session, socket, sent } = await openSession({
      tools: { get_weather: tool({ parameters: CITY }) },
    });
    socket.push(doneWithCall('completed'));
    // The user spoke again: a new response is in progress before the result is ready.
    socket.push({
      type: 'response.created',
      event_id: 'e',
      response: { id: 'resp_3', status: 'in_progress' },
    });
    await flush();
    session.sendToolResult('call_1', 'sunny');
    expect(sent().map((message) => message.type)).toEqual(['conversation.item.create']);

    socket.push({
      type: 'response.done',
      event_id: 'e',
      response: { id: 'resp_3', status: 'completed', output: [] },
    });
    await flush();
    expect(sent().map((message) => message.type)).toEqual([
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('arms no tool timer for timeoutMs Infinity', async () => {
    const { clock, pending } = manualClock();
    let finish: (value: string) => void = () => {};
    const { socket, sent } = await openSession({
      tools: {
        get_weather: tool({
          parameters: CITY,
          timeoutMs: Number.POSITIVE_INFINITY,
          execute: () => new Promise<string>((resolve) => (finish = resolve)),
        }),
      },
      deps: { clock },
    });
    socket.push(doneWithCall('completed'));
    await flush();
    expect(pending()).toBe(0);
    finish('sunny');
    await flush();
    expect((sent()[0]!.item as { output: string }).output).toBe('sunny');
  });

  it('abandons a tool that outlives its timeoutMs on the injected clock', async () => {
    const { clock, advance } = manualClock();
    const { socket, sent } = await openSession({
      tools: {
        get_weather: tool({
          parameters: CITY,
          timeoutMs: 50,
          execute: () => new Promise(() => {}),
        }),
      },
      deps: { clock },
    });
    socket.push(doneWithCall('completed'));
    await flush();
    expect(sent()).toEqual([]);
    await advance(50);
    expect((sent()[0]!.item as { output: string }).output).toBe(
      "Tool 'get_weather' timed out after 50ms and was abandoned.",
    );
  });
});

describe('OpenAI Realtime — one response at a time', () => {
  // Only one response can write to the default conversation at a time; a
  // response.create the server has not acknowledged yet already counts.
  const creates = (sent: Record<string, unknown>[]) =>
    sent.filter((message) => message.type === 'response.create');

  it('holds a second response.create until the first response is done', async () => {
    const { session, socket, sent } = await openSession();
    session.sendText('a');
    session.sendText('b');
    expect(sent().map((message) => message.type)).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
    ]);

    socket.push({ type: 'response.created', event_id: 'e1', response: { id: 'resp_1' } });
    await flush();
    expect(creates(sent())).toHaveLength(1);

    socket.push({
      type: 'response.done',
      event_id: 'e2',
      response: { id: 'resp_1', status: 'completed', output: [] },
    });
    await flush();
    expect(sent().map((message) => message.type)).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('holds the tool results response.create while a text turn create is unacknowledged', async () => {
    let finish: (value: string) => void = () => {};
    const { session, socket, sent } = await openSession({
      tools: {
        get_weather: tool({
          parameters: CITY,
          execute: () => new Promise<string>((resolve) => (finish = resolve)),
        }),
      },
    });
    socket.push({
      type: 'response.done',
      event_id: 'e0',
      response: {
        id: 'resp_0',
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        ],
      },
    });
    await flush();
    session.sendText('Also, what time is it?'); // its response.created is still on its way
    finish('sunny');
    await flush();
    expect(sent().map((message) => message.type)).toEqual([
      'conversation.item.create',
      'response.create',
      'conversation.item.create', // the function_call_output; its response.create waits
    ]);

    socket.push({ type: 'response.created', event_id: 'e1', response: { id: 'resp_1' } });
    socket.push({
      type: 'response.done',
      event_id: 'e2',
      response: { id: 'resp_1', status: 'completed', output: [] },
    });
    await flush();
    expect(creates(sent())).toHaveLength(2);
  });

  it('asks again after the running response when the server refused a create for it', async () => {
    const { session, socket, events, sent } = await openSession();
    session.sendText('a');
    const [create] = creates(sent());
    expect(create).toEqual({ type: 'response.create', event_id: expect.any(String) });

    // Server VAD started a response first; the create lost the race.
    socket.push({ type: 'response.created', event_id: 'e1', response: { id: 'resp_vad' } });
    socket.push({
      type: 'error',
      event_id: 'e2',
      error: {
        type: 'invalid_request_error',
        code: 'conversation_already_has_active_response',
        message: 'Conversation already has an active response in progress: resp_vad.',
        event_id: create!.event_id,
      },
    });
    await flush();
    expect(ofType(events, 'error')[0]).toMatchObject({
      fatal: false,
      error: { kind: 'provider', upstreamType: 'conversation_already_has_active_response' },
    });
    expect(creates(sent())).toHaveLength(1);

    socket.push({
      type: 'response.done',
      event_id: 'e3',
      response: { id: 'resp_vad', status: 'completed', output: [] },
    });
    await flush();
    expect(creates(sent())).toHaveLength(2);
  });

  it('sends a held response.create at once when the one in flight fails for another reason', async () => {
    const { session, socket, sent } = await openSession();
    session.sendText('a');
    session.sendText('b');
    const [create] = creates(sent());
    // An error about another event leaves the create in flight.
    socket.push({
      type: 'error',
      event_id: 'e1',
      error: { type: 'invalid_request_error', code: 'unknown_parameter', message: 'Bad event' },
    });
    await flush();
    expect(creates(sent())).toHaveLength(1);

    socket.push({
      type: 'error',
      event_id: 'e2',
      error: {
        type: 'server_error',
        message: 'The server had an error.',
        event_id: create!.event_id,
      },
    });
    await flush();
    expect(creates(sent())).toHaveLength(2);
  });
});

describe('OpenAI Realtime — interruption, errors and close', () => {
  it('reports barge-in once: speech during a response interrupts it', async () => {
    const { socket, events } = await openSession();
    socket.push({
      type: 'response.created',
      event_id: 'e',
      response: { id: 'resp_4', status: 'in_progress' },
    });
    socket.push({
      type: 'input_audio_buffer.speech_started',
      event_id: 'e',
      audio_start_ms: 1500,
      item_id: 'item_u2',
    });
    socket.push({
      type: 'response.done',
      event_id: 'e',
      response: {
        id: 'resp_4',
        status: 'cancelled',
        status_details: { type: 'cancelled', reason: 'turn_detected' },
        output: [],
      },
    });
    socket.push({
      type: 'input_audio_buffer.speech_stopped',
      event_id: 'e',
      audio_end_ms: 2400,
      item_id: 'item_u2',
    });
    await flush();
    expect(events.slice(1)).toEqual([
      { type: 'response-started', responseId: 'resp_4' },
      { type: 'speech-started', itemId: 'item_u2', audioStartMs: 1500 },
      { type: 'interrupted', responseId: 'resp_4' },
      { type: 'response-done', responseId: 'resp_4', status: 'cancelled', reason: 'turn_detected' },
      { type: 'speech-stopped', itemId: 'item_u2', audioEndMs: 2400 },
    ]);
  });

  it('interrupt() cancels the running response and truncates the audio the user heard', async () => {
    const { session, socket, sent } = await openSession();
    socket.push({
      type: 'response.created',
      event_id: 'e',
      response: { id: 'resp_5', status: 'in_progress' },
    });
    socket.push({
      type: 'response.output_audio.delta',
      event_id: 'e',
      response_id: 'resp_5',
      item_id: 'item_a5',
      output_index: 0,
      content_index: 0,
      delta: 'AAA=',
    });
    await flush();
    session.interrupt({ playedMs: 800 });
    expect(sent()).toEqual([
      { type: 'response.cancel' },
      {
        type: 'conversation.item.truncate',
        item_id: 'item_a5',
        content_index: 0,
        audio_end_ms: 800,
      },
    ]);
  });

  it('keeps the session open on a recoverable server error', async () => {
    const { session, socket, events } = await openSession();
    socket.push({
      type: 'error',
      event_id: 'e',
      error: { type: 'invalid_request_error', code: 'unknown_parameter', message: 'Bad event' },
    });
    await flush();
    const [error] = ofType(events, 'error');
    expect(error).toMatchObject({
      fatal: false,
      error: { kind: 'provider', upstreamType: 'unknown_parameter', message: 'Bad event' },
    });
    expect(session.status).toBe('open');
  });

  it('closes cleanly from the client and refuses to send afterwards', async () => {
    const { session, socket, events } = await openSession();
    const iterated: RealtimeEvent['type'][] = [];
    const drained = (async () => {
      for await (const event of session.events()) iterated.push(event.type);
    })();

    await session.close();
    await drained;
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'client closed' }]);
    expect(session.status).toBe('closed');
    expect(ofType(events, 'session-closed')).toEqual([
      { type: 'session-closed', code: 1000, reason: 'client closed', initiator: 'client' },
    ]);
    expect(iterated).toEqual(['session-closed']);
    expect(() => session.appendAudio(new Uint8Array(2))).toThrow(RealtimeError);
    await session.close(); // idempotent
  });

  it('turns an abnormal server close into a fatal error, then session-closed', async () => {
    const { session, socket, events } = await openSession();
    socket.drop(1011, 'internal error');
    await flush();
    expect(events.slice(1)).toEqual([
      {
        type: 'error',
        fatal: true,
        error: expect.objectContaining({ kind: 'closed', closeCode: 1011 }),
      },
      { type: 'session-closed', code: 1011, reason: 'internal error', initiator: 'server' },
    ]);
    expect(session.status).toBe('closed');
  });

  it('reports a transport failure before the socket goes down', async () => {
    const { socket, events } = await openSession();
    socket.fail();
    socket.drop(1006);
    await flush();
    expect(ofType(events, 'error')[0]).toMatchObject({ fatal: true, error: { kind: 'transport' } });
    expect(ofType(events, 'session-closed')).toEqual([
      { type: 'session-closed', code: 1006, reason: '', initiator: 'server' },
    ]);
  });
});

describe('OpenAI Realtime — usage and pricing', () => {
  const usageFrame = (id: string) => ({
    type: 'response.done',
    event_id: 'e',
    response: {
      id,
      status: 'completed',
      output: [],
      usage: {
        total_tokens: 1500,
        input_tokens: 1000,
        output_tokens: 500,
        input_token_details: {
          text_tokens: 200,
          audio_tokens: 800,
          image_tokens: 0,
          cached_tokens: 100,
          cached_tokens_details: { text_tokens: 100, audio_tokens: 0, image_tokens: 0 },
        },
        output_token_details: { text_tokens: 100, audio_tokens: 400 },
      },
    },
  });

  it('splits usage by modality and prices text and audio at their own rates', async () => {
    const onUsage = vi.fn();
    const priceProvider = createPriceProvider({
      table: realtimePriceTable({
        'gpt-realtime': {
          text: { input: 4, output: 16, cachedRead: 0.4 },
          audio: { input: 32, output: 64, cachedRead: 0.4 },
        },
      }),
    });
    const { session, socket, events } = await openSession({ deps: { priceProvider, onUsage } });

    socket.push(usageFrame('resp_a'));
    socket.push(usageFrame('resp_b'));
    await flush();

    const usage = ofType(events, 'usage');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual({
      type: 'usage',
      responseId: 'resp_a',
      tokens: {
        text: { input: 100, cachedInput: 100, output: 100 },
        audio: { input: 800, cachedInput: 0, output: 400 },
        image: { input: 0, cachedInput: 0, output: 0 },
      },
      usage: {
        inputTokens: 900,
        outputTokens: 500,
        reasoningTokens: 0,
        cachedReadTokens: 100,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        audioTokens: 1200,
        totalTokens: 1500,
      },
      // 100×4 + 100×0.4 + 100×16 (text) + 800×32 + 400×64 (audio), per 1M tokens.
      costUsd: 0.05324,
    });
    // `usage` is reported before the turn ends.
    expect(events.findIndex((event) => event.type === 'usage')).toBeLessThan(
      events.findIndex((event) => event.type === 'response-done'),
    );
    expect(session.usage.costUsd).toBeCloseTo(0.10648, 10);
    expect(session.usage.usage).toMatchObject({ inputTokens: 1800, outputTokens: 1000 });
    expect(session.usage.tokens.audio).toEqual({ input: 1600, cachedInput: 0, output: 800 });
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls[0]![1]).toEqual({ model: 'gpt-realtime', reason: 'finished' });
    expect(ofType(events, 'warning')).toEqual([]);
  });

  it('warns once per model and keeps going when the model has no price', async () => {
    const { session, socket, events } = await openSession({
      deps: { priceProvider: createPriceProvider() },
    });
    socket.push(usageFrame('resp_a'));
    socket.push(usageFrame('resp_b'));
    await flush();

    const warnings = ofType(events, 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning).toMatchObject({ type: 'unpriced-model' });
    expect(warnings[0]!.warning.message).toContain('gpt-realtime');
    expect(ofType(events, 'usage').map((event) => event.costUsd)).toEqual([undefined, undefined]);
    expect(session.usage.costUsd).toBeUndefined();
    expect(session.usage.usage.totalTokens).toBe(3000);
    expect(session.status).toBe('open');
  });

  it('awaits an async price provider without reordering events', async () => {
    const priceProvider = {
      priceUsage: async (model: string) => (model.startsWith('audio:') ? 0.5 : 0.25),
    };
    const { socket, events } = await openSession({ deps: { priceProvider } });
    socket.push(usageFrame('resp_a'));
    await flush();
    const types = events.map((event) => event.type);
    expect(types.slice(-2)).toEqual(['usage', 'response-done']);
    expect(ofType(events, 'usage')[0]!.costUsd).toBe(0.75);
  });
});

describe('OpenAI Realtime — configuration and edge cases', () => {
  it('maps server turn detection and default transcription, and warns about what the wire cannot carry', async () => {
    const { socket, events } = await openSession({
      turnDetection: 'server',
      inputTranscription: true,
      inputSampleRate: 16_000,
      outputTranscription: false,
    });
    const update = socket.messages[0] as { session: { audio: { input: unknown } } };
    expect(update.session.audio.input).toEqual({
      transcription: { model: 'gpt-4o-mini-transcribe' },
      turn_detection: { type: 'server_vad' },
    });
    expect(
      ofType(events, 'warning').map((event) => [event.warning.type, event.warning.setting]),
    ).toEqual([
      ['unsupported-setting', 'inputSampleRate'],
      ['unsupported-setting', 'outputTranscription'],
    ]);
  });

  it('forces a named tool, and sends no tool_choice without tools', async () => {
    const forced = await openSession({
      tools: { get_weather: tool({ parameters: CITY }) },
      toolChoice: { type: 'tool', toolName: 'get_weather' },
    });
    expect(
      (forced.socket.messages[0] as { session: Record<string, unknown> }).session,
    ).toMatchObject({
      tool_choice: { type: 'function', name: 'get_weather' },
    });

    const none = await openSession({ toolChoice: 'required' });
    expect(
      (none.socket.messages[0] as { session: Record<string, unknown> }).session,
    ).not.toHaveProperty('tool_choice');
  });

  it('reports G.711 audio when providerOptions picks it', () => {
    const session = createRealtimeSession({
      model: createOpenAIRealtime({ apiKey: 'sk' })('gpt-realtime'),
      providerOptions: {
        audio: {
          input: { format: { type: 'audio/pcmu' } },
          output: { format: { type: 'audio/pcma' } },
        },
      },
    });
    expect(session.audioFormat).toEqual({
      input: { encoding: 'g711-ulaw', sampleRate: 8000, mimeType: 'audio/pcmu' },
      output: { encoding: 'g711-alaw', sampleRate: 8000, mimeType: 'audio/pcma' },
    });
  });

  it('does not report barge-in when turn detection is told not to interrupt', async () => {
    const { socket, events } = await openSession({
      providerOptions: {
        audio: { input: { turn_detection: { type: 'server_vad', interrupt_response: false } } },
      },
    });
    socket.push({ type: 'response.created', event_id: 'e', response: { id: 'resp_9' } });
    socket.push({ type: 'input_audio_buffer.speech_started', event_id: 'e', item_id: 'item_u9' });
    await flush();
    expect(ofType(events, 'speech-started')).toHaveLength(1);
    expect(ofType(events, 'interrupted')).toEqual([]);
  });

  it('truncates the last heard audio once, and sends nothing when there is nothing to stop', async () => {
    const { session, socket, sent } = await openSession();
    session.interrupt({ playedMs: 100 });
    expect(sent()).toEqual([]);

    socket.push({ type: 'response.created', event_id: 'e', response: { id: 'resp_6' } });
    socket.push({
      type: 'response.output_audio.delta',
      event_id: 'e',
      response_id: 'resp_6',
      item_id: 'item_a6',
      output_index: 0,
      content_index: 0,
      delta: 'AAA=',
    });
    socket.push({
      type: 'response.done',
      event_id: 'e',
      response: { id: 'resp_6', status: 'completed', output: [] },
    });
    await flush();
    // The response is over but its audio may still be playing: truncate only.
    session.interrupt({ playedMs: 250.7 });
    session.interrupt({ playedMs: 300 });
    expect(sent()).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item_a6',
        content_index: 0,
        audio_end_ms: 250,
      },
    ]);
  });

  it('treats a response.done without a final status as not completed', async () => {
    const execute = vi.fn(() => 'never');
    const { socket, events } = await openSession({
      tools: { get_weather: tool({ parameters: CITY, execute }) },
    });
    socket.push({
      type: 'response.done',
      event_id: 'e',
      response: {
        id: 'resp_7',
        output: [
          { type: 'function_call', call_id: 'call_7', name: 'get_weather', arguments: '{}' },
        ],
      },
    });
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(ofType(events, 'response-done')).toEqual([
      { type: 'response-done', responseId: 'resp_7', status: 'incomplete' },
    ]);
  });

  it('attributes tokens reported without a modality breakdown to text', async () => {
    const { socket, events } = await openSession();
    socket.push({
      type: 'response.done',
      event_id: 'e',
      response: {
        id: 'resp_8',
        status: 'completed',
        output: [],
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
      },
    });
    await flush();
    const [usage] = ofType(events, 'usage');
    expect(usage!.tokens).toEqual({
      text: { input: 50, cachedInput: 0, output: 20 },
      audio: { input: 0, cachedInput: 0, output: 0 },
      image: { input: 0, cachedInput: 0, output: 0 },
    });
    expect(usage!.usage).not.toHaveProperty('audioTokens');
  });

  it('counts a throwing price provider as unpriced instead of failing the session', async () => {
    const priceProvider = {
      priceUsage: () => {
        throw new Error('price table unavailable');
      },
    };
    const { session, socket, events } = await openSession({ deps: { priceProvider } });
    socket.push({
      type: 'response.done',
      event_id: 'e',
      response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 5 } },
    });
    await flush();
    expect(ofType(events, 'warning')[0]!.warning.type).toBe('unpriced-model');
    expect(ofType(events, 'usage')[0]!.costUsd).toBeUndefined();
    expect(session.status).toBe('open');
  });
});
