/**
 * Unpriced models under a USD budget (2.3, decision 4). A model has no price
 * when no `deps.priceProvider` is configured or it returns `undefined` for the
 * model; by default the call runs and the run reports it once per model.
 * Shared by the legacy loop accounting and the native request. Edge-safe.
 */
import type { CallWarning } from '../types/methods';

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
