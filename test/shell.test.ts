import { describe, it, expect } from 'vitest';
import { createClient, streamChat, generateText, DeuzError } from '../src/index';
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

  it('streamChat returns synchronously (errors surface via the stream, not a throw)', async () => {
    // No api key anywhere → must NOT throw synchronously (locked sync return).
    const result = streamChat({
      model: anthropic('x'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(typeof result.fullStream[Symbol.asyncIterator]).toBe('function');
    // generateText is async → it rejects (a DeuzError), it does not throw synchronously.
    await expect(generateText({ model: anthropic('x'), messages: [] })).rejects.toBeInstanceOf(
      DeuzError,
    );
  });

  it('createClient pre-binds deps without touching globals (no I/O on construction)', () => {
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
    // Returns a result object; the pump is lazy, so binding/constructing does no I/O.
    const result = client.streamChat({ model: anthropic('x'), messages: [] });
    expect(result).toBeDefined();
    expect(fetchCalls).toBe(0);
  });
});
