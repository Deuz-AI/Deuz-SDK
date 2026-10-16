/**
 * Ledger accounting for `embed`/`embedMany` (2.4, `EmbedOptions.accounting`).
 * Loaded only when a call passes `accounting`, so a 2.3 call pays nothing
 * for it. Edge-safe.
 */
import { assertExecutionPolicy } from '../execution-policy';
import { BudgetLedgerError } from '../budget-ledger';
import { embeddingUsage, withTotal } from '../core/metering';
import { createTokenEstimator } from '../internal/estimate-tokens';
import type { CallAccounting } from '../types/accounting';
import type { PriceProvider, ResolvedDependencies } from '../types/deps';
import type { Usage } from '../types/usage';

/** Without a `deps.priceProvider` no model has a price. */
const NO_PRICES: PriceProvider = { priceUsage: () => undefined };

/** One embedding call's charge: settle it with the usage, or close it on failure. */
export interface EmbeddingCharge {
  /** The provider answered: settle its usage, or hold the estimate when it reported none. */
  settle(usage: Usage, reported: boolean): Promise<void>;
  /** The call failed: release it when nothing billable was sent, else hold the estimate. */
  fail(billable: boolean): Promise<void>;
}

/**
 * Reserves one embedding call on `accounting.execution` before its first
 * request. The estimate is `accounting.tokens`, else the shared token
 * estimator's count of the values, and `accounting.usd`, else the price of
 * that many input tokens (`unpriced` when the model has none; a price lookup
 * that throws leaves no USD estimate, so a USD bound refuses the call). The
 * policy (allowed models, depth, deadline) is checked at the injected clock.
 *
 * A request id already on the ledger is not reserved again: a settled one is
 * not charged again, an unknown or reserved one is settled by this call, and
 * a released one is a `reservation_conflict` (charge a retry under a new id).
 */
export async function startEmbeddingCharge(
  accounting: CallAccounting,
  modelId: string,
  values: readonly string[],
  deps: ResolvedDependencies,
): Promise<EmbeddingCharge> {
  const { execution, requestId } = accounting;
  if (
    execution === null ||
    typeof execution !== 'object' ||
    typeof execution.reserve !== 'function' ||
    typeof execution.ledger?.reserve !== 'function'
  )
    throw new TypeError('EmbedOptions.accounting needs an execution context');
  if (typeof requestId !== 'string' || requestId === '')
    throw new TypeError('EmbedOptions.accounting needs a nonempty requestId');
  const ledger = execution.ledger;
  const existing = ledger.get(requestId);
  if (existing?.state === 'released')
    throw new BudgetLedgerError(
      'reservation_conflict',
      `Embedding request ${requestId} was released; charge a retry under a new request id.`,
    );
  if (existing) assertExecutionPolicy(execution, { modelId, now: deps.clock.now() });
  else {
    const tokens =
      accounting.tokens ??
      createTokenEstimator().estimate(values.map((value) => ({ role: 'user', content: value })));
    let usd = accounting.usd;
    let unpriced = false;
    if (usd === undefined) {
      try {
        usd = (await deps.priceProvider?.priceUsage(modelId, embeddingUsage(tokens))) ?? undefined;
        unpriced = usd === undefined;
      } catch {
        // A billing outage is not a price: a USD bound refuses the call.
      }
    }
    await execution.reserve({
      requestId,
      modelId,
      kind: accounting.kind ?? 'embedding',
      now: deps.clock.now(),
      tokens,
      ...(usd !== undefined ? { usd } : {}),
      ...(unpriced ? { unpriced: true } : {}),
    });
  }
  const charged = existing?.state === 'settled';
  return {
    async settle(usage, reported) {
      if (charged) return;
      await (reported
        ? ledger.settleUsage(requestId, withTotal(usage), deps.priceProvider ?? NO_PRICES)
        : ledger.markUnknown(requestId));
    },
    async fail(billable) {
      if (charged) return;
      await (billable ? ledger.markUnknown(requestId) : ledger.release(requestId));
    },
  };
}
