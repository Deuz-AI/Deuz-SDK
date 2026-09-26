<!-- verified: 2026-09-26 against @deuz-sdk/core@2.1.0 + the 2.2 changesets · api-contract sha256:c025621e10fd
     sources: packages/core/src/types/{tool,config,guardrails,stream,message,methods}.ts, packages/core/src/{tool,agent,server-tools}.ts,
     packages/core/src/inference/{agent-tool,handoff,stop,loop-shared}.ts, docs/content/docs/reference/whats-new-2-0.mdx,
     docs/content/docs/agents/{tools,tool-loop,create-agent,client-tools,server-tools,subagents,handoffs,guardrails}.mdx -->

# Tools, loops, agents, handoffs and guardrails

**Load when:** the model has to call your code — tool definitions, multi-step loops, stop conditions and budgets, human approval, reusable agents, sub-agents, triage handoffs, or run-level guardrails. These examples cover the existing loop API. For native validated output, strict persistence, inherited execution policy and swarms (fixed or dynamic, with leases), read `references/native-execution.md`.

## The `Tool` shape

```ts no-verify
interface Tool<Args = unknown, Result = unknown> {
  description?: string;
  parameters: StandardSchemaV1<unknown, Args> | JSONSchema;
  execute?: (args: Args, ctx: ToolExecuteContext) => Promise<Result> | Result;
  needsApproval?: boolean | ((args: Args, ctx: ToolExecuteContext) => boolean | Promise<boolean>);
  type?: 'function' | 'provider';
  providerTool?: Record<string, unknown>;
  outputSchema?: JSONSchema;
  timeoutMs?: number;
}
type ToolSet = Record<string, Tool>;
```

| Field | Notes |
| --- | --- |
| `description` | The model's only clue about when to call it. Write it carefully. |
| `parameters` | A Standard Schema (zod, valibot, arktype) **or** a raw JSON Schema. Raw JSON Schema needs no peer; a Standard Schema needs `zod` + `@standard-community/standard-json`. |
| `execute` | Omit it and the key becomes a **client tool**. Return anything JSON-serializable — it becomes the `tool_result` sent back verbatim. |
| `needsApproval` | `true` or a predicate over the parsed args. A **throwing** predicate counts as approval-required (safe side). |
| `type: 'provider'` | Provider-executed: never runs locally, never breaks the loop. Built by the three factories below. |
| `outputSchema` / `timeoutMs` | Carried metadata only (never sent on chat wires, never validated — MCP populates it) / per-execution cap for **this** tool, overriding the call's `timeout.toolMs`. |

The map **key** is the name the model calls — `Tool` carries no `name` field. `ToolExecuteContext` is `execute`'s second argument: `toolCallId`, an immutable `messages` snapshot, `signal` (forward it into your `fetch`), `runtimeContext`, plus the loop-populated sub-agent seam (`agentPath`, `deps`, `approveToolCall`, `session`, `emitPart`, `reportUsage`, `approvalResponses`, `approvalSigner`, `approvalMaxAgeMs`, `execution`). Pass inherited `execution` into billable child calls.

| Tool kind | Runs where | Shape | Loop effect |
| --- | --- | --- | --- |
| Server function | Your process | `execute` set | result feeds back automatically |
| Client | Your UI / browser | key present, **no** `execute` | **breaks** the loop; you own the round-trip |
| Provider-executed | The provider, mid-turn | `type: 'provider'` + `providerTool` | never breaks the loop; citations arrive as `source` parts |
| Sub-agent | A nested loop | `agentTool({ … })` | runs a whole loop one level down |

With a Standard Schema the loop validates the model's arguments and, on failure, skips `execute` and feeds `Invalid arguments: …` back. With a raw JSON Schema there is no zero-dep validator — parsed arguments reach `execute` as-is, so annotate and narrow them yourself. Client-tool args are never validated either.

## `tool()` — argument inference, nothing else

`ToolSet = Record<string, Tool>` erases `Tool<Args, Result>`, so a hand-written literal gets `args: unknown` and editing the schema produces **no** compile error in the handler. `tool()` fixes exactly that: a **pure identity function** (`tool(def) === def`) that imports no validator and adds zero runtime behaviour.

```ts
import { generateText, stepCountIs, tool } from '@deuz-sdk/core';
import type { InferToolInput, InferToolOutput } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { z } from 'zod';
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const getWeather = tool({
  description: 'Current weather for a city.',
  parameters: z.object({ city: z.string() }),
  timeoutMs: 5_000,
  execute: async (args, ctx) => {
    // `args` is { city: string } — the schema types the handler, with no annotation.
    const res = await fetch(`https://api.example.com/w?city=${args.city}`, { signal: ctx.signal });
    return (await res.json()) as { tempC: number };
  },
});
// InferToolOutput is awaited, so a sync and an async tool report the same type.
const show = (a: InferToolInput<typeof getWeather>, o: InferToolOutput<typeof getWeather>) => `${a.city}: ${o.tempC}C`;
const res = await generateText({
  model: anthropic('claude-opus-4-8'),
  prompt: 'What should I wear in Paris today?',
  tools: { getWeather },
  maxSteps: 5, // THE DEFAULT IS 1 — without this the tool is requested but never executed
  maxToolConcurrency: 4,
  stopWhen: [stepCountIs(5)],
});
console.log(res.text, res.steps?.length, show({ city: 'Paris' }, { tempC: 22 }));
```

A raw JSON Schema has no type-level payload, so it degrades to `unknown` (deliberately not `any`). One sharp edge: calling `myTool.execute(args, ctx)` **directly** checks `args` as `unknown` — `Tool` is invariant in `Args`, so `tool()` returns an intersection to stay assignable to plain `ToolSet`. Authoring inference and the loop are unaffected.

## The agentic loop

The loop activates when **any** of `tools`, `chat`, `memory`, `mcp`, `guardrails`, `verifyStep` or `doneWhen` is present — each of the last six hangs off a loop boundary the single-turn path does not have, so the option pulls the call into the loop rather than being accepted and inert. `generateText` and `streamChat` run the same loop; only the framing differs.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `tools` | `ToolSet` | — | Presence switches the loop on. |
| `toolChoice` | `'auto' \| 'required' \| 'none' \| { type: 'tool'; toolName: string }` | `'auto'` | |
| `maxSteps` | `number` | **`1`** | Counts model turns, not tool calls: three parallel tools is one step. |
| `stopWhen` | `StopCondition \| StopCondition[]` | — | OR-ed with `maxSteps`; it can only stop **earlier**. |
| `budget` | `{ usd?: number; tokens?: number }` | — | Sugar over `costExceeds`/`totalTokensExceed` with `budget.*` markers; streaming also emits a `budget-exceeded` part. |
| `maxToolConcurrency` | `number` | `5` | Parallel `execute`s per step. |
| `onStepFinish` | `(step: StepResult) => void` | — | Fires after each step that made tool calls (breaks included). **Not** for the terminal text-only step — read `result.steps.at(-1)`. |
| `prepareStep` | `(ctx) => PrepareStepResult \| undefined` | — | Per-step overrides. A throw fails the call. |
| `activeTools` | `string[]` | — | Static filter on which keys reach the wire. |
| `runtimeContext` | `unknown` | — | Opaque per-call value threaded into tools and every hook. |
| `approveToolCall` / `approvalResponses` | approver fn / `ToolApprovalResponse[]` | — | Presence of the approver selects server-mode approval; the verdicts resume a client-mode break. |
| `guardrails` | `Guardrails` | — | `onInput` / `onToolCall` / `onOutput`. |
| `timeout.stepMs` / `timeout.toolMs` | `number` | unbounded | One step end-to-end / one `execute`. `Tool.timeoutMs` overrides `toolMs`. |

Per-step order (load-bearing): compaction → `prepareStep` → model call → append the assistant turn → handoff interception → `onToolCall` guardrails → approval gate → client-tool break → `executeTools` → append **one** tool turn → `onStepFinish` → runaway guard → `stopWhen`/`maxSteps`/`budget` → checkpoint. Once per run leg before the first iteration: MCP connect, handoff catalog capture, `activeTools` filtering, pending-approval settle, memory recall, `onInput` guardrails. The invariants below are enforced and pinned by tests — treat them as contracts.

- **`maxSteps` defaults to 1.** With tools set and `maxSteps` untouched you get `finishReason: 'tool_calls'`, empty `text`, and a tool whose result the model never saw. The single most common mistake.
- **Continuation keys on accumulated `tool_use`, never `finishReason`.** A live Gemini probe returned `STOP` in the same response as a `functionCall`. Do not add your own `finishReason` check, and do not branch `stopWhen` on it — branch on `toolCalls.length`.
- **Immutable history.** Every step builds a new `[...messages, assistantTurn, toolTurn]`; prompt-cache hits, React state and durable checkpoints all depend on it. And **every `tool_use` id gets a `tool_result`** on every exit path including suspensions (Anthropic 400s otherwise) — never append tool results from inside `execute`.
- **Self-healing:** a thrown `execute` never propagates; it becomes an `is_error` `tool_result` the model can react to. An **unregistered** name self-heals too (1.9) — `No such tool: "x". Available tools: a, b.` and the loop continues; own keys only, so `toString`/`constructor` are unknown as well.
- **Runaway guard:** the same tool name erroring on **3 consecutive steps** hard-stops the run regardless of `maxSteps`. One success resets that tool's counter.
- **Parallel, capped:** `toolResults` order is preserved relative to `toolCalls`, so index pairing is safe.
- **The loop does not** plan, validate results against `outputSchema`, deduplicate calls, retry a step that failed after streaming began, or bound wall-clock (use `durationExceeds` / `timeout.stepMs`).

| Error cause | What the model sees | Counts toward the runaway guard |
| --- | --- | --- |
| `execute` threw | the thrown error's own message | yes |
| Standard Schema rejected the args | `Invalid arguments: …` | yes |
| Name not in `tools` | `No such tool: "x". Available tools: …` | yes |
| `timeoutMs` / `timeout.toolMs` expired | `Tool 'x' timed out after Nms and was abandoned.` | yes |
| Registered tool with no `execute`, reached anyway | `No server-side executor.` | yes |
| Approval denied (server mode) | `Tool call denied.` (+ reason) | **no** |
| `onToolCall` guardrail blocked it, or `maxHandoffs` was reached | `Blocked by guardrail 'name': reason` / `Handoff limit (N) reached; continue yourself.` | **no** |

Timeouts **abandon, they do not kill**: the tool's `signal` is aborted and the orphaned promise gets a no-op catch. A tool that ignores `signal` keeps burning resources in the background — cap the work inside the tool too.

## Stopping: conditions, budgets and `stoppedBy`

`StopCondition` is `(info: { steps; stepCount; usage?; costUSD?; elapsedMs? }) => boolean | Promise<boolean>`, evaluated at the **step boundary** after tools ran — never mid-batch, which is what keeps every `tool_use` answered.

| Exported condition | Stops when | Requires |
| --- | --- | --- |
| `stepCountIs(n)` | `stepCount >= n` | — |
| `hasToolCall(name)` | the latest step called that tool | — |
| `totalTokensExceed(n)` | cumulative **real** provider-reported usage crosses `n` | — |
| `costExceeds(usd)` | cumulative cost crosses `usd` | `deps.priceProvider` — without one it warns **once**, then never fires |
| `durationExceeds(ms)` | the loop has run `ms` | nothing (time comes from `deps.clock`) |

All five ship from `@deuz-sdk/core` and `/edge`; a hand-written inline predicate works identically and reports as `'custom'`. A budget stop **does not change `finishReason`** — the union is locked, so it stays whatever the model returned (typically `'tool_calls'`). Read `result.providerMetadata?.deuz?.stoppedBy`, or the streaming `finish` part's metadata:

| `stoppedBy` | Meaning |
| --- | --- |
| `'stepCountIs'`, `'hasToolCall'`, `'totalTokensExceed'`, `'costExceeds'`, `'durationExceeds'` | that named condition fired |
| `'budget.usd'`, `'budget.tokens'` | the `budget` option tripped; `'custom'` = an unnamed `stopWhen` predicate |
| `'guardrail:input'`, `'guardrail:output'`, `'false-finish'` | a guardrail block, or a spent `doneWhen` re-drive budget, ended the run |
| absent | natural end, or the implicit `maxSteps` bound (deliberately unmarked) |

## Per-step control: `activeTools`, `prepareStep`, `runtimeContext`

`activeTools?: string[]` is the static filter: only these keys are sent, every step. Unknown names warn and are ignored; a list matching **nothing** fails **open** (the full set is sent) rather than starving the model. `prepareStep` runs before every model call, **after** automatic compaction, so it sees and has the last word on the compacted history.

```ts no-verify
// ctx: { stepIndex: number; messages: Message[]; usage: Usage; runtimeContext?: unknown }
interface PrepareStepResult {
  messages?: Message[];    // base history for THIS and every FOLLOWING step
  activeTools?: string[];  // THIS step only — OVERRIDES the static list (does not intersect it)
  toolChoice?: ToolChoice; // THIS step only
  model?: LanguageModel;   // THIS step only — return it every step to persist a swap
}
```

Because `messages` persists forward, `prepareStep` doubles as a user-controlled compaction and system-prompt-rewrite hook: rewrite the system-role message inside `messages`, there is no separate `system` field here. Typical use is cheap exploration steps on a small model with `activeTools: ['search']`, then a strong model for the final synthesis. A throw fails the call — it is your code and is never swallowed.

`runtimeContext?: unknown` is threaded **untouched** into `ToolExecuteContext.runtimeContext`, `prepareStep`, `verifyStep`, `doneWhen` and all three guardrail hooks; sub-agents inherit it. The SDK never reads, copies or serializes it, so it never reaches a checkpoint, chat record or observation event — a live DB handle or a secret is safe there. Define your `ToolSet` once at module scope and pass the tenant per call instead of rebuilding the tool set per request. It is `unknown` on purpose: cast it once at the top of each consumer.

## Client tools — the loop hands the call back

A key **present in `tools`** with no `execute`. When a step calls one, the loop appends the assistant turn, stops, and returns the pending call(s) in `result.toolCalls` (and as `tool-call` parts on `fullStream`). **Nothing else in that batch runs** — the whole batch is deferred, which is how the "every id answered" invariant survives. Your code appends a `role: 'tool'` message answering **every** pending `toolCallId`, then calls again.

```ts
import { generateText } from '@deuz-sdk/core';
import type { Message, ToolResultPart, ToolSet } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
declare function confirmInUi(input: unknown): Promise<boolean>;
const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');
const tools: ToolSet = {
  confirmPurchase: {
    description: 'Ask the user to confirm a purchase before charging.',
    parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
    // no `execute` — this is the client tool
  },
};
let messages: Message[] = [{ role: 'user', content: 'Buy SKU-42 for me.' }];
const first = await generateText({ model, messages, tools, maxSteps: 5 });
messages = [...messages, ...first.response.messages]; // ends with the assistant tool_use turn
const content: ToolResultPart[] = [];
for (const call of first.toolCalls ?? []) {
  const confirmed = await confirmInUi(call.args); // client args are NOT validated for you
  content.push({ type: 'tool_result', toolUseId: call.toolCallId, result: { confirmed } });
}
// One `role: 'tool'` message answering EVERY pending id, then call again.
const second = await generateText({ model, messages: [...messages, { role: 'tool', content }], tools, maxSteps: 5 });
console.log(second.text);
```

A route serving client tools must validate its body with `validateChatRequest(body, { rejectToolResults: false })` — the round-trip POSTs a `role: 'tool'` turn. See `references/streaming-ui.md`.

## Approval — `needsApproval` in two modes

The mode is chosen by one thing: whether you passed `approveToolCall`. **Server mode** — the approver is awaited per gated call and the loop never pauses. `false` or a throw denies; the denial becomes an `is_error` `tool_result` and the run continues. This is the mode that inherits into sub-agents at every depth. **Client mode** — omit `approveToolCall` and a gated call **breaks** the loop exactly like a client tool: `generateText` returns `pendingApprovals: ToolApprovalRequest[]` (`{ approvalId, toolCallId, toolName, input, agentPath?, token? }`; `approvalId === toolCallId` today) and streaming emits one `tool-approval-request` part per pending call.

```ts
import { generateText } from '@deuz-sdk/core';
import type { LanguageModel, Message, ToolApprovalResponse, ToolSet } from '@deuz-sdk/core';
declare const model: LanguageModel;
declare const tools: ToolSet; // at least one tool has needsApproval: true
declare const messages: Message[];
declare function askHuman(pending: unknown): Promise<ToolApprovalResponse[]>;
const first = await generateText({ model, messages, tools, maxSteps: 6 });
if (first.pendingApprovals) {
  const verdicts = await askHuman(first.pendingApprovals); // { approvalId, approved, reason?, token? }
  const history = [...messages, ...first.response.messages];
  const settled = await generateText({ model, messages: history, tools, maxSteps: 6, approvalResponses: verdicts });
  console.log(settled.text);
}
```

Settle rules on the resume leg, run before the first model call: approved calls execute; denied become `is_error` `'Tool call denied.'` plus your `reason`; **a gated call with no matching verdict is DENIED**, not left pending; deferred non-gated server tools from a mixed batch execute automatically; unanswered client tools self-heal as `is_error`; unknown `approvalId`s are ignored (replays are safe). Results append as a **new** `role: 'tool'` message and stream as `tool-result` parts before the first `step-start`. `onToolCall` guardrails are **re-evaluated** on that leg — a suspension must not launder a blocked call.

A denial is `state: 'error'` **plus** `denied: true` on the streaming `tool-state` part; `ToolRunState` deliberately gains no 7th member, so branch on `state === 'error' && denied`. `deniedReason` is the denier's own words: a client verdict's `reason` verbatim, `'No approval response.'`, `'No result provided for this client tool.'`, or `'Approval token missing, invalid, expired, or bound to another run.'`. A server-mode approver returns a boolean, so its refusal sets `denied: true` with **no** reason. A tool that merely threw gains no denial fields. The buffered `generateText` loop emits no `tool-state` parts at all.

`approvalResponses` is a **trust boundary**: a verdict from a browser is untrusted input. Bind it to the authenticated session, or sign the request server-side with `createApprovalSigner` (`@deuz-sdk/core/durable`) and pass `approvalSigner` + `approvalMaxAgeMs` — an approval without a verifying token is denied.

## Provider-executed tools

Registered like any tool, run by the provider mid-turn, never local, never a loop break. Citations normalize into canonical `source` parts; billed uses land on `usage.serverToolUses`.

| Factory | Wire it needs | Build the model with | Config fields |
| --- | --- | --- | --- |
| `anthropicWebSearch(config?)` | Anthropic Messages | `createAnthropic` | `AnthropicWebSearchConfig`: `type` (default `'web_search_20260318'`), `max_uses`, `allowed_domains`, `blocked_domains`, `user_location`, `allowed_callers`, `response_inclusion` |
| `openaiWebSearch(config?)` | OpenAI **Responses** | `createOpenAIResponses` | `OpenAIWebSearchConfig`: `search_context_size`, `filters`, `user_location`, `return_token_budget`, plus arbitrary passthrough keys |
| `googleSearch()` | Gemini **native** `generateContent` | `createGoogleNative` | none |

All three are root exports (and on `/edge`). A `type: 'provider'` entry registered against a `chat_completions`-surface model (`createOpenAI`, xAI, `createGoogle`) is **silently filtered out** of the request — it never errors, it just never happens. Use the surface each factory targets.

## `createAgent` — an agent as a frozen value

`@deuz-sdk/core/agent` (also on `/edge`). Not a class: a factory returning a frozen plain object of closures, so `agent.streamChat(o)` **is** `streamChat({ ...def, ...o })` and every invariant is inherited — `streamChat`/`streamObject` stay synchronous and never throw.

```ts
import { agentTool, generateText } from '@deuz-sdk/core';
import type { Tool } from '@deuz-sdk/core';
import { createAgent } from '@deuz-sdk/core/agent';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
declare const lookupOrder: Tool;
declare const webSearch: Tool;
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const support = createAgent({
  name: 'support', // observation label + asTool()'s agentPath segment; never on a wire
  model: anthropic('claude-opus-4-8'),
  instructions: 'You are a terse support agent.',
  tools: { lookupOrder },
  maxSteps: 8, // remember: the default is 1
});
const strict = support.with({ temperature: 0 }); // a NEW frozen agent; the original is untouched
const answer = await strict.generateText({ prompt: 'where is order 12?' });
const orchestrated = await generateText({
  model: anthropic('claude-opus-4-8'),
  prompt: 'Research the pricing question, then answer the customer.',
  maxSteps: 6,
  tools: {
    support: support.asTool({ description: 'Answer an order question.' }),
    researcher: agentTool({
      name: 'researcher', // SAME string as the map key
      description: 'Delegate research to a focused sub-agent.',
      model: anthropic('claude-haiku-5'),
      tools: { webSearch },
      maxSteps: 6,
      subAgentStream: 'none',
    }),
  },
  approveToolCall: async () => true, // inherited into every sub-agent depth
});
console.log(answer.text, orchestrated.usage.totalTokens);
```

- **Merge rule, one sentence:** shallow **top-level** spread. A per-call key **replaces** the def's value whole — including `tools`, `deps`, `providerOptions` and `stopWhen` arrays. An explicit `undefined` **unsets** it. Opt into merging yourself: `{ deps: { ...support.def.deps, observer } }`. `with(overrides)` applies the same rule and returns a new agent, and `def` is a shallow-frozen **copy**, so mutating your original object afterwards changes nothing.
- **`generateObject` on an agentic def fails by design** — structured output refuses loop options. The merge rule is the fix: `support.generateObject({ schema, prompt, tools: undefined, maxSteps: undefined })`, or bake it once with `with(...)`.
- **`asTool()` forwards only** `model`, `tools`, `instructions` (→ `system`), `maxSteps`, `stopWhen`, `compaction`, `name`. Sampling params, `verifyStep`, `deps`, `timeout` and `memory` do **not** cross — the sub-agent reuses the parent's transport and approval flow. Omitted fields keep `agentTool`'s defaults (`maxSteps` 10, `maxDepth` 2).

## `agentTool` — delegate and come back

`AgentToolDef`: `name`, `description`, `model`, `tools?`, `system?`, `maxSteps?` (default **10**), `maxDepth?` (default **2**), `needsApproval?`, `compaction?`, `stopWhen?`, `subAgentStream?: 'full' | 'none'` (default `'full'`). The input schema is fixed to `{ prompt: string }` and the tool returns the sub-agent's final text. **Use the same string for the map key and `name`** — nothing enforces it, and a mismatch just makes `agentPath` confusing to read.

- **Live visibility.** With a streaming parent, the sub-agent's entire canonical stream forwards into the parent's `fullStream` as `{ type: 'sub-agent', agentPath, part }`, tagged with the full path (`['researcher']`, `['researcher','coder']` one level down — single-wrapped, never nested). `subAgentStream: 'none'` runs it silently; a buffered `generateText` parent is always silent and just gets the text back as a `tool_result`.
- **Approval inheritance.** The parent's server-mode `approveToolCall` is inherited to every depth. Client-mode approval inside a sub-agent requires the parent call to carry `session` (the child suspends into its own checkpoint and the parent's pending approvals are `agentPath`-tagged); with no session and no inherited approver, a gated sub-agent call comes back as a clear `is_error`.
- **Usage folds up:** a sub-agent's cumulative usage counts in `result.usage`, in budget stops and in cost; its `onUsage` events carry `meta.agentPath`. **`maxDepth`** is checked against the path length at call time; exceeding it throws inside `execute` and therefore self-heals into an `is_error` the parent model can recover from.
- The parent `signal` propagates into every sub-agent loop. `guardrails` do **not** — see below. In a `useChat` UI a sub-agent run lands in `turn.subAgents`, not in the parent's `parts`.

## `handoff()` — transfer the run, don't delegate it

`handoff(agents, options?)` mints one `transfer_to_<name>` tool per target. When the model calls one, the loop swaps the **active agent**: system prompt, tool set and model become the target's, and the whole history travels with it.

| | `handoff()` — transfer | `agentTool()` — delegation |
| --- | --- | --- |
| History | travels with the transfer | not carried; fresh `{ system, prompt }` |
| Who drives after | the target, for the rest of the run | the parent — it never stopped |
| Result | *is* the run's answer | comes back as a `tool_result` |
| Loop shape | one loop, changing identity | two loops, nested |
| Stream signal | `handoff` part | `sub-agent` parts |
| Metadata | `providerMetadata.deuz.handoffs` | usage per `agentPath` |
| Guardrails | **kept** (they are run-level) | **not inherited** |

Targets are `Record<string, DeuzAgent | HandoffAgentDef>`; `HandoffAgentDef` carries exactly four fields — `model`, `instructions?`, `tools?`, `name?` — because everything else (`deps`, timeouts, `memory`, `session`, `guardrails`, budgets) belongs to the **run**, not the agent driving it. A `createAgent` value is accepted and only those four fields are read off it. The record **key** names the tool and appears in `HandoffPart.to`. `HandoffOptions`: `maxHandoffs?` (default **5**), `describe?: (name) => string` (the sentence appended to each transfer tool's description; default is the target's `instructions`), `onHandoff?: ({ from?, to, reason? }) => void` (throws propagate). Construction validates eagerly — an empty key or a target with no `model` throws a `TypeError` immediately, not on the step where the model calls it.

```ts
import { handoff, streamChat } from '@deuz-sdk/core';
import type { Message, Tool } from '@deuz-sdk/core';
import { maxOutputLength, promptInjectionGuardrail } from '@deuz-sdk/core/guardrails';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
declare const refund: Tool;
declare const messages: Message[];
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const haiku = anthropic('claude-haiku-5');
const result = streamChat({
  model: haiku, // the ROOT agent — its own identity is `undefined`, hence HandoffPart.from being absent
  instructions: 'Route the customer, then transfer.',
  messages,
  // The router is duplicated as a target, because that is the only way back to it.
  tools: handoff(
    {
      triage: { model: haiku, instructions: 'Route the customer, then transfer.' },
      billing: { model: anthropic('claude-sonnet-5'), instructions: 'You handle refunds.', tools: { refund } },
    },
    { maxHandoffs: 4, describe: (name) => `Transfer when the problem is clearly about ${name}.` },
  ),
  maxSteps: 10,
  guardrails: { onInput: promptInjectionGuardrail(), onOutput: maxOutputLength(4000) },
  approveToolCall: async () => true, // belongs to the RUN — survives every transfer
});
for await (const part of result.fullStream) {
  if (part.type === 'handoff') console.log(`${part.from ?? 'root'} → ${part.to}: ${part.reason ?? ''}`);
  else if (part.type === 'guardrail') console.log(`guardrail ${part.hook} ${part.action}`);
  else if (part.type === 'text-delta') process.stdout.write(part.text);
  // StreamPart is an OPEN union — always keep a default/else branch.
}
```

Mechanics to plan around: interception is **deterministic** and happens **before** guardrails, the approval gate and `executeTools`, so a transfer is never blocked by `onToolCall` and never queued for approval. **One transfer per step** — the first in the model's emission order wins, sibling transfers get an `is_error`, and the rest of the batch still runs. `instructions` **replaces** the leading system turn (a target with none strips the run's system prompt for every following step — restate it there). The target gets its own tools plus every transfer tool except its own, and the transfer catalog is captured once from the root tool set, so pass the same `handoff({…})` group on every leg. `maxHandoffs` self-heals into an `is_error` and is excluded from the runaway guard; the count is checkpointed. Pricing keeps using the **root** model after a transfer, so bound such runs with `budget.tokens` too; compaction follows the active agent, except on a durable resume leg where it keeps measuring against the root model until the next transfer — pin `compaction.summarizeModel` there.

## Guardrails

Four hooks, three verdicts, plain functions. Contract types on `CommonCallOptions`; built-in values on `@deuz-sdk/core/guardrails` (`promptInjectionGuardrail`, `maxOutputLength`, `maxToolResultLength` (2.2), `PROMPT_INJECTION_POLICY` — `promptInjectionGuardrail`, `maxOutputLength` and `maxToolResultLength` are also root and `/edge` exports).

| Hook | Runs | `block` | `rewrite` |
| --- | --- | --- | --- |
| `onInput` | once per run leg, before any model call | run ends with `text: ''` and `stoppedBy: 'guardrail:input'`; **no provider request** | `{ messages }` replaces the history the run starts from |
| `onToolCall` | per call, **before** the approval gate | `is_error` `tool_result`, run **continues** | `{ args }` substitutes what the gate and `execute` see |
| `onToolResult` (2.2) | per executed tool, after it returns, **before the model sees it**; once the whole batch settled, in call order | the result becomes an `is_error` `tool_result` carrying the reason; run **continues** | `{ result }` replaces what the model sees — authoritative for history, `steps[].toolResults`, the stream part and the checkpoint |
| `onOutput` | at a natural completion, after `doneWhen` + `verifyStep` | text suppressed, `replacement ?? ''` returned, `stoppedBy: 'guardrail:output'` | `{ text }` replaces the final answer |

`undefined` and `{ action: 'pass' }` are the same thing and emit nothing. Each hook takes one guardrail or an ordered array: the array runs in order, rewrites **chain** (the next sees the previous one's output), the first `block` short-circuits that hook, and a **throw propagates** — a silently swallowed safety control is the worse failure. Order cheapest and most decisive first.

```ts
import { generateText } from '@deuz-sdk/core';
import type { LanguageModel, Message, OutputGuardrail, ToolCallGuardrail, ToolSet } from '@deuz-sdk/core';
import { maxOutputLength } from '@deuz-sdk/core/guardrails';
declare const model: LanguageModel;
declare const tools: ToolSet;
declare const messages: Message[];
interface Ctx { tenantId: string; allowShell: boolean }
const shellPolicy: ToolCallGuardrail = (ctx) => {
  const { allowShell } = ctx.runtimeContext as Ctx; // typed `unknown` — cast once
  if (ctx.toolCall.toolName !== 'shell' || allowShell) return undefined; // pass
  return { action: 'block', reason: 'shell is disabled for this tenant' };
};
const noSecrets: OutputGuardrail = (ctx) =>
  /sk-[A-Za-z0-9]{16,}/.test(ctx.text)
    ? { action: 'block', reason: 'answer contained an API key', replacement: 'Redacted.' }
    : undefined;
const res = await generateText({
  model,
  messages,
  tools,
  maxSteps: 8,
  runtimeContext: { tenantId: 't_42', allowShell: false } satisfies Ctx,
  guardrails: { onToolCall: shellPolicy, onOutput: [noSecrets, maxOutputLength(4000)] },
});
console.log(res.providerMetadata?.deuz?.stoppedBy, res.providerMetadata?.deuz?.guardrails);
```

- **A blocked tool call joins the existing denial machinery:** an `is_error` `tool_result` naming the rule (`Blocked by guardrail 'shellPolicy': …`), a `denied` tool-state part, **exclusion from the runaway guard**, and the run continues. It never reaches the approval gate; a blocked *client* tool is answered in the same turn instead of breaking the loop. Observation reports the cause as `'server-denied'`.
- **`onToolResult` sees only output a tool produced** (a success, or a throw/timeout as `isError: true` with the self-heal message); SDK-authored answers (denials, unknown tools, argument validation failures) never reach it. `ctx.toolCall` carries the arguments after any `onToolCall` rewrite. A **blocked result counts toward the runaway-error guard** (the tool did run), unlike a blocked call. It runs in `generateText`, `streamChat` and native `runAgent`; in a native run it guards the model-facing projection while the receipt keeps the raw result. Verdicts report `hook: 'tool-result'` with `toolCallId`. `maxToolResultLength(n, { mode?: 'truncate' | 'block' })` caps each result at `n` characters (non-strings measured as JSON) and tells the model how much it cut.

```ts
import { generateText } from '@deuz-sdk/core';
import type { ToolResultGuardrail } from '@deuz-sdk/core';
import { maxToolResultLength } from '@deuz-sdk/core/guardrails';
import { createMockModel } from '@deuz-sdk/core/testing';

const redactKeys: ToolResultGuardrail = (ctx) =>
  typeof ctx.result === 'string' && /sk-[A-Za-z0-9]+/.test(ctx.result)
    ? { action: 'rewrite', result: ctx.result.replace(/sk-[A-Za-z0-9]+/g, 'sk-[redacted]') }
    : undefined;

const res = await generateText({
  model: createMockModel({
    responses: [{ toolCalls: [{ toolName: 'readFile', args: { path: '.env' } }] }, { text: 'It sets a key.' }],
  }),
  prompt: 'What does .env configure?',
  tools: {
    readFile: {
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => 'OPENAI_API_KEY=sk-live123456',
    },
  },
  maxSteps: 3,
  guardrails: { onToolResult: [redactKeys, maxToolResultLength(8_000)] },
});
console.log(res.steps?.[0]?.toolResults[0]?.result); // 'OPENAI_API_KEY=sk-[redacted]'
```

- **A tool-argument rewrite does not rewrite history.** The assistant turn and the `tool-call` part keep the arguments the *model* issued; only the gate and `execute` see the new ones. An **output** rewrite is the opposite — authoritative, so `response.messages`, `steps[]`, the checkpoint and the chat record all match what you were handed.
- **Neither `stoppedBy` marker is an error,** and `finishReason` will not tell you (an input block reports `'stop'`). Every non-pass verdict emits one `guardrail` part (`{ hook, action, name?, reason?, toolCallId?, stepIndex? }`) and is collected on `providerMetadata.deuz.guardrails`; a rewrite carries no `reason`. Verdicts produced on a resume-leg settle carry no `stepIndex`.
- **Names come from the function:** `const noSecrets: OutputGuardrail = …` reports `'noSecrets'`, but an anonymous array element reports nothing (and gives the model a vaguer message). Set one with `Object.defineProperty(fn, 'name', { value: 'myRule', configurable: true })` — a plain `fn.name = '…'` throws in strict mode. **Built-ins:** `promptInjectionGuardrail({ policy? })` prepends a spotlighting system turn built from `PROMPT_INJECTION_POLICY` (always a `rewrite`, so it always emits one part); `maxOutputLength(n, { mode?: 'truncate' | 'block' })` caps the final answer at `n` **characters** with a plain `slice`.
- **Sub-agents do NOT inherit guardrail callbacks.** `agentTool` forwards `runtimeContext`, approvals/signers, abort signals and the mandatory `execution` context, but not guardrail hooks. In 2.1 a child cannot loosen inherited execution allowlists, approval requirements, depth, deadline or budget. A **handoff** keeps the run's guardrails. See `references/native-execution.md` for the policy contract.
- **`generateObject` / `streamObject` reject `guardrails`** (and `mcp`, `tools`, `maxSteps > 1`, `session`, …) with an `InvalidRequestError` before any network request. Use native `runAgent({ tools, guardrails, output })` for one validated run, or retain the existing `generateText` then `generateObject` composition.

Guardrails wrap the **run**; `wrapModel(model, [...])` middleware wraps the **model** and therefore also covers compaction summaries and sub-agent side calls. Use middleware for an instruction that must ride on literally every request, guardrails for decisions that must be visible and able to stop the run.

## Deep dive

- [/docs/agents/tools](/docs/agents/tools) — the `Tool` shape, schemas, `tool()`, `toolChoice`, budget conditions.
- [/docs/agents/tool-loop](/docs/agents/tool-loop) — per-step ordering, stop conditions, the self-healing table, streaming parts.
- [/docs/agents/client-tools](/docs/agents/client-tools) — the round-trip and the approval resume, end to end.
- [/docs/agents/server-tools](/docs/agents/server-tools) — provider-executed tools and their wires.
- [/docs/agents/create-agent](/docs/agents/create-agent) — the merge rule and `asTool()`.
- [/docs/agents/subagents](/docs/agents/subagents) — `agentTool`, live sub-streams, approval inheritance, `maxDepth`.
- [/docs/agents/handoffs](/docs/agents/handoffs) — transfer vs delegation, interception order, durable resume.
- [/docs/agents/guardrails](/docs/agents/guardrails) — hooks, verdicts, ordering, built-ins, guardrail vs middleware.
- [/docs/agents/durable-runtime](/docs/agents/durable-runtime) — checkpoints, suspend/resume, HMAC-signed approvals.
- [/docs/agents/unbreakable-chatbot](/docs/agents/unbreakable-chatbot) — the whole stack wired into one production call.
- [/docs/reference/whats-new-2-0](/docs/reference/whats-new-2-0) — the 2.0 surface and the stated known limits.
