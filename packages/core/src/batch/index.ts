/**
 * `@deuz-sdk/core/batch` (2.3): provider batch APIs — OpenAI (Files +
 * Batches, on the Responses or Chat Completions endpoint), Anthropic Message
 * Batches and Gemini batch mode — for single-turn requests, billed on the
 * providers' batch tier.
 *
 * - `createBatchClient({ model })` submits requests (bodies built by the
 *   model's own adapter, streaming off), follows the batch (`status`, `wait`,
 *   `cancel`) and reads one normalized result per request (`results`,
 *   `collect`).
 * - With an `execution` context, every request reserves a budget hold at
 *   submit, priced on the batch tier (`ModelPrice.batch`), and its result
 *   settles it — idempotently, in the ledger and in a persistent `BudgetStore`.
 * - A `BatchJob` is plain JSON; `createMemoryBatchJobStore` (or your own
 *   `BatchJobStore`) lets a new process resume open jobs.
 *
 * Edge-safe (Web APIs only). NOT LIVE-VERIFIED: the wire shapes were derived
 * from the providers' official SDK types (`openai` 7.32, `@anthropic-ai/sdk`
 * 0.133, `@google/genai` 2.28) and tested against in-memory stand-ins.
 */
export { createBatchClient } from './client';
export { createMemoryBatchJobStore } from './store';
export { BatchError } from './errors';
export type { BatchErrorKind, BatchErrorOptions } from './errors';
export type {
  BatchProtocol,
  BatchRequest,
  BatchHold,
  BatchJobRequest,
  BatchJob,
  BatchState,
  BatchCounts,
  BatchStatus,
  BatchResultStatus,
  BatchResult,
  BatchJobStore,
  BatchClientOptions,
  BatchCallOptions,
  BatchSubmitOptions,
  BatchWaitOptions,
  BatchResultsOptions,
  BatchClient,
} from './types';
