/**
 * Error → ObservedError normalization (1.6). Category derives from the STABLE
 * `DeuzError.code` strings (never class names — cross-realm safe via
 * `isDeuzError`), with one branch: AuthenticationError statusCode 403 maps to
 * 'authorization' (there is no separate class). The 'approval' category is
 * never produced here — it is synthesized at the loop's deny sites. The cause
 * chain is never serialized; `message` is included only on request and always
 * passes the observation redaction profile first.
 */
import { isDeuzError } from '../errors';
import type { ObservedError } from '../types/observe';
import { redactObservationString } from './redact';

const CODE_CATEGORY: Record<string, ObservedError['category']> = {
  rate_limit: 'rate-limit',
  overloaded: 'overloaded',
  timeout: 'timeout',
  network_error: 'network',
  api_call_error: 'provider',
  model_not_found: 'provider',
  context_overflow: 'provider',
  unsupported_capability: 'provider',
  no_object_generated: 'provider',
  not_implemented: 'provider',
  invalid_request: 'validation',
  tool_execution: 'tool',
  checkpoint_not_found: 'checkpoint',
  aborted: 'aborted',
};

export function toObservedError(err: unknown, captureMessage: boolean): ObservedError {
  if (isDeuzError(err)) {
    const rec = err as unknown as Record<string, unknown>;
    const statusCode = typeof rec.statusCode === 'number' ? rec.statusCode : undefined;
    const category: ObservedError['category'] =
      err.code === 'authentication'
        ? statusCode === 403
          ? 'authorization'
          : 'authentication'
        : (CODE_CATEGORY[err.code] ?? 'unknown');
    return {
      name: err.name,
      category,
      code: err.code,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(typeof rec.isRetryable === 'boolean' ? { retryable: rec.isRetryable } : {}),
      ...(typeof rec.provider === 'string' ? { provider: rec.provider } : {}),
      ...(captureMessage ? { message: redactObservationString(err.message) } : {}),
    };
  }
  const name = err instanceof Error ? err.name : 'Error';
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  return {
    name,
    category: 'unknown',
    ...(captureMessage ? { message: redactObservationString(raw) } : {}),
  };
}
