/**
 * A `LanguageModel` is the descriptor returned by a provider factory
 * (e.g. `anthropic('claude-opus-4-8')`). In Faz 0 it only carries identity +
 * the wire surface; the real adapter is attached in Faz 1.B.
 */
export type ModelSurface = 'anthropic' | 'chat_completions' | 'responses' | 'native';

export interface LanguageModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: ModelSurface;
}

/** Provider factory: maps a model id to a `LanguageModel` descriptor. */
export type Provider = (modelId: string) => LanguageModel;

/**
 * Embedding models are a SEPARATE kind from `LanguageModel` (Faz 3). Keeping
 * them distinct means an embedding model can never be passed to `generateText`
 * /`streamChat` at the type level, and vice-versa. The wire surface tells the
 * embed adapter which request/response shape to speak.
 */
export type EmbeddingModelSurface = 'openai-embeddings' | 'gemini-embeddings' | 'voyage-embeddings';

export interface EmbeddingModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: EmbeddingModelSurface;
}

/** Embedding-provider factory: maps a model id to an `EmbeddingModel` descriptor. */
export type EmbeddingProvider = (modelId: string) => EmbeddingModel;
