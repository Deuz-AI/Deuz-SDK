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
import { validateChatRequest } from '@deuz-sdk/core/chat';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';
import { createOpenAI } from '@deuz-sdk/core/openai';

export async function POST(req: Request): Promise<Response> {
  // The body is attacker-controlled and canonical Message[] includes role:'system'.
  const parsed = validateChatRequest(await req.json());
  if (!parsed.ok) return Response.json({ issues: parsed.issues }, { status: 400 });

  const result = streamChat({
    model: createOpenAI({ apiKey: process.env.OPENAI_KEY })('gpt-5.2'),
    instructions: 'You are a helpful assistant.',
    messages: parsed.request.messages,
    signal: req.signal,
  });
  return toDeuzStreamResponse(result); // SSE, header x-deuz-stream: v2 (v1 on request)
}
```
A route serving CLIENT TOOLS must pass `validateChatRequest(body, { rejectToolResults: false })` — `useChat`'s `onToolCall` round-trip POSTs a `role: 'tool'` message. Client: `readDeuzStream(response)` yields `DeuzUIPart`s. See `rules/streaming-ui.md`.

### 3. Agentic tool loop (set maxSteps > 1!)
```ts
import { generateText, tool } from '@deuz-sdk/core';
import { z } from 'zod';

const res = await generateText({
  model: createAnthropic({ apiKey: KEY })('claude-opus-4-8'),
  prompt: 'weather in Paris?',            // 1.9: shorthand for one user turn
  tools: {
    // `tool()` is a pure identity function — inference only, zero runtime.
    getWeather: tool({
      description: 'Get weather',
      parameters: z.object({ city: z.string() }),
      execute: async (args) => ({ city: args.city, temp: 22 }), // args: { city: string }
    }),
  },
  maxSteps: 5, // DEFAULT 1 = single turn, tools won't loop
});
```
A raw JSON Schema works too (no peer dep) — then annotate `args` yourself. See `rules/tools-agents.md`.

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
| `@deuz-sdk/core` | `streamChat`, `generateText`, `generateObject`, `streamObject`, `embed`, `embedMany`, `tool`, `filePart`, `imagePart`, `getModelCapabilities`, `agentTool`, stop conditions, `wrapModel`, `createClient`, errors, all types |
| `@deuz-sdk/core/agent` | `createAgent` — a reusable agent as a frozen VALUE (no class, no `new`) |
| `@deuz-sdk/core/chat` | pure chat engine: `applyUIPart`, `uiFromMessages`, `canonicalFromUI`, `sealAssistantTurn`, `userMessageFromInput`, `filesToImageParts`, `ChatStore`, `validateChatRequest` |
| `@deuz-sdk/core/providers` | compat factories + `createOpenAICompatible({ id, baseURL })` + `createProviderRegistry` |
| `@deuz-sdk/core/testing` | `createMockModel`, `sseResponse`, `sseEvents`, `mockFetch`, `mockFetchSequence` |
| `@deuz-sdk/react` | `useChat`, `useObject`, `partsFromFiles`, `ToolApprovalCard`, `CostBadge` (supersedes `@deuz-sdk/core/react`) |
| `@deuz-sdk/core/anthropic` | `createAnthropic`, `anthropic` |
| `@deuz-sdk/core/openai` | `createOpenAI`, `createOpenAIResponses`, `createOpenAIEmbedding`, `openai`, `openaiResponses`, `openaiEmbedding` |
| `@deuz-sdk/core/xai` | `createXai`, `xai` |
| `@deuz-sdk/core/google` | `createGoogle`, `createGoogleNative`, `createGoogleEmbedding`, `google`, `googleNative` |
| `@deuz-sdk/core/google/extras` | Gemini explicit cache + Files API (`createGeminiCache`, `uploadFile`) |
| `@deuz-sdk/core/vertex` | `createVertexAnthropic`, `createVertexGoogle`, `createVertexGoogleNative` |
| `@deuz-sdk/core/voyage` | `createVoyage`, `voyage` (embeddings) |
| `@deuz-sdk/core/yunwu` | `createYunwu` unified relay (chat/image/embed/MJ) |
| `@deuz-sdk/core/ui` | `toDeuzStreamResponse`, `toDeuzTextStreamResponse`, `toDeuzObjectStreamResponse`, `createDeuzStream`, `resumeDeuzStreamResponse`, `readDeuzStream`, `connectDeuzStream` |
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
| `@deuz-sdk/core/durable` | `resumeFromCheckpoint`, `resumeStreamFromCheckpoint`, `createApprovalSigner`, `createInMemorySessionStore`, checkpoint codec |
| `@deuz-sdk/core/react` | `useChat`, `useObject` React hooks |
| `@deuz-sdk/core/observe` | observation events: `createMemoryObserver`, `createCallbackObserver`, `composeObservers`, `filterObserver`, `summarizeRun` (edge-safe; inject via `deps.observer`) |
| `@deuz-sdk/core/observe/node` | `createJsonlObserver`, `readJsonlEvents` (Node JSONL persistence) |
| `@deuz-sdk/core/edge` | edge-safe re-export subset |

## 1.9 additions worth knowing up front

- **Call shape:** `prompt` (one user turn, mutually exclusive with `messages`), `instructions` (system prompt, placed first, idempotent fold), `timeout: { ttftMs, totalMs, stepMs, toolMs }` (bare number = `totalMs`; `0` disables a layer), `capabilities` (override the registry row), `abortSignal` (deprecated alias for `signal`).
- **`tool()`** — a pure identity function that types `execute(args)`. Plus `InferToolInput` / `InferToolOutput`, and `Tool.timeoutMs`.
- **`filePart()` / `imagePart()`** — `ImagePart` is the carrier for ALL binary media; a non-`image/*` `mediaType` now maps to each wire's document block (Anthropic `document`, Responses `input_file`, Chat Completions `file`, Gemini `inlineData`) instead of 400ing on three of four.
- **`consume()`** on `StreamChatResult` / `StreamObjectResult` — drain the lazy pump so `onFinish` / chat persistence / checkpoints run when nobody iterates. Optional on the type (`fallbackModels` and `withFallback` return `undefined`).
- **`createAgent`** (`/agent`) and **`validateChatRequest`** (`/chat`, `/edge`).
- **`createOpenAICompatible({ id, baseURL })`** (`/providers`) for Ollama / vLLM / an internal gateway.
- **UI:** ordered `UIMessage.parts`, `useChat`'s `setHistory` / `setMessages` / `addToolResult` / `clearError` / `pendingToolCalls` / `throttleMs` / `resume.auto` / `onHttpError`, `sendMessage({ text, parts })`, `writeData(name, payload, { id?, transient? })`, `toDeuzTextStreamResponse`.

**1.9 wired up three surfaces that first shipped inert:** `streamChat().warnings` resolves a real `CallWarning[]` and `warning` parts ride `fullStream`; the streaming loop sets `tool-state.denied` / `deniedReason`, so a REFUSED tool call is distinguishable from a crashed one all the way to `UIToolCall.denied`; `applyUIPart` folds `sub-agent` frames into `turn.subAgents` (+ `turn.warnings`, `turn.falseFinishes`), all three surfaced by `useChat`.

**The ONE remaining trap:** `warnings` is populated on `streamChat` ONLY. It is `undefined` on `GenerateTextResult` / `GenerateObjectResult` / `StreamObjectResult`, and a `streamChat` carrying `tools` (or `chat`/`memory`/`verifyStep`/`doneWhen`) reports only its own `activeTools` notices — a model-level warning raised inside a step reaches `deps.logger.warn`, not the field. See `rules/pitfalls.md` #16.

## Detail rules (read on demand)

- `rules/providers.md` — every factory signature + which surface to pick.
- `rules/streaming-ui.md` — streamChat semantics, `fullStream` parts, UI wire, Next.js/Worker recipes.
- `rules/tools-agents.md` — ToolSet shape, loop invariants, `createAgent`, generateObject strategies.
- `rules/modules.md` — memory, RAG, skills, MCP, image, middleware, pricing recipes.
- `rules/pitfalls.md` — the sharp edges (read this before debugging weirdness).

## Porting from another SDK?

If the task is moving an existing app off the Vercel AI SDK (`ai`, `@ai-sdk/*`), use the companion skill **`migrate-from-ai-sdk`** (installed by the same `npx skills add Deuz-AI/Deuz-SDK`). It carries the verified name-by-name mapping, the porting order, and the list of AI SDK features that have no Deuz equivalent. This skill stays the reference for the target API itself.
