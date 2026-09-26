import type { LanguageModel, EmbeddingModel, EmbeddingProvider } from './types/model';
import type { Reranker } from './rag';
import { attachConfig } from './internal/config-symbol';
import { createHostedReranker, type HostedRerankerSettings } from './internal/rerank-http';

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

/** Settings for {@link createVoyageReranker}. */
export type VoyageRerankerSettings = HostedRerankerSettings;

/** Voyage's recommended rerank model — the {@link createVoyageReranker} default. */
export const VOYAGE_RERANK_DEFAULT_MODEL = 'rerank-2.5';

/**
 * A `Reranker` (the `@deuz-sdk/core/rag` seam) backed by Voyage AI's
 * `POST /v1/rerank` cross-encoder (2.2). The candidates' `text` is sent as
 * `documents`; each returned `index` maps back to its original chunk, whose
 * `score` becomes Voyage's `relevance_score` (best first). Returns
 * `min(topN, topK)` chunks.
 *
 * Key precedence: `deps.keyProvider.getKey('voyage')` > `apiKey` > an
 * `AuthenticationError` before any request. Transport: `fetch` > `deps.fetch`.
 * HTTP failures map onto the usual `DeuzError` classes. One call, no retries.
 */
export function createVoyageReranker(settings: VoyageRerankerSettings = {}): Reranker {
  return createHostedReranker(
    {
      provider: 'voyage',
      defaultBaseURL: 'https://api.voyageai.com/v1',
      defaultModel: VOYAGE_RERANK_DEFAULT_MODEL,
      countField: 'top_k',
      results: (json) => (json as { data?: unknown } | null)?.data,
    },
    settings,
  );
}
