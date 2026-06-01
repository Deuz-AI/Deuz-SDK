/**
 * google-extras.ts — Gemini explicit context caching + the Files API
 * (`@deuz/core/google/extras`). The native `generateContent` adapter already
 * *passes through* an opaque `cachedContent` name and `fileData.fileUri`; this
 * module is what *produces* them:
 *
 *   - `createGeminiCache(...)` → POST /cachedContents → a reusable `name` you put
 *     on `options.cachedContent`. Big shared prefixes (a long system prompt, a
 *     manual, a transcript) are billed once at the cheap cached-read rate.
 *   - `uploadFile(...)` → resumable Files API upload → a `fileUri` you reference
 *     as an image/file Part for media too large to inline (>~20 MB).
 *
 * Edge-safe (only `fetch` + Web APIs); key/token injected, never hardcoded.
 * Works against AI Studio (API key) OR Vertex (OAuth2 Bearer + project/location).
 */
import type { Dependencies } from './types/deps';
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

const AISTUDIO_BASE = 'https://generativelanguage.googleapis.com';

export interface GoogleExtrasConfig {
  /** AI Studio API key. Omit when using Vertex (then pass `accessToken` + `vertex`). */
  apiKey?: string;
  /** Vertex OAuth2 access token (Bearer). */
  accessToken?: string;
  /** Present → target Vertex AI instead of AI Studio. */
  vertex?: { project: string; location: string };
  /** Override the host root (no trailing slash). */
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  deps?: Dependencies;
}

interface Resolved {
  base: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  /** model-path prefix: '' for AI Studio, 'projects/…/locations/…' for Vertex. */
  vertexPrefix: string;
}

function resolve(cfg: GoogleExtrasConfig): Resolved {
  const deps = resolveDependencies(cfg.deps);
  const fetchImpl = cfg.fetch ?? deps.fetch;
  const vertex = cfg.vertex;

  if (vertex) {
    if (!cfg.accessToken) {
      throw new AuthenticationError({
        message: 'Vertex Files/cache requires an OAuth2 accessToken.',
        provider: 'vertex-google',
      });
    }
    const host =
      cfg.baseURL ??
      (vertex.location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${vertex.location}-aiplatform.googleapis.com`);
    return {
      base: `${host}/v1/projects/${vertex.project}/locations/${vertex.location}`,
      headers: { authorization: `Bearer ${cfg.accessToken}`, ...cfg.headers },
      fetch: fetchImpl,
      vertexPrefix: `projects/${vertex.project}/locations/${vertex.location}/`,
    };
  }

  if (!cfg.apiKey) {
    throw new AuthenticationError({
      message: 'Gemini Files/cache requires an apiKey (AI Studio) or accessToken+vertex.',
      provider: 'google',
    });
  }
  return {
    base: `${(cfg.baseURL ?? AISTUDIO_BASE).replace(/\/+$/, '')}/v1beta`,
    headers: { 'x-goog-api-key': cfg.apiKey, ...cfg.headers },
    fetch: fetchImpl,
    vertexPrefix: '',
  };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function mapError(status: number, body: unknown, headers: Headers): DeuzError {
  const j = (body ?? {}) as { error?: { message?: string; status?: string } };
  const message = j.error?.message ?? `Gemini extras request failed (HTTP ${status}).`;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  const base = { message, provider: 'google', upstreamType: j.error?.status, retryAfterMs };
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
// Explicit context caching — POST /cachedContents
// ===================================================================

/** A Gemini content `part` (text / inline data / file ref) for the cached prefix. */
export type GeminiCachePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } };

export interface CreateCacheOptions extends GoogleExtrasConfig {
  /** Model the cache is bound to, e.g. `gemini-2.5-flash` (must match the call). */
  model: string;
  /** The cached content — usually a large system prompt / document prefix. */
  contents: { role?: 'user' | 'model'; parts: GeminiCachePart[] }[];
  /** Optional cached system instruction. */
  systemInstruction?: { parts: { text: string }[] };
  /** Time-to-live, e.g. `'3600s'` (default 1h). Mutually exclusive with `expireTime`. */
  ttl?: string;
  /** Absolute RFC-3339 expiry; overrides `ttl`. */
  expireTime?: string;
  /** Human label. */
  displayName?: string;
}

export interface CachedContent {
  /** The opaque cache id — pass this as `options.cachedContent` on a generate call. */
  name: string;
  model: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: { totalTokenCount?: number };
}

/**
 * Normalize a model id to the resource form Gemini expects:
 *  - AI Studio: `models/<id>`
 *  - Vertex:    `projects/<p>/locations/<l>/publishers/google/models/<id>`
 */
function modelResource(prefix: string, model: string): string {
  const bare = model.replace(/^(projects\/.*\/)?(publishers\/google\/)?models\//, '');
  return prefix ? `${prefix}publishers/google/models/${bare}` : `models/${bare}`;
}

/**
 * Create an explicit cache. Returns the `CachedContent` whose `.name` you set on
 * a generate call's `cachedContent` option — the cached prefix is then billed at
 * the cheap cached-read rate on every reuse until it expires.
 */
export async function createGeminiCache(options: CreateCacheOptions): Promise<CachedContent> {
  const r = resolve(options);
  const body: Record<string, unknown> = {
    model: modelResource(r.vertexPrefix, options.model),
    contents: options.contents,
  };
  if (options.systemInstruction) body.systemInstruction = options.systemInstruction;
  if (options.expireTime) body.expireTime = options.expireTime;
  else body.ttl = options.ttl ?? '3600s';
  if (options.displayName) body.displayName = options.displayName;

  const res = await r.fetch(`${r.base}/cachedContents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...r.headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw mapError(res.status, await readBody(res), res.headers);
  return (await res.json()) as CachedContent;
}

/** Fetch a cache's metadata by name. */
export async function getGeminiCache(
  name: string,
  cfg: GoogleExtrasConfig,
): Promise<CachedContent> {
  const r = resolve(cfg);
  const res = await r.fetch(`${r.base}/${name.replace(/^\/+/, '')}`, { headers: r.headers });
  if (!res.ok) throw mapError(res.status, await readBody(res), res.headers);
  return (await res.json()) as CachedContent;
}

/** Delete a cache by name. */
export async function deleteGeminiCache(name: string, cfg: GoogleExtrasConfig): Promise<void> {
  const r = resolve(cfg);
  const res = await r.fetch(`${r.base}/${name.replace(/^\/+/, '')}`, {
    method: 'DELETE',
    headers: r.headers,
  });
  if (!res.ok && res.status !== 404) throw mapError(res.status, await readBody(res), res.headers);
}

/** List caches (AI Studio). */
export async function listGeminiCaches(cfg: GoogleExtrasConfig): Promise<CachedContent[]> {
  const r = resolve(cfg);
  const res = await r.fetch(`${r.base}/cachedContents`, { headers: r.headers });
  if (!res.ok) throw mapError(res.status, await readBody(res), res.headers);
  const j = (await res.json()) as { cachedContents?: CachedContent[] };
  return j.cachedContents ?? [];
}

// ===================================================================
// Files API — resumable upload (AI Studio). Returns a `fileUri` Part ref.
// ===================================================================

export interface UploadedFile {
  /** Resource name, e.g. `files/abc-123`. */
  name: string;
  /** The URI to reference in a `fileData` part. */
  uri: string;
  mimeType: string;
  sizeBytes?: string;
  state?: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  expirationTime?: string;
}

export interface UploadFileOptions extends GoogleExtrasConfig {
  /** Raw bytes to upload (PDF, audio, video, image…). */
  bytes: Uint8Array;
  mimeType: string;
  /** Optional display name. */
  displayName?: string;
}

/**
 * Upload a file via the resumable Files API (AI Studio only — Vertex uses GCS).
 * Returns an `UploadedFile`; reference `.uri` as a `fileData` image/file Part for
 * media too large to inline. Files auto-expire after ~48h.
 */
export async function uploadFile(options: UploadFileOptions): Promise<UploadedFile> {
  if (options.vertex) {
    throw new InvalidRequestError({
      message:
        'Vertex AI does not use the Files API — upload to Google Cloud Storage and pass a gs:// fileUri instead.',
      provider: 'vertex-google',
    });
  }
  const r = resolve(options);
  const numBytes = options.bytes.byteLength;

  // 1) Start a resumable session.
  const startRes = await r.fetch(`${r.base.replace(/\/v1beta$/, '')}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      ...r.headers,
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(numBytes),
      'x-goog-upload-header-content-type': options.mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      file: { ...(options.displayName ? { displayName: options.displayName } : {}) },
    }),
  });
  if (!startRes.ok) throw mapError(startRes.status, await readBody(startRes), startRes.headers);
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new APICallError({
      message: 'Files API did not return an upload URL.',
      provider: 'google',
      statusCode: startRes.status,
      isRetryable: false,
    });
  }

  // 2) Upload the bytes + finalize.
  const upRes = await r.fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'content-length': String(numBytes),
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
    },
    body: options.bytes as unknown as BodyInit,
  });
  if (!upRes.ok) throw mapError(upRes.status, await readBody(upRes), upRes.headers);
  const j = (await upRes.json()) as { file?: UploadedFile };
  if (!j.file?.uri) {
    throw new APICallError({
      message: 'Files API upload returned no file URI.',
      provider: 'google',
      statusCode: upRes.status,
      isRetryable: false,
    });
  }
  return j.file;
}

/** Poll a file until it is ACTIVE (large media is processed async). */
export async function waitForFileActive(
  name: string,
  cfg: GoogleExtrasConfig & { pollIntervalMs?: number; timeoutMs?: number },
): Promise<UploadedFile> {
  const r = resolve(cfg);
  const deps = resolveDependencies(cfg.deps);
  const interval = cfg.pollIntervalMs ?? 2000;
  const timeout = cfg.timeoutMs ?? 120_000;
  const start = deps.clock.now();
  for (;;) {
    const res = await r.fetch(`${r.base}/${name.replace(/^\/+/, '')}`, { headers: r.headers });
    if (!res.ok) throw mapError(res.status, await readBody(res), res.headers);
    const file = (await res.json()) as UploadedFile;
    if (file.state === 'ACTIVE') return file;
    if (file.state === 'FAILED') {
      throw new APICallError({
        message: `File '${name}' processing FAILED.`,
        provider: 'google',
        statusCode: 422,
        isRetryable: false,
      });
    }
    if (deps.clock.now() - start >= timeout) {
      throw new APICallError({
        message: `File '${name}' did not become ACTIVE within ${timeout}ms.`,
        provider: 'google',
        statusCode: 408,
        isRetryable: true,
      });
    }
    await new Promise<void>((resolve) => deps.clock.setTimeout(() => resolve(), interval));
  }
}
