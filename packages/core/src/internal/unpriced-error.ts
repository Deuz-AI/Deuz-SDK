import { DeuzError } from '../errors';

/**
 * A legacy agentic loop refused a model with no price before calling it,
 * because its `budget` bounds `usd` with `unknownPrice: 'reject'` (2.3).
 * Native execution refuses the same call with `BudgetLedgerError`; both carry
 * `code: 'unpriced_model'`. With a `cause`, the price lookup itself failed.
 */
export class UnpricedModelError extends DeuzError {
  readonly code = 'unpriced_model';
  /**
   * The refusal ends the run, as a `BudgetLedgerError` does (2.3): raised in a
   * compaction summary or inside an `agentTool` sub-agent, it is never a
   * skipped layer or a tool error the model may retry.
   */
  readonly fatalExecution = true;
  readonly modelId: string;

  constructor(modelId: string, cause?: unknown) {
    super(
      `${modelId} has no usable price, so the USD budget cannot bound it (unknownPrice: 'reject').`,
      cause === undefined ? undefined : { cause },
    );
    this.modelId = modelId;
  }
}
