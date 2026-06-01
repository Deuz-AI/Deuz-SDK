<div align="center">

# `@deuz/core`

### Pure · Web-first · Multi-provider AI SDK for TypeScript

**Anthropic · OpenAI · xAI Grok · Google Gemini · Vertex AI · Yunwu**

_One canonical wire. Zero runtime dependencies. Runs anywhere `fetch` runs._

<sub>Chat · Tools · Vision · Reasoning · Embeddings · Memory · RAG · Skills · Image generation · MCP · UI streaming</sub>

</div>

---

`@deuz/core` is a from-scratch, **independent** AI SDK built for the **Deuz** platform and shared with everyone. It depends on no other AI SDK and ships its own streaming + UI protocol. It is **pure**: no Supabase, no credit logic, no env reading. Everything stateful — HTTP, clock, logging, metering, circuit-breaker, API keys, memory, vector stores — is injected through a single `Dependencies` seam, so the exact same core runs unchanged on **Node, Deno, Bun, Vercel/Cloudflare Edge**.

> **Status — Faz 4 (image generation).** Chat across all four wires + Vertex, the agentic tool loop, vision, MCP, the UI wire, native Gemini, embeddings, memory, RAG, skills, and image generation are all implemented and tested (**172 tests green**; `tsc` + `eslint` + `publint --strict` + dual ESM/CJS/d.ts build all clean). The remaining work is app-side wiring and the publish phase (see [Roadmap](#roadmap)).

```bash
npm install @deuz/core
```

Requires **Node ≥ 22**. **Zero runtime dependencies.** Optional peers, pulled in only if you use them: `zod` (or any Standard Schema lib) + `@standard-community/standard-json` for schema-typed `generateObject`; `@modelcontextprotocol/sdk` for MCP; `unpdf` / `mammoth` / `xlsx` for `@deuz/core/rag/node` document parsing.

---

## Why this exists

| Principle | What it means in practice |
| --- | --- |
| 🧊 **Pure core** | No `Date.now()` / `Math.random()` / `process.env` / `console` in `src/`. All of it injected via one `Dependencies` object → deterministic, replayable tests. |
| 🌍 **Edge-safe** | Only Web APIs (`fetch`, Web Streams, `TextDecoder`, `WebCrypto`, `atob/btoa`). `node:*` / `Buffer` are **forbidden by lint** — Node-only bits live in separate `…/node` subpaths. |
| 🔌 **Zero deps** | The chat core ships nothing in `dependencies`. Heavy or stateful things are optional peers or injected seams. |
| 🔓 **No vendor lock** | Our own canonical delta stream + our own versioned UI wire. We never proxy a provider's raw bytes to your client. |
| 🔒 **Secrets never leak** | API keys are masked in every log / error / span path, regression-tested. |

---

## Quickstart

```ts
import { streamChat, generateText, generateObject } from '@deuz/core';
import { createAnthropic } from '@deuz/core/anthropic';

// API keys are injected — core never reads process.env.
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// streamChat returns SYNCHRONOUSLY — the request starts lazily on first access.
// It never throws synchronously; errors surface via the stream + usage promise.
const res = streamChat({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Selam!' }],
  maxRetries: 2,
  onUsage: (u) => console.log(u.inputTokens, u.outputTokens),
});

for await (const chunk of res.textStream) process.stdout.write(chunk);
const usage = await res.usage; // resolves when the stream finishes
```

`generateText` / `generateObject` are awaited (buffered) calls:

```ts
import { z } from 'zod'; // any Standard Schema works; or pass a raw JSON Schema

const { object } = await generateObject({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Capital of France as JSON.' }],
  schema: z.object({ city: z.string() }),
});
```

### Tools (agentic loop)

```ts
const { text, steps } = await generateText({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Weather in Paris?' }],
  maxSteps: 5,
  tools: {
    getWeather: {
      description: 'Get the weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      execute: async ({ city }) => ({ city, tempC: 22, condition: 'sunny' }),
    },
  },
});
```

Parallel execution, self-healing on tool errors, immutable history (cache-safe), and runaway guards are built in.

### Embeddings

```ts
import { embedMany } from '@deuz/core';
import { openaiEmbedding } from '@deuz/core/openai';

const { embeddings, usage } = await embedMany({
  model: openaiEmbedding('text-embedding-3-small'),
  values: ['hello', 'world'],  // auto chunk-batched + concurrency-capped
  taskType: 'search_document', // mapped per provider (OpenAI ignores it)
});
```

### Native Gemini — AI Studio **or** Vertex

```ts
import { createGoogleNative } from '@deuz/core/google';        // AI Studio (API key)
import { createVertexGoogleNative } from '@deuz/core/vertex';  // Vertex AI (OAuth2)

// AI Studio
streamChat({
  model: createGoogleNative({ apiKey: process.env.GEMINI_API_KEY })('gemini-2.5-pro'),
  messages: [{ role: 'user', content: 'Explain RAG.' }],
  effort: 'high', // → thinkingBudget (2.5) / thinkingLevel (3); thoughtSignature round-trips
});

// Vertex AI — same native wire, OAuth2 Bearer + regional endpoint.
// Prefer a refreshing deps.keyProvider over the static accessToken (tokens expire ~hourly).
const vertex = createVertexGoogleNative({ project: 'my-gcp-project', location: 'us-central1' });
streamChat({
  model: vertex('gemini-2.5-pro'),
  deps: { keyProvider: { getKey: async () => getFreshAccessToken() } },
  messages: [{ role: 'user', content: 'Explain RAG.' }],
});
```

### Gemini explicit caching + Files API (`@deuz/core/google/extras`)

Cache a large shared prefix (system prompt, manual, transcript) once, then reuse
it across calls at the cheap **cached-read** rate. Works on AI Studio and Vertex.

```ts
import { createGeminiCache, uploadFile } from '@deuz/core/google/extras';

// 1) Cache a big prefix → reuse its name on generate calls
const cache = await createGeminiCache({
  apiKey: process.env.GEMINI_API_KEY,
  model: 'gemini-2.5-flash',
  contents: [{ role: 'user', parts: [{ text: longManual }] }],
  ttl: '3600s',
});
const { text } = await generateText({
  model: createGoogleNative({ apiKey })('gemini-2.5-flash'),
  cachedContent: cache.name, // ← prefix billed at cached-read rate
  messages: [{ role: 'user', content: 'Summarize section 4.' }],
});

// 2) Upload media too large to inline (>~20 MB) → reference its fileUri
const file = await uploadFile({ apiKey, bytes, mimeType: 'application/pdf' });
// then use { type: 'image', image: file.uri, mediaType: 'application/pdf' } as a Part
```

### Memory (mem0 pipeline + Obsidian-markdown store)

```ts
import { remember, recall } from '@deuz/core/memory';
import { createMarkdownMemoryStore } from '@deuz/core/memory/markdown'; // Node, hybrid

const store = createMarkdownMemoryStore({ dir: './memory-vault' });
// extract → reconcile (ADD/UPDATE/DELETE) → store, then semantic recall
await remember([{ role: 'user', content: 'I went vegetarian' }], { userId: 'u1' }, seams);
const hits = await recall({ scope: { userId: 'u1' }, text: 'diet' }, seams);
```

> The `MemoryStore` seam is backend-agnostic: the same interface drives a cosine vector store **or** an **Obsidian-style** markdown vault (YAML frontmatter + `[[wikilinks]]`, git-versionable, human-editable) — `search()` owns its ranking. Hybrid by default: embeddings live in a hidden sidecar so the `.md` stays clean.

### RAG

```ts
import { parse, chunkRecursive, retrieve } from '@deuz/core/rag';
import { defaultNodeParserRegistry } from '@deuz/core/rag/node'; // unpdf / mammoth / xlsx

const doc = await parse(bytes, defaultNodeParserRegistry(), { hint: { filename: 'report.pdf' } });
const chunks = chunkRecursive(doc.text, { size: 512, overlap: 64 });
```

**Hybrid search** — fuse dense (embeddings) + lexical (BM25) with Reciprocal Rank
Fusion. Embeddings catch paraphrase; BM25 catches exact terms / IDs / rare tokens
(`clause 17`, a SKU) the vector model blurs:

```ts
import { createBm25Index, hybridRetrieve, createMemoryVectorStore, indexChunks } from '@deuz/core/rag';

await indexChunks(chunks, { embedder, store });   // dense
const bm25 = createBm25Index(chunks);             // lexical (build once)

const hits = await hybridRetrieve('warm animal and GDPR clause 17', { embedder, store, bm25 }, { topK: 8 });
// semantic match AND the exact "clause 17" both surface — RRF-fused, then reranked.
```

### Skills (SKILL.md + progressive disclosure)

```ts
import { createSkillRegistry, renderSkillCatalog } from '@deuz/core/skills';
import { nodeSkillSource } from '@deuz/core/skills/node';

const skills = createSkillRegistry({ source: nodeSkillSource(['.claude/skills']) });
const block = renderSkillCatalog(await skills.catalog());   // Level 1 → system prompt
const manifest = await skills.trigger('pdf-filler');         // Level 2 → body on demand
```

### Image generation

```ts
import { generateImage } from '@deuz/core/image';        // sync (DALL·E / Flux / GPT-Image / SD)
import { imagine } from '@deuz/core/midjourney';         // async (submit → poll → action)
import { createYunwu, YUNWU_MODELS } from '@deuz/core/yunwu';

// One base URL drives every surface — chat/image/embed at /v1, Midjourney at the root.
const yunwu = createYunwu({ apiKey: process.env.YUNWU_KEY }); // or baseURL: 'https://mirror/v1'

const { images } = await generateImage({ model: yunwu.image('gpt-image-2'), prompt: '…' });
const task = await imagine({ ...yunwu.mj(), prompt: 'a robot mascot --ar 1:1' });
YUNWU_MODELS.chat;  // 2026 catalog: gpt-5.2, claude-opus-4-5, gemini-3-pro-preview, grok-4.1, …
```

### UI streaming (`@deuz/core/ui`)

```ts
// server route
import { toDeuzStreamResponse } from '@deuz/core/ui';
export async function POST(req: Request) {
  const { messages } = await req.json();
  return toDeuzStreamResponse(streamChat({ model: anthropic('claude-opus-4-8'), messages, tools }));
}

// client
import { readDeuzStream } from '@deuz/core/ui';
for await (const part of readDeuzStream(await fetch('/api/chat', { method: 'POST', body }))) {
  // { type: 'text-delta' | 'tool-call' | 'tool-result' | 'step-finish' | 'finish' | … }
}
```

---

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@deuz/core` | Free functions (`streamChat`, `generateText`, `generateObject`, `embed`), `createClient`, types, errors |
| `@deuz/core/anthropic` | Anthropic Messages provider |
| `@deuz/core/openai` | OpenAI (Chat Completions + Responses) + `openaiEmbedding` |
| `@deuz/core/xai` | xAI Grok (OpenAI-compatible) |
| `@deuz/core/google` | Gemini — compat (`createGoogle`) + native `generateContent` (`createGoogleNative`) + `googleEmbedding` |
| `@deuz/core/voyage` | Voyage AI embeddings |
| `@deuz/core/vertex` | Vertex AI — Claude + Gemini (compat **and** native `createVertexGoogleNative`) |
| `@deuz/core/pricing` | Optional USD cost table (2026) + `createPriceProvider` (token → $) |
| `@deuz/core/middleware` | `wrapModel` + `logging` / `simpleCache` / `redactPII` / `promptInjectionGuard` |
| `@deuz/core/memory` | Pure memory layer — extract / reconcile / recall + store seam |
| `@deuz/core/memory/markdown` | Obsidian-style markdown `MemoryStore` (Node; hybrid `.md` + vector sidecar) |
| `@deuz/core/rag` | RAG primitives — MIME sniff, chunkers, retrieve→rerank seam (edge-safe) |
| `@deuz/core/rag/node` | Node document parsers — unpdf / mammoth / xlsx |
| `@deuz/core/skills` | Agent Skills — SKILL.md parser, progressive-disclosure registry, matcher seam |
| `@deuz/core/skills/node` | Node filesystem `SkillSource` |
| `@deuz/core/image` | Synchronous OpenAI-compatible image generation |
| `@deuz/core/midjourney` | Async Midjourney (submit / poll / action / `imagine` + webhook) |
| `@deuz/core/yunwu` | Yunwu (云雾) unified relay — `createYunwu` + 2026 `YUNWU_MODELS` catalog |
| `@deuz/core/mcp` · `…/mcp/stdio` | MCP client (HTTP/SSE edge-safe; stdio Node-only) |
| `@deuz/core/edge` | Guaranteed edge-safe subset |
| `@deuz/core/ui` | `toDeuzStreamResponse` (server) + `readDeuzStream` (client) — our own UI wire |
| `@deuz/core/react` | React hooks (planned, Faz 6) |

---

## Architecture — the canonical line

```
Request:  canonical Message[]/Part[]  →  adapter (one of 4 wires)  →  upstream fetch
Response: upstream SSE  →  robust parser  →  CANONICAL DELTA STREAM
          (text_delta | reasoning_delta | tool_call_delta | citation | usage | finish)
          →  inference orchestration (router / retry / tool-loop)
          →  (a) canonical stream to the consumer   (b) versioned Deuz UI wire
```

`inference` never proxies raw provider SSE to the client — everything is normalized to the canonical delta stream first. Without that, abort, retry-after-first-byte, multi-wire merging, and typed UI events would be impossible.

---

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **Faz 0** | Scaffold, seam standard, publish hygiene | ✅ |
| **Faz 1** | Chat core — 4 wires, errors, resilience, metering, registry | ✅ |
| **Faz 2** | Tools + vision + MCP + UI wire | ✅ |
| **Faz 3** | Skills + memory + RAG + native Gemini + embeddings | ✅ |
| **Faz 4** | Image generation (sync + Midjourney + Yunwu) | ✅ SDK side · ⏳ app-side `tasks` table |
| **Faz 5** | Aggregator fallback, DeepSeek/Kimi, Batch API, rate-limiter impl | ⬜ optional |
| **Faz 6** | `1.0.0` publish, `@deuz/react` hooks, docs, CI provenance | ⬜ |

**Deliberately deferred** (seam exists, impl later): `streamObject`, pre-flight token counting (`tokens.ts`), budgeter, pricing seam, `wrapModel` middleware, full token-bucket rate limiter, OpenTelemetry / PII / prompt-injection seams, memory consolidation/decay + graph memory, RAG hybrid search (BM25+RRF) + cross-encoder rerank, Gemini explicit caching + Files API, native Vertex Gemini, video generation helper.

---

## Quality bar

- **172 tests** (vitest + MSW golden-replay fixtures + deterministic mock models)
- `tsc` strict · `eslint` (edge-safety enforced) · `publint --strict` · `attw` · dual **ESM + CJS + .d.ts** build — all green
- ~10k lines across 55 source modules, zero runtime dependencies

---

## Credits

<div align="center">

**Founder — [Umutcan Edizaslan](https://github.com/U-C4N)**

_Helping by_

🤖 **Codex 5.5** · 🧠 **Claude Opus 4.8** · ⚡ **ultracode**

<sub>Designed, researched, and built with a multi-agent workflow — adversarial review, live API verification, and deep web research at every phase.</sub>

</div>

---

## License

[MIT](./LICENSE) © 2026 Umutcan Edizaslan
