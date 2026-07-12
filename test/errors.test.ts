import { describe, expect, it } from 'vitest';
import { AuthenticationError, DeuzError, NetworkError, isDeuzError } from '../src/errors';
import { streamChat } from '../src/index';
import { createOpenAIResponses } from '../src/openai';

describe('standard error contract', () => {
  it('serializes only stable, secret-safe fields', () => {
    const secret = 'sk-never-serialize-this';
    const error = new AuthenticationError({
      message: 'Authentication failed.',
      provider: 'openai',
      requestId: 'req_123',
      cause: new Error(secret),
    });

    expect(error).toBeInstanceOf(DeuzError);
    expect(isDeuzError(error)).toBe(true);
    expect(error.toJSON()).toEqual({
      name: 'AuthenticationError',
      code: 'authentication',
      message: 'Authentication failed.',
      details: {
        statusCode: 401,
        isRetryable: false,
        provider: 'openai',
        requestId: 'req_123',
      },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('normalizes an exhausted transport failure without leaking the thrown value', async () => {
    const secret = 'sk-transport-secret';
    const fetch = (async () => {
      throw new TypeError(`connect failed with ${secret}`);
    }) as typeof globalThis.fetch;
    const result = streamChat({
      model: createOpenAIResponses({ apiKey: 'test-key', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hello' }],
      maxRetries: 0,
    });
    const usage = result.usage.catch((error: unknown) => error);
    const finish = result.finishReason.catch((error: unknown) => error);
    const errors = [];
    for await (const part of result.fullStream) {
      if (part.type === 'error') errors.push(part.error);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NetworkError);
    expect(errors[0]).toMatchObject({
      code: 'network_error',
      provider: 'openai',
      statusCode: 0,
      isRetryable: true,
      upstreamType: 'TypeError',
    });
    expect(JSON.stringify(errors[0])).not.toContain(secret);
    expect(await usage).toBe(errors[0]);
    expect(await finish).toBe(errors[0]);
  });
});
