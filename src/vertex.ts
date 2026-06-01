import type { LanguageModel, Provider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * Google Vertex AI transports. Vertex hosts BOTH Anthropic Claude and Gemini,
 * but authenticates with a short-lived OAuth2 access token (not an API key) and
 * uses regional endpoints. So the same app can route Gemini through AI Studio
 * (`@deuz/core/google`) OR Vertex (`createVertexGoogle`), and Claude through the
 * direct Anthropic API (`@deuz/core/anthropic`) OR Vertex (`createVertexAnthropic`).
 *
 * Prefer a `deps.keyProvider` that refreshes the token (it expires ~hourly);
 * `accessToken` here is a convenience for a single short-lived call.
 */
export interface VertexSettings {
  project: string;
  location: string;
  /** OAuth2 access token (e.g. `gcloud auth print-access-token`). Short-lived. */
  accessToken?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

function vertexBase(location: string): string {
  return location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
}

/**
 * Anthropic Claude on Vertex AI. Reuses the Anthropic Messages wire (same SSE
 * parsing / error mapping); only the URL, auth (Bearer), and `anthropic_version`
 * placement differ. Model ids are the Vertex form, e.g. `claude-sonnet-4-5`.
 */
export function createVertexAnthropic(settings: VertexSettings): Provider {
  const { project, location } = settings;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'vertex-anthropic', modelId, surface: 'anthropic' },
      {
        provider: 'vertex-anthropic',
        apiKey: settings.accessToken,
        baseURL: vertexBase(location),
        fetch: settings.fetch,
        headers: settings.headers,
        vertex: { project, location },
      },
    );
}

/**
 * Gemini on Vertex AI via its OpenAI-compatible endpoint. Reuses the
 * Chat-Completions wire. Pass the model in Vertex form, e.g.
 * `google/gemini-2.5-flash`.
 */
export function createVertexGoogle(settings: VertexSettings): Provider {
  const { project, location } = settings;
  const baseURL = `${vertexBase(location)}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'vertex-google', modelId, surface: 'chat_completions' },
      {
        provider: 'vertex-google',
        apiKey: settings.accessToken,
        baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

/**
 * Gemini on Vertex AI via the NATIVE `generateContent` wire (full capabilities:
 * reasoning + thoughtSignature, structured output, grounding, native PDF/audio).
 * Reuses `google-native.ts` — the adapter sees `call.vertex` and builds the
 * Vertex URL (`…/projects/{p}/locations/{l}/publishers/google/models/{model}`)
 * with `Authorization: Bearer <OAuth2 token>` instead of `x-goog-api-key`.
 *
 * Pass the bare model id (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`). The OAuth2
 * access token is short-lived — prefer a `deps.keyProvider` that refreshes it
 * over the static `accessToken` convenience field.
 */
export function createVertexGoogleNative(settings: VertexSettings): Provider {
  const { project, location } = settings;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'vertex-google', modelId, surface: 'native' },
      {
        provider: 'vertex-google',
        apiKey: settings.accessToken,
        baseURL: vertexBase(location),
        fetch: settings.fetch,
        headers: settings.headers,
        vertex: { project, location },
      },
    );
}
