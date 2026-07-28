# Streaming and the core calls

## `streamText` -> `streamChat`

```ts
// before
const result = streamText({ model, instructions: 'You are terse.', prompt: 'hi' });
for await (const chunk of result.textStream) write(chunk);

// after
const result = streamChat({ model, instructions: 'You are terse.', prompt: 'hi' });
try {
  for await (const chunk of result.textStream) write(chunk);
} catch {
  /* mid-stream failure — the streamChat() CALL never throws */
}
const usage = await result.usage;
```

`prompt` and `instructions` are the same names and the same meanings as AI SDK 7 (1.9 added them to Deuz). `prompt` is shorthand for exactly ONE user turn and is mutually exclusive with `messages`; passing both, or neither, is an `InvalidRequestError`. `instructions` is placed first and a `system`-role message already in `messages` is preserved after it.

### The G2 contract — port your error handling

`streamChat` returns **synchronously** and **never throws**, not even on a missing key. Do not `await` it. Do not wrap the call in `try/catch` — it catches nothing. Failures arrive as:

- an `{ type: 'error', error }` part on `fullStream` (the stream ends after it), and
- rejected `usage` / `finishReason` promises; iterating `textStream` throws at the error point.

Do not make wrappers `async`. `result.runId` is readable synchronously.

### The lazy pump — `consumeStream()` -> `consume?.()`

The network pump starts on first access of an output and only advances while someone pulls. If nobody iterates (client disconnected, result returned and dropped), the run never reaches its terminal boundary — so `onFinish`, chat persistence, durable checkpoints and memory extraction NEVER RUN.

```ts
const res = streamChat({ model, prompt, chat: { store, chatId, scope } });
const response = toDeuzStreamResponse(res);
after(() => res.consume?.());   // next/server; ctx.waitUntil(...) on Workers
return response;
```

`consume()` takes its own subscription (safe alongside iteration), is memoized, and NEVER rejects — failures go to `consume({ onError })`. Write `res.consume?.()`: it is `undefined` on two paths (`streamChat({ fallbackModels })` and the `withFallback` middleware).

## Timeouts

Both SDKs have a `timeout` option accepting a number or an object, but the layers differ:

| | AI SDK 7 | Deuz 1.9 |
| --- | --- | --- |
| object | `{ totalMs, stepMs, toolMs, tools: { [name]Ms } }` | `{ ttftMs, totalMs, stepMs, toolMs }` |
| per-tool cap | `timeout.tools` map | `Tool.timeoutMs` on the tool itself |
| time-to-first-byte | — | `ttftMs` (default 60_000, cleared on first content delta) |
| bare number | shorthand | shorthand for `{ totalMs }` |

Deuz defaults: `ttftMs` 60_000, `totalMs` 300_000; `stepMs`/`toolMs` unbounded. An explicit **`0` disables** that layer — that is how you drop the 300s ceiling. Every timer runs on `deps.clock`, so tests are deterministic.

- An expiry is a **failure**: `TimeoutError`, never `finishReason: 'aborted'`. A user abort resolves `'aborted'` with partial usage.
- `stepMs` is enforced in the **streaming** loop only; the buffered `generateText` loop honours `ttftMs`/`totalMs`/`toolMs`.
- A tool timeout is **self-healing**: the execution is abandoned and the model gets an `is_error` `tool_result`, so the run continues. It counts toward the runaway-tool guard.

## Abort

`abortSignal` is accepted as a **deprecated alias** for `signal`, so a copy-pasted AI SDK options object still cancels. `signal` wins if both are set. Prefer `signal` in ported code.

## Retries

Deuz retries **pre-first-byte only** (`maxRetries`, default 2; exponential backoff + full jitter, `Retry-After` honoured). Once bytes stream, a mid-stream error is final — there is no mid-stream resume of a provider call. Resuming the *UI stream* is a separate, supported thing (`rules/ui.md`).

Jitter is derived from `deps.generateId()`, not `Math.random()`, so it is deterministic in tests.

## Canonical part names

Deuz normalizes every provider SSE into `StreamPart` first — adapters never proxy raw provider bytes. Keep a `default` case: the union is documented as OPEN.

| AI SDK part | Deuz `StreamPart` |
| --- | --- |
| `text-delta` | `text-delta` (`text`) |
| `reasoning-delta` | `reasoning-delta` (`text`, `signature?`, `encrypted?`) |
| `tool-input-delta` | `tool-call-delta` (`{ id, name?, argsTextDelta }`) — accumulate as a STRING, parse once |
| `tool-call` | `tool-call` (`{ toolCallId, toolName, input }`) |
| `tool-result` | `tool-result` (`{ toolCallId, toolName, output, isError? }`) |
| `start-step` / `finish-step` | `step-start` / `step-finish` |
| `source` | `source` |
| `finish` | `finish` (`{ usage, finishReason, providerMetadata? }`) |
| `error` | `error` (`{ error: unknown }`) |

Deuz-only members: `compaction`, `sub-agent`, `citation`, `cost`, `budget-exceeded`, `verify`, `false-finish`, `plan-update`, `activity`, `tool-state`, `tool-approval-request`, `data`, and `warning` (see below).

## Result fields

| AI SDK | Deuz |
| --- | --- |
| `result.stream` / `result.fullStream` | `result.fullStream` |
| `result.textStream` | `result.textStream` |
| `result.usage` / `result.totalUsage` | `result.usage` — ONE field, already summed across every step and sub-agent |
| `result.finishReason` | `result.finishReason` (`'stop' \| 'length' \| 'tool_calls' \| 'content_filter' \| 'error' \| 'aborted'`) |
| `result.steps` | `result.steps` — **`undefined` on a single-turn call** (no `tools`) |
| `result.finalStep` | `result.steps?.at(-1)` |
| `result.warnings` | `result.warnings` — **`streamChat` only, see below** |

### `warnings` is a partial map

`streamChat().warnings` is real: `Promise<CallWarning[]>`, settles with `usage`, NEVER rejects (`[]` on a clean run), and each notice also arrives on `fullStream` as `{ type: 'warning', warning }` ahead of the model's own output.

```ts
const result = streamChat({ model, prompt, temperature: 0.7 });
for (const w of (await result.warnings) ?? []) console.warn(w.type, w.setting, w.message);
```

`CallWarning` is `{ type: 'unsupported-setting' | 'clamped-setting' | 'unknown-model' | 'unsupported-tool' | 'other'; setting?: string; message: string }` — an OPEN union, so treat an unknown `type` as `'other'`. (`clamped-setting` has no producer yet.)

Where it does NOT map:

- **`generateText`, `generateObject` and `streamObject` leave it `undefined`.** A port that reads `warnings` off a buffered result loses information silently.
- **A `streamChat` with `tools` / `chat` / `memory` / `verifyStep` / `doneWhen`** runs the loop and reports only its own `activeTools` notices; a model-level warning (unknown slug, a stripped sampling param, a hosted tool dropped on Chat Completions, a dropped document) is raised inside the per-step pump and reaches the log only.

`deps.logger.warn` is still the complete channel, and the DEFAULT LOGGER IS A NO-OP. Wire one during the port:

```ts
deps: {
  logger: {
    debug() {}, info() {},
    warn: (msg, meta) => console.warn('[deuz]', msg, meta),
    error: (msg, meta) => console.error('[deuz]', msg, meta),
  },
}
```

## Structured output

```ts
// before (AI SDK 7)
const { output } = await generateText({ model, prompt, output: Output.object({ schema }) });

// after
const { object } = await generateObject({ model, prompt, schema });
```

- `mode: 'auto'` (default) picks native json mode when the model's registry row reports `structuredOutput`, else tool-call coercion.
- **One repair retry** on a parse/validation miss, then `NoObjectGeneratedError`. `streamObject` has NO repair retry (partials cannot be un-streamed) — it rejects `object` and the stream but still resolves `usage`/`finishReason`.
- Anthropic + extended thinking forces json mode; `auto` handles it. Do not pass `mode: 'tool'` there.
- **Loop options are refused.** `tools`, `toolChoice`, `maxSteps > 1`, `stopWhen`, `budget`, `maxToolConcurrency`, `onStepFinish`, `prepareStep`, `activeTools`, `verifyStep`, `maxVerifyAttempts`, `compaction`, `approveToolCall`, `approvalResponses`, `session`, `chat`, `memory`, `fallbackModels`, `approvalSigner`, `approvalMaxAgeMs` all raise an `InvalidRequestError` before any network call. Empty collections and `maxSteps: 1` pass the guard.

If the source called `Output.object` WITH tools, split it:

```ts
const { text } = await generateText({ model, prompt, tools, maxSteps: 10 });
const { object } = await generateObject({ model, schema, prompt: `Structure this:\n${text}` });
```

## Unknown model slugs

Deuz never throws on an unrecognized slug — it falls back to a conservative row (`maxOutput: 4096`, `reasoning: false`, `structuredOutput: false`) and logs a warning. So a port using a brand-new slug can be **silently truncated at 4096 output tokens**. Fix it per call:

```ts
capabilities: { maxOutput: 32_000, reasoning: true, structuredOutput: true }
```

`capabilities` overrides what the SDK BELIEVES, not what the provider does; `capabilities.tools` is read by no adapter. `getModelCapabilities(model)` returns the effective frozen matrix (`caps.known === false` means the fallback row was used).
