/**
 * The `warnings` collector (1.9). Pure and edge-safe: no clock, no randomness,
 * no console - a bounded array plus a forward to the injected logger.
 *
 * WHY IT EXISTS. Deuz deliberately never throws on something it can degrade: an
 * unknown model slug falls back to a conservative capability row, a sampling
 * parameter a reasoning model rejects is stripped, a typo'd `activeTools` name is
 * ignored fail-open. That policy is right - a new provider slug must not break a
 * running app - but until 1.9 every one of those decisions went only to
 * `deps.logger.warn`, and the DEFAULT LOGGER IS A NO-OP
 * (`internal/resolve-deps.ts`), so by default they went nowhere at all. The escape
 * valve for "we quietly did something other than what you asked" has to be
 * visible on the result, not just in a log the app may never have wired up.
 */
import type { CallWarning } from '../types/methods';
import type { Logger } from '../types/deps';

/**
 * Hard cap. A pathological loop (a step that re-strips the same parameter every
 * turn, a 200-name `activeTools` typo) must not grow this without bound - the
 * array rides on the result and, when streaming, resolves to every consumer.
 * Warnings are diagnostics: the first N are the informative ones.
 */
const MAX_WARNINGS = 50;

export interface WarningSink {
  /**
   * Record a warning, deduplicated by (type, setting, message). Returns whether
   * it was new (2.3): `false` for a repeat, `true` otherwise, also when the
   * list cap only counts it as omitted. A site that logs its own line gates
   * that line on this, so the log carries each warning once.
   *
   * `mirror` (default true) also sends it to `deps.logger.warn`. Pass `false` at
   * a site that ALREADY logs - the registry's unknown-slug fallback, the Chat
   * Completions hosted-tool drop, the dropped-document path - so that 1.9 adds a
   * typed channel without turning one log line into two. Several tests pin those
   * call counts and field shapes precisely because they are the pre-1.9 contract.
   */
  add(warning: CallWarning, options?: { mirror?: boolean }): boolean;
  /** Everything recorded, in first-seen order. The returned array is a copy. */
  list(): CallWarning[];
  /**
   * What no stream has carried yet, in first-seen order, now marked as carried
   * (2.3). A loop and the model calls it drives share one sink, and whichever
   * flushes first streams a warning, so it reaches the run's stream once. The
   * omitted-warnings notice is carried once, when the cap is first passed.
   */
  take(): CallWarning[];
}

/**
 * Create a per-call sink. Never a module-level singleton: one sink per call is
 * what keeps concurrent calls (and concurrent isolates) from seeing each other's
 * warnings.
 */
export function createWarningSink(logger?: Logger): WarningSink {
  const out: CallWarning[] = [];
  // Dedup by (type, setting, message): the loop re-derives capabilities on every
  // step, so a single stripped `temperature` would otherwise be reported once per
  // step for the same one cause.
  const seen = new Set<string>();
  let dropped = 0;
  /** How much of `out` (append-only) a stream has carried, and whether the notice went too. */
  let carried = 0;
  let noticeCarried = false;
  // Say what was withheld rather than truncating in silence - the whole point
  // of this module is that a quiet decision becomes a visible one.
  const notice = (): CallWarning => ({
    type: 'other',
    message: `${dropped} further warning(s) omitted (cap ${MAX_WARNINGS}).`,
  });

  return {
    add(warning: CallWarning, options?: { mirror?: boolean }): boolean {
      const key = `${warning.type} ${warning.setting ?? ''} ${warning.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (options?.mirror !== false) {
        logger?.warn(warning.message, {
          warning: warning.type,
          ...(warning.setting !== undefined ? { setting: warning.setting } : {}),
        });
      }
      if (out.length >= MAX_WARNINGS) {
        dropped++;
        return true;
      }
      out.push(warning);
      return true;
    },
    list(): CallWarning[] {
      return dropped === 0 ? [...out] : [...out, notice()];
    },
    take(): CallWarning[] {
      const fresh = out.slice(carried);
      carried = out.length;
      if (dropped > 0 && !noticeCarried) {
        noticeCarried = true;
        fresh.push(notice());
      }
      return fresh;
    },
  };
}

/** Convenience for the most common shape: a setting the wire could not carry. */
export function unsupportedSetting(setting: string, message: string): CallWarning {
  return { type: 'unsupported-setting', setting, message };
}
