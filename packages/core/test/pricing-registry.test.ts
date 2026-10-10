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

const SURFACES: ModelSurface[] = ['anthropic', 'chat_completions', 'responses', 'native'];
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
 * Registry models without a verified price: explicitly unknown. Under a USD
 * budget they warn and run (decision 4), or are refused with
 * `unknownPrice: 'reject'`.
 */
const UNPRICED = new Set([
  'gemini-3.8-flash',
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

/** A slug the chat registry answers with a pinned or family row on some wire. */
function known(modelId: string): boolean {
  return SURFACES.some(
    (surface) => registryMatch({ provider: 'x', surface, modelId }) !== 'fallback',
  );
}

describe('price table and registry agree (F19)', () => {
  it('knows every priced chat model, or lists why it does not', () => {
    const unknown = Object.keys(PRICES_2026).filter((id) => {
      if (id in EMBEDDINGS) return false;
      // A row the registry knows under an alias (mistral-large-latest → mistral-large).
      const aliases = Object.keys(PRICE_ALIASES).filter((alias) => PRICE_ALIASES[alias] === id);
      return ![id, ...aliases].some(known);
    });
    expect(unknown.sort()).toEqual([...PRICED_ON_FALLBACK].sort());
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

  it('keeps both exception lists honest', () => {
    for (const id of PRICED_ON_FALLBACK) expect(id in PRICES_2026, id).toBe(true);
    for (const id of UNPRICED) expect(known(id), id).toBe(true);
  });
});
