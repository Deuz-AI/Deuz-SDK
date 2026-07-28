import type { Clock } from '../types/deps';
// TYPE-ONLY (erased under `verbatimModuleSyntax`, so no runtime edge and no
// cycle): the per-call `timeout` shape is declared INLINE on CommonCallOptions,
// never as a named type, so this module reads it through the interface.
import type { CommonCallOptions } from '../types/config';
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
 * Every timeout layer of one call, fully resolved (1.9). `ttftMs`/`totalMs` are
 * PER MODEL CALL and always present (module defaults when the caller set
 * nothing); `stepMs`/`toolMs` are unbounded — and therefore absent — unless the
 * caller asked for them.
 */
export interface ResolvedTimeouts extends Required<TimeoutConfig> {
  /** ONE agentic step end-to-end: the model call PLUS its tool executions. */
  stepMs?: number;
  /**
   * ONE tool `execute`. Resolved HERE so there is a single resolution point for
   * every layer, but CONSUMED by `inference/loop-shared.ts` — the only place
   * tools actually run (a tool's own `Tool.timeoutMs` overrides it).
   */
  toolMs?: number;
}

/**
 * Collapse `options.timeout` into the four layers (1.9). Absent `timeout`
 * reproduces the 1.8 behaviour EXACTLY: the {@link DEFAULT_TIMEOUTS} module
 * constants, with step/tool unbounded. A bare number is the documented
 * `{ totalMs }` shorthand. An explicit `0` disables that layer — `createTimeout`
 * only arms timers for positive values — which is how a caller opts out of the
 * 300s total ceiling that a 25-30s serverless function budget makes meaningless.
 */
export function resolveTimeouts(timeout: CommonCallOptions['timeout']): ResolvedTimeouts {
  if (timeout === undefined) return { ...DEFAULT_TIMEOUTS };
  const config = typeof timeout === 'number' ? { totalMs: timeout } : timeout;
  return {
    ttftMs: config.ttftMs ?? DEFAULT_TIMEOUTS.ttftMs,
    totalMs: config.totalMs ?? DEFAULT_TIMEOUTS.totalMs,
    ...(config.stepMs !== undefined ? { stepMs: config.stepMs } : {}),
    ...(config.toolMs !== undefined ? { toolMs: config.toolMs } : {}),
  };
}

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

export interface StepTimeoutHandle {
  /**
   * Abort source for the step's model call. The loop merges it as a FAILURE
   * signal (`InternalRunOptions.failSignal`), NEVER as the user's cancel
   * signal — G2 keeps the two apart: an expiry is a `TimeoutError` on the error
   * part with rejected promises, a user abort resolves `finishReason:
   * 'aborted'` with partial usage.
   */
  signal: AbortSignal;
  /**
   * True once the deadline passed. The loop checks this after its tool
   * executions — a timer that fires while a tool is running cannot abort the
   * tool itself (that is `timeout.toolMs` / `Tool.timeoutMs`, in loop-shared).
   */
  expired(): boolean;
  /**
   * The exact error this deadline armed — the loop throws THIS instance, so the
   * error part and the rejected promises carry one identity.
   */
  error: TimeoutError;
  /** Call at the end of the step — clears the timer. */
  clear(): void;
}

/**
 * Per-step deadline for BOTH agentic loops (1.9, `timeout.stepMs`) — the
 * streaming one (`inference/stream-tool-loop.ts`) and the buffered one
 * (`inference/tool-loop.ts`) arm it identically, so the same option can never
 * mean two things. Returns `undefined` when the layer is unset so the unbounded
 * path stays byte-for-byte the 1.8 behaviour: no timer armed, no object
 * allocated, no clock draw. Clock-driven like every other timer (never
 * `AbortSignal.timeout` — see `createTimeout`).
 */
export function createStepTimeout(clock: Clock, stepMs?: number): StepTimeoutHandle | undefined {
  if (stepMs === undefined || stepMs <= 0) return undefined;
  const controller = new AbortController();
  let expired = false;
  // `layer: 'step'` is machine-readable (1.9): a caller distinguishing "my agent
  // ran long" from "the provider never answered" branches on the field, not on
  // the message.
  const error = new TimeoutError('step', `Agentic step timed out (step, ${stepMs}ms).`);
  const cancel = clock.setTimeout(() => {
    expired = true;
    controller.abort(error);
  }, stepMs);
  return {
    signal: controller.signal,
    expired: () => expired,
    error,
    clear: () => {
      cancel();
    },
  };
}
