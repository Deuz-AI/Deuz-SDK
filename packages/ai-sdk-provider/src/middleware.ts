import type { LanguageModelV4Middleware } from '@ai-sdk/provider';
import type { BudgetLedger } from '@deuz-sdk/core/agent';
import { createGuard, type DeuzOptions } from './guard';

/** An AI SDK middleware that runs every call through a Deuz budget. */
export type DeuzMiddleware = LanguageModelV4Middleware & {
  /** The ledger the middleware reserves against: read `totals()` for spend. */
  readonly ledger: BudgetLedger;
};

/**
 * The budget, circuit breaker and cost receipts of `deuz()` as an AI SDK
 * `LanguageModelV4Middleware`, for `wrapLanguageModel` from `ai`. Fail-over
 * is not part of it: a middleware wraps one model. Use this form to compose
 * with other middleware or to guard an older-spec (v2/v3) model, which
 * `wrapLanguageModel` upgrades first.
 *
 * One middleware value holds one ledger and one breaker store: every model
 * it wraps shares them.
 *
 * @example
 * ```ts
 * import { wrapLanguageModel, generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { deuzMiddleware } from '@deuz-sdk/ai-sdk-provider';
 *
 * const model = wrapLanguageModel({
 *   model: openai('gpt-5-mini'),
 *   middleware: deuzMiddleware({ budget: { usd: 5 } }),
 * });
 * await generateText({ model, prompt: 'Hello' });
 * ```
 */
export function deuzMiddleware(options: DeuzOptions = {}): DeuzMiddleware {
  const guard = createGuard(options);
  return {
    specificationVersion: 'v4',
    ledger: guard.ledger,
    transformParams: async ({ params }) => guard.prepare(params),
    wrapGenerate: ({ doGenerate, params, model }) =>
      guard.generate(model, params, () => doGenerate()),
    wrapStream: ({ doStream, params, model }) => guard.stream(model, params, () => doStream()),
  };
}
