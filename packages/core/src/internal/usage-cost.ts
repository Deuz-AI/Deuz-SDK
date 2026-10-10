import type { Dependencies, PriceProvider, UsageMeta } from '../types/deps';
import type { BudgetLimits } from '../types/execution';
import type { Usage } from '../types/usage';
import { UnpricedModelError, unpricedModelWarning } from './unpriced';
import type { WarningSink } from './warnings';

/** Persisted paid totals, not a mixed-model token total to reprice on resume. */
export interface UsageCostSnapshot {
  readonly version: 1;
  readonly pricedUsd: number;
  readonly calls: number;
  /** Calls whose price lookup failed or was still pending: their cost is unknown. */
  readonly unknownCalls: number;
  /** Calls to a model with no price (2.3); they add nothing to `pricedUsd`. */
  readonly unpricedCalls?: number;
  /** Those models in first-seen order (2.3). */
  readonly unpricedModels?: readonly string[];
  readonly cacheSavingsUsd?: number;
}

export interface UsageCostSummary {
  /** Known charges; a lower bound when unknownCalls is nonzero. */
  readonly pricedUsd: number;
  /**
   * The cumulative cost, unavailable while any price lookup failed. A model
   * with no price adds nothing (2.3): the sum stays defined, so a `budget.usd`
   * keeps counting the priced calls. 2.2 dropped it for the rest of the run.
   */
  readonly costUsd?: number;
  readonly calls: number;
  readonly unknownCalls: number;
  /** Calls to a model with no price (2.3); omitted when zero. */
  readonly unpricedCalls?: number;
  /** Those models in first-seen order (2.3). */
  readonly unpricedModels?: readonly string[];
  readonly cacheSavingsUsd?: number;
}

export interface UsageCostAccumulatorOptions {
  readonly priceProvider?: PriceProvider;
  readonly snapshot?: UsageCostSnapshot;
  /** Old checkpoints with usage but no model-aware cost have an unknown base. */
  readonly unpricedBaseUsage?: boolean;
  /**
   * The loop's `budget` (2.3). While it bounds `usd`, a model with no price
   * adds one `unpriced-model` warning per model to `warnings`, and
   * `unknownPrice: 'reject'` makes {@link UsageCostAccumulator.admit} refuse it.
   */
  readonly budget?: BudgetLimits;
  /** The run's warning sink (2.3), deduplicating per model. */
  readonly warnings?: WarningSink;
}

export interface UsageCostAccumulator {
  record(usage: Usage, meta: Pick<UsageMeta, 'model'>): void;
  /** Observe each callback once, preserving the user's effective callback. */
  wrap(callback?: Dependencies['onUsage']): NonNullable<Dependencies['onUsage']>;
  flush(): Promise<UsageCostSummary>;
  /** Pending price lookups become unknown in a snapshot taken before flush. */
  snapshot(): UsageCostSnapshot;
  /**
   * Call before each model call (2.3). Under a `budget.usd` it looks the
   * model's price up once per run: a model with no price is reported
   * (`'warn'`, the default) or refused with {@link UnpricedModelError}
   * (`'reject'`). Without a USD bound it does nothing.
   */
  admit(model: string): Promise<void>;
}

/** One input and one output token: enough to ask whether a model has a price. */
const PROBE: Usage = Object.freeze({
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2,
});

function count(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
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
      !count(saved.unpricedCalls) ||
      saved.unknownCalls + (saved.unpricedCalls ?? 0) > saved.calls ||
      (saved.unpricedModels !== undefined &&
        (!Array.isArray(saved.unpricedModels) ||
          saved.unpricedModels.length > (saved.unpricedCalls ?? 0) ||
          saved.unpricedModels.some((model) => typeof model !== 'string' || !model))) ||
      (saved.cacheSavingsUsd !== undefined &&
        (!Number.isFinite(saved.cacheSavingsUsd) || saved.cacheSavingsUsd < 0)) ||
      (saved.calls === 0 && saved.pricedUsd !== 0))
  ) {
    throw new TypeError('Invalid usage cost snapshot.');
  }
  let pricedUsd = saved?.pricedUsd ?? 0;
  let calls = saved?.calls ?? 0;
  let unknownCalls = saved?.unknownCalls ?? 0;
  let unpricedCalls = saved?.unpricedCalls ?? 0;
  const unpricedModels: string[] = [...(saved?.unpricedModels ?? [])];
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
  /** Whether each model has a price, looked up once per run by `admit`. */
  const probes = new Map<string, Promise<boolean>>();
  const hasProvider = options.priceProvider !== undefined;

  /** Report a model with no price, once per model (the sink deduplicates). */
  function warn(model: string): void {
    if (options.budget?.usd !== undefined)
      options.warnings?.add(unpricedModelWarning(model, hasProvider));
  }

  function record(usage: Usage, meta: Pick<UsageMeta, 'model'>): void {
    // The hook is synchronous; copy before the async price lookup so mutable
    // result objects cannot change the charge after the event was observed.
    const copied = Object.freeze({ ...usage });
    const model = meta.model;
    calls++;
    pending++;
    queue = queue.then(async () => {
      let price: number | undefined | null = null;
      try {
        price = (await options.priceProvider?.priceUsage(model, copied)) ?? undefined;
      } catch {
        // A price lookup failure is not a zero-cost model invocation.
      }
      if (price === undefined) {
        // No price for this model (2.3): it adds nothing to the priced total,
        // and nothing to the cache savings either.
        unpricedCalls++;
        if (!unpricedModels.includes(model)) unpricedModels.push(model);
        warn(model);
        pending--;
        return;
      }
      if (price !== null && Number.isFinite(price) && price >= 0) pricedUsd += price;
      else unknownCalls++;
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

  /** Price a probe usage; `true` when the model has a usable price. */
  async function probe(model: string): Promise<boolean> {
    if (!options.priceProvider) return false;
    const price = (await options.priceProvider.priceUsage(model, PROBE)) ?? undefined;
    if (price === undefined) return false;
    if (Number.isFinite(price) && price >= 0) return true;
    throw new TypeError(`The priceProvider returned an invalid price for ${model}.`);
  }

  function unpriced(): Pick<UsageCostSummary, 'unpricedCalls' | 'unpricedModels'> {
    return unpricedCalls > 0
      ? { unpricedCalls, unpricedModels: Object.freeze([...unpricedModels]) }
      : {};
  }

  function snapshot(): UsageCostSnapshot {
    return Object.freeze({
      version: 1,
      pricedUsd,
      calls,
      unknownCalls: unknownCalls + pending,
      ...unpriced(),
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
        ...unpriced(),
        ...(savingsKnown && savingsCalls > 0 ? { cacheSavingsUsd } : {}),
      });
    },
    snapshot,
    async admit(model: string): Promise<void> {
      const budget = options.budget;
      if (budget?.usd === undefined) return;
      let lookup = probes.get(model);
      if (!lookup) {
        lookup = probe(model);
        probes.set(model, lookup);
      }
      let priced: boolean;
      try {
        priced = await lookup;
      } catch (cause) {
        // An outage is not a missing price: ask again before the next call.
        probes.delete(model);
        if (budget.unknownPrice === 'reject')
          throw new UnpricedModelError(model, { priceProvider: hasProvider, cause });
        return;
      }
      if (priced) return;
      if (budget.unknownPrice === 'reject')
        throw new UnpricedModelError(model, { priceProvider: hasProvider });
      warn(model);
    },
  });
}
