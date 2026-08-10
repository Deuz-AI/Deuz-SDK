/**
 * Google Gemini, against the real API, on BOTH wires.
 *
 * Gemini is the only provider we reach two ways — `generateContent` (the bespoke
 * `native` adapter) and the OpenAI-shaped compatibility endpoint — and the
 * native one carries the quirks the registry exists to record. What only a live
 * call settles:
 *
 *  - the STOP-BUG GUARD is not theoretical. A probe of `gemini-3.6-flash`
 *    returned `finishReason: STOP` in the same response as a `functionCall`,
 *    which is exactly the shape that makes a finishReason-driven loop hang up
 *    mid-task. The loop keys continuation on accumulated tool calls instead.
 *  - thinking tokens are reported in a SEPARATE field (`thoughtsTokenCount`),
 *    not inside `candidatesTokenCount`. The probe measured 155 thinking tokens
 *    against 1 answer token, so a mapping that missed the field would
 *    under-report this call by ~20x and silently break cost and budget stops.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat, generateObject } from '../../src/index';
import { createGoogle, createGoogleNative } from '../../src/google';
import type { JSONSchema } from '../../src/index';
import { key, fingerprint, skipOnQuota } from './env';

const apiKey = key('GOOGLE_API_KEY');
const MODEL = 'gemini-3.6-flash';

const WEATHER: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

describe.skipIf(!apiKey)(`google native — live (${MODEL})`, () => {
  const model = createGoogleNative({ apiKey })(MODEL);

  it('round-trips text and counts thinking tokens separately from the answer', async () => {
    const result = await generateText({ model, prompt: 'Reply with one word: pong' });

    expect(result.text.toLowerCase()).toContain('pong');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    // The assertion that matters: `thoughtsTokenCount` reached `reasoningTokens`,
    // and `totalTokens` is the provider's own total rather than input+output —
    // which for a thinking model is most of the bill.
    expect(result.usage.reasoningTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(
      result.usage.inputTokens + result.usage.outputTokens,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[gemini-native ${fingerprint(apiKey!)}] text=${JSON.stringify(result.text)} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
        `reasoning=${result.usage.reasoningTokens} total=${result.usage.totalTokens}`,
    );
  });

  it('streams, keeping the LAST usage rather than summing per-chunk repeats', async () => {
    const res = streamChat({ model, prompt: 'Count from 1 to 5, digits only.' });

    const chunks: string[] = [];
    for await (const delta of res.textStream) chunks.push(delta);

    expect(chunks.join('')).toMatch(/1/);
    const usage = await res.usage;
    // Gemini repeats usageMetadata on every chunk; summing would multiply the
    // bill by the chunk count. A plausible input count is the evidence it did not.
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.inputTokens).toBeLessThan(200);
    expect(await res.finishReason).toBe('stop');
  });

  it('drives a tool loop even though the provider says STOP mid-call', async () => {
    // The stop-bug guard, live. The probe confirmed this model answers a tool
    // request with `finishReason: STOP` AND a functionCall in the same payload.
    let observed: { city?: unknown } = {};
    const result = await generateText({
      model,
      prompt: 'What is the weather in Istanbul? Use the tool, then answer in one sentence.',
      maxSteps: 4,
      tools: {
        get_weather: {
          description: 'Current weather for a city.',
          parameters: WEATHER,
          execute: (args: unknown) => {
            observed = args as { city?: unknown };
            return { tempC: 31, sky: 'clear' };
          },
        },
      },
    });

    expect(observed.city).toBeTruthy();
    // > 1 step is the whole point: a loop that trusted finishReason would have
    // stopped at one and returned the tool call as the final answer.
    expect(result.steps?.length ?? 0).toBeGreaterThan(1);
    expect(result.text).toMatch(/31|clear/i);
    // eslint-disable-next-line no-console
    console.log(
      `[gemini-native] tool arg=${JSON.stringify(observed)} steps=${result.steps?.length ?? 0}`,
    );
  });

  it('produces structured output through responseSchema', async () => {
    const { object } = await generateObject({
      model,
      prompt: 'Return the capital of Turkey.',
      schema: {
        type: 'object',
        properties: { capital: { type: 'string' } },
        required: ['capital'],
        additionalProperties: false,
      } satisfies JSONSchema,
    });

    expect((object as { capital: string }).capital).toMatch(/ankara/i);
  });
});

describe.skipIf(!apiKey)(`google compat — live (${MODEL})`, () => {
  const model = createGoogle({ apiKey })(MODEL);

  it('round-trips text on the OpenAI-shaped endpoint', async () => {
    const result = await generateText({
      model,
      prompt: 'Reply with one word: pong',
      maxOutputTokens: 512,
    });

    expect(result.text.toLowerCase()).toContain('pong');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[gemini-compat] text=${JSON.stringify(result.text)} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
    );
  });

  it('accumulates streamed tool-call fragments that all arrive at index 0', async (ctx) =>
    // The free tier's quota is tight and this is the last call of the file, so
    // it is the one that trips a 429 — which says nothing about the adapter.
    skipOnQuota(ctx, async () => {
      // The compat endpoint sends every tool-call fragment with `index: 0`, so an
      // adapter that keyed by index would collapse them. Slotting by position is
      // what keeps the arguments parseable.
      let observed: { city?: unknown } = {};
      const result = await generateText({
        model,
        prompt: 'Weather in Istanbul? Use the tool, then answer in one sentence.',
        maxSteps: 4,
        maxOutputTokens: 512,
        tools: {
          get_weather: {
            description: 'Current weather for a city.',
            parameters: WEATHER,
            execute: (args: unknown) => {
              observed = args as { city?: unknown };
              return { tempC: 31, sky: 'clear' };
            },
          },
        },
      });

      expect(observed.city).toBeTruthy();
      expect(result.steps?.length ?? 0).toBeGreaterThan(1);
    }));
});
