/**
 * Budget holds for batch requests (2.3, BA2). Each request of a batch reserves
 * one hold in the client's execution context when the batch is submitted,
 * estimated the way a native call is (the prompt plus the output cap the wire
 * sends) and priced on the provider's batch tier. Its result closes the hold:
 * settled with the actual usage, released when the provider never ran or
 * refused it, kept as unknown when it may have been billed. Every close goes
 * through the ledger, which mirrors it into a persistent `BudgetStore` and is
 * idempotent there and in the store, so results can be read again.
 */
import { adoptReservation } from '../budget-ledger';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { createTokenEstimator } from '../internal/estimate-tokens';
import { wireOutputCap } from '../internal/output-cap';
import { firstRunReport } from '../internal/run-ledger';
import type { CallWarning } from '../types/methods';
import type { PriceProvider, ResolvedDependencies } from '../types/deps';
import type { BudgetScope, NativeExecutionContext } from '../types/execution';
import type { LanguageModel } from '../types/model';
import type { Usage } from '../types/usage';
import { BatchError } from './errors';
import type { PreparedRequest } from './prepare';
import type { BatchHold, BatchJob } from './types';

/** The reservation kind of a batch hold in the ledger. */
const KIND = 'batch';

/**
 * Statuses that prove the provider refused the request without running it, as
 * for a native call: the hold is released. Any other failure may have been
 * billed, so the hold stays, unknown.
 */
const REFUSED = new Set([400, 401, 403, 404, 422, 429]);

/** How a request's hold closes. */
export type HoldClose =
  | { readonly kind: 'settle'; readonly usage: Usage; readonly price: BatchPrice }
  | { readonly kind: 'release' }
  | { readonly kind: 'unknown' };

/** A batch-tier price lookup, done once per usage: its value, or the failure it met. */
export interface BatchPrice {
  readonly usd?: number;
  readonly failed?: { readonly error: unknown };
}

/** Price `usage` of `modelId` on the batch tier. A failing lookup is kept, not thrown. */
export async function batchPrice(
  deps: ResolvedDependencies,
  modelId: string,
  usage: Usage,
): Promise<BatchPrice> {
  if (!deps.priceProvider) return {};
  try {
    const usd =
      (await deps.priceProvider.priceUsage(modelId, usage, { tier: 'batch' })) ?? undefined;
    return usd === undefined ? {} : { usd };
  } catch (error) {
    return { failed: { error } };
  }
}

/** A PriceProvider that answers the ledger with a price already looked up. */
const answering = (price: BatchPrice): PriceProvider => ({
  priceUsage: () => {
    if (price.failed) throw price.failed.error;
    return price.usd;
  },
});

/** What the context's budgets bound: its own (every ancestor's included) and the persistent scopes. */
function bounds(execution: NativeExecutionContext): { usd: boolean; any: boolean } {
  const scopes = execution.ledger.snapshot().admission ?? [];
  const usd =
    execution.budget.usd !== undefined || scopes.some((scope) => scope.limits.usd !== undefined);
  const tokens =
    execution.budget.tokens !== undefined ||
    scopes.some((scope) => scope.limits.tokens !== undefined);
  return { usd, any: usd || tokens };
}

/** True when a token or USD bound applies to the batch's holds (F12). */
export const bounded = (execution: NativeExecutionContext | undefined): boolean =>
  execution !== undefined && bounds(execution).any;

/**
 * The usage a request may bill, as the native request estimates a call: the
 * prompt (estimated) and the output cap the wire sends, reasoning included;
 * on Anthropic a cached prompt is a cache write.
 */
function estimate(model: LanguageModel, request: PreparedRequest): Usage {
  const { options, caps } = request;
  const promptTokens = createTokenEstimator().estimate(options.messages);
  const outputTokens = wireOutputCap(model.surface, caps, options, model.modelId) ?? caps.maxOutput;
  const cacheWrite =
    model.surface === 'anthropic' && caps.caching ? options.promptCaching : undefined;
  return {
    ...EMPTY_USAGE,
    ...(cacheWrite === 'auto-1h'
      ? { cacheWrite1hTokens: promptTokens }
      : cacheWrite
        ? { cacheWriteTokens: promptTokens }
        : { inputTokens: promptTokens }),
    outputTokens,
    totalTokens: promptTokens + outputTokens,
  };
}

/**
 * Reserve one hold per request, all or none: when one is refused (a budget, an
 * unpriced model under `unknownPrice: 'reject'`, the policy), the holds
 * already made are released and the refusal is thrown before anything is sent.
 * A model with no batch price under a USD bound is reported once (decision 4).
 */
export async function reserveHolds(
  prepared: readonly PreparedRequest[],
  input: {
    readonly execution: NativeExecutionContext;
    readonly deps: ResolvedDependencies;
    readonly model: LanguageModel;
    /** Unique per submission: `<scopeId>/batch/<key>/<request id>`. */
    readonly key: string;
    readonly report: (warning: CallWarning) => void;
  },
): Promise<BatchHold[]> {
  const { execution, deps, model } = input;
  const holds: BatchHold[] = [];
  let unpriced = false;
  try {
    for (const request of prepared) {
      const usage = estimate(model, request);
      const given = request.options.executionEstimate;
      let usd = given?.usd;
      let missing = false;
      if (usd === undefined) {
        const price = await batchPrice(deps, model.modelId, usage);
        usd = price.usd;
        // A lookup that throws is an outage, not a missing price: without an
        // estimate a USD bound refuses the hold (missing_reservation).
        missing = usd === undefined && !price.failed;
      }
      const tokens = given?.tokens ?? usage.totalTokens;
      const id = `${execution.scopeId}/batch/${input.key}/${request.id}`;
      await execution.reserve({
        requestId: id,
        modelId: model.modelId,
        now: deps.clock.now(),
        kind: KIND,
        tokens,
        ...(usd !== undefined ? { usd } : {}),
        ...(missing ? { unpriced: true } : {}),
      });
      holds.push({
        id,
        tokens,
        ...(usd !== undefined ? { usd } : {}),
        ...(missing ? { unpriced: true as const } : {}),
      });
      unpriced ||= missing;
    }
  } catch (error) {
    for (const hold of holds.reverse())
      await execution.ledger.release(hold.id).catch(() => undefined);
    throw error;
  }
  if (unpriced && bounds(execution).usd && firstRunReport(execution.ledger, model.modelId))
    input.report({
      type: 'unpriced-model',
      setting: 'budget.usd',
      message: deps.priceProvider
        ? `${model.modelId} has no batch price, so the USD budget does not count its batch requests.`
        : `No deps.priceProvider is set, so the USD budget does not count batch requests to ${model.modelId}.`,
    });
  return holds;
}

/**
 * Close every hold of a submission that failed. While nothing could have
 * created the batch, or the provider refused the batch call, they are
 * released; otherwise the batch may exist and run, so they stay, unknown.
 * A close that fails leaves its hold reserved (fail-closed) for a sweep.
 */
export async function closeAfterFailure(
  execution: NativeExecutionContext,
  holds: readonly BatchHold[],
  failure: { readonly error: unknown; readonly mayExist: boolean },
  deps: ResolvedDependencies,
): Promise<void> {
  const status = (failure.error as { statusCode?: unknown } | null)?.statusCode;
  const release = !failure.mayExist || (typeof status === 'number' && REFUSED.has(status));
  for (const hold of holds) {
    try {
      await (release ? execution.ledger.release(hold.id) : execution.ledger.markUnknown(hold.id));
    } catch (error) {
      deps.logger.warn('A batch hold could not be closed after the submission failed.', {
        requestId: hold.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** How a per-request provider error closes its hold. */
export const closeForStatus = (status: number | undefined): HoldClose =>
  status !== undefined && REFUSED.has(status) ? { kind: 'release' } : { kind: 'unknown' };

/**
 * Close one request's hold. A hold the ledger does not know (a context that
 * was not restored from its snapshot, after a restart) is first recorded again
 * with the amounts the job recorded. The provider already ran the request, so
 * this context's budgets do not refuse it (they count it from then on), while
 * a `BudgetStore` treats it as the same hold, so nothing is counted twice.
 * That needs the job's own scope.
 */
export async function closeHold(
  execution: NativeExecutionContext,
  job: BatchJob,
  hold: BatchHold,
  close: HoldClose,
  scopes: () => readonly BudgetScope[],
): Promise<void> {
  const ledger = execution.ledger;
  if (!ledger.get(hold.id)) {
    if (execution.scopeId !== job.scopeId)
      throw new BatchError({
        kind: 'invalid-job',
        provider: job.provider,
        batchId: job.id,
        message:
          `The ledger does not know the holds of batch ${job.id}, and they were reserved under ` +
          `scope ${job.scopeId ?? '(none)'}, not ${execution.scopeId}: settle them through a ` +
          'context of that scope, or one restored from its snapshot.',
      });
    await adoptReservation(ledger, {
      requestId: hold.id,
      modelId: job.modelId,
      kind: KIND,
      tokens: hold.tokens,
      ...(hold.usd !== undefined ? { usd: hold.usd } : {}),
      ...(hold.unpriced ? { unpriced: true } : {}),
      scopes: scopes(),
    });
  }
  switch (close.kind) {
    case 'settle':
      await ledger.settleUsage(hold.id, withTotal(close.usage), answering(close.price));
      return;
    case 'release':
      await ledger.release(hold.id);
      return;
    case 'unknown':
      await ledger.markUnknown(hold.id);
      return;
  }
}
