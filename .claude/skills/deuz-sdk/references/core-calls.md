<!-- verified: 2026-09-20 against @deuz-sdk/core@2.1.0 · api-contract sha256:c301da6ab500
     sources: packages/core/src/types/config.ts, packages/core/src/types/methods.ts,
     packages/core/src/types/stream.ts, packages/core/src/types/message.ts,
     packages/core/src/types/deps.ts, packages/core/src/types/model.ts,
     packages/core/src/types/usage.ts, packages/core/src/errors.ts, packages/core/src/parts.ts,
     packages/core/src/client.ts, packages/core/src/generate.ts,
     packages/core/src/inference/stream-chat.ts, packages/core/src/inference/object-shared.ts,
     packages/core/src/core/registry.ts, docs/content/docs/core/*.mdx,
     skills/deuz-sdk/rules/streaming-ui.md, skills/deuz-sdk/rules/pitfalls.md -->

# The six call functions

**Load when:** writing any call into a model — streaming text to a user, one-shot generation, structured/JSON extraction, embeddings — or when you need the `StreamPart` union, the `Message`/`Part` model, the error taxonomy, timeouts/aborts, or `createClient` and the `Dependencies` seam.

## The six, at a glance

| Function | Returns | Failure channel | Runs the agentic loop? | `warnings` |
| --- | --- | --- | --- | --- |
| `streamChat` | `StreamChatResult` **synchronously** | `error` part + rejected `usage`/`finishReason` | yes, when routed (below) | `Promise<CallWarning[]>` |
| `generateText` | `Promise<GenerateTextResult>` | rejected promise | yes, when routed | `CallWarning[]`, omitted if empty |
| `generateObject` | `Promise<GenerateObjectResult<T>>` | rejected promise | never — refuses loop options | `CallWarning[]`, omitted if empty |
| `streamObject` | `StreamObjectResult<T>` **synchronously** | rejected stream + promises | never — refuses loop options | `Promise<CallWarning[]>` |
| `embed` | `Promise<EmbedResult>` | rejected promise | n/a | — |
| `embedMany` | `Promise<EmbedManyResult>` | rejected promise | n/a | — |

All four chat calls share `CommonCallOptions` (`packages/core/src/types/config.ts`). There is no client object to construct; `createClient` only pre-binds config.

**Loop routing.** `streamChat`/`generateText` dispatch into the agentic loop when *any* of `tools` (non-empty), `chat`, `memory`, `verifyStep`, `doneWhen`, `guardrails`, or `mcp` (non-empty) is present. Otherwise it is one request. `maxSteps` defaults to **1**, so tools are requested but never executed-and-fed-back until you raise it.

## `streamChat`

```ts no-verify
function streamChat(options: StreamChatOptions): StreamChatResult;

interface StreamChatResult {
  textStream: AsyncIterable<string>;      // text-delta parts only
  fullStream: AsyncIterable<StreamPart>;  // the canonical event stream
  usage: Promise<Usage>;
  finishReason: Promise<FinishReason>;
  consume?: (options?: { onError?: (error: unknown) => void }) => Promise<void>;
  warnings?: Promise<CallWarning[]>;
  runId?: string;                          // only with `session`
  observation?: { settled: Promise<void> };// only with an observer/tracer
  memory?: Promise<MemoryMutation[]>;      // only with `memory` extraction
}
```

**G2 — it returns synchronously and never throws.** The call body resolves no key, opens no socket, reads no clock. Do not `await` it and do not make your wrapper `async`. A `try`/`catch` around the *call* catches nothing; put it around the `for await`.

**Lazy pump, one broadcaster.** The request starts on first access of `textStream`, `fullStream`, `usage`, `finishReason` or `warnings`. Reading `result.consume` does **not** start it (it is a method, not a getter). All outputs are branches of a single pump fanned out by a broadcaster, with subscriptions registered before the pump starts — so `await result.usage` first and iterate later without losing a chunk. Each branch buffers independently: a branch you never drain holds its queue until the end, so do not open `fullStream` "just in case" when you only render text.

**Nobody reading = nothing finishes.** No consumer means no request, no `onFinish`, no `chat` persistence, no `session` checkpoint, no memory extraction. `consume()` drains it: memoized, takes its own subscription (safe alongside iteration), **never rejects** — failures go to `consume({ onError })`. Always call it with `?.` — it is absent on the `fallbackModels` / `withFallback` paths and on hand-written result objects.

```ts
import { streamChat } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

// Next.js `after` / Workers `ctx.waitUntil` — anything that outlives the response.
declare function after(work: () => unknown): void;

export async function POST(req: Request): Promise<Response> {
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

  const result = streamChat({
    model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8'),
    instructions: 'You are a helpful assistant.',
    messages: parsed.request.messages,
    signal: req.signal, // forwards the client disconnect
  });
  const response = toDeuzStreamResponse(result);
  after(() => result.consume?.()); // terminal effects run even if the client disconnects
  return response;
}
```

`StreamChatResult` has **no `response.messages`** — reconstruct the turns from the stream, or let the `chat` layer persist them. `generateText` does return them.

### Timeouts, abort, retry

`timeout` is `number | { totalMs?, ttftMs?, stepMs?, toolMs? }`; a bare number means `{ totalMs }`. Only the layers you set are overridden; an explicit `0` **disables** a layer. Every timer is scheduled through `deps.clock`, never an ambient host timer.

| Layer | Scope | Default | Cleared by |
| --- | --- | --- | --- |
| `ttftMs` | one model call — time to the first content byte | `60_000` | the first `text-delta`, `reasoning-delta` **or** `tool-call-delta` |
| `totalMs` | one model call — whole response | `300_000` | the call completing |
| `stepMs` | one agentic step: the model call **plus** the tools it triggered | unbounded | the step ending |
| `toolMs` | one tool `execute` (per call, not per step); `Tool.timeoutMs` overrides per tool | unbounded | the execution returning |

A `stepMs` expiry cannot abort tools already running — that is `toolMs`. A tool timeout is self-healing: the execution is abandoned and the model gets an `is_error` `tool_result`, so nothing throws out of the call (it does count toward the runaway-tool guard).

**Abort is not a timeout.** A user abort via `signal` resolves `finishReason: 'aborted'` with partial `usage`, no `error` part, `onUsage` with `meta.reason === 'aborted'`. A timeout is a **failure**: a `TimeoutError` `error` part and rejected promises. `abortSignal` is a deprecated alias for `signal`; if both are set, `signal` wins.

**Retry is pre-first-byte only.** `maxRetries` defaults to `2`, exponential backoff with full jitter (base 500ms, cap 30s), `Retry-After` honoured. Retryable = `NetworkError`, `RateLimitError`, `OverloadedError`, `APICallError` with status ≥ 500. Once a byte is out, a mid-stream failure is final — and so is cross-model fail-over.

**Warnings.** In 2.0 all four chat calls populate `warnings`; on the streaming pair it is a promise that settles with `usage` and **never rejects**, and each notice also arrives on `fullStream` as a `warning` part *ahead of* the model's output. Deduped by `(type, setting, message)`, capped at 50. Producers: `unknown-model` (unregistered slug → conservative fallback row), `unsupported-setting` (`temperature`/`topP`/`effort` a wire strips), `unsupported-tool`, `other` (a dropped document). `CallWarning.type` is an **open** union — never switch exhaustively. Every notice is also exactly one `deps.logger.warn` line, and **the default logger is a no-op**. One gap: the buffered loop's `activeTools` notices are logged but never recorded, so a typo'd name reaches the log and not `GenerateTextResult.warnings` (`tool-loop.ts` calls `filterWireTools` and `applyPrepareStep` without the sink); the streaming loop records them. `clamped-setting` has no producer at all.

## `generateText`

Same orchestration, buffered. Errors **reject** — a promise already has a failure channel.

`prompt` vs `messages` vs `instructions`:

- `prompt: string` is shorthand for exactly one user turn. **Mutually exclusive** with `messages`; passing both (or neither) is an `InvalidRequestError` before any request — a rejection on `generateText`/`generateObject`, an `error` part on `streamChat`/`streamObject`. One exception: `messages: []` alongside `prompt` is *not* "both", so wrappers that always spread a full bag keep working.
- `instructions: string` is the system prompt. It is placed **first** and kept structurally apart from history, so an injected `role: 'system'` turn in attacker-supplied `messages` cannot reorder or overwrite it (a `system` message already in `messages` is preserved *after* it). The fold is idempotent — persisting the folded history and passing the same `instructions` again does not stack it. There is no `system` option name.

```ts
import { generateText } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const { text, usage, finishReason, response } = await generateText({
  model: anthropic('claude-opus-4-8'),
  instructions: 'You are terse.',
  prompt: 'Name three primary colors.',
});
// response.messages holds ONLY the new turns — append, never mutate the input array.
console.log(text, finishReason, usage.totalTokens, response.messages.length);
```

`GenerateTextResult`: `text`, `usage`, `finishReason`, `response.messages` always; `steps` / `toolCalls` / `toolResults` only with tools (`steps === undefined` is how you tell a single-turn result apart); `pendingApprovals` on a client-mode approval break; `providerMetadata.deuz` for `stoppedBy` / `verified` / `guardrails` / `handoffs`; `runId` with `session`; `memory`, `observation`, `warnings` as above. `usage.totalTokens` is the provider's own total where one exists, not `inputTokens + outputTokens`.

## `generateObject` and `streamObject`

Both take `GenerateObjectOptions<T>` = `CommonCallOptions` plus `schema`, `schemaName`, `schemaDescription`, `mode`. `schema` accepts a zod / Standard Schema instance (`T` inferred) or a raw `JSONSchema` (supply `T` yourself). Standard Schema needs the optional peer `@standard-community/standard-json` to reach JSON Schema; raw JSON Schema needs no peer and is not re-validated after parsing.

`schemaName` is the tool name in tool mode / the schema name in json mode; `schemaDescription` is a human description passed to the provider. Both are worth setting — they are prompt surface the model actually reads.

| `mode` | Strategy |
| --- | --- |
| `'auto'` (default) | `json` when the resolved capability row says `structuredOutput: true`, else `tool` |
| `'json'` | native json mode (`json_schema` / `output_config` / `responseSchema`) |
| `'tool'` | a forced tool call whose arguments are the object |

**G3:** Anthropic rejects a forced `tool_choice` while extended thinking is on, so a would-be `tool` strategy is auto-overridden to `json` there — when `effort` is set to anything but `'none'`, and unconditionally on adaptive-thinking flagships (`effortWire: 'output_config'`). Do not set `mode` for this yourself.

**Repair retry.** `generateObject` makes at most **two** attempts — the initial call plus one repair — when the payload fails `JSON.parse` or Standard Schema validation; both failing throws `NoObjectGeneratedError` (`.text` is the raw model output, `.cause` the last parse error). A hard transport error is thrown immediately, unwrapped. **`streamObject` has NO repair retry** — partials were already emitted and cannot be un-streamed. On a bad final payload its `object` rejects with `NoObjectGeneratedError` and `partialObjectStream` rejects, while `usage` and `finishReason` still **resolve** (the tokens were spent).

**They refuse loop options.** These are single-turn by construction, so passing any of `tools`, `toolChoice`, `maxSteps > 1`, `stopWhen`, `budget`, `maxToolConcurrency`, `onStepFinish`, `prepareStep`, `activeTools`, `verifyStep`, `maxVerifyAttempts`, `doneWhen`, `falseFinishGuard`, `compaction`, `approveToolCall`, `approvalResponses`, `session`, `chat`, `memory`, `fallbackModels`, `approvalSigner`, `approvalMaxAgeMs`, `mcp` or `guardrails` is an `InvalidRequestError` **before any network request**. Empty collections, `tools: {}` and `maxSteps: 1` pass. Honoured normally: `signal`, `maxRetries`, `timeout`, `capabilities`, `headers`, `deps`, `onUsage`, `onFinish`, sampling params, `effort`, `responseFormat`, `providerOptions`, `promptCaching`, `runtimeContext`, `agentPath`. To combine tools with structure, use the optional native `runAgent({ tools, output })` described in `references/native-execution.md`, or retain the two-call `generateText` then `generateObject` composition.

```ts
import { generateObject, streamObject, NoObjectGeneratedError } from '@deuz-sdk/core';
import { createOpenAI } from '@deuz-sdk/core/openai';
import { z } from 'zod';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const Invoice = z.object({ vendor: z.string(), total: z.number(), dueDate: z.string() });

const { object } = await generateObject({
  model: openai('gpt-5.2'),
  schema: Invoice,
  schemaName: 'invoice',
  schemaDescription: 'One invoice header extracted from raw text.',
  prompt: 'ACME Corp, $1,240.00, due 2026-09-01',
});
console.log(object.vendor, object.total);

// Each element is a DeepPartial<T>: every field optional at every depth, strings
// arrive truncated, and a value is emitted only when the parsed object changes.
const stream = streamObject({ model: openai('gpt-5.2'), schema: Invoice, prompt: '…' });
try {
  for await (const partial of stream.partialObjectStream) console.log(partial.vendor);
  console.log(await stream.object);
} catch (err) {
  if (err instanceof NoObjectGeneratedError) console.error('raw payload:', err.text);
}
```

Under the `tool` strategy `partialObjectStream` cannot stream argument fragments usefully, so it **buffers** and emits exactly one element — the final validated object. Serve it to a browser with `toDeuzObjectStreamResponse` (`@deuz-sdk/core/ui`) and read it with `useObject`.

## `embed` / `embedMany`

`EmbeddingModel` is a **deliberately distinct kind** from `LanguageModel` (`{ provider, modelId, surface }` where `surface` is `'openai-embeddings' | 'gemini-embeddings' | 'voyage-embeddings'`). The type system rejects an embedding model in `streamChat`/`generateText` and a chat model in `embed` — do not cast around it; the wire shapes are unrelated.

`embedMany` preserves order (`embeddings[i]` ↔ `values[i]`), splits into `maxBatchSize` sub-batches (default: the registry's per-model batch limit) and runs them with `maxConcurrency` (default 5), summing usage. `embed` is implemented on top of it. Other options: `taskType` (`'search_document'` at index time, `'search_query'` at query time — OpenAI ignores it), `dimensions` (Matryoshka truncation; pair with `normalize: true`), `title` (Gemini `RETRIEVAL_DOCUMENT` only), `signal`, `maxRetries`, `headers`, `deps`, `onUsage` (fires once per call). Empty `values` makes no request and still fires `onUsage`. For embeddings `outputTokens` is always `0`.

```ts
import { embed, embedMany } from '@deuz-sdk/core';
import { createOpenAIEmbedding } from '@deuz-sdk/core/openai';

const embeddings = createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY! });
const model = embeddings('text-embedding-3-small');

// Index time and query time use MATCHING but different task hints.
const docs = await embedMany({ model, values: ['first chunk', 'second'], taskType: 'search_document' });
const query = await embed({ model, value: 'what is deuz?', taskType: 'search_query' });
console.log(docs.embeddings.length, query.embedding.length, query.usage.inputTokens);
```

## The canonical `StreamPart` union

`fullStream` is an **open** discriminated union: new members are added additively, so a switch **must** keep a `default` case or a future release breaks it. Everything a provider sends is normalized into this before anything else touches it — never pipe a provider's raw SSE to a caller.

| `type` | Fields | What it means to a consumer |
| --- | --- | --- |
| `text-delta` | `text` | Assistant text fragment — the only thing `textStream` yields. |
| `reasoning-delta` | `text`, `signature?`, `encrypted?` | Thinking fragment. When `encrypted`, `text` is an opaque payload — do not render it. |
| `tool-call-delta` | `id`, `name?`, `argsTextDelta`, `providerMetadata?` | Raw args JSON fragment. Accumulate as a **string**, parse once at block end. |
| `source` | `id`, `url?`, `title?` | Grounding source from a provider-executed search. |
| `finish` | `usage`, `finishReason`, `providerMetadata?` | Terminal. In a loop `usage` is summed across steps; `providerMetadata.deuz.stoppedBy` names a budget/stop-condition end. |
| `error` | `error` | Failure. The stream ends after it; `usage`/`finishReason` reject. |
| `step-start` | `stepIndex` | Loop step began — normally the first part of any loop run. |
| `step-finish` | `stepIndex`, `finishReason`, `usage` | That step's usage alone. |
| `tool-call` | `toolCallId`, `toolName`, `input` | Final parsed call, after the deltas complete. |
| `tool-result` | `toolCallId`, `toolName`, `output`, `isError?` | Execution result. A thrown tool arrives here with `isError`, not as a stream failure. |
| `tool-state` | `toolCallId`, `toolName?`, `state`, `denied?`, `deniedReason?` | Lifecycle: `input-streaming`→`input-complete`→`awaiting-approval`→`executing`→`complete`\|`error`. A refusal is `state: 'error'` **and** `denied: true`, not a 7th state. |
| `tool-approval-request` | `approvalId`, `toolCallId`, `toolName`, `input`, `agentPath?`, `token?` | A gated call; the loop breaks after emitting these. Resume with `approvalResponses`. |
| `compaction` | `layer`, `tokensBefore`, `tokensAfter`, `trigger?` | Automatic compaction ran before a step. Token counts are estimates; `trigger` is `'threshold' \| 'manual' \| 'overflow'`. |
| `sub-agent` | `agentPath`, `part` | A sub-agent's own canonical part, forwarded live. **Single-wrapped** — depth 2 is `agentPath.length === 2`, never a nested `sub-agent`. |
| `handoff` | `from?`, `to`, `toolCallId`, `reason?`, `stepIndex` | The run transferred to another agent; prompt, tools and model become the target's. |
| `guardrail` | `hook`, `action`, `name?`, `reason?`, `toolCallId?`, `stepIndex?` | One part per **non-pass** verdict (`block`/`rewrite`). Passes emit nothing. |
| `data` | `name`, `payload` | App-defined typed data you wrote into the stream. |
| `citation` | `id`, `sourceId?`, `url?`, `title?`, `snippet?`, `chunkIndex?`, `score?` | RAG provenance for a retrieved chunk. |
| `cost` | `costUsd`, `deltaUsd?`, `cacheSavingsUsd?`, `stepIndex?` | Live cumulative USD. Requires `deps.priceProvider`; absent without one. |
| `budget-exceeded` | `kind`, `limit`, `value` | The `budget` ceiling tripped. Always precedes the terminal `finish`. |
| `verify` | `stepIndex`, `attempt`, `ok`, `willRetry`, `feedback?` | A `verifyStep` verdict. |
| `false-finish` | `stepIndex`, `attempt`, `willRetry` | `doneWhen` rejected a natural completion. Streaming loop only. |
| `plan-update` | `goal?`, `tasks` | Live plan snapshot for a to-do panel. |
| `activity` | `message`, `level?`, `data?`, `agentPath?` | "Computer" feed line from an autonomous run. |
| `warning` | `warning` | Non-fatal notice. Never ends the stream, never replaces a delta. |

`step-*`, `tool-call`, `tool-result`, `tool-state` and `tool-approval-request` appear only on loop-routed runs.

```ts
import { streamChat, DeuzError } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const result = streamChat({ model: anthropic('claude-opus-4-8'), prompt: 'Think, then answer: 2+2?' });

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-delta':
      process.stdout.write(part.text);
      break;
    case 'reasoning-delta':
      if (!part.encrypted) process.stdout.write(part.text); // encrypted = opaque, not display text
      break;
    case 'error':
      if (part.error instanceof DeuzError) console.error(part.error.code, part.error.message);
      break;
    case 'finish':
      console.log(part.finishReason, part.usage.totalTokens);
      break;
    default:
      break; // REQUIRED — the union is open
  }
}
```

## Messages, parts, and binary media

`Message` is `{ role, content, providerMetadata? }` where `role` is `'system' | 'user' | 'assistant' | 'tool'` and `content` is a `string` (coerced to one `TextPart`) or a `Part[]`. All `system` messages are concatenated and lifted to the wire's system slot; a `tool`-role message is folded into a user turn on wires without a tool role.

`Part` is a five-member locked union — keep a `default` branch when you switch on it:

| `type` | Fields | Direction |
| --- | --- | --- |
| `text` | `text` | in / out |
| `image` | `image: string \| Uint8Array`, `mediaType?` | in — **also the carrier for every non-image file** |
| `reasoning` | `text`, `signature?`, `encrypted?`, `redacted?` | out, replayed back in |
| `tool_use` | `id`, `name`, `input`, `providerMetadata?` | out, replayed back in |
| `tool_result` | `toolUseId`, `result`, `isError?` | in |

There is **no `file` part kind**. A PDF, audio or video is an `image` part with a non-`image/*` `mediaType`, which each adapter maps to that wire's document block (Anthropic `document`, OpenAI Responses `input_file`, Chat Completions `file`, Gemini `inlineData`/`fileData`). Use the constructors rather than remembering that: `filePart({ data, mediaType })` (mediaType **required**) and `imagePart({ data, mediaType? })`. `data` may be raw bytes, base64, a `data:` URL or an `https:` URL.

```ts
import { generateText, filePart, imagePart } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
declare const pdfBytes: Uint8Array;

const { text } = await generateText({
  model: anthropic('claude-opus-4-8'),
  messages: [
    {
      role: 'user',
      // Media FIRST, the question after it — the order every provider's docs recommend.
      content: [
        filePart({ data: pdfBytes, mediaType: 'application/pdf' }),
        imagePart({ data: 'https://example.com/chart.png' }),
        { type: 'text', text: 'Summarise the report and describe the chart.' },
      ],
    },
  ],
});
console.log(text);
```

Documents are gated on the resolved capability row (`nativePdf || vision`). A model that fails the gate has the part **dropped** with a `deps.logger.warn` (and a `warning`) — a message can carry fewer blocks than parts. An unknown slug takes the conservative fallback row, which is not vision-capable, so fix it with a per-call `capabilities` override. Chat Completions additionally drops an `https:`-URL document: pass bytes or base64 there. `reasoning` parts must round-trip in a multi-step loop (Anthropic `signature`, Gemini `thoughtSignature` on `tool_use.providerMetadata`, OpenAI encrypted reasoning) — the loop preserves them for you; never strip `providerMetadata`.

## The `DeuzError` taxonomy

Every error extends the abstract `DeuzError` and carries a stable string `code`. HTTP-shaped ones also extend `APICallError` and carry `statusCode`, `isRetryable`, `retryAfterMs`, `provider`, `requestId`, `upstreamType`.

| Class | `code` | Thrown when | SDK retries it |
| --- | --- | --- | --- |
| `APICallError` | `api_call_error` | any non-2xx (base class; used directly for generic 5xx) | when status ≥ 500 |
| `NetworkError` | `network_error` | DNS/TLS/transport died before an HTTP response (`statusCode: 0`) | ✅ |
| `RateLimitError` | `rate_limit` | 429 — read `retryAfterMs` and back off at your layer too | ✅ |
| `OverloadedError` | `overloaded` | 529 — provider capacity; the classic `fallbackModels` case | ✅ |
| `AuthenticationError` | `authentication` | 401/403, **and when no key resolved at all** | ❌ |
| `InvalidRequestError` | `invalid_request` | 400/422/413, plus SDK-side guards (`prompt`+`messages`, loop options on an object call) | ❌ |
| `ModelNotFoundError` | `model_not_found` | 404 — wrong slug/region/deployment | ❌ |
| `ContextOverflowError` | `context_overflow` | history too long; inside the loop it self-heals once per step by force-compacting | ❌ |
| `TimeoutError` | `timeout` | a `timeout` layer expired; `layer` is `'connect'\|'ttft'\|'total'\|'step'\|'tool'` | ❌ never |
| `AbortError` | `aborted` | caller cancellation; in a stream you normally see `finishReason: 'aborted'` instead | ❌ never |
| `NoObjectGeneratedError` | `no_object_generated` | `generateObject` after its repair, or `streamObject` on final validation; `.text` is the raw output | ❌ |
| `UnsupportedCapabilityError` | `unsupported_capability` | a model lacks the requested capability — **before** any network call | ❌ |
| `BreakerOpenError` | `breaker_open` | the per-`provider:modelId` circuit breaker is open (5 consecutive health failures, 30s cooldown); `cooldownUntil` is a `deps.clock.now()` stamp | ❌ — fail over instead |
| `McpAuthorizationRequiredError` | `mcp_authorization_required` | an MCP server needs OAuth; step one of a flow, not a dead end | ❌ |
| `ToolExecutionError` | `tool_execution` | a tool `execute` threw — **constructed but not thrown** by the loop; it becomes an `is_error` `tool_result` | ❌ |

Prefer `isDeuzError(value)` (a `Symbol.for` brand check) over `instanceof DeuzError` at package boundaries — `instanceof` breaks across duplicate copies and realms. Use `instanceof` for the *specific* subclasses when you need their fields. `err.toJSON()` is the secret-free projection (`name`, `code`, `message`, plus an allowlist of scalar details); `cause` and raw headers are never carried, so logging a `DeuzError` verbatim is safe.

```ts
import { generateText, isDeuzError, RateLimitError, BreakerOpenError, APICallError } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

try {
  await generateText({ model: anthropic('claude-opus-4-8'), prompt: 'hello' });
} catch (err) {
  if (err instanceof RateLimitError) console.log('retry after ms:', err.retryAfterMs);
  else if (err instanceof BreakerOpenError) console.log('failing fast until', err.cooldownUntil);
  else if (err instanceof APICallError) console.error(err.provider, err.statusCode, err.requestId);
  else if (isDeuzError(err)) console.error(err.toJSON()); // secret-free, safe to log
  else throw err;
}
```

## `createClient` and the `Dependencies` seam

Core is pure: it reads **no** environment variable and touches no global you cannot override. Everything stateful or non-deterministic is injected through one optional-per-field `Dependencies` bag, available per call as `deps` and merged from the client.

| Field | Type | Default | Why you would set it |
| --- | --- | --- | --- |
| `fetch` | `typeof fetch` | bound `globalThis.fetch` | proxy, gateway, request logging, test transport |
| `clock` | `Clock` (`now()`, `setTimeout(fn, ms) => cancel`) | host time + timers | deterministic timeouts and backoff in tests |
| `logger` | `Logger` (`debug/info/warn/error`) | **no-op** | the complete channel for warnings and dropped documents — wire one or you see nothing |
| `tracer` | `Tracer` (+ `tracerMode`) | no-op | OTel-shaped spans; bridge with `@deuz-sdk/core/otel` |
| `breakerStore` | `BreakerStore` | in-memory `Map`, resolved **once per client** | share breaker state across processes |
| `keyProvider` | `KeyProvider` (`getKey(provider)`) | unset | highest-priority key source; async/rotating/per-tenant |
| `priceProvider` | `PriceProvider` | unset | USD cost: enables `cost` parts and `costExceeds`/`budget.usd` |
| `generateId` | `() => string` | `crypto.randomUUID()` | stable ids **and** deterministic retry jitter |
| `observer` | `Observer` | unset (absence is the fast path) | local-first observation events |
| `onUsage` / `onFinish` | callbacks | unset | metering; a call-level option **overrides** the deps one — they never both fire |
| `mcpPool` | `McpConnectionPool` | unset | reuse MCP connections across calls |

`resolveDependencies(bag)` applies the defaults and returns a `ResolvedDependencies` with `fetch`/`clock`/`logger`/`tracer`/`breakerStore`/`generateId` non-optional.

**G1 key precedence**, first non-empty wins, else `AuthenticationError`: `deps.keyProvider.getKey(provider)` → factory `apiKey` → `createClient({ apiKeys })`. Base URL: factory `baseURL` → `createClient({ baseUrls })` → the wire default. Factory `fetch` beats `deps.fetch`; call-level `headers` beat factory headers. Client keys are the lowest link *on purpose* — do not "fix" it by wrapping them in a `keyProvider`.

`createClient(config?)` returns a frozen-config `DeuzClient` with `streamChat`, `generateText`, `generateObject`, `streamObject`, `embed`, `embedMany`, and `bind(options)` — which threads the client's keys/baseUrls/deps onto the options of a free function the client has no method for (`generateSpeech`, `transcribe`, `generateImage`, …). It performs no I/O on construction and is edge-safe. Per-call `deps` are shallow-merged over the client's.

```ts
import { createClient } from '@deuz-sdk/core';
import { createPriceProvider } from '@deuz-sdk/core/pricing';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import type { KeyProvider, Logger } from '@deuz-sdk/core';

// The default logger is a NO-OP; without one you never see a warning or a dropped document.
const logger: Logger = { debug() {}, info() {}, warn: console.warn, error: console.error };
const keyProvider: KeyProvider = {
  getKey: async (p) => (p === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined),
};
export const deuz = createClient({
  apiKeys: { openai: process.env.OPENAI_API_KEY }, // lowest-priority source
  deps: {
    keyProvider, // highest — wins for 'anthropic'
    logger,
    priceProvider: createPriceProvider(), // enables `cost` parts and budget.usd
    onUsage: (usage, meta) => console.log(meta.model, usage.totalTokens, meta.reason),
  },
});

export const anthropic = createAnthropic(); // no apiKey — the client supplies the chain
const result = deuz.streamChat({ model: anthropic('claude-opus-4-8'), prompt: 'Hi' });
void result.consume?.();
```

## Deep dive

- [/docs/core/stream-chat](/docs/core/stream-chat) — the streaming entry point, `consume()`, the broadcaster, the full `StreamPart` table.
- [/docs/core/generate-text](/docs/core/generate-text) — the buffered call, `StepResult` anatomy, stop conditions.
- [/docs/core/generate-object](/docs/core/generate-object) — schema input, strategy selection, the repair retry, Gemini schema conversion.
- [/docs/core/stream-object](/docs/core/stream-object) — partial objects, the missing repair retry, the tool-strategy buffering.
- [/docs/core/prompts-and-timeouts](/docs/core/prompts-and-timeouts) — `prompt`, `instructions`, the four timeout layers, `capabilities`.
- [/docs/core/messages](/docs/core/messages) — roles, the `Part` union, vision inputs, reasoning round-trips.
- [/docs/core/files](/docs/core/files) — `filePart()` / `imagePart()` and how each wire carries a document.
- [/docs/core/errors](/docs/core/errors) — the full taxonomy, retry interplay, the circuit breaker, secret redaction.
- [/docs/core/embeddings](/docs/core/embeddings) — providers, `taskType`, batching and concurrency.
- [/docs/core/dependencies](/docs/core/dependencies) — every `Dependencies` member, `createClient`, G1 precedence.
- [/docs/core/compaction](/docs/core/compaction) — surviving long conversations inside the loop.
