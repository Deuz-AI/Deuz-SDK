import { describe, expect, it } from 'vitest';
import { generateText } from '../src/index';
import { createGoogleNative } from '../src/google';
import { createVertexGoogleNative } from '../src/vertex';
import {
  getCapabilities,
  isMaxOutputPlaceholder,
  omitsDefaultOutputCap,
} from '../src/core/registry';
import { resolveModelProfile } from '../src/model-profile';
import { optionalOutputCap } from '../src/core/request-rules';
import { withCapabilityOverride } from '../src/internal/config-symbol';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

// Verified model cards, not live model behavior. Request rules are covered separately.
const providers = [
  {
    name: 'Gemini',
    create: (fetch: typeof globalThis.fetch, modelId: string) =>
      createGoogleNative({
        apiKey: 'test-key',
        fetch,
      })(modelId),
  },
  {
    name: 'Vertex',
    create: (fetch: typeof globalThis.fetch, modelId: string) =>
      createVertexGoogleNative({
        project: 'test-project',
        location: 'global',
        accessToken: 'test-token',
        fetch,
      })(modelId),
  },
];
const noNetwork = (() => {
  throw new Error('Catalog lookup must not use the network');
}) as typeof fetch;
describe.each(providers)('$name documented native models', ({ create }) => {
  it.each(['gemini-3.8-flash', 'gemini-4-argon'])(
    '%s has sourced capabilities and a known single-stream limit without a default cap',
    (modelId) => {
      const model = create(noNetwork, modelId);
      const caps = getCapabilities(model);
      expect(caps).toMatchObject({
        known: true,
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        vision: true,
        tools: true,
        reasoning: true,
        nativePdf: true,
        audio: true,
        caching: true,
      });
      expect(isMaxOutputPlaceholder(caps)).toBe(false);
      expect(omitsDefaultOutputCap(caps)).toBe(true);
      expect(optionalOutputCap(caps, {})).toBeUndefined();
      const profile = resolveModelProfile(model);
      expect(profile).toMatchObject({
        match: 'exact',
        status: 'stable',
        checkedAt: '2026-10-17',
        liveVerified: false,
      });
      expect(profile.sourceUrl).toBe(`https://ai.google.dev/gemini-api/docs/models/${modelId}`);
      expect(profile.limits).toEqual({
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        defaultOutputCap: 'omitted',
      });
      expect(profile.capabilities.vision).toBe('supported');
      expect(profile.notes.join(' ')).toContain(
        modelId === 'gemini-4-argon' ? 'share' : 'separate',
      );
    },
  );

  it.each(['gemini-3.8-flash', 'gemini-4-argon'])(
    '%s still honors descriptor and per-call output overrides',
    (modelId) => {
      const factory = withCapabilityOverride(create(noNetwork, modelId), { maxOutput: 8192 });
      expect(optionalOutputCap(getCapabilities(factory), {})).toBe(8192);
      expect(resolveModelProfile(factory).limits.defaultOutputCap).toBe(8192);
      expect(optionalOutputCap(getCapabilities(factory), { maxOutputTokens: 4096 })).toBe(4096);
      expect(optionalOutputCap(getCapabilities(factory, undefined, { maxOutput: 16384 }), {})).toBe(
        16384,
      );
    },
  );

  it.each(['gemini-3.8-flash', 'gemini-4-argon'])(
    '%s has unchanged output-cap omission on real request serialization',
    async (modelId) => {
      const { fetch, calls } = mockFetch(() =>
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
      const result = await generateText({ model: create(fetch, modelId), prompt: 'Explain' });
      expect(JSON.parse(String(calls[0]!.init!.body)).generationConfig).not.toHaveProperty(
        'maxOutputTokens',
      );
      expect(result.warnings?.some((w) => w.type === 'unknown-model') ?? false).toBe(false);
    },
  );
});
