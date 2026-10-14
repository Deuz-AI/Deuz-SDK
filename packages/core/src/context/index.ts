/**
 * `@deuz-sdk/core/context` (2.4): one token budget for memory, RAG,
 * transcript and the skill catalog. `compileContext` is pure and
 * deterministic; `createContextCompiler` (preview) adds source querying and
 * refresh. Packages are placed append-only with the working memory as an
 * ephemeral tail, so the prompt cache and preserved thinking survive, and
 * every package comes with a manifest of what was selected and why. Off
 * unless configured. Edge-safe.
 */
import { notImplemented } from '../internal/not-implemented';
import type { CompileContextInput, ContextCompiler, ContextPackage } from './types';
import type { CreateContextCompilerOptions } from './types';

export type * from './types';
export * from './working-memory';
export {
  createMemoryContextSource,
  createRagContextSource,
  createTranscriptContextSource,
  createSkillsContextSource,
} from './sources';
export type {
  ContextSourceOptions,
  MemoryContextSourceOptions,
  RagContextSourceOptions,
  TranscriptContextSourceOptions,
  SkillsContextSourceOptions,
} from './sources';
/**
 * The one token estimator (2.4: public here): about 3.6 characters per token,
 * corrected by real usage, or a host tokenizer. `/rag` keeps its own 4
 * characters per token so chunk boundaries do not move.
 */
export { createTokenEstimator } from '../internal/estimate-tokens';
export type { TokenEstimator, TokenEstimatorOptions } from '../internal/estimate-tokens';
export { ContextBudgetExceededError } from '../errors';

/** The added-context budget defaults of spec §2.3. */
export const DEFAULT_CONTEXT_BUDGET = {
  ratio: 0.2,
  maxTokens: 8192,
  workingMemoryTokens: 1024,
  shares: { memory: 2, rag: 2, skills: 1, transcript: 1 },
  candidatesPerSource: 20,
} as const;

/** The retrieval refresh defaults of spec §2.3. */
export const DEFAULT_CONTEXT_REFRESH = { minSteps: 2, maxPasses: 4 } as const;

/**
 * Compiles a context package (2.4). Pure and deterministic: the same input
 * gives the same package, byte for byte; nothing is fetched or awaited.
 *
 * 1. The added-context budget is `min(ratio × (inputTokens − usedTokens),
 *    maxTokens)`; the working memory takes up to `workingMemoryTokens` of it
 *    first, its critical fields (goal, constraints, active task) whatever the
 *    ranking.
 * 2. The rest is shared by source kind (memory 2 : rag 2 : skills 1, plus
 *    transcript 1 when present); a share a source leaves unused flows to the
 *    others (`'reallocated'`).
 * 3. Within a share, candidates go by descending score, then `recordId`; an
 *    entry in `placed` at the same revision (or digest) is `'already-placed'`
 *    and not written again, a digest seen from another source is
 *    `'duplicate'`, and mandatory candidates come first.
 * 4. Selected retrieval forms one `'append'` block (only what is new), the
 *    working memory one `'ephemeral-tail'` block; content is labelled as data
 *    with its origin and source kinds.
 *
 * Throws `ContextBudgetExceededError` (with `input.phase`) when mandatory
 * content does not fit; never truncates it.
 */
export function compileContext(_input: CompileContextInput): ContextPackage {
  return notImplemented('compileContext');
}

/**
 * A stateful context compiler for the native loop (2.4, preview). Implements
 * `ContextLoopHooks`: refreshes retrieval on the first call, an active-task
 * change or `requestRefresh()`, at least `minSteps` model steps apart and at
 * most `maxPasses` times per run (then reusing the last package, with
 * `fallback: 'pass-limit'` in the manifest); a failing optional source is a
 * `context-source-failed` warning, a failing required one stops the call.
 * Reports `deuz.context.compile` spans. A restored `state` compiles the same
 * context again; refusing a legacy durable session for adaptive use is the
 * loop's job.
 */
export function createContextCompiler(_options: CreateContextCompilerOptions): ContextCompiler {
  return notImplemented('createContextCompiler');
}
