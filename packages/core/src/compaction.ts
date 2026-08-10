/**
 * Manual context compaction (2.0 additive).
 *
 * The agentic loop already compacts on its own: set `compaction` on a call and
 * it measures fill every step and shrinks the history when it crosses the
 * threshold. But that only helps INSIDE a run. A caller who owns the history —
 * trimming a stored chat before replaying it, handing a transcript to a smaller
 * model, reacting to a `ContextOverflowError` from a bare `generateText` — had
 * no way in. `compactMessages()` is that entry point: the same layers, the same
 * protection rules, as one function over an array.
 *
 * PURE BY DEFAULT: with no `summarize` dependency this NEVER calls a model. The
 * summarize layer is simply skipped and the two local pruning layers do their
 * work — the default call performs no I/O at all, and costs nothing.
 */
import type { Message } from './types/message';
import type { CompactionLayer, CompactionOption } from './types/config';
import {
  applyCompaction,
  normalizeCompaction,
  type ApplyCompactionCtx,
  type CompactionEvent,
} from './inference/compaction';
import { createTokenEstimator } from './internal/estimate-tokens';

export type { CompactionEvent };

export interface CompactMessagesDeps {
  /**
   * Summarizer for the `summarize` layer — typically a `generateText` call.
   * `previousSummary` carries the rolling summary already in the history on
   * every pass after the first, so the new slice folds INTO it.
   *
   * OMIT IT and the summarize layer is skipped entirely: `compactMessages`
   * makes no network call of its own unless you hand it one.
   */
  summarize?: (slice: Message[], previousSummary?: string) => Promise<string>;
  /**
   * Token counter for the fill estimate. Default: the same calibrated character
   * heuristic the loop uses — a `countTokens` on the POLICY replaces that
   * heuristic's base count, this replaces the whole estimate.
   */
  estimateTokens?: (messages: Message[]) => number;
  /**
   * The model's context window. WITH it, the policy threshold decides whether
   * anything runs at all (loop semantics). WITHOUT it there is no ratio to
   * compare, so every layer runs exactly once — the "just make it smaller" mode.
   */
  contextWindow?: number;
  /** Fired when a layer is skipped (a throwing summarizer, most often). */
  onSkip?: (layer: CompactionLayer, reason: string) => void;
}

export interface CompactMessagesResult {
  /** The compacted history. Same reference as the input when nothing ran. */
  messages: Message[];
  /** One entry per layer that actually changed the history, in run order. */
  events: CompactionEvent[];
  /**
   * Which gate decided: `'threshold'` when a `contextWindow` was supplied (the
   * fill ratio had the last word, exactly as in the loop), `'manual'` when it
   * was not (forced — every layer ran once). Matches the `trigger` field on the
   * compaction stream part and observation event.
   */
  trigger: 'manual' | 'threshold';
}

/**
 * Compact a message history by hand.
 *
 * ```ts
 * const { messages, events } = await compactMessages(history, 'auto', {
 *   contextWindow: 200_000,
 *   summarize: async (slice, previousSummary) =>
 *     (await generateText({ model, messages: buildSummaryPrompt(slice, previousSummary) })).text,
 * });
 * ```
 *
 * Never throws: a failing summarizer skips its layer (`onSkip`) and the layers
 * that already ran are kept. Untouched messages keep reference equality, so a
 * React state or prompt cache built on the input survives the round-trip.
 */
export async function compactMessages(
  messages: Message[],
  policy: CompactionOption = 'auto',
  deps?: CompactMessagesDeps,
): Promise<CompactMessagesResult> {
  const normalized = normalizeCompaction(policy);
  // No window ⇒ no fill ratio ⇒ nothing for a threshold to gate: force mode
  // runs the layers once instead of asking a question it cannot answer.
  const mode = deps?.contextWindow ? 'threshold' : 'force';
  const estimator = createTokenEstimator(
    normalized.countTokens ? { countTokens: normalized.countTokens } : undefined,
  );
  const ctx: ApplyCompactionCtx = {
    estimate: deps?.estimateTokens ?? ((m) => estimator.estimate(m)),
    contextWindow: deps?.contextWindow ?? Number.POSITIVE_INFINITY,
    mode,
    ...(deps?.summarize ? { summarize: deps.summarize } : {}),
    ...(deps?.onSkip ? { onSkip: deps.onSkip } : {}),
  };
  const result = await applyCompaction(messages, normalized, ctx);
  return { ...result, trigger: mode === 'force' ? 'manual' : 'threshold' };
}
