/**
 * `@deuz-sdk/core/evolve` (2.2) — evolutionary program search: AlphaEvolve's
 * evolve blocks and SEARCH/REPLACE diffs, an evaluation cascade, islands with
 * ring migration and weakest-island resets, a MAP-Elites archive, a UCB1 model
 * ensemble, novelty rejection, a mandatory budget and durable, zero-call
 * resume over a `PopulationStore`. Edge-safe; the SQLite store is
 * `@deuz-sdk/core/evolve/sqlite`.
 */
export { evolve, resumeEvolve } from './evolve/controller';
export {
  applySearchReplace,
  EvolvePatchError,
  extractFullRewrite,
  parseEvolveBlocks,
  parseSearchReplace,
} from './evolve/patch';
export type {
  EvolveBlock,
  EvolvePatchErrorCode,
  ParsedEvolveSource,
  SearchReplaceBlock,
} from './evolve/patch';
export { buildMutationPrompt } from './evolve/prompt';
export {
  createInMemoryPopulationStore,
  EvolveConflictError,
  evolveCandidateId,
} from './evolve/store';
export type * from './evolve/types';
