<div align="center">

# Deuz SDK

### A TypeScript runtime for agents that have to survive production

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=3b82f6)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-3b82f6?style=flat-square)](./packages/core/package.json)
[![license](https://img.shields.io/npm/l/%40deuz-sdk%2Fcore?style=flat-square)](./LICENSE)

**[Docs](./docs)** · **[Native agents in 2.1](./docs/content/docs/modules/native-agents.mdx)** · **[Swarm](./docs/content/docs/modules/swarm.mdx)** · **[Changelog](./packages/core/CHANGELOG.md)**

</div>

`@deuz-sdk/core` combines model calls, tool execution, memory, approvals and resumable agent runs in **one package with zero runtime dependencies**. Clock, randomness, `fetch`, keys and logging are injected; the core runs on Web APIs, with Node-only integrations in separate entry points.

**Version 2.1 adds an optional native agent engine and a fixed-DAG swarm scheduler.** Existing `generateText`, synchronous `streamChat`, `generateObject` and `createAgent` methods keep their contracts.

```ts
import { streamChat } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Returns synchronously and never throws. Failures arrive as typed stream parts.
const res = streamChat({
  model: anthropic('claude-opus-4-8'),
  instructions: 'You are terse.',
  prompt: 'Hello!',
});

for await (const chunk of res.textStream) process.stdout.write(chunk);
const usage = await res.usage;
```

## Native agents in 2.1

`runAgent` returns a discriminated result: only `completed` contains an accepted, validated `output`. `streamAgent` returns synchronously and starts when consumed; drafts and complete array elements are separate from the final validated result. Tool work uses the canonical loop, followed by finalization with application tools disabled.

This complete example uses the deterministic mock model and needs no API key:

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
      additionalProperties: false,
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

Raw JSON Schema requires an explicit runtime validator; Standard Schema can supply its own. Verification is `verified`, `rejected` or `inconclusive`, with bounded retries. Per-tool context validation, output validation and `toModelOutput` separate a tool's raw result from what enters model history.

Native persistence uses a versioned `AgentRunEnvelope` and `AgentRunStore`, separate from the legacy `SessionStore` checkpoint contract. `resumeAgent` checks the stored scope, binding and limits; missing approval verdicts remain pending. A failed durable write stops execution, and completed stored results can be recovered without another model call. See the [native agent guide](./docs/content/docs/modules/native-agents.mdx) for approval and client-tool resume examples.

## Swarm: parallel tasks with explicit dependencies

`createSwarm` runs a fixed directed acyclic graph of agents and reducers. Concurrency limits live tasks; dependencies consume accepted predecessor outputs. The journal records ordered task/run events independently of model token streams.

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

The in-memory store is volatile. `@deuz-sdk/core/swarm/sqlite` provides a Node-only store that atomically commits run state, tasks and journal events. Recovery reuses completed tasks; interrupted effects require reconciliation unless explicitly safe to replay. Version 2.1 requires one executor per run and does not provide distributed workers or a cross-process lease. [Swarm persistence and recovery](./docs/content/docs/modules/swarm.mdx).

`createExecutionContext` supplies inherited policy and shared accounting for native runs; swarm also accepts parent and per-binding policies/budgets. Admission reserves estimates before dispatch, then settles known usage. Unknown usage or pricing keeps reservations held. These are admission controls, not a guarantee of a provider's final invoice. See [policy and budget semantics](./docs/content/docs/modules/native-agents.mdx#mandatory-policy-and-shared-budgets).

## Memory and context for long runs

**Memory that outlives the session.** Not a message array — a pipeline that extracts durable facts from a conversation, reconciles them against what it already knows (add / update / delete, never blind appends), scores them for importance, expires them, and pulls the relevant ones back on the next call. It runs on a vector store, a Postgres table, or an Obsidian vault.

```ts
await generateText({
  model,
  messages,
  memory: {
    seams: { store, embedder, llm: model },
    scope: { userId },
    recall: { topK: 6, maxChars: 2000, expandLinks: 1 },
    writePolicy: 'each-turn',
  },
});
```

**Compaction that keeps a long run alive.** When the window fills, it prunes stale tool output, drops old reasoning, and folds the earliest turns into a single running summary — one block that gets updated, not a stack that grows. And when a provider rejects a request as too long anyway, the loop force-compacts and retries that step instead of failing the run.

```ts
await generateText({ model, messages, maxSteps: 30, compaction: 'auto' });
```

## What else is in the box

| You need                  | It ships as                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tool loops that hold up   | Parallel calls, self-healing errors, runaway guards, cost and token budgets, sub-agents                    |
| A human in the loop       | `needsApproval` at any depth and HMAC-signed expiring tokens; native resume keeps missing verdicts pending |
| Runs that survive a crash | Native envelopes with `resumeAgent`; legacy step checkpoints with `resumeFromCheckpoint`                   |
| Rules the run must obey   | Guardrails on input, each tool call and the final answer: pass / block / rewrite                           |
| Agents that hand off      | `handoff()` moves the conversation — history, tools and model — to another agent                           |
| Tool servers, connected   | MCP with OAuth 2.0, reconnect, sampling and roots; `mcp: [{ url }]` does the rest                          |
| Plan → act → verify       | `planTasks`, CodeAct sandboxes, `verifyStep`, workspaces, browser control, background runs                 |
| State in your database    | SQLite, Redis and Postgres packs behind the memory, chat, session and run seams                            |
| Many models, one call     | **28 chat providers across four wires**, plus embeddings, images, speech, transcription and video          |
| A reusable agent          | `createAgent` — a frozen value, not a class. No `new`, no second runtime                                   |
| Traces without an account | Versioned events, a JSONL observer, a standalone HTML run report, an OpenTelemetry bridge                  |
| Resumable UI              | A refresh, a network blip and a server crash all look the same to the client                               |

```ts
import { generateText, handoff } from '@deuz-sdk/core';
import { promptInjectionGuardrail, maxOutputLength } from '@deuz-sdk/core/guardrails';
import { createPostgresStores } from '@deuz-sdk/core/stores/postgres';

const stores = createPostgresStores({ connectionString: process.env.DATABASE_URL });

await generateText({
  model: triage,
  messages,
  maxSteps: 8,
  tools: { ...handoff({ billing, support }), search },
  guardrails: { onInput: promptInjectionGuardrail(), onOutput: maxOutputLength(4000) },
  mcp: [{ url: 'https://mcp.example.com/mcp' }], // connected, namespaced and closed for you
  chat: { store: stores.chats, chatId, scope: { userId } },
  session: { store: stores.sessions, runId }, // transcript and checkpoints, one connection
  runtimeContext: { tenantId, db }, // travels with the call, not a per-request closure
});
```

## Install

```sh
npm install @deuz-sdk/core     # the runtime
npm install @deuz-sdk/react    # optional: useChat, useObject, headless UI
```

Node ≥ 22, or any edge runtime with `fetch`. Optional peers only when you use them: `zod` (or any Standard Schema library), `@modelcontextprotocol/sdk`, `react`, `pg` / `redis`, `unpdf` / `mammoth` / `xlsx`, `playwright`, `@opentelemetry/api`.

### Teach your coding agent

```sh
npx skills add Deuz-AI/Deuz-SDK
```

The **`deuz-sdk`** Agent Skill gives coding agents a build guide, API invariants and a task-to-file router. Its reference files cover the published entry points and are loaded when needed.

The skill checks resolve documented `@deuz-sdk` symbols against the export table, compile examples against the built package, and detect changes to the version or locked API contract.

## How it is built

One design rule explains most of the code: **normalize provider bytes to a canonical delta stream first.** Retry, failover, resume, budgets, sub-agents and typed UI events then share one language, and no code path streams a provider's raw SSE to a caller.

The rest follows from it:

- **Zero runtime dependencies.** Ours to test, version and secure.
- **No ambient state.** One `Dependencies` seam for clock, randomness, `fetch`, logging and keys — lint bans `Date.now()` and `Math.random()` in core, which is also why tests are deterministic.
- **Your infrastructure.** Checkpoints and journals live in your process and your database.
- **Privacy by default.** Content capture is opt-in and always redacted; API keys never reach a log, error or span.
- **The gate is the contract.** `npm run check` runs formatting, lint, runtime and type tests, a dual build, `publint` + Are-the-Types-Wrong, edge compatibility, byte budgets and a locked export contract. The core package publishes **56 export entries, including `./package.json`**.

Most tests replay recorded provider bytes, which proves the SDK builds the request it means to but never that a provider accepts it. So a separate [live suite](./packages/core/test/live) calls the real endpoints. It has already earned its keep: it confirmed that Gemini answers a tool request with `finishReason: STOP` — the exact shape that makes a naive loop hang up holding a tool call instead of an answer — and that a thinking model can spend 112 reasoning tokens against 1 answer token, which an SDK that misreads the usage envelope would under-report by an order of magnitude.

## Operational limits

Native runs use one executor per run; cross-process ownership needs application coordination. Stored tool receipts do not make external effects exactly-once. The native engine currently rejects `chat`, `memory`, `fallbackModels` and legacy completion hooks; those remain available through the existing APIs. Native `verify` has its own three-outcome contract. Legacy `resumeFromCheckpoint` retains its missing-verdict default-deny behavior.

So the limitations sit next to the features rather than in an issue tracker. Overflow recovery does not reach the Gemini native wire. `generateObject` cannot coerce a DeepSeek V4 model — it refuses both strategies, and [the page says why](./docs/content/docs/providers/compat.mdx#deepseek-v4-always-thinks). The Redis pack has no `MULTI`. Token counting is a calibrated heuristic unless you supply a tokenizer. `rerank` is still the identity reranker, MCP has no WebSocket transport, and the `Part` union has no `AudioPart`. Speech, transcription and video are covered by mocked tests but have not yet been run against a live endpoint. [The full list](./docs/content/docs/reference/whats-new-2-0.mdx).

## The map

```
@deuz-sdk/core         streamChat · generateText · generateObject · streamObject · embed
                       tool · filePart · imagePart · agentTool · handoff · compactMessages
                       createAgent · getModelCapabilities
  providers            /anthropic  /openai  /azure  /bedrock  /google  /google/extras  /xai  /voyage
                       /vertex  /vertex/node   (service-account JWT on the edge; ADC on Node)
                       /providers   (Mistral, DeepSeek, Qwen, Kimi, Groq, Perplexity, Cohere, DeepInfra,
                                     NVIDIA, SambaNova, Hyperbolic, keyless Ollama / LM Studio,
                                     createOpenAICompatible, createProviderRegistry)
  agents               /agent  /swarm  /swarm/sqlite  /guardrails  /autonomy  /runtime  /runtime/node
  memory & context     /memory  /memory/markdown  /rag  /rag/node  /skills  /skills/node
  state & storage      /stores/sqlite  /stores/redis  /stores/postgres  /durable
  chat & wire          /chat  /chat/node  /ui
  work & tools         /workspace  /workspace/node  /compute  /compute/node  /browser  /browser/node
  connect & media      /mcp  /mcp/stdio  /mcp/node
                       /image  /midjourney  /speech  /transcription  /video  /yunwu
  ops                  /observe  /observe/node  /otel  /middleware  /pricing  /testing  /edge

@deuz-sdk/react        useChat · useObject · ToolApprovalCard · CostBadge
```

## Docs & contributing

[`docs/`](./docs) — start with [native agents](./docs/content/docs/modules/native-agents.mdx), [swarm](./docs/content/docs/modules/swarm.mdx), [autonomy](./docs/content/docs/modules/autonomy.mdx), or the [legacy durable runtime](./docs/content/docs/agents/durable-runtime.mdx).

```sh
git clone https://github.com/Deuz-AI/Deuz-SDK.git && cd Deuz-SDK
npm install
npm run check
```

---

<div align="center">

Built by **Umutcan Edizaslan** — [X @UEdizaslan](https://x.com/UEdizaslan) · [GitHub @U-C4N](https://github.com/U-C4N)

<sub>With help from <b>Claude Opus 4.8</b> and <b>Claude Opus 5</b>.</sub>

<sub>[MIT](./LICENSE) © 2026</sub>

</div>
