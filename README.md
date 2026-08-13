<div align="center">

# Deuz SDK

### A TypeScript runtime for agents that have to survive production

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=3b82f6)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-3b82f6?style=flat-square)](./packages/core/package.json)
[![license](https://img.shields.io/npm/l/%40deuz-sdk%2Fcore?style=flat-square)](./LICENSE)

**[Docs](./docs)** · **[What's new in 2.0](./docs/content/docs/reference/whats-new-2-0.mdx)** · **[Coming from the Vercel AI SDK](./docs/content/docs/migration/from-vercel-ai-sdk.mdx)** · **[Changelog](./packages/core/CHANGELOG.md)**

</div>

Calling a model is a solved problem. What is not solved is everything around it: remembering a user across sessions, staying inside a context window on turn forty, asking a human before the irreversible thing, resuming after the process dies mid-run, and connecting a tool server without hand-rolling OAuth.

Most SDKs leave those to you. `@deuz-sdk/core` ships them — **one package, zero runtime dependencies**, and nothing ambient: clock, randomness, `fetch`, keys and logging are all injected, so the same code runs on Node, Bun, Deno and the edge, and tests stay deterministic.

We are not claiming to build ASI. This is meant to be honest infrastructure on that road — a vehicle, not the destination.

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

## The two things nobody else ships

Every SDK gives you `generateText`. These are the ones you would otherwise build yourself, badly, twice.

**Memory that outlives the session.** Not a message array — a pipeline that extracts durable facts from a conversation, reconciles them against what it already knows (add / update / delete, never blind appends), scores them for importance, expires them, and pulls the relevant ones back on the next call. It runs on a vector store, a Postgres table, or an Obsidian vault.

```ts
await generateText({
  model, messages,
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

| You need | It ships as |
| --- | --- |
| Tool loops that hold up | Parallel calls, self-healing errors, runaway guards, cost and token budgets, sub-agents |
| A human in the loop | `needsApproval` at any depth, HMAC-signed expiring tokens, a missing verdict denies |
| Runs that survive a crash | Step checkpoints in *your* database, `resumeFromCheckpoint` later — no workflow vendor |
| Rules the run must obey | Guardrails on input, each tool call and the final answer: pass / block / rewrite |
| Agents that hand off | `handoff()` moves the conversation — history, tools and model — to another agent |
| Tool servers, connected | MCP with OAuth 2.0, reconnect, sampling and roots; `mcp: [{ url }]` does the rest |
| Plan → act → verify | `planTasks`, CodeAct sandboxes, `verifyStep`, workspaces, browser control, background runs |
| State in your database | SQLite, Redis and Postgres packs behind the memory, chat, session and run seams |
| Many models, one call | **28 chat providers across four wires**, plus embeddings, images, speech, transcription and video |
| A reusable agent | `createAgent` — a frozen value, not a class. No `new`, no second runtime |
| Traces without an account | Versioned events, a JSONL observer, a standalone HTML run report, an OpenTelemetry bridge |
| Resumable UI | A refresh, a network blip and a server crash all look the same to the client |

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
  mcp: [{ url: 'https://mcp.example.com/mcp' }],   // connected, namespaced and closed for you
  chat: { store: stores.chats, chatId, scope: { userId } },
  session: { store: stores.sessions, runId },      // transcript and checkpoints, one connection
  runtimeContext: { tenantId, db },                // travels with the call, not a per-request closure
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

Two Agent Skills, for Claude Code and any other agent that reads the format.

**`deuz-sdk`** is a build guide over the whole surface — the mental model and its invariants, a task-to-file router, and thirteen reference files the agent loads only when the task needs them, covering every one of the 53 subpaths. **`migrate-from-ai-sdk`** is the verified name-by-name port from `ai` and `@ai-sdk/*`.

They are gated, not just written. Every `@deuz-sdk` symbol in them is resolved against the real export table on every commit, every code example is compiled against the built package, and a freshness check fails the moment the version or the locked API contract moves — so an agent reading them cannot confidently invent a function that does not exist. Written test-first: nine build tasks were given to agents without the skill first, which produced 19 imaginary imports across 8 of 9 answers.

## How it is built

One design rule explains most of the code: **normalize provider bytes to a canonical delta stream first.** Retry, failover, resume, budgets, sub-agents and typed UI events then share one language, and no code path streams a provider's raw SSE to a caller.

The rest follows from it:

- **Zero runtime dependencies.** Ours to test, version and secure.
- **No ambient state.** One `Dependencies` seam for clock, randomness, `fetch`, logging and keys — lint bans `Date.now()` and `Math.random()` in core, which is also why tests are deterministic.
- **Your infrastructure.** Checkpoints and journals live in your process and your database.
- **Privacy by default.** Content capture is opt-in and always redacted; API keys never reach a log, error or span.
- **The gate is the contract.** `npm run check` runs formatting, lint, types, 1,892 tests, a dual build, `publint` + Are-the-Types-Wrong, an edge bundle with no Node leaks, byte budgets, and a locked list of 242 public exports across 54 subpaths. A removed export fails the release, not your build.

Most tests replay recorded provider bytes, which proves the SDK builds the request it means to but never that a provider accepts it. So a separate [live suite](./packages/core/test/live) calls the real endpoints. It has already earned its keep: it confirmed that Gemini answers a tool request with `finishReason: STOP` — the exact shape that makes a naive loop hang up holding a tool call instead of an answer — and that a thinking model can spend 112 reasoning tokens against 1 answer token, which an SDK that misreads the usage envelope would under-report by an order of magnitude.

## What this is not

**Need the largest ecosystem today? Use the Vercel AI SDK.** Years of production hours, hundreds of contributors, integrations everywhere. That gap is real and it is not closing this year, and no feature list here changes it.

Our bet is smaller: a runtime you can hold in your head. Durability without a workflow vendor. Autonomy without an Agent god-class. Observability without an account. Nothing phones home.

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
  agents               /agent  /guardrails  /autonomy  /runtime  /runtime/node
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

[`docs/`](./docs) — start with [autonomy](./docs/content/docs/modules/autonomy.mdx), [the durable runtime](./docs/content/docs/agents/durable-runtime.mdx), or [the unbreakable chatbot](./docs/content/docs/agents/unbreakable-chatbot.mdx). Coming from the Vercel AI SDK? [The verified mapping](./docs/content/docs/migration/from-vercel-ai-sdk.mdx) lists what has an equivalent — and what does not.

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
