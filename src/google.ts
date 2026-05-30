import type { LanguageModel, Provider } from './types/model';

/**
 * Google Gemini provider. Faz 1 uses the OpenAI-compat endpoint
 * (`…/v1beta/openai/`) as a *limited-capability* surface (no reasoning /
 * explicit cache / native PDF/audio). The native `generateContent` surface
 * arrives in Faz 3.
 */
export interface GoogleSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createGoogle(settings: GoogleSettings = {}): Provider {
  void settings;
  return (modelId: string): LanguageModel => ({
    provider: 'google',
    modelId,
    surface: 'chat_completions',
  });
}

export const google: Provider = createGoogle();
