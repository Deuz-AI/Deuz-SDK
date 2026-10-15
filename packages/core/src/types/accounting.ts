/**
 * The accounted-call contract (2.4, spec §3.1). In 2.3 several helper calls
 * never reached a budget ledger: `embed()` only calls `onUsage`, memory LLM
 * callbacks return a bare string, the RAG embedder returns bare vectors and
 * `createVerifier`'s judge call is unbudgeted. 2.4 charges them:
 *
 * - A call the SDK makes itself (`embed`, `embedMany`, `createVerifier`) takes
 *   a {@link CallAccounting}: it reserves on the execution context before the
 *   request and settles the provider's usage after it.
 * - A host callback reports its usage through an accounted variant
 *   ({@link AccountedMemoryLLM}, {@link AccountedEmbedder},
 *   {@link AccountedMemoryEmbedder}), marked `accounted: true` so a strict
 *   budget can tell before calling it.
 *
 * A callback without the mark is never counted as free: its reservation is
 * marked `unaccounted` (`BudgetReservation.unaccounted`) and the call reports
 * one `unaccounted-usage` warning; under `unknownPrice: 'reject'` it is
 * refused before it runs. Nothing here adds a paid call to a 2.3 API.
 */
import type { NativeExecutionContext } from './execution';
import type { Usage } from './usage';

/** What a callback reports about one model or embedding call it made (2.4). */
export interface AccountedUsage {
  /** The provider-reported usage of the call. */
  usage: Usage;
  /** The model the call went to: prices are looked up by it. */
  modelId: string;
}

/**
 * Ledger accounting for a call the SDK makes itself (2.4): `embed()` and
 * `embedMany()` (`EmbedOptions.accounting`), the RAG ingestion embeddings and
 * `createVerifier`. The call reserves `tokens`/`usd` on `execution` under
 * `requestId` before the request, settles the reported usage after it, and
 * marks the reservation unknown when the request may have been billed but no
 * usage came back.
 */
export interface CallAccounting {
  /** The context whose ledger, policy and budget the call is admitted against. */
  readonly execution: NativeExecutionContext;
  /** Unique per billable attempt and stable across recovery. */
  readonly requestId: string;
  /** The reservation's kind; defaults to the call's own (`'embedding'`, `'verifier'`). */
  readonly kind?: string;
  /** Conservative token estimate; defaults to the shared estimator's count of the input. */
  readonly tokens?: number;
  /** Conservative USD estimate; defaults to the price of `tokens` when the model is priced. */
  readonly usd?: number;
}

/** An accounted memory LLM's answer: its text and the call's usage (2.4). */
export interface AccountedMemoryLLMResult extends AccountedUsage {
  text: string;
}

/**
 * The accounted variant of `MemoryLLM` (2.4): the same prompt in, the text and
 * the call's usage out. Build one with `defineAccountedMemoryLLM` and pass it
 * as `MemorySeams.accountedLlm` (`MemorySeams.llm` stays a plain `MemoryLLM`)
 * or as a versioned memory session's `llm`.
 */
export interface AccountedMemoryLLM {
  (prompt: { system: string; user: string }): Promise<AccountedMemoryLLMResult>;
  /** Declares that the callback reports usage. */
  readonly accounted: true;
}

/** An accounted embedder's answer: the vectors and the call's usage (2.4). */
export interface AccountedEmbeddings extends AccountedUsage {
  vectors: number[][];
}

/**
 * The accounted variant of the RAG `Embedder` (2.4): vectors plus the call's
 * usage. Build one with `defineAccountedEmbedder`.
 */
export interface AccountedEmbedder {
  embed(texts: string[]): Promise<AccountedEmbeddings>;
  readonly dims: number;
  /** Declares that the embedder reports usage. */
  readonly accounted: true;
}

/**
 * The accounted variant of the memory `Embedder` (2.4): `{ vectors, model }`
 * as before, plus the call's usage (`modelId` is the model that answered).
 */
export interface AccountedMemoryEmbedder {
  embed(
    texts: string[],
    action: 'add' | 'search' | 'update',
  ): Promise<AccountedEmbeddings & { model: string }>;
  /** Declares that the embedder reports usage. */
  readonly accounted: true;
}
