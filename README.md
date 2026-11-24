<div align="center">

# Deuz SDK

**One TypeScript SDK. Models, agents, and swarms.**

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=18181b)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-18181b?style=flat-square)](./packages/core/package.json)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](./LICENSE)

[Documentation](https://deuz-sdk.tech/docs) · [Examples](./examples) · [What's new in 2.5](./docs/content/docs/reference/whats-new-2-5.mdx)

</div>

## Start building

```sh
npm install @deuz-sdk/core
```

Set `ANTHROPIC_API_KEY`, then run your first agent:

```ts
import { runAgent } from '@deuz-sdk/core/agent';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const result = await runAgent({
  model: anthropic('claude-opus-4-8'),
  prompt: 'Explain how rainbows form in three sentences.',
  maxSteps: 4,
});

if (result.status === 'completed') console.log(result.output);
```

Use Node.js 22+, or an edge runtime with Web APIs. Node integrations have separate imports.

The repository has twenty-three [examples](./examples): 01–06 call Anthropic with your key, 07–22 run without a key or network, and 23 runs against a local Docker engine without a key.

## What ships

- **Models** — multiple providers, streaming, structured output, tool calls, realtime voice, and batch requests.
- **Agents** — typed results, verification, approvals, resumable runs, and memory, chat and model fail-over.
- **Swarms** — task dependencies, runtime spawning, shared blackboards, rounds, and SQLite, Postgres or Redis persistence.
- **Operations** — leases, drain, cross-process cancel and recovery, persistent budgets, schedules, goal records with a goal supervisor, a local Docker runner (preview), and a headless preview.
- **Evolve** — evolutionary program search with a mandatory budget and zero-call resume.
- **Context** — versioned memory, a context compiler with working memory, retrieval, compaction, transcript search, and MCP tools.
- **Interop** — an MCP server with resources and prompts, A2A to call other agents and serve your own, ACP for editors, and a Vercel AI SDK provider.
- **Harnesses** — a budget meter in front of Claude Code or Codex, the `deuz` CLI, and coding harnesses run as budgeted sub-agents.
- **Control** — shared execution policies, budget accounting, traces, eval suites, and optional React bindings.

Core has zero required runtime dependencies; integrations use optional peers. Without a lease provider, drive each swarm or native agent run from one process; uncertain external effects require reconciliation before retry.

[Agents](./docs/content/docs/modules/native-agents.mdx) · [Swarms](./docs/content/docs/modules/swarm.mdx) · [React](./docs/content/docs/modules/react-hooks.mdx) · [Changelog](./packages/core/CHANGELOG.md)

### New in 2.5

2.4 made agents that keep working over days. 2.5 takes Deuz's budgets, receipts and signed approvals to the tools developers already use.

- **Caps a coding harness** — `npx @deuz-sdk/cli meter --budget-usd 5 -- claude` runs Claude Code behind a local [meter](./docs/content/docs/modules/meter.mdx) that charges every request to a persistent budget and answers 402 at the ceiling. The [CLI](./docs/content/docs/modules/cli.mdx) is a preview.
- **Delegates to a harness** — [`runHarness`](./docs/content/docs/modules/harness.mdx) runs Claude Code, Codex, Gemini CLI or OpenCode as a sub-agent under a budget, decides its permission requests by policy, and puts its measured cost next to the cost it declares (preview).
- **Works in your editor** — [ACP](./docs/content/docs/modules/acp.mdx) serves a Deuz agent to Zed or a JetBrains IDE with signed approvals, or drives any ACP agent from code (preview).
- **Keeps a big toolbox small** — [tool search](./docs/content/docs/modules/tool-search.mdx) hides a large catalog behind one search that respects the run's budget and policy.
- **Fits existing code** — [`@deuz-sdk/ai-sdk-provider`](./docs/content/docs/modules/ai-sdk-provider.mdx) puts a Deuz budget under Vercel AI SDK 7 models in one line, the [MCP server](./docs/content/docs/modules/mcp-server.mdx) publishes resources and prompts, and [`@deuz-sdk/mcp-ledger`](./docs/content/docs/modules/mcp-ledger.mdx) gives Claude Desktop or Cursor memory, a spend ledger and receipts.

2.5 is additive: 2.4 code compiles unchanged, and nothing new runs until you import it. An MCP server with no tools now lists `[]`, and served tool call ids changed format; the upgrade notes explain both. The meter and the harness runner were run against real Claude Code and Codex on 2026-11-24 (Codex on a ChatGPT login was charged its estimate in that run; the meter now measures that traffic, checked by unit test only); nothing in 2.5 was run in a real editor. Read [What's new in 2.5](./docs/content/docs/reference/whats-new-2-5.mdx) for the known limits, and [Known gaps](./docs/content/docs/reference/known-gaps.mdx) for where Deuz is behind and what to use instead.

2.4 added versioned memory, a context compiler with working memory, transcript search, a goal supervisor with a durable scheduler and webhooks, a local Docker runner (preview) and durable chats and streams: [What's new in 2.4](./docs/content/docs/reference/whats-new-2-4.mdx).

2.3 added memory, chat and model fail-over to native runs, an MCP server and A2A, realtime voice, batch requests and Redis backends: [What's new in 2.3](./docs/content/docs/reference/whats-new-2-3.mdx).

### Add the coding-agent skill

```sh
npx skills add Deuz-AI/Deuz-SDK
```

API references and implementation guidance for your coding agent. [Explore the skill →](./skills/deuz-sdk)

---

<div align="center">

[MIT](./LICENSE) · Built by [Umutcan Edizaslan](https://github.com/U-C4N)

<sub>Built with <b>Opus 4.8 / 5</b>, <b>Fable 5 / 5.1</b>, and <b>GPT-6 Astra Ultra</b>.</sub>

</div>
