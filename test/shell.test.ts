import { describe, it, expect } from 'vitest';
import {
  createClient,
  streamChat,
  generateText,
  DeuzError,
  NotImplementedError,
} from '../src/index';
import { anthropic, createAnthropic } from '../src/anthropic';

describe('@deuz/core shell (Faz 0)', () => {
  it('provider factory returns a LanguageModel descriptor', () => {
    const model = anthropic('claude-opus-4-8');
    expect(model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      surface: 'anthropic',
    });
  });

  it('createAnthropic with settings still returns a descriptor', () => {
    const provider = createAnthropic({ apiKey: 'sk-test' });
    expect(provider('claude-haiku-4-5').provider).toBe('anthropic');
  });

  it('free functions throw NotImplementedError (a DeuzError)', () => {
    expect(() => streamChat({ model: anthropic('x'), messages: [] })).toThrow(NotImplementedError);

    let err: unknown;
    try {
      void generateText({ model: anthropic('x'), messages: [] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeuzError);
    expect((err as DeuzError).code).toBe('not_implemented');
  });

  it('createClient pre-binds deps without touching globals', () => {
    let fetchCalls = 0;
    const client = createClient({
      deps: {
        clock: {
          now: () => 42,
          setTimeout: (fn) => {
            void fn;
            return () => {};
          },
        },
        fetch: async () => {
          fetchCalls++;
          return new Response();
        },
      },
    });

    expect(typeof client.streamChat).toBe('function');
    expect(client.config).toBeDefined();
    expect(() => client.streamChat({ model: anthropic('x'), messages: [] })).toThrow(
      NotImplementedError,
    );
    // Binding must not perform any I/O.
    expect(fetchCalls).toBe(0);
  });
});
