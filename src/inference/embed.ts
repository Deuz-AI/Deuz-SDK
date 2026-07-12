import type {
  Embed,
  EmbedMany,
  EmbedOptions,
  EmbedManyOptions,
  EmbedResult,
  EmbedManyResult,
} from '../types/methods';
import type { EmbeddingModel, EmbeddingModelSurface } from '../types/model';
import type { ResolvedDependencies } from '../types/deps';
import type { Usage } from '../types/usage';
import type { EmbeddingCall, EmbeddingAdapter } from '../adapters/embeddings';
import { getEmbeddingAdapter } from '../adapters/embeddings';
import { getEmbeddingCapabilities, type EmbeddingCapabilities } from '../core/registry';
import { embeddingUsage, fireUsage } from '../core/metering';
import { resolveDependencies } from '../internal/resolve-deps';
import {
  attachClientContext,
  readClientContext,
  type ClientContext,
} from '../internal/client-context';
import { readConfig } from '../internal/config-symbol';
import { mapWithConcurrency } from '../internal/p-limit';
import { parseRetryAfterMs } from '../internal/http';
import {
  AbortError,
  AuthenticationError,
  InvalidRequestError,
  NetworkError,
  UnsupportedCapabilityError,
} from '../errors';

const DEFAULT_EMBEDDING_BASE_URL: Record<EmbeddingModelSurface, string> = {
  'openai-embeddings': 'https://api.openai.com/v1',
  'gemini-embeddings': 'https://generativelanguage.googleapis.com/v1beta',
  'voyage-embeddings': 'https://api.voyageai.com/v1',
};

/** Read a non-2xx response body as JSON, falling back to text (for mapError). */
async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Resolve an embedding call (key / baseURL / headers) — the embedding analogue of resolveCall. */
async function resolveEmbeddingCall(
  model: EmbeddingModel,
  deps: ResolvedDependencies,
  headers: Record<string, string> | undefined,
  clientContext: ClientContext | undefined,
): Promise<{ call: EmbeddingCall; fetch: typeof fetch }> {
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
      message: `No API key for embedding provider '${model.provider}'. Pass it to the factory, ClientConfig.apiKeys, or a deps.keyProvider.`,
      provider: model.provider,
    });
  }

  const baseURLRaw =
    config?.baseURL ??
    clientContext?.baseUrls?.[model.provider] ??
    DEFAULT_EMBEDDING_BASE_URL[model.surface];
  if (!baseURLRaw) {
    throw new InvalidRequestError({
      message: `No base URL for embedding provider '${model.provider}'.`,
    });
  }

  return {
    call: {
      provider: model.provider,
      modelId: model.modelId,
      apiKey,
      baseURL: baseURLRaw.replace(/\/+$/, ''),
      headers: { ...config?.headers, ...headers },
    },
    fetch: config?.fetch ?? deps.fetch,
  };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function hashToUnit(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h % 1000) / 1000;
}

/** One sub-batch request with pre-response retry (exp backoff + full jitter, Retry-After honored). */
async function fetchBatch(
  adapter: EmbeddingAdapter,
  call: EmbeddingCall,
  fetchImpl: typeof fetch,
  values: string[],
  opts: EmbedManyOptions,
  caps: EmbeddingCapabilities,
  deps: ResolvedDependencies,
  signal: AbortSignal | undefined,
): Promise<{ vectors: number[][]; tokens?: number }> {
  const built = adapter.buildRequest({ call, values, opts, caps });
  const maxRetries = opts.maxRetries ?? 2;
  let attempt = 0;

  for (;;) {
    if (signal?.aborted) throw new AbortError();
    let response: Response;
    try {
      response = await fetchImpl(built.url, { ...built.init, signal });
    } catch (err) {
      if (signal?.aborted) throw new AbortError(undefined, { cause: err });
      if (attempt >= maxRetries) {
        throw new NetworkError({
          message: `Embedding network request to provider '${call.provider}' failed.`,
          provider: call.provider,
          upstreamType: err instanceof Error ? err.name : typeof err,
        });
      }
      await delay(attempt, undefined, deps);
      attempt++;
      continue;
    }

    if (response.ok) {
      const json = await response.json().catch(() => ({}));
      return adapter.parseResponse(json, caps);
    }

    if (!RETRYABLE.has(response.status) || attempt >= maxRetries) {
      const body = await readErrorBody(response);
      throw adapter.mapError(response.status, body, response.headers);
    }
    const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'), deps.clock.now());
    await delay(attempt, retryAfter, deps);
    attempt++;
  }
}

function delay(
  attempt: number,
  retryAfterMs: number | undefined,
  deps: ResolvedDependencies,
): Promise<void> {
  const exp = Math.min(30_000, 500 * 2 ** attempt);
  const ms = retryAfterMs ?? Math.floor(exp * hashToUnit(deps.generateId()));
  return new Promise((resolve) => deps.clock.setTimeout(() => resolve(), ms));
}

/** Pure L2 normalization (edge-safe). */
function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export const embedMany: EmbedMany = async (options: EmbedManyOptions): Promise<EmbedManyResult> => {
  const deps = resolveDependencies(options.deps);
  const clientContext = readClientContext(options);
  const caps = getEmbeddingCapabilities(options.model, deps.logger);

  // Guard BEFORE any network call — xAI / non-embedding slugs never fall through.
  if (!caps.embedding || options.model.provider === 'xai') {
    throw new UnsupportedCapabilityError({
      provider: options.model.provider,
      capability: 'embedding',
      modelId: options.model.modelId,
    });
  }

  if (options.values.length === 0) {
    // Still fire usage exactly once (G10) so the credit/metering hook is never
    // skipped — even for a zero-input call.
    const usage = embeddingUsage(0);
    fireUsage(options as never, deps, usage, { model: options.model.modelId, reason: 'finished' });
    return { embeddings: [], usage };
  }

  const { call, fetch: fetchImpl } = await resolveEmbeddingCall(
    options.model,
    deps,
    options.headers,
    clientContext,
  );
  const adapter = getEmbeddingAdapter(options.model.surface);

  // Split into sub-batches of (override ?? caps.embeddingMaxBatch).
  const batchSize = Math.max(1, options.maxBatchSize ?? caps.embeddingMaxBatch);
  const batches: string[][] = [];
  for (let i = 0; i < options.values.length; i += batchSize) {
    batches.push(options.values.slice(i, i + batchSize));
  }

  const results = await mapWithConcurrency(batches, options.maxConcurrency ?? 5, (batch) =>
    fetchBatch(adapter, call, fetchImpl, batch, options, caps, deps, options.signal),
  );

  // Concatenate in original order; sum tokens across sub-batches.
  const embeddings: number[][] = [];
  let totalTokens = 0;
  let sawTokens = false;
  for (const r of results) {
    for (const vec of r.vectors) embeddings.push(options.normalize ? l2normalize(vec) : vec);
    if (r.tokens !== undefined) {
      totalTokens += r.tokens;
      sawTokens = true;
    }
  }

  const usage: Usage = embeddingUsage(sawTokens ? totalTokens : undefined);
  fireUsage(options as never, deps, usage, { model: options.model.modelId, reason: 'finished' });

  return { embeddings, usage };
};

export const embed: Embed = async (options: EmbedOptions): Promise<EmbedResult> => {
  const { value, ...rest } = options;
  const manyOptions: EmbedManyOptions = { ...rest, values: [value] };
  // Spread copies only enumerable props — the client-context Symbol is
  // non-enumerable, so re-attach it or `client.embed` loses its client-level
  // apiKeys/baseUrls (G1) on the way into embedMany.
  const clientContext = readClientContext(options);
  if (clientContext) attachClientContext(manyOptions, clientContext);
  const { embeddings, usage } = await embedMany(manyOptions);
  return { embedding: embeddings[0] ?? [], usage };
};
