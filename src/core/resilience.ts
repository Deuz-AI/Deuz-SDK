import type { Clock } from '../types/deps';
import { APICallError, AbortError, type DeuzError } from '../errors';

export interface RetryOptions {
  maxRetries: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  baseMs: 500,
  capMs: 30_000,
};

/** Only `APICallError`s carry an `isRetryable` verdict; everything else is final. */
export function isRetryable(err: unknown): boolean {
  return err instanceof APICallError && err.isRetryable;
}

/** True for an overload (HTTP 529) — these use a SEPARATE attempt counter. */
export function isOverload(err: unknown): boolean {
  return err instanceof APICallError && err.statusCode === 529;
}

/**
 * Exponential backoff with FULL jitter: `random() * min(cap, base * 2^attempt)`.
 * A provider `Retry-After` (ms) takes precedence (capped). `random` is injected
 * (derived from `deps.generateId`) so core never calls `Math.random`.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number,
  opts: RetryOptions = DEFAULT_RETRY,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, opts.capMs);
  const exp = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
  return Math.floor(exp * random());
}

/** Derive a deterministic [0,1) value from an id string (FNV-1a) — jitter source. */
export function unitFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Abortable delay via the injected clock — aborting during backoff rejects at once. */
export function wait(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new AbortError());
      return;
    }
    const onAbort = (): void => {
      cancelTimer();
      reject(signal?.reason ?? new AbortError());
    };
    const cancelTimer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry verdict consumed by the inference pump (pre-first-byte only). */
export function shouldRetry(err: DeuzError, attempt: number, maxRetries: number): boolean {
  return isRetryable(err) && attempt < maxRetries;
}
