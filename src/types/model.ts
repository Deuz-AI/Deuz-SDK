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
