/**
 * Context compiler contracts (2.4, spec §2.3): memory, RAG, transcript and
 * skill-catalog candidates selected into one token budget, placed so the
 * provider's prompt cache survives, and explained by a manifest.
 *
 * Placement (spec §2.3 "Yerleşim ve prompt cache"):
 * - The system message and tool schemas never change on a refresh: the cached
 *   prefix (system, tools, earlier turns) is kept.
 * - Retrieval enters the message stream append-only (`'append'` blocks): a new
 *   pass appends only what earlier packages lack (an entry already placed at
 *   the same revision is never written again), and an earlier block is never
 *   rewritten in place, which on Claude 5.x would drop preserved thinking.
 * - The working memory's current state is an `'ephemeral-tail'` block, added
 *   after the last message of each request and never written to history, so
 *   the model never sees stale versions of it. On a model that binds
 *   preserved thinking to the prefix (Claude 5.x) a V3 run keeps each step's
 *   copy in the history once the call succeeded instead, since the step's
 *   thinking was generated right after it (the provider's prefix rule wins);
 *   every copy reads as replacing the earlier ones, and the manifest records
 *   `placement.tailKept`.
 * - Old blocks go only at a safe compaction boundary; the working memory is
 *   then placed again from the durable V3 state, never from a summary.
 *
 * Memory, RAG and transcript content is data, never instructions: it is
 * labelled with its origin and source kind, and can change neither tool
 * permissions nor host instructions.
 */
import type { Sha256Digest } from '../internal/digest';
import type { TokenEstimator } from '../internal/estimate-tokens';
import type { MemoryScope } from '../memory';
import type { Dependencies } from '../types/deps';
import type { Message } from '../types/message';
import type { CallWarning } from '../types/methods';
import type { MemoryOrigin, MemorySourceKind } from '../memory/versioned/types';
import type { WorkingMemorySnapshot } from './working-memory/types';

// ===================================================================
// Sources and candidates
// ===================================================================

/** The kinds of context sources; budget shares are set per kind. */
export type ContextSourceKind = 'memory' | 'rag' | 'transcript' | 'skills';

/** How a candidate is labelled when placed: data, with where it came from. */
export interface ContextProvenance {
  origin?: MemoryOrigin;
  sourceKinds?: MemorySourceKind[];
}

/** One item a source offers for the context. */
export interface ContextCandidate {
  /** Stable within its source: a memory record id, chunk id, message id or skill name. */
  recordId: string;
  /** The item's revision, when it has revisions (memory records). */
  revision?: number;
  /**
   * `sha256:<hex>` of `text`. With `revision` it identifies what was placed:
   * an entry already placed at the same revision (or, without one, the same
   * digest) is not placed again.
   */
  digest: Sha256Digest;
  /** The content as it would be placed. */
  text: string;
  /** Relevance within the source; higher ranks first. */
  score: number;
  /** Token estimate of the placed text; the compiler estimates it when absent. */
  tokens?: number;
  provenance?: ContextProvenance;
  /**
   * Must be placed whatever the ranking: content the model already loaded
   * (`load_skill`). Mandatory content that does not fit throws
   * `ContextBudgetExceededError`, never a silent cut.
   */
  mandatory?: boolean;
  /** The query that found it. */
  query?: string;
  /** How the source matched it, e.g. `'vector'`, `'lexical'`, `'hybrid'`, `'catalog'`. */
  match?: string;
}

/** What a source is asked for. */
export interface ContextSourceRequest {
  /**
   * The query: the latest user text and the active task's title, as the
   * compiler derives it. No LLM rewriting unless the host configures it.
   */
  text: string;
  /**
   * The host-pinned memory scope. A child run may only narrow it, by the same
   * rule as native runs (`scopeWithin` / `claimMemoryScope`).
   */
  scope?: MemoryScope;
  /** Candidates wanted at most. Default 20. */
  limit: number;
  /** The share of the budget the source may fill, in tokens (a hint). */
  budgetTokens: number;
  /** Versioned memory reads what the store knew then, so a restart reads the same. */
  recordedAsOf?: number;
  signal?: AbortSignal;
}

/**
 * A context source (2.4). An optional source that fails produces a
 * `context-source-failed` warning and the step goes on without it; a required
 * source that fails stops the model call.
 */
export interface ContextSource {
  /** Unique within one compiler; recorded in the manifest. */
  readonly id: string;
  readonly kind: ContextSourceKind;
  /** Default false. */
  readonly required?: boolean;
  /** Up to `request.limit` candidates; nothing found is `[]`, never a throw. */
  query(request: ContextSourceRequest): Promise<readonly ContextCandidate[]>;
}

/** One source's answer, as `compileContext` takes it. */
export interface ContextSourceResult {
  source: { id: string; kind: ContextSourceKind; required?: boolean };
  status: 'ok' | 'failed' | 'skipped';
  candidates: readonly ContextCandidate[];
  /** For a failed source: what went wrong (name and code only). */
  error?: { name: string; code?: string };
}

// ===================================================================
// Budget and refresh
// ===================================================================

/** How the added context is budgeted (spec §2.3 defaults in `DEFAULT_CONTEXT_BUDGET`). */
export interface ContextBudgetOptions {
  /** Share of the usable input budget for added context, 0..1. Default 0.2. */
  ratio?: number;
  /** Cap on the added context, in tokens. Default 8192. */
  maxTokens?: number;
  /** The working memory's priority share, in tokens. Default 1024. */
  workingMemoryTokens?: number;
  /**
   * Relative shares of what remains, by source kind. Default memory 2, rag 2,
   * skills 1, and transcript 1 when a transcript source is configured. A
   * share a source does not use flows to the others.
   */
  shares?: Partial<Record<ContextSourceKind, number>>;
  /** Candidates asked of each source. Default 20. */
  candidatesPerSource?: number;
}

/** The token arithmetic of one compile. */
export interface ContextBudget {
  /** The model's usable input budget: its context window minus the output reservation. */
  inputTokens: number;
  /**
   * What the request already takes without added context: messages, tool
   * schemas, output schema and provider framing (estimated).
   */
  usedTokens: number;
  /** The added-context budget resolved from the options. */
  contextTokens: number;
  /** Of which the working memory's priority share. */
  workingMemoryTokens: number;
}

/** When retrieval runs (spec §2.3 defaults in `DEFAULT_CONTEXT_REFRESH`). */
export interface ContextRefreshOptions {
  /** Model steps at least between automatic refreshes. Default 2. */
  minSteps?: number;
  /** Retrieval passes per run at most. Default 4; then the last package is reused. */
  maxPasses?: number;
  /** Rewrites the query with a model. Default: none (off). */
  rewriteQuery?: (query: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * Why a package was compiled as it was: the first call, a change of the
 * active task, a host request, no retrieval this step (`'reused'`), an
 * overflow retry under a smaller budget, or a checkpointed package that a
 * `forget` redacted and that was compiled again.
 */
export type ContextRefreshReason =
  | 'initial'
  | 'active-task-changed'
  | 'host-request'
  | 'reused'
  | 'overflow-retry'
  | 'redacted';

/** What the token counts rest on: the built-in estimate, a host tokenizer, or a provider count. */
export interface ContextEstimator {
  kind: 'heuristic' | 'tokenizer' | 'provider';
  /** Whether real usage has calibrated it (the EMA of `createTokenEstimator`). */
  calibrated: boolean;
}

// ===================================================================
// Package and manifest
// ===================================================================

/** Where a block goes: appended to history once, or after the last message of this request only. */
export type ContextPlacement = 'append' | 'ephemeral-tail';

/** One placed block of a package. */
export interface ContextBlock {
  /** `'append'` for retrieval, `'ephemeral-tail'` for working memory. */
  placement: ContextPlacement;
  kind: 'retrieval' | 'working-memory';
  /** The messages placed: data, labelled with provenance, never instructions. */
  messages: Message[];
  tokens: number;
  /** The manifest entries the block carries, by index into `manifest.entries`. */
  entries: number[];
}

/** Why an entry was selected or left out. */
export type ContextEntryReason =
  /** Selected by rank within its share. */
  | 'ranked'
  /** Selected from a share another source left unused. */
  | 'reallocated'
  /** Selected because it is mandatory. */
  | 'mandatory'
  /** Left out: placed by an earlier package at the same revision. */
  | 'already-placed'
  /** Left out: did not fit the budget. */
  | 'over-budget'
  /** Left out: the same digest came from another source. */
  | 'duplicate'
  /** Left out: its record was forgotten (the package was redacted). */
  | 'redacted';

/** One candidate in the manifest: ids, digests and tokens, never its text. */
export interface ContextManifestEntry {
  /** `ContextSource.id`, or `'working-memory'`. */
  source: string;
  kind: ContextSourceKind | 'working-memory';
  recordId: string;
  revision?: number;
  digest: Sha256Digest;
  query?: string;
  selected: boolean;
  reason: ContextEntryReason;
  tokens: number;
}

/** One source in the manifest. */
export interface ContextManifestSource {
  source: string;
  kind: ContextSourceKind;
  required: boolean;
  status: ContextSourceResult['status'];
  selected: number;
  excluded: number;
  tokens: number;
  error?: { name: string; code?: string };
}

/** A content-addressed blob of a compiled package in the V3 run store. */
export interface ContextBlobRef {
  /** `sha256:<hex>` of the canonical JSON of the package's blocks. */
  digest: Sha256Digest;
  bytes: number;
}

/**
 * What a compile selected and left out, and why (2.4). Carries ids,
 * revisions, digests, queries and token counts, never memory or document
 * text; the V3 run stores it with the run and the package as a blob.
 */
export interface ContextManifest {
  version: 1;
  /** The model step the package was compiled for. */
  step: number;
  entries: ContextManifestEntry[];
  sources: ContextManifestSource[];
  budget: ContextBudget & { selectedTokens: number };
  estimator: ContextEstimator;
  refresh: ContextRefreshReason;
  /** The run's retrieval pass the package's retrieval came from (1-based). */
  pass: number;
  /**
   * `'pass-limit'`: the run used its retrieval passes and the last package was
   * reused. `'source-failed'`: an optional source failed and was left out.
   */
  fallback?: 'pass-limit' | 'source-failed';
  /**
   * Which blocks the package placed. `tailKept` (2.4, V3 runs): the working
   * memory block joined the history after the call instead of ending that
   * request only, because the model binds preserved thinking to the
   * transcript prefix (Claude 5.x); absent otherwise.
   */
  placement: { append: boolean; tail: boolean; tailKept?: boolean };
  /**
   * Whether the request's cached prefix (system, tools, earlier turns) differs
   * from the previous request's. False in normal operation; true only after a
   * compaction boundary or a host change.
   */
  cachePrefixChanged: boolean;
  /** A `forget` redacted entries of this package; it was compiled again on reopen. */
  redacted?: boolean;
  /** The package blob, once the V3 store wrote it. */
  blob?: ContextBlobRef;
}

/** A compiled context package (2.4): the blocks to place and their manifest. */
export interface ContextPackage {
  version: 1;
  /** At most one `'append'` block and one `'ephemeral-tail'` block, in that order. */
  blocks: ContextBlock[];
  manifest: ContextManifest;
}

/** An entry placed by an earlier package of the run. */
export interface ContextPlacedEntry {
  source: string;
  recordId: string;
  revision?: number;
  digest: Sha256Digest;
  /**
   * The retrieval pass whose `'append'` block carries it. The stateful
   * compiler forgets an entry once no message carries that block any more
   * (a compaction removed it), so the entry can be placed again.
   */
  pass?: number;
  /**
   * The model step of the `'append'` block that carries it (2.4): with
   * `pass`, it names that one block (`<deuz_context pass="P" step="S">`),
   * since a block placing entries again after a compaction keeps the
   * current pass. Without it, any block of the pass counts.
   */
  step?: number;
  /**
   * Placed as mandatory content (2.4), such as a loaded skill body. When a
   * compaction removes its block and the compiler did not retrieve it itself
   * (it was restored from a checkpoint), it asks the source again instead of
   * waiting for the next refresh.
   */
  mandatory?: boolean;
}

// ===================================================================
// The pure compiler
// ===================================================================

/** Input of `compileContext`: everything it needs, nothing it fetches. */
export interface CompileContextInput {
  step: number;
  /** The sources' answers, already gathered. */
  results: readonly ContextSourceResult[];
  /** The model's usable input budget and what the request already takes. */
  inputTokens: number;
  usedTokens: number;
  budget?: ContextBudgetOptions;
  workingMemory?: WorkingMemorySnapshot;
  /** What earlier packages of the run placed: same revision, not placed again. */
  placed?: readonly ContextPlacedEntry[];
  refresh: ContextRefreshReason;
  pass: number;
  fallback?: ContextManifest['fallback'];
  cachePrefixChanged?: boolean;
  /** `'overflow-retry'` recompiles under the smaller budget of an overflow. */
  phase?: 'compile' | 'overflow-retry';
  estimator?: TokenEstimator;
  estimatorKind?: ContextEstimator;
}

// ===================================================================
// The native loop's hooks and the stateful compiler
// ===================================================================

/**
 * What the native loop knows at the point it asks for context: after
 * compaction and the host's `prepareStep`, with the real model and active
 * tools resolved (spec §2.3 order, steps 1–3).
 */
export interface ContextStepInput {
  runId: string;
  step: number;
  /** The messages the request would send. */
  messages: Message[];
  model: { provider: string; modelId: string; contextWindow: number; maxOutputTokens: number };
  /** Estimated tokens of the active tools' schemas, the output schema and framing. */
  overheadTokens: number;
  /** The working memory to place as the tail. */
  workingMemory?: WorkingMemorySnapshot;
  /** The host asked for a retrieval refresh at this step. */
  refresh?: boolean;
  /**
   * What the token counts rest on at this step, e.g. `calibrated: true` once
   * the loop has fed real usage to the shared estimator. Default: the
   * compiler's `estimatorKind`.
   */
  estimatorKind?: ContextEstimator;
  /**
   * The checkpointed package of this step was redacted by a `forget`: compile
   * it again with a fresh retrieval (refresh `'redacted'`, the one documented
   * exception to reusing a checkpointed package). It bypasses `minSteps` and
   * `maxPasses`.
   */
  redacted?: boolean;
  signal?: AbortSignal;
}

/**
 * The hooks the native loop calls (2.4). Before each model call it asks for
 * the package (spec §2.3 steps 4–5) and writes it with its manifest to the V3
 * run before calling the model. On an overflow retry (where 2.3 compacts
 * again without re-running `prepareStep`) it asks for a recompile under the
 * smaller budget; mandatory content that does not fit throws
 * `ContextBudgetExceededError` with phase `'overflow-retry'`.
 */
export interface ContextLoopHooks {
  beforeModelCall(input: ContextStepInput): Promise<ContextPackage>;
  onOverflow(input: ContextStepInput & { inputTokens: number }): Promise<ContextPackage>;
}

/** The compiler state a V3 checkpoint keeps, so a restart compiles the same. */
export interface ContextCompilerState {
  version: 1;
  /** Retrieval passes used by the run. */
  passes: number;
  /** The model step of the last retrieval. */
  lastRefreshStep?: number;
  /** The active task at the last retrieval. */
  activeTaskId?: string;
  /** Everything placed so far. */
  placed: ContextPlacedEntry[];
  /** The last package's blob, reused when no retrieval runs. */
  lastPackage?: ContextBlobRef;
  /** A refresh the host asked for that has not run yet. */
  refreshRequested?: boolean;
  /**
   * The previous request's message prefix (its messages and the `'append'`
   * block placed after them): when the next request no longer starts with it,
   * the manifest records `cachePrefixChanged: true`.
   */
  prefix?: { messages: number; digest: Sha256Digest };
}

/**
 * The stateful compiler (2.4, preview): queries the sources when a refresh is
 * due (the first call, an active-task change, a host request; at least
 * `minSteps` model steps apart, at most `maxPasses` passes per run), then
 * compiles with `compileContext`.
 */
export interface ContextCompiler extends ContextLoopHooks {
  readonly sources: readonly ContextSource[];
  /** Asks for a retrieval refresh at the next model call. */
  requestRefresh(): void;
  /** The state to checkpoint. */
  state(): ContextCompilerState;
}

/** Options of `createContextCompiler`. */
export interface CreateContextCompilerOptions {
  sources: readonly ContextSource[];
  budget?: ContextBudgetOptions;
  refresh?: ContextRefreshOptions;
  /** The host-pinned memory scope handed to every source. */
  scope?: MemoryScope;
  /** The shared token estimator (`createTokenEstimator`), calibrated by the loop. */
  estimator?: TokenEstimator;
  estimatorKind?: ContextEstimator;
  /** A checkpointed state to continue from. */
  state?: ContextCompilerState;
  /** Clock, ids, logger, observer (`deuz.context.compile` spans). */
  deps?: Dependencies;
  /**
   * Receives a `context-source-failed` warning for each optional source that
   * failed (the manifest records it too).
   */
  onWarning?: (warning: CallWarning) => void;
}
