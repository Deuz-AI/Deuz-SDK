import type { LanguageModel, Provider } from './types/model';

/**
 * xAI Grok provider — OpenAI Chat Completions-compatible wire. Wire adapter
 * reuses the OpenAI-CC path in Faz 1.B.
 */
export interface XaiSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createXai(settings: XaiSettings = {}): Provider {
  void settings;
  return (modelId: string): LanguageModel => ({
    provider: 'xai',
    modelId,
    surface: 'chat_completions',
  });
}

export const xai: Provider = createXai();
