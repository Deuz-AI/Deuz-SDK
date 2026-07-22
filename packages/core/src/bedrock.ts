import type { LanguageModel, Provider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * Amazon Bedrock via the OpenAI-compatible **Mantle** endpoint
 * (`bedrock-mantle.{region}.api.aws`). Auth is a Bedrock API key / short-term
 * bearer token passed as `Authorization: Bearer` — no AWS SigV4 SDK, no
 * `node:` imports, edge-safe.
 *
 * Default root: `https://bedrock-mantle.{region}.api.aws/openai/v1`
 * (adapter appends `/chat/completions`). Override with `baseURL` if your
 * region documents `/v1` without the `/openai` segment.
 *
 * This is **not** the Bedrock Runtime Converse API. For Converse, use a
 * gateway or a future dedicated surface.
 */
export interface BedrockSettings {
  /**
   * Amazon Bedrock API key or short-term bearer token
   * (`AWS_BEARER_TOKEN_BEDROCK` / console long-term key). Core never reads env.
   */
  apiKey?: string;
  /** AWS region for the Mantle host. Default `us-east-1`. */
  region?: string;
  /** Full OpenAI-style root override (no trailing slash). */
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

const DEFAULT_REGION = 'us-east-1';

function defaultMantleBaseURL(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

/**
 * Amazon Bedrock (Mantle / OpenAI-compatible) provider factory.
 *
 * ```ts
 * import { createBedrock } from '@deuz-sdk/core/bedrock';
 *
 * const bedrock = createBedrock({
 *   apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK!,
 *   region: 'us-west-2',
 * });
 * const model = bedrock('openai.gpt-oss-120b');
 * ```
 */
export function createBedrock(settings: BedrockSettings = {}): Provider {
  const region = settings.region ?? DEFAULT_REGION;
  const baseURL = (settings.baseURL ?? defaultMantleBaseURL(region)).replace(/\/+$/, '');
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'bedrock', modelId, surface: 'chat_completions' },
      {
        provider: 'bedrock',
        apiKey: settings.apiKey,
        baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

/** Unbound default (`us-east-1` Mantle). Prefer `createBedrock({ region, apiKey })`. */
export const bedrock: Provider = createBedrock();
