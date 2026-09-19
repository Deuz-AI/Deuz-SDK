import type { Dependencies, PriceProvider, UsageMeta } from '../types/deps';
import type { Usage } from '../types/usage';

/** Persisted paid totals, not a mixed-model token total to reprice on resume. */
export interface UsageCostSnapshot {
  readonly version: 1;
  readonly pricedUsd: number;
  readonly calls: number;
  readonly unknownCalls: number;
  readonly cacheSavingsUsd?: number;
}

export interface UsageCostSummary {
  /** Known charges; a lower bound when unknownCalls is nonzero. */
  readonly pricedUsd: number;
  /** Exact cumulative cost is unavailable if any call could not be priced. */
  readonly costUsd?: number;
  readonly calls: number;
  readonly unknownCalls: number;
  readonly cacheSavingsUsd?: number;
}

export interface UsageCostAccumulatorOptions {
  readonly priceProvider?: PriceProvider;
  readonly snapshot?: UsageCostSnapshot;
  /** Old checkpoints with usage but no model-aware cost have an unknown base. */
  readonly unpricedBaseUsage?: boolean;
}

export interface UsageCostAccumulator {
  record(usage: Usage, meta: Pick<UsageMeta, 'model'>): void;
  /** Observe each callback once, preserving the user's effective callback. */
  wrap(callback?: Dependencies['onUsage']): NonNullable<Dependencies['onUsage']>;
  flush(): Promise<UsageCostSummary>;
  /** Pending price lookups become unknown in a snapshot taken before flush. */
  snapshot(): UsageCostSnapshot;
}

/**
 * Legacy loop cost accounting observes per-model callbacks, never cumulative
 * result usage. Parent callback inheritance includes children and compaction
 * without counting their final aggregate usage a second time. It deliberately
 * does not enforce admission; native execution uses BudgetLedger for that.
 */
export function createUsageCostAccumulator(
  options: UsageCostAccumulatorOptions = {},
): UsageCostAccumulator {
  const saved = options.snapshot;
  if (
    saved &&
    (saved.version !== 1 ||
      !Number.isFinite(saved.pricedUsd) ||
      saved.pricedUsd < 0 ||
      !Number.isSafeInteger(saved.calls) ||
      saved.calls < 0 ||
      !Number.isSafeInteger(saved.unknownCalls) ||
      saved.unknownCalls < 0 ||
      saved.unknownCalls > saved.calls ||
      (saved.cacheSavingsUsd !== undefined &&
        (!Number.isFinite(saved.cacheSavingsUsd) || saved.cacheSavingsUsd < 0)) ||
      (saved.calls === 0 && saved.pricedUsd !== 0))
  ) {
    throw new TypeError('Invalid usage cost snapshot.');
  }
  let pricedUsd = saved?.pricedUsd ?? 0;
  let calls = saved?.calls ?? 0;
  let unknownCalls = saved?.unknownCalls ?? 0;
  let pending = 0;
  let cacheSavingsUsd = saved?.cacheSavingsUsd ?? 0;
  let savingsCalls = saved?.cacheSavingsUsd !== undefined ? saved.calls : 0;
  let savingsKnown = !saved || saved.calls === 0 || saved.cacheSavingsUsd !== undefined;
  let queue = Promise.resolve();
  if (options.unpricedBaseUsage) {
    calls++;
    unknownCalls++;
    savingsKnown = false;
  }

  function record(usage: Usage, meta: Pick<UsageMeta, 'model'>): void {
    // The hook is synchronous; copy before the async price lookup so mutable
    // result objects cannot change the charge after the event was observed.
    const copied = Object.freeze({ ...usage });
    const model = meta.model;
    calls++;
    pending++;
    queue = queue.then(async () => {
      try {
        const price = await options.priceProvider?.priceUsage(model, copied);
        if (price !== undefined && Number.isFinite(price) && price >= 0) pricedUsd += price;
        else unknownCalls++;
      } catch {
        // A price lookup failure is not a zero-cost model invocation.
        unknownCalls++;
      }
      try {
        const savings = await options.priceProvider?.cacheSavings?.(model, copied);
        if (savings !== undefined && Number.isFinite(savings) && savings >= 0) {
          cacheSavingsUsd += savings;
          savingsCalls++;
        } else savingsKnown = false;
      } catch {
        savingsKnown = false;
      }
      pending--;
    });
  }

  function snapshot(): UsageCostSnapshot {
    return Object.freeze({
      version: 1,
      pricedUsd,
      calls,
      unknownCalls: unknownCalls + pending,
      ...(pending === 0 && savingsKnown && savingsCalls > 0 ? { cacheSavingsUsd } : {}),
    });
  }

  return Object.freeze({
    record,
    wrap(callback?: Dependencies['onUsage']) {
      return (usage: Usage, meta: UsageMeta) => {
        record(usage, meta);
        callback?.(usage, meta);
      };
    },
    async flush(): Promise<UsageCostSummary> {
      // Include callbacks that arrive while prior async prices are resolving.
      while (pending > 0) await queue;
      return Object.freeze({
        pricedUsd,
        ...(unknownCalls === 0 ? { costUsd: pricedUsd } : {}),
        calls,
        unknownCalls,
        ...(savingsKnown && savingsCalls > 0 ? { cacheSavingsUsd } : {}),
      });
    },
    snapshot,
  });
}
