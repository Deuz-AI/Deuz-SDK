/**
 * DeepSeek, against the real API.
 *
 * What only a live call can settle: that `DEFAULT_BASE_URL.deepseek` plus the
 * adapter's `/chat/completions` suffix is a URL DeepSeek actually serves, that
 * the SSE frames parse, and that a slug the registry has never heard of behaves
 * the way the registry promises — conservative defaults and a warning, never a
 * throw. `deepseek-v4-flash` is exactly that slug: the pinned row is v3.2.
 */
import { describe, it, expect } from 'vitest';
import { generateText, streamChat, generateObject } from '../../src/index';
import { createDeepSeek } from '../../src/providers';
import { getModelCapabilities } from '../../src/core/registry';
import type { JSONSchema } from '../../src/index';
import { key, fingerprint } from './env';

const apiKey = key('DEEPSEEK_API_KEY');
const MODEL = 'deepseek-v4-flash';

describe.skipIf(!apiKey)(`deepseek — live (${MODEL})`, () => {
  const deepseek = createDeepSeek({ apiKey });
  const model = deepseek(MODEL);

  it('round-trips a real completion, with the reasoning flag the wire confirms', async () => {
    // v4 landed after 1.9 pinned its rows and ran on the unknown-slug fallback
    // until this live run; the row exists now, and `reasoning` is not a guess —
    // the API returns `reasoning_content` on every call (asserted below).
    const caps = getModelCapabilities(model);
    expect(caps.reasoning).toBe(true);
    expect(caps.maxOutput).toBeGreaterThan(0);

    const result = await generateText({
      model,
      prompt: 'Reply with the single word: pong',
      // Budget has to clear the thinking pass: v4 always reasons, and reasoning
      // tokens come out of the SAME allowance as the answer. A budget sized for
      // the visible reply alone returns an empty string, not an error.
      maxOutputTokens: 512,
    });

    expect(result.text.toLowerCase()).toContain('pong');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[deepseek ${fingerprint(apiKey!)}] text=${JSON.stringify(result.text)} ` +
        `usage=${result.usage.inputTokens}/${result.usage.outputTokens} ` +
        `reasoningTokens=${result.usage.reasoningTokens} finish=${result.finishReason}`,
    );
  });

  it('streams deltas over real SSE, with reasoning on its own channel', async () => {
    const res = streamChat({
      model,
      prompt: 'Count from 1 to 5, digits only, separated by spaces.',
      maxOutputTokens: 512,
    });

    const text: string[] = [];
    const reasoning: string[] = [];
    for await (const part of res.fullStream) {
      if (part.type === 'text-delta') text.push(part.text);
      if (part.type === 'reasoning-delta') reasoning.push(part.text);
    }

    expect(text.length).toBeGreaterThan(1); // genuinely streamed, not one blob
    expect(text.join('')).toMatch(/1/);
    // `reasoning_content` must arrive as reasoning parts, never spliced into the
    // answer — the whole point of keeping the two channels apart.
    expect(reasoning.length).toBeGreaterThan(0);
    expect((await res.usage).reasoningTokens).toBeGreaterThan(0);
    expect(await res.finishReason).toBe('stop');
  });

  it('calls a tool and feeds the result back', async () => {
    // Unforced tool calling works even though FORCED `tool_choice` does not —
    // the two are separate wire features, which is why the gap below is scoped
    // to `generateObject` and leaves the agentic loop unaffected.
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
    // eslint-disable-next-line no-console
    console.log(
      `[deepseek] tool arg=${JSON.stringify(observed)} steps=${result.steps?.length ?? 0}`,
    );
  });

  /**
   * KNOWN GAP, pinned so it cannot regress quietly. `generateObject` has two
   * strategies and DeepSeek v4 rejects both:
   *
   *   json → `response_format: json_schema` → 400 "This response_format type is
   *          unavailable now" (v4 supports only the older `json_object`)
   *   tool → forced `tool_choice` → 400 "Thinking mode does not support this
   *          tool_choice" (v4 always thinks; it cannot be turned off)
   *
   * `pickObjectStrategy` already avoids the tool strategy for a thinking model,
   * but the guard is scoped to `provider === 'anthropic'`, and even lifting that
   * would land on the json strategy, which v4 also refuses.
   *
   * Until a `json_object` strategy exists, the honest workaround is plain
   * `generateText` with the schema in the prompt — asserted below, so the docs'
   * recommendation is executable rather than aspirational.
   */
  it('rejects generateObject on both strategies — the documented v4 gap', async () => {
    const schema = {
      type: 'object',
      properties: { capital: { type: 'string' } },
      required: ['capital'],
      additionalProperties: false,
    } satisfies JSONSchema;

    await expect(
      generateObject({ model, prompt: 'Return the capital of Turkey.', schema, mode: 'tool' }),
    ).rejects.toThrow(/thinking mode does not support this tool_choice/i);

    await expect(
      generateObject({ model, prompt: 'Return the capital of Turkey.', schema, mode: 'json' }),
    ).rejects.toThrow(/response_format type is unavailable/i);
  });

  it('the documented workaround works: generateText with the schema in the prompt', async () => {
    const { text } = await generateText({
      model,
      prompt:
        'Return ONLY JSON matching {"capital": string} for the capital of Turkey. No prose, no code fence.',
      maxOutputTokens: 512,
    });

    const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()) as {
      capital: string;
    };
    expect(parsed.capital).toMatch(/ankara/i);
  });
});
