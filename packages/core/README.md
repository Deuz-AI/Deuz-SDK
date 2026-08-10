# @deuz-sdk/core

A TypeScript runtime for agents that have to survive production — **zero runtime dependencies**, 28 chat providers across four wires, and a canonical streaming protocol of its own.

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

## The two things nobody else ships

Calling a model is a solved problem. These are the parts you would otherwise build yourself.

**Memory that outlives the session.** Not a message array — a pipeline that extracts durable facts, reconciles them against what it already knows (add / update / delete, never blind appends), scores them for importance, expires them, and pulls the relevant ones back on the next call.

```ts
await generateText({
  model, messages,
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
- **Canonical stream** — every provider's SSE is normalized to one typed delta stream *before* anything else touches it. Retries, timeouts, tool loops, fail-over and the UI wire all build on that one language.
- **Agentic loop** — parallel tool execution, self-healing tool errors, runaway guards, budget and stop conditions, durable checkpoints, HMAC-signed human approvals, sub-agents, and **agent handoffs** that move the conversation, tools and model together.
- **Guardrails** — `onInput` / `onToolCall` / `onOutput`, each returning pass / block / rewrite, reported on the stream rather than applied invisibly.
- **Persistence you point at a database** — SQLite, Redis and Postgres packs behind the `MemoryStore` / `ChatStore` / `SessionStore` / `RunStore` seams, all held to one shared conformance suite.
- **MCP** — zero-config servers in the loop (`mcp: [{ url }]`), OAuth 2.0, sampling, roots, reconnect with backoff, and a cross-call connection pool.
- **Batteries** — RAG with hybrid retrieval, skills, structured output, middleware, pricing, observability and an OpenTelemetry bridge.
- **Modalities** — text, images, **speech**, **transcription** and **video**.
- **React bindings** — [`@deuz-sdk/react`](https://www.npmjs.com/package/@deuz-sdk/react).

## Providers

**28 chat provider ids**, four wires, one call shape. A *provider id* is the string a descriptor carries and the key that resolves an API key and a base URL; a *factory* is the function that mints descriptors for it. The two do not count the same — `createOpenAI` and `createOpenAIResponses` are two factories over the one id `openai`, and `createKimi` is an alias of `createMoonshot`. A model descriptor is a plain `{ provider, modelId, surface }` value, and factory settings ride a non-enumerable symbol, so keys never leak through `Object.keys` or `JSON.stringify`.

| Group | Provider ids | Subpath |
| --- | --- | --- |
| Dedicated (9 ids) | `anthropic`, `openai`, `xai`, `google`, `vertex-anthropic`, `vertex-google`, `azure`, `bedrock`, `yunwu` | `/anthropic`, `/openai`, `/xai`, `/google`, `/vertex`, `/azure`, `/bedrock`, `/yunwu` |
| OpenAI-compat cloud hosts (17 ids) | `groq`, `mistral`, `deepseek`, `together`, `openrouter`, `cerebras`, `fireworks`, `moonshot` (a.k.a. Kimi), `qwen`, `glm`, `minimax`, `perplexity`, `cohere`, `deepinfra`, `nvidia`, `sambanova`, `hyperbolic` | `/providers` |
| Keyless local hosts (2 ids) | `ollama`, `lmstudio` | `/providers` |

`voyage` is deliberately absent: it is an embeddings provider, so it speaks none of the four chat wires and cannot be handed to `streamChat`.

Which wire each one speaks — the exhaustive `ModelSurface` → adapter switch:

| Wire (`surface`) | Covers |
| --- | --- |
| **Anthropic Messages** (`anthropic`) | Anthropic, Claude on Vertex |
| **OpenAI Responses** (`responses`) | OpenAI (GPT-5.x reasoning + tools) |
| **Gemini native** (`native`, `generateContent`) | Google Gemini, Gemini on Vertex — reasoning, thought signatures, caching, native PDF |
| **OpenAI Chat Completions** (`chat_completions`) | everything else, including Gemini-compat and Azure / Bedrock |

Embeddings, images, speech, transcription and video are **separate model kinds** with their own surfaces and adapters — not chat wires, and none of them can be handed to `streamChat` by accident. Embeddings ship for OpenAI, Google, Voyage and Yunwu; speech adds `openai` / `elevenlabs`, transcription adds `openai` / `deepgram`, video any OpenAI-Videos-shaped relay.

Ollama and LM Studio need **no API key** — they dial `localhost` and set the keyless escape for you, without weakening the key-precedence chain for anyone else. Any other OpenAI-shaped host gets a real provider id through `createOpenAICompatible({ id, baseURL })`, and `createProviderRegistry` resolves `'groq:llama-4-maverick'` strings.

Unknown model slugs never throw: they fall back to a conservative capability row and report an `unknown-model` warning, so a model released this morning works without an SDK release. Correct the row per factory or per call with `capabilities`. That path is verified against live APIs rather than only in theory — `grok-4.5` and `gemini-3.6-flash` both postdate the pinned rows and both run end to end, tool loop included.

## Where it fits

Deuz is not a framework and it is not a claim about ASI. It is a small runtime you can hold in your head, for the part of the problem that does not get easier as models improve: remembering across sessions, using tools safely, surviving a crash, asking a human before something risky, and staying observable while it does.

Need the largest ecosystem today? Use the Vercel AI SDK — that gap is real. This is the other trade: zero runtime dependencies, no ambient state, no vendor for durability, nothing phoning home.

The limitations are documented next to the features rather than left to be discovered: overflow recovery does not reach the Gemini native wire, `generateObject` cannot coerce a DeepSeek V4 model, the Redis pack has no `MULTI`, token counting is a calibrated heuristic unless you supply a tokenizer, and speech / transcription / video are covered by mocked tests but not yet by a live one.

Node ≥ 22, or any runtime with `fetch`. Optional peers only when you use them: `zod` (or any Standard Schema library), `@modelcontextprotocol/sdk`, `react`, `unpdf` / `mammoth` / `xlsx`, `playwright`, `@opentelemetry/api`, `redis`, `pg`.

Full documentation, architecture tour and the complete limitations list: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).
