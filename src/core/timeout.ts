import type { Clock } from '../types/deps';
import { TimeoutError } from '../errors';

export interface TimeoutConfig {
  /** Abort if the first content delta hasn't arrived in time. */
  ttftMs?: number;
  /** Hard ceiling on the whole request. */
  totalMs?: number;
}

export const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  ttftMs: 60_000,
  totalMs: 300_000,
};

/**
 * Combine signals. Uses `AbortSignal.any` when available but guards against the
 * Node 22 leak / Cloudflare `.timeout()` issues with a manual fallback so an
 * uncatchable DOMException can't escape.
 */
export function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => !!s);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];

  const AnyCtor = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof AnyCtor === 'function') {
    try {
      return AnyCtor(real);
    } catch {
      /* fall through to manual */
    }
  }

  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of real) {
    if (s.aborted) {
      abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => abort(s.reason), { once: true });
  }
  return controller.signal;
}

export interface TimeoutHandle {
  /** Combined timeout signal to merge with the user signal. */
  signal: AbortSignal;
  /** Call when the first content delta arrives — clears the ttft timer. */
  firstByte(): void;
  /** Call on completion — clears all timers. */
  clear(): void;
}

/**
 * Build clock-driven timeouts (NOT `AbortSignal.timeout`, which is non-injectable
 * and hits the CF bug). The ttft timer is armed when this is called — i.e. at
 * pump start, not at the synchronous `streamChat` return (G9).
 */
export function createTimeout(clock: Clock, config: TimeoutConfig = {}): TimeoutHandle {
  const controller = new AbortController();
  let ttftCancel: (() => void) | undefined;
  let totalCancel: (() => void) | undefined;

  if (config.totalMs && config.totalMs > 0) {
    totalCancel = clock.setTimeout(
      () => controller.abort(new TimeoutError('total')),
      config.totalMs,
    );
  }
  if (config.ttftMs && config.ttftMs > 0) {
    ttftCancel = clock.setTimeout(() => controller.abort(new TimeoutError('ttft')), config.ttftMs);
  }

  return {
    signal: controller.signal,
    firstByte() {
      ttftCancel?.();
      ttftCancel = undefined;
    },
    clear() {
      ttftCancel?.();
      totalCancel?.();
      ttftCancel = undefined;
      totalCancel = undefined;
    },
  };
}
