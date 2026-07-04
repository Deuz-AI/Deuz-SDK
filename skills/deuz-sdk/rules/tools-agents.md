# Tools + agents

## ToolSet shape

```ts
type ToolSet = Record<string, Tool>;
interface Tool<Args = unknown, Result = unknown> {
  description?: string;
  parameters: StandardSchemaV1<unknown, Args> | JSONSchema; // zod/valibot OR raw JSON Schema
  execute?: (args: Args, ctx: ToolExecuteContext) => Promise<Result> | Result; // omit → client tool
  needsApproval?: boolean | ((args, ctx) => boolean | Promise<boolean>);
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

## The agentic loop

Set on `generateText` / `streamChat` options: `tools`, `toolChoice?`, `maxSteps?`, `stopWhen?`, `maxToolConcurrency?`, `onStepFinish?`.

```ts
const res = await generateText({ model, messages, tools, maxSteps: 5 });
// res.text, res.usage, res.steps?, res.toolCalls?, res.toolResults?, res.response.messages
```

### Invariants you must respect

- **`maxSteps` DEFAULT IS 1** = single turn. With tools but `maxSteps` left at 1, the model can request a tool but the loop will NOT feed the result back. Set `maxSteps > 1` to actually loop. (This is the #1 mistake.)
- **`stopWhen`** is OR-ed with `maxSteps`. It's a predicate `(info: { steps; stepCount }) => boolean | Promise<boolean>`. `stepCountIs`/`hasToolCall` exist in source but are NOT part of the public surface (not re-exported from any subpath) — write your own inline predicate:
  ```ts
  stopWhen: ({ steps }) => steps.at(-1)?.toolCalls.some(c => c.toolName === 'final') ?? false,
  ```
- **Stop is decided on accumulated `tool_use` count, not `finishReason`** — the Gemini stop-bug guard. Don't add your own finishReason check.
- **Immutable history.** Each step builds a new `[...messages, turn]` array (prompt-cache + React state depend on it). Never mutate prior arrays.
- **Self-healing.** A thrown `execute` becomes an `is_error` tool_result fed back to the model — never a throw out of the loop. Every `tool_use_id` always gets a matching `tool_result` (Anthropic 400s otherwise).
- **Runaway guards.** The same tool failing 3 times consecutively hard-stops. Approval DENIALS are excluded from this counter (deliberate, not failures).
- **Parallel tools**, concurrency-capped by `maxToolConcurrency` (default 5).
- **Client tools** (no `execute`) break the loop early; the caller owns the round-trip and must append the `tool_result` message itself.

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

```ts
import { z } from 'zod';
const { object } = await generateObject({
  model: createOpenAI({ apiKey: KEY })('gpt-5.2'),
  messages: [{ role: 'user', content: 'Extract city + temp' }],
  schema: z.object({ city: z.string(), temp: z.number() }),
});
```
