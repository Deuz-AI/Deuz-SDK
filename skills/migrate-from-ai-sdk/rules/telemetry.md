# Telemetry, observation and cost

## `@ai-sdk/otel` maps to `@deuz-sdk/core/otel`

AI SDK 7 moved OpenTelemetry into `@ai-sdk/otel` with a global `registerTelemetry(...)`. Deuz ships an
adapter but **no global registration** — you thread it through the `Dependencies` seam, so nothing is
ambient and tests stay deterministic.

```ts
import { createClient } from '@deuz-sdk/core';
import { createOtelTracer, createOtelObserver, otelReady } from '@deuz-sdk/core/otel';

// Pick ONE — attaching both double-spans the run.
const tracer = createOtelTracer();           // naming: 'gen-ai' by default
export const ai = createClient({ deps: { tracer } });

// startSpan() is sync while the peer import is not; await this once at startup to
// surface a missing-peer error instead of silently emitting nothing.
await otelReady(tracer);
```

`@opentelemetry/api` is an OPTIONAL peer, imported lazily — install it yourself. Content capture is
OPT-IN (`captureContent: true`) and always double-redacted; AI SDK records inputs/outputs by default, so
do NOT port that assumption across.

Everything below still applies if you would rather implement the seam yourself.

```ts
import type { Tracer, Span, SpanOptions } from '@deuz-sdk/core';

interface Tracer {
  startSpan(name: string, attributes?: Record<string, unknown>, options?: SpanOptions): Span;
}
interface Span {
  setAttribute(key: string, value: unknown): void;
  recordException(error: unknown): void;
  end(): void;
}
interface SpanOptions {
  parent?: Span; // carries the enclosing span so a bridge builds a REAL parent-child tree
}
```

Adapting it to an OTel tracer is a small wrapper: create a span in `startSpan` (using `options.parent` for the context), forward `setAttribute` / `recordException`, and `end()` it. Pass it once per call or pre-bind it with `createClient({ deps: { tracer } })`.

There is **no ambient/global tracer** and there will not be: core reads no globals. If the ported app called `registerTelemetry` once at boot, that becomes a shared `deps` object threaded through `createClient`.

Never open spans in your own orchestration code paths inside the SDK — the internal tracer bridge is the single span source.

## Observation — the richer seam

`deps.observer` receives a versioned `ObserveEvent` protocol, which is closer to what a devtools/eval workflow needs than raw spans. Built-ins:

```ts
// edge-safe: '@deuz-sdk/core/observe'
createMemoryObserver, createCallbackObserver, composeObservers, filterObserver, summarizeRun

// Node: '@deuz-sdk/core/observe/node'
createJsonlObserver, readJsonlEvents
```

`@ai-sdk/devtools` runs a local web UI on a port; Deuz has no server. The equivalent is a FILE:
`renderRunReport(events, options?)` (`@deuz-sdk/core/observe`) returns one self-contained HTML document
(inline CSS/JS, no external fetch, opens from `file://`), and `writeRunReport({ from, to })`
(`@deuz-sdk/core/observe/node`) renders it straight from a `createJsonlObserver` JSONL file. Nothing
records by default and nothing listens on a port. `summarizeRun(events)` still gives the per-run rollup.

Two properties to preserve when porting:

- **Fast path.** With no observer and a noop tracer, the observation runtime is never created — zero event objects and zero extra id draws. Do not wire an observer "just in case" in hot paths.
- **Content capture is opt-in** and always passes redaction. Keys never reach a log, error, span or wire frame — that is a P0 regression-tested invariant.

## Secret redaction

`Authorization` / `x-api-key` / `x-goog-api-key` headers and `sk-` / `sk-ant-` / `AIza` / `Bearer` token patterns are masked (last 4 characters only) everywhere: logs, errors, spans, the UI wire's `error` message. `DeuzError` carries no raw request body or headers by default.

Factory settings (including `apiKey`) live on a non-enumerable Symbol, so `Object.keys(model)` and `JSON.stringify(model)` never leak them:

```ts
console.log(Object.keys(model)); // ['provider', 'modelId', 'surface']
```

If the ported app logged the AI SDK's provider object or request bodies, that logging can be deleted rather than reproduced.

## `warnings` reports on `streamChat` only

The AI SDK's `result.warnings` reports dropped settings on every result. Deuz's is populated on **`streamChat`** (`await result.warnings`, plus live `warning` parts on `fullStream`) and is `undefined` on `generateText` / `generateObject` / `streamObject`. A `streamChat` carrying `tools` / `chat` / `memory` / `verifyStep` / `doneWhen` reports only its own `activeTools` notices.

These are the degradations at stake, and every one of them reports through `deps.logger.warn` on every path:

- a provider-executed (hosted) tool dropped on a `chat_completions`-surface model,
- a document dropped on a model whose capability row cannot accept one,
- an unknown model slug falling back to the conservative capability row,
- a `temperature` / `topP` / `effort` value stripped because the model's row cannot carry it,
- an `activeTools` name that matches no tool.

So the port must wire a logger, and treat the field as a bonus rather than the source:

```ts
const deps = {
  logger: {
    debug() {}, info() {},
    warn: (msg: string, meta?: unknown) => console.warn('[deuz]', msg, meta),
    error: (msg: string, meta?: unknown) => console.error('[deuz]', msg, meta),
  },
};
```

The default logger is a **no-op**, which is why these situations look silent out of the box.

## Cost and usage

Deuz meters real provider-reported usage and can price it locally — there is no hosted billing view to replace.

```ts
import { createPriceProvider, PRICES_2026 } from '@deuz-sdk/core';

const deps = { priceProvider: createPriceProvider(PRICES_2026) };
```

With a `priceProvider` you get `cost` parts on the wire (feed them straight into a badge), `budget: { usd, tokens }` guardrails, and the `costExceeds(usd)` stop condition. **Without one, `costExceeds` warns ONCE and then never fires** — a silent no-op that is easy to mistake for "the budget was never reached".

A budget stop does **not** change `finishReason` (the union is locked). Read `result.providerMetadata?.deuz?.stoppedBy` (or the `finish` part's `providerMetadata`) instead.

`onUsage(usage, meta)` fires once per request with `meta.reason` (`'finished'` / `'aborted'` / `'error'`), `meta.ttftMs`, and `meta.agentPath` inside a sub-agent. `onFinish(meta)` fires on successful completion.

## Determinism in tests

Everything ambient is injected, which makes ported tests simpler than their AI SDK originals:

- `deps.fetch` — return a deterministic SSE `ReadableStream` (`sseResponse`, `sseEvents`, `mockFetch`, `mockFetchSequence` from `@deuz-sdk/core/testing`). No interception layer needed.
- `deps.clock` — every timer, including retries and timeouts, goes through it.
- `deps.generateId` — ids AND retry jitter (FNV-1a over the id), so backoff is reproducible.
- `createMockModel` — scripted turns for tool-loop tests with no LLM.
