import { APICallError } from '../errors';
import type {
  GoogleContinuationCheckpoint,
  GoogleContinuationHandler,
} from '../types/google-continuation';

/** Storage work is host work, not provider silence; the overall abort remains binding. */
export function saveGoogleContinuation(
  handler: GoogleContinuationHandler,
  checkpoint: GoogleContinuationCheckpoint,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw signal.reason;
        return handler(checkpoint, signal);
      })
      .then(
        () => {
          signal.removeEventListener('abort', aborted);
          resolve();
        },
        () => {
          signal.removeEventListener('abort', aborted);
          // Do not copy a storage exception that may include the opaque token or request.
          reject(
            signal.aborted
              ? signal.reason
              : new APICallError({
                  provider: checkpoint.provider,
                  statusCode: 200,
                  isRetryable: false,
                  message:
                    'The native continuation checkpoint handler failed. No continuation was attempted.',
                }),
          );
        },
      );
  });
}
