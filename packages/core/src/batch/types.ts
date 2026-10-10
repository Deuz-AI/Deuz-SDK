import type { ModelCapabilities } from '../core/registry';
import type { DeuzError } from '../errors';
import type { CommonCallOptions } from '../types/config';
import type { Dependencies } from '../types/deps';
import type { NativeExecutionContext } from '../types/execution';
import type { Message } from '../types/message';
import type { CallWarning, StopDetails } from '../types/methods';
import type { LanguageModel, ModelSurface } from '../types/model';
import type { JSONSchema, StandardSchemaV1 } from '../types/schema';
import type { FinishReason, Usage } from '../types/usage';

/** The provider batch API a model's requests go to (2.3). */
export type BatchProtocol = 'openai' | 'anthropic' | 'gemini';

/**
 * One single-turn request of a batch (2.3): what `generateText` or
 * `generateObject` would send, without tools. Every request of a batch runs on
 * the client's model.
 */
export interface BatchRequest<T = unknown> {
  /**
   * Your id for the request: 1–64 letters, digits, `_` or `-`, unique in the
   * batch. Its result carries it; providers return results in any order.
   */
  readonly id: string;
  /** A single user turn. Pass `prompt` or `messages`, not both. */
  readonly prompt?: string;
  /** The conversation, as for `generateText`. */
  readonly messages?: Message[];
  /** The system prompt, kept apart from `messages` as for `generateText`. */
  readonly instructions?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly topP?: number;
  readonly stopSequences?: string[];
  readonly effort?: CommonCallOptions['effort'];
  readonly responseFormat?: CommonCallOptions['responseFormat'];
  readonly providerOptions?: CommonCallOptions['providerOptions'];
  readonly promptCaching?: CommonCallOptions['promptCaching'];
  /** Replaces the hold's estimate, as `executionEstimate` does for a call. */
  readonly executionEstimate?: CommonCallOptions['executionEstimate'];
  /**
   * Structured output: the result's `object` is the reply parsed as JSON and,
   * for a Standard Schema, validated. There is no repair attempt: a reply that
   * does not parse or validate comes back with an `error`.
   */
  readonly schema?: StandardSchemaV1<unknown, T> | JSONSchema;
  readonly schemaName?: string;
  readonly schemaDescription?: string;
  /** The structured-output strategy, as for `generateObject`; default `'auto'`. */
  readonly mode?: 'auto' | 'json' | 'tool';
}

/** A request's budget hold (2.3), recorded on the job so a new process can settle it. */
export interface BatchHold {
  /** The ledger request id: `<scopeId>/batch/<job key>/<request id>`. */
  readonly id: string;
  /** The reserved estimates. */
  readonly tokens: number;
  readonly usd?: number;
  /** The model had no batch price when the hold was reserved. */
  readonly unpriced?: true;
}

/** One request as the job remembers it. */
export interface BatchJobRequest {
  readonly id: string;
  /** Its budget hold, when the client has an execution context. */
  readonly hold?: BatchHold;
  /** How a structured request's object comes back: JSON text, or a forced tool call. */
  readonly object?: { readonly strategy: 'json' | 'tool'; readonly toolName?: string };
}

/**
 * A submitted batch (2.3): plain JSON, safe to store and to hand to another
 * process. It never holds credentials; the client's model supplies them.
 */
export interface BatchJob {
  readonly version: 1;
  /** The provider's batch id: `batch_…` (OpenAI), `msgbatch_…` (Anthropic), `batches/…` (Gemini). */
  readonly id: string;
  readonly protocol: BatchProtocol;
  readonly provider: string;
  readonly modelId: string;
  readonly surface: ModelSurface;
  /** When it was submitted: epoch milliseconds on `deps.clock`. */
  readonly submittedAt: number;
  /** When the provider expires it, when the provider says. */
  readonly expiresAt?: number;
  /**
   * Until when its holds are meant to stay open: `submittedAt + holdMs`. A
   * `BudgetStore.sweep` must not close them before this.
   */
  readonly holdUntil: number;
  /** OpenAI: the endpoint its lines target and the uploaded input file. */
  readonly endpoint?: '/v1/responses' | '/v1/chat/completions';
  readonly inputFileId?: string;
  readonly displayName?: string;
  /** The execution scope its holds were reserved under. */
  readonly scopeId?: string;
  /** Every request, in submission order. */
  readonly requests: readonly BatchJobRequest[];
  /** Notices from building the requests: dropped or clamped settings, an unpriced model. */
  readonly warnings?: readonly CallWarning[];
  /**
   * Set once every result was read: every hold is settled, released, or left
   * unknown for a `BudgetStore.sweep` (reading again would not change it).
   */
  readonly closedAt?: number;
}

/**
 * Where a batch stands (2.3). `pending` (accepted, not started), `running`,
 * `cancelling`; then one of the ended states: `completed`, `cancelled`,
 * `expired` (the provider's window passed) or `failed` (the batch as a whole
 * failed, such as an input file that did not validate).
 */
export type BatchState =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

/** Request counts, as far as the provider reports them. */
export interface BatchCounts {
  readonly total: number;
  readonly succeeded: number;
  readonly errored: number;
  readonly cancelled?: number;
  readonly expired?: number;
  /** Not finished yet. */
  readonly processing?: number;
}

export interface BatchStatus {
  /** The provider batch id. */
  readonly id: string;
  readonly state: BatchState;
  /** True once the provider finished the batch: its results can be read. */
  readonly ended: boolean;
  /** The provider's own status value. */
  readonly providerState: string;
  readonly counts?: BatchCounts;
  /** When the provider expires the batch (epoch milliseconds), when it says. */
  readonly expiresAt?: number;
  /** Why the batch as a whole failed, when the provider says. */
  readonly error?: string;
}

/** What the provider did with one request. */
export type BatchResultStatus = 'succeeded' | 'errored' | 'cancelled' | 'expired';

export interface BatchResult<T = unknown> {
  /** The request's `id`. */
  readonly id: string;
  readonly status: BatchResultStatus;
  /** The reply's text; `''` when there is none. */
  readonly text: string;
  /** The reply's readable reasoning, when it carried some. */
  readonly reasoning?: string;
  /** A structured request's object, parsed and (for a Standard Schema) validated. */
  readonly object?: T;
  readonly finishReason?: FinishReason;
  /** The request's usage, per the 2.3 usage contract. */
  readonly usage?: Usage;
  /** `false` when the provider reported no usage for the request: its cost is unknown. */
  readonly usageAvailable?: boolean;
  /** Its cost on the batch tier, when `deps.priceProvider` has a batch price for the model. */
  readonly costUsd?: number;
  /**
   * Why there is no usable output: the provider's error for the request, or an
   * object that did not parse or validate (then `status` is `'succeeded'`: the
   * request ran and was billed).
   */
  readonly error?: DeuzError;
  readonly stopDetails?: StopDetails;
  readonly providerMetadata?: Record<string, unknown>;
}

/** Where jobs are kept so a new process can resume them (2.3). */
export interface BatchJobStore {
  /** Insert or replace the record of `job.id`. */
  put(job: BatchJob): Promise<void>;
  /** The record of a job, or `undefined`. */
  get(id: string): Promise<BatchJob | undefined>;
  /** Every record, oldest first. */
  list(): Promise<BatchJob[]>;
  /** Forget a job. */
  delete(id: string): Promise<void>;
}

export interface BatchClientOptions {
  /**
   * The model every request runs on: one model per batch. Its factory's
   * `apiKey`, `baseURL`, `fetch` and `headers` apply, as for any call.
   */
  readonly model: LanguageModel;
  readonly deps?: Dependencies;
  /**
   * Budget holds (2.3): each request reserves a hold at submit, priced on the
   * batch tier, and its result settles it. Without it nothing is reserved.
   */
  readonly execution?: NativeExecutionContext;
  /** Records every job, so a new process can resume it (`pending()`). */
  readonly store?: BatchJobStore;
  /**
   * How long a request's hold may stay open: the provider's batch window plus
   * time to read the results. Default 25 hours (a 24-hour window and 1 hour).
   */
  readonly holdMs?: number;
  /** Extra headers on every batch call. */
  readonly headers?: Record<string, string>;
  /** Overrides the registry row of the model, as `capabilities` does for a call. */
  readonly capabilities?: Partial<ModelCapabilities>;
}

export interface BatchCallOptions {
  readonly signal?: AbortSignal;
}

export interface BatchSubmitOptions extends BatchCallOptions {
  /** A label: OpenAI `metadata.display_name`, Gemini `displayName`; Anthropic has none. */
  readonly displayName?: string;
}

export interface BatchWaitOptions extends BatchCallOptions {
  /** Time between polls; default 60 000 ms. */
  readonly intervalMs?: number;
  /** Give up after this long with `BatchError` kind `'timeout'`; default never. */
  readonly timeoutMs?: number;
  /** Called with every status a poll reads. */
  readonly onStatus?: (status: BatchStatus) => void;
}

export interface BatchResultsOptions extends BatchCallOptions {
  /**
   * Schemas to validate `object` with, by request id. The client keeps the
   * ones it submitted in memory until the job's results were read once; a
   * later read, or a new process, passes them here.
   */
  readonly schemas?: Readonly<Record<string, StandardSchemaV1 | JSONSchema>>;
}

export interface BatchClient {
  /** Reserve a hold per request (with an execution context), then send the batch. */
  submit(requests: readonly BatchRequest[], options?: BatchSubmitOptions): Promise<BatchJob>;
  /** Read where the batch stands (one provider call). */
  status(job: BatchJob, options?: BatchCallOptions): Promise<BatchStatus>;
  /** Poll until the batch ends. */
  wait(job: BatchJob, options?: BatchWaitOptions): Promise<BatchStatus>;
  /**
   * The results of an ended batch, one per request, settling each request's
   * hold as its result is read. Reading them again is safe: settlement is
   * idempotent.
   */
  results(job: BatchJob, options?: BatchResultsOptions): AsyncIterable<BatchResult>;
  /** `results` into an array. */
  collect(job: BatchJob, options?: BatchResultsOptions): Promise<BatchResult[]>;
  /** Ask the provider to cancel the batch. Read its results afterwards to close the holds. */
  cancel(job: BatchJob, options?: BatchCallOptions): Promise<BatchStatus>;
  /** The stored jobs whose results were not all read yet, oldest first (needs `store`). */
  pending(): Promise<BatchJob[]>;
}
