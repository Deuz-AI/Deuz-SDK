# @deuz-sdk/ai-sdk-provider

Deuz budgets, fail-over and circuit breaker for [Vercel AI SDK](https://ai-sdk.dev) models.

The AI SDK has no persistent, cross-process USD ceiling. This package adds one
without asking you to rewrite anything: wrap your model in one line and keep
using `generateText`, `streamText`, `generateObject` and agents as before. Every
call is then reserved against a [Deuz](https://github.com/Deuz-AI/Deuz-SDK)
budget, priced by Deuz's price table, settled with the usage the provider
reports, and guarded by Deuz's circuit breaker and fail-over.

```bash
npm install @deuz-sdk/ai-sdk-provider @deuz-sdk/core @ai-sdk/provider ai
```

Requires AI SDK 7 (`ai@7`, `@ai-sdk/provider@4`, language-model spec `v4`) and
Node 22+. `@deuz-sdk/core` stays zero-dependency; `@deuz-sdk/core` and
`@ai-sdk/provider` are peers of this package, and `ai` is what your app already
installs.

## One line

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { deuz } from '@deuz-sdk/ai-sdk-provider';

const model = deuz(openai('gpt-5-mini'), { budget: { usd: 5 } });

const { text } = await generateText({ model, prompt: 'Summarise the ticket.' });
```

`budget: { usd, tokens }` on its own is an **in-process** budget: it counts every
call through this wrapped model in this process, for as long as the model value
lives. `model.ledger.totals()` shows what it has spent.

## A persistent, shared ceiling

Give the budget a `BudgetStore` and one or more scopes. Every process that uses
the same store shares the same scopes, and admission is all-or-none across them.

```ts
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { deuz } from '@deuz-sdk/ai-sdk-provider';
import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';
// or: createPostgresBudgetStore from '@deuz-sdk/core/ops/postgres',
//     createRedisBudgetStore from '@deuz-sdk/core/ops/redis',
//     createInMemoryBudgetStore from '@deuz-sdk/core/agent'

const store = createSqliteBudgetStore({ path: './budgets.sqlite' });

export async function POST(request: Request) {
  const { userId, messages } = await request.json();
  // Wrapping is cheap: wrap per request to bind per-user scopes.
  const model = deuz(anthropic('claude-sonnet-4-5'), {
    budget: {
      store,
      scopes: [
        // $2 per user in any rolling 24 hours.
        { key: `user:${userId}`, limits: { usd: 2 }, window: { ms: 86_400_000 } },
        // $500 lifetime for the whole organisation.
        { key: 'org:acme', limits: { usd: 500 } },
      ],
      warnAtPercent: 80,
      onWarning: (w) => console.warn(`${w.key} at ${Math.round(w.percent)}% of its ${w.dimension}`),
    },
    onCost: (receipt) => console.log(receipt.priceKey, receipt.usd, receipt.source),
  });
  return streamText({ model, messages }).toUIMessageStreamResponse();
}
```

Scopes, windows, warnings, holds, `sweep` and `prune` behave exactly as in core;
see the Deuz [budgets guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/budgets.mdx).

## What happens at the ceiling

Before the call is sent, Deuz reserves an estimate. When it does not fit, the
call fails with `DeuzBudgetError` and **the provider is never called**:

- `code: 'budget_exceeded'`: the estimate does not fit a token or USD bound;
- `code: 'unpriced_model'`: the model has no price and the budget says
  `unknownPrice: 'reject'`;
- `code: 'missing_reservation'`: a USD bound applies but the price lookup threw
  (an outage fails closed);
- `code: 'admission_failed'`: the store itself failed; nothing was admitted.

`DeuzBudgetError` is not an `APICallError` and has `isRetryable: false`, so the
AI SDK does not retry it. `generateText` rejects with it. `streamText` surfaces it
like any model error: an `error` part on `fullStream` and your `onError` callback.

```ts
import { DeuzBudgetError } from '@deuz-sdk/ai-sdk-provider';

try {
  await generateText({ model, prompt });
} catch (error) {
  if (DeuzBudgetError.isInstance(error) && error.code === 'budget_exceeded') {
    return new Response('Monthly budget reached', { status: 402 });
  }
  throw error;
}
```

## Prices and models without one

Calls are priced by `createPriceProvider()` from `@deuz-sdk/core/pricing` unless
you pass your own `priceProvider`. The price key is the AI SDK `modelId`, with
Vertex `@version` suffixes and Bedrock region/vendor prefixes and `-v1:0`
suffixes removed; Deuz's lookup also drops a vendor prefix such as `openai/` and
a trailing snapshot date. Map anything else yourself:

```ts
deuz(azure('prod-gpt-deployment'), { priceKey: 'gpt-5-mini' });
deuz(model, { priceKey: ({ provider, modelId }) => myTable[modelId] }); // undefined → default
```

A model with no price follows `unknownPrice`:

- `'warn'` (default): the call runs; its tokens are reserved, bounded and
  recorded, its USD cost is left out of every USD total, and the first call per
  model reports an AI SDK warning;
- `'reject'`: refused with `DeuzBudgetError` code `'unpriced_model'` under a USD
  bound. A persistent scope's own `limits.unknownPrice: 'reject'` refuses too.

## Fail-over and circuit breaker

```ts
const model = deuz(openai('gpt-5-mini'), {
  budget: { usd: 5 },
  fallbackModels: [anthropic('claude-haiku-4-5'), { model: azure('backup'), priceKey: 'gpt-5-mini' }],
  onFallback: ({ from, to, error }) => console.warn(`${from.modelId} → ${to.modelId}`, error),
});
```

- A model is tried, then the next, only while it has produced **no content**
  (core's pre-first-byte rule). An error after the first text, reasoning or tool
  part is final. A stream is buffered until its first content part.
- By default a hop happens on an open breaker, a retryable error or a 5xx;
  client errors, aborts and budget refusals never hop. Override with
  `shouldFallback`.
- Each attempt is reserved, priced and settled as its own call.
- Each model has a breaker keyed `provider:modelId` with core's defaults: it
  opens after 5 consecutive provider failures (retryable or 5xx) and fails fast
  with core's `BreakerOpenError` for 30 s, then lets one call through. Configure
  it with `breaker: { threshold, cooldownMs, store }` or turn it off with
  `breaker: false`. The default store is in memory, one per wrapper.

## Cost receipts

`onCost` receives one receipt per completed call, and the same summary is set
as `providerMetadata.deuz` on the result (on the `finish` part of a stream):

```ts
{
  requestId: '…', operation: 'stream', provider: 'openai.responses', modelId: 'gpt-5-mini',
  priceKey: 'gpt-5-mini',
  source: 'measured',          // 'estimated' when no usage came back or pricing failed
  tokens: 1500, usd: 0.00125,  // what the budget was charged
  unpriced: false,
  estimate: { tokens: 4110, usd: 0.0082 },
  usage: { inputTokens: 1000, outputTokens: 500, … },  // Deuz canonical usage
  settled: true,               // false: the store failed to settle; the estimate stays held
  failedOver: { from: 'openai.responses:gpt-5-mini', reason: 'http_503' },  // only after a hop
  at: 1763251200000,
}
```

## Middleware form

The budget, breaker and receipts are also available as an AI SDK middleware,
to compose with other middleware or to guard an older-spec (v2/v3) model, which
`wrapLanguageModel` upgrades first. Fail-over is not part of it.

```ts
import { wrapLanguageModel } from 'ai';
import { deuzMiddleware } from '@deuz-sdk/ai-sdk-provider';

const budget = deuzMiddleware({ budget: { usd: 5 } });
const model = wrapLanguageModel({ model: openai('gpt-5-mini'), middleware: budget });
budget.ledger.totals();
```

One middleware value holds one ledger and one breaker store, shared by every
model it wraps. `deuz()` takes only `v4` models and throws
`DeuzUnsupportedModelError` for others.

## Honest limits

- **Admission runs on estimates.** The prompt is estimated from its characters
  (3.6 per token, 1 600 per file part); there is no tokenizer, so dense code,
  non-Latin text and PDFs can be under-estimated. The output is reserved at
  `maxOutputTokens`, or 4 096 when the call sets none, and a provider can bill
  more than that. Set `maxOutputTokens`, or `estimate: { capOutputTokens: true }`
  to send the reserved amount as the cap (this can cut long answers short).
- **A ceiling can be overshot by up to one call.** The actual usage replaces the
  estimate only after the call. Several calls in flight are each admitted
  against what was committed when they started.
- **Streaming settles at the end.** A stream holds its estimate until its
  `finish` part arrives. A stream that ends, errors or is cancelled before it
  keeps the estimate charged (fail closed), since the provider may have billed it.
- **Failed calls.** A failure with status 400, 401, 403, 404, 422 or 429 releases
  the hold; any other failure keeps the estimate charged. Use the store's
  `holds()` and `sweep()` to reconcile such holds.
- **Not provider-enforced.** Deuz decides whether to send a call; it cannot stop
  a provider from billing a call that was sent.
- **Settlement failures do not fail the call.** When the store fails to settle
  after core's retries, the call still returns, the estimate stays held in the
  store, and `onAccountingError` is called.
- An in-process budget, the breaker's default store and the `unpriced` warning
  are per wrapped model. Use a store (budget) and a shared `breaker.store` to
  share them.
- AI SDK retries happen around the wrapper: each retry is a new, separately
  admitted call.
- `supportedUrls` is the wrapped model's; a fallback model that does not support
  a URL the first one does receives the URL unchanged.
- Tested against the AI SDK's mock models, not live providers.

## License

MIT
