import { assertExecutionPolicy } from '../execution-policy';
export { assertExecutionPolicy } from '../execution-policy';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { getCapabilities } from '../core/registry';
import { createTokenEstimator } from './estimate-tokens';
import { wireOutputCap } from './output-cap';
import { firstRunReport } from './run-ledger';
import { unpricedModelWarning } from './unpriced';
import type { CommonCallOptions } from '../types/config';
import type { CallWarning } from '../types/methods';
import type { PriceProvider, ResolvedDependencies } from '../types/deps';
import type { BudgetLedger, NativeExecutionContext } from '../types/execution';
import type { Usage } from '../types/usage';
import type { InternalRunOptions } from '../core/inference';

/** Without a `deps.priceProvider` no model has a price (2.3). */
const NO_PRICES: PriceProvider = { priceUsage: () => undefined };

/** What a ledger's persistent scopes bound; fixed when the ledger is created. */
const persistentBounds = new WeakMap<BudgetLedger, { usd: boolean; tokens: boolean }>();

function persistent(ledger: BudgetLedger): { usd: boolean; tokens: boolean } {
  let bounds = persistentBounds.get(ledger);
  if (!bounds) {
    const scopes = ledger.snapshot().admission ?? [];
    bounds = {
      usd: scopes.some((scope) => scope.limits.usd !== undefined),
      tokens: scopes.some((scope) => scope.limits.tokens !== undefined),
    };
    persistentBounds.set(ledger, bounds);
  }
  return bounds;
}

/** True when a USD bound applies to calls made under this context. */
function boundsUsd(execution: NativeExecutionContext): boolean {
  // The context budget already intersects every ancestor's.
  return execution.budget.usd !== undefined || persistent(execution.ledger).usd;
}

/** True when a token or USD bound applies to calls made under this context. */
function bounded(execution: NativeExecutionContext): boolean {
  return (
    boundsUsd(execution) ||
    execution.budget.tokens !== undefined ||
    persistent(execution.ledger).tokens
  );
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
  const caps = getCapabilities(options.model);
  // A token or USD bound needs an explicit cap even when ordinary requests
  // leave it to the provider. The reservation must cover the cap actually sent.
  const capped =
    wireOutputCap(options.model.surface, caps, options, modelId) === undefined &&
    bounded(execution);
  const callOptions: CommonCallOptions = capped
    ? { ...options, maxOutputTokens: caps.maxOutput }
    : options;
  let reservationId: string | undefined;
  /** Rounds of settlement the current reservation's store failed (F17: two at most). */
  let settleRounds = 0;
  const assert = () => assertExecutionPolicy(execution, { modelId, now: deps.clock.now() });
  /**
   * Report that the USD budget cannot count this model, once per run (decision
   * 4): a loop or a finalization through its warning sink, which puts it on the
   * result and the stream; a single model call on its own; a swarm or `evolve`
   * run once for all its tasks. A shared execution context does not silence a
   * later run.
   */
  const reportUnpriced = (): void => {
    if (!boundsUsd(execution) || !firstRunReport(execution.ledger, modelId)) return;
    const warning = unpricedModelWarning(modelId, deps.priceProvider !== undefined);
    // The line is logged here, once, even when the sink carries a logger too.
    if (internal.warnings && !internal.warnings.add(warning, { mirror: false })) return;
    deps.logger.warn(warning.message, { warning: warning.type, setting: warning.setting });
  };
  /** The cap this request adds, reported once per run. */
  const warning: CallWarning | undefined = capped
    ? {
        type: 'clamped-setting',
        setting: 'maxOutputTokens',
        message:
          `maxOutputTokens ${caps.maxOutput} was sent: ${modelId} leaves its default output cap unset ` +
          'and the call has a budget; pass maxOutputTokens to select a cap.',
      }
    : undefined;
  return {
    assert,
    /** The options the request is built from: the call's own, or with the cap above. */
    options: callOptions,
    warning,
    async reserve(): Promise<void> {
      assert();
      if (userSignal?.aborted) throw userSignal.reason ?? new DOMException('Aborted', 'AbortError');
      const promptTokens =
        createTokenEstimator().estimate(options.messages) +
        Math.ceil(JSON.stringify(internal.tools?.tools ?? []).length / 3.6);
      // F12 (2.3): reserve the output cap the wire actually sends (Anthropic's
      // thinking raise included), not a fixed 4,096 — the provider may bill up
      // to it, reasoning included. Only a call with no token or USD bound can
      // leave the cap off (see `capped`); nothing is admitted against its
      // reservation, so the row's placeholder is an estimate there.
      const outputTokens =
        wireOutputCap(options.model.surface, caps, callOptions, modelId) ?? caps.maxOutput;
      // A prompt the call caches is billed as a cache write, above the input
      // rate. Only the Anthropic wire writes one, for a row that caches; every
      // other wire bills the prompt as input, long-context tiers included.
      const cacheWrite =
        options.model.surface === 'anthropic' && caps.caching ? options.promptCaching : undefined;
      const estimatedUsage: Usage = {
        ...EMPTY_USAGE,
        ...(cacheWrite === 'auto-1h'
          ? { cacheWrite1hTokens: promptTokens }
          : cacheWrite
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
      settleRounds = 0;
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
    // write. A settlement the store failed (three attempts in the ledger) gets
    // one more round here, while the call can still finish; once that fails
    // too, the call reports it, and the error path does not try a third round.
    async settle(usage: Usage | undefined, available: boolean): Promise<void> {
      const id = reservationId;
      while (id && settleRounds < 2) {
        try {
          await (usage && available
            ? execution.ledger.settleUsage(id, withTotal(usage), deps.priceProvider ?? NO_PRICES)
            : execution.ledger.markUnknown(id));
          reservationId = undefined;
          return;
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code !== 'admission_failed') throw error;
          if (++settleRounds === 2) throw error;
        }
      }
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
