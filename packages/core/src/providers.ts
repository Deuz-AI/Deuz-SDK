/**
 * `@deuz-sdk/core/providers` (2.0) — the OpenAI-Chat-Completions-compatible
 * provider factories PLUS a tiny string-lookup model router.
 *
 * The factories live in `providers-compat.ts`, in three groups:
 *
 * - **cloud hosts** — Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras,
 *   Fireworks, Moonshot/Kimi, Qwen, GLM, MiniMax, and 2.0's Perplexity, Cohere,
 *   DeepInfra, NVIDIA NIM, SambaNova, Hyperbolic;
 * - **keyless local hosts** (2.0) — Ollama and LM Studio, which dial
 *   `localhost` and need no API key at all (see `providers/local.mdx`);
 * - the generic `createOpenAICompatible({ id, … })` (1.9) for any host with no
 *   named factory — a self-hosted vLLM, an internal gateway — which carries
 *   YOUR provider id instead of borrowing an unrelated factory's.
 *
 * Dedicated Azure OpenAI + Amazon Bedrock (Mantle) factories live in
 * `./azure` and `./bedrock` and are re-exported here for the registry.
 * This module also adds `createProviderRegistry`, so a caller can resolve
 * `'groq:llama-4-maverick'` into a `LanguageModel` descriptor the same way
 * Mastra/Vercel expose a unified model router — but with ZERO network and no
 * hosted gateway: it is a pure descriptor lookup over factories YOU wire up.
 *
 * Edge-safe by construction (only descriptor assembly; no node builtins).
 */
import type { LanguageModel, Provider } from './types/model';
import { InvalidRequestError, ModelNotFoundError } from './errors';

export type { CompatSettings, OpenAICompatibleSettings } from './providers-compat';
export {
  createOpenAICompatible,
  createGroq,
  groq,
  createMistral,
  mistral,
  createDeepSeek,
  deepseek,
  createTogether,
  together,
  createOpenRouter,
  openrouter,
  createCerebras,
  cerebras,
  createFireworks,
  fireworks,
  createMoonshot,
  moonshot,
  createKimi,
  kimi,
  createQwen,
  qwen,
  createGLM,
  glm,
  createMiniMax,
  minimax,
} from './providers-compat';
// 2.0 — six more cloud hosts. (Kept in its own statement, not folded into the
// list above: `tooling/verify-docs.mjs` builds the public symbol table by
// regex, and a comment INSIDE the braces swallows the name that follows it.)
export {
  createPerplexity,
  perplexity,
  createCohere,
  cohere,
  createDeepInfra,
  deepinfra,
  createNvidia,
  nvidia,
  createSambaNova,
  sambanova,
  createHyperbolic,
  hyperbolic,
} from './providers-compat';
// 2.0 — keyless local hosts (see `providers/local.mdx`).
export { createOllama, ollama, createLMStudio, lmstudio } from './providers-compat';
export { createAzure, azure, type AzureSettings } from './azure';
export { createBedrock, bedrock, type BedrockSettings } from './bedrock';

/** A resolved string-lookup model router over a fixed set of providers. */
export interface ProviderRegistry {
  /**
   * Resolve a `'<provider><separator><modelId>'` spec into a `LanguageModel`.
   * Only the FIRST separator splits, so slash-namespaced model ids survive
   * (`'openrouter:meta-llama/llama-4-maverick'`). Unknown provider ids throw a
   * `ModelNotFoundError`; a missing/empty modelId throws `InvalidRequestError`.
   */
  model(spec: string): LanguageModel;
  /** The registered provider ids, in insertion order. */
  readonly providers: readonly string[];
}

export interface CreateProviderRegistryOptions {
  /** Separator between provider id and model id. Default `':'`. */
  separator?: string;
}

/**
 * Build a string-lookup model router from a map of provider ids to factories.
 * Pure and synchronous — nothing is dialed until you actually stream/generate:
 *
 * ```ts
 * import { createProviderRegistry, createGroq } from '@deuz-sdk/core/providers';
 * import { createOpenAI } from '@deuz-sdk/core/openai';
 *
 * const registry = createProviderRegistry({
 *   groq: createGroq({ apiKey: process.env.GROQ_API_KEY! }),
 *   openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY! }),
 * });
 *
 * const model = registry.model('groq:llama-4-maverick');
 * ```
 */
export function createProviderRegistry(
  providers: Record<string, Provider>,
  options: CreateProviderRegistryOptions = {},
): ProviderRegistry {
  const separator = options.separator ?? ':';
  if (separator.length === 0) {
    throw new InvalidRequestError({ message: 'Provider-registry separator must be non-empty.' });
  }
  const ids = Object.keys(providers);
  return {
    providers: ids,
    model(spec: string): LanguageModel {
      const cut = spec.indexOf(separator);
      if (cut === -1) {
        throw new InvalidRequestError({
          message: `Model spec '${spec}' must be '<provider>${separator}<modelId>'. Known providers: ${ids.join(', ') || '(none)'}.`,
        });
      }
      const providerId = spec.slice(0, cut);
      const modelId = spec.slice(cut + separator.length);
      const factory = providers[providerId];
      if (!factory) {
        throw new ModelNotFoundError({
          provider: providerId,
          message: `Unknown provider '${providerId}' in '${spec}'. Known providers: ${ids.join(', ') || '(none)'}.`,
        });
      }
      if (modelId.length === 0) {
        throw new InvalidRequestError({
          provider: providerId,
          message: `Empty model id in spec '${spec}'.`,
        });
      }
      return factory(modelId);
    },
  };
}
