import { describe, it, expect, vi } from 'vitest';
import {
  getCapabilities,
  getEmbeddingCapabilities,
  getModelCapabilities,
  type ModelCapabilities,
} from '../src/core/registry';
import { generateText } from '../src/generate';
import { createOpenAICompatible } from '../src/providers-compat';
import { readConfig, withCapabilityOverride } from '../src/internal/config-symbol';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';
import type { Logger } from '../src/types/deps';

const anthropic = (modelId: string) =>
  ({ provider: 'anthropic', modelId, surface: 'anthropic' }) as const;

describe('registry: 2026-07 Anthropic catalog', () => {
  it('claude-fable-5 is a known row with output_config effort wire', () => {
    const caps = getCapabilities(anthropic('claude-fable-5'));
    expect(caps.known).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.caching).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.effortWire).toBe('output_config');
    expect(caps.samplingRestrictions).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('claude-sonnet-5 matches fable-5 caps shape', () => {
    const caps = getCapabilities(anthropic('claude-sonnet-5'));
    expect(caps.known).toBe(true);
    expect(caps.effortWire).toBe('output_config');
    expect(caps.samplingRestrictions).toBe(true);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('opus 4.7/4.8 moved to output_config + samplingRestrictions', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7']) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.effortWire).toBe('output_config');
      expect(caps.samplingRestrictions).toBe(true);
    }
  });

  it('opus 4.6 and older keep the budget_tokens wire and free sampling', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.effortWire).toBe('budget_tokens');
      expect(caps.samplingRestrictions).toBe(false);
    }
  });

  it('unknown slugs default to budget_tokens', () => {
    const caps = getCapabilities(anthropic('claude-opus-4-9'));
    expect(caps.known).toBe(false);
    expect(caps.effortWire).toBe('budget_tokens');
  });
});

describe('registry: 2026-07 OpenAI catalog', () => {
  it('gpt-5.5 exposes reasoning (effort ships on both OpenAI wires)', () => {
    const caps = getCapabilities({
      provider: 'openai',
      modelId: 'gpt-5.5',
      surface: 'chat_completions',
    });
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1_050_000);
  });
  it('gpt-5.4-nano and gpt-5.3-codex are known responses rows', () => {
    for (const id of ['gpt-5.4-nano', 'gpt-5.3-codex']) {
      const caps = getCapabilities({ provider: 'openai', modelId: id, surface: 'responses' });
      expect(caps.known).toBe(true);
      expect(caps.reasoning).toBe(true);
      expect(caps.samplingRestrictions).toBe(true);
      expect(caps.contextWindow).toBe(400_000);
    }
  });
});

describe('registry: 2026-07 Google catalog', () => {
  it('gemini-3.1-pro-preview is known on both wires', () => {
    const native = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
      surface: 'native',
    });
    expect(native.known).toBe(true);
    expect(native.reasoning).toBe(true);
    expect(native.nativePdf).toBe(true);
    const compat = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
      surface: 'chat_completions',
    });
    expect(compat.known).toBe(true);
    expect(compat.usagePerChunk).toBe(true);
  });
  it('gemini-3.1-flash-lite is a known native row', () => {
    const caps = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.1-flash-lite',
      surface: 'native',
    });
    expect(caps.known).toBe(true);
  });
});

// ===================================================================
// 1.9 — `capabilities` per-call / per-factory override
// ===================================================================

/** One minimal, well-formed Chat Completions text turn. */
const CC_TEXT = sseEvents([
  { data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } },
  { data: '[DONE]' },
]);

const ccReplay = (): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } =>
  mockFetch(() => sseResponse([CC_TEXT]));

/** `brand-new-slug` is deliberately absent from the registry → defaultRow (maxOutput 4_096). */
const UNKNOWN_SLUG = 'brand-new-slug';

const maxTokensOf = (body: unknown): number =>
  (JSON.parse(String(body)) as { max_tokens: number }).max_tokens;

describe('registry: capability overrides (1.9)', () => {
  it('THE BUG: an unknown slug truncates at 4096 unless overridden — the override reaches the wire', async () => {
    const { fetch, calls } = ccReplay();
    const together = createOpenAICompatible({
      id: 'together',
      apiKey: 'k',
      baseURL: 'https://api.together.xyz/v1',
      fetch,
    });
    const model = together(UNKNOWN_SLUG);

    await generateText({ model, prompt: 'hi' });
    expect(maxTokensOf(calls[0]!.init!.body)).toBe(4_096); // the silent truncation

    await generateText({ model, prompt: 'hi', capabilities: { maxOutput: 32_000 } });
    expect(maxTokensOf(calls[1]!.init!.body)).toBe(32_000);
  });

  it('factory-level capabilities reach the wire, and a per-call override BEATS them', async () => {
    const { fetch, calls } = ccReplay();
    const host = createOpenAICompatible({
      id: 'together',
      apiKey: 'k',
      baseURL: 'https://api.together.xyz/v1',
      fetch,
      capabilities: { maxOutput: 12_345 },
    });
    const model = host(UNKNOWN_SLUG);
    expect(getModelCapabilities(model).maxOutput).toBe(12_345);

    await generateText({ model, prompt: 'hi' });
    expect(maxTokensOf(calls[0]!.init!.body)).toBe(12_345);

    await generateText({ model, prompt: 'hi', capabilities: { maxOutput: 32_000 } });
    expect(maxTokensOf(calls[1]!.init!.body)).toBe(32_000);

    // The per-call clone must not leak: the factory descriptor is unchanged.
    expect(getModelCapabilities(model).maxOutput).toBe(12_345);
    await generateText({ model, prompt: 'hi' });
    expect(maxTokensOf(calls[2]!.init!.body)).toBe(12_345);
  });

  it('an override does not have to be exhaustive (shallow merge over the row)', () => {
    const caps = getCapabilities(
      { provider: 'together', modelId: UNKNOWN_SLUG, surface: 'chat_completions' },
      undefined,
      { maxOutput: 32_000, reasoning: true, structuredOutput: true },
    );
    expect(caps.maxOutput).toBe(32_000);
    expect(caps.reasoning).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.contextWindow).toBe(128_000); // untouched row value
    expect(caps.known).toBe(false); // still a fallback row — the override is a claim, not knowledge
  });

  it('returns a FROZEN copy; mutating it cannot poison the next call', () => {
    const model = anthropic('claude-opus-4-8');
    const caps = getModelCapabilities(model);
    expect(Object.isFrozen(caps)).toBe(true);
    try {
      (caps as { maxOutput: number }).maxOutput = 1; // strict mode: throws; sloppy: no-op
    } catch {
      /* frozen — either way the write must not stick */
    }
    expect(getModelCapabilities(model).maxOutput).toBe(128_000);
    expect(getCapabilities(model).maxOutput).toBe(128_000);
  });

  it('never throws on a garbage override, and undefined values cannot blank a field', () => {
    const model = {
      provider: 'together',
      modelId: UNKNOWN_SLUG,
      surface: 'chat_completions',
    } as const;
    const garbage = { maxOutput: 'lots', bogusFlag: true } as unknown as Partial<ModelCapabilities>;
    expect(() => getCapabilities(model, undefined, garbage)).not.toThrow();
    // No validation by design: the claim rides through untouched.
    expect(getCapabilities(model, undefined, garbage).maxOutput).toBe('lots' as unknown as number);
    // A generic wrapper forwarding absent keys as `undefined` must not blank the
    // row (max_tokens: undefined would 400 on Anthropic).
    expect(getCapabilities(model, undefined, { maxOutput: undefined }).maxOutput).toBe(4_096);
  });

  it('the per-call descriptor clone is re-appliable and never mutates the original', () => {
    // `attachConfig` is non-writable/non-configurable, so a second fold MUST build
    // a fresh clone rather than redefining the Symbol (that would throw).
    const original = createOpenAICompatible({
      id: 'together',
      apiKey: 'k',
      baseURL: 'https://api.together.xyz/v1',
      capabilities: { maxOutput: 12_345 },
    })(UNKNOWN_SLUG);
    const once = withCapabilityOverride(original, { maxOutput: 32_000 });
    const twice = withCapabilityOverride(once, { vision: true });
    expect(once).not.toBe(original);
    expect(getModelCapabilities(original).maxOutput).toBe(12_345); // untouched
    expect(getModelCapabilities(once).maxOutput).toBe(32_000);
    expect(getModelCapabilities(twice)).toMatchObject({ maxOutput: 32_000, vision: true });
    // The whole config blob rides along, so G1 key/baseURL resolution is unchanged.
    expect(readConfig(twice)).toMatchObject({
      provider: 'together',
      apiKey: 'k',
      baseURL: 'https://api.together.xyz/v1',
    });
    // An empty/absent override is a no-op: the caller's descriptor passes through.
    expect(withCapabilityOverride(original, {})).toBe(original);
    expect(withCapabilityOverride(original, undefined)).toBe(original);
  });

  it('an override does NOT silence the unknown-slug warning', () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    getCapabilities(
      { provider: 'together', modelId: UNKNOWN_SLUG, surface: 'chat_completions' },
      logger,
      {
        maxOutput: 32_000,
      },
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('registry: 2026-07 embedding catalog', () => {
  it('gemini-embedding-2 has no task_type (instructions go in the prompt)', () => {
    const caps = getEmbeddingCapabilities({
      provider: 'google',
      modelId: 'gemini-embedding-2',
      surface: 'gemini-embeddings',
    });
    expect(caps.known).toBe(true);
    expect(caps.embeddingDimensions).toBe(3072);
    expect(caps.embeddingMaxBatch).toBe(100);
    expect(caps.supportsTaskType).toBe(false);
  });
  it('text-embedding-004 (shut down 2026-01-14) falls back unknown', () => {
    const caps = getEmbeddingCapabilities({
      provider: 'google',
      modelId: 'text-embedding-004',
      surface: 'gemini-embeddings',
    });
    expect(caps.known).toBe(false);
  });
});
