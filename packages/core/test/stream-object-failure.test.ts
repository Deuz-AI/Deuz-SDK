/**
 * stream-object-failure.test.ts (2.3) — `streamObject`'s promises settle on a
 * failed call.
 *
 * `StreamObjectResult.warnings` is declared to never reject. On a transport
 * failure the pump rejected `object` / `usage` / `finishReason` but never
 * settled `warnings`, so `await result.warnings` hung forever — and with it the
 * notices collected before the request (a dropped `temperature`, an unknown
 * model) that explain the failure.
 */
import { describe, expect, it } from 'vitest';
import { streamObject } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { mockFetch } from './fixtures/sse';

const OBJ = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };

/** Settled or still pending once every queued task ran. */
async function state(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(resolve, 0, 'pending')),
  ]);
}

describe('streamObject on a failed call', () => {
  it('resolves warnings with what was collected before the failure', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
          { status: 400 },
        ),
    );
    const result = streamObject({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
      messages: [{ role: 'user', content: 'hi' }],
      schema: OBJ,
      mode: 'json',
      maxRetries: 0,
      // Claude Opus 5.5 takes no sampling parameters: one warning before the request.
      temperature: 0.2,
    });
    await expect(result.object).rejects.toThrow('bad');
    await result.consume?.();
    expect(await state(result.warnings!)).toBe('settled');
    expect(await result.warnings).toEqual([
      expect.objectContaining({ type: 'unsupported-setting', setting: 'temperature' }),
    ]);
  });
});
