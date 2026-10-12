/**
 * internal/native-retry.ts (2.3) — which failures of a native run a resume may
 * re-enter (`retryFailed`). A failed run stays failed by default; a run whose
 * failure was transient records why (`AgentRunEnvelope.retry`), so a resume
 * can go on from its last checkpoint instead of starting the work over. A
 * failure that would only fail again, or that a policy, a budget or a person
 * decided, is never retried.
 */
import type { AgentRunRetry } from '../types/agent-run';
import { DeuzError } from '../errors';
import { defaultShouldFallback } from './fallback';
import { isFatalExecutionError } from './execution-error';

/** What a contended Postgres write raises: a serialization failure, or a deadlock victim. */
const SERIALIZATION_CODES: ReadonlySet<string> = new Set(['40001', '40P01']);

/**
 * The transient cause of a native run's failure, or undefined when there is
 * none:
 * - `'admission'`: the persistent budget store refused to admit a call with a
 *   serialization conflict (after its own retries), so nothing was admitted.
 *   A store that failed to close a hold names that hold (`requestId`): its
 *   failure is no admission.
 * - `'model-call'`: a model call failed with a retryable transport or provider
 *   error, the errors model fail-over acts on (network, transport timeout, 5xx,
 *   429/529 after the call's own retries, an open breaker); or the call's stream
 *   broke off, which the runtime reports with an error of its own: `brokeOff`
 *   says the run's last model call was sent and its outcome is unknown.
 *
 * The caller rules out a run that was cancelled or ran out of time.
 */
export function retryableCause(
  error: unknown,
  brokeOff: boolean,
): AgentRunRetry['cause'] | undefined {
  const failure = error as { code?: unknown; requestId?: unknown; cause?: unknown } | null;
  if (failure?.code === 'admission_failed') {
    const cause = failure.cause as { code?: unknown } | null | undefined;
    return failure.requestId === undefined &&
      typeof cause?.code === 'string' &&
      SERIALIZATION_CODES.has(cause.code)
      ? 'admission'
      : undefined;
  }
  if (error instanceof DeuzError) return defaultShouldFallback(error) ? 'model-call' : undefined;
  // A policy, budget or persistence failure is the run's own infrastructure.
  if (isFatalExecutionError(error)) return undefined;
  return brokeOff ? 'model-call' : undefined;
}
