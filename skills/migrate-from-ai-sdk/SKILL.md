---
name: migrate-from-ai-sdk
description: Use when porting an app from the Vercel AI SDK (`ai`, `@ai-sdk/*`) to @deuz-sdk/core. Triggers include "migrate from the AI SDK", "replace ai with @deuz-sdk/core", "we use streamText/generateText/useChat and want to switch", removing @ai-sdk/openai or @ai-sdk/anthropic, porting a toUIMessageStreamResponse route, converting ToolLoopAgent to Deuz, or any question about which Deuz API replaces a given AI SDK one.
license: MIT
---

# Migrate from the Vercel AI SDK to @deuz-sdk/core

Both are TypeScript AI SDKs with free functions, a canonical delta stream, schema-typed structured output and a streaming UI protocol, so most of a port is mechanical. Four things are NOT mechanical and decide the shape of the work — read them before editing a single file.

Companion skill: **`deuz-sdk`** (same install) documents the target API itself. Use it for anything about how Deuz works; use this skill for the mapping and the porting order.

## Verification rule (do not skip)

The AI SDK renames aggressively across majors. Every left-hand name in these rule files was verified against the live docs at `ai-sdk.dev` on **2026-07-28** (`ai@7.0.40`, AI SDK 7 published 2026-06-25). Before you trust one:

1. Read the user's `package.json` for the actual `ai` / `@ai-sdk/*` versions. A v4/v5/v6 app uses different names (`toDataStreamResponse`, `stepCountIs`, `onStepFinish`, `system`, `fullStream`, `needsApproval`, `experimental_*`).
2. When a name in their code is not in the mapping tables, DO NOT guess a Deuz equivalent. Grep the Deuz source or say you could not map it.

Right-hand (Deuz) names are verified against the repo source. If an import does not exist in `@deuz-sdk/core`'s `package.json` `exports`, it is wrong — check before writing it.

## The four decisions

### 1. Keys become explicit — there is no env read anywhere

`@deuz-sdk/core` reads NO environment variable and has no hosted gateway (it must run unchanged on Cloudflare Workers). Every provider factory takes `apiKey`. Read `process.env` at the app layer, or pass `env.X` in a Worker.

### 2. The UI wire is different — both halves of a chat feature move together

Deuz does not speak the AI SDK's UI message protocol. You cannot point the AI SDK's `useChat` at a Deuz route, or Deuz's `useChat` at an AI SDK route. Port the route and its client in the same commit.

### 3. `maxSteps` defaults to 1 — this is the #1 porting bug

An AI SDK agent loops by default. A Deuz call with `tools` and no `maxSteps` runs ONE turn, returns `finishReason: 'tool_calls'` and no answer. Add an explicit `maxSteps` to every ported tool-using call.

### 4. `generateObject`/`streamObject` still exist, and are single-turn

AI SDK 7 dropped them for `Output.object({ schema })` on `generateText`. Deuz keeps them as their own functions — but they REFUSE loop options (`tools`, `maxSteps > 1`, `stopWhen`, `memory`, …) with an `InvalidRequestError`. If their `Output.object` call also passed `tools`, split it into a `generateText` loop followed by a `generateObject` structuring pass.

## Porting order

Work in this order; each step leaves the app compiling.

1. **Providers** — replace `@ai-sdk/*` imports with Deuz factories and thread keys in. `rules/providers.md`
2. **Core calls** — `streamText` → `streamChat`, `generateText` → `generateText`, `Output.object` → `generateObject`. Add `maxSteps`. `rules/imports.md`, `rules/streaming.md`
3. **Tools** — `inputSchema` → `parameters`, `ToolCallOptions`/`ToolExecutionOptions` → `ToolExecuteContext`. `rules/tools.md`
4. **Agents** — `ToolLoopAgent` → `createAgent`; `WorkflowAgent` → `session` + `resumeFromCheckpoint`. `rules/tools.md`
5. **Routes + client together** — `toUIMessageStreamResponse` → `toDeuzStreamResponse`, and add `validateChatRequest`. `rules/ui.md`
6. **Telemetry** — `@ai-sdk/otel` has no Deuz package; write a `deps.tracer` adapter. `rules/telemetry.md`
7. **Remove `ai` and `@ai-sdk/*`** from `package.json`. Deuz has zero runtime deps; install only the optional peers you use (`zod` + `@standard-community/standard-json` for Standard Schema, `@modelcontextprotocol/sdk` for MCP).

## Headline mapping

| Vercel AI SDK (7.x) | `@deuz-sdk/core` |
| --- | --- |
| `streamText` | `streamChat` (sync return, never throws, lazy pump) |
| `generateText` | `generateText` |
| `generateText({ output: Output.object({ schema }) })` | `generateObject({ schema })` |
| `result.stream` (`fullStream` pre-7) | `result.fullStream` |
| `result.consumeStream()` | `result.consume?.()` |
| `result.totalUsage` | `result.usage` (already summed across steps + sub-agents) |
| `result.finalStep` | `result.steps?.at(-1)` |
| `instructions` (`system` pre-7) | `instructions` |
| `abortSignal` | `signal` (`abortSignal` accepted, deprecated) |
| `tool({ inputSchema, execute })` | `tool({ parameters, execute })` |
| `stopWhen: isStepCount(n)` | `maxSteps: n` (or `stopWhen: stepCountIs(n)`) |
| `onStepEnd` / `onEnd` | `onStepFinish` / `onFinish` |
| `toolApproval` (`needsApproval` pre-7) | `needsApproval` on the tool + `approveToolCall` / `approvalResponses` |
| `ToolExecutionOptions` | `ToolExecuteContext` |
| `ToolLoopAgent` | `createAgent` (`@deuz-sdk/core/agent`) — a frozen value, not a class |
| `WorkflowAgent` | `session: { store, runId }` + `resumeFromCheckpoint` |
| `result.toUIMessageStreamResponse()` | `toDeuzStreamResponse(result)` (`@deuz-sdk/core/ui`) |
| `result.toTextStreamResponse()` | `toDeuzTextStreamResponse(result)` |
| `createUIMessageStream` + a `data-*` write | `createDeuzStream(result).writeData(name, payload, opts?)` |
| `useChat` (`@ai-sdk/react`) | `useChat` (`@deuz-sdk/react`) |
| `convertToModelMessages(messages)` | nothing — Deuz's `useChat` POSTs canonical `Message[]` already |
| — | `validateChatRequest(body)` — ADD this to every ported route |
| `wrapLanguageModel` | `wrapModel(model, [...])` (`@deuz-sdk/core/middleware`) |
| `customProvider` / gateway string ids | `createProviderRegistry({...})` (local lookup, zero network) |
| `MockLanguageModelV4` (`ai/test`) | `createMockModel` (`@deuz-sdk/core/testing`) |

## No equivalent — flag these, do not fake them

Tell the user up front if their app uses any of these; there is no Deuz replacement today.

| AI SDK feature | Status |
| --- | --- |
| `transcribe`, `generateSpeech` | Absent. No audio entry point exists (audio *tokens* are metered, that is all). |
| `experimental_generateVideo` | Absent as a function. |
| `useCompletion` | Absent. Use `useChat` against a single-turn route. |
| Svelte / Vue / Angular bindings | Absent. Only `@deuz-sdk/react` ships; the wire is plain SSE. |
| `@ai-sdk/devtools` (local web UI) | Absent. Nearest: `deps.observer` + `createJsonlObserver` (`@deuz-sdk/core/observe/node`) + `summarizeRun`. |
| `@ai-sdk/otel` / `registerTelemetry()` | No package. Write a `deps.tracer` adapter — `rules/telemetry.md`. |
| `Output.array()` / element streaming | Absent. `streamObject` streams partials of ONE object. |
| `contextSchema` / `toolsContext` / `runtimeContext` | Absent. Close over what a tool needs, or read `ctx.messages`. |
| Codemods | Absent. This skill is the replacement. |
| Hosted gateway / plain string model ids | Deliberately absent. |

## `result.warnings` does NOT map one-to-one

The AI SDK reports dropped settings on every result. Deuz's `warnings` is populated on **`streamChat` only** (`Promise<CallWarning[]>`, settles with `usage`, never rejects; `warning` parts also ride `fullStream`). It is `undefined` on `GenerateTextResult` / `GenerateObjectResult` / `StreamObjectResult`, and a `streamChat` carrying `tools` / `chat` / `memory` / `verifyStep` / `doneWhen` reports only its own `activeTools` notices — a model-level warning raised inside a step reaches `deps.logger.warn`, not the field. So a port that reads `warnings` off a buffered result loses information silently: wire a logger (`rules/telemetry.md`), and read the field only as a bonus.

Two things that DID need a workaround when 1.9 first landed and no longer do — use them directly: **tool approval DENIAL** (`tool-state.denied` / `deniedReason` → `UIToolCall.denied`, set by the streaming loop; a thrown tool gains no denial fields) and **`sub-agent` parts in `useChat`** (`applyUIPart` folds them into `turn.subAgents`, exposed as `useChat().subAgents` — no hand-rolled `readDeuzStream` needed). See `rules/tools.md` and `rules/ui.md`.

## Detail rules (read on demand)

- `rules/imports.md` — import-by-import table, package.json surgery, the subpath map.
- `rules/streaming.md` — `streamChat`'s never-throw contract, `consume()`, timeouts, the canonical part names.
- `rules/tools.md` — tool literals, the loop, approvals, `createAgent`, durable runs.
- `rules/ui.md` — the route + client pair, `validateChatRequest`, `useChat` differences, ordered `parts`.
- `rules/telemetry.md` — replacing `@ai-sdk/otel`, observation, cost, redaction.
- `rules/providers.md` — factory-for-package mapping and `createOpenAICompatible`.
