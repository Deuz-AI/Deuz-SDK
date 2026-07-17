---
'@deuz-sdk/core': minor
---

Live USD cost streaming (D2) and a conversation budget guardrail (D3) — both in-library, no gateway required:

- **Live `cost` part** — with a `deps.priceProvider` injected, the streaming loop emits a cumulative `cost` part after every step (`costUsd`, per-step `deltaUsd`, `stepIndex`), and single-turn calls price the finish usage inline. Cumulative totals are cross-leg on durable resumes. Vercel closed this as wontfix (vercel/ai#3932) — Deuz ships it from a verified in-library price catalog.
- **`cacheSavingsUsd`** — the new optional `PriceProvider.cacheSavings` seam (implemented by `createPriceProvider`, margin-aware, standalone `cacheSavings()` export in `./pricing`) reports the USD saved by prompt-cache reads as its own field.
- **`budget: { usd?, tokens? }`** — a first-class call option that hard-stops the agentic loop at a spend or token ceiling: sugar over `costExceeds`/`totalTokensExceed` with dedicated `stoppedBy: 'budget.usd' | 'budget.tokens'` markers and a typed `budget-exceeded` stream part before `finish` (render a continue-confirmation directly from it). AI SDK has no built-in budget stop — its docs hardcode prices in a custom condition.
- `durationExceeds` (written in 1.6, unexported until now) joins the root and edge surfaces.
- Raw bundle budgets raised deliberately for the 1.7 feature set (core 100 kB → 110 kB, edge 90 kB → 100 kB); the gzip budgets — the delivery-relevant guard — are unchanged.
