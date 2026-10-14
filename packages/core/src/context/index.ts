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
import type { ContextCompiler, CreateContextCompilerOptions } from './types';

export type * from './types';
export * from './working-memory';
export { compileContext } from './compile';
export { DEFAULT_CONTEXT_BUDGET, DEFAULT_CONTEXT_REFRESH } from './defaults';
export {
  ANTHROPIC_TOOL_FRAMING_TOKENS,
  estimateRequestOverhead,
  estimateRequestTokens,
  estimateTextTokens,
} from './count';
export type { ContextToolSchema, RequestOverheadInput } from './count';
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
