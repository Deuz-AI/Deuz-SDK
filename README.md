<div align="center">

# Deuz SDK

**One TypeScript SDK. Models, agents, and swarms.**

[![npm](https://img.shields.io/npm/v/%40deuz-sdk%2Fcore?style=flat-square&label=npm&color=18181b)](https://www.npmjs.com/package/@deuz-sdk/core)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-18181b?style=flat-square)](./packages/core/package.json)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](./LICENSE)

[Documentation](https://deuz-sdk.tech/docs) · [Examples](./examples) · [What's new in 2.2](./docs/content/docs/reference/whats-new-2-2.mdx)

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

## What ships

- **Models** — multiple providers, streaming, structured output, and tool calls.
- **Agents** — typed results, verification, approvals, and resumable runs.
- **Swarms** — task dependencies, runtime spawning, shared blackboards, rounds, and SQLite or Postgres persistence.
- **Operations** — leases, drain, cross-process cancel and recovery, persistent budgets, and schedules.
- **Evolve** — evolutionary program search with a mandatory budget and zero-call resume.
- **Context** — memory, retrieval, compaction, and MCP tools.
- **Control** — shared execution policies, budget accounting, traces, and optional React bindings.

Core has zero required runtime dependencies; integrations use optional peers. Without a lease provider, drive each swarm run from one process; uncertain external effects require reconciliation before retry.

[Agents](./docs/content/docs/modules/native-agents.mdx) · [Swarms](./docs/content/docs/modules/swarm.mdx) · [React](./docs/content/docs/modules/react-hooks.mdx) · [Changelog](./packages/core/CHANGELOG.md)

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
