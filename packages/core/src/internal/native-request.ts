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
      // cache write, the dearest input rate. A model the registry does not know
      // sends no cap on the OpenAI and Gemini wires; its reservation is then the
      // row's placeholder, an estimate rather than a bound (`maxOutputTokens`
      // makes it one).
      const caps = getCapabilities(options.model);
      const outputTokens =
        wireOutputCap(options.model.surface, caps, options, modelId) ?? caps.maxOutput;
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
        try {
          await execution.ledger.release(requestId);
          reservationId = undefined;
        } catch {
          // The kept id is settled as unknown on the caller's error path.
        }
        throw error;
      }
    },
    // F17 (2.3): the request id is forgotten only once the ledger accepted the
    // write, so a failed settlement can still be closed on the error path.
    async settle(usage: Usage | undefined, available: boolean): Promise<void> {
      const id = reservationId;
      if (!id) return;
      await (usage && available
        ? execution.ledger.settleUsage(id, withTotal(usage), deps.priceProvider ?? NO_PRICES)
        : execution.ledger.markUnknown(id));
      reservationId = undefined;
    },
    async rejectResponse(status: number): Promise<void> {
      const id = reservationId;
      if (!id) return;
      await ([400, 401, 403, 404, 422, 429].includes(status)
        ? execution.ledger.release(id)
        : execution.ledger.markUnknown(id));
      reservationId = undefined;
    },
    remaining(): number | undefined {
      return execution.policy.deadlineAt === undefined
        ? undefined
        : Math.max(1, execution.policy.deadlineAt - deps.clock.now());
    },
  };
}
