/**
 * xAI Grok, against the real API.
 *
 * Grok rides the shared OpenAI Chat Completions adapter, so this is as much a
 * test of that adapter's portability as of the provider: the same code path
 * serves a dozen hosts, and each one is free to differ in exactly the places a
 * mock cannot notice — the auth header, the usage envelope, whether strict
 * `json_schema` is honoured, whether forced `tool_choice` is accepted.
 *
 * `grok-4.5` postdates the pinned rows, so it also exercises the unknown-slug
 * fallback: conservative caps, a warning, and a call that still works.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat, generateObject } from '../../src/index';
import { createXai } from '../../src/xai';
import { getModelCapabilities } from '../../src/core/registry';
import type { JSONSchema } from '../../src/index';
import { key, fingerprint } from './env';

const apiKey = key('XAI_API_KEY');
const MODEL = 'grok-4.5';

describe.skipIf(!apiKey)(`xai — live (${MODEL})`, () => {
  const model = createXai({ apiKey })(MODEL);

  it('calls an unpinned slug on conservative defaults without throwing', async () => {
    const caps = getModelCapabilities(model);
    expect(caps.known).toBe(false); // newer than the registry, by design not an error

    const result = await generateText({
      model,
      prompt: 'Reply with one word: pong',
      maxOutputTokens: 512,
    });

    expect(result.text.toLowerCase()).toContain('pong');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[xai ${fingerprint(apiKey!)}] text=${JSON.stringify(result.text)} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
        `cachedRead=${result.usage.cachedReadTokens} known=${caps.known}`,
    );
  });

  it('reports cached prompt tokens as cache reads, not as fresh input', async () => {
    // Grok returns `prompt_tokens_details.cached_tokens`, and the adapter
    // subtracts it from `inputTokens`. Billing them twice is the bug this
    // guards: cached input is charged at a different rate, or not at all.
    const result = await generateText({
      model,
      prompt: 'Reply with one word: pong',
      maxOutputTokens: 512,
    });

    expect(result.usage.cachedReadTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.inputTokens + result.usage.cachedReadTokens).toBeLessThanOrEqual(
      result.usage.totalTokens,
    );
  });

  it('streams deltas over real SSE', async () => {
    const res = streamChat({
      model,
      prompt: 'Count from 1 to 5, digits only, separated by spaces.',
      maxOutputTokens: 512,
    });

    const chunks: string[] = [];
    for await (const delta of res.textStream) chunks.push(delta);

    expect(chunks.join('')).toMatch(/1/);
    expect((await res.usage).outputTokens).toBeGreaterThan(0);
    expect(await res.finishReason).toBe('stop');
  });

  it('runs a tool loop', async () => {
    let observed: { city?: unknown } = {};
    const result = await generateText({
      model,
      prompt: 'What is the weather in Istanbul? Use the tool, then answer in one sentence.',
      maxSteps: 4,
      maxOutputTokens: 512,
      tools: {
        get_weather: {
          description: 'Current weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
          } satisfies JSONSchema,
          execute: (args: unknown) => {
            observed = args as { city?: unknown };
            return { tempC: 31, sky: 'clear' };
          },
        },
      },
    });

    expect(observed.city).toBeTruthy();
    expect(result.steps?.length ?? 0).toBeGreaterThan(1);
    expect(result.text).toMatch(/31|clear/i);
  });

  it('produces structured output', async () => {
    // An unpinned slug gets `structuredOutput: false`, so this takes the TOOL
    // strategy — the forced `tool_choice` path the probe confirmed Grok accepts.
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
