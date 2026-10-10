import { assertExecutionPolicy } from '../execution-policy';
export { assertExecutionPolicy } from '../execution-policy';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { getCapabilities } from '../core/registry';
import { createTokenEstimator } from './estimate-tokens';
import { wireOutputCap } from './output-cap';
import { unpricedModelWarning } from './unpriced';
import type { CommonCallOptions } from '../types/config';
import type { PriceProvider, ResolvedDependencies } from '../types/deps';
import type { BudgetLedger, NativeExecutionContext } from '../types/execution';
import type { Usage } from '../types/usage';
import type { InternalRunOptions } from '../core/inference';

/** Without a `deps.priceProvider` no model has a price (2.3). */
const NO_PRICES: PriceProvider = { priceUsage: () => undefined };

/** Models reported per ledger: one `unpriced-model` warning per run and model. */
const reported = new WeakMap<BudgetLedger, Set<string>>();
/** Whether a ledger's persistent scopes bound USD; fixed when the ledger is created. */
const persistentUsd = new WeakMap<BudgetLedger, boolean>();

/** True when a USD bound applies to calls made under this context. */
function boundsUsd(execution: NativeExecutionContext): boolean {
  // The context budget already intersects every ancestor's.
  if (execution.budget.usd !== undefined) return true;
  let bounded = persistentUsd.get(execution.ledger);
  if (bounded === undefined) {
    bounded =
      execution.ledger.snapshot().admission?.some((scope) => scope.limits.usd !== undefined) ??
      false;
    persistentUsd.set(execution.ledger, bounded);
  }
  return bounded;
}

/** Loaded only for callers opting into mandatory execution accounting. */
export function createNativeRequest(
  options: CommonCallOptions,
  internal: InternalRunOptions,
  deps: ResolvedDependencies,
  modelId: string,
  userSignal?: AbortSignal,
) {
  const execution = options.execution!;
  let reservationId: string | undefined;
  const assert = () => assertExecutionPolicy(execution, { modelId, now: deps.clock.now() });
  /** Report that the USD budget cannot count this model, once per ledger. */
  const reportUnpriced = (): void => {
    let models = reported.get(execution.ledger);
    if (models?.has(modelId) || !boundsUsd(execution)) return;
    if (!models) reported.set(execution.ledger, (models = new Set()));
    models.add(modelId);
    const warning = unpricedModelWarning(modelId, deps.priceProvider !== undefined);
    // A loop's sink puts it on the result and mirrors it to the logger.
    if (internal.warnings) internal.warnings.add(warning);
    else deps.logger.warn(warning.message, { warning: warning.type, setting: warning.setting });
  };
  return {
    assert,
    async reserve(): Promise<void> {
      assert();
      if (userSignal?.aborted) throw userSignal.reason ?? new DOMException('Aborted', 'AbortError');
      const promptTokens =
        createTokenEstimator().estimate(options.messages) +
        Math.ceil(JSON.stringify(internal.tools?.tools ?? []).length / 3.6);
      // F12 (2.3): reserve the output cap the wire actually sends (Anthropic's
      // thinking raise included), not a fixed 4,096 — the provider may bill up
      // to it, reasoning included. A prompt cached by this call is billed as a
      // cache write, the dearest input rate.
      const caps = getCapabilities(options.model);
      const outputTokens = wireOutputCap(options.model.surface, caps, options) ?? caps.maxOutput;
      const estimatedUsage: Usage = {
        ...EMPTY_USAGE,
        ...(options.promptCaching === 'auto-1h'
          ? { cacheWrite1hTokens: promptTokens }
          : options.promptCaching
            ? { cacheWriteTokens: promptTokens }
            : { inputTokens: promptTokens }),
        outputTokens,
        totalTokens: promptTokens + outputTokens,
      };
      let usd = options.executionEstimate?.usd;
      // Decision 4 (2.3): no price provider, or no price for this model, makes an
      // unpriced call; its budget's `unknownPrice` decides. A lookup that throws
      // is an outage: without an estimate a USD bound still refuses the call.
      let unpriced = false;
      if (usd === undefined) {
        try {
          usd = (await deps.priceProvider?.priceUsage(modelId, estimatedUsage)) ?? undefined;
          unpriced = usd === undefined;
        } catch {
          /* Unknown prices cannot admit a bounded USD request. */
        }
      }
      // The ledger revision only grows; a reservation count shrinks after 2.2 compaction.
      const requestId = `${execution.scopeId}/${deps.generateId()}/${execution.ledger.snapshot().revision + 1}`;
      const reservation = await execution.reserve({
        requestId,
        modelId,
        now: deps.clock.now(),
        kind: internal.observe?.purpose ?? internal.operation ?? 'model',
        tokens: options.executionEstimate?.tokens ?? estimatedUsage.totalTokens,
        ...(usd !== undefined ? { usd } : {}),
        ...(unpriced ? { unpriced: true } : {}),
      });
      reservationId = requestId;
      if (reservation.unpriced) reportUnpriced();
      try {
        assert();
        if (userSignal?.aborted)
          throw userSignal.reason ?? new DOMException('Aborted', 'AbortError');
      } catch (error) {
        reservationId = undefined;
        await execution.ledger.release(requestId);
        throw error;
      }
    },
    async settle(usage: Usage | undefined, available: boolean): Promise<void> {
      if (!reservationId) return;
      const id = reservationId;
      reservationId = undefined;
      if (usage && available)
        await execution.ledger.settleUsage(id, withTotal(usage), deps.priceProvider ?? NO_PRICES);
      else await execution.ledger.markUnknown(id);
    },
    async rejectResponse(status: number): Promise<void> {
      if (!reservationId) return;
      const id = reservationId;
      reservationId = undefined;
      if ([400, 401, 403, 404, 422, 429].includes(status)) await execution.ledger.release(id);
      else await execution.ledger.markUnknown(id);
    },
    remaining(): number | undefined {
      return execution.policy.deadlineAt === undefined
        ? undefined
        : Math.max(1, execution.policy.deadlineAt - deps.clock.now());
    },
  };
}
