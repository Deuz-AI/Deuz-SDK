/**
 * image.ts — synchronous image generation (Faz 4).
 *
 * OpenAI-compatible `POST /v1/images/generations` wire (DALL·E, Flux, SD,
 * Recraft, Ideogram, … via OpenAI or an OpenAI-compatible relay such as Yunwu).
 * PURE + edge-safe: HTTP goes through the injected `deps.fetch`, the API key
 * through `deps.keyProvider` / factory config / `ClientConfig.apiKeys` — never
 * read from the environment, never hardcoded. The async Midjourney-proxy path
 * (submit/poll/webhook) lands separately.
 */
import type { LanguageModel } from './types/model';
import type { Dependencies, ResolvedDependencies } from './types/deps';
import { attachConfig, readConfig } from './internal/config-symbol';
import { readClientContext, type ClientContext } from './internal/client-context';
import { resolveDependencies } from './internal/resolve-deps';
import { parseRetryAfterMs } from './internal/http';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  OverloadedError,
  RateLimitError,
  type DeuzError,
} from './errors';

/** An image model descriptor — separate kind from chat `LanguageModel`. */
export interface ImageModel {
  readonly provider: string;
  readonly modelId: string;
  readonly surface: 'images';
}

export type ImageProvider = (modelId: string) => ImageModel;

export interface ImageProviderSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Logical provider id used for key/baseURL resolution. Default 'openai'. */
  provider?: string;
}

/**
 * Generic OpenAI-compatible image provider factory. The descriptor carries the
 * factory settings on a private symbol (same trick as the chat providers) so the
 * public `ImageModel` shape stays clean and the key never leaks via enumeration.
 */
export function createImageProvider(settings: ImageProviderSettings = {}): ImageProvider {
  const provider = settings.provider ?? 'openai';
  return (modelId: string): ImageModel =>
    attachConfig({ provider, modelId, surface: 'images' } as unknown as LanguageModel, {
      provider,
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      fetch: settings.fetch,
      headers: settings.headers,
    }) as unknown as ImageModel;
}

export interface GenerateImageOptions {
  model: ImageModel;
  prompt: string;
  /** Number of images (provider-dependent; DALL·E 3 only supports 1). */
  n?: number;
  /** e.g. '1024x1024', '1792x1024'. */
  size?: string;
  /** e.g. 'standard' | 'hd' (DALL·E 3). */
  quality?: string;
  /** e.g. 'vivid' | 'natural' (DALL·E 3). */
  style?: string;
  /** 'url' (default) or 'b64_json'. */
  responseFormat?: 'url' | 'b64_json';
  signal?: AbortSignal;
  headers?: Record<string, string>;
  deps?: Dependencies;
}

export interface GeneratedImage {
  /** Hosted URL (when responseFormat is 'url'). */
  url?: string;
  /** Base64-encoded image bytes (when responseFormat is 'b64_json'). */
  b64Json?: string;
  /** Provider-revised prompt, when returned (DALL·E 3). */
  revisedPrompt?: string;
}

export interface GenerateImageResult {
  images: GeneratedImage[];
  /** The raw provider response (for provider-specific extras). */
  raw: unknown;
}

const DEFAULT_IMAGE_BASE_URL = 'https://api.openai.com/v1';

async function resolveImageCall(
  model: ImageModel,
  deps: ResolvedDependencies,
  headers: Record<string, string> | undefined,
  clientContext: ClientContext | undefined,
): Promise<{
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
}> {
  const config = readConfig(model as never) as
    | { apiKey?: string; baseURL?: string; fetch?: typeof fetch; headers?: Record<string, string> }
    | undefined;

  let apiKey: string | undefined;
  if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(model.provider)) ?? undefined;
  if (!apiKey) apiKey = config?.apiKey;
  if (!apiKey) {
    apiKey = clientContext?.apiKeys?.[
      model.provider as keyof NonNullable<typeof clientContext>['apiKeys']
    ] as string | undefined;
  }
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for image provider '${model.provider}'. Pass it to the factory, ClientConfig.apiKeys, or a deps.keyProvider.`,
      provider: model.provider,
    });
  }

  const baseURLRaw =
    config?.baseURL ?? clientContext?.baseUrls?.[model.provider] ?? DEFAULT_IMAGE_BASE_URL;

  return {
    apiKey,
    baseURL: baseURLRaw.replace(/\/+$/, ''),
    headers: { ...config?.headers, ...headers },
    fetch: config?.fetch ?? deps.fetch,
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function mapError(provider: string, status: number, body: unknown, headers: Headers): DeuzError {
  const envelope = (body ?? {}) as {
    error?: { message?: string; type?: string; code?: string } | string;
  };
  const errObj = typeof envelope.error === 'object' ? envelope.error : undefined;
  const message =
    errObj?.message ??
    (typeof envelope.error === 'string' ? envelope.error : undefined) ??
    `Image request failed (HTTP ${status}).`;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = { message, provider, upstreamType: errObj?.type ?? errObj?.code, retryAfterMs };

  if (status === 401 || status === 403)
    return new AuthenticationError({ ...base, statusCode: status });
  if (status === 404) return new ModelNotFoundError({ ...base, statusCode: 404 });
  if (status === 429) return new RateLimitError({ ...base, statusCode: 429 });
  if (status === 529) return new OverloadedError({ ...base, statusCode: 529 });
  if (status >= 400 && status < 500)
    return new InvalidRequestError({ ...base, statusCode: status });
  return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
}

interface OpenAIImageResponse {
  data?: { url?: string; b64_json?: string; revised_prompt?: string }[];
}

/** Generate one or more images via the OpenAI-compatible images endpoint. */
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const deps = resolveDependencies(options.deps);
  const clientContext = readClientContext(options);
  const {
    apiKey,
    baseURL,
    headers,
    fetch: fetchImpl,
  } = await resolveImageCall(options.model, deps, options.headers, clientContext);

  const body: Record<string, unknown> = {
    model: options.model.modelId,
    prompt: options.prompt,
    n: options.n ?? 1,
  };
  if (options.size) body.size = options.size;
  if (options.quality) body.quality = options.quality;
  if (options.style) body.style = options.style;
  if (options.responseFormat) body.response_format = options.responseFormat;

  const response = await fetchImpl(`${baseURL}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    throw mapError(
      options.model.provider,
      response.status,
      await readErrorBody(response),
      response.headers,
    );
  }

  const json = (await response.json()) as OpenAIImageResponse;
  const images: GeneratedImage[] = (json.data ?? []).map((d) => ({
    ...(d.url ? { url: d.url } : {}),
    ...(d.b64_json ? { b64Json: d.b64_json } : {}),
    ...(d.revised_prompt ? { revisedPrompt: d.revised_prompt } : {}),
  }));

  return { images, raw: json };
}
