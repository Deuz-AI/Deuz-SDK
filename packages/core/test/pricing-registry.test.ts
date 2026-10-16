import { describe, expect, it } from 'vitest';
import { getEmbeddingCapabilities, pinnedModelIds, registryMatch } from '../src/core/registry';
import { PRICE_ALIASES, PRICES_2026, priceUsage } from '../src/pricing';
import type { EmbeddingModelSurface, ModelSurface } from '../src/types/model';
import type { Usage } from '../src/types/usage';

// F19 (2.3): the price table and the capability registry describe the same
// models. A priced model the registry does not know runs on the conservative
// fallback row (thinking, effort and caching off); a registry model with no
// price cannot be bounded by a USD budget. Every exception is listed here, so a
// new row on either side fails this test until the other side follows.
//
// Knowing a model is checked per wire: the Gemini native and OpenAI-compatible
// tables are separate, so a priced Gemini model must be known on both Google
// wires (createGoogleNative and createGoogle), or be listed for the one it is not.

const SURFACES: ModelSurface[] = ['anthropic', 'chat_completions', 'responses', 'native'];

/** The wires a priced chat model is served on. Every wire but Gemini native shares one table. */
function wiresOf(modelId: string): ModelSurface[] {
  if (modelId.startsWith('gemini-')) return ['native', 'chat_completions'];
  return [modelId.startsWith('claude-') ? 'anthropic' : 'chat_completions'];
}
const PROBE: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2,
};

/** Priced embedding models live in the embedding registry. */
const EMBEDDINGS: Record<string, { provider: string; surface: EmbeddingModelSurface }> = {
  'text-embedding-3-small': { provider: 'openai', surface: 'openai-embeddings' },
  'text-embedding-3-large': { provider: 'openai', surface: 'openai-embeddings' },
  'gemini-embedding-2': { provider: 'google', surface: 'gemini-embeddings' },
  'gemini-embedding-001': { provider: 'google', surface: 'gemini-embeddings' },
  'voyage-3.5': { provider: 'voyage', surface: 'voyage-embeddings' },
  'voyage-3.5-lite': { provider: 'voyage', surface: 'voyage-embeddings' },
};

/**
 * Priced chat models the fallback row answers for, deliberately: it already
 * matches them (no `effort` parameter, sampling accepted), and no limit could
 * be verified offline. Add a registry row when one is verified.
 */
const PRICED_ON_FALLBACK = new Set([
  'grok-4.2',
  'grok-4.1',
  'grok-4',
  'grok-4-fast',
  'deepseek-r1',
  'kimi-k2.6',
  'kimi-k2-thinking',
]);

/**
 * Priced Gemini models the fallback row answers for on ONE Google wire,
 * deliberately (`id@surface` → why). Each is pinned on the other wire.
 */
const PRICED_ON_FALLBACK_BY_WIRE: Record<string, string> = {
  'gemini-3.1-flash-lite@chat_completions':
    'pinned on the native wire only since the 2026-07 catalog; nothing in the repo states ' +
    'its OpenAI-compatible behaviour (json_schema structured output, the wire quirks)',
  'gemini-3-pro@chat_completions':
    'shut down 2026-03-09; the id aliases gemini-3.1-pro-preview, which is pinned on both ' +
    'wires. Only the native table keeps the alias row, for existing native callers',
};

/**
 * Registry models without a verified price: explicitly unknown. Under a USD
 * budget they warn and run (decision 4), or are refused with
 * `unknownPrice: 'reject'`.
 */
const UNPRICED = new Set([
  'gemini-3.8-flash',
  'gemini-4-argon', // Price validity dates need a separate pricing change; unknown is not zero.
  'gpt-6-luna',
  'llama-4-maverick',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-flash',
  'kimi-k3',
  'kimi-k2.7-code',
  'glm-5.3',
  'sonar-reasoning-pro',
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
  'deepseek-ai/DeepSeek-V3.2',
  'meta/llama-4-maverick-17b-128e-instruct',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'Llama-4-Maverick-17B-128E-Instruct',
  'Meta-Llama-3.3-70B-Instruct',
  'Qwen/Qwen3-235B-A22B-Instruct',
  'moonshotai/Kimi-K2-Instruct',
  'Qwen/Qwen3-Coder-Next',
]);

/** A slug the chat registry answers with a pinned or family row on this wire. */
function knownOn(modelId: string, surface: ModelSurface): boolean {
  return registryMatch({ provider: 'x', surface, modelId }) !== 'fallback';
}

/** A slug the chat registry answers with a pinned or family row on some wire. */
function known(modelId: string): boolean {
  return SURFACES.some((surface) => knownOn(modelId, surface));
}

describe('price table and registry agree (F19)', () => {
  it('knows every priced chat model on each wire that serves it, or lists why it does not', () => {
    const gaps = Object.keys(PRICES_2026)
      .filter((id) => !(id in EMBEDDINGS))
      .flatMap((id) => {
        // A row the registry knows under an alias (mistral-large-latest → mistral-large).
        const aliases = Object.keys(PRICE_ALIASES).filter((alias) => PRICE_ALIASES[alias] === id);
        return wiresOf(id)
          .filter((surface) => ![id, ...aliases].some((slug) => knownOn(slug, surface)))
          .map((surface) => `${id}@${surface}`);
      });
    const listed = [
      ...[...PRICED_ON_FALLBACK].flatMap((id) => wiresOf(id).map((surface) => `${id}@${surface}`)),
      ...Object.keys(PRICED_ON_FALLBACK_BY_WIRE),
    ];
    expect(gaps.sort()).toEqual(listed.sort());
  });

  it('knows every priced embedding model', () => {
    for (const [modelId, { provider, surface }] of Object.entries(EMBEDDINGS)) {
      expect(modelId in PRICES_2026, modelId).toBe(true);
      expect(getEmbeddingCapabilities({ provider, surface, modelId }).known, modelId).toBe(true);
    }
  });

  it('prices every registry model, or marks it unknown', () => {
    const { native, other } = pinnedModelIds();
    const unpriced = [...new Set([...native, ...other])].filter(
      (id) => priceUsage(id, PROBE) === undefined,
    );
    expect(unpriced.sort()).toEqual([...UNPRICED].sort());
  });

  it('keeps the exception lists honest', () => {
    for (const id of PRICED_ON_FALLBACK) expect(id in PRICES_2026, id).toBe(true);
    for (const id of UNPRICED) expect(known(id), id).toBe(true);
    // A per-wire exception is priced, has a reason, and is pinned on the other wire.
    for (const [key, why] of Object.entries(PRICED_ON_FALLBACK_BY_WIRE)) {
      const [id, surface] = key.split('@') as [string, ModelSurface];
      expect(id in PRICES_2026, key).toBe(true);
      expect(why.length, key).toBeGreaterThan(0);
      const others = wiresOf(id).filter((wire) => wire !== surface);
      expect(others.length, key).toBeGreaterThan(0);
      for (const wire of others) expect(knownOn(id, wire), `${id}@${wire}`).toBe(true);
    }
  });
});
