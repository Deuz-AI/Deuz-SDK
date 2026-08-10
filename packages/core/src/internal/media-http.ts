/**
 * internal/media-http.ts — the shared HTTP error surface of the MEDIA modules
 * (2.0: speech, transcription, video).
 *
 * Media endpoints are not chat wires: they never stream canonical `StreamPart`s,
 * so they do not go through an `Adapter`'s `mapError`. Each of them still owes a
 * caller the same typed `DeuzError` a chat call would produce for the same
 * status. This module is that mapping, lifted VERBATIM out of `image.ts`
 * (the first media module) so the new ones inherit it instead of re-deriving it.
 *
 * `image.ts` and `midjourney.ts` deliberately keep their own copies — they are
 * shipped, byte-locked surfaces and a pure-refactor risk is not worth taking in
 * a release that is already changing this much.
 *
 * PURE + edge-safe: no clock, no randomness, no logging.
 */
import { parseRetryAfterMs } from './http';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  OverloadedError,
  RateLimitError,
  type DeuzError,
} from '../errors';

/**
 * Read a failed response's body once, preferring JSON. A media provider's error
 * envelope is usually JSON but plain text on gateway/proxy failures (nginx 502,
 * a relay's HTML error page), so a hard `response.json()` would throw and lose
 * the diagnostic entirely. A body that cannot even be read yields `''`.
 */
export async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Map a media endpoint's HTTP failure onto the canonical error taxonomy —
 * the same status→class table the chat adapters use:
 *
 * 401/403 → `AuthenticationError`, 404 → `ModelNotFoundError`,
 * 429 → `RateLimitError` (with `Retry-After`), 529 → `OverloadedError`,
 * any other 4xx → `InvalidRequestError`, 5xx → a RETRYABLE `APICallError`.
 *
 * The message is pulled out of the OpenAI-shaped `{ error: { message } }`
 * envelope, tolerating the `{ error: 'string' }` variant some relays emit, and
 * falls back to `fallbackMessage` (default: a generic line naming the status).
 * `x-request-id` is captured when present — it is what a provider's support
 * will ask for.
 */
export function mapMediaError(
  provider: string,
  status: number,
  body: unknown,
  headers: Headers,
  fallbackMessage?: string,
): DeuzError {
  const envelope = (body ?? {}) as {
    error?: { message?: string; type?: string; code?: string } | string;
  };
  const errObj = typeof envelope.error === 'object' ? envelope.error : undefined;
  const message =
    errObj?.message ??
    (typeof envelope.error === 'string' ? envelope.error : undefined) ??
    fallbackMessage ??
    `Media request failed (HTTP ${status}).`;
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
