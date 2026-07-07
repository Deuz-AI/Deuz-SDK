<div align="center">

# `@deuz-sdk/core`

### Pure · Web-first · Multi-provider AI SDK for TypeScript

**Anthropic · OpenAI · xAI Grok · Google Gemini · Vertex AI · Yunwu**

_One canonical wire. Zero runtime dependencies. Runs anywhere `fetch` runs._

<sub>Chat · Tools · Sub-agents · Vision · Reasoning · Embeddings · Memory · RAG · Skills · Image generation · MCP · UI streaming</sub>

</div>

---

`@deuz-sdk/core` is a from-scratch, **independent** AI SDK built for the **Deuz** platform and shared with everyone. It depends on no other AI SDK and ships its own streaming + UI protocol. It is **pure**: no Supabase, no credit logic, no env reading. Everything stateful — HTTP, clock, logging, metering, circuit-breaker, API keys, memory, vector stores — is injected through a single `Dependencies` seam, so the exact same core runs unchanged on **Node, Deno, Bun, Vercel/Cloudflare Edge**.

[`@deuz-sdk/core`](https://www.npmjs.com/package/@deuz-sdk/core) is published on npm. Chat across all four wires plus Vertex, the agentic tool loop, vision, MCP, the UI wire, native Gemini, embeddings, memory, RAG, skills, image generation, middleware, pricing, hybrid RAG search, and Gemini explicit caching are all implemented and tested — **411 tests green** across 41 files; `tsc` + `eslint` + `publint --strict` + `attw` + dual ESM/CJS/`.d.ts` build all clean.

### Highlights (v1.5.0 "Durable")

- **Durable sessions** — `session: { store, runId? }`; both agentic loops (top-level and sub-agent) checkpoint at every step boundary into a two-method `SessionStore` seam over any backend, no vendor runtime required.
- **Checkpoint resume** — `resumeFromCheckpoint` / `resumeStreamFromCheckpoint` (from `@deuz-sdk/core/durable`) continue a crashed or suspended run with cumulative usage and step indices preserved across legs; resuming without a verdict default-denies pending gated calls.
- **Client-mode approval inside sub-agents** — the 1.4 limitation is removed: a gated call inside `agentTool` suspends child and parent into checkpoints, and `agentPath`-tagged approvals route verdicts back down the tree on resume.
- **HMAC-signed approvals** — `createApprovalSigner` issues WebCrypto HMAC-SHA256 tokens bound to `runId` with `maxAgeMs` expiry, closing the `approvalResponses` trust boundary.

Full release history is in [`CHANGELOG.md`](./CHANGELOG.md). See the [Roadmap](#roadmap) for what's next.

```bash
npm install @deuz-sdk/core
```

Requires **Node ≥ 22**. **Zero runtime dependencies.** Optional peers, pulled in only if you use them: `zod` (or any Standard Schema lib) + `@standard-community/standard-json` for schema-typed `generateObject`; `@modelcontextprotocol/sdk` for MCP; `unpdf` / `mammoth` / `xlsx` for `@deuz-sdk/core/rag/node` document parsing.

**Documentation** — the full docs site lives in [`docs/`](./docs) (Fumadocs; 40 pages covering every module, with `llms.txt` / `llms-full.txt` for AI agents). **Claude Code skill** — [`skills/deuz-sdk/`](./skills/deuz-sdk) teaches AI coding agents to integrate the SDK correctly.

---

## Why this exists

| Principle | What it means in practice |
| --- | --- |
| **Pure core** | No `Date.now()` / `Math.random()` / `process.env` / `console` in `src/`. All of it injected via one `Dependencies` object → deterministic, replayable tests. |
| **Edge-safe** | Only Web APIs (`fetch`, Web Streams, `TextDecoder`, `WebCrypto`, `atob/btoa`). `node:*` / `Buffer` are **forbidden by lint** — Node-only bits live in separate `…/node` subpaths. |
| **Zero deps** | The chat core ships nothing in `dependencies`. Heavy or stateful things are optional peers or injected seams. |
| **No vendor lock** | Our own canonical delta stream + our own versioned UI wire. We never proxy a provider's raw bytes to your client. |
| **Secrets never leak** | API keys are masked in every log / error / span path, regression-tested. |

---

## Quickstart

```ts
import { streamChat, generateText, generateObject, streamObject } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

// API keys are injected — core never reads process.env.
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// streamChat returns SYNCHRONOUSLY — the request starts lazily on first access.
// It never throws synchronously; errors surface via the stream + usage promise.
const res = streamChat({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Hello!' }],
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

`streamObject` streams the same thing progressively — partial objects on every meaningful delta, validated final value at the end (sync return, G2 semantics):

```ts
const result = streamObject({ model, messages, schema });
for await (const partial of result.partialObjectStream) render(partial); // DeepPartial<T>
const value = await result.object;
```

### React hooks

`useChat` / `useObject` over the Deuz UI wire (React is an **optional peer** `^18 || ^19`):

```ts
import { useChat } from '@deuz-sdk/core/react';

const { messages, sendMessage, pendingApprovals, addToolApprovalResponse } = useChat({
  api: '/api/chat',
  onToolCall: async (call) => runInBrowser(call), // client tools auto-round-trip
});
// Gated tools pause into pendingApprovals; verdicts resume the chat automatically.
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

Parallel execution, self-healing on tool errors, immutable history (cache-safe), and runaway guards are built in. **Tool approval** is wired end-to-end: gate a tool with `needsApproval`, then either decide inline (`approveToolCall`) or let the loop break with `pendingApprovals` / `tool-approval-request` parts and resume via `approvalResponses`. **Loop hooks** — `prepareStep` (per-step model/tools/history rewrite) and `activeTools` (static per-call tool filter) — give fine-grained control over long loops; **budget stop conditions** — `totalTokensExceed`, `costExceeds` — bound the loop by real spend, OR-ed into `stopWhen` alongside `stepCountIs`/`hasToolCall`; and opt-in **`compaction: 'auto'`** automatically prunes old tool results/reasoning and summarizes the oldest history once context fills up, immutable- and cache-safe.

### Sub-agents (`agentTool`)

```ts
import { agentTool, generateText } from '@deuz-sdk/core';

const { text } = await generateText({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Research the latest release notes and summarize them.' }],
  maxSteps: 5,
  tools: {
    researcher: agentTool({
      name: 'researcher', // same string as the tools-map key
      description: 'Delegate research tasks to a focused sub-agent.',
      model: anthropic('claude-haiku-5'),
      tools: { webSearch /* … */ },
    }),
  },
});
```

A sub-agent is a nested agentic loop wrapped as an ordinary `Tool` — no new runtime. Two things are first-class here: when the parent streams, the sub-agent's **entire canonical stream forwards live** into the parent's `fullStream` as `agentPath`-tagged `sub-agent` parts (rather than only surfacing the final text), and the parent's server-mode `approveToolCall` is **inherited to every nesting depth**, so a sub-agent's own tool calls stay gated with no extra wiring. `maxDepth` guards against runaway nesting, usage folds into the parent total (tagged with `agentPath`), and abort propagates down. See the [sub-agents docs](./docs/content/docs/agents/subagents.mdx) for a side-by-side comparison with the agent-as-tool pattern.

### Embeddings

```ts
import { embedMany } from '@deuz-sdk/core';
import { openaiEmbedding } from '@deuz-sdk/core/openai';

const { embeddings, usage } = await embedMany({
  model: openaiEmbedding('text-embedding-3-small'),
  values: ['hello', 'world'],  // auto chunk-batched + concurrency-capped
  taskType: 'search_document', // mapped per provider (OpenAI ignores it)
});
```

### Native Gemini — AI Studio **or** Vertex

```ts
import { createGoogleNative } from '@deuz-sdk/core/google';        // AI Studio (API key)
import { createVertexGoogleNative } from '@deuz-sdk/core/vertex';  // Vertex AI (OAuth2)

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

### Gemini explicit caching + Files API (`@deuz-sdk/core/google/extras`)

Cache a large shared prefix (system prompt, manual, transcript) once, then reuse
it across calls at the cheap **cached-read** rate. Works on AI Studio and Vertex.

```ts
import { createGeminiCache, uploadFile } from '@deuz-sdk/core/google/extras';

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
import { remember, recall } from '@deuz-sdk/core/memory';
import { createMarkdownMemoryStore } from '@deuz-sdk/core/memory/markdown'; // Node, hybrid

const store = createMarkdownMemoryStore({ dir: './memory-vault' });
// extract → reconcile (ADD/UPDATE/DELETE) → store, then semantic recall
await remember([{ role: 'user', content: 'I went vegetarian' }], { userId: 'u1' }, seams);
const hits = await recall({ scope: { userId: 'u1' }, text: 'diet' }, seams);
```

> The `MemoryStore` seam is backend-agnostic: the same interface drives a cosine vector store **or** an **Obsidian-style** markdown vault (YAML frontmatter + `[[wikilinks]]`, git-versionable, human-editable) — `search()` owns its ranking. Hybrid by default: embeddings live in a hidden sidecar so the `.md` stays clean.

### RAG

```ts
import { parse, chunkRecursive, retrieve } from '@deuz-sdk/core/rag';
import { defaultNodeParserRegistry } from '@deuz-sdk/core/rag/node'; // unpdf / mammoth / xlsx

const doc = await parse(bytes, defaultNodeParserRegistry(), { hint: { filename: 'report.pdf' } });
const chunks = chunkRecursive(doc.text, { size: 512, overlap: 64 });
```

**Hybrid search** — fuse dense (embeddings) + lexical (BM25) with Reciprocal Rank
Fusion. Embeddings catch paraphrase; BM25 catches exact terms / IDs / rare tokens
(`clause 17`, a SKU) the vector model blurs:

```ts
import { createBm25Index, hybridRetrieve, createMemoryVectorStore, indexChunks } from '@deuz-sdk/core/rag';

await indexChunks(chunks, { embedder, store });   // dense
const bm25 = createBm25Index(chunks);             // lexical (build once)

const hits = await hybridRetrieve('warm animal and GDPR clause 17', { embedder, store, bm25 }, { topK: 8 });
// semantic match AND the exact "clause 17" both surface — RRF-fused ranking.
```

### Skills (SKILL.md + progressive disclosure)

```ts
import { createSkillRegistry, renderSkillCatalog } from '@deuz-sdk/core/skills';
import { nodeSkillSource } from '@deuz-sdk/core/skills/node';

const skills = createSkillRegistry({ source: nodeSkillSource(['.claude/skills']) });
const block = renderSkillCatalog(await skills.catalog());   // Level 1 → system prompt
const manifest = await skills.trigger('pdf-filler');         // Level 2 → body on demand
```

### Image generation

```ts
import { generateImage } from '@deuz-sdk/core/image';        // sync (DALL·E / Flux / GPT-Image / SD)
import { imagine } from '@deuz-sdk/core/midjourney';         // async (submit → poll → action)
import { createYunwu, YUNWU_MODELS } from '@deuz-sdk/core/yunwu';

// One base URL drives every surface — chat/image/embed at /v1, Midjourney at the root.
const yunwu = createYunwu({ apiKey: process.env.YUNWU_KEY }); // or baseURL: 'https://mirror/v1'

const { images } = await generateImage({ model: yunwu.image('gpt-image-2'), prompt: '…' });
const task = await imagine({ ...yunwu.mj(), prompt: 'a robot mascot --ar 1:1' });
YUNWU_MODELS.chat;  // 2026 catalog: gpt-5.2, claude-opus-4-5, gemini-3-pro-preview, grok-4.1, …
```

### Durable sessions (`@deuz-sdk/core/durable`)

Checkpoint an agentic loop at every step boundary and resume it later — across a
process restart, a suspended human-approval gate, or a crashed leg — without any
vendor-specific runtime.

```ts
import { resumeFromCheckpoint, resumeStreamFromCheckpoint } from '@deuz-sdk/core/durable';

// First leg: pass a session store + runId; the loop checkpoints after each step.
const { text, steps } = await generateText({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Draft the release notes.' }],
  tools: { publish: { /* … needsApproval: true */ } },
  session: { store, runId: 'run-42' },
});

// If a step is pending approval (or the process died), resume the same run later.
const resumed = await resumeFromCheckpoint({ store, runId: 'run-42' }, { model: anthropic, tools });

// Streaming variant preserves cumulative usage and step indices across legs.
const res = resumeStreamFromCheckpoint({ store, runId: 'run-42' }, { model: anthropic, tools });
```

Resuming a run with a pending gated call and no supplied verdict **default-denies**
that call rather than silently proceeding. Approvals can be signed with
`createApprovalSigner` (WebCrypto HMAC-SHA256, bound to `runId`, with `maxAgeMs`
expiry) to close the trust boundary on `approvalResponses` coming back from a client.

### UI streaming (`@deuz-sdk/core/ui`)

```ts
// server route
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
export async function POST(req: Request) {
  const { messages } = await req.json();
  return toDeuzStreamResponse(streamChat({ model: anthropic('claude-opus-4-8'), messages, tools }));
}

// client
import { readDeuzStream } from '@deuz-sdk/core/ui';
for await (const part of readDeuzStream(await fetch('/api/chat', { method: 'POST', body }))) {
  // { type: 'text-delta' | 'tool-call' | 'tool-result' | 'step-finish' | 'finish' | … }
}
```

---

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@deuz-sdk/core` | Free functions (`streamChat`, `generateText`, `generateObject`, `streamObject`, `embed`), `createClient`, types, errors |
| `@deuz-sdk/core/anthropic` | Anthropic Messages provider |
| `@deuz-sdk/core/openai` | OpenAI (Chat Completions + Responses) + `openaiEmbedding` |
| `@deuz-sdk/core/xai` | xAI Grok (OpenAI-compatible) |
| `@deuz-sdk/core/google` | Gemini — compat (`createGoogle`) + native `generateContent` (`createGoogleNative`) + `googleEmbedding` |
| `@deuz-sdk/core/google/extras` | Gemini explicit caching (`createGeminiCache`) + Files API (`uploadFile`) |
| `@deuz-sdk/core/voyage` | Voyage AI embeddings |
| `@deuz-sdk/core/pricing` | Optional USD cost table (2026) + `createPriceProvider` (token → $) |
| `@deuz-sdk/core/middleware` | `wrapModel` + `logging` / `simpleCache` / `redactPII` / `promptInjectionGuard` |
| `@deuz-sdk/core/image` | Synchronous OpenAI-compatible image generation |
| `@deuz-sdk/core/midjourney` | Async Midjourney (submit / poll / action / `imagine` + webhook) |
| `@deuz-sdk/core/yunwu` | Yunwu (云雾) unified relay — `createYunwu` + 2026 `YUNWU_MODELS` catalog |
| `@deuz-sdk/core/memory` | Pure memory layer — extract / reconcile / recall + store seam |
| `@deuz-sdk/core/memory/markdown` | Obsidian-style markdown `MemoryStore` (Node; hybrid `.md` + vector sidecar) |
| `@deuz-sdk/core/rag` | RAG primitives — MIME sniff, chunkers, retrieve→rerank seam (edge-safe) |
| `@deuz-sdk/core/rag/node` | Node document parsers — unpdf / mammoth / xlsx |
| `@deuz-sdk/core/skills` | Agent Skills — SKILL.md parser, progressive-disclosure registry, matcher seam |
| `@deuz-sdk/core/skills/node` | Node filesystem `SkillSource` |
| `@deuz-sdk/core/vertex` | Vertex AI — Claude + Gemini (compat **and** native `createVertexGoogleNative`) |
| `@deuz-sdk/core/mcp` · `…/mcp/stdio` | MCP client (HTTP/SSE edge-safe; stdio Node-only) |
| `@deuz-sdk/core/durable` | Durable sessions — `resumeFromCheckpoint` / `resumeStreamFromCheckpoint` + `createApprovalSigner` |
| `@deuz-sdk/core/edge` | Guaranteed edge-safe subset |
| `@deuz-sdk/core/ui` | `toDeuzStreamResponse` (server) + `readDeuzStream` (client) — our own UI wire |
| `@deuz-sdk/core/react` | React hooks — `useChat` (client tools + approvals) / `useObject` (React = optional peer) |

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
| **Faz 0** | Scaffold, seam standard, publish hygiene | done |
| **Faz 1** | Chat core — 4 wires, errors, resilience, metering, registry | done |
| **Faz 2** | Tools + vision + MCP + UI wire | done |
| **Faz 3** | Skills + memory + RAG + native Gemini + embeddings | done |
| **Faz 4** | Image generation (sync + Midjourney + Yunwu) | SDK side done · app-side `tasks` table pending |
| **Faz 5** | Aggregator fallback, DeepSeek/Kimi, Batch API, rate-limiter impl | optional |
| **Faz 6** | `@deuz-sdk/core/react` hooks, CI provenance | hooks done · CI provenance pending |

**Deliberately deferred** (seam exists, impl later): pre-flight token counting (`tokens.ts`), budgeter, full token-bucket rate limiter, OpenTelemetry exporter, memory consolidation/decay + graph memory, cross-encoder rerank implementation (seam is in), video generation helper.

---

## Quality bar

- **411 tests** across 41 files (vitest golden-replay fixtures + deterministic mock models — no real network)
- `tsc` strict · `eslint` (edge-safety enforced) · `publint --strict` · `attw` · dual **ESM + CJS + .d.ts** build — all green
- Type-contract lock: `test/surface.test-d.ts` pins the public 1.0 surface
- 13,971 lines across 81 source modules, zero runtime dependencies

---

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md) for the full release history (v1.1.1 through v1.5.0).

---

## Author & License

Umutcan Edizaslan ([@U-C4N](https://github.com/U-C4N))

[MIT](./LICENSE) © 2026
