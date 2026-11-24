/**
 * Typed errors of the AI SDK adapter. None of them is an AI SDK `APICallError`
 * and each carries `isRetryable: false`, so the AI SDK's retry loop (which only
 * retries a retryable `APICallError` or `GatewayError`) rethrows them at once.
 */
import type { BudgetLedgerError } from '@deuz-sdk/core/agent';

/** The codes a `BudgetLedgerError` carries (core does not export the union by name). */
export type DeuzBudgetErrorCode = BudgetLedgerError['code'];

const DEUZ_BUDGET_ERROR = Symbol.for('@deuz-sdk/ai-sdk-provider/DeuzBudgetError');

/**
 * A Deuz budget refused a call before it was sent to the provider.
 *
 * `code` is the `BudgetLedgerError` code that refused it:
 * - `'budget_exceeded'`: the estimate does not fit a token or USD bound, in
 *   the in-process budget or in a persistent `BudgetStore` scope;
 * - `'unpriced_model'`: the model has no price and a USD bound uses
 *   `unknownPrice: 'reject'`;
 * - `'missing_reservation'`: a USD bound applies but the price lookup threw,
 *   so no USD estimate exists (an outage fails closed);
 * - `'admission_failed'`: the persistent store itself failed; nothing was
 *   admitted.
 *
 * The original `BudgetLedgerError` is the `cause`. Nothing was billed: the
 * wrapped model was never called.
 */
export class DeuzBudgetError extends Error {
  readonly name = 'DeuzBudgetError';
  /** Always false: the AI SDK never retries a budget refusal. */
  readonly isRetryable = false;
  readonly code: DeuzBudgetErrorCode;
  /** AI SDK `provider` of the refused model. */
  readonly provider: string;
  /** AI SDK `modelId` of the refused model. */
  readonly modelId: string;
  /** The Deuz price key the call was estimated with. */
  readonly priceKey: string;

  constructor(options: {
    code: DeuzBudgetErrorCode;
    message: string;
    provider: string;
    modelId: string;
    priceKey: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.priceKey = options.priceKey;
    Object.defineProperty(this, DEUZ_BUDGET_ERROR, { value: true });
  }

  /** True for a `DeuzBudgetError`, also across duplicate package copies. */
  static isInstance(value: unknown): value is DeuzBudgetError {
    return (
      value instanceof DeuzBudgetError ||
      (typeof value === 'object' &&
        value !== null &&
        (value as Record<PropertyKey, unknown>)[DEUZ_BUDGET_ERROR] === true)
    );
  }
}

/**
 * `deuz()` was given a model that does not implement the installed AI SDK
 * language-model specification (`'v4'`, AI SDK 7). Wrap an older-spec model
 * with `wrapLanguageModel({ model, middleware: deuzMiddleware(...) })` from
 * `ai`, which upgrades it first.
 */
export class DeuzUnsupportedModelError extends TypeError {
  readonly name = 'DeuzUnsupportedModelError';
  readonly isRetryable = false;
  readonly specificationVersion: string;

  constructor(specificationVersion: string) {
    super(
      `deuz() needs a LanguageModelV4 (AI SDK 7); got specificationVersion '${specificationVersion}'. ` +
        "Use wrapLanguageModel({ model, middleware: deuzMiddleware(options) }) from 'ai' for an older model.",
    );
    this.specificationVersion = specificationVersion;
  }
}
