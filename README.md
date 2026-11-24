<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/mascot-dark.png">
  <img src="./assets/mascot-light.png" alt="The Deuz mascot: the logo's ring and dot as a head, a gloved hand pointing up" width="180">
</picture>

# Deuz SDK

**One TypeScript SDK. Models, agents, and swarms.**

Deuz is a TypeScript library that calls models from Anthropic, OpenAI, Google and other providers, and runs agents and swarms in your own process. It is for applications that must limit what a run spends and account for what it did: budgets shared across processes, receipts for tool calls, signed approvals, and runs that resume after a crash.

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=18181b)](https://www.npmjs.com/package/@deuz-sdk/core)
[![core runtime dependencies](https://img.shields.io/badge/core_runtime_dependencies-0-18181b?style=flat-square)](./packages/core/package.json)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](./LICENSE)

[Documentation](https://deuz-sdk.tech/docs) · [Examples](./examples) · [What's new in 2.5](./docs/content/docs/reference/whats-new-2-5.mdx) · [Changelog](./packages/core/CHANGELOG.md)

</div>

## Start building

```sh
npm install @deuz-sdk/core
```

Set `ANTHROPIC_API_KEY`, then run your first agent:

```ts
import { runAgent } from '@deuz-sdk/core/agent';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await runAgent({
  model: anthropic('claude-opus-5-5'),
  prompt: 'Explain how rainbows form in three sentences.',
  maxSteps: 4,
});

if (result.status === 'completed') console.log(result.output);
else console.error(result.status, result.status === 'failed' ? result.error.message : '');
```

Save it as `agent.mts` and run `node agent.mts`. Node.js runs a `.mts` file directly from 22.18 (on the 23 line, from 23.6); core itself supports Node.js 22 and newer. `createAnthropic` does not read the environment, so you pass the key in. Without a key the run returns `failed`, and the last line prints why.

The [examples](./examples) run from a clone of this repository. 01–06 call Anthropic with your key. The rest need no key and no network, with two exceptions: `13-headless` calls Anthropic when `ANTHROPIC_API_KEY` is set, and `23-docker-runner` needs a local Docker engine.

## Packages

| Package | What it is | Status |
| --- | --- | --- |
| [`@deuz-sdk/core`](./packages/core) | The SDK: models, agents, swarms and every module under "What ships" | Stable, except labelled previews |
| [`@deuz-sdk/react`](./packages/react) | `useChat`, `useObject` and headless chat components for React 18 and 19 | Stable |
| [`@deuz-sdk/ai-sdk-provider`](./packages/ai-sdk-provider) | A Deuz budget, fail-over and a circuit breaker for Vercel AI SDK 7 models | Stable |
| [`@deuz-sdk/mcp-ledger`](./packages/mcp-ledger) | A ready-made MCP server: versioned memory, an advisory spend record and a hash-chained receipt log | Stable |
| [`@deuz-sdk/cli`](./packages/cli) | The `deuz` command: `deuz meter`, a budget proxy for coding agents, and `deuz acp`, which serves an agent to an editor | Preview |

All five are published together at one version, as ESM and CommonJS builds with type declarations; the last three are new in 2.5. Core, the React bindings and the AI SDK provider have no runtime dependencies, and the libraries core's integrations use are optional peer dependencies. Core's SQLite stores (unless you pass them your own database handle), the MCP ledger and the CLI's `--store` option need Node.js 22.13 or newer.

Core's [edge-safe import paths](./docs/content/docs/advanced/edge.mdx) use only Web APIs. CI checks that by bundling representative imports for the browser platform; no test runs on Bun, Deno or Cloudflare Workers. Integrations that need Node.js have their own import paths.

## What ships

- **Models** — one API across providers: [streaming](./docs/content/docs/core/stream-chat.mdx), [structured output](./docs/content/docs/core/generate-object.mdx), tool calls, [embeddings](./docs/content/docs/core/embeddings.mdx), [realtime voice](./docs/content/docs/modules/realtime.mdx) and [batch requests](./docs/content/docs/modules/batch.mdx).
- **[Agents](./docs/content/docs/modules/native-agents.mdx)** — typed results, verification, approvals, memory, model fail-over and resumable runs. In a native run each tool call gets a receipt, so a resume reuses a recorded result instead of running the tool again.
- **[Swarms](./docs/content/docs/modules/swarm.mdx)** — agent tasks with dependencies, runtime spawning, shared blackboards and rounds, persisted in SQLite, Postgres or Redis.
- **[Budgets](./docs/content/docs/modules/budgets.mdx)** — persistent token and USD budgets per user, thread or organisation, shared by every process on the same store. A call whose estimate does not fit is refused before it is sent.
- **[Signed approvals](./docs/content/docs/agents/durable-runtime.mdx)** — an approval signer puts an HMAC token on each approval request. The token proves which call was approved, not who approved it.
- **[Operations](./docs/content/docs/modules/operations.mdx)** — runs across several processes: leases, drain, crash recovery and cancel from any process. Also [schedules and webhooks](./docs/content/docs/modules/schedule.mdx), a [goal supervisor](./docs/content/docs/modules/goal-runtime.mdx), a local [Docker runner](./docs/content/docs/modules/docker.mdx) (preview) and [headless runs](./docs/content/docs/modules/headless.mdx) (preview).
- **[Context](./docs/content/docs/modules/context.mdx)** — [versioned memory](./docs/content/docs/modules/versioned-memory.mdx), a context compiler (partly preview) with working memory, retrieval, compaction and [transcript search](./docs/content/docs/modules/transcript-search.mdx).
- **[Chat UI](./docs/content/docs/modules/ui-streaming.mdx)** — a versioned, resumable stream protocol, chat persistence and [React hooks](./docs/content/docs/modules/react-hooks.mdx).
- **[Interop](./docs/content/docs/modules/mcp.mdx)** — an MCP client and [MCP server](./docs/content/docs/modules/mcp-server.mdx), and [A2A](./docs/content/docs/modules/a2a.mdx) (Agent2Agent) to call other agents and serve your own.
- **[Evolve](./docs/content/docs/modules/evolve.mdx)** — evolutionary program search with a mandatory budget. A resume replays the stored candidates without calling a model, then continues.
- **[Observability](./docs/content/docs/modules/observability.mdx)** — local events for every run, an OpenTelemetry bridge and [eval suites](./docs/content/docs/modules/evals.mdx).

A ceiling limits what Deuz admits, not what a provider invoices: admission works on estimates, so each call admitted near the ceiling can overshoot it. A USD budget set in code needs a price provider (`createPriceProvider` from `@deuz-sdk/core/pricing`); without one the calls run and their dollars are not counted. The meter, the AI SDK provider and the `deuz` CLI add one by default.

Receipts do not make a tool's side effect exactly-once. If a crash interrupts a tool call, Deuz cannot know whether it ran, so the resume stops at that call until you retry it or record its outcome; a tool marked idempotent does not stop the resume. Without a lease provider, let only one process drive a given swarm or agent run.

## New in 2.5

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/mascot-flip-dark.png">
  <img src="./assets/mascot-flip-light.png" alt="" width="15%" align="right">
</picture>

2.5 applies Deuz's budgets, receipts and signed approvals outside your own code: to coding agents such as Claude Code and Codex, to ACP editors, to Vercel AI SDK code and to MCP clients.

- **[Meter](./docs/content/docs/modules/meter.mdx)** — a local proxy that charges the model requests of Claude Code, Codex or any Anthropic or OpenAI client to a budget, and refuses them with 402 at the ceiling. It is a core module you can mount in code; the [`deuz` CLI](./docs/content/docs/modules/cli.mdx) (preview) is the short way to start it:

  ```sh
  npx @deuz-sdk/cli meter --budget-usd 5 -- claude
  ```

  The budget stays in memory for that run unless you pass `--store <file>`.
- **[Harness runner](./docs/content/docs/modules/harness.mdx)** (preview) — `runHarness` runs Claude Code, Codex, OpenCode or Gemini CLI as a sub-agent, applies your policy to the permission requests the harness sends, and reports the cost the meter measured next to the cost the harness declared. The first three run under a budget; Gemini CLI cannot be metered, so it has a declared cost only and no ceiling.
- **[ACP](./docs/content/docs/modules/acp.mdx)** (Agent Client Protocol, preview) — serves a Deuz agent to ACP editors such as Zed and JetBrains IDEs, with signed approvals and a budget, and drives any ACP agent from code. It has not run in a real editor yet.
- **[Tool search](./docs/content/docs/modules/tool-search.mdx)** — puts a large tool catalog behind one lexical search tool. A search never returns a tool the run's policy refuses, and it leaves out or labels a tool whose cost estimate does not fit the remaining budget.
- **[AI SDK provider](./docs/content/docs/modules/ai-sdk-provider.mdx)** — wraps a Vercel AI SDK 7 model in one line, so existing AI SDK code runs under a Deuz budget.
- **[MCP server](./docs/content/docs/modules/mcp-server.mdx)** — now publishes resources and prompts next to tools, can change its catalog at runtime, and can run opted-in tools as MCP tasks (preview).
- **[MCP ledger](./docs/content/docs/modules/mcp-ledger.mdx)** — `npx -y @deuz-sdk/mcp-ledger` starts it for any MCP client. Its spend record is advisory: nothing is refused.

<br clear="right">

**Stability.** The items marked preview can still change in 2.6; everything else in this list is stable.

**What ran against real tools.** On 2026-11-24 the meter (`deuz meter` in front of `claude -p`) and the harness runner's Claude Code preset ran against real Claude Code. Codex on a ChatGPT login reached the meter only through a custom model provider, and the change that measures its traffic has a unit test only. ACP passed a conformance run against the official ACP TypeScript SDK. Nothing else in 2.5 met a real model, editor or MCP host; the [support matrix](./docs/content/docs/reference/support-matrix.mdx) has the detail.

**Upgrading.** 2.4 code that calls the API compiles unchanged, and nothing new runs until you import it. Three things changed for code that serves tools over MCP: a server with no tools now answers `tools/list` with `[]` instead of an error, served tool call ids have a new format, and a class that implements `DeuzMcpServer` itself needs the new `catalog` member. The [upgrade notes](./docs/content/docs/reference/whats-new-2-5.mdx) cover all three and each new module's limits. [Known gaps](./docs/content/docs/reference/known-gaps.mdx) says where other SDKs do more than Deuz, and what to use there instead.

Earlier releases: [2.4](./docs/content/docs/reference/whats-new-2-4.mdx) added versioned memory, the context compiler, a goal supervisor and a local Docker runner; [2.3](./docs/content/docs/reference/whats-new-2-3.mdx) added an MCP server, A2A, realtime voice, batch requests and Redis backends.

## Add the coding-agent skills

```sh
npx skills add Deuz-AI/Deuz-SDK
```

The command offers two skills, instruction files that a coding agent such as Claude Code loads when a task needs them: [`deuz-sdk`](./skills/deuz-sdk) (API references and implementation guidance) and [`migrate-from-ai-sdk`](./skills/migrate-from-ai-sdk) (the mapping for porting an app from the Vercel AI SDK).

---

<div align="center">

[MIT](./LICENSE) · Built by [Umutcan Edizaslan](https://github.com/U-C4N)

<sub>Built with <b>Opus 4.8 / 5 / 5.5</b>, <b>Fable 5 / 5.1 / 5.2</b>, and <b>GPT-6 Astra Ultra</b>.</sub>

</div>
