<!-- verified: 2026-08-12 against @deuz-sdk/core@2.0.0 · api-contract sha256:209a805b7f32
     sources: docs/content/docs/modules/{observability,pricing,middleware}.mdx,
     docs/content/docs/reference/observe-events.mdx, docs/content/docs/advanced/resilience.mdx,
     skills/deuz-sdk/rules/pitfalls.md, packages/core/src/{observe,otel,pricing,middleware,errors}.ts,
     packages/core/src/node/observe.ts, packages/core/src/inference/stop.ts,
     packages/core/src/core/{timeout,resilience}.ts,
     packages/core/src/types/{observe,deps,config}.ts -->

# Production operations: observability, cost, middleware, resilience

**Load when:** you need traces, run reports, OTel export, USD cost or budgets, model-level layers (logging, caching, PII redaction, injection guard), retries, timeouts, cross-provider failover, or a circuit breaker — i.e. anything you would have reached for LangSmith, Langfuse, `@ai-sdk/otel`, or a hand-rolled retry wrapper to get.

Everything here is local-first and injected. There is no hosted service, no account, no data leaving your process, and core imports none of it — you wire it through the one `Dependencies` seam on `deps` (per call) or `createClient({ deps })` (per app). A per-call `deps` field overrides the client's.

## The ops seams on `Dependencies`

| Field | Default | What it unlocks |
| --- | --- | --- |
| `logger` | **no-op** | Every warning core produces. Wire one or you are flying blind — see the last section. |
| `observer` | absent (fast path) | The whole `ObserveEvent` protocol. Absence is the signal: no observer and no tracer means no event objects and no extra `generateId()` draws. |
| `tracer` | no-op | Span seam (`invoke` → `step` → `execute_tool`). `createOtelTracer()` implements it. |
| `tracerMode` | `'hierarchical'` | `'legacy'` restores the 1.5 flat topology (one parent-less `invoke` per model call). |
| `priceProvider` | absent | `cost` stream parts, `budget.usd`, `costExceeds`, `cost.calculated` events. |
| `breakerStore` | in-memory `Map` **per client** | Circuit-breaker state. Resolved once per `createClient` (G11) — a per-call store can never accumulate consecutive failures. |
| `onUsage` / `onFinish` | absent | Metering hooks. A call-level `onUsage` **overrides** `deps.onUsage`; they never both fire (G10). |
| `clock` / `generateId` | host clock / `crypto.randomUUID()` | Timeout timers and retry jitter. Pin both for deterministic tests. |

```ts
import { createClient } from '@deuz-sdk/core';
import type { BreakerState, BreakerStore, Logger } from '@deuz-sdk/core';
import { createMemoryObserver } from '@deuz-sdk/core/observe';
import { createPriceProvider } from '@deuz-sdk/core/pricing';

const logger: Logger = {
  debug: (m, f) => console.debug(m, f),
  info: (m, f) => console.info(m, f),
  warn: (m, f) => console.warn(m, f),
  error: (m, f) => console.error(m, f),
};

// Share this across instances (Redis, a Durable Object, …) and one sick model
// fails fast fleet-wide. Both methods may return a Promise.
const states = new Map<string, BreakerState>();
const breakerStore: BreakerStore = {
  get: (key) => states.get(key),
  set: (key, state) => {
    states.set(key, state);
  },
};

export const observer = createMemoryObserver({ maxEvents: 5_000, maxBytes: 8_000_000 });
const priceProvider = createPriceProvider({ margin: 1.3 }); // 30% markup

export const deuz = createClient({
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY },
  deps: {
    logger,
    observer,
    priceProvider,
    breakerStore,
    onUsage: async (usage, meta) => {
      const usd = await priceProvider.priceUsage(meta.model, usage);
      logger.info('llm.usage', { model: meta.model, reason: meta.reason, usd });
    },
  },
});
```

## Observation events

One versioned protocol (`ObserveEvent`, `schemaVersion: 1`) covers a run's whole lifecycle. Every event carries `eventId`, `sequence` (0-based per execution leg), `timestamp` (from `deps.clock`), `runId`, `executionId`, `spanId`/`parentSpanId`, and optional `agentPath`/`stepIndex`/`metadata`/`truncated`.

| Family | Members | The fields you actually read |
| --- | --- | --- |
| run | `run.started`, `run.completed`, `run.suspended`, `run.aborted`, `run.failed` | `operation`, `endReason` (`natural`/`stop-condition`/`max-steps`/`runaway-tool-errors`), `stoppedBy`, counters, `usage`, `cumulativeUsage`, `costUsd` |
| model | `model.started`, `model.first-content`, `model.retry`, `model.completed`, `model.failed` | `ttftMs`, `retryCount`, `delayMs`/`retryAfterMs`, `purpose: 'compaction-summary'`, per-call `usage` |
| step | `step.started`, `step.completed` | effective `model`, `estimatedInputTokens`, `activeToolCount`, `cumulativeUsage` |
| tool | `tool.started`, `tool.completed`, `tool.failed`, `tool.denied` | `executionMode` (`server`/`client`), `parallel`, `selfHealed`, `consecutiveFailureCount`, denial `cause` |
| approval | `approval.requested`, `approval.resolved` | `approvalId`, `mode`, `approved`, `source` (incl. `default-deny`), `waitDurationMs` |
| checkpoint | `checkpoint.saved`, `checkpoint.loaded`, `checkpoint.failed` | `stepId`, `checkpointStatus`, `checkpointAgeMs`, `runContinued` |
| compaction | `compaction`, `compaction.skipped` | `layer`, `trigger` (`threshold`/`manual`/`overflow`), `tokensBefore`/`tokensAfter` (calibrated **estimates**) |
| subagent | `subagent.started`, `subagent.completed`, `subagent.suspended`, `subagent.failed` | `agentName`, `depth`, `childRunId`, child `usage` (already folded into the parent — never sum twice) |
| cost | `cost.calculated` | `target: 'model' \| 'run'`, `costUsd`. May arrive **after** the terminal event. |
| operation | `operation.started`, `operation.completed`, `operation.failed` | `subsystem` (`image`, `speech`, `video`, `rag`, `memory`, `mcp`, …), `operation` |

Canonical orderings, worth knowing before you write a consumer:

```text
single call   run.started → model.started → model.first-content → model.completed → run.completed
retries       … model.started → model.retry × N → model.first-content → …   (one model.started per call)
tool loop     run.started → (step.started → model.* → tool.* → step.completed) × N → run.completed
suspension    … approval.requested → step.completed → checkpoint.saved{suspended} → run.suspended
resume        checkpoint.loaded → run.started{resumed} → approval.resolved → tool.* → step.started → …
abort         … model.completed{finishReason:'aborted'} → run.aborted   (never model.failed / run.failed)
```

Guarantees you can build on: exactly one terminal event per execution leg; a durable run keeps one `runId` across legs while each leg gets a fresh `executionId`; a throwing, slow or closed observer can never affect the run; `streamChat` stays lazy, so `run.started` fires when the pump starts, not at call time.

### Observers

| Factory | Subpath | Notes |
| --- | --- | --- |
| `createMemoryObserver({ maxEvents?, maxBytes?, overflow?, observation? })` | `@deuz-sdk/core/observe` | Ring buffer with `events()` / `eventsForRun(runId)` / `latestRun()` / `clear()` / `droppedCount`. `maxEvents` default 10 000; `overflow` is `'drop-oldest'` (default) or `'drop-newest'`; both caps compose. |
| `createCallbackObserver(fn, options?)` | `@deuz-sdk/core/observe` | Wraps a plain callback; a throwing callback is swallowed. |
| `composeObservers(...observers)` | `@deuz-sdk/core/observe` | Fan-out with per-sink capture projection; one throwing child never blocks siblings. |
| `filterObserver(observer, predicate)` | `@deuz-sdk/core/observe` | Forward only matching events; a throwing predicate drops the event, not the run. |
| `createJsonlObserver({ file, append?, flushEvery?, maxQueueSize?, observation?, onWriteError? })` | `@deuz-sdk/core/observe/node` | Node-only file sink. |

`summarizeRun(events)` folds one run's events into a `RunSummary` (`status`, `startedAt`/`finishedAt`/`durationMs`, `executionCount`, `stepCount`, `modelCallCount`, `toolCallCount`, `toolErrorCount`, `retryCount`, `approvalCount`, `checkpointCount`, `subAgentCount`, `usage`, `costUsd?`, `errors`). It is pure and total: out-of-order input, multiple legs and a missing terminal event all work (`status: 'running'`). `renderRunReport(events, options?)` turns the same array into one self-contained HTML document — inline CSS/JS, no fetches, opens from `file://` — with `{ title?, runId?, theme? }`.

```ts
import { generateText } from '@deuz-sdk/core';
import type { LanguageModel, ToolSet } from '@deuz-sdk/core';
import { createMemoryObserver, renderRunReport, summarizeRun } from '@deuz-sdk/core/observe';

declare const model: LanguageModel;
declare const tools: ToolSet;

const observer = createMemoryObserver({ maxEvents: 5_000 });

export async function nightly(): Promise<string> {
  const res = await generateText({
    model,
    prompt: 'Draft the release notes from the merged PRs.',
    tools,
    maxSteps: 8,
    deps: { observer },
  });

  // THE DRAINING RULE: cost.calculated can resolve asynchronously (an async
  // priceProvider), so await this before reading events or closing a sink.
  await res.observation?.settled;

  const events = observer.latestRun() ?? [];
  const summary = summarizeRun(events);
  console.log(summary.status, summary.stepCount, summary.usage.totalTokens, summary.costUsd);
  return renderRunReport(events, { title: 'Nightly release notes', theme: 'auto' });
}
```

`observation` exists on the result **only** when an observer (or a real tracer) was active — hence `res.observation?.settled`. Nothing about the run itself ever waits on it (G2 holds). On `streamChat`, drain the stream (or `consume()`) first: the pump is lazy, so an undrained stream emits no events at all.

### Privacy defaults and capture

By default events carry only counts, ids, names, durations and small enums — never prompts, tool inputs/outputs, reasoning or error message text. Raw content is opt-in per field on `ObservationOptions`:

```ts no-verify
{
  enabled: true,
  sampleRate: 0.25,        // deterministic per runId — a run is all-in or all-out
  sampleErrors: true,      // still emit a minimal run.failed for unsampled runs
  metadata: { app: 'billing-agent' },              // flat primitives, on every event
  // EVERY capture flag defaults to false:
  capture: { messages: false, outputText: false, reasoning: false, toolInputs: false,
             toolOutputs: false, errorMessages: false, providerMetadata: false },
  // Structural caps; overflow marks `truncated: true`. maxEventBytes: serializing sinks only.
  limits: { maxStringLength: 4096, maxArrayLength: 100, maxObjectDepth: 6,
            maxObjectKeys: 100, maxEventBytes: 65536 },
  redact: (value, ctx) => value,                   // runs BEFORE the built-in profile
}
```

Captured payloads always pass the built-in redaction profile (API keys, `Bearer`/JWT/PEM patterns, `password`/`cookie`/`token`-style keys → `[REDACTED]`) — and it runs **after** your custom `redact`, so a buggy redactor cannot reintroduce a secret. `composeObservers` merges options for event *production* (capture = OR, sampleRate = max, limits = min) but projects per child: a sink that opted into nothing receives counts and ids only, even when composed next to one capturing prompts. `error.message` is gated by `capture.errorMessages` the same way.

### JSONL and HTML on Node

`emit()` is synchronous; the JSONL sink queues writes internally (`maxQueueSize` default 10 000, overflow drops and counts in `droppedCount`), so a slow or failing disk can never affect a run. One event per line, every line valid JSON, `Uint8Array` payloads round-trip. **You own that file's security** — it contains whatever you opted into capturing.

```ts
import { createJsonlObserver, readJsonlEvents, writeRunReport } from '@deuz-sdk/core/observe/node';

export const observer = createJsonlObserver({
  file: '.deuz/runs.jsonl',
  flushEvery: 50,
  maxQueueSize: 20_000,
  onWriteError: (err) => console.error('observe sink failed', err),
});

export async function reportRun(runId: string): Promise<void> {
  await observer.flush();
  const events = await readJsonlEvents('.deuz/runs.jsonl');
  await writeRunReport({ events, runId, to: `reports/${runId}.html` });
}

export async function shutdown(): Promise<void> {
  await observer.close(); // drains the queue; later emits are dropped
}
```

A JSONL file usually holds many runs; one report renders one, so pass `runId` (default: the first run in the input).

## The OpenTelemetry bridge

Two entry points on `@deuz-sdk/core/otel`, both taking `OtelTracerOptions` (`{ tracer?, naming?: 'gen-ai' | 'deuz', captureContent? }`). **Attach one, not both** — both together double-spans a run.

| Entry | Wire to | Emits |
| --- | --- | --- |
| `createOtelTracer(options?)` | `deps.tracer` | Translates the existing bridge topology onto real spans. `captureContent` has no effect (the bridge carries no message content). |
| `createOtelObserver(options?)` | `deps.observer` | **Recommended.** Consumes the event protocol, so `gen_ai.usage.*` lands exactly once per model request: `invoke_agent` (run) → `chat {model}` (CLIENT) → `execute_tool {name}` (INTERNAL), plus `embeddings {model}`. Approvals, checkpoints and compaction become span events. |

`@opentelemetry/api` is an optional peer, imported lazily. When it is missing the run is untouched — spans are dropped silently (G2). `otelReady(target)` is how you find out: it resolves once spans flow and **rejects** with the actionable install error otherwise. Call it once at boot if you want to fail loudly. `captureContent: true` puts prompts and completions on spans double-redacted and bounded; leave it off unless you have decided your collector may hold user content. Under `naming: 'deuz'` the observer drives the legacy bridge instead (content capture unavailable there), which keeps dashboards pinned to the old span names working.

```ts
import { streamChat } from '@deuz-sdk/core';
import type { LanguageModel, StreamChatResult } from '@deuz-sdk/core';
import { createOtelObserver, otelReady } from '@deuz-sdk/core/otel';

declare const model: LanguageModel;

const observer = createOtelObserver({ captureContent: false });

export async function boot(): Promise<void> {
  await otelReady(observer); // rejects: "install @opentelemetry/api" — fail at boot, not in prod
}

export function ask(question: string): StreamChatResult {
  return streamChat({ model, prompt: question, deps: { observer } });
}
```

## Cost

The core never bills; it returns a token breakdown (`Usage`) and nothing else. `@deuz-sdk/core/pricing` is fully optional.

- `PRICES_2026` is a pinned `PriceTable` of 2026 list prices. **It is not authoritative** — list prices drift and enterprise/Vertex/Bedrock rates differ. Treat it as a starting point and override per deployment.
- `priceUsage(model, usage, table?)` → `number | undefined`. `undefined` for an unknown model — never a wrong charge, never a throw. Lookup is tolerant: exact slug, then a stripped date stamp / `vendor/` prefix, then the longest known prefix.
- Buckets: `inputTokens` → `input`; `outputTokens` **and** `reasoningTokens` → `output`; `cachedReadTokens` → `cachedRead` (default `0.1 × input`); `cacheWriteTokens` → `cacheWrite` (`1.25 × input`); `cacheWrite1hTokens` → `cacheWrite1h` (`2 × input`); `audioTokens` → `audio` (`input`). A row may carry `over200k` for long-context tiers. **`serverToolUses` is not priced** — provider-executed tools bill per call; add that yourself.
- `cacheSavings(model, usage, table?)` → what cache reads saved versus the full input rate. Cache *writes* are the investment side and are not netted.
- `createPriceProvider({ table?, margin? })` builds the `PriceProvider` for `deps.priceProvider`. `table` is shallow-merged per model over `PRICES_2026`; `margin` multiplies every result (default 1). It performs no I/O and reads no globals, so it is edge-safe, and it implements the optional `cacheSavings` seam out of the box.

Injecting `deps.priceProvider` also turns on two loop features: a canonical `cost` stream part (`{ type: 'cost', costUsd, deltaUsd?, cacheSavingsUsd?, stepIndex? }`, one after every step, `costUsd` cumulative across the whole run including durable resume legs) and the `budget` call option. A `budget` trip emits `{ type: 'budget-exceeded', kind: 'usd' | 'tokens', limit, value }` right before the terminal `finish`.

```ts
import { streamChat } from '@deuz-sdk/core';
import type { LanguageModel, ToolSet } from '@deuz-sdk/core';
import { createPriceProvider } from '@deuz-sdk/core/pricing';

declare const model: LanguageModel;
declare const tools: ToolSet;

const priceProvider = createPriceProvider();

export async function research(prompt: string): Promise<number> {
  const result = streamChat({
    model,
    prompt,
    tools,
    maxSteps: 20,
    budget: { usd: 0.5, tokens: 200_000 }, // either field alone works
    deps: { priceProvider },
  });

  let costUsd = 0;
  for await (const part of result.fullStream) {
    if (part.type === 'cost') costUsd = part.costUsd;
    if (part.type === 'budget-exceeded') {
      console.warn(`budget ${part.kind}: ${part.value} of ${part.limit}`);
    }
  }
  return costUsd;
}
```

Sharp edges:

- **`costExceeds(usd)` and `budget.usd` are inert without `deps.priceProvider`** — the loop logs one warning (through the no-op default logger, so you will not see it) and the condition never fires. `totalTokensExceed(n)` and `budget.tokens` read provider-reported usage and need nothing.
- **A budget stop does not change `finishReason`.** Read `result.providerMetadata?.deuz?.stoppedBy` — `'budget.usd'`, `'budget.tokens'`, or the condition name (`'costExceeds'`, `'totalTokensExceed'`, `'durationExceeds'`, `'stepCountIs'`, `'hasToolCall'`).
- Budgets are evaluated at **step boundaries**; an in-flight step always finishes. On a durable run they see the whole run's cumulative usage — a resume leg cannot reset the meter.
- A budget stop is not an error: the turn finishes cleanly with partial work and full history, so the natural UX is a "continue anyway" button that re-sends the same conversation with a raised budget.
- No `priceProvider`, or an unknown model → no `cost` parts and no errors. A throwing provider logs a warning and the part is skipped.
- `UsageMeta` carries no dollars, by design: `{ model, reason: 'finished' | 'aborted' | 'error', ttftMs?, agentPath? }`. Compute cost inside your own `onUsage`.

## Middleware

`wrapModel(model, middleware[])` returns a `WrappedModel` — `{ model, streamChat, generateText }` with the model pre-bound, so you pass call options without `model`. It is a thin client, **not** a `LanguageModel`: don't hand the object to something expecting a descriptor.

**Ordering rule: the first element is the outermost.** `transformParams` runs in array order (a → b → c → base) and the `wrap*` chain composes around the base function outward-in. So put `promptInjectionGuard()` first (its system message survives later transforms) and `redactPII()` before anything that inspects message content.

| Factory | Hooks | Behavior |
| --- | --- | --- |
| `logging({ logger?, label? })` | `transformParams`, `wrapGenerate` | `debug` on the way in, `info` with `finishReason`/`totalTokens` on the way out. **No console fallback** — no logger means no output. |
| `simpleCache({ ttlMs?, now?, keyFn? })` | `wrapGenerate` | In-memory cache for buffered calls; `ttlMs` default 300 000. Default key = provider, modelId, messages, temperature, maxOutputTokens, topP, responseFormat. **Streaming passes through unchanged.** |
| `redactPII()` | `transformParams` | Masks secret-looking substrings (`sk-`, `sk-ant-`, `AIza`, `Bearer`, known auth headers) in a deep copy. Best-effort hygiene, not a PII detector. |
| `promptInjectionGuard({ policy? })` | `transformParams` | Prepends a spotlighting system message. Deprecated in 2.0 in favour of `promptInjectionGuardrail()` (`@deuz-sdk/core/guardrails`), which applies the identical policy text once per run instead of on every model call. |
| `withFallback(models, { shouldFallback?, onFallback? })` | `wrapGenerate`, `wrapStream` | Cross-provider failover — see the next section. |

```ts
import { wrapModel, logging, promptInjectionGuard, redactPII, simpleCache } from '@deuz-sdk/core/middleware';
import type { LanguageModel, Logger } from '@deuz-sdk/core';

declare const model: LanguageModel;
declare const logger: Logger;

const m = wrapModel(model, [
  promptInjectionGuard(), // 1. guard system message
  redactPII(),            // 2. mask secrets
  logging({ logger }),    // 3. log — now safe, runs after redaction
  simpleCache({ ttlMs: 60_000 }), // 4. cache buffered results
]);

export async function summarize(input: string): Promise<string> {
  const { text } = await m.generateText({ prompt: `Summarize:\n${input}` });
  return text;
}
```

Writing your own: a `LanguageModelMiddleware` is a plain object with an optional `name` and any of `transformParams(options, ctx)` (rewrite and return the options; may be async — `wrapModel` defers async transforms into the lazy stream so G2 holds), `wrapGenerate(next, options, ctx)` (skip `next` to short-circuit, which is exactly how a cache hit works), and `wrapStream(next, options, ctx)` (observe or replace the returned `StreamChatResult`; never consume the stream inside the hook). `ctx` is `MiddlewareContext` — `{ operation: 'stream' | 'generate', model }`.

**Middleware vs guardrail** — they compose and neither replaces the other:

| | middleware (`@deuz-sdk/core/middleware`) | guardrail (`@deuz-sdk/core/guardrails`) |
| --- | --- | --- |
| Wraps | the **model** descriptor | the **run** |
| Applies | on every call through that model, including the SDK's own (compaction summaries, sub-agent turns) | once per run, at the loop boundary |
| Reports itself | not at all | a `guardrail` stream part + `providerMetadata.deuz.guardrails` |
| Can refuse a tool call or end a run | no | yes |

## Resilience

**Retry is pre-first-byte only.** A connect failure or non-2xx handshake retries; once the stream has emitted a delta, an error is final — a transparent retry would replay tokens the consumer already saw.

| Aspect | Behavior |
| --- | --- |
| Budget | `maxRetries` on any call, default **2** |
| Backoff | full jitter, `random() * min(30_000, 500 * 2^attempt)`; the random unit is hashed from `deps.generateId()`, never `Math.random()` |
| `Retry-After` | takes precedence over computed backoff, still capped at 30s; also readable as `err.retryAfterMs` |
| Which errors | only those whose `isRetryable` is true: `RateLimitError` (429), `OverloadedError` (529), generic 5xx `APICallError`. Never `AuthenticationError`, `InvalidRequestError`, `ModelNotFoundError`, `ContextOverflowError`, `TimeoutError`, `AbortError` |
| Waiting | scheduled through `deps.clock.setTimeout`, so a user abort during backoff rejects immediately |

**Timeouts** come from the per-call `timeout` option — a bare number is shorthand for `{ totalMs }`. Every timer runs on `deps.clock`, never `AbortSignal.timeout`.

| Layer | Scope | Default |
| --- | --- | --- |
| `ttftMs` | one model call, up to the first content byte; cleared by the first delta | 60 000 |
| `totalMs` | one model call, end to end | 300 000 |
| `stepMs` | one agentic step: the model call **plus** the tools it triggered | unbounded |
| `toolMs` | one tool `execute` (`Tool.timeoutMs` overrides it per tool) | unbounded |

An explicit `0` disables a layer — that is how you drop the 300s ceiling a 25s serverless budget makes meaningless. Your own `signal` merges with all of them; the tightest bound wins. A fired timer produces a `TimeoutError` whose `layer` is `'connect' | 'ttft' | 'total' | 'step' | 'tool'` — a genuine failure, never retried. A **user abort is not a failure**: `finishReason` resolves to `'aborted'` and `usage` resolves with partial counts, with no `error` part.

**Cross-provider failover.** Because the whole conversation is canonical, the next candidate receives the identical request. Two equivalent surfaces: the `fallbackModels` call option, or the `withFallback` middleware (which additionally gives you `shouldFallback` and `onFallback`). Streaming hops only **pre-first-content**; buffered calls hop on any fallback-worthy rejection. What hops by default: `BreakerOpenError`, `NetworkError`, transport-layer `TimeoutError` (not `'step'`/`'tool'`, which are caller budgets), and retryable/5xx `APICallError`. Client errors never hop — they would fail identically everywhere. Each candidate keeps its own retry budget; failover engages after a candidate's final failure. The winner carries `providerMetadata.deuz.failedOver = { from, to, reason }`.

> **`consume()` is `undefined` on the `fallbackModels` and `withFallback` paths.** Always call it as `result.consume?.()`. On a serverless runtime that means terminal effects (chat persistence, checkpoints, `onFinish`, memory extraction) do not run on those paths unless you drain `fullStream` yourself in the `after` / `waitUntil` callback.

**The circuit breaker** runs per `provider:model` in `deps.breakerStore`. Five consecutive countable failures open it for 30s; while open, calls fail immediately — before any network request — with `BreakerOpenError` (`code: 'breaker_open'`, carrying `provider`, `modelId`, `cooldownUntil`). Only provider-health failures count (network, timeout, 5xx/overload/retryable); 4xx client errors and a `BreakerOpenError` itself never do, and failures the retry budget absorbs don't either. The first byte of any response resets the counter to 0. After `cooldownUntil` the next call goes through as a half-open probe. A throwing `breakerStore` is ignored, never fatal. This is the breaker/failover synergy: an open breaker fails fast, so the hop is instant.

```ts
import { streamChat, BreakerOpenError, TimeoutError } from '@deuz-sdk/core';
import type { LanguageModel } from '@deuz-sdk/core';

declare const primary: LanguageModel;
declare const backup: LanguageModel;

export async function ask(prompt: string): Promise<string> {
  const result = streamChat({
    model: primary,
    prompt,
    maxRetries: 4,
    timeout: { ttftMs: 15_000, totalMs: 60_000 },
    fallbackModels: [backup], // capability profiles must cover the call
  });

  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text;
    if (part.type === 'error') {
      if (part.error instanceof BreakerOpenError) {
        console.warn('breaker open until', part.error.cooldownUntil);
      } else if (part.error instanceof TimeoutError) {
        console.warn('timed out at layer', part.error.layer);
      }
    }
  }
  return text;
}
```

Honest caveats: pick fallbacks whose capabilities cover the call (a tool-heavy call falling back to a model without tool support fails on the fallback too), and remember cost is priced against the model that actually ran, not the primary you asked for.

## Wire a real logger

**The default `deps.logger` is a no-op, and it sees everything the result field does plus one thing it does not.** All four chat calls populate `warnings` — a promise on the streaming pair, a plain array with the key omitted when empty on the buffered pair — and both loops thread one sink through every step, so `unknown-model`, `unsupported-setting`, a dropped hosted tool and a dropped document all reach the outer result. The exception is the buffered loop's `activeTools` notices, which reach the log only. Without a logger these are silent:

- an unknown model slug silently capped at `maxOutput: 4096` (check with `getModelCapabilities(model)`; `caps.known === false` means the fallback row);
- `costExceeds` / `budget.usd` inert because no `priceProvider` was injected;
- the circuit breaker opening, a throwing `priceProvider` skipping a `cost` part, `falseFinishGuard` set without `doneWhen`.

`CallWarning.type` is an **open** union with `'other'` as the escape hatch — do not switch on it exhaustively.

## Deep dive

- [/docs/modules/observability](/docs/modules/observability) — observers, capture, composition, the tracer bridge and `tracerMode`.
- [/docs/reference/observe-events](/docs/reference/observe-events) — the full event catalog, `ObservedError`, canonical orderings.
- [/docs/modules/pricing](/docs/modules/pricing) — `Usage` anatomy, `onUsage`, the price table, the live cost stream and the budget guardrail.
- [/docs/modules/middleware](/docs/modules/middleware) — `wrapModel`, the hook interface, every bundled layer, writing your own.
- [/docs/advanced/resilience](/docs/advanced/resilience) — retry policy, timeout layers, the circuit breaker, cross-provider failover.
- [/docs/core/prompts-and-timeouts](/docs/core/prompts-and-timeouts) — the `timeout` option's four scopes in prose.
- [/docs/core/dependencies](/docs/core/dependencies) — the whole `Dependencies` seam, `createClient`, G10/G11.
- [/docs/core/errors](/docs/core/errors) — the `DeuzError` taxonomy, `isRetryable`, `retryAfterMs`.
- [/docs/agents/guardrails](/docs/agents/guardrails) — run-level pass/block/rewrite hooks and the guardrail twin of `promptInjectionGuard`.
