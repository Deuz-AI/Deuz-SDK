/**
 * `@deuz-sdk/core/providers` (1.8.0) — the OpenAI-Chat-Completions-compatible
 * provider factories PLUS a tiny string-lookup model router.
 *
 * The factories (Groq, Mistral, DeepSeek, Together, OpenRouter, Cerebras,
 * Fireworks, Moonshot/Kimi, Qwen, GLM, MiniMax) live in `providers-compat.ts`.
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

export type { CompatSettings } from './providers-compat';
export {
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
