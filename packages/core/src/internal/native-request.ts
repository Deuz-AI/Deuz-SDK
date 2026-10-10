import { assertExecutionPolicy } from '../execution-policy';
export { assertExecutionPolicy } from '../execution-policy';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { getCapabilities } from '../core/registry';
import { createTokenEstimator } from './estimate-tokens';
import { wireOutputCap } from './output-cap';
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
      if (usd === undefined && deps.priceProvider) {
        try {
          usd = (await deps.priceProvider.priceUsage(modelId, estimatedUsage)) ?? undefined;
        } catch {
          /* Unknown prices cannot admit a bounded USD request. */
        }
      }
      // The ledger revision only grows; a reservation count shrinks after 2.2 compaction.
      const requestId = `${execution.scopeId}/${deps.generateId()}/${execution.ledger.snapshot().revision + 1}`;
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
