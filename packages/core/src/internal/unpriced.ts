/**
 * Unpriced models under a USD budget (2.3, decision 4). A model has no price
 * when no `deps.priceProvider` is configured or it returns `undefined` for the
 * model; by default the call runs and the run reports it once per model.
 * Shared by the legacy loop accounting and the native request. Edge-safe.
 */
import type { CallWarning } from '../types/methods';

/** Models already reported per run ledger (see {@link markRunLedger}). */
const runLedgers = new WeakMap<object, Set<string>>();

/**
 * Mark an execution ledger that one run owns for its whole life, such as a
 * swarm's or an `evolve` run's: its tasks' model calls then report an unpriced
 * model once in all. Any other ledger may be shared by many runs, so each run
 * reports it once: a loop through its warning sink, a single call by itself.
 */
export function markRunLedger(ledger: object): void {
  if (!runLedgers.has(ledger)) runLedgers.set(ledger, new Set());
}

/**
 * False when `ledger` is a run ledger that already reported `modelId`; true
 * otherwise, recording the report.
 */
export function firstRunReport(ledger: object, modelId: string): boolean {
  const models = runLedgers.get(ledger);
  if (!models) return true;
  if (models.has(modelId)) return false;
  models.add(modelId);
  return true;
}

/**
 * The `unpriced-model` warning. Its message depends only on the model and on
 * whether a price provider exists, so a warning sink reports it once per model.
 */
export function unpricedModelWarning(modelId: string, priceProvider: boolean): CallWarning {
  return {
    type: 'unpriced-model',
    setting: 'budget.usd',
    message: priceProvider
      ? `${modelId} has no price, so the USD budget does not count its calls.`
      : `No deps.priceProvider is set, so the USD budget does not count calls to ${modelId}.`,
  };
}
