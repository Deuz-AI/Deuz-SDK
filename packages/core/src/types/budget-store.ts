/**
 * Persistent budget scopes (2.2). A `BudgetStore` admits model calls against
 * budgets that outlive one run — a user, a thread, an organisation — and that
 * many processes share. The in-process `BudgetLedger` still admits locally
 * first; the store is the shared, durable second gate.
 */
import type { BudgetLimits } from './execution';

/** A rolling window, counted in `buckets` equal slices of `ms`. */
export interface BudgetWindow {
  /** Window length in milliseconds (a positive safe integer). */
  readonly ms: number;
  /**
   * Slices the window is counted in (default `min(60, ms)`). Usage leaves the
   * window one slice at a time, so the counted span is between
   * `ms - ms / buckets` and `ms`, rounded up to whole milliseconds.
   */
  readonly buckets?: number;
}

/** One durable budget a request is admitted against. */
export interface PersistentBudgetScope {
  /** Stable, shared name such as `user:42` or `org:acme`. */
  readonly key: string;
  /** Checked on every admission; different requests may bring different limits. */
  readonly limits: BudgetLimits;
  /**
   * Omit for a lifetime budget. A key's window is fixed by its first request;
   * a later request with a different window is rejected.
   */
  readonly window?: BudgetWindow;
  /** Overrides the admission-wide `warnAtPercent` for this scope. */
  readonly warnAtPercent?: number;
}

export interface BudgetStoreReserveInput {
  /** Idempotency key: the ledger's request ID for this provider attempt. */
  readonly requestId: string;
  readonly modelId: string;
  /** Conservative estimates; required for every dimension a scope bounds. */
  readonly tokens?: number;
  readonly usd?: number;
  /** Admission is all-or-nothing across every scope. */
  readonly scopes: readonly PersistentBudgetScope[];
}

/** Committed usage (spent plus held) of one scope inside its window. */
export interface BudgetScopeUsage {
  readonly key: string;
  readonly tokens: number;
  readonly usd: number;
}

export type BudgetStoreReservation =
  | {
      readonly admitted: true;
      /** Committed usage per scope, including this request's estimate. */
      readonly scopes: readonly BudgetScopeUsage[];
    }
  | {
      readonly admitted: false;
      /** The first scope and dimension that could not fit the request. */
      readonly key: string;
      readonly dimension: 'tokens' | 'usd';
      readonly limit: number;
      /** Committed usage in that scope before this request. */
      readonly committed: number;
    };

export interface BudgetUsageOptions {
  /** Epoch ms: count only buckets that end after it (a straddling bucket counts whole). */
  readonly since?: number;
  readonly byModel?: boolean;
}

export interface BudgetUsage {
  /** Settled actual amounts plus estimates still held by unsettled requests. */
  readonly tokens: number;
  readonly usd: number;
  readonly byModel?: Readonly<Record<string, { readonly tokens: number; readonly usd: number }>>;
}

/** What `BudgetStore.prune` may remove (2.3). */
export interface BudgetPruneOptions {
  /**
   * Epoch milliseconds on the store's clock (database time for Postgres).
   * Request records created before it, and history in buckets that closed
   * before it, are pruned.
   */
  readonly before: number;
}

/** What `BudgetStore.prune` removed (2.3). */
export interface BudgetPruneResult {
  /** Settled, released and denied request records deleted. */
  readonly requests: number;
  /** History rows folded into a newer row of the same scope and model. */
  readonly buckets: number;
}

/**
 * Shared, durable admission. Every method is atomic. A hold is charged to the
 * bucket of its reservation time, so a hold leaked by a crash leaves a
 * windowed budget with its bucket; in a lifetime budget it stays charged,
 * which is the fail-closed outcome.
 */
export interface BudgetStore {
  /**
   * Admit against every scope or none. Idempotent by `requestId`: an
   * identical repeat returns the recorded outcome (a denial included); a
   * repeat with different input throws.
   */
  reserve(input: BudgetStoreReserveInput): Promise<BudgetStoreReservation>;
  /**
   * Replace the held estimates with the actual amounts. Repeating the same
   * settlement is a no-op; a different one, or settling a released request,
   * throws. A request the store never admitted is ignored.
   */
  settle(requestId: string, actual: { tokens: number; usd: number }): Promise<void>;
  /** Drop a hold that was never billed. Releasing twice is a no-op; a billed request throws. */
  release(requestId: string): Promise<void>;
  /** Totals across the key's recorded history, or since a point in time. */
  usage(key: string, options?: BudgetUsageOptions): Promise<BudgetUsage>;
  /**
   * Retention (2.3). Deletes the settled, released and denied request records
   * created before `before`: a pruned request is forgotten, so repeating its
   * reservation admits it anew and a late settlement of it is ignored. Folds
   * each scope's history, per model, from the buckets that closed a whole
   * bucket length before both `before` and now, and that admission no longer
   * counts, into the newest of them. Usage totals and admission do not change;
   * `usage(key, { since })` counts a folded amount at the bucket it was folded
   * into. A request still reserved keeps its record and its bucket. Optional:
   * the memory, SQLite and Postgres stores have it.
   */
  prune?(options: BudgetPruneOptions): Promise<BudgetPruneResult>;
}
