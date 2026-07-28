<div align="center">

# Deuz SDK

### Open-source TypeScript runtime for AI agents

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=3b82f6)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-3b82f6?style=flat-square)](./packages/core/package.json)
[![license](https://img.shields.io/npm/l/%40deuz-sdk%2Fcore?style=flat-square)](./LICENSE)

**[Docs](./docs)** · **[What's new in 1.9](./docs/content/docs/reference/whats-new-1-9.mdx)** · **[Migrating from the Vercel AI SDK](./docs/content/docs/migration/from-vercel-ai-sdk.mdx)** · **[Changelog](./packages/core/CHANGELOG.md)**

</div>

Models are getting better every month. The gap we care about is not another wrapper around `fetch` — it is whether an agent can remember, use tools safely, plan and check its own work, survive a crash, ask a human before something risky, and keep going when a tab or a process dies.

That is what `@deuz-sdk/core` is for: a small, from-scratch TypeScript runtime — **one package, zero runtime dependencies** — so you can build agents that run in production, not only in demos.

We are not claiming to build ASI. The longer arc we care about is systems that can stay useful as models get smarter. Deuz is meant to be **honest infrastructure on that road** — a vehicle, not the destination.

## What ships today

Providers normalize to one canonical stream. Failures are typed parts on that stream, not thrown surprises. Clock, randomness, fetch, keys, and logging are injected, so the same code runs on Node, Deno, Bun, and the edge, and tests stay deterministic.

| Need | In the box |
| --- | --- |
| Memory across sessions | Recall + mem0-style extract/reconcile over a vector store or markdown vault — `memory: { seams, scope }` |
| Tool loops that hold up | Parallel tools, self-healing errors, runaway guards, budgets, sub-agents, MCP, skills, hybrid RAG |
| Plan → act → verify | `planTasks`, CodeAct sandboxes, `verifyStep`, workspace files, browser tools, background runs ([1.8](./docs/content/docs/modules/autonomy.mdx)) |
| Durable runs | Step checkpoints in *your* DB; `resumeFromCheckpoint` later — no workflow vendor |
| Human approval | `needsApproval` at any depth; HMAC-signed, expiring tokens; missing verdict = deny |
| Many models, one call shape | Anthropic, OpenAI, Azure, Bedrock, Gemini, xAI, Vertex, plus Mistral / DeepSeek / Qwen / Kimi / Groq / … via `./providers` and `createProviderRegistry` |
| Resumable UI | Refresh, network blip, and server crash look the same to the client |
| An agent you can reuse | `createAgent` — a frozen value with `generateText` / `streamChat` / `generateObject` / `streamObject` / `asTool` / `with`, no `new` and no second runtime ([1.9](./docs/content/docs/agents/create-agent.mdx)) |
| Traces without an account | Versioned observe events, a JSONL observer, an HTML run report, and an OpenTelemetry bridge — content capture opt-in and always redacted |

Published on npm, covered by golden-replay tests, documented under [`docs/`](./docs).

## Quickstart

```ts
import { streamChat } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Returns synchronously. Never throws. Failures arrive as typed stream parts.
const res = streamChat({
  model: anthropic('claude-opus-4-8'),
  instructions: 'You are terse.',
  prompt: 'Hello!',
});

for await (const chunk of res.textStream) process.stdout.write(chunk);
const usage = await res.usage;
```

Design rule: normalize provider bytes to a canonical delta stream *first*. Retry, failover, resume, budgets, and sub-agents can share one language.

## Ergonomics (1.9)

1.9 is mostly about removing papercuts and making silent failures loud. Highlights:

```ts
import { createAgent } from '@deuz-sdk/core/agent';
import { tool, filePart } from '@deuz-sdk/core';
import { validateChatRequest } from '@deuz-sdk/core/chat';

// A reusable agent is a frozen VALUE, not a class. No `new`, no new runtime:
// agent.streamChat(o) IS streamChat({ ...def, ...o }).
const support = createAgent({
  name: 'support',
  model: anthropic('claude-opus-4-8'),
  instructions: 'You are a terse support agent.',
  tools: { lookupOrder: tool({ description: '…', parameters: schema, execute }) },
  maxSteps: 8,                                    // the default is 1 — always set it
  timeout: { ttftMs: 10_000, totalMs: 25_000 },   // four layers: ttft / total / step / tool
});

// A chat route validates its own body — canonical Message[] includes role:'system'.
const parsed = validateChatRequest(await req.json());
if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });
```

Also: `prompt` / `instructions`, `consume()` so terminal effects run when nobody reads the stream, `filePart()` with PDFs that now work on **all four wires**, `createOpenAICompatible({ id, baseURL })` for Ollama / vLLM / an internal gateway, per-call `capabilities` so a brand-new slug is not silently capped at 4096 output tokens, ordered `UIMessage.parts`, and a writable `useChat` (`setHistory` / `addToolResult` / `throttleMs` / `resume: { auto }`).

Three new subpaths ship with it:

- **`/agent`** — `createAgent` (above).
- **`/otel`** — `createOtelTracer()` / `createOtelObserver()`, the last mile from the existing `deps.tracer` / `deps.observer` seams to a real collector: GenAI-semconv span names, `@opentelemetry/api` as a lazily resolved **optional** peer, no global registration (you pass it through `deps`, so nothing is ambient), and content capture off by default and double-redacted when you turn it on. Attach one of the two, not both: attaching both double-spans a run.
- **`/vertex/node`** — `createAdcKeyProvider()`: Application Default Credentials for Vertex, resolved in the documented order (explicit key file → `GOOGLE_APPLICATION_CREDENTIALS` → the GCE/Cloud Run metadata server). It is the Node twin of the edge-safe `createServiceAccountKeyProvider()` on `/vertex`, which signs the JWT with WebCrypto and takes `clock` / `fetch` as required arguments so nothing is ambient. Both only return a `KeyProvider` — the top of the same key-precedence chain.

`/observe` and `/observe/node` also gained a run report: the pure `renderRunReport(events)` turns one run's observation events into a standalone HTML document, and `writeRunReport({ from, to })` reads a JSONL journal and writes that file.

Three 1.9 surfaces first shipped as **declared but inert** and all three now have producers: `streamChat().warnings` resolves a real `CallWarning[]` (and `warning` parts ride `fullStream`), the built-in approval loop sets `tool-state.denied` / `deniedReason` so a refused call no longer renders as "getWeather failed", and `applyUIPart` folds `sub-agent` frames into `turn.subAgents`, which `useChat` exposes. One gap remains and we say so on every page that mentions it: `result.warnings` is **`undefined` on `generateText` / `generateObject` / `streamObject`**, and a `streamChat` carrying `tools` reports only its own `activeTools` notices — read `deps.logger.warn` there. [The full list, with the limitations](./docs/content/docs/reference/whats-new-1-9.mdx).

## Install

```sh
npm install @deuz-sdk/core     # the runtime
npm install @deuz-sdk/react    # optional: useChat, useObject, headless UI
```

Node ≥ 22, or any edge runtime with `fetch`. Optional peers only when you use them: `zod` (or any Standard Schema library) with `@standard-community/standard-json`, `@modelcontextprotocol/sdk`, `react`, `unpdf` / `mammoth` / `xlsx`, `playwright`, `@opentelemetry/api`.

```sh
npx skills add Deuz-AI/Deuz-SDK   # two skills for Claude Code / Cursor:
                                  #   deuz-sdk            — the API reference
                                  #   migrate-from-ai-sdk — port an app off `ai` / @ai-sdk/*
```

## Autonomy (1.8)

Longer runs need more than chat: plan work, act (often by writing code), verify, persist progress. 1.8 adds those primitives as free functions on the same edge-safe core — heavy pieces stay behind Node seams you can swap (Docker, E2B, Playwright, …).

```ts
import { generateText } from '@deuz-sdk/core';
import { planTasks, nextPendingTask, setTaskStatus } from '@deuz-sdk/core/autonomy';
import { createWorkspaceTools } from '@deuz-sdk/core/workspace';
import { createFileWorkspace } from '@deuz-sdk/core/workspace/node';
import { codeActTool, shellTool } from '@deuz-sdk/core/compute';
import { createNodeSandbox } from '@deuz-sdk/core/compute/node';

const workspace = createFileWorkspace({ root: './.agent-workspace' });
const sandbox = createNodeSandbox({ allowedLanguages: ['python', 'bash', 'javascript'] });

let plan = await planTasks(goal, { model });

for (let task = nextPendingTask(plan); task; task = nextPendingTask(plan)) {
  const result = await generateText({
    model,
    messages: [{ role: 'user', content: task.title }],
    tools: {
      ...createWorkspaceTools(workspace),
      ...codeActTool(sandbox),
      ...shellTool(sandbox),
    },
    verifyStep: ({ text, attempt }) =>
      /\bdone\b/i.test(text)
        ? { ok: true }
        : { ok: false, feedback: 'Finish the task and confirm.', retry: attempt < 2 },
  });

  plan = setTaskStatus(
    plan,
    task.id,
    result.providerMetadata?.deuz?.verified === false ? 'failed' : 'done',
  );
}
```

`createNodeSandbox` is a reference host process — not production isolation. Cookbook: [Build your own Manus](./docs/content/docs/cookbooks/autonomous-agent.mdx).

## Where we actually are

Deuz is young: one maintainer, a small star count, a few hundred npm downloads a week (July 2026).

Every figure in this section is from the **1.8.0 panel, scored 2026-07-22**. It has **not** been re-scored for 1.9.0 — treat it as the last measured point, not as a claim about this release. On that panel (sixteen TypeScript AI SDKs, self-scored) we land **9th at 74.0 / 100** (was 14th / 69.6 on 1.7). Community weight is still harsh (393 downloads/week + 2 stars → criterion **23** in every scenario), and we did not curve the grade ([scores](./bench) · [research](./bench/research-1.8.0.md)).

The jump is almost all **coding** (61 → 71) and **ASI** (74 → 77): workspace tools, CodeAct sandboxes, `planTasks` → `verifyStep`, background runs, browser. Mastra’s remote sandboxes still beat our Node reference host on production isolation; Vercel still owns the ecosystem. Need the biggest ecosystem today? Use the Vercel AI SDK.

Our bet is smaller: a runtime you can hold in your head. Zero runtime deps. Lint-banned ambient clock/randomness in core. Durability without a workflow vendor. Autonomy without an Agent god-class. Observability without an account. Nothing phones home.

### The honest benchmark (1.8.0 panel — not re-scored for 1.9.0)

Most SDK READMEs open with a benchmark they win. This one opens with the one we don't.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/benchmark-dark.png">
  <img alt="1.8.0 panel (2026-07-22): self-assessed 100-point benchmark of 16 AI SDKs across 5 scenarios: Vercel AI SDK leads at 86.2; Deuz SDK ranks 9th of 16 at 74.0 (was 14th / 69.6 on 1.7)" src="./assets/benchmark.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/footprint-dark.png">
  <img alt="Measured install footprint on a log scale, 2026-07-22: @deuz-sdk/core 1.8 local pack 4.09 MB / 40.3 ms vs ai, @mastra/core, langchain, llamaindex, and @openai/agents (up to 116 MB, 765 ms)" src="./assets/footprint.png">
</picture>

Both charts are generated from the 1.8.0 data in [`bench/`](./bench) and have not been regenerated for 1.9.0. Bare-package installs favor frameworks that split providers into separate packages. Footprint is not a quality score — it measures what you pay before the first token. Rubric, criterion breakdowns, and live community numbers: [`bench/`](./bench).

## Principles

- **Zero dependencies.** Ours to test, version, and secure.
- **No ambient state.** One `Dependencies` seam for clock, randomness, fetch, logging, keys.
- **One canonical stream.** Adapters never proxy raw provider bytes.
- **Your infrastructure.** Checkpoints and journals stay in your process and database.
- **Privacy by default.** Content capture opt-in, always redacted.
- **Honesty over hype.** The only leaderboard here ranks us 9th — and it is still the 1.8.0 one.

## The map

```
@deuz-sdk/core         streamChat · generateText · generateObject · streamObject · embed
                       tool · filePart · imagePart · agentTool · getModelCapabilities
  providers            /anthropic  /openai  /azure  /bedrock  /google  /google/extras  /xai  /voyage
                       /vertex  /vertex/node   (service-account JWT on the edge; ADC on Node)
                       /providers   (Mistral, DeepSeek, Qwen, Kimi, Groq, OpenRouter, createOpenAICompatible,
                                     createProviderRegistry)
  agents               /agent       (createAgent — a reusable agent as a frozen value)
  chat & wire          /chat  /chat/node  /ui  /durable
  memory & knowledge   /memory  /memory/markdown  /rag  /rag/node  /skills  /skills/node
  autonomy             /workspace  /workspace/node  /compute  /compute/node
                       /autonomy  /runtime  /runtime/node  /browser  /browser/node
  connect & media      /mcp  /mcp/stdio  /image  /midjourney  /yunwu
  ops                  /observe  /observe/node  /otel  /middleware  /pricing  /testing  /edge

@deuz-sdk/react        useChat · useObject · ToolApprovalCard · CostBadge
```

## Docs & contributing

[`docs/`](./docs) — start with [autonomy](./docs/content/docs/modules/autonomy.mdx), [durable runtime](./docs/content/docs/agents/durable-runtime.mdx), or [the unbreakable chatbot](./docs/content/docs/agents/unbreakable-chatbot.mdx). Coming from the Vercel AI SDK? [The verified mapping](./docs/content/docs/migration/from-vercel-ai-sdk.mdx) lists what has an equivalent — and what does not.

```sh
git clone https://github.com/Deuz-AI/Deuz-SDK.git && cd Deuz-SDK
npm install
npm run check
```

---

<div align="center">

Built by **Umutcan Edizaslan** — [X @UEdizaslan](https://x.com/UEdizaslan) · [GitHub @U-C4N](https://github.com/U-C4N)

<sub>With help from <b>Claude Opus 4.8</b> and <b>Claude Fable 5</b>.</sub>

<sub>[MIT](./LICENSE) © 2026</sub>

</div>
