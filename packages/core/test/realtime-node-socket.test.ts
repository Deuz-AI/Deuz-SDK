/**
 * Realtime sessions over the runtime's REAL global WebSocket (undici in
 * Node >= 22) against a local RFC 6455 listener — no fake socket. This proves
 * what the scripted fake cannot: the default socket factory, handshake headers
 * and subprotocols as they reach a server, real DOM event objects, Gemini's
 * JSON in binary frames and both closing handshakes. Still offline: the
 * listener is on 127.0.0.1 and scripts the provider's side of the wire.
 */
import { describe, it, expect } from 'vitest';
import {
  createRealtimeSession,
  createOpenAIRealtime,
  createGeminiLive,
  type RealtimeEvent,
} from '../src/realtime';
import { startLocalWsServer, type WsConnection } from './fixtures/realtime-ws-server';

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ofType = <T extends RealtimeEvent['type']>(events: RealtimeEvent[], type: T) =>
  events.filter((event): event is Extract<RealtimeEvent, { type: T }> => event.type === type);

/** The OpenAI side of the handshake, plus one scripted answer to `response.create`. */
function openaiServer(connection: WsConnection): void {
  connection.sendText({ type: 'session.created', event_id: 'e0', session: { id: 'sess_local' } });
  connection.onMessage = (message) => {
    if (message.type === 'session.update') {
      connection.sendText({
        type: 'session.updated',
        event_id: 'e1',
        session: { id: 'sess_local' },
      });
    }
    if (message.type === 'response.create') {
      connection.sendText({ type: 'response.created', event_id: 'e2', response: { id: 'resp_1' } });
      connection.sendText({
        type: 'response.output_audio.delta',
        event_id: 'e3',
        response_id: 'resp_1',
        item_id: 'item_1',
        output_index: 0,
        content_index: 0,
        delta: 'AQID',
      });
      connection.sendText({
        type: 'response.done',
        event_id: 'e4',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 12,
            output_tokens: 30,
            input_token_details: { text_tokens: 12 },
            output_token_details: { audio_tokens: 30 },
          },
        },
      });
    }
  };
}

describe.skipIf(typeof WebSocket === 'undefined')('realtime over a real WebSocket', () => {
  it('OpenAI: Bearer header, JSON frames both ways and a client close handshake', async () => {
    const server = await startLocalWsServer(openaiServer);
    try {
      const session = createRealtimeSession({
        model: createOpenAIRealtime({ apiKey: 'sk-local', baseURL: `${server.origin}/v1` })(
          'gpt-realtime',
        ),
        instructions: 'Be brief.',
      });
      const events: RealtimeEvent[] = [];
      session.on('*', (event) => events.push(event));
      await session.connect();

      const [connection] = server.connections;
      expect(connection!.url).toBe('/v1/realtime?model=gpt-realtime');
      expect(connection!.headers.authorization).toBe('Bearer sk-local');
      expect(connection!.headers['sec-websocket-protocol']).toBeUndefined();
      expect(connection!.received[0]).toMatchObject({
        type: 'session.update',
        session: { type: 'realtime', instructions: 'Be brief.' },
      });
      expect(session.sessionId).toBe('sess_local');

      session.sendText('Merhaba');
      await waitFor(() => ofType(events, 'response-done').length > 0);
      expect(connection!.received.slice(1).map((message) => message.type)).toEqual([
        'conversation.item.create',
        'response.create',
      ]);
      expect(ofType(events, 'audio-delta')[0]!.audio).toEqual(new Uint8Array([1, 2, 3]));
      expect(ofType(events, 'usage')[0]!.tokens.audio.output).toBe(30);

      await session.close();
      // Code and reason are what the server echoed in its close frame.
      expect(events.at(-1)).toEqual({
        type: 'session-closed',
        code: 1000,
        reason: 'client closed',
        initiator: 'client',
      });
      await connection!.ended;
    } finally {
      await server.stop();
    }
  });

  it('OpenAI: an ephemeral secret travels in the subprotocol list, never in a header', async () => {
    const server = await startLocalWsServer(openaiServer);
    try {
      const session = createRealtimeSession({
        model: createOpenAIRealtime({ baseURL: `${server.origin}/v1` })('gpt-realtime'),
        ephemeralToken: async () => 'ek_local',
      });
      await session.connect();
      const [connection] = server.connections;
      expect(connection!.headers['sec-websocket-protocol']).toBe(
        'realtime, openai-insecure-api-key.ek_local',
      );
      expect(connection!.headers.authorization).toBeUndefined();
      await session.close();
    } finally {
      await server.stop();
    }
  });

  it('Gemini: x-goog-api-key header and JSON delivered in binary frames', async () => {
    const server = await startLocalWsServer((connection) => {
      connection.onMessage = (message) => {
        if ('setup' in message)
          connection.sendBinary({ setupComplete: { sessionId: 'live-local' } });
        const input = message.realtimeInput as Record<string, unknown> | undefined;
        if (input?.audio) {
          connection.sendBinary({
            serverContent: {
              modelTurn: {
                parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BAUG' } }],
              },
            },
          });
          connection.sendBinary({
            serverContent: { turnComplete: true },
            usageMetadata: { promptTokenCount: 8, responseTokenCount: 4, totalTokenCount: 12 },
          });
        }
      };
    });
    try {
      const session = createRealtimeSession({
        model: createGeminiLive({ apiKey: 'g-local', baseURL: server.origin })(
          'gemini-live-2.5-flash-preview',
        ),
      });
      const events: RealtimeEvent[] = [];
      session.on('*', (event) => events.push(event));
      await session.connect();

      const [connection] = server.connections;
      expect(connection!.url).toBe(
        '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      );
      expect(connection!.headers['x-goog-api-key']).toBe('g-local');
      expect(session.sessionId).toBe('live-local');

      session.appendAudio(new Uint8Array([1, 2]));
      await waitFor(() => ofType(events, 'response-done').length > 0);
      expect(ofType(events, 'audio-delta')[0]!.audio).toEqual(new Uint8Array([4, 5, 6]));
      expect(ofType(events, 'usage')[0]!.usage.totalTokens).toBe(12);
      await session.close();
    } finally {
      await server.stop();
    }
  });

  it('reports a server close with an error code as fatal, then session-closed', async () => {
    const server = await startLocalWsServer(openaiServer);
    try {
      const session = createRealtimeSession({
        model: createOpenAIRealtime({ apiKey: 'sk-local', baseURL: `${server.origin}/v1` })(
          'gpt-realtime',
        ),
      });
      const events: RealtimeEvent[] = [];
      session.on('*', (event) => events.push(event));
      await session.connect();

      server.connections[0]!.close(1011, 'internal error');
      await waitFor(() => session.status === 'closed');
      expect(events.slice(1)).toEqual([
        {
          type: 'error',
          fatal: true,
          error: expect.objectContaining({ kind: 'closed', closeCode: 1011 }),
        },
        { type: 'session-closed', code: 1011, reason: 'internal error', initiator: 'server' },
      ]);
    } finally {
      await server.stop();
    }
  });
});
