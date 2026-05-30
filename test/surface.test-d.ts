import { expectTypeOf } from 'vitest';
import { streamChat, createClient } from '../src/index';
import type {
  Part,
  Usage,
  FinishReason,
  CommonCallOptions,
  LanguageModel,
  Message,
  StreamChatResult,
} from '../src/index';

// `reasoning` part variant is present and carries `signature` (breaking-if-removed).
expectTypeOf<Extract<Part, { type: 'reasoning' }>>().toHaveProperty('signature');

// `signal` + `maxRetries` + sampling params are locked on the call surface.
expectTypeOf<CommonCallOptions>().toHaveProperty('signal');
expectTypeOf<CommonCallOptions>().toHaveProperty('maxRetries');
expectTypeOf<CommonCallOptions>().toHaveProperty('temperature');
expectTypeOf<CommonCallOptions>().toHaveProperty('effort');

// Usage carries the full cache/reasoning breakdown.
expectTypeOf<Usage>().toHaveProperty('reasoningTokens');
expectTypeOf<Usage>().toHaveProperty('cachedReadTokens');
expectTypeOf<Usage>().toHaveProperty('cacheWrite1hTokens');

// LanguageModel descriptor shape.
expectTypeOf<LanguageModel>().toHaveProperty('surface');
expectTypeOf<Message>().toHaveProperty('role');

// FinishReason union is exact.
expectTypeOf<FinishReason>().toEqualTypeOf<
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'aborted'
>();

// Free-function + client-method shapes.
expectTypeOf(streamChat).toBeFunction();
expectTypeOf(streamChat).returns.toEqualTypeOf<StreamChatResult>();

const client = createClient();
expectTypeOf(client.generateText).returns.resolves.toHaveProperty('text');
