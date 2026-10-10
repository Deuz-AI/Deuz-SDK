import { describe, it, expect, vi } from 'vitest';
import {
  getCapabilities,
  getEmbeddingCapabilities,
  getModelCapabilities,
  isMaxOutputPlaceholder,
  registryMatch,
  type ModelCapabilities,
} from '../src/core/registry';
import { resolveModelProfile } from '../src/model-profile';
import { generateText } from '../src/generate';
import {
  createOpenAICompatible,
  createOllama,
  createLMStudio,
  perplexity,
  cohere,
  deepinfra,
  nvidia,
  sambanova,
  hyperbolic,
} from '../src/providers-compat';
import { readConfig, withCapabilityOverride } from '../src/internal/config-symbol';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';
import type { Logger } from '../src/types/deps';
import type { Provider } from '../src/types/model';

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

// ===================================================================
// 2.3 (F14) — Claude 5.x rows. Verified against Anthropic's API reference
// (cached 2026-10-06), NOT live-verified: these pin what the SDK sends.
// ===================================================================

describe('registry: Claude 5.x (2.3, F14)', () => {
  const CLAUDE_5 = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

  it('the four current ids are known rows with the Claude 5.x request rules', () => {
    for (const id of CLAUDE_5) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.known, id).toBe(true);
      expect(caps, id).toMatchObject({
        effortWire: 'output_config',
        samplingRestrictions: true,
        structuredOutput: true,
        caching: true,
        vision: true,
        reasoning: true,
        contextWindow: 1_000_000,
        maxOutput: 128_000,
      });
      expect(caps.effortLevels, id).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    }
  });

  it('forced tool_choice: rejected by Fable 5.1 / Opus 5.5 / Sonnet 5.5, accepted by Haiku 5.5', () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(getCapabilities(anthropic(id)).forcedToolChoice, id).toBe(false);
    }
    expect(getCapabilities(anthropic('claude-haiku-5-5')).forcedToolChoice).toBe(true);
  });

  it("effort 'none' maps per model; documented defaults are recorded", () => {
    expect(getCapabilities(anthropic('claude-fable-5-1')).effortNone).toBe('lowest');
    expect(getCapabilities(anthropic('claude-opus-5-5'))).toMatchObject({
      effortNone: 'lowest',
      effortDefault: 'medium',
    });
    expect(getCapabilities(anthropic('claude-sonnet-5-5'))).toMatchObject({
      effortNone: 'thinking-between-tools',
      effortDefault: 'high',
    });
    expect(getCapabilities(anthropic('claude-haiku-5-5'))).toMatchObject({
      effortNone: 'thinking-disabled',
      effortDefault: 'medium',
    });
  });

  it('claude-opus-5 is now a known row (thinking can be disabled at effort <= high)', () => {
    const caps = getCapabilities(anthropic('claude-opus-5'));
    expect(caps.known).toBe(true);
    expect(caps).toMatchObject({
      effortWire: 'output_config',
      samplingRestrictions: true,
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      effortNone: 'thinking-disabled',
    });
  });

  it('family fallback: an unknown claude-{fable,opus,sonnet,haiku}-N (N >= 5) gets the 5.x rules', () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    for (const id of [
      'claude-opus-9-9',
      'claude-sonnet-6',
      'claude-haiku-5-7',
      'claude-fable-5-2',
    ]) {
      const caps = getCapabilities(anthropic(id), logger);
      expect(caps.known, id).toBe(false); // still a fallback — the unknown-model warning fires
      expect(caps, id).toMatchObject({
        effortWire: 'output_config',
        samplingRestrictions: true,
        structuredOutput: true,
        caching: true,
        reasoning: true,
        forcedToolChoice: false,
        effortNone: 'lowest',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
      });
    }
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      'Claude 5.x',
    );
  });

  it('the family fallback stays narrow: 4.x, other names and other wires keep the old fallback', () => {
    expect(getCapabilities(anthropic('claude-opus-4-9')).effortWire).toBe('budget_tokens');
    expect(getCapabilities(anthropic('claude-zeta-9-9')).effortWire).toBe('budget_tokens');
    expect(getCapabilities(anthropic('claude-opus-5x')).effortWire).toBe('budget_tokens');
    // The 5.x rules are Messages-wire rules: a chat_completions proxy keeps its own fallback.
    const viaProxy = getCapabilities({
      provider: 'openrouter',
      modelId: 'claude-opus-9-9',
      surface: 'chat_completions',
    });
    expect(viaProxy.samplingRestrictions).toBe(false);
  });

  it('the capabilities override cannot re-enable budget_tokens or sampling for the 5.x family', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-9-9']) {
      const caps = getCapabilities(anthropic(id), undefined, {
        reasoning: true,
        effortWire: 'budget_tokens',
        samplingRestrictions: false,
      });
      expect(caps.effortWire, id).toBe('output_config');
      expect(caps.samplingRestrictions, id).toBe(true);
      expect(caps.reasoning, id).toBe(true);
    }
    // A plain `{ reasoning: true }` (the documented cure) keeps the 5.x wire too.
    expect(
      getCapabilities(anthropic('claude-opus-9-9'), undefined, { reasoning: true }).effortWire,
    ).toBe('output_config');
    // Older families are untouched: an override is still a claim the SDK does not check.
    expect(
      getCapabilities(anthropic('claude-opus-4-6'), undefined, { samplingRestrictions: true })
        .samplingRestrictions,
    ).toBe(true);
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
  it('gemini-3.1-pro, the GA id, is known on both wires: natively it shares the preview row', () => {
    const on = (modelId: string, surface: 'native' | 'chat_completions') =>
      getCapabilities({ provider: 'google', modelId, surface });
    const ga = on('gemini-3.1-pro', 'native');
    expect(ga).toEqual(on('gemini-3.1-pro-preview', 'native'));
    expect(ga.known).toBe(true);
    // A documented limit, not the fallback's placeholder: the native wire sends it.
    expect(isMaxOutputPlaceholder(ga)).toBe(false);
    expect(on('gemini-3.1-pro', 'chat_completions').known).toBe(true);
  });
});

// ===================================================================
// 2.0 — the eight new OpenAI-compatible hosts
// ===================================================================

describe('registry: 2.0 OpenAI-compatible hosts', () => {
  it('pins a row per new cloud host, each attributed to its own provider', () => {
    const PINNED: [Provider, string, string][] = [
      [perplexity, 'sonar', 'perplexity'],
      [perplexity, 'sonar-pro', 'perplexity'],
      [perplexity, 'sonar-reasoning-pro', 'perplexity'],
      [cohere, 'command-a-03-2025', 'cohere'],
      [deepinfra, 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', 'deepinfra'],
      [deepinfra, 'deepseek-ai/DeepSeek-V3.2', 'deepinfra'],
      [nvidia, 'meta/llama-4-maverick-17b-128e-instruct', 'nvidia'],
      [nvidia, 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'nvidia'],
      [sambanova, 'Llama-4-Maverick-17B-128E-Instruct', 'sambanova'],
      [sambanova, 'Meta-Llama-3.3-70B-Instruct', 'sambanova'],
      [hyperbolic, 'Qwen/Qwen3-235B-A22B-Instruct', 'hyperbolic'],
      [hyperbolic, 'moonshotai/Kimi-K2-Instruct', 'hyperbolic'],
    ];
    for (const [factory, slug, provider] of PINNED) {
      const caps = getCapabilities(factory(slug));
      expect(caps.known, slug).toBe(true);
      expect(caps.provider, slug).toBe(provider);
      expect(caps.surface, slug).toBe('chat_completions');
    }
  });

  it('Perplexity Sonar disables client tools (the search is server-side)', () => {
    for (const slug of ['sonar', 'sonar-pro', 'sonar-reasoning-pro']) {
      expect(getCapabilities(perplexity(slug)).tools, slug).toBe(false);
    }
    expect(getCapabilities(perplexity('sonar-reasoning-pro')).reasoning).toBe(true);
  });

  it('Ollama / LM Studio slugs are user-defined, so they are DELIBERATELY unknown', () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    for (const [model, provider] of [
      [createOllama()('anything'), 'ollama'],
      [createOllama()('llama3.2:3b'), 'ollama'],
      [createLMStudio()('some-gguf'), 'lmstudio'],
    ] as const) {
      const caps = getCapabilities(model, logger);
      expect(caps.known).toBe(false);
      expect(caps.provider).toBe(provider);
      expect(caps.tools).toBe(false); // conservative fallback
      expect(caps.maxOutput).toBe(4_096);
    }
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('CompatSettings.capabilities is the documented cure — it flows into getCapabilities', () => {
    const model = createOllama({
      capabilities: { tools: true, maxOutput: 32_000, structuredOutput: true },
    })('qwen3');
    const caps = getCapabilities(model);
    expect(caps.tools).toBe(true);
    expect(caps.maxOutput).toBe(32_000);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.contextWindow).toBe(128_000); // untouched fallback value
    expect(caps.known).toBe(false); // an override is a claim, not knowledge
    // …and a per-call override still outranks the factory one.
    expect(getCapabilities(model, undefined, { maxOutput: 8_000 }).maxOutput).toBe(8_000);
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
  it('THE BUG: an unknown slug is no longer truncated at 4096 — and the override still reaches the wire', async () => {
    const { fetch, calls } = ccReplay();
    const together = createOpenAICompatible({
      id: 'together',
      apiKey: 'k',
      baseURL: 'https://api.together.xyz/v1',
      fetch,
    });
    const model = together(UNKNOWN_SLUG);

    // 2.3 (F08, deliberate): the 4096 placeholder used to reach the wire and
    // silently truncate. Chat Completions' cap is optional, so it is now left
    // off and the host's own default applies.
    await generateText({ model, prompt: 'hi' });
    expect(JSON.parse(String(calls[0]!.init!.body))).not.toHaveProperty('max_tokens');
    expect(getModelCapabilities(model).maxOutput).toBe(4_096); // still the reported placeholder

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

describe('registry lookups read own rows only (2.3)', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    '%s is an unknown model, not an inherited object member',
    (modelId) => {
      for (const surface of ['anthropic', 'chat_completions', 'responses', 'native'] as const) {
        expect(registryMatch({ provider: 'x', surface, modelId }), surface).toBe('fallback');
        const caps = getModelCapabilities({ provider: 'x', surface, modelId });
        expect(caps.known, surface).toBe(false);
        expect(caps.maxOutput, surface).toBeGreaterThan(0);
      }
      expect(
        getEmbeddingCapabilities({ provider: 'openai', surface: 'openai-embeddings', modelId })
          .known,
      ).toBe(false);
      expect(resolveModelProfile({ provider: 'x', surface: 'responses', modelId }).match).toBe(
        'fallback',
      );
    },
  );
});
