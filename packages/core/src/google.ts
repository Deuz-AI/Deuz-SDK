import type { LanguageModel, Provider, EmbeddingModel, EmbeddingProvider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * Google Gemini provider. `createGoogle` defaults to the OpenAI-compat endpoint
 * (`…/v1beta/openai/`) — a *limited-capability* surface (no reasoning / explicit
 * cache / native PDF/audio; usage-per-chunk quirk). Pass `surface:'native'` (or
 * use `createGoogleNative`) for the full `generateContent` wire (Faz 3):
 * reasoning + thoughtSignature, structured output, grounding, native PDF/audio.
 */
export interface GoogleSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Wire to target. Default 'chat_completions' (compat). 'native' = generateContent. */
  surface?: 'native' | 'chat_completions';
}

/** Native generateContent base; compat uses the resolve-call default ('…/v1beta/openai'). */
const NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com';

export function createGoogle(settings: GoogleSettings = {}): Provider {
  const surface = settings.surface ?? 'chat_completions';
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'google', modelId, surface },
      {
        provider: 'google',
        apiKey: settings.apiKey,
        // Native wire needs the bare host (adapter appends /v1beta/models/...).
        baseURL: settings.baseURL ?? (surface === 'native' ? NATIVE_BASE_URL : undefined),
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

/** Convenience: Gemini on the native `generateContent` wire (full capabilities). */
export function createGoogleNative(settings: GoogleSettings = {}): Provider {
  return createGoogle({ ...settings, surface: 'native' });
}

export const google: Provider = createGoogle();
export const googleNative: Provider = createGoogleNative();

/** Google Gemini embedding-model factory (Faz 3): `gemini-embedding-001` / `text-embedding-004`. */
export function createGoogleEmbedding(settings: GoogleSettings = {}): EmbeddingProvider {
  return (modelId: string): EmbeddingModel =>
    attachConfig(
      { provider: 'google', modelId, surface: 'gemini-embeddings' } as unknown as LanguageModel,
      {
        provider: 'google',
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    ) as unknown as EmbeddingModel;
}

export const googleEmbedding: EmbeddingProvider = createGoogleEmbedding();
