import type { Usage } from '../types/usage';
import type { Dependencies, UsageMeta, FinishMeta, ResolvedDependencies } from '../types/deps';
import type { CommonCallOptions } from '../types/config';

/** A zero-token canonical Usage (used as the baseline / abort fallback). */
export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
};

/** Fill in `totalTokens` if an adapter left it at 0. */
export function withTotal(usage: Usage): Usage {
  if (usage.totalTokens > 0) return usage;
  return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
}

/**
 * Normalize embedding usage (Faz 3) onto the canonical `Usage`. Embeddings have
 * only input tokens — no output/reasoning/cache. `tokens` may be undefined when
 * a provider omits usage (Gemini AI-Studio embeddings) → treated as 0 so
 * `priceProvider` still receives a well-formed Usage.
 */
export function embeddingUsage(tokens: number | undefined): Usage {
  const t = tokens ?? 0;
  return {
    inputTokens: t,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: t,
  };
}

/**
 * Fire the usage callback exactly ONCE (G10): a call-level `options.onUsage`
 * overrides a `deps.onUsage` — never both, so the credit system is never
 * double-charged.
 */
export function fireUsage(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  usage: Usage,
  meta: UsageMeta,
): void {
  const cb = options.onUsage ?? deps.onUsage;
  cb?.(usage, meta);
}

/**
 * Fire the finish callback (same options-over-deps precedence as `fireUsage`).
 *
 * G12 (1.9) — WHO fires, and how often. G10 above governs PRECEDENCE only: a
 * call-level callback overrides a deps-level one, never both. It says nothing
 * about how many TIMES one run may reach a terminal boundary, and a loop-routed
 * call reaches two: the pump that ran the step fires one `onFinish`
 * (`core/inference.ts`) and the loop fires another for the whole run
 * (`inference/stream-tool-loop.ts`). Everything metering or persisting on
 * `onFinish` was double-counting.
 *
 * The RUN OWNER's firing is the one that survives, because `FinishMeta.finishReason`
 * describes the run (the last step's reason, after every stop condition) while a
 * step's describes one model call — and per-step granularity already has its own
 * hook (`onStepFinish`). So the pump stays silent whenever a loop owns the call
 * (`core/inference.ts` gates on `internal.tools`, the same "a loop drives this"
 * test it already uses for the inline cost part) and the owner fires once.
 *
 * `onUsage` is deliberately NOT collapsed this way: `UsageMeta` is per-MODEL-CALL
 * by construction (`ttftMs`, and `agentPath` for a sub-agent's own calls), it
 * already fires exactly once per call on every path, and folding it into one
 * event per run would under-report a multi-step agent's tokens.
 *
 * `deps` is only read for the fallback callback, so the widest useful type is
 * taken: the buffered call boundary passes the RAW `options.deps` rather than
 * resolving them (resolving allocates a second breaker store, breaking G11's
 * once-per-client rule).
 */
export function fireFinish(
  options: CommonCallOptions,
  deps: Pick<Dependencies, 'onFinish'>,
  meta: FinishMeta,
): void {
  const cb = options.onFinish ?? deps.onFinish;
  cb?.(meta);
}

/**
 * G12: fire the run's single `onFinish` from OUTSIDE the pump — for an
 * orchestrator that has the finished result in hand rather than resolved
 * dependencies (today: the buffered call boundary in `src/generate.ts`). Same
 * precedence, same once-per-run contract.
 */
export function fireRunFinish(options: CommonCallOptions, meta: FinishMeta): void {
  fireFinish(options, options.deps ?? {}, meta);
}
