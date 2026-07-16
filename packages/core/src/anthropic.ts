import type { LanguageModel, Provider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * Anthropic Messages (`/v1/messages`) provider. The factory settings are stashed
 * on the descriptor via a private Symbol (see config-symbol) so the inference
 * layer can resolve the key/baseURL without changing the locked descriptor shape.
 */
export interface AnthropicSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createAnthropic(settings: AnthropicSettings = {}): Provider {
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'anthropic', modelId, surface: 'anthropic' },
      {
        provider: 'anthropic',
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

/** Default Anthropic provider (api key supplied via call-level deps.keyProvider). */
export const anthropic: Provider = createAnthropic();
