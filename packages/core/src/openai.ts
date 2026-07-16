import type { LanguageModel, Provider, EmbeddingModel, EmbeddingProvider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * OpenAI provider. `openai(...)` targets Chat Completions; `openaiResponses(...)`
 * targets the Responses API (typed `response.*` events) where GPT-5.x
 * reasoning+tool lives.
 */
export interface OpenAISettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

function toConfig(settings: OpenAISettings) {
  return {
    provider: 'openai',
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    fetch: settings.fetch,
    headers: settings.headers,
  };
}

export function createOpenAI(settings: OpenAISettings = {}): Provider {
  return (modelId: string): LanguageModel =>
    attachConfig({ provider: 'openai', modelId, surface: 'chat_completions' }, toConfig(settings));
}

export function createOpenAIResponses(settings: OpenAISettings = {}): Provider {
  return (modelId: string): LanguageModel =>
    attachConfig({ provider: 'openai', modelId, surface: 'responses' }, toConfig(settings));
}

export const openai: Provider = createOpenAI();
export const openaiResponses: Provider = createOpenAIResponses();

/** OpenAI embedding-model factory (Faz 3): `text-embedding-3-small`/`-large`. */
export function createOpenAIEmbedding(settings: OpenAISettings = {}): EmbeddingProvider {
  return (modelId: string): EmbeddingModel =>
    attachConfig(
      { provider: 'openai', modelId, surface: 'openai-embeddings' } as unknown as LanguageModel,
      toConfig(settings),
    ) as unknown as EmbeddingModel;
}

export const openaiEmbedding: EmbeddingProvider = createOpenAIEmbedding();
