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
