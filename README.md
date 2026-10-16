<div align="center">

# Deuz SDK

**One TypeScript SDK. Models, agents, and swarms.**

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=18181b)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-18181b?style=flat-square)](./packages/core/package.json)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](./LICENSE)

[Documentation](https://deuz-sdk.tech/docs) · [Examples](./examples) · [What's new in 2.4](./docs/content/docs/reference/whats-new-2-4.mdx)

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
- **Interop** — an MCP server, and A2A to call other agents and serve your own.
- **Control** — shared execution policies, budget accounting, traces, eval suites, and optional React bindings.

Core has zero required runtime dependencies; integrations use optional peers. Without a lease provider, drive each swarm or native agent run from one process; uncertain external effects require reconciliation before retry.

[Agents](./docs/content/docs/modules/native-agents.mdx) · [Swarms](./docs/content/docs/modules/swarm.mdx) · [React](./docs/content/docs/modules/react-hooks.mdx) · [Changelog](./packages/core/CHANGELOG.md)

### New in 2.4

2.3 agents worked well inside one conversation. 2.4 adds what an agent needs to keep working over days: memory it can trust, background work that survives a crash, and chats that do not break.

- **Remembers over time** — [versioned memory](./docs/content/docs/modules/versioned-memory.mdx) keeps every fact with its history and its source, and `forget` deletes a fact and redacts the stored context that held it.
- **Picks the right context** — a [context compiler](./docs/content/docs/modules/context.mdx) fits memory, documents, past chats and skills into one token budget, next to a small working memory for the goal, constraints and decisions. [Transcript search](./docs/content/docs/modules/transcript-search.mdx) finds past messages.
- **Works on its own** — a [goal supervisor](./docs/content/docs/modules/goal-runtime.mdx) runs goals on a schedule (time zones and daylight saving included) and from verified webhooks, and resumes after a crash without repeating an external effect or charging usage twice.
- **Runs code in a box** — a local [Docker sandbox](./docs/content/docs/modules/docker.mdx) for agent-written code (preview).
- **Keeps the chat alive** — answers continue after a dropped connection or a page reload, without duplicates, and a React chat can be saved and restored as a [snapshot](./docs/content/docs/modules/chat-durability.mdx).
- **Proves it is done** — a goal completes only on evidence the host can check, such as the digest of the file a run produced.
- **Learns from success** — a verified run can be turned into a draft skill for you to review.

Every 2.4 feature is off until you configure it; with them off, provider requests are byte-identical to 2.3's. A few 2.3 behaviours changed (bug fixes, and one new request header from `useChat`); the upgrade notes list each one. A 2.3 install can still open a database that 2.4 wrote, so you can roll back. Nothing in 2.4 was run against a model provider: model calls are tested against scripted models, and the new stores and the Docker runner against real SQLite, PostgreSQL, Redis and Docker. Read [What's new in 2.4](./docs/content/docs/reference/whats-new-2-4.mdx) for the upgrade notes and known limits before you deploy.

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
