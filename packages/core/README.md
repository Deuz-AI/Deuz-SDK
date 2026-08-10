# @deuz-sdk/core

Pure, web-first, multi-provider TypeScript AI SDK — 29 provider factories across five wires — with **zero runtime dependencies** and a canonical streaming protocol of its own.

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

## What is in the box

- **Edge-safe core** — Web APIs only; everything stateful or non-deterministic (clock, randomness, `fetch`, keys, logging, tracing) is injected through one `Dependencies` seam.
- **Canonical stream** — every provider's SSE is normalized to one typed delta stream *before* anything else touches it. Retries, timeouts, tool loops, fail-over and the UI wire all build on that one language.
- **Agentic loop** — parallel tool execution, self-healing tool errors, runaway guards, budget/stop conditions, durable checkpoints, HMAC-signed human approvals, sub-agents and **agent handoffs**.
- **Guardrails** — `onInput` / `onToolCall` / `onOutput` hooks, each returning pass / block / rewrite, reported on the stream.
- **Context management** — layered compaction with a rolling summary, a manual `compactMessages()`, and automatic recovery from a provider's context-overflow rejection.
- **Persistence you can point at a database** — SQLite, Redis and Postgres packs behind the `MemoryStore` / `ChatStore` / `SessionStore` / `RunStore` seams.
- **MCP** — zero-config servers in the loop (`mcp: [{ url }]`), OAuth 2.0, sampling, roots, reconnect, and a cross-call connection pool.
- **Batteries** — memory (mem0-style), RAG with hybrid retrieval, skills, structured output, middleware, pricing, observability and an OpenTelemetry bridge.
- **Modalities** — text, images, **speech**, **transcription** and **video**.
- **React bindings** — [`@deuz-sdk/react`](https://www.npmjs.com/package/@deuz-sdk/react) (the `@deuz-sdk/core/react` subpath remains for compatibility).

## Providers

**29 built-in provider ids**, four chat wires, one call shape. A model descriptor is a plain `{ provider, modelId, surface }` value — factory settings ride a non-enumerable symbol, so keys never leak through `Object.keys` or `JSON.stringify`.

| Group | Provider ids | Subpath |
| --- | --- | --- |
| Dedicated factories (10) | `anthropic`, `openai`, `xai`, `google`, `vertex-anthropic`, `vertex-google`, `azure`, `bedrock`, `voyage`, `yunwu` | `/anthropic`, `/openai`, `/xai`, `/google`, `/vertex`, `/azure`, `/bedrock`, `/voyage`, `/yunwu` |
| OpenAI-compat cloud hosts (17) | `groq`, `mistral`, `deepseek`, `together`, `openrouter`, `cerebras`, `fireworks`, `moonshot` (a.k.a. Kimi), `qwen`, `glm`, `minimax`, `perplexity`, `cohere`, `deepinfra`, `nvidia`, `sambanova`, `hyperbolic` | `/providers` |
| Keyless local hosts (2) | `ollama`, `lmstudio` | `/providers` |

Which adapter each one uses:

| Wire | Covers |
| --- | --- |
| **Anthropic Messages** | Anthropic, Claude on Vertex |
| **OpenAI Responses** | OpenAI (GPT-5.x reasoning + tools) |
| **Gemini native** (`generateContent`) | Google Gemini, Gemini on Vertex — reasoning, thought signatures, caching, native PDF |
| **OpenAI Chat Completions** | everything else, including Gemini-compat and Azure / Bedrock |

Embeddings ship for OpenAI, Google, Voyage and Yunwu; speech adds `openai` / `elevenlabs`, transcription adds `openai` / `deepgram`, each with its own model kind so a TTS model cannot reach `streamChat` by accident.

Ollama and LM Studio need **no API key** — they dial `localhost` and set the keyless escape for you. Any other OpenAI-shaped host gets a real provider id through `createOpenAICompatible({ id, baseURL })`, and `createProviderRegistry` resolves `'groq:llama-4-maverick'` strings.

Unknown model slugs never throw: they fall back to a conservative capability row and report an `unknown-model` warning, so a model released this morning works without an SDK release. Correct the row per factory or per call with `capabilities`.

## Where it fits

Deuz is not a framework and it is not a claim about ASI. It is a small runtime you can hold in your head, for the part of the problem that does not get easier as models improve: remembering across sessions, using tools safely, surviving a crash, asking a human before something risky, and staying observable while it does. Zero runtime dependencies, no ambient state, no vendor for durability, nothing phoning home.

Node ≥ 22, or any runtime with `fetch`. Optional peers only when you use them: `zod` (or any Standard Schema library), `@modelcontextprotocol/sdk`, `react`, `unpdf` / `mammoth` / `xlsx`, `playwright`, `@opentelemetry/api`, `redis`, `pg`.

Full documentation, architecture tour and the honest limitations list: [github.com/Deuz-AI/Deuz-SDK](https://github.com/Deuz-AI/Deuz-SDK#readme).
