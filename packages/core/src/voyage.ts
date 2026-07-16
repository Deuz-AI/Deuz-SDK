import type { LanguageModel, EmbeddingModel, EmbeddingProvider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * Voyage AI embedding provider (Faz 3, optional catalog). Retrieval-focused
 * embeddings with an `input_type` (query/document) hint. Behind its own
 * subpath export so it never adds weight to the default bundle.
 */
export interface VoyageSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createVoyage(settings: VoyageSettings = {}): EmbeddingProvider {
  return (modelId: string): EmbeddingModel =>
    attachConfig(
      { provider: 'voyage', modelId, surface: 'voyage-embeddings' } as unknown as LanguageModel,
      {
        provider: 'voyage',
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    ) as unknown as EmbeddingModel;
}

export const voyage: EmbeddingProvider = createVoyage();
