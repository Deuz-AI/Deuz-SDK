---
name: deuz-sdk
description: Use when integrating or using @deuz-sdk/core in a project. Triggers include installing the SDK; adding AI chat, text streaming, tool calling or agentic loops, structured-object generation, embeddings, RAG, or memory to an app built on it; wiring a provider (Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex, Voyage, Yunwu); building a Next.js or Cloudflare Worker route with its UI wire; or any question about its API, exports, edge-safety model, or call patterns.
license: MIT
---

# @deuz-sdk/core

A pure, web-first, multi-provider AI SDK. Depends on NO other AI SDK. Zero runtime deps, ESM+CJS, Node >= 22, runs unchanged on Edge/Workers (Web APIs only). Providers: Anthropic, OpenAI, xAI Grok, Google Gemini, Vertex, Voyage, Yunwu. Everything normalizes to a canonical `StreamPart` delta stream first; adapters never proxy raw provider bytes.

## Install

```bash
npm i @deuz-sdk/core
# optional peers, only when used:
npm i zod @standard-community/standard-json   # zod/valibot schemas for tools + generateObject
npm i @modelcontextprotocol/sdk                # MCP
npm i unpdf mammoth xlsx                        # RAG PDF/DOCX/XLSX parsing (Node)
```

Keys are NEVER read from env by core. Inject them (factory `apiKey`, `createClient({ apiKeys })`, or `deps.keyProvider`). See `rules/pitfalls.md`.

## Recipes

### 1. streamChat (sync return, never throws)
```ts
import { streamChat } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const result = streamChat({
  model: createAnthropic({ apiKey: KEY })('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Hi' }],
});
for await (const chunk of result.textStream) process.stdout.write(chunk);
const usage = await result.usage; // resolves at end; errors surface on fullStream, not as throws
```

### 2. Next.js route + Deuz UI wire
```ts
// app/api/chat/route.ts (Edge or Node)
import { streamChat } from '@deuz-sdk/core';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { createOpenAI } from '@deuz-sdk/core/openai';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamChat({ model: createOpenAI({ apiKey: process.env.OPENAI_KEY })('gpt-5.2'), messages });
  return toDeuzStreamResponse(result); // SSE, header x-deuz-stream: v1
}
```
Client: `readDeuzStream(response)` yields `DeuzUIPart`s. See `rules/streaming-ui.md`.

### 3. Agentic tool loop (set maxSteps > 1!)
```ts
import { generateText } from '@deuz-sdk/core';
const res = await generateText({
  model: createAnthropic({ apiKey: KEY })('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'weather in Paris?' }],
  tools: {
    getWeather: {
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      execute: async ({ city }: { city: string }) => ({ city, temp: 22 }),
    },
  },
  maxSteps: 5, // DEFAULT 1 = single turn, tools won't loop
});
```
See `rules/tools-agents.md`.

### 4. generateObject (structured output)
```ts
import { generateObject } from '@deuz-sdk/core';
import { z } from 'zod'; // or a raw JSON Schema (no peer needed)
const { object } = await generateObject({
  model: createOpenAI({ apiKey: KEY })('gpt-5.2'),
  messages: [{ role: 'user', content: 'Extract the city' }],
  schema: z.object({ city: z.string() }),
}); // strategy auto-picked from capabilities; one repair retry
```

### 5. Embeddings (distinct model kind)
```ts
import { embed, embedMany } from '@deuz-sdk/core';
import { createOpenAIEmbedding } from '@deuz-sdk/core/openai';
const { embedding } = await embed({
  model: createOpenAIEmbedding({ apiKey: KEY })('text-embedding-3-small'),
  value: 'hello',
});
```
EmbeddingModel is NOT a LanguageModel — it only works with `embed`/`embedMany`.

### 6. Provider factory pattern + G1 key precedence
```ts
import { createClient } from '@deuz-sdk/core';
import { anthropic } from '@deuz-sdk/core/anthropic'; // singleton, no baked key
const client = createClient({ apiKeys: { anthropic: KEY } });
await client.generateText({ model: anthropic('claude-opus-4-8'), messages });
```
Key precedence (highest wins): `deps.keyProvider` > factory `apiKey` > `createClient({ apiKeys })` > else `AuthenticationError`. See `rules/providers.md`.

## Subpath export map

| Import | Provides |
| --- | --- |
| `@deuz-sdk/core` | `streamChat`, `generateText`, `generateObject`, `embed`, `embedMany`, `createClient`, errors, all types |
| `@deuz-sdk/core/anthropic` | `createAnthropic`, `anthropic` |
| `@deuz-sdk/core/openai` | `createOpenAI`, `createOpenAIResponses`, `createOpenAIEmbedding`, `openai`, `openaiResponses`, `openaiEmbedding` |
| `@deuz-sdk/core/xai` | `createXai`, `xai` |
| `@deuz-sdk/core/google` | `createGoogle`, `createGoogleNative`, `createGoogleEmbedding`, `google`, `googleNative` |
| `@deuz-sdk/core/google/extras` | Gemini explicit cache + Files API (`createGeminiCache`, `uploadFile`) |
| `@deuz-sdk/core/vertex` | `createVertexAnthropic`, `createVertexGoogle`, `createVertexGoogleNative` |
| `@deuz-sdk/core/voyage` | `createVoyage`, `voyage` (embeddings) |
| `@deuz-sdk/core/yunwu` | `createYunwu` unified relay (chat/image/embed/MJ) |
| `@deuz-sdk/core/ui` | `toDeuzStreamResponse`, `readDeuzStream` |
| `@deuz-sdk/core/middleware` | `wrapModel`, `logging`, `simpleCache`, `redactPII`, `promptInjectionGuard` |
| `@deuz-sdk/core/pricing` | `createPriceProvider`, `priceUsage`, `PRICES_2026` |
| `@deuz-sdk/core/image` | `createImageProvider`, `generateImage` (sync) |
| `@deuz-sdk/core/midjourney` | async imagine submit/poll |
| `@deuz-sdk/core/memory` | `remember`, `recall`, `createMemoryTools`, stores (edge-safe) |
| `@deuz-sdk/core/memory/markdown` | Obsidian-style markdown store (Node) |
| `@deuz-sdk/core/rag` | sniff/parse/chunk/retrieve/hybridRetrieve (edge-safe) |
| `@deuz-sdk/core/rag/node` | PDF/DOCX/XLSX parsers (Node) |
| `@deuz-sdk/core/skills` | SKILL.md parser + registry (edge-safe) |
| `@deuz-sdk/core/skills/node` | filesystem skill source (Node) |
| `@deuz-sdk/core/mcp` | `createMcpClient` (http/sse, edge-safe) |
| `@deuz-sdk/core/mcp/stdio` | stdio MCP transport (Node) |
| `@deuz-sdk/core/edge` | edge-safe re-export subset |

## Detail rules (read on demand)

- `rules/providers.md` — every factory signature + which surface to pick.
- `rules/streaming-ui.md` — streamChat semantics, `fullStream` parts, UI wire, Next.js/Worker recipes.
- `rules/tools-agents.md` — ToolSet shape, loop invariants, generateObject strategies.
- `rules/modules.md` — memory, RAG, skills, MCP, image, middleware, pricing recipes.
- `rules/pitfalls.md` — the sharp edges (read this before debugging weirdness).
