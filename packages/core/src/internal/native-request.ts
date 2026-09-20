import { assertExecutionPolicy } from '../execution-policy';
export { assertExecutionPolicy } from '../execution-policy';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { createTokenEstimator } from './estimate-tokens';
import type { CommonCallOptions } from '../types/config';
import type { ResolvedDependencies } from '../types/deps';
import type { Usage } from '../types/usage';
import type { InternalRunOptions } from '../core/inference';

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
  return {
    assert,
    async reserve(): Promise<void> {
      assert();
      if (userSignal?.aborted) throw userSignal.reason ?? new DOMException('Aborted', 'AbortError');
      const inputTokens =
        createTokenEstimator().estimate(options.messages) +
        Math.ceil(JSON.stringify(internal.tools?.tools ?? []).length / 3.6);
      const estimatedUsage = withTotal({
        ...EMPTY_USAGE,
        inputTokens,
        outputTokens: options.maxOutputTokens ?? 4096,
      });
      let usd = options.executionEstimate?.usd;
      if (usd === undefined && deps.priceProvider) {
        try {
          usd = (await deps.priceProvider.priceUsage(modelId, estimatedUsage)) ?? undefined;
        } catch {
          /* Unknown prices cannot admit a bounded USD request. */
        }
      }
      const requestId = `${execution.scopeId}/${deps.generateId()}/${execution.ledger.snapshot().reservations.length + 1}`;
      await execution.reserve({
        requestId,
        modelId,
        now: deps.clock.now(),
        kind: internal.observe?.purpose ?? internal.operation ?? 'model',
        tokens: options.executionEstimate?.tokens ?? estimatedUsage.totalTokens,
        ...(usd !== undefined ? { usd } : {}),
      });
      reservationId = requestId;
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
        await execution.ledger.settleUsage(id, withTotal(usage), deps.priceProvider);
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
