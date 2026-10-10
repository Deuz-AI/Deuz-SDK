/**
 * Unpriced models under a USD budget (2.3, decision 4). A model is unpriced when
 * no `deps.priceProvider` is configured or it returns `undefined` for the model.
 * By default the call runs and the run reports one `unpriced-model` warning per
 * model; `budget.unknownPrice: 'reject'` refuses the call before it is sent.
 * Shared by the legacy loop accounting and the native request. Edge-safe.
 */
import { DeuzError } from '../errors';
import type { CallWarning } from '../types/methods';

/**
 * A legacy agentic loop refused a model with no price before calling it,
 * because its `budget` bounds `usd` with `unknownPrice: 'reject'` (2.3). Native
 * execution refuses the same call with `BudgetLedgerError` code
 * `unpriced_model`; both carry `code: 'unpriced_model'`.
 */
export class UnpricedModelError extends DeuzError {
  readonly code = 'unpriced_model';
  /** A price cannot appear by retrying the same call. */
  readonly isRetryable = false;
  readonly modelId: string;

  constructor(modelId: string, options: { priceProvider: boolean; cause?: unknown }) {
    super(
      `${modelId} has no price${options.priceProvider ? '' : ' (no deps.priceProvider is configured)'}, ` +
        "so the USD budget cannot bound it and budget.unknownPrice is 'reject'.",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.modelId = modelId;
  }
}

/**
 * The `unpriced-model` warning. The message depends only on the model and on
 * whether a price provider exists, so a warning sink reports it once per model.
 */
export function unpricedModelWarning(modelId: string, priceProvider: boolean): CallWarning {
  return {
    type: 'unpriced-model',
    setting: 'budget.usd',
    message: priceProvider
      ? `${modelId} has no price, so the USD budget does not count its calls; token limits ` +
        "still apply. Add a price for it, or set budget.unknownPrice to 'reject'."
      : `No deps.priceProvider is configured, so the USD budget does not count calls to ` +
        `${modelId}; token limits still apply. Inject a priceProvider, or set ` +
        "budget.unknownPrice to 'reject'.",
  };
}
