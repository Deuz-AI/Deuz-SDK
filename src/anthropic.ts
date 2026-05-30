import type { LanguageModel, Provider } from './types/model';

/**
 * Anthropic Messages (`/v1/messages`) provider. The wire adapter + SSE handling
 * land in Faz 1.B; Faz 0 returns a `LanguageModel` descriptor.
 */
export interface AnthropicSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createAnthropic(settings: AnthropicSettings = {}): Provider {
  void settings;
  return (modelId: string): LanguageModel => ({
    provider: 'anthropic',
    modelId,
    surface: 'anthropic',
  });
}

/** Default Anthropic provider (api key supplied via call-level deps.keyProvider). */
export const anthropic: Provider = createAnthropic();
