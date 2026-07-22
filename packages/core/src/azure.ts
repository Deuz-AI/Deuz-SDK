import type { LanguageModel, Provider } from './types/model';
import { InvalidRequestError } from './errors';
import { attachConfig } from './internal/config-symbol';

/**
 * Azure OpenAI / Azure AI Foundry (OpenAI-compatible Chat Completions wire).
 *
 * Classic Azure OpenAI URLs are deployment-scoped:
 * `https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=…`
 * The `modelId` passed to the provider IS the deployment name. Auth defaults to
 * the `api-key` header (not Bearer); set `auth: 'bearer'` for Entra ID tokens.
 *
 * For Azure AI Foundry or a custom gateway, pass `baseURL` pointing at the
 * OpenAI-style root (adapter still appends `/chat/completions`).
 */
export interface AzureSettings {
  apiKey?: string;
  /**
   * Azure OpenAI resource name (`https://{resource}.openai.azure.com`).
   * Required unless `baseURL` is set.
   */
  resourceName?: string;
  /**
   * `api-version` query param. Default `2024-12-01-preview`.
   * Azure requires this on every request.
   */
  apiVersion?: string;
  /**
   * Full OpenAI-style root override (no trailing slash). When set,
   * `resourceName` is ignored — use this for Foundry / proxies. For a
   * deployment-scoped classic URL without `resourceName`, pass
   * `https://{resource}.openai.azure.com/openai/deployments/{deployment}` and
   * call the provider with that same deployment as `modelId` (body `model`
   * still carries the slug).
   */
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * `'api-key'` (default) — Azure API key header.
   * `'bearer'` — `Authorization: Bearer` (Microsoft Entra ID access token).
   */
  auth?: 'api-key' | 'bearer';
}

const DEFAULT_API_VERSION = '2024-12-01-preview';

function toAzureBaseURL(settings: AzureSettings, deployment: string): string {
  if (settings.baseURL) return settings.baseURL.replace(/\/+$/, '');
  if (settings.resourceName) {
    return `https://${settings.resourceName}.openai.azure.com/openai/deployments/${deployment}`;
  }
  throw new InvalidRequestError({
    message:
      'createAzure requires `resourceName` (classic Azure OpenAI) or `baseURL` (Foundry / proxy).',
    provider: 'azure',
  });
}

/**
 * Azure OpenAI provider factory. The argument to the returned `Provider` is the
 * **deployment name** (not necessarily the underlying model slug).
 *
 * ```ts
 * import { createAzure } from '@deuz-sdk/core/azure';
 *
 * const azure = createAzure({
 *   apiKey: process.env.AZURE_OPENAI_API_KEY!,
 *   resourceName: 'my-resource',
 * });
 * const model = azure('gpt-4o'); // deployment name
 * ```
 */
export function createAzure(settings: AzureSettings = {}): Provider {
  return (deployment: string): LanguageModel =>
    attachConfig(
      { provider: 'azure', modelId: deployment, surface: 'chat_completions' },
      {
        provider: 'azure',
        apiKey: settings.apiKey,
        baseURL: toAzureBaseURL(settings, deployment),
        fetch: settings.fetch,
        headers: settings.headers,
        query: { 'api-version': settings.apiVersion ?? DEFAULT_API_VERSION },
        authHeader: settings.auth ?? 'api-key',
      },
    );
}

/**
 * Unbound default instance — supply the key via `createClient` `apiKeys.azure`,
 * `deps.keyProvider`, or prefer `createAzure({ … })` so `resourceName`/`baseURL`
 * are bound (unbound calls still need a `baseURL` from client context).
 */
export const azure: Provider = createAzure();
