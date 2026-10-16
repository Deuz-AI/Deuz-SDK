/**
 * Charges the memory session's own model and embedding calls (2.4, the
 * accounted-call contract of `types/accounting.ts`). With an execution
 * context, every call reserves on its ledger before it runs (so a policy or a
 * strict budget refuses it first), then settles: an accounted callback with
 * the usage it reported, an unmarked one as unknown with its estimate still
 * held (never as free), plus one `unaccounted-usage` warning per session.
 * Without an execution context the callbacks simply run. Edge-safe.
 */
import { EMPTY_USAGE, withTotal } from '../../core/metering';
import { isAccounted } from '../../internal/accounting';
import { createTokenEstimator } from '../../internal/estimate-tokens';
import type { Embedder, MemoryLLM } from '../../memory';
import type {
  AccountedMemoryEmbedder,
  AccountedMemoryLLM,
  AccountedUsage,
} from '../../types/accounting';
import type { PriceProvider, ResolvedDependencies } from '../../types/deps';
import type { NativeExecutionContext } from '../../types/execution';
import type { CallWarning } from '../../types/methods';
import type { Usage } from '../../types/usage';
import { invalid } from './shared';

/** Without a price provider no model has a price. */
const NO_PRICES: PriceProvider = { priceUsage: () => undefined };

/** Output tokens a memory LLM answer is assumed to take before it reports usage. */
const LLM_OUTPUT_ESTIMATE = 1024;

export interface MemoryCharging {
  /** One memory LLM call: its answer text. */
  complete(
    llm: MemoryLLM | AccountedMemoryLLM,
    prompt: { system: string; user: string },
  ): Promise<string>;
  /** One embedding call: one vector per text, and the model that made them. */
  embed(
    embedder: Embedder | AccountedMemoryEmbedder,
    texts: string[],
    action: 'add' | 'search' | 'update',
    modelId?: string,
  ): Promise<{ vectors: number[][]; model: string }>;
}

export interface MemoryChargingOptions {
  execution?: NativeExecutionContext;
  deps: ResolvedDependencies;
  /** The model a reservation names for LLM calls (prices and allowlists read it). */
  llmModelId?: string;
  /** The model a reservation names for embedding calls when no generation names one. */
  embedderModelId?: string;
}

function estimateTokens(texts: readonly string[]): number {
  return createTokenEstimator().estimate(texts.map((text) => ({ role: 'user', content: text })));
}

export function createMemoryCharging(options: MemoryChargingOptions): MemoryCharging {
  const { execution, deps } = options;
  let warned = false;

  const reportUnaccounted = (what: string): void => {
    if (warned) return;
    warned = true;
    const warning: CallWarning = {
      type: 'unaccounted-usage',
      message: `The memory ${what} reports no usage: its calls are charged as unaccounted at their estimates. Use an accounted variant for a strict budget.`,
    };
    deps.logger.warn(warning.message, { warning: warning.type });
  };

  /** Reserves, runs and settles one call on `execution`'s ledger. */
  async function charged<T>(
    call: {
      kind: string;
      modelId: string;
      accounted: boolean;
      inputTokens: number;
      outputTokens: number;
      what: string;
    },
    run: () => Promise<T>,
    usageOf: (result: T) => AccountedUsage | undefined,
  ): Promise<T> {
    if (!execution) return run();
    const estimated: Usage = {
      ...EMPTY_USAGE,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      totalTokens: call.inputTokens + call.outputTokens,
    };
    let usd: number | undefined;
    let unpriced = false;
    try {
      usd = (await deps.priceProvider?.priceUsage(call.modelId, estimated)) ?? undefined;
      unpriced = usd === undefined;
    } catch {
      // An outage, not a missing price: a USD bound refuses the call without an estimate.
    }
    const requestId = `${execution.scopeId}/memory/${deps.generateId()}`;
    await execution.reserve({
      requestId,
      modelId: call.modelId,
      kind: call.kind,
      tokens: estimated.totalTokens,
      now: deps.clock.now(),
      ...(usd !== undefined ? { usd } : {}),
      ...(unpriced ? { unpriced: true } : {}),
      ...(!call.accounted ? { unaccounted: true } : {}),
    });
    if (!call.accounted) reportUnaccounted(call.what);
    let result: T;
    try {
      result = await run();
    } catch (error) {
      // The request may have been billed: keep the estimate held.
      await execution.ledger.markUnknown(requestId).catch(() => undefined);
      throw error;
    }
    const usage = call.accounted ? usageOf(result) : undefined;
    if (usage)
      await execution.ledger.settleUsage(
        requestId,
        withTotal(usage.usage),
        deps.priceProvider ?? NO_PRICES,
      );
    else await execution.ledger.markUnknown(requestId);
    return result;
  }

  return {
    async complete(llm, prompt) {
      const accounted = isAccounted(llm);
      const result = await charged(
        {
          kind: 'memory-llm',
          modelId: options.llmModelId ?? 'memory-llm',
          accounted,
          inputTokens: estimateTokens([prompt.system, prompt.user]),
          outputTokens: LLM_OUTPUT_ESTIMATE,
          what: 'LLM',
        },
        () => (llm as (prompt: { system: string; user: string }) => Promise<unknown>)(prompt),
        (answer) =>
          (answer as AccountedUsage | undefined)?.usage ? (answer as AccountedUsage) : undefined,
      );
      if (accounted) {
        const text = (result as { text?: unknown } | null)?.text;
        if (typeof text !== 'string')
          throw invalid('An accounted memory LLM must return { text, usage, modelId }.');
        return text;
      }
      if (typeof result !== 'string') throw invalid('A memory LLM must return a string.');
      return result;
    },

    async embed(embedder, texts, action, modelId) {
      const accounted = isAccounted(embedder);
      const result = await charged(
        {
          kind: 'memory-embedding',
          modelId: modelId ?? options.embedderModelId ?? 'memory-embedder',
          accounted,
          inputTokens: estimateTokens(texts),
          outputTokens: 0,
          what: 'embedder',
        },
        () =>
          (
            embedder.embed as (
              texts: string[],
              action: 'add' | 'search' | 'update',
            ) => Promise<{ vectors: number[][]; model: string } & Partial<AccountedUsage>>
          )(texts, action),
        (answer) =>
          answer.usage
            ? { usage: answer.usage, modelId: answer.modelId ?? answer.model }
            : undefined,
      );
      if (
        !result ||
        !Array.isArray(result.vectors) ||
        result.vectors.length !== texts.length ||
        typeof result.model !== 'string'
      )
        throw invalid(
          `The memory embedder must return one vector per text and its model (${texts.length} asked).`,
        );
      return { vectors: result.vectors, model: result.model };
    },
  };
}
