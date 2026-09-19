# @deuz-sdk/core

A TypeScript runtime for agents that have to survive production — **zero runtime dependencies**, 28 chat providers across four wires, and a canonical streaming protocol of its own.

**2.1 adds optional native agents and a fixed-DAG swarm scheduler.** Existing generation, streaming and `createAgent` methods retain their contracts.

[Native agents](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/native-agents.mdx) · [Swarm](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/swarm.mdx) · [Changelog](https://github.com/Deuz-AI/Deuz-SDK/blob/main/packages/core/CHANGELOG.md)

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

Tool execution uses the canonical loop, then finalizes with application tools disabled. Tools can validate their own context and result, retain a raw result receipt, and use `toModelOutput` to project what the model receives.

Native sessions store a versioned `AgentRunEnvelope` through `AgentRunStore`; this is separate from the legacy `SessionStore` checkpoint contract. `resumeAgent` checks identity and bindings, preserves pending approvals when verdicts are absent, and reuses completed stored results. Failed durable writes stop execution. The [native guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/native-agents.mdx) covers stores, approval/client-tool resume and reconciliation.

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

Swarm runs a fixed DAG of agents and reducers, with dependency handling, cancellation and a cursor-based control-event journal. The in-memory store is volatile. The Node-only `@deuz-sdk/core/swarm/sqlite` entry atomically persists run state, tasks and journal events. Completed tasks are reused; uncertain effects need reconciliation before replay. Version 2.1 requires one executor per run and has no distributed worker or cross-process lease protocol. [Swarm guide](https://github.com/Deuz-AI/Deuz-SDK/blob/main/docs/content/docs/modules/swarm.mdx).

`createExecutionContext` adds inherited model/tool policy and shared token/USD accounting. Reservations are persisted before dispatch; known usage settles them, while unknown usage or pricing keeps amounts held. Budget admission uses estimates and cannot guarantee a provider's final invoice. Native sessions preserve an existing shared ledger rather than resetting it on resume.

## Memory and context for long runs

**Memory that outlives the session.** Not a message array — a pipeline that extracts durable facts, reconciles them against what it already knows (add / update / delete, never blind appends), scores them for importance, expires them, and pulls the relevant ones back on the next call.

```ts
await generateText({
  model,
  messages,
  memory: {
    seams: { store, embedder, llm: model },
    scope: { userId },
    recall: { topK: 6, maxChars: 2000, expandLinks: 1 },
  },
});
```

**Compaction that keeps a long run alive.** When the window fills, it prunes stale tool output, drops old reasoning, and folds the earliest turns into a single running summary — one block that gets updated, not a stack that grows. When a provider rejects a request as too long anyway, the loop force-compacts and retries that step instead of failing the run.

```ts
await generateText({ model, messages, maxSteps: 30, compaction: 'auto' });
```

## What else is in the box

- **Edge-safe core** — Web APIs only; everything stateful or non-deterministic (clock, randomness, `fetch`, keys, logging, tracing) is injected through one `Dependencies` seam.
- **Canonical stream** — every provider's SSE is normalized to one typed delta stream _before_ anything else touches it. Retries, timeouts, tool loops, fail-over and the UI wire all build on that one language.
- **Agentic loop** — parallel tool execution, self-healing tool errors, runaway guards, budget and stop conditions, durable checkpoints, HMAC-signed human approvals, sub-agents, and **agent handoffs** that move the conversation, tools and model together.
- **Guardrails** — `onInput` / `onToolCall` / `onOutput`, each returning pass / block / rewrite, reported on the stream rather than applied invisibly.
- **Persistence you point at a database** — SQLite, Redis and Postgres packs behind the `MemoryStore` / `ChatStore` / `SessionStore` / `RunStore` seams, all held to one shared conformance suite.
- **MCP** — zero-config servers in the loop (`mcp: [{ url }]`), OAuth 2.0, sampling, roots, reconnect with backoff, and a cross-call connection pool.
- **Batteries** — RAG with hybrid retrieval, skills, structured output, middleware, pricing, observability and an OpenTelemetry bridge.
- **Modalities** — text, images, **speech**, **transcription** and **video**.
- **React bindings** — [`@deuz-sdk/react`](https://www.npmjs.com/package/@deuz-sdk/react).

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

Unknown model slugs never throw: they fall back to a conservative capability row and report an `unknown-model` warning, so a model released this morning works without an SDK release. Correct the row per factory or per call with `capabilities`. That path is verified against live APIs rather than only in theory — `grok-4.5` and `gemini-3.6-flash` both postdate the pinned rows and both run end to end, tool loop included.

## Where it fits

Deuz is not a framework and it is not a claim about ASI. It is a small runtime you can hold in your head, for the part of the problem that does not get easier as models improve: remembering across sessions, using tools safely, surviving a crash, asking a human before something risky, and staying observable while it does.

The native engine currently rejects `chat`, `memory`, `fallbackModels` and legacy completion hooks; these remain available through the existing APIs. Native `verify` has its own three-outcome contract. Legacy `resumeFromCheckpoint` retains its missing-verdict default-deny behavior. Native store operations require one executor per run; coordinating separate processes or store wrappers remains the application's responsibility. Receipts do not provide exactly-once external effects.

The limitations are documented next to the features rather than left to be discovered: overflow recovery does not reach the Gemini native wire, `generateObject` cannot coerce a DeepSeek V4 model, the Redis pack has no `MULTI`, token counting is a calibrated heuristic unless you supply a tokenizer, and speech / transcription / video are covered by mocked tests but not yet by a live one.

Node ≥ 22, or any runtime with `fetch`. Optional peers only when you use them: `zod` (or any Standard Schema library), `@modelcontextprotocol/sdk`, `react`, `unpdf` / `mammoth` / `xlsx`, `playwright`, `@opentelemetry/api`, `redis`, `pg`.

Full documentation, architecture tour and the complete limitations list: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).

The package publishes **56 export entries, including `./package.json`**. Native APIs are in `/agent`, `/swarm`, and `/swarm/sqlite`; provider, memory, chat, MCP, observability and legacy durable APIs retain their existing entry points.
