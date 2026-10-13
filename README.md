<div align="center">

# Deuz SDK

**One TypeScript SDK. Models, agents, and swarms.**

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=18181b)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-18181b?style=flat-square)](./packages/core/package.json)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](./LICENSE)

[Documentation](https://deuz-sdk.tech/docs) · [Examples](./examples) · [What's new in 2.3](./docs/content/docs/reference/whats-new-2-3.mdx)

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

The repository has twenty [examples](./examples): 01–06 call Anthropic with your key, and 07–20 run without a key or network.

## What ships

- **Models** — multiple providers, streaming, structured output, tool calls, realtime voice, and batch requests.
- **Agents** — typed results, verification, approvals, resumable runs, and memory, chat and model fail-over.
- **Swarms** — task dependencies, runtime spawning, shared blackboards, rounds, and SQLite, Postgres or Redis persistence.
- **Operations** — leases, drain, cross-process cancel and recovery, persistent budgets, schedules, goal records, and a headless preview.
- **Evolve** — evolutionary program search with a mandatory budget and zero-call resume.
- **Context** — memory, retrieval, compaction, and MCP tools.
- **Interop** — an MCP server, and A2A to call other agents and serve your own.
- **Control** — shared execution policies, budget accounting, traces, eval suites, and optional React bindings.

Core has zero required runtime dependencies; integrations use optional peers. Without a lease provider, drive each swarm or native agent run from one process; uncertain external effects require reconciliation before retry.

[Agents](./docs/content/docs/modules/native-agents.mdx) · [Swarms](./docs/content/docs/modules/swarm.mdx) · [React](./docs/content/docs/modules/react-hooks.mdx) · [Changelog](./packages/core/CHANGELOG.md)

### New in 2.3

- **Native runs** — memory, chat and model fail-over, and one path for every tool call: policy, approval, budget admission and an effect receipt.
- **Interop** — the MCP 2026-07-28 client, an MCP server, and A2A in both directions.
- **Models** — realtime voice on OpenAI Realtime and Gemini Live, provider batch requests, model profiles, a stable request prefix for Claude 5.x thinking, usage billed once, and models without a price under USD budgets.
- **Redis** — backends for swarms, leases, native runs, schedule claims and budgets.
- **UI** — `useChat` drives native agent runs, with their approvals and client tools.
- **Goals and evals** — goal records, versioned eval suites, and a headless preview for scripts and CI.

Nothing in 2.3 was run against a live provider or third-party service; it is tested offline. Read [What's new in 2.3](./docs/content/docs/reference/whats-new-2-3.mdx) for the upgrade notes and known limits before you deploy.

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
