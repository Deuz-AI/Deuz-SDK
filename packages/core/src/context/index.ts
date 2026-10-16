/**
 * `@deuz-sdk/core/context` (2.4): one token budget for memory, RAG,
 * transcript and the skill catalog. `compileContext` is pure and
 * deterministic; `createContextCompiler` (preview) adds source querying and
 * refresh. Packages are placed append-only with the working memory as an
 * ephemeral tail, so the prompt cache and preserved thinking survive, and
 * every package comes with a manifest of what was selected and why. Off
 * unless configured. Edge-safe.
 */
export type * from './types';
export * from './working-memory';
export { compileContext } from './compile';
export { createContextCompiler, contextPackageBlob, contextWarnings } from './compiler';
export type { ContextPackageBlob } from './compiler';
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
