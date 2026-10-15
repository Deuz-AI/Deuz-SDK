# @deuz-sdk/core

A TypeScript runtime for agents that have to survive production — **zero runtime dependencies**, 28 chat providers across four wires, and a canonical streaming protocol of its own.

**New in 2.4.** [Versioned memory](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/versioned-memory.mdx) keeps each fact with a stable id, revisions, sources and an asserted or inferred origin, written through operations with receipts. The [context compiler](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/context.mdx) places memory, RAG, past chats and the skill catalog into one token budget, with a manifest of what each step saw, next to a structured working memory, and [transcript search](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/transcript-search.mdx) finds past messages within a scope. [V3 native runs](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/native-agents.mdx) (`checkpointVersion: 3`) checkpoint the context, the working memory and the memory writes. The [goal runtime](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/goal-runtime.mdx) adds a goal supervisor, a durable time-zone scheduler, a webhook inbox and acceptance on evidence, and a local [Docker sandbox and process runner](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/docker.mdx) (a preview) reconnects after a host restart. [Conditional chat stores, durable streams (a preview) and a capability handshake](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/chat-durability.mdx) keep chats and streams consistent, embeddings, RAG, memory and verifier calls reach the [budget ledger](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/budgets.mdx), and every [cleanup](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/retention.mdx) is an explicit call. Every 2.4 feature is off until you configure it. Nothing in 2.4 was run against a model provider: model calls are tested against scripted models.

Every public API change in 2.4 is additive, so 2.3 code compiles against it, except an exhaustive `switch` over a widened union. Some behaviours change on purpose: read "Upgrading from 2.3" in the [2.4 notes](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/reference/whats-new-2-4.mdx) before you deploy.

**New in 2.3.** Native runs take [`memory`, `chat` and `fallbackModels`](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/native-agents.mdx), and every tool call, local or MCP, takes one path: policy, approval, budget admission and an effect receipt. The [MCP client](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/mcp.mdx) speaks MCP 2026-07-28 next to 2025-11-25, and an [MCP server](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/mcp-server.mdx) publishes your tools and agents. [A2A](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/a2a.mdx) calls other agents and serves your own, [realtime voice](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/realtime.mdx) runs on OpenAI Realtime and Gemini Live, and [batch requests](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/batch.mdx) go to the OpenAI, Anthropic and Gemini batch APIs. [Redis backends](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/operations.mdx) hold swarms, leases, native runs, schedule claims and budgets, and the Redis store pack gains `runs`. [`toDeuzAgentStreamResponse`](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/ui-streaming.mdx) puts a native run on the UI wire, [`runEvalSuite`](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/evals.mdx) runs versioned eval tasks, [`@deuz-sdk/core/headless`](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/headless.mdx) (a Node-only preview) runs native runs from a script or a CI job, [`resolveModelProfile`](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/model-profiles.mdx) reports what a model accepts before you call it, and the agentic loops keep the [request prefix stable](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/agents/preserved-thinking.mdx) for the Claude 5.x models that bind thinking to it. Nothing in 2.3 was run against a live provider or third-party service; it is tested offline.

Every public API change in 2.3 is additive, so 2.2 code compiles against it, except an exhaustive `switch` over a widened union and a hand-built `RedisStores`. Some defaults and request shapes change on purpose, and some data 2.3 writes needs 2.3 to resume: read "Upgrading from 2.2" in the [2.3 notes](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/reference/whats-new-2-3.mdx) before you deploy.

[What's new in 2.4](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/reference/whats-new-2-4.mdx) · [What's new in 2.3](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/reference/whats-new-2-3.mdx) · [Native agents](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/native-agents.mdx) · [Swarm](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/swarm.mdx) · [Changelog](https://github.com/Deuz-AI/Deuz-SDK/blob/main/packages/core/CHANGELOG.md)

```bash
npm i @deuz-sdk/core
```

```ts
import { streamChat } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-opus-4-8');
const result = streamChat({ model, messages: [{ role: 'user', content: 'Merhaba!' }] });
for await (const text of result.textStream) process.stdout.write(text);
```

`streamChat` returns **synchronously and never throws**: failures arrive as typed parts on the stream.

## Native agents: typed output and explicit outcomes

The following complete example uses a deterministic model and needs no API key:

```ts
import { runAgent } from '@deuz-sdk/core/agent';
import { createMockModel } from '@deuz-sdk/core/testing';

const result = await runAgent({
  model: createMockModel({ responses: [{ text: '{"answer":42}' }] }),
  prompt: 'Return the answer as JSON.',
  output: {
    mode: 'json',
    schema: {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
    },
    validate(value) {
      if (
        value === null ||
        typeof value !== 'object' ||
        !('answer' in value) ||
        typeof value.answer !== 'number'
      ) {
        throw new Error('Expected a numeric answer');
      }
      return { answer: value.answer };
    },
  },
  verify: ({ output }) =>
    output.answer === 42
      ? { status: 'verified' }
      : { status: 'rejected', feedback: 'Check the calculation.' },
  maxSteps: 4,
});

if (result.status === 'completed') console.log(result.output.answer);
else console.log(result.status); // suspended, stopped, or failed
```

Only `completed` contains an accepted `output`. Raw JSON Schema requires a runtime validator; Standard Schema can provide its own. `streamAgent` returns synchronously and starts when consumed, with separate draft and array-element streams. Verification is `verified`, `rejected` or `inconclusive`, with bounded retries.

Tool execution uses the canonical loop; finalization is one more turn that offers the loop's tools with `tool_choice: 'none'` and validates its own output. Since 2.3 every tool call takes one path, in one order: the finish-reason gate (a refused or cut-off turn runs none of its calls), the execution policy, the approval gate, budget admission, the effect receipt, execution, `onToolResult` and the step checkpoint. Local tools, MCP tools, handoff transfers and sub-agent calls all take it. Tools can validate their own context and result, retain a raw result receipt, and use `toModelOutput` to project what the model receives.

Native sessions store a versioned `AgentRunEnvelope` through `AgentRunStore`; this is separate from the legacy `SessionStore` checkpoint contract. `resumeAgent` checks identity and bindings, preserves pending approvals when verdicts are absent, and reuses completed stored results. Since 2.3 the binding also covers the MCP tool catalog, handoff targets, the memory scope, the chat and the fallback models, and `lease: { provider, owner?, ttlMs? }` keeps two processes from driving one run. Failed durable writes stop execution. The [native guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/native-agents.mdx) covers stores, approval/client-tool resume, reconciliation, and memory, chat and model fail-over.

## Swarm: bounded parallel tasks

```ts
import { createAgent } from '@deuz-sdk/core/agent';
import { createSwarm, createInMemorySwarmStore } from '@deuz-sdk/core/swarm';
import { createMockModel } from '@deuz-sdk/core/testing';

const worker = createAgent({
  model: createMockModel({ responses: [{ text: 'checked' }] }),
  maxSteps: 4,
});
const swarm = createSwarm({
  agents: { worker: { agent: worker, version: 'worker-v1' } },
  reducers: {
    report: {
      version: 'report-v1',
      execute: (results) =>
        Object.fromEntries(Object.entries(results).map(([id, result]) => [id, result.output])),
    },
  },
  store: createInMemorySwarmStore(),
  concurrency: 2,
  definitionVersion: 'review-v1',
});
const handle = await swarm.run({
  scope: 'tenant-a',
  runId: 'review-1',
  tasks: [
    { id: 'facts', agent: 'worker', prompt: 'Check the facts.' },
    { id: 'math', agent: 'worker', prompt: 'Check the calculations.' },
    { id: 'report', reducer: 'report', dependsOn: ['facts', 'math'] },
  ],
});
const outcome = await handle.result;
console.log(outcome.run.status);
console.log(outcome.tasks.find((task) => task.task.id === 'report')?.result?.output);
```

Swarm runs a DAG of agents and reducers, with dependency handling, cancellation and a cursor-based control-event journal. With `dynamic` limits (2.2), finished tasks spawn more tasks at runtime; tasks in a `group` share a blackboard, and `createRounds` chains rounds of grouped agents. The in-memory store is volatile. The Node-only `@deuz-sdk/core/swarm/sqlite`, `@deuz-sdk/core/swarm/postgres` (2.2) and `@deuz-sdk/core/swarm/redis` (2.3) entries atomically persist run state, tasks and journal events. Completed tasks are reused; uncertain effects need reconciliation before replay. With the `lease` option (2.2), several processes share runs: the executor holding a run's lease drives it, and `handle.drain()`, `swarm.recover()` and `swarm.requestCancel(key)` drain a run for a deploy, take over runs whose executor died, and cancel a run from any process. Without a lease provider, drive each run from one process. [Swarm guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/swarm.mdx) · [Operations](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/operations.mdx).

`createExecutionContext` adds inherited model/tool policy and shared token/USD accounting. Native sessions persist reservations before dispatch; known usage settles them, while a call whose usage the provider did not report keeps its amounts held as unknown. A native reservation prices the output cap the request sends, reasoning included. Since 2.3 a model without a price runs under a USD budget: its tokens are reserved and recorded, its cost stays out of the USD totals, and each leg of the run reports one `unpriced-model` warning per model; `budget.unknownPrice: 'reject'` refuses it before it is sent. Budget admission uses estimates and cannot guarantee a provider's final invoice. Native sessions preserve an existing shared ledger rather than resetting it on resume. Budgets shared across runs persist in the SQLite, Postgres or Redis budget stores.

## Memory and context for long runs

**Memory that outlives the session.** Not a message array — a pipeline that extracts durable facts, reconciles them against what it already knows (add / update / delete, never blind appends), scores them for importance, expires them, and pulls the relevant ones back on the next call.

```ts
await generateText({
  model,
  messages,
  memory: {
    seams, // MemorySeams: { store, embedder, llm, clock, generateId }
    scope: { userId },
    recall: { topK: 6, maxChars: 2000, expandLinks: 1 },
  },
});
```

`seams` holds the memory store, an embedder, the extraction `llm` (a `({ system, user }) => Promise<string>` function, usually a cheap model behind `generateText`), a clock and an id source; the [memory guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/memory.mdx) builds one. Native runs take the same `memory` option since 2.3: they recall once, before the first model call, and extract only after the run completed, so a resume never recalls or extracts again.

**Compaction that keeps a long run alive.** When the window fills, it prunes stale tool output, drops old reasoning, and folds the earliest turns into a single running summary — one block that gets updated, not a stack that grows. When a provider rejects a request as too long anyway, the loop force-compacts and retries that step instead of failing the run. For the models that bind thinking to the transcript prefix (Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5), a pass is one summary that replaces the earlier turns, with no pruning layers (2.3).

```ts
await generateText({ model, messages, maxSteps: 30, compaction: 'auto' });
```

## What else is in the box

- **Edge-safe core** — Web APIs only; everything stateful or non-deterministic (clock, randomness, `fetch`, keys, logging, tracing) is injected through one `Dependencies` seam.
- **Canonical stream** — every provider's SSE is normalized to one typed delta stream _before_ anything else touches it. Retries, timeouts, tool loops, fail-over and the UI wire all build on that one language.
- **Agentic loop** — parallel tool execution, self-healing tool errors, runaway guards, budget and stop conditions, durable checkpoints, HMAC-signed human approvals, sub-agents, and **agent handoffs** that move the conversation, tools and model together.
- **Guardrails** — `onInput` / `onToolCall` / `onOutput`, each returning pass / block / rewrite, reported on the stream rather than applied invisibly.
- **Persistence you point at a database** — SQLite, Redis and Postgres packs behind the `MemoryStore` / `ChatStore` / `SessionStore` / `RunStore` seams, all held to one shared conformance suite (the Redis pack serves `runs` since 2.3). Native runs, swarms, leases, schedule claims and budgets have their own SQLite, Postgres and, since 2.3, Redis stores.
- **Operations** — leases, drain, cross-process cancel and recovery, persistent budgets, cron schedules and verified webhook signals, goal records (2.3), and a headless run / resume / inspect preview for scripts and CI (2.3, Node-only).
- **Evolve** — evolutionary program search with SEARCH/REPLACE diffs, an evaluator cascade, a mandatory budget and zero-call resume.
- **MCP** — a dual-stack client for MCP 2026-07-28 (on `@modelcontextprotocol/client`) and 2025-11-25 (on `@modelcontextprotocol/sdk`), zero-config servers in the loop (`mcp: [{ url }]`), OAuth 2.0, sampling, roots, elicitation, reconnect with backoff and a cross-call connection pool; and an MCP server (2.3) that publishes tools, native agent tools and agents over Streamable HTTP and stdio.
- **A2A** (2.3) — Agent2Agent 1.0.0 over JSON-RPC and HTTP+JSON, edge-safe and dependency-free: call other agents, serve your own, a native agent run included.
- **Batteries** — RAG with hybrid retrieval, skills, structured output, middleware, pricing, model profiles, provider batch requests, eval suites, observability and an OpenTelemetry bridge.
- **Modalities** — text, images, **speech**, **transcription**, **video** and **realtime voice** (OpenAI Realtime and Gemini Live over WebSocket, 2.3).
- **React bindings** — [`@deuz-sdk/react`](https://www.npmjs.com/package/@deuz-sdk/react), which drives chat routes and, since 2.3, native agent routes.

## Providers

**28 chat provider ids**, four wires, one call shape. A _provider id_ is the string a descriptor carries and the key that resolves an API key and a base URL; a _factory_ is the function that mints descriptors for it. The two do not count the same — `createOpenAI` and `createOpenAIResponses` are two factories over the one id `openai`, and `createKimi` is an alias of `createMoonshot`. A model descriptor is a plain `{ provider, modelId, surface }` value, and factory settings ride a non-enumerable symbol, so keys never leak through `Object.keys` or `JSON.stringify`.

| Group                              | Provider ids                                                                                                                                                                                                   | Subpath                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Dedicated (9 ids)                  | `anthropic`, `openai`, `xai`, `google`, `vertex-anthropic`, `vertex-google`, `azure`, `bedrock`, `yunwu`                                                                                                       | `/anthropic`, `/openai`, `/xai`, `/google`, `/vertex`, `/azure`, `/bedrock`, `/yunwu` |
| OpenAI-compat cloud hosts (17 ids) | `groq`, `mistral`, `deepseek`, `together`, `openrouter`, `cerebras`, `fireworks`, `moonshot` (a.k.a. Kimi), `qwen`, `glm`, `minimax`, `perplexity`, `cohere`, `deepinfra`, `nvidia`, `sambanova`, `hyperbolic` | `/providers`                                                                          |
| Keyless local hosts (2 ids)        | `ollama`, `lmstudio`                                                                                                                                                                                           | `/providers`                                                                          |

`voyage` is deliberately absent: it is an embeddings provider, so it speaks none of the four chat wires and cannot be handed to `streamChat`.

Which wire each one speaks — the exhaustive `ModelSurface` → adapter switch:

| Wire (`surface`)                                 | Covers                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Anthropic Messages** (`anthropic`)             | Anthropic, Claude on Vertex                                                          |
| **OpenAI Responses** (`responses`)               | OpenAI (GPT-5.x reasoning + tools)                                                   |
| **Gemini native** (`native`, `generateContent`)  | Google Gemini, Gemini on Vertex — reasoning, thought signatures, caching, native PDF |
| **OpenAI Chat Completions** (`chat_completions`) | everything else, including Gemini-compat and Azure / Bedrock                         |

Embeddings, images, speech, transcription and video are **separate model kinds** with their own surfaces and adapters — not chat wires, and none of them can be handed to `streamChat` by accident. Embeddings ship for OpenAI, Google, Voyage and Yunwu; speech adds `openai` / `elevenlabs`, transcription adds `openai` / `deepgram`, video any OpenAI-Videos-shaped relay.

Ollama and LM Studio need **no API key** — they dial `localhost` and set the keyless escape for you, without weakening the key-precedence chain for anyone else. Any other OpenAI-shaped host gets a real provider id through `createOpenAICompatible({ id, baseURL })`, and `createProviderRegistry` resolves `'groq:llama-4-maverick'` strings.

Unknown model slugs never throw: they fall back to a conservative capability row and report an `unknown-model` warning, so a model released this morning works without an SDK release. Correct the row per factory or per call with `capabilities`. The opt-in live tests exercised that path before 2.3: `grok-4.5` and `gemini-3.6-flash` have no pinned row and ran end to end, tool loop included. 2.3 did not run them again.

`resolveModelProfile(model)` (2.3) reports what Deuz knows about a model before you call it, with no network call: each capability as supported, unsupported or unknown, the context window and output limits, the effort levels, and every value a request changes. Every value a request changes is also reported as a `clamped-setting` or `unsupported-setting` warning.

## Where it fits

Deuz is not a framework and it is not a claim about ASI. It is a small runtime you can hold in your head, for the part of the problem that does not get easier as models improve: remembering across sessions, using tools safely, surviving a crash, asking a human before something risky, and staying observable while it does.

Native runs take `chat`, `memory` and `fallbackModels` since 2.3, bound to the run's checkpoint and resume binding. The native engine still rejects the legacy completion hooks `verifyStep`, `doneWhen` and `falseFinishGuard`; use `verify`, which has its own three-outcome contract. Legacy `resumeFromCheckpoint` retains its missing-verdict default-deny behavior. Without a lease provider, drive each native or swarm run from one process; with one (`lease`, 2.2 for swarms and 2.3 for native runs), the process holding a run's lease drives it. Receipts do not provide exactly-once external effects.

The limitations are documented next to the features rather than left to be discovered: overflow recovery does not reach the Gemini native wire, `generateObject` cannot coerce a DeepSeek V4 model, the Redis store pack writes without `MULTI` (the 2.3 Redis ops, budget and swarm stores run each operation as one Lua script and need Redis 7 or later), token counting is a calibrated heuristic unless you supply a tokenizer, speech / transcription / video are covered by mocked tests but not yet by a live one, and nothing 2.3 added — the Claude 5.x request rules, realtime, batches, A2A, and MCP against third-party hosts among them — was run against a live provider or service.

Node ≥ 22, or any runtime with `fetch`. Optional peers only when you use them: `zod` (or any Standard Schema library) with `@standard-community/standard-json`, `@modelcontextprotocol/client` (MCP 2026-07-28) or `@modelcontextprotocol/sdk` (MCP 2025-11-25), `@modelcontextprotocol/server`, `react`, `unpdf` / `mammoth` / `xlsx`, `playwright`, `@opentelemetry/api`, `redis` (node-redis 4.6+, 5 or 6), `pg`.

Full documentation, architecture tour and the complete limitations list: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).

The package publishes **72 export entries, including `./package.json`**. Native APIs are in `/agent`, `/swarm` (with `/swarm/sqlite`, `/swarm/postgres` and `/swarm/redis`) and `/ops` (with `/ops/sqlite`, `/ops/postgres` and `/ops/redis`). 2.2 added `/ops`, `/ops/sqlite`, `/ops/postgres`, `/swarm/postgres`, `/evolve`, `/evolve/sqlite` and `/schedule`; 2.3 adds `/mcp/server`, `/mcp/server/stdio`, `/a2a`, `/realtime`, `/batch`, `/goal`, `/headless`, `/ops/redis` and `/swarm/redis`. Provider, memory, chat, MCP client, observability and legacy durable APIs retain their existing entry points.
