/**
 * internal/rerank-http.ts — the shared HTTP body of the hosted rerankers (2.2):
 * `createVoyageReranker` (`voyage.ts`) and `createCohereReranker` (`rag.ts`).
 *
 * Both wires are the same shape — POST `{ model, query, documents, <count> }`,
 * get back `[{ index, relevance_score }]` — so the key precedence, transport,
 * index mapping and error taxonomy live here once. Only the endpoint, the count
 * field name and the response envelope differ, and those come in as a `RerankWire`.
 *
 * PURE + edge-safe: HTTP goes through the settings' `fetch` or `deps.fetch`, the
 * key through `deps.keyProvider` or the factory `apiKey`. No clock, no
 * randomness, no logging — and the key is only ever written into the
 * `authorization` header, never into an error.
 */
import type { Dependencies } from '../types/deps';
import type { Reranker, ScoredChunk } from '../rag';
import { resolveDependencies } from './resolve-deps';
import { mapMediaError, readErrorBody } from './media-http';
import { APICallError, AuthenticationError, NetworkError } from '../errors';

/** Settings shared by every hosted reranker factory. */
export interface HostedRerankerSettings {
  /** API key. `deps.keyProvider` (when it returns a key) outranks this. */
  apiKey?: string;
  /** Rerank model id. Each factory documents its own default. */
  model?: string;
  /**
   * Upper bound on how many chunks one call returns. The pipeline's `topN`
   * still applies: the reranker returns `min(topN, topK)` chunks.
   */
  topK?: number;
  /** Provider root URL (the wire path `/rerank` is appended). */
  baseURL?: string;
  /** Transport override. Wins over `deps.fetch`. */
  fetch?: typeof fetch;
  /** Extra request headers, merged under the auth header. */
  headers?: Record<string, string>;
  /** The injection seam — only `fetch` and `keyProvider` are read. */
  deps?: Dependencies;
}

/** What differs between the hosted rerank wires. */
export interface RerankWire {
  /** Provider id used for `deps.keyProvider.getKey` and error `provider`. */
  provider: string;
  defaultBaseURL: string;
  defaultModel: string;
  /** Body field that caps the result count (`top_k` on Voyage, `top_n` on Cohere). */
  countField: string;
  /** Pull `[{ index, relevance_score }]` out of the provider's envelope. */
  results(json: unknown): unknown;
}

interface RawResult {
  index?: unknown;
  relevance_score?: unknown;
}

/** Message extraction for envelopes `mapMediaError` does not read (`detail`, top-level `message`). */
function envelopeMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.length > 0 ? body : undefined;
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.detail === 'string') return record.detail;
  if (typeof record.message === 'string') return record.message;
  return undefined;
}

/** Build a `Reranker` that calls a hosted rerank endpoint. */
export function createHostedReranker(wire: RerankWire, settings: HostedRerankerSettings): Reranker {
  const deps = resolveDependencies(settings.deps);
  const model = settings.model ?? wire.defaultModel;
  const baseURL = (settings.baseURL ?? wire.defaultBaseURL).replace(/\/+$/, '');
  const fetchImpl = settings.fetch ?? deps.fetch;

  return {
    async rerank(query, candidates, topN): Promise<ScoredChunk[]> {
      const limit = Math.min(topN, settings.topK ?? topN, candidates.length);
      if (limit <= 0) return [];

      // G1 for a factory with no client context: keyProvider > factory apiKey > throw.
      let apiKey: string | undefined;
      if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(wire.provider)) ?? undefined;
      if (!apiKey) apiKey = settings.apiKey;
      if (!apiKey) {
        throw new AuthenticationError({
          message: `No API key for rerank provider '${wire.provider}'. Pass { apiKey } to the reranker factory or supply a deps.keyProvider.`,
          provider: wire.provider,
        });
      }

      const body = {
        model,
        query,
        documents: candidates.map((c) => c.text),
        [wire.countField]: limit,
      };

      let response: Response;
      try {
        response = await fetchImpl(`${baseURL}/rerank`, {
          method: 'POST',
          headers: {
            ...settings.headers,
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        throw new NetworkError({
          message: `Rerank request to '${wire.provider}' failed before a response arrived.`,
          provider: wire.provider,
          cause,
        });
      }

      if (!response.ok) {
        const errorBody = await readErrorBody(response);
        throw mapMediaError(
          wire.provider,
          response.status,
          errorBody,
          response.headers,
          envelopeMessage(errorBody) ?? `Rerank request failed (HTTP ${response.status}).`,
        );
      }

      const raw = wire.results(await response.json());
      const results = Array.isArray(raw) ? (raw as RawResult[]) : [];
      const out: ScoredChunk[] = [];
      for (const result of results) {
        const index = result.index;
        const candidate =
          typeof index === 'number' && Number.isInteger(index) ? candidates[index] : undefined;
        if (!candidate) {
          throw new APICallError({
            message: `Rerank response from '${wire.provider}' referenced document index ${String(index)}, outside the ${candidates.length} candidates sent.`,
            statusCode: response.status,
            isRetryable: false,
            provider: wire.provider,
          });
        }
        const score = typeof result.relevance_score === 'number' ? result.relevance_score : 0;
        out.push({ ...candidate, score });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
