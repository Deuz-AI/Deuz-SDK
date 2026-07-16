import type { LanguageModel, Provider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * xAI Grok provider — OpenAI Chat Completions-compatible wire (reuses the
 * openai-compatible adapter with registry-driven quirk flags).
 */
export interface XaiSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createXai(settings: XaiSettings = {}): Provider {
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'xai', modelId, surface: 'chat_completions' },
      {
        provider: 'xai',
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

export const xai: Provider = createXai();
