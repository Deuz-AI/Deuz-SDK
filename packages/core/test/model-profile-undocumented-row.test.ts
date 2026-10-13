import { describe, it, expect, vi } from 'vitest';
import { resolveModelProfile } from '../src/model-profile';
import { createOpenAIResponses } from '../src/openai';
import { withCapabilityOverride } from '../src/internal/config-symbol';

// 2.3 — the model profile's structural guard. A pinned row that leaves its
// output limit undocumented pins only what its request rules need; without a
// documentary facts entry, its other values are conservative defaults, never
// facts. Every such row in the real table has a facts entry, so the registry is
// mocked to answer one unlisted id with an exact, undocumented row: the real
// fallback caps (tools off, 128K context, vision off).
vi.mock('../src/core/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/registry')>();
  const unlisted = (model: { modelId: string }) => model.modelId === 'gpt-5.99-unlisted';
  return {
    ...real,
    registryMatch: (model: Parameters<typeof real.registryMatch>[0]) =>
      unlisted(model) ? 'exact' : real.registryMatch(model),
    isUndocumentedRow: (model: Parameters<typeof real.isUndocumentedRow>[0]) =>
      unlisted(model) || real.isUndocumentedRow(model),
  };
});

describe('an undocumented pinned row without facts (2.3, structural guard)', () => {
  it('reports its row defaults as unknown, never as facts', () => {
    const profile = resolveModelProfile(
      createOpenAIResponses({ apiKey: 'k' })('gpt-5.99-unlisted'),
    );
    expect(profile.match).toBe('exact');
    expect(Object.values(profile.capabilities).every((s) => s === 'unknown')).toBe(true);
    expect(profile.limits).toEqual({ defaultOutputCap: 'omitted' });
    expect(profile.sampling.accepted).toBe('unknown');
    expect(profile.thinking).toEqual({ mode: 'unknown', replay: 'unknown' });
  });

  it("a caller's claim is still the caller's word; claiming a limit leaves the rest unknown", () => {
    const profile = resolveModelProfile(
      withCapabilityOverride(createOpenAIResponses({ apiKey: 'k' })('gpt-5.99-unlisted'), {
        vision: true,
        maxOutput: 32_000,
      }),
    );
    expect(profile.capabilities.vision).toBe('supported');
    expect(profile.capabilities.tools).toBe('unknown');
    expect(profile.limits).toEqual({ maxOutput: 32_000, defaultOutputCap: 32_000 });
  });

  it('a real pinned row is untouched by the mock', () => {
    expect(resolveModelProfile(createOpenAIResponses({ apiKey: 'k' })('gpt-5.4'))).toMatchObject({
      match: 'exact',
      capabilities: { vision: 'supported' },
      limits: { contextWindow: 400_000 },
    });
  });
});
