import type { BudgetStore, PersistentBudgetScope } from './budget-store';
import type { PriceProvider } from './deps';
import type { Usage } from './usage';

/** Limits include all descendant calls, including auxiliary model calls. */
export interface BudgetLimits {
  readonly tokens?: number;
  readonly usd?: number;
}

/** Mandatory constraints. An omitted allowlist allows all; an empty one allows none. */
export interface ExecutionPolicy {
  readonly allowedTools?: readonly string[];
  readonly allowedModels?: readonly string[];
  /** Absolute nesting depth; the root is depth zero. */
  readonly maxDepth?: number;
  readonly requireApproval?: boolean;
  /** Absolute epoch milliseconds, checked against the injected clock. */
  readonly deadlineAt?: number;
}

export interface BudgetScope {
  readonly id: string;
  readonly budget: BudgetLimits;
}

export interface BudgetReservationInput {
  /** Unique per potentially billable provider attempt, stable across recovery. */
  readonly requestId: string;
  /** The actual model used by this attempt, not the root agent model. */
  readonly modelId: string;
  readonly kind?: string;
  /** Conservative estimates; mandatory for each bounded dimension. */
  readonly tokens?: number;
  readonly usd?: number;
  /** Contexts provide these automatically; direct ledger callers may omit them. */
  readonly scopes?: readonly BudgetScope[];
}

export interface BudgetReservation {
  readonly requestId: string;
  readonly modelId: string;
  readonly kind: string;
  readonly reservation: BudgetLimits;
  readonly actual: BudgetLimits;
  readonly scopes: readonly BudgetScope[];
  readonly state: 'reserved' | 'settled' | 'unknown' | 'released';
  readonly usage?: Readonly<Usage>;
}

export interface BudgetSettlement {
  readonly requestId: string;
  readonly usage?: Usage;
  readonly tokens?: number;
  readonly usd?: number;
}

export interface BudgetTotals {
  readonly spent: Required<BudgetLimits>;
  readonly reserved: Required<BudgetLimits>;
  /** Spent plus still-held reservations. */
  readonly committed: Required<BudgetLimits>;
  /** Attempts with unknown actual amounts, even when the held estimate is zero. */
  readonly unknownTokens: number;
  readonly unknownUsd: number;
}

/**
 * Accounting folded out of finished scopes by `BudgetLedger.compact` (2.2).
 * Folded reservations keep counting against every ancestor scope, so global
 * and ancestor totals are unchanged by compaction.
 */
export interface BudgetAggregate {
  /** Ancestor scopes, root first, that the folded reservations still count against. */
  readonly scopes: readonly BudgetScope[];
  /** Folded reservations. */
  readonly count: number;
  /** Known actual amounts. */
  readonly spent: Required<BudgetLimits>;
  /** Estimates still held for dimensions whose actual amount stayed unknown. */
  readonly held: Required<BudgetLimits>;
  readonly unknownTokens: number;
  readonly unknownUsd: number;
  /** Unknown amounts that carried no estimate: a cap on that dimension fails closed. */
  readonly unestimatedTokens: number;
  readonly unestimatedUsd: number;
}

/** What one `compact` call changed (2.2). */
export interface BudgetCompaction {
  readonly scopeId: string;
  /** Settled or unknown reservations folded into an aggregate. */
  readonly folded: number;
  /** Released reservations dropped; they never counted toward totals. */
  readonly dropped: number;
  /** In-flight reservations left in place until they settle. */
  readonly retained: number;
}

export interface BudgetLedgerSnapshot {
  /** Version 2 (2.2) carries `aggregates`, `subtree` or `admission`; 2.1 readers reject it. */
  readonly version: 1 | 2;
  readonly revision: number;
  readonly budget: BudgetLimits;
  readonly reservations: readonly BudgetReservation[];
  /** Version 2: accounting folded by `compact`. */
  readonly aggregates?: readonly BudgetAggregate[];
  /**
   * Version 2: only the accounting charged to this scope. A native run under a
   * shared child context checkpoints its own slice; the slice proves
   * continuity on resume but can never seed a ledger.
   */
  readonly subtree?: string;
  /**
   * Version 2: the persistent scopes every reservation is admitted against.
   * Restoring requires the store again; a reader that cannot honour them
   * must refuse the snapshot rather than admit without them.
   */
  readonly admission?: readonly PersistentBudgetScope[];
}

/** One scope crossing its warning threshold on admission (2.2). */
export interface BudgetWarning {
  readonly key: string;
  readonly dimension: 'tokens' | 'usd';
  /** Committed usage in the window, including the admitted request's estimate. */
  readonly committed: number;
  readonly limit: number;
  /** `committed / limit * 100`. */
  readonly percent: number;
  readonly warnAtPercent: number;
  /** The reservation that crossed the threshold. */
  readonly requestId: string;
}

/**
 * Persistent admission (2.2): after local admission, every reservation is also
 * admitted by a shared `BudgetStore` against these scopes, inside the ledger's
 * queue. Settlement and release are mirrored; unknown usage keeps the hold.
 */
export interface BudgetAdmission {
  readonly store: BudgetStore;
  readonly scopes: readonly PersistentBudgetScope[];
  /** Warn when committed usage reaches this percentage of a scope limit. */
  readonly warnAtPercent?: number;
  /** Called once per crossing per scope and dimension; errors are ignored. */
  readonly onWarning?: (warning: BudgetWarning) => void;
}

/**
 * Admission when restoring: the snapshot supplies its scopes. Scopes given here
 * are added, and a key the snapshot already has only tightens its limits.
 */
export interface BudgetAdmissionRestore extends Omit<BudgetAdmission, 'scopes'> {
  readonly scopes?: readonly PersistentBudgetScope[];
}

export interface BudgetLedgerOptions {
  readonly budget?: BudgetLimits;
  readonly snapshot?: BudgetLedgerSnapshot;
  /** Awaited under the shared mutation queue, before admission succeeds. */
  readonly persist?: (snapshot: BudgetLedgerSnapshot) => void | Promise<void>;
  /** Shared persistent admission (2.2); required to restore a snapshot that records one. */
  readonly admission?: BudgetAdmissionRestore;
}

/** In-process serialized accounting; external distributed admission needs a transactional store. */
export interface BudgetLedger {
  readonly budget: BudgetLimits;
  /**
   * Add an awaited durable sink; the returned function unsubscribes it.
   * Callbacks may read snapshots but must never call/await ledger mutations.
   * All sinks share the admission queue and any failed sink poisons the ledger.
   */
  addPersistence(persist: NonNullable<BudgetLedgerOptions['persist']>): () => void;
  reserve(input: BudgetReservationInput): Promise<BudgetReservation>;
  settle(input: BudgetSettlement): Promise<BudgetReservation>;
  /** Missing/failed pricing retains the USD reservation. */
  settleUsage(
    requestId: string,
    usage: Usage,
    priceProvider?: PriceProvider,
  ): Promise<BudgetReservation>;
  markUnknown(requestId: string): Promise<BudgetReservation>;
  /** Only after the caller establishes that the attempt cannot have been billed. */
  release(requestId: string): Promise<BudgetReservation>;
  get(requestId: string): BudgetReservation | undefined;
  totals(scopeId?: string): BudgetTotals;
  /**
   * Fold the settled and unknown reservations charged to a FINISHED scope (and
   * its descendants) into one aggregate per ancestor chain, and drop its
   * released ones (2.2). Global and ancestor totals are unchanged; the scope's
   * own totals and per-request records are gone. In-flight reservations stay
   * until they settle. Only compact a scope that will never reserve again —
   * the swarm does this for terminal tasks.
   */
  compact(scopeId: string): Promise<BudgetCompaction>;
  snapshot(): BudgetLedgerSnapshot;
}

export interface ExecutionContextSnapshot {
  /** Version 2 (2.2) when the ledger records persistent admission; 2.1 readers reject it. */
  readonly version: 1 | 2;
  readonly policy: ExecutionPolicy;
  readonly budget: BudgetLimits;
  readonly depth: number;
  readonly scopeId: string;
  readonly scopes: readonly BudgetScope[];
  readonly ledger: BudgetLedgerSnapshot;
}

export interface ExecutionContextOptions extends BudgetLedgerOptions {
  /** Shared persistent admission (2.2); child contexts inherit it through the ledger. */
  readonly admission?: BudgetAdmission;
  readonly policy?: ExecutionPolicy;
  readonly scopeId?: string;
  readonly snapshot?: never;
}

export interface ExecutionContextRestoreOptions {
  readonly snapshot: ExecutionContextSnapshot;
  /** Restored constraints may only be tightened. */
  readonly policy?: ExecutionPolicy;
  readonly budget?: BudgetLimits;
  readonly persist?: BudgetLedgerOptions['persist'];
  /** Required when the snapshot records persistent admission (2.2). */
  readonly admission?: BudgetAdmissionRestore;
}

export interface ExecutionChildOptions {
  /** Stable identifier unique within this parent (for example the tool-call ID). */
  readonly scopeId: string;
  readonly policy?: ExecutionPolicy;
  readonly budget?: BudgetLimits;
}

export interface ExecutionReservationInput extends Omit<BudgetReservationInput, 'scopes'> {
  /** Injected current epoch milliseconds; required when policy has a deadline. */
  readonly now?: number;
}

/** Shared by ordinary, child, compaction, finalizer and verifier calls. */
export interface NativeExecutionContext {
  readonly policy: ExecutionPolicy;
  readonly budget: BudgetLimits;
  readonly depth: number;
  readonly scopeId: string;
  readonly ledger: BudgetLedger;
  child(options: ExecutionChildOptions): NativeExecutionContext;
  reserve(input: ExecutionReservationInput): Promise<BudgetReservation>;
  snapshot(): ExecutionContextSnapshot;
}
