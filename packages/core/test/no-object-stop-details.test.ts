/**
 * no-object-stop-details.test.ts (2.3, A2H hand-off) — a structured request the
 * model refused or cut off fails with NoObjectGeneratedError; the error now says
 * how the last attempt ended. Anthropic sends `stop_details` only with
 * `stop_reason: 'refusal'` (Claude API reference, cached 2026-10-06). Not
 * live-verified.
 */
import { describe, expect, it } from 'vitest';
import { generateObject, streamObject, NoObjectGeneratedError } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';

const REFUSAL = { type: 'refusal', category: 'cyber', explanation: 'declined' };
const OBJ = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;
const messages = [{ role: 'user' as const, content: 'hi' }];

function turn(text: string, stopReason: string, details?: unknown): string {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, ...(details ? { stop_details: details } : {}) },
        usage: { output_tokens: 3 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function claude(...turns: string[]) {
  const sequence = mockFetchSequence(turns.map((t) => () => sseResponse([t])));
  return createAnthropic({ apiKey: 'k', fetch: sequence.fetch })('claude-opus-5-5');
}

describe('NoObjectGeneratedError carries the last attempt’s stop', () => {
  it('generateObject: a refusal names its finish reason and stop details', async () => {
    const refused = turn('I can’t help with that.', 'refusal', REFUSAL);
    const error = await generateObject({
      model: claude(refused, refused),
      messages,
      schema: OBJ,
      mode: 'json',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoObjectGeneratedError);
    expect(error).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL });
  });

  it('generateObject: a cut-off object names finish reason length, without details', async () => {
    const cut = turn('{"answer": "par', 'max_tokens');
    const error = (await generateObject({
      model: claude(cut, cut),
      messages,
      schema: OBJ,
      mode: 'json',
    }).catch((e: unknown) => e)) as NoObjectGeneratedError;
    expect(error.finishReason).toBe('length');
    expect(error.stopDetails).toBeUndefined();
  });

  it('streamObject: the rejected object promise carries the same fields', async () => {
    const result = streamObject({
      model: claude(turn('I can’t help with that.', 'refusal', REFUSAL)),
      messages,
      schema: OBJ,
      mode: 'json',
    });
    const error = await result.object.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoObjectGeneratedError);
    expect(error).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL });
  });
});
