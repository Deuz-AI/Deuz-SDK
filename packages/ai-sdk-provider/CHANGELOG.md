# @deuz-sdk/ai-sdk-provider

## 2.5.0

### Minor Changes

- First release. `deuz(model, { budget })` wraps a Vercel AI SDK 7 language model (`LanguageModelV4`) with a persistent USD and token ceiling. Every `doGenerate` and `doStream` passes a breaker check, a reservation on a Deuz budget ledger (backed by any `BudgetStore`), the call, and a settlement priced by Deuz's price table with a cost receipt. Fallback models take over only before the first content byte. `deuzMiddleware(options)` gives the same budget, breaker and receipts as an AI SDK middleware for `wrapLanguageModel`, without fail-over; that is also the path for AI SDK 5 and 6 models, which `deuz()` refuses with a typed error. A refused call throws `DeuzBudgetError`, which the AI SDK does not retry. Output capping is opt-in (`estimate.capOutputTokens`).
