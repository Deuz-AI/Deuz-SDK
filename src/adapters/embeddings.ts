import type { AdapterRequest } from './types';
import type { EmbedManyOptions, EmbeddingTaskType } from '../types/methods';
import type { EmbeddingCapabilities } from '../core/registry';
import type { DeuzError } from '../errors';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  OverloadedError,
  RateLimitError,
} from '../errors';
import { parseRetryAfterMs } from '../internal/http';

/**
 * Resolved embedding call — the embedding analogue of `ResolvedCall`, produced
 * by `resolveEmbeddingCall` in `inference/embed.ts`. Adapters are pure of I/O:
 * they only build a request and parse a response.
 */
export interface EmbeddingCall {
  provider: string;
  modelId: string;
  apiKey: string;
  /** Provider root URL (no trailing slash). */
  baseURL: string;
  headers: Record<string, string>;
}

export interface EmbeddingBuildContext {
  call: EmbeddingCall;
  values: string[];
  opts: EmbedManyOptions;
  caps: EmbeddingCapabilities;
}

export interface EmbeddingParseResult {
  vectors: number[][];
  /** Total input tokens, when the provider reports usage. */
  tokens?: number;
}

/**
 * The seam every embedding wire (OpenAI / Gemini-native / Voyage) implements.
 * Pure-JSON, no streaming — mirrors the chat `Adapter` shape but simpler.
 */
export interface EmbeddingAdapter {
  buildRequest(ctx: EmbeddingBuildContext): AdapterRequest;
  parseResponse(json: unknown, caps: EmbeddingCapabilities): EmbeddingParseResult;
  mapError(status: number, body: unknown, headers: Headers): DeuzError;
}

// --- shared base64 decode (edge-safe, NO Buffer) ---

/** Decode a base64 little-endian Float32 vector → number[]. */
function decodeBase64Floats(b64: string): number[] {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(len / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  return out;
}

/** A single returned vector may be a number[] (JSON) or base64 string. */
function toVector(value: unknown): number[] {
  if (typeof value === 'string') return decodeBase64Floats(value);
  if (Array.isArray(value)) return value as number[];
  return [];
}

// --- shared error mapping (OpenAI/Voyage envelope; Gemini overrides) ---

function mapJsonError(
  provider: string,
  status: number,
  body: unknown,
  headers: Headers,
): DeuzError {
  const envelope = (body ?? {}) as {
    error?: { message?: string; type?: string; code?: string } | string;
  };
  const errObj = typeof envelope.error === 'object' ? envelope.error : undefined;
  const message =
    errObj?.message ??
    (typeof envelope.error === 'string' ? envelope.error : undefined) ??
    `Embedding request failed (HTTP ${status}).`;
  const requestId = headers.get('x-request-id') ?? undefined;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = {
    message,
    provider,
    requestId,
    upstreamType: errObj?.type ?? errObj?.code,
    retryAfterMs,
  };

  if (status === 401 || status === 403)
    return new AuthenticationError({ ...base, statusCode: status });
  if (status === 404) return new ModelNotFoundError({ ...base, statusCode: 404 });
  if (status === 429) return new RateLimitError({ ...base, statusCode: 429 });
  if (status === 529) return new OverloadedError({ ...base, statusCode: 529 });
  if (status >= 400 && status < 500)
    return new InvalidRequestError({ ...base, statusCode: status });
  return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
}

// ===================================================================
// OpenAI embeddings — POST {baseURL}/embeddings, Bearer auth
// ===================================================================

export const openaiEmbeddings: EmbeddingAdapter = {
  buildRequest({ call, values, opts, caps }): AdapterRequest {
    const body: Record<string, unknown> = { model: call.modelId, input: values };
    if (opts.dimensions !== undefined) body.dimensions = opts.dimensions;
    if (caps.supportsBase64) body.encoding_format = 'base64';
    return {
      url: `${call.baseURL}/embeddings`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${call.apiKey}`,
          ...call.headers,
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseResponse(json): EmbeddingParseResult {
    const j = (json ?? {}) as {
      data?: { index?: number; embedding: number[] | string }[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const data = j.data ?? [];
    // Spec-correct: sort by `index`, never trust array position.
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((d) => toVector(d.embedding));
    const tokens = j.usage?.total_tokens ?? j.usage?.prompt_tokens;
    return { vectors, tokens };
  },
  mapError: (status, body, headers) => mapJsonError('openai', status, body, headers),
};

// ===================================================================
// Voyage AI — POST {baseURL}/embeddings, Bearer auth, input_type
// ===================================================================

function toVoyageInputType(t: EmbeddingTaskType | undefined): string | null {
  if (t === 'search_query') return 'query';
  if (t === 'search_document') return 'document';
  return null;
}

export const voyageEmbeddings: EmbeddingAdapter = {
  buildRequest({ call, values, opts, caps }): AdapterRequest {
    const body: Record<string, unknown> = { model: call.modelId, input: values };
    const inputType = toVoyageInputType(opts.taskType);
    if (inputType) body.input_type = inputType;
    if (opts.dimensions !== undefined) body.output_dimension = opts.dimensions;
    if (caps.supportsBase64) body.encoding_format = 'base64';
    return {
      url: `${call.baseURL}/embeddings`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${call.apiKey}`,
          ...call.headers,
        },
        body: JSON.stringify(body),
      },
    };
  },
  parseResponse(json): EmbeddingParseResult {
    const j = (json ?? {}) as {
      data?: { index?: number; embedding: number[] | string }[];
      usage?: { total_tokens?: number };
    };
    const data = j.data ?? [];
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return { vectors: sorted.map((d) => toVector(d.embedding)), tokens: j.usage?.total_tokens };
  },
  mapError: (status, body, headers) => mapJsonError('voyage', status, body, headers),
};

// ===================================================================
// Gemini native embeddings — POST {baseURL}/models/{id}:batchEmbedContents
// header x-goog-api-key; NO usage on the response.
// ===================================================================

function toGeminiTaskType(t: EmbeddingTaskType | undefined): string | undefined {
  switch (t) {
    case 'search_query':
      return 'RETRIEVAL_QUERY';
    case 'search_document':
      return 'RETRIEVAL_DOCUMENT';
    case 'similarity':
      return 'SEMANTIC_SIMILARITY';
    case 'classification':
      return 'CLASSIFICATION';
    case 'clustering':
      return 'CLUSTERING';
    case 'question_answering':
      return 'QUESTION_ANSWERING';
    case 'fact_verification':
      return 'FACT_VERIFICATION';
    case 'code_retrieval_query':
      return 'CODE_RETRIEVAL_QUERY';
    default:
      return undefined;
  }
}

export const geminiEmbeddings: EmbeddingAdapter = {
  buildRequest({ call, values, opts }): AdapterRequest {
    const modelPath = `models/${call.modelId}`;
    const taskType = toGeminiTaskType(opts.taskType);
    const requests = values.map((text) => {
      const req: Record<string, unknown> = {
        // Inner request.model MUST equal the path model or Gemini 400s.
        model: modelPath,
        content: { parts: [{ text }] },
      };
      if (taskType) req.taskType = taskType;
      // `title` is only valid with RETRIEVAL_DOCUMENT; drop it otherwise.
      if (opts.title && taskType === 'RETRIEVAL_DOCUMENT') req.title = opts.title;
      if (opts.dimensions !== undefined) req.outputDimensionality = opts.dimensions;
      return req;
    });
    return {
      url: `${call.baseURL}/${modelPath}:batchEmbedContents`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': call.apiKey,
          ...call.headers,
        },
        body: JSON.stringify({ requests }),
      },
    };
  },
  parseResponse(json): EmbeddingParseResult {
    const j = (json ?? {}) as { embeddings?: { values: number[] }[] };
    // Gemini returns embeddings[] in request order (no index) and NO usage.
    return { vectors: (j.embeddings ?? []).map((e) => e.values ?? []), tokens: undefined };
  },
  mapError(status, body, headers): DeuzError {
    // Gemini envelope: { error: { code, message, status } }
    const j = (body ?? {}) as { error?: { message?: string; status?: string } };
    const message = j.error?.message ?? `Gemini embedding request failed (HTTP ${status}).`;
    const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
    const base = { message, provider: 'google', upstreamType: j.error?.status, retryAfterMs };
    if (status === 401 || status === 403)
      return new AuthenticationError({ ...base, statusCode: status });
    if (status === 404) return new ModelNotFoundError({ ...base, statusCode: 404 });
    if (status === 429) return new RateLimitError({ ...base, statusCode: 429 });
    if (status >= 400 && status < 500)
      return new InvalidRequestError({ ...base, statusCode: status });
    return new APICallError({ ...base, statusCode: status, isRetryable: status >= 500 });
  },
};

/** Map an embedding surface to its adapter. */
export function getEmbeddingAdapter(surface: string): EmbeddingAdapter {
  switch (surface) {
    case 'openai-embeddings':
      return openaiEmbeddings;
    case 'gemini-embeddings':
      return geminiEmbeddings;
    case 'voyage-embeddings':
      return voyageEmbeddings;
    default:
      throw new InvalidRequestError({ message: `Unknown embedding surface '${surface}'.` });
  }
}

export { decodeBase64Floats };
