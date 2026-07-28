# Tools + agents

## ToolSet shape

```ts
type ToolSet = Record<string, Tool>;
interface Tool<Args = unknown, Result = unknown> {
  type?: 'function' | 'provider';                          // 'provider' = provider-executed
  description?: string;
  parameters: StandardSchemaV1<unknown, Args> | JSONSchema; // zod/valibot OR raw JSON Schema
  execute?: (args: Args, ctx: ToolExecuteContext) => Promise<Result> | Result; // omit → client tool
  needsApproval?: boolean | ((args, ctx) => boolean | Promise<boolean>);
  outputSchema?: JSONSchema;                               // metadata only, never sent on chat wires
  providerTool?: Record<string, unknown>;                  // raw native def for a 'provider' tool
  timeoutMs?: number;                                      // 1.9 — per-execution cap for THIS tool
}
interface ToolExecuteContext { toolCallId: string; messages: Message[]; signal?: AbortSignal; }
type ToolChoice = 'auto' | 'required' | 'none' | { type: 'tool'; toolName: string };
```

The map KEY is the tool name the model sees. `parameters` can be a raw JSON Schema (no peer dep) or any Standard Schema like zod (needs `zod` + `@standard-community/standard-json`).

```ts
const tools = {
  getWeather: {
    description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    execute: async ({ city }: { city: string }) => ({ city, temp: 22 }),
  },
} satisfies ToolSet;
```

## `tool()` — typed args (1.9)

`ToolSet = Record<string, Tool>` ERASES `Tool<Args, Result>`, so a hand-written literal gets `args: unknown` and editing the schema produces no compile error in the handler. `tool()` (root export) fixes only that:

```ts
import { tool, type InferToolInput, type InferToolOutput } from '@deuz-sdk/core';
import { z } from 'zod';

const getWeather = tool({
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async (args) => fetchWeather(args.city),   // args: { city: string }
});
await generateText({ model, prompt: 'weather?', maxSteps: 5, tools: { getWeather } });
```

It is a PURE IDENTITY FUNCTION (`tool(def) === def`), imports no validator and adds zero runtime behaviour. A raw JSON Schema degrades to `unknown` (never `any`) — narrow it yourself. One sharp edge: calling `myTool.execute(args, ctx)` DIRECTLY checks `args` as `unknown` (`Tool` is invariant in `Args`, so the return type is an intersection that stays assignable to plain `ToolSet`). Authoring inference and the loop are unaffected.

`Tool.timeoutMs` overrides the call's `timeout.toolMs` for one tool. Expiry is SELF-HEALING — the execution is abandoned and the model gets `Tool 'x' timed out after Nms and was abandoned.` as an `is_error` result — and it COUNTS toward the runaway guard.

## The agentic loop

Set on `generateText` / `streamChat` options: `tools`, `toolChoice?`, `maxSteps?`, `stopWhen?`, `maxToolConcurrency?`, `onStepFinish?`.

```ts
const res = await generateText({ model, messages, tools, maxSteps: 5 });
// res.text, res.usage, res.steps?, res.toolCalls?, res.toolResults?, res.response.messages
```

### Invariants you must respect

- **`maxSteps` DEFAULT IS 1** = single turn. With tools but `maxSteps` left at 1, the model can request a tool but the loop will NOT feed the result back. Set `maxSteps > 1` to actually loop. (This is the #1 mistake.)
- **`stopWhen`** is OR-ed with `maxSteps`. It's a predicate `(info: { steps; stepCount }) => boolean | Promise<boolean>`. `stepCountIs`, `hasToolCall`, `totalTokensExceed`, `costExceeds` and `durationExceeds` ARE exported from the root and `/edge`; a hand-written inline predicate works too:
  ```ts
  stopWhen: ({ steps }) => steps.at(-1)?.toolCalls.some(c => c.toolName === 'final') ?? false,
  ```
- **Stop is decided on accumulated `tool_use` count, not `finishReason`** — the Gemini stop-bug guard. Don't add your own finishReason check.
- **Immutable history.** Each step builds a new `[...messages, turn]` array (prompt-cache + React state depend on it). Never mutate prior arrays.
- **Self-healing.** A thrown `execute` becomes an `is_error` tool_result fed back to the model — never a throw out of the loop. Every `tool_use_id` always gets a matching `tool_result` (Anthropic 400s otherwise).
- **Runaway guards.** The same tool failing 3 times consecutively hard-stops (`endReason: 'runaway-tool-errors'`). Unknown-tool errors and tool timeouts COUNT toward it; approval DENIALS are excluded (a policy verdict is not something the model can fix).
- **Parallel tools**, concurrency-capped by `maxToolConcurrency` (default 5).
- **Client tools** — a key PRESENT in `tools` with no `execute` — break the loop early; the caller owns the round-trip and must append the `tool_result` message itself.
- **An UNREGISTERED name is NOT a client tool** (changed in 1.9). Before 1.9 both satisfied `!tools[name]?.execute`, so a hallucinated name broke the loop and left a dangling `tool_use` nobody could answer. Now it self-heals — `No such tool: "x". Available tools: a, b.` as an `is_error` result — and the loop CONTINUES. Own keys only, so `toString` / `constructor` are unknown too. A `type: 'provider'` tool also has no `execute` but never breaks the loop.

### Streaming the loop

`streamChat({ ..., tools, maxSteps })`: `fullStream` interleaves `step-start` / `tool-call` / `tool-result` / `step-finish` with text/reasoning deltas. Same invariants.

## Loop hooks — prepareStep / activeTools (1.4.0+)

`prepareStep?: (ctx: { stepIndex, messages, usage }) => PrepareStepResult | undefined` runs before EVERY step, AFTER automatic compaction (sees, and has the final word on, the compacted history). `usage` is cumulative REAL usage of all prior steps (sub-agents included). `PrepareStepResult = { messages?, activeTools?, toolChoice?, model? }` — `messages` becomes the base for THIS and all FOLLOWING steps (doubles as the user-controlled compaction hook; system-prompt edits go through rewriting the system-role message here — there is no separate `system` field). `activeTools`/`toolChoice`/`model` apply to THIS step only. A thrown `prepareStep` fails the call — never swallowed.

`activeTools?: string[]` (static, on options) — only these tool keys are sent every step. Unknown names log a warn and are ignored; matching NOTHING fails OPEN (sends the full list). `prepareStep`'s `activeTools` OVERRIDES the static one (filters the full set, does not intersect).

## Budget stop conditions (1.4.0+)

`totalTokensExceed(n)` / `costExceeds(usd)` — `StopCondition` factories exported from root + `/edge`, alongside `stepCountIs`/`hasToolCall` (now also exported). OR-ed into `stopWhen` like any condition, plus the implicit `maxSteps` bound; evaluated at the STEP boundary, never mid-tool-batch (Anthropic 400 guard preserved). `totalTokensExceed` reads provider-reported usage (no estimate); `costExceeds` needs `deps.priceProvider` — without one it warns ONCE and never fires. A budget stop does NOT change `finishReason` (the union stays locked) — instead the result / `finish` part carries `providerMetadata.deuz.stoppedBy: 'totalTokensExceed' | 'costExceeds'`. `GenerateTextResult.providerMetadata` is a new additive field.

## Automatic compaction (1.4.0+)

`compaction?: 'auto' | CompactionPolicy` on options — opt-in, OFF by default, **only runs inside the agentic loop** (a no-`tools` call bypasses it entirely). `CompactionPolicy = { threshold? (default 0.92), keepRecentSteps? (default 4, floored/clamped to a positive integer), layers? (default ['prune-tool-results','prune-reasoning','summarize']), summarizeModel? (default the loop's own model) }`. Layers run cheapest-first, re-estimating after each, until fill drops under `threshold * 0.8`:

- `prune-tool-results` — old `tool_result` bodies → `[pruned N chars]` (toolUseId/isError kept — Anthropic 400 safe).
- `prune-reasoning` — old assistant reasoning parts dropped; the LAST assistant turn is never touched (thinking-signature chain).
- `summarize` — the oldest unprotected run collapses into ONE `user`-role summary message; costs one extra model call whose usage counts toward the result total AND budget stops.

ALWAYS protected: every system message, the first user message, the LAST message (the pending question), and the last `keepRecentSteps` assistant turns. Never throws (a failed summarize warns via `logger` and skips the layer); immutable + prefix-stable history (KV-cache hits survive; `response.messages` is never affected by compaction). Token counts are a calibrated HEURISTIC (no tokenizer, no network — a session-local EMA tightens against real usage each step). Streaming emits a `{ type: 'compaction', layer, tokensBefore, tokensAfter }` `StreamPart` per layer that ran; buffered logs it via `deps.logger.info`. Anthropic's native `providerOptions.anthropic.context_management` still works verbatim alongside this — its `applied_edits` come back on `providerMetadata.anthropic.contextManagement`.

## Sub-agents — agentTool (1.4.0+)

`agentTool(def: AgentToolDef): Tool` wraps a nested agentic loop as a callable tool (no new runtime — `execute` drives the same streaming loop one level down). `AgentToolDef = { name, description, model, tools?, system?, maxSteps? (default 10), maxDepth? (default 2), needsApproval?, compaction?, stopWhen?, subAgentStream?: 'full' | 'none' (default 'full') }`. **Use the same string for the tools-map key and `name`.** The tool's input is `{ prompt: string }`; it returns the sub-agent's final text.

- **Live visibility** (streaming parent only): the sub-agent's ENTIRE canonical stream forwards into the parent's `fullStream` as `{ type: 'sub-agent', agentPath, part }`, tagged with the full path (`['researcher']`, `['researcher','coder']` one level deeper — single-wrapped, never a nested `sub-agent` part). `subAgentStream: 'none'` runs silently; a buffered parent is always silent (just gets the final text back as a normal tool_result).
- **Approval inheritance**: the parent's server-mode `approveToolCall` is inherited to every depth — a sub-agent's own tool calls stay gated. AI SDK's subagents explicitly cannot do this. Client-mode approval INSIDE a sub-agent is NOT supported in 1.4 (needs durable suspend/resume — lands in 1.5); a gated sub-agent tool with no inherited approver returns a clear is_error explaining this.
- **Usage**: a sub-agent's cumulative usage folds into the parent total (`result.usage`, budget stops, cost); its own `onUsage` events are tagged with `meta.agentPath`.
- **`maxDepth`** (default 2) caps nesting per agent — exceeding it is a self-healing is_error (the parent model can recover), not a crash.
- **Abort**: the parent `signal` propagates down into every sub-agent's own loop.

## Tool approval (1.3.0+)

`needsApproval` is LIVE (boolean or predicate; a THROWING predicate = approval required, safe side). Two modes:

- **Server mode** — pass `approveToolCall: (call, { messages }) => boolean | Promise<boolean>` on the options. Awaited per gated call; `false`/throw → `is_error` `'Tool call denied.'` tool_result, loop continues (denials never trip the runaway guard).
- **Client mode** — omit `approveToolCall`: gated calls break the loop like client tools (ONE break, nothing in that batch executes). `generateText` returns `pendingApprovals: [{ approvalId, toolCallId, toolName, input }]` (`approvalId === toolCallId`); streaming emits `tool-approval-request` parts. Resume with `approvalResponses: [{ approvalId, approved, reason? }]` — approved execute, denied become is_error, **no-verdict gated calls DENY by default**, deferred plain server tools auto-execute, every tool_use id gets answered. Settled results append as a NEW `role:'tool'` message (in `response.messages`) and stream as `tool-result` parts before the first `step-start`.

## createAgent — a reusable agent as a VALUE (1.9)

`@deuz-sdk/core/agent` (also on `/edge`). NOT a class: a free-function factory returning a FROZEN plain object of closures, in the `createClient` idiom. No `new`, no prototype, no new runtime — `agent.streamChat(o)` IS `streamChat({ ...def, ...o })`.

```ts
import { createAgent } from '@deuz-sdk/core/agent';

const support = createAgent({
  name: 'support',                 // observation label + asTool()'s agentPath segment; never on a wire
  model: anthropic('claude-opus-4-8'),
  instructions: 'You are a terse support agent.',
  tools: { lookupOrder },
  maxSteps: 8,                     // remember: the default is 1
});

await support.generateText({ prompt: 'where is order 12?' });
const res = support.streamChat({ prompt: '…' });   // SYNCHRONOUS (G2), never throws
const strict = support.with({ temperature: 0 });   // a NEW frozen agent; the original is untouched
const sub = support.asTool();                      // built by the existing agentTool
```

- **Merge rule, one sentence:** shallow TOP-LEVEL spread. A per-call key REPLACES the def's value whole — including `tools`, `deps`, `providerOptions` and `stopWhen` arrays. An explicit `undefined` UNSETS it. Opt into merging yourself: `{ deps: { ...support.def.deps, observer } }`.
- **`generateObject` on an agentic def FAILS by design** (structured output refuses loop options). Pass `{ tools: undefined, maxSteps: undefined }` per call, or bake it with `with(...)`.
- **`asTool()` forwards only** `model`, `tools`, `instructions` (→ `system`), `maxSteps`, `stopWhen`, `compaction`, `name`. Sampling params, `verifyStep`, `deps`, `timeout`, `memory` do NOT cross — the sub-agent reuses the PARENT's transport and approval flow. Omitted fields keep `agentTool`'s defaults (maxSteps 10, maxDepth 2).
- `def` is a shallow-frozen COPY, so mutating your original object afterwards changes nothing.

## Structured output — streamObject (1.3.0+)

`streamObject(options)` = same options as `generateObject`, returns SYNCHRONOUSLY (G2): `{ partialObjectStream: AsyncIterable<DeepPartial<T>>, object: Promise<T>, usage, finishReason }`. json strategy streams growing partials (emit only on change; string values arrive truncated); tool strategy buffers ONE final emission. **NO repair retry** (divergence from generateObject — partials can't be un-streamed): failed final parse/validation rejects `object` (NoObjectGeneratedError) AND the stream, but `usage`/`finishReason` still resolve.

## Structured output — generateObject

```ts
const { object, usage, finishReason } = await generateObject({
  model, messages,
  schema,                 // StandardSchemaV1 (zod/valibot) | JSONSchema
  schemaName?, schemaDescription?,
  mode?: 'auto' | 'json' | 'tool',  // default 'auto'
});
```

- **`auto`** picks `json` when the model's registry capabilities include `structuredOutput`, else `tool` (function-calling coercion).
- One **repair retry** on parse/validation failure; then `NoObjectGeneratedError`.
- **Anthropic + extended thinking** (`effort` set and not `'none'`) forces `json` mode — forced tool-choice is rejected by the API with thinking on. `auto` handles this for you; don't pass `mode: 'tool'` there.
- **LOOP OPTIONS ARE REFUSED (1.9).** Structured output is single-turn, so `tools`, `toolChoice`, `maxSteps > 1`, `stopWhen`, `budget`, `maxToolConcurrency`, `onStepFinish`, `prepareStep`, `activeTools`, `verifyStep`, `maxVerifyAttempts`, `compaction`, `approveToolCall`, `approvalResponses`, `session`, `chat`, `memory`, `fallbackModels`, `approvalSigner` and `approvalMaxAgeMs` now raise an `InvalidRequestError` BEFORE any network request (they used to be silently ignored). `generateObject` rejects; `streamObject` reports it through its never-throw shape. Empty collections (`tools: {}`, `stopWhen: []`) and `maxSteps: 1` pass the guard. To combine tools with structure: run the loop with `generateText`, then structure its `text` with `generateObject`.

```ts
import { z } from 'zod';
const { object } = await generateObject({
  model: createOpenAI({ apiKey: KEY })('gpt-5.2'),
  messages: [{ role: 'user', content: 'Extract city + temp' }],
  schema: z.object({ city: z.string(), temp: z.number() }),
});
```
