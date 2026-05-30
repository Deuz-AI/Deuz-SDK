import type { LanguageModel, Provider } from './types/model';

/**
 * OpenAI provider. `openai(...)` targets Chat Completions; `openaiResponses(...)`
 * targets the Responses API (typed `response.*` events) where GPT-5.x
 * reasoning+tool lives. Wire adapters land in Faz 1.B.
 */
export interface OpenAISettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createOpenAI(settings: OpenAISettings = {}): Provider {
  void settings;
  return (modelId: string): LanguageModel => ({
    provider: 'openai',
    modelId,
    surface: 'chat_completions',
  });
}

export function createOpenAIResponses(settings: OpenAISettings = {}): Provider {
  void settings;
  return (modelId: string): LanguageModel => ({
    provider: 'openai',
    modelId,
    surface: 'responses',
  });
}

export const openai: Provider = createOpenAI();
export const openaiResponses: Provider = createOpenAIResponses();
