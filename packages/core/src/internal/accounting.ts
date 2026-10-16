/**
 * Accounted-callback helpers (2.4): mark a host callback as one that reports
 * its usage, tell marked from unmarked ones, and charge one call of either to
 * an execution context's ledger. See `types/accounting.ts` for the contract.
 * Edge-safe.
 */
import { assertExecutionPolicy } from '../execution-policy';
import type {
  AccountedEmbedder,
  AccountedMemoryLLM,
  AccountedMemoryLLMResult,
  AccountedUsage,
} from '../types/accounting';
import type { PriceProvider } from '../types/deps';
import type { BudgetReservationInput, NativeExecutionContext } from '../types/execution';
import type { CallWarning } from '../types/methods';
import { firstRunReport } from './run-ledger';

/**
 * Whether `callback` declares that it reports usage (`accounted: true`). A
 * callback without the mark is unaccounted: its calls are never counted as
 * free (see `BudgetReservation.unaccounted`).
 */
export function isAccounted(callback: unknown): boolean {
  return (
    (typeof callback === 'function' || (typeof callback === 'object' && callback !== null)) &&
    (callback as { accounted?: unknown }).accounted === true
  );
}

/** Marks a memory LLM callback that returns its text with the call's usage. */
export function defineAccountedMemoryLLM(
  fn: (prompt: { system: string; user: string }) => Promise<AccountedMemoryLLMResult>,
): AccountedMemoryLLM {
  if (typeof fn !== 'function')
    throw new TypeError('defineAccountedMemoryLLM needs a function that returns { text, usage }');
  const llm = (prompt: { system: string; user: string }) => fn(prompt);
  return Object.defineProperty(llm, 'accounted', {
    value: true,
    enumerable: true,
  }) as AccountedMemoryLLM;
}

/** Marks a RAG embedder whose `embed` returns the vectors with the call's usage. */
export function defineAccountedEmbedder(
  embedder: Omit<AccountedEmbedder, 'accounted'>,
): AccountedEmbedder {
  if (typeof embedder?.embed !== 'function' || !Number.isSafeInteger(embedder.dims))
    throw new TypeError('defineAccountedEmbedder needs { embed, dims }');
  return { embed: (texts) => embedder.embed(texts), dims: embedder.dims, accounted: true };
}

/**
 * The `unaccounted-usage` warning for one kind of callback (2.4). Its text
 * depends only on `kind`, so a run's warning sink keeps it once.
 */
export function unaccountedUsageWarning(kind: string): CallWarning {
  return {
    type: 'unaccounted-usage',
    setting: kind,
    message:
      `The ${kind} callback reports no usage, so its calls are counted as unaccounted at their ` +
      'estimates, never as free; pass its accounted variant to charge what they really used.',
  };
}

/** Without a price provider no model has a price. */
const NO_PRICES: PriceProvider = { priceUsage: () => undefined };

/** What `chargeCallback` needs to charge one host callback call (2.4). */
export interface ChargeCallbackOptions<T> {
  /** The context whose policy, budgets and ledger admit the call. */
  readonly execution: NativeExecutionContext;
  /** Unique per call and stable across recovery: the same id is charged once. */
  readonly requestId: string;
  /** The reservation kind, which also names the callback in the warning: `'memory-llm'`, `'rag-embedder'`. */
  readonly kind: string;
  /** The host callback; its `accounted` mark decides how the call is charged. */
  readonly callback: unknown;
  /**
   * The model the callback calls, when the caller knows it before the call:
   * the policy's `allowedModels` checks it. Without it the reservation is
   * named `callback:<kind>` and only the budget, depth and deadline apply.
   */
  readonly modelId?: string;
  /** Conservative token estimate of the call. */
  readonly tokens?: number;
  /**
   * Conservative USD estimate. Without one the reservation is `unpriced`: a
   * USD bound admits it without a USD hold, or refuses it under
   * `unknownPrice: 'reject'`.
   */
  readonly usd?: number;
  /** The injected clock; required when the policy has a deadline. */
  readonly now?: number;
  /** Prices the usage an accounted callback reports, by the model it names. */
  readonly priceProvider?: PriceProvider;
  /** Receives the `unaccounted-usage` warning (once per run ledger). */
  readonly warn?: (warning: CallWarning) => void;
  /** Makes the call. */
  readonly run: () => Promise<T>;
  /** Reads the usage an accounted callback returned with its result. */
  readonly usage?: (result: T) => AccountedUsage | undefined;
}

/**
 * Charges one host callback call to an execution context's ledger (2.4): the
 * one path for memory LLM callbacks and RAG or memory embedders.
 *
 * The call is reserved before it runs, at `tokens` and `usd` under
 * `requestId`. An accounted callback's reported usage settles it, priced by
 * the model the callback names; one that reports none, or throws, leaves the
 * reservation unknown with its estimates held. A callback without the mark is
 * reserved `unaccounted`, so a strict budget (`unknownPrice: 'reject'` on the
 * context, a scope or a persistent scope) refuses it with `unaccounted_call`
 * before it runs; otherwise it runs, ends unknown with its estimates held
 * (never free) and `warn` receives one `unaccounted-usage` warning per run
 * ledger (on a ledger several runs share, once per call, with the same text
 * for each run's warning sink to keep once).
 *
 * A `requestId` the ledger already settled is not settled again, so a
 * retried or recovered call is charged once. A budget or policy refusal
 * rejects before the callback runs; a callback error is rethrown.
 */
export async function chargeCallback<T>(options: ChargeCallbackOptions<T>): Promise<T> {
  const { execution, requestId, kind } = options;
  const ledger = execution.ledger;
  const accounted = isAccounted(options.callback);
  const input: Omit<BudgetReservationInput, 'scopes'> = {
    requestId,
    modelId: options.modelId ?? `callback:${kind}`,
    kind,
    ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
    ...(options.usd !== undefined ? { usd: options.usd } : { unpriced: true }),
    ...(accounted ? {} : { unaccounted: true }),
  };
  const settledBefore = ledger.get(requestId)?.state === 'settled';
  if (options.modelId !== undefined)
    await execution.reserve({
      ...input,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  else {
    // The model is unknown before the call: no allowlist can name it.
    assertExecutionPolicy(execution, { now: options.now });
    await ledger.reserve({ ...input, scopes: execution.snapshot().scopes });
  }
  if (!accounted && firstRunReport(ledger, `unaccounted-usage:${kind}`))
    options.warn?.(unaccountedUsageWarning(kind));
  let result: T;
  try {
    result = await options.run();
  } catch (error) {
    // It may have been billed: the estimates stay held.
    if (!settledBefore) await ledger.markUnknown(requestId).catch(() => undefined);
    throw error;
  }
  if (settledBefore) return result;
  const reported = accounted ? options.usage?.(result) : undefined;
  if (reported?.usage !== undefined) {
    const prices = options.priceProvider ?? NO_PRICES;
    await ledger.settleUsage(requestId, reported.usage, {
      priceUsage: (_modelId, usage) => prices.priceUsage(reported.modelId, usage),
    });
  } else await ledger.markUnknown(requestId);
  return result;
}
