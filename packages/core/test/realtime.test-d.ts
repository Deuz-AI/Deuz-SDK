import { expectTypeOf, test } from 'vitest';
import {
  createRealtimeSession,
  createOpenAIRealtime,
  createGeminiLive,
  type RealtimeEvent,
  type RealtimeEventOf,
  type RealtimeSession,
  type RealtimeSessionOptions,
  type RealtimeWebSocket,
  type RealtimeWebSocketFactory,
} from '../src/realtime';
import type { CallWarning } from '../src/types/methods';
import type { Usage } from '../src/types/usage';
import type { LanguageModel } from '../src/types/model';

declare const session: RealtimeSession;
declare const chatModel: LanguageModel;

test('typed listeners narrow the event; the wildcard sees the whole union', () => {
  session.on('audio-delta', (event) => {
    expectTypeOf(event.audio).toEqualTypeOf<Uint8Array>();
    expectTypeOf(event.responseId).toEqualTypeOf<string | undefined>();
  });
  session.on('usage', (event) => {
    expectTypeOf(event.usage).toEqualTypeOf<Usage>();
    expectTypeOf(event.costUsd).toEqualTypeOf<number | undefined>();
    expectTypeOf(event.tokens.audio.cachedInput).toEqualTypeOf<number>();
  });
  session.on('warning', (event) => expectTypeOf(event.warning).toEqualTypeOf<CallWarning>());
  session.on('*', (event) => expectTypeOf(event).toEqualTypeOf<RealtimeEvent>());
  expectTypeOf(session.on('error', () => {})).toEqualTypeOf<() => void>();
  // @ts-expect-error not an event type
  session.on('audio', () => {});
  expectTypeOf<RealtimeEventOf<'session-closed'>['initiator']>().toEqualTypeOf<
    'client' | 'server'
  >();
  expectTypeOf(session.events()).toEqualTypeOf<AsyncIterableIterator<RealtimeEvent>>();
});

test('a session needs a realtime model descriptor, not a chat model', () => {
  expectTypeOf(createRealtimeSession).parameter(0).toEqualTypeOf<RealtimeSessionOptions>();
  createRealtimeSession({ model: createGeminiLive()('gemini-live-2.5-flash-preview') });
  createRealtimeSession({ model: createOpenAIRealtime()('gpt-realtime'), turnDetection: 'manual' });
  // @ts-expect-error `model` is required
  createRealtimeSession({ instructions: 'x' });
  // @ts-expect-error a chat model's surface is not a realtime wire
  createRealtimeSession({ model: chatModel });
});

test('the runtime WebSocket satisfies the socket seam', () => {
  expectTypeOf<WebSocket>().toExtend<RealtimeWebSocket>();
  const factory: RealtimeWebSocketFactory = (url, { protocols }) => new WebSocket(url, protocols);
  void factory;
});
