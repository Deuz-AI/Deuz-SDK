import type { LanguageModel, ModelSurface } from '../types/model';
import type { ResolvedDependencies } from '../types/deps';
import { AuthenticationError, InvalidRequestError } from '../errors';
import { readConfig, type ProviderConfig, type VertexConfig } from './config-symbol';
import type { ClientContext } from './client-context';

/** Everything a wire adapter needs to issue a request, fully resolved. */
export interface ResolvedCall {
  provider: string;
  modelId: string;
  surface: ModelSurface;
  apiKey: string;
  /** Provider root URL (no trailing slash). Adapter appends the wire path. */
  baseURL: string;
  fetch: typeof fetch;
  /** Caller + factory headers merged (adapter adds auth/version on top). */
  headers: Record<string, string>;
  /** Set for Vertex AI transports — adapters build Vertex URLs/bodies + Bearer auth. */
  vertex?: VertexConfig;
  /** Extra query params for the final wire URL (Azure `api-version`, …). */
  query?: Record<string, string>;
  /** OpenAI-compatible auth style; default bearer when omitted. */
  authHeader?: 'bearer' | 'api-key';
}

/** Wire root URLs. Anthropic appends `/v1/messages`; OpenAI-style already includes `/v1`. */
const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  // OpenAI-compatible hosts (providers-compat.ts) — all speak Chat Completions.
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  together: 'https://api.together.xyz/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  minimax: 'https://api.minimax.io/v1',
};

export interface ResolveCallInput {
  model: LanguageModel;
  deps: ResolvedDependencies;
  /** Caller-level headers (highest precedence). */
  headers?: Record<string, string>;
  /** Client-bound apiKeys/baseUrls (lowest-priority key/url source). */
  clientContext?: ClientContext;
}

/**
 * Merge factory settings (symbol), deps, and client config into a `ResolvedCall`.
 * Async because `keyProvider.getKey` may be async. Key precedence (G1):
 *   deps.keyProvider (if the user actually supplied one) >
 *   factory `apiKey` > ClientConfig.apiKeys[provider] > throw.
 */
export async function resolveCall(input: ResolveCallInput): Promise<ResolvedCall> {
  const { model, deps, headers, clientContext } = input;
  const { provider, modelId, surface } = model;
  const config: ProviderConfig | undefined = readConfig(model);

  // --- API key (precedence: user keyProvider > factory > apiKeys table) ---
  let apiKey: string | undefined;
  if (deps.keyProvider) {
    apiKey = (await deps.keyProvider.getKey(provider)) ?? undefined;
  }
  if (!apiKey) apiKey = config?.apiKey;
  if (!apiKey)
    apiKey = clientContext?.apiKeys?.[provider as keyof NonNullable<ClientContext['apiKeys']>];
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for provider '${provider}'. Pass it to the factory (e.g. create${provider}({ apiKey })), via ClientConfig.apiKeys, or a deps.keyProvider.`,
      provider,
    });
  }

  // --- baseURL (precedence: factory > ClientConfig.baseUrls > wire default) ---
  const baseURLRaw =
    config?.baseURL ?? clientContext?.baseUrls?.[provider] ?? DEFAULT_BASE_URL[provider];
  if (!baseURLRaw) {
    throw new InvalidRequestError({
      message: `No base URL for provider '${provider}'.`,
      provider,
    });
  }
  const baseURL = baseURLRaw.replace(/\/+$/, '');

  // --- fetch (precedence: factory > resolved deps) ---
  const fetchImpl = config?.fetch ?? deps.fetch;

  // --- headers (factory lowest, caller highest; auth added by the adapter) ---
  const mergedHeaders: Record<string, string> = { ...config?.headers, ...headers };

  return {
    provider,
    modelId,
    surface,
    apiKey,
    baseURL,
    fetch: fetchImpl,
    headers: mergedHeaders,
    ...(config?.vertex ? { vertex: config.vertex } : {}),
    ...(config?.query ? { query: config.query } : {}),
    ...(config?.authHeader ? { authHeader: config.authHeader } : {}),
  };
}
