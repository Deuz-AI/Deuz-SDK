# Tools, the loop, and agents

## The tool literal

```ts
// before (AI SDK)
import { tool } from 'ai';
const getWeather = tool({
  description: 'Get the weather for a city',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 22 }),
});

// after
import { tool } from '@deuz-sdk/core';
const getWeather = tool({
  description: 'Get the weather for a city',
  parameters: z.object({ city: z.string() }),          // NOT inputSchema
  execute: async (args) => ({ city: args.city, tempC: 22 }), // args: { city: string }
});
```

`inputSchema` -> `parameters` is the only required rename. Deuz's `tool()` is a **pure identity function** (`tool(def) === def`) that imports no validator and adds zero runtime behaviour — its whole job is to flow the schema type into `execute`. A plain object literal is equally valid; it just types `args` as `unknown`.

The full shape:

```ts
interface Tool<Args = unknown, Result = unknown> {
  type?: 'function' | 'provider';          // 'provider' = provider-executed
  description?: string;
  parameters: StandardSchemaV1<unknown, Args> | JSONSchema;
  execute?: (args: Args, ctx: ToolExecuteContext) => Promise<Result> | Result;
  needsApproval?: boolean | ((args: Args, ctx: ToolExecuteContext) => boolean | Promise<boolean>);
  outputSchema?: JSONSchema;               // metadata only, never sent on chat wires
  providerTool?: Record<string, unknown>;  // raw native def for a 'provider' tool
  timeoutMs?: number;                      // 1.9 — per-execution cap for THIS tool
}
type ToolSet = Record<string, Tool>;       // the KEY is the name the model sees

interface ToolExecuteContext {             // was ToolExecutionOptions / ToolCallOptions
  toolCallId: string;
  messages: Message[];                     // immutable snapshot — read, never mutate
  signal?: AbortSignal;
  // plus agentPath inside a sub-agent
}
```

A raw JSON Schema needs no peer dependency and is fully first-class; a Standard Schema (zod/valibot/arktype) additionally validates the model's arguments before `execute` runs, and needs `zod` + `@standard-community/standard-json`.

Also available: `InferToolInput<T>` / `InferToolOutput<T>` (both work on `tool()` results and on plain `Tool` values; the output type is awaited).

## The loop

```ts
// before
await generateText({ model, prompt, tools, stopWhen: isStepCount(5) });

// after
await generateText({ model, prompt, tools, maxSteps: 5 });
```

`maxSteps` **defaults to 1** = single turn. With `tools` set and `maxSteps` left alone the model can request a tool but the loop will not feed the result back: you get `finishReason: 'tool_calls'` and no answer. Add an explicit bound to EVERY ported tool-using call. This is the #1 porting bug.

`stopWhen` is OR-ed with `maxSteps` and accepts one predicate or an array. Deuz exports `stepCountIs`, `hasToolCall`, `totalTokensExceed`, `costExceeds`, `durationExceeds` from the root.

Invariants you inherit and must not re-implement:

- **Immutable history.** Each step builds a new `[...messages, turn]`; prompt-cache hits and React state depend on it.
- **Stop is decided on accumulated `tool_use` count, not `finishReason`** — the Gemini stop-bug guard. Do not add your own `finishReason` check.
- **Self-healing.** A thrown `execute` becomes an `is_error` `tool_result` fed back to the model, never a throw out of the loop. Every `tool_use_id` always gets exactly one `tool_result` (Anthropic 400s otherwise). Do not append tool results yourself inside `execute`.
- **Parallel tools**, capped by `maxToolConcurrency` (default 5).
- **Runaway guard.** The same tool failing on 3 consecutive steps hard-stops the loop. Unknown-tool errors and tool timeouts count; approval denials do not.
- **`activeTools`** matching nothing fails OPEN (the full set is sent), unlike a filter that would starve the model.

## Client tools — the definition changed in 1.9

A **client tool** is a key **PRESENT in `tools`** whose value has no `execute`. The loop breaks and the caller owns the round-trip.

An **unregistered** name (the model invented it) is NOT a client tool. Before 1.9 both satisfied the same `!tools[name]?.execute` test, so a hallucination broke the loop and left a dangling `tool_use` nobody could answer. Now it self-heals:

```
No such tool: "search_web". Available tools: getWeather, search.
```

…and the loop continues. A name colliding with an `Object.prototype` member (`toString`, `constructor`) is classified as unknown too. A `type: 'provider'` tool has no `execute` but runs upstream, so it never breaks the loop either.

If the ported app relied on the old behaviour to catch hallucinations, that logic is now dead code — delete it.

## Approvals

`toolApproval` (AI SDK 7; `needsApproval` before that) maps to `needsApproval` **on the tool**, plus one of two modes on the call:

- **Server mode** — pass `approveToolCall: (call, { messages }) => boolean | Promise<boolean>`. Awaited per gated call; `false` or a throw becomes an `is_error` `'Tool call denied.'` result and the loop continues. Denials never trip the runaway guard.
- **Client mode** — omit `approveToolCall`; gated calls break the loop. `generateText` returns `pendingApprovals: [{ approvalId, toolCallId, toolName, input }]`; streaming emits `tool-approval-request` parts. Resume with `approvalResponses: [{ approvalId, approved, reason?, token? }]`.

Sharp edges to carry into the port:

- **No verdict = DENIED.** A gated call with no matching response on resume is denied (safe side); it does not stay pending. Send a verdict for every `approvalId`. Unknown ids are ignored (replay-safe).
- **`createApprovalSigner`** (`@deuz-sdk/core/durable`) issues an HMAC-signed `token` on the request part; echo it back to approve.
- **Denial does not reach the UI as a denial.** `tool-state.denied` / `UIToolCall.denied` exist but no built-in producer sets them, so a declined call renders as a plain tool error unless your server emits its own `tool-state` part. Do not build a denial UI on those fields yet.
- Client-mode approval **inside a sub-agent** is not supported; pass `approveToolCall` on the outermost call if any sub-agent tool is gated.

## `ToolLoopAgent` -> `createAgent`

```ts
// before
const support = new ToolLoopAgent({ model, instructions: '…', tools: { lookupOrder } });
const { text } = await support.generate({ prompt: 'where is order 12?' });

// after
import { createAgent } from '@deuz-sdk/core/agent';
const support = createAgent({
  name: 'support',
  model,
  instructions: '…',
  tools: { lookupOrder },
  maxSteps: 8,          // remember: the default is 1
});
const { text } = await support.generateText({ prompt: 'where is order 12?' });
const res = support.streamChat({ prompt: '…' });   // SYNCHRONOUS (G2), never throws
const strict = support.with({ temperature: 0 });   // a new frozen agent
const asSubAgent = support.asTool();               // via agentTool
```

- **No class, no `new`.** It is a frozen plain object of closures; the methods are the free functions' names because that is what they forward to.
- **Merge rule:** `{ ...def, ...options }` — a shallow top-level spread. A per-call key REPLACES the def's value whole, including `tools`, `deps`, `providerOptions` and `stopWhen`. An explicit `undefined` UNSETS the def's field. Opt into merging yourself: `{ deps: { ...agent.def.deps, observer } }`.
- **`agent.generateObject(...)` on an agentic def fails by design** (structured output refuses loop options). Unset them: `{ tools: undefined, maxSteps: undefined }`, or once via `agent.with(...)`.
- **`asTool()` forwards only** `model`, `tools`, `instructions` (as `system`), `maxSteps`, `stopWhen`, `compaction`, `name`. Sampling params, `verifyStep`, `deps`, `timeout`, `memory` do NOT cross — the sub-agent reuses the parent's transport and approval flow.

## `WorkflowAgent` -> durable runs

There is no workflow vendor. Checkpoints go in **your** store:

```ts
const res = streamChat({
  model, messages, tools, maxSteps: 12,
  session: { store: sessionStore, runId },   // checkpoint at every step boundary
});
// later, after a crash:
await resumeFromCheckpoint({ store: sessionStore, runId, /* … */ }); // '@deuz-sdk/core/durable'
```

Only agentic calls (with `tools`) checkpoint — a single-turn call has no step boundaries. Store failures log through `deps.logger.error` and never kill the run. Pair it with the resumable UI wire (`rules/ui.md`) so a refresh, a network blip and a server crash all look the same to the client.

## Sub-agents

`agentTool(def)` (root export) wraps a nested agentic loop as a callable `Tool` — the AI SDK has no equivalent with approval inheritance. Use the SAME string for the tools-map key and `def.name`. The tool's input is `{ prompt: string }`; it returns the sub-agent's final text.

The parent's server-mode `approveToolCall` is inherited to every depth. The sub-agent's entire canonical stream forwards into the parent's `fullStream` as `{ type: 'sub-agent', agentPath, part }` — single-wrapped regardless of depth.

**It IS renderable in a `useChat` UI (1.9):** `applyUIPart` folds each `sub-agent` part into `turn.subAgents` — `Array<{ agentPath: string[]; afterPart: number; turn: AssistantTurnState }>`, one frame per path — and `useChat` exposes it as `subAgents`. `frame.turn` is a full turn folded by the same reducer, so render it with the SAME part component; indent by `agentPath.length` and splice at `afterPart` (the parent's ordered-element count at the handoff). No hand-rolled `readDeuzStream` needed. It is deliberately NOT merged into the parent's bubble or its canonical history: that would misattribute the child's prose and emit the child's `tool_use` without a `tool_result`.

## No equivalent

- `contextSchema` / `toolsContext` / `runtimeContext` — close over what the tool needs, or read `ctx.messages`.
- Typed per-tool context injection of any kind. `ToolExecuteContext` is fixed.
