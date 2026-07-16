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
  createObservationRuntime,
  observeCost,
  counterFields,
  type ObservationRuntime,
} from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';
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

/**
 * Observation (1.6): `embed()` delegates to `embedMany()` — mark the wrapped
 * options so exactly ONE run is emitted, labeled with the original operation.
 * Module-local symbol: never enumerable, never public.
 */
const EMBED_OPERATION = Symbol('deuz.observe.embedOperation');

function readEmbedOperation(options: EmbedManyOptions): 'embed' | 'embed-many' {
  const marked = (options as unknown as Record<PropertyKey, unknown>)[EMBED_OPERATION];
  return marked === 'embed' ? 'embed' : 'embed-many';
}

function hashToUnit(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h % 1000) / 1000;
}

/** Retry correlation for embed batches (observation is optional — fast path passes undefined). */
interface EmbedObserve {
  rt: ObservationRuntime;
  spanId: string;
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
  observe: EmbedObserve | undefined,
): Promise<{ vectors: number[][]; tokens?: number }> {
  const built = adapter.buildRequest({ call, values, opts, caps });
  const maxRetries = opts.maxRetries ?? 2;
  let attempt = 0;

  const emitRetry = (
    delayMs: number,
    reason: 'network' | 'rate-limit' | 'overloaded' | 'server-error',
    statusCode?: number,
    retryAfterMs?: number,
  ): void => {
    observe?.rt.emit({
      type: 'model.retry',
      spanId: observe.spanId,
      provider: call.provider,
      model: call.modelId,
      failedAttempt: attempt,
      nextAttempt: attempt + 1,
      delayMs,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      reason,
      ...(statusCode !== undefined ? { statusCode } : {}),
    });
  };

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
      const ms = retryDelayMs(attempt, undefined, deps);
      emitRetry(ms, 'network');
      await sleep(ms, deps);
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
    const ms = retryDelayMs(attempt, retryAfter, deps);
    emitRetry(
      ms,
      response.status === 429
        ? 'rate-limit'
        : response.status === 529
          ? 'overloaded'
          : 'server-error',
      response.status,
      retryAfter,
    );
    await sleep(ms, deps);
    attempt++;
  }
}

function retryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  deps: ResolvedDependencies,
): number {
  const exp = Math.min(30_000, 500 * 2 ** attempt);
  return retryAfterMs ?? Math.floor(exp * hashToUnit(deps.generateId()));
}

function sleep(ms: number, deps: ResolvedDependencies): Promise<void> {
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

  // Observation (1.6): every top-level embed/embedMany call is a run of its
  // own (no model.* lifecycle — embeddings have no canonical stream; retries
  // still surface as model.retry). Fast path: rt is undefined without an
  // observer.
  const rt = createObservationRuntime(deps);
  let runSpanId = '';
  let runStartedAt = 0;
  if (rt) {
    const span = rt.startSpan();
    runSpanId = span.spanId;
    runStartedAt = span.startedAt;
    rt.emit({
      type: 'run.started',
      spanId: runSpanId,
      operation: readEmbedOperation(options),
      provider: options.model.provider,
      model: options.model.modelId,
      surface: options.model.surface,
      durable: false,
      resumed: false,
    });
  }

  try {
    const result = await embedManyCore(options, deps, rt ? { rt, spanId: runSpanId } : undefined);
    if (rt) {
      const costUsd = observeCost(
        rt,
        deps.priceProvider,
        'run',
        options.model.provider,
        options.model.modelId,
        result.usage,
        runSpanId,
      );
      rt.emit({
        type: 'run.completed',
        spanId: runSpanId,
        status: 'completed',
        durationMs: rt.durationSince(runStartedAt),
        finishReason: 'stop',
        endReason: 'natural',
        stepCount: 0,
        ...counterFields(rt),
        usage: result.usage,
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    }
    // Settlement (1.6.1): cost enrichment registered above; settled() drains it.
    return rt ? { ...result, observation: { settled: rt.settled() } } : result;
  } catch (err) {
    if (rt) {
      if (err instanceof AbortError || options.signal?.aborted) {
        rt.emit({
          type: 'run.aborted',
          spanId: runSpanId,
          status: 'aborted',
          durationMs: rt.durationSince(runStartedAt),
          usage: embeddingUsage(undefined),
        });
      } else {
        rt.emit({
          type: 'run.failed',
          spanId: runSpanId,
          status: 'failed',
          durationMs: rt.durationSince(runStartedAt),
          error: toObservedError(err, rt.capture.errorMessages),
          stepCount: 0,
          ...counterFields(rt),
        });
      }
    }
    throw err;
  }
};

async function embedManyCore(
  options: EmbedManyOptions,
  deps: ResolvedDependencies,
  observe: EmbedObserve | undefined,
): Promise<EmbedManyResult> {
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
    fetchBatch(adapter, call, fetchImpl, batch, options, caps, deps, options.signal, observe),
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
}

export const embed: Embed = async (options: EmbedOptions): Promise<EmbedResult> => {
  const { value, ...rest } = options;
  const manyOptions: EmbedManyOptions = { ...rest, values: [value] };
  // Spread copies only enumerable props — the client-context Symbol is
  // non-enumerable, so re-attach it or `client.embed` loses its client-level
  // apiKeys/baseUrls (G1) on the way into embedMany.
  const clientContext = readClientContext(options);
  if (clientContext) attachClientContext(manyOptions, clientContext);
  // Observation: one run, labeled 'embed' — embedMany must not emit a second.
  Object.defineProperty(manyOptions, EMBED_OPERATION, { value: 'embed', enumerable: false });
  const { embeddings, usage, observation } = await embedMany(manyOptions);
  return { embedding: embeddings[0] ?? [], usage, ...(observation ? { observation } : {}) };
};
