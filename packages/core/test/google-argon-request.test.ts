import { describe, expect, it } from 'vitest';
import { generateText } from '../src/index';
import { createGoogleNative } from '../src/google';
import { createVertexGoogleNative } from '../src/vertex';
import { InvalidRequestError } from '../src/errors';
import { resolveModelProfile } from '../src/model-profile';
import type { CommonCallOptions } from '../src/types/config';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

// Request-contract tests only; these do not claim live model or long-decode support.
// https://ai.google.dev/gemini-api/docs/generate-content/latest-model
// https://ai.google.dev/gemini-api/docs/generate-content/thinking
const providers = [
  {
    name: 'Gemini API',
    key: 'google',
    create: (fetch: typeof globalThis.fetch, modelId: string) =>
      createGoogleNative({ apiKey: 'test-key', fetch })(modelId),
  },
  {
    name: 'Vertex AI',
    key: 'vertex-google',
    create: (fetch: typeof globalThis.fetch, modelId: string) =>
      createVertexGoogleNative({
        project: 'test-project',
        location: 'global',
        accessToken: 'test-token',
        fetch,
      })(modelId),
  },
];

function transport() {
  return mockFetch(() =>
    sseResponse([
      sseEvents([
        {
          data: {
            candidates: [
              { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          },
        },
      ]),
    ]),
  );
}

describe.each(providers)('$name Gemini 4 Argon request rules', ({ create, key }) => {
  async function request(options: Partial<CommonCallOptions> = {}, modelId = 'gemini-4-argon') {
    const { fetch, calls } = transport();
    const result = await generateText({
      ...options,
      model: create(fetch, modelId),
      messages: [{ role: 'user', content: 'Explain' }],
      maxRetries: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`${modelId}:streamGenerateContent`);
    return { body: JSON.parse(String(calls[0]!.init!.body)), warnings: result.warnings ?? [] };
  }

  it.each(['low', 'medium', 'high'] as const)(
    'sends %s as thinkingLevel, never thinkingBudget',
    async (effort) => {
      const { body, warnings } = await request({ effort });
      expect(body.generationConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: effort,
      });
      expect(warnings.filter((warning) => warning.setting === 'effort')).toEqual([]);
    },
  );

  it.each(['xhigh', 'max'] as const)(
    'clamps %s to high with the existing typed warning',
    async (effort) => {
      const { body, warnings } = await request({ effort });
      expect(body.generationConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: 'high',
      });
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'clamped-setting', setting: 'effort' }),
        ]),
      );
    },
  );

  it('maps none to low with a warning rather than silently using the backend default', async () => {
    const { body, warnings } = await request({ effort: 'none' });
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'low',
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'clamped-setting', setting: 'effort' }),
      ]),
    );
  });

  it('leaves unset effort and output limits unset instead of inventing Argon defaults', async () => {
    const { body } = await request();
    expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
    expect(body.generationConfig).not.toHaveProperty('maxOutputTokens');
  });

  it('does not raise or lower an explicit caller output budget', async () => {
    const { body } = await request({ maxOutputTokens: 8192, effort: 'low' });
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('omits deprecated sampling settings and reports each omission', async () => {
    const options = { temperature: 0, topP: 0.5 };
    const { body, warnings } = await request(options);
    expect(body.generationConfig).not.toHaveProperty('temperature');
    expect(body.generationConfig).not.toHaveProperty('topP');
    expect(
      warnings
        .filter((warning) => warning.type === 'unsupported-setting')
        .map((warning) => warning.setting)
        .sort(),
    ).toEqual(['temperature', 'topP']);
    expect(options).toEqual({ temperature: 0, topP: 0.5 });
  });

  it('does not report sampling drops when no sampling settings were supplied', async () => {
    const { warnings } = await request();
    expect(warnings.filter((warning) => warning.type === 'unsupported-setting')).toEqual([]);
  });

  it('reports the sampling and cache rules that the adapter actually enforces', async () => {
    const noNetwork = (() => {
      throw new Error('A profile must never request the network');
    }) as typeof fetch;
    const profile = resolveModelProfile(create(noNetwork, 'gemini-4-argon'));
    expect(profile.sampling.handling).toBe('stripped');
    expect(profile.cache.mode).toBe('implicit');
    expect(Object.isFrozen(profile)).toBe(true);
    const { body, warnings } = await request({ temperature: 0, topP: 0.5 });
    for (const setting of ['temperature', 'topP']) {
      expect(body.generationConfig).not.toHaveProperty(setting);
      expect(profile.clamps).toContainEqual({
        setting,
        from: '*',
        to: 'dropped',
        warning: 'unsupported-setting',
      });
      expect(warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ setting, type: 'unsupported-setting' })]),
      );
    }
  });

  it.each(['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-4-unreviewed-test-model'])(
    'does not apply Argon profile rules to %s',
    (modelId) => {
      const { fetch } = transport();
      const profile = resolveModelProfile(create(fetch, modelId));
      expect(profile.sampling.handling).toBe('sent');
      expect(profile.cache.mode).toBe('cached-content');
    },
  );

  it('rejects explicit cachedContent before HTTP without discarding cached context', async () => {
    const { fetch, calls } = transport();
    const options = { providerOptions: { [key]: { cachedContent: 'cachedContents/test-only' } } };
    await expect(
      generateText({
        ...options,
        model: create(fetch, 'gemini-4-argon'),
        prompt: 'Explain',
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
    expect(options.providerOptions[key]!.cachedContent).toBe('cachedContents/test-only');
  });

  it('preserves Gemini 2.5 budget, sampling and explicit-cache behavior', async () => {
    const { body } = await request(
      {
        effort: 'high',
        temperature: 0.2,
        topP: 0.7,
        providerOptions: { [key]: { cachedContent: 'cachedContents/test-only' } },
      },
      'gemini-2.5-flash',
    );
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 24576,
    });
    expect(body.generationConfig).toMatchObject({ temperature: 0.2, topP: 0.7 });
    expect(body.cachedContent).toBe('cachedContents/test-only');
  });

  it('keeps Gemini 3.8 level-based requests unchanged', async () => {
    const { body } = await request({ effort: 'medium' }, 'gemini-3.8-flash');
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'medium',
    });
  });

  it('does not assume the same contract for an unreviewed Gemini 4 model', async () => {
    const { body } = await request(
      { effort: 'high', temperature: 0.2 },
      'gemini-4-unreviewed-test-model',
    );
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 24576,
    });
    expect(body.generationConfig.temperature).toBe(0.2);
  });
});
