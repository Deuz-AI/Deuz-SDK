import { DeuzError, type DeuzErrorJSON } from '../errors';
import type { BatchJob } from './types';

/**
 * What went wrong with a batch (2.3):
 *
 * - `unsupported` — the model has no batch API here: only OpenAI (Responses and
 *   Chat Completions), Anthropic and Gemini on their own APIs batch; Vertex AI,
 *   Bedrock, Azure and the other OpenAI-compatible hosts do not.
 * - `invalid-request` — the batch cannot be sent as given: no requests, a
 *   missing, malformed or repeated `id`, `prompt` with `messages`, an
 *   agentic-loop option, or more requests or bytes than the provider takes.
 * - `invalid-job` — a job handle that is malformed, or that belongs to another
 *   provider than the client's model.
 * - `not-ended` — results were read before the provider finished the batch.
 * - `timeout` — `wait` gave up after its `timeoutMs`.
 * - `provider` — the provider answered a lifecycle call with something this
 *   module cannot use (no batch id, an unknown result format).
 * - `store` — no job store is configured for a call that needs one, or the
 *   store failed to record a job the provider accepted: `job` then carries the
 *   handle, so the caller can keep it and read its results.
 *
 * Provider HTTP failures keep their own typed errors (`RateLimitError`,
 * `AuthenticationError`, …), mapped by the model's wire.
 */
export type BatchErrorKind =
  | 'unsupported'
  | 'invalid-request'
  | 'invalid-job'
  | 'not-ended'
  | 'timeout'
  | 'provider'
  | 'store';

export interface BatchErrorOptions {
  kind: BatchErrorKind;
  message: string;
  provider?: string;
  /** The provider batch id, when the error is about one job. */
  batchId?: string;
  /** The submitted job a failing store could not record (kind `store`). */
  job?: BatchJob;
  cause?: unknown;
}

/** A batch failure. `kind` is the branch point; messages never carry credentials. */
export class BatchError extends DeuzError {
  readonly code = 'batch_error';
  readonly kind: BatchErrorKind;
  readonly provider?: string;
  readonly batchId?: string;
  /** The submitted job a failing store could not record (kind `store`). */
  readonly job?: BatchJob;

  constructor(options: BatchErrorOptions) {
    super(options.message, { cause: options.cause });
    this.kind = options.kind;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.batchId !== undefined) this.batchId = options.batchId;
    if (options.job !== undefined) this.job = options.job;
  }

  override toJSON(): DeuzErrorJSON {
    const json = super.toJSON();
    return {
      ...json,
      details: {
        ...json.details,
        kind: this.kind,
        ...(this.batchId !== undefined ? { batchId: this.batchId } : {}),
      },
    };
  }
}
